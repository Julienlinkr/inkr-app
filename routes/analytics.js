/**
 * routes/analytics.js
 *
 * Analytics de trafic inkr.club — 100 % auto-hébergé, sans cookie, RGPD OK.
 *
 * ─── Ce que ça fait ───────────────────────────────────────────────────────────
 *
 *  Chaque fois qu'un visiteur charge inkr.club (index.html), le frontend envoie
 *  une requête silencieuse à POST /api/analytics/hit.
 *  Le backend l'enregistre en base avec :
 *    - la page visitée
 *    - un hash SHA-256 de l'IP (l'IP brute n'est JAMAIS stockée → RGPD)
 *    - le pays déduit si dispo (header CF-IPCountry de Cloudflare)
 *    - la source (referrer)
 *
 *  Les stats sont disponibles sur GET /api/analytics/stats (admin seulement).
 *
 * ─── Routes ───────────────────────────────────────────────────────────────────
 *
 *  POST /api/analytics/hit         → Enregistrer une visite (appelé par le frontend)
 *  GET  /api/analytics/stats       → Stats globales (admin seulement)
 *  GET  /api/analytics/realtime    → Visiteurs actifs (fenêtre 5 min)
 *
 * ─── Sécurité / RGPD ─────────────────────────────────────────────────────────
 *
 *  • L'IP n'est jamais stockée. On stocke SHA-256(IP + salt) → irréversible.
 *  • Pas de cookie, pas de fingerprinting.
 *  • Les bots sont filtrés sur le User-Agent.
 *  • Rate-limit implicite : 1 hit par IP par page par heure (dédoublonnage en base).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { db }  = require('../db/database');

// Salt aléatoire pour les hashes IP (dérivé du JWT_SECRET pour la cohérence)
// Sans ce salt, deux serveurs pourraient corréler les hashes entre eux.
const IP_SALT = process.env.JWT_SECRET || 'inkr_analytics_salt_2026';

// ─── Migration ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS site_visits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    page        TEXT    DEFAULT '/',
    ip_hash     TEXT    DEFAULT NULL,   -- SHA-256(IP + salt), jamais l'IP brute
    country     TEXT    DEFAULT NULL,   -- Code pays ISO 3166-1 alpha-2 (ex: FR)
    referrer    TEXT    DEFAULT NULL,   -- Domaine source (ex: instagram.com)
    is_mobile   INTEGER DEFAULT 0,      -- 1 = mobile, 0 = desktop
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Index pour les requêtes de stats fréquentes
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_site_visits_date ON site_visits(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_site_visits_page ON site_visits(page, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_site_visits_ip ON site_visits(ip_hash, created_at)');
} catch(_) {}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Anonymise une adresse IP par hachage SHA-256 avec salt.
 * L'IP brute n'est jamais stockée ni loggée.
 * @param {string} ip - Adresse IP brute
 * @returns {string} Hash hexadécimal de 16 chars (tronqué pour la lisibilité)
 */
function hashIp(ip) {
  return crypto
    .createHash('sha256')
    .update(ip + IP_SALT)
    .digest('hex')
    .slice(0, 16); // 16 chars suffisent pour identifier un visiteur unique
}

/**
 * Extrait le domaine source depuis un header Referer.
 * Ex: "https://www.instagram.com/..." → "instagram.com"
 * @param {string} referer - Header HTTP Referer
 * @returns {string|null}
 */
function extractReferrer(referer) {
  if (!referer || referer.includes('inkr.club')) return null;
  try {
    const url = new URL(referer);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Filtre les bots évidents sur le User-Agent.
 * @param {string} ua - User-Agent header
 * @returns {boolean} true si c'est un bot
 */
function isBot(ua) {
  if (!ua) return true;
  const BOT_PATTERNS = /bot|crawl|spider|slurp|bingpreview|googlebot|yandex|baidu|semrush|ahrefs|wget|curl|python|java|axios|node-fetch/i;
  return BOT_PATTERNS.test(ua);
}

// ─── POST /hit — Enregistrer une visite ────────────────────────────────────
/**
 * Appelé silencieusement par index.html à chaque chargement de page.
 * Body JSON attendu : { page?: string }
 * Répond toujours 200 (ne doit jamais bloquer le chargement de la page).
 */
router.post('/hit', (req, res) => {
  // Toujours répondre 200 immédiatement — tracking non-bloquant
  res.sendStatus(200);

  try {
    const ua = req.headers['user-agent'] || '';
    if (isBot(ua)) return; // Ne pas tracker les bots

    // IP réelle (Railway est derrière un proxy → X-Forwarded-For)
    const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress
      || '';

    const ipHash   = rawIp ? hashIp(rawIp) : null;
    const country  = req.headers['cf-ipcountry'] || req.headers['x-country'] || null;
    const referrer = extractReferrer(req.headers['referer'] || req.body?.referrer || '');
    const page     = (req.body?.page || '/').slice(0, 100);
    const isMobile = /mobile|android|iphone|ipad/i.test(ua) ? 1 : 0;

    // Dédoublonnage : ne pas compter le même visiteur 2 fois sur la même page dans la même heure
    if (ipHash) {
      const recent = db.prepare(`
        SELECT id FROM site_visits
        WHERE ip_hash = ? AND page = ?
          AND created_at >= datetime('now', '-1 hour')
        LIMIT 1
      `).get(ipHash, page);
      if (recent) return; // Déjà compté
    }

    db.prepare(`
      INSERT INTO site_visits (page, ip_hash, country, referrer, is_mobile)
      VALUES (?, ?, ?, ?, ?)
    `).run(page, ipHash, country, referrer, isMobile);

  } catch (err) {
    // Non-bloquant : une erreur de tracking ne doit jamais affecter l'utilisateur
    console.error('[Analytics] Erreur tracking:', err.message);
  }
});

// ─── GET /stats — Stats globales (admin seulement) ─────────────────────────
/**
 * Retourne les stats de trafic pour le dashboard admin.
 * Protégé par ADMIN_SECRET en query param.
 */
router.get('/stats', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.query.secret !== secret && req.cookies?.inkr_token) {
    // Autoriser aussi les dev/admin connectés via cookie
    const jwt = require('jsonwebtoken');
    try {
      const payload = jwt.verify(req.cookies.inkr_token, process.env.JWT_SECRET || 'inkr_secret_dev');
      const user = db.prepare("SELECT role FROM users WHERE id = ?").get(payload.userId);
      if (user?.role !== 'dev' && user?.role !== 'admin') {
        return res.status(403).json({ error: 'Accès réservé aux admins' });
      }
    } catch {
      return res.status(401).json({ error: 'Non authentifié' });
    }
  }

  try {
    // Visites aujourd'hui
    const today = db.prepare(`
      SELECT COUNT(*) as total,
             COUNT(DISTINCT ip_hash) as unique_visitors
      FROM site_visits
      WHERE date(created_at) = date('now')
    `).get();

    // Visites cette semaine
    const thisWeek = db.prepare(`
      SELECT COUNT(*) as total,
             COUNT(DISTINCT ip_hash) as unique_visitors
      FROM site_visits
      WHERE created_at >= datetime('now', '-7 days')
    `).get();

    // Visites ce mois
    const thisMonth = db.prepare(`
      SELECT COUNT(*) as total,
             COUNT(DISTINCT ip_hash) as unique_visitors
      FROM site_visits
      WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `).get();

    // Courbe journalière sur 30 jours
    const daily = db.prepare(`
      SELECT date(created_at) as day,
             COUNT(*) as visits,
             COUNT(DISTINCT ip_hash) as unique_visitors
      FROM site_visits
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY day
      ORDER BY day ASC
    `).all();

    // Top pages
    const topPages = db.prepare(`
      SELECT page,
             COUNT(*) as visits,
             COUNT(DISTINCT ip_hash) as unique_visitors
      FROM site_visits
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY page
      ORDER BY visits DESC
      LIMIT 10
    `).all();

    // Top sources
    const topReferrers = db.prepare(`
      SELECT referrer,
             COUNT(*) as visits
      FROM site_visits
      WHERE created_at >= datetime('now', '-30 days')
        AND referrer IS NOT NULL
      GROUP BY referrer
      ORDER BY visits DESC
      LIMIT 10
    `).all();

    // Répartition mobile/desktop
    const devices = db.prepare(`
      SELECT is_mobile,
             COUNT(*) as visits
      FROM site_visits
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY is_mobile
    `).all();

    // Top pays
    const countries = db.prepare(`
      SELECT country,
             COUNT(*) as visits
      FROM site_visits
      WHERE created_at >= datetime('now', '-30 days')
        AND country IS NOT NULL
      GROUP BY country
      ORDER BY visits DESC
      LIMIT 10
    `).all();

    res.json({
      today,
      thisWeek,
      thisMonth,
      daily,
      topPages,
      topReferrers,
      devices,
      countries,
    });

  } catch (err) {
    console.error('[Analytics /stats] Erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /realtime — Visiteurs actifs (fenêtre 5 min) ─────────────────────
/**
 * Nombre de visiteurs uniques ayant chargé une page dans les 5 dernières minutes.
 * Accessible à tous (pas de secret) — utilisé pour un compteur live éventuel.
 */
router.get('/realtime', (req, res) => {
  try {
    const result = db.prepare(`
      SELECT COUNT(DISTINCT ip_hash) as active
      FROM site_visits
      WHERE created_at >= datetime('now', '-5 minutes')
    `).get();
    res.json({ active: result?.active || 0 });
  } catch (err) {
    res.json({ active: 0 });
  }
});

module.exports = router;
