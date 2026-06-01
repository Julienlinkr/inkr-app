/**
 * routes/instagram.js
 *
 * Route : GET /api/instagram/:username
 *
 * Récupère les derniers posts Instagram publics d'un tatoueur via l'API
 * non-officielle d'Instagram, avec mise en cache SQLite (TTL 24h).
 *
 * ─── Pour les développeurs ──────────────────────────────────────────────────
 *
 * En 2025 Instagram ne dispose pas d'API publique ouverte. Cette route utilise
 * l'endpoint « web_profile_info » accessible avec l'App ID public du site web
 * Instagram (936619743392459).
 *
 * SI INSTAGRAM BLOQUE CET ENDPOINT :
 *   → Migrer vers l'API officielle Meta (Meta Graph API) :
 *     https://developers.facebook.com/docs/instagram-basic-display-api
 *     Nécessite : compte Meta Developer, validation d'app, OAuth par utilisateur
 *   → Ou utiliser un service tiers (ex: RapidAPI Instagram Scraper)
 *   → Ou demander aux artistes d'uploader leurs photos manuellement
 *
 * Cache : table SQLite `ig_cache` (username PK, posts JSON, status, fetched_at)
 * TTL   : 24h par défaut, configurable via variable d'env IG_CACHE_TTL_HOURS
 *
 * Autres routes :
 *   DELETE /api/instagram/:username/cache  →  Invalide le cache d'un compte
 *   GET    /api/instagram/:username/status →  Retourne juste le statut du cache
 * ────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();
const { db }  = require('../db/database');

// ── Création de la table de cache (idempotent) ───────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ig_cache (
    username   TEXT    PRIMARY KEY,
    posts      TEXT    NOT NULL DEFAULT '[]',
    status     TEXT    NOT NULL DEFAULT 'pending',
    fetched_at INTEGER NOT NULL DEFAULT 0
  )
`);

// TTL : 24h par défaut (modifiable via IG_CACHE_TTL_HOURS dans Railway)
const CACHE_TTL_MS = (parseInt(process.env.IG_CACHE_TTL_HOURS) || 24) * 3600 * 1000;

// ── GET /api/instagram/:username ─────────────────────────────────────────────
router.get('/:username', async (req, res) => {
  const raw      = (req.params.username || '').replace(/^@/, '').trim().toLowerCase();
  const username = raw.replace(/[^a-z0-9_.]/g, ''); // sanitize
  if (!username) return res.status(400).json({ error: 'Username manquant' });

  // 1. Vérifier le cache SQLite
  try {
    const cached = db.prepare('SELECT * FROM ig_cache WHERE username = ?').get(username);
    if (cached && (Date.now() - cached.fetched_at) < CACHE_TTL_MS) {
      return res.json({
        username,
        posts:  JSON.parse(cached.posts || '[]'),
        status: cached.status,
        cached: true,
      });
    }
  } catch (e) {
    console.warn('[instagram] Erreur lecture cache:', e.message);
  }

  // 2. Fetch depuis Instagram
  let posts  = [];
  let status = 'error';

  try {
    posts = await fetchInstagramPosts(username);
    status = posts.length > 0 ? 'ok' : 'empty';
  } catch (e) {
    console.warn(`[instagram] Fetch échoué pour @${username}:`, e.message);
    status = 'error';
  }

  // 3. Mettre en cache (même si vide — évite de re-requêter immédiatement)
  try {
    db.prepare(`
      INSERT OR REPLACE INTO ig_cache (username, posts, status, fetched_at)
      VALUES (?, ?, ?, ?)
    `).run(username, JSON.stringify(posts), status, Date.now());
  } catch (e) {
    console.warn('[instagram] Erreur écriture cache:', e.message);
  }

  res.json({ username, posts, status, cached: false });
});

// ── DELETE /api/instagram/:username/cache ── invalide le cache manuellement ──
router.delete('/:username/cache', (req, res) => {
  const username = (req.params.username || '').replace(/^@/, '').trim().toLowerCase();
  try {
    db.prepare('DELETE FROM ig_cache WHERE username = ?').run(username);
    res.json({ ok: true, message: `Cache supprimé pour @${username}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/instagram/:username/status ── vérifie l'état du cache ───────────
router.get('/:username/status', (req, res) => {
  const username = (req.params.username || '').replace(/^@/, '').trim().toLowerCase();
  try {
    const row = db.prepare('SELECT status, fetched_at, json_array_length(posts) as count FROM ig_cache WHERE username = ?').get(username);
    if (!row) return res.json({ cached: false });
    const ageMs  = Date.now() - row.fetched_at;
    const expiredIn = Math.max(0, CACHE_TTL_MS - ageMs);
    res.json({
      cached:    true,
      status:    row.status,
      count:     row.count,
      ageMs,
      expiredIn,
      fresh:     ageMs < CACHE_TTL_MS,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Logique de fetch Instagram ────────────────────────────────────────────────
/**
 * fetchInstagramPosts(username)
 *
 * Tente plusieurs stratégies pour obtenir les posts publics d'un compte :
 *  1. API web_profile_info (endpoint officieux, le plus fiable)
 *  2. Scraping de la page publique (meta og:image, fallback)
 *
 * Retourne un tableau de { thumbnail, link, caption, isVideo }.
 */
async function fetchInstagramPosts(username) {

  // ── Stratégie 1 : API web_profile_info ──────────────────────────────────
  try {
    const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'x-ig-app-id':    '936619743392459',
        'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':         '*/*',
        'Accept-Language':'fr-FR,fr;q=0.9,en;q=0.8',
        'Referer':        `https://www.instagram.com/${username}/`,
        'Origin':         'https://www.instagram.com',
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
      },
    });

    if (res.ok) {
      const data  = await res.json();
      const edges = data?.data?.user?.edge_owner_to_timeline_media?.edges || [];
      if (edges.length > 0) {
        return edges.slice(0, 12).map(e => ({
          thumbnail: e.node?.thumbnail_src || e.node?.display_url || '',
          link:      `https://www.instagram.com/p/${e.node?.shortcode}/`,
          caption:   (e.node?.edge_media_to_caption?.edges?.[0]?.node?.text || '').slice(0, 150),
          isVideo:   !!e.node?.is_video,
        })).filter(p => p.thumbnail);
      }
    }
  } catch (e) {
    console.warn('[instagram] Stratégie 1 (web_profile_info) échouée:', e.message);
  }

  // ── Stratégie 2 : page publique (meta og:image) ──────────────────────────
  // Note : Instagram redirige souvent vers la page de connexion sans cookie.
  // Cette stratégie peut fonctionner pour les comptes très publics/connus.
  try {
    const profileUrl = `https://www.instagram.com/${username}/`;
    const res = await fetch(profileUrl, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent':     'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept':         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':'fr-FR,fr;q=0.9',
      },
    });

    if (res.ok) {
      const html = await res.text();
      // Cherche les images og:image (généralement la photo de profil ou un post)
      const ogImages = [...html.matchAll(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/g)]
        .map(m => m[1])
        .filter(u => u && !u.includes('profile'));
      if (ogImages.length > 0) {
        return ogImages.slice(0, 12).map(url => ({
          thumbnail: url,
          link:      profileUrl,
          caption:   '',
          isVideo:   false,
        }));
      }
    }
  } catch (e) {
    console.warn('[instagram] Stratégie 2 (scraping page) échouée:', e.message);
  }

  return [];
}

module.exports = router;
