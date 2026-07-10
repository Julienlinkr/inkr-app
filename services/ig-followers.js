/**
 * ig-followers.js — Scraping automatique du nombre de followers Instagram
 *
 * Utilise l'API interne d'Instagram (endpoint que leur propre appli web utilise).
 * Pas besoin de clé API ni de compte connecté pour les profils publics.
 *
 * Stratégie :
 *  - Lance un batch au démarrage du serveur (artists sans données ou obsolètes)
 *  - Cadence : 1 requête / 1.2s pour ne pas déclencher le rate-limit Instagram
 *  - Refresh : re-scrape les profils toutes les 7 jours
 *  - Abandonne silencieusement si Instagram répond 401 (compte privé / bloqué)
 */

const https = require('https');

const DELAY_MS     = 1200; // 1.2 s entre chaque requête
const REFRESH_DAYS = 7;    // Re-scrape toutes les 7 jours

// User-agents reconnus par Instagram pour servir les meta OG
// (Slack, Discord, Telegram utilisent exactement ces UAs pour leurs link previews)
const CRAWLER_UAS = [
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'TelegramBot (like TwitterBot)',
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Twitterbot/1.0',
];

// ── Formatte un nombre de followers pour l'affichage ──────────────────────────
function fmtFollowers(n) {
  if (!n) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// ── Stratégie 1 : page publique Instagram via meta OG (crawlers reconnus) ────
// Instagram sert toujours le og:description aux bots Slack/Discord/Telegram/FB.
// Le format est : "1 234 Followers, 456 Following, 78 Posts – See Instagram..."
function fetchViaOG(handle, ua) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'www.instagram.com',
      path: `/${encodeURIComponent(handle)}/`,
      method: 'GET',
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      timeout: 14000,
    };

    const req = https.get(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Redirect → probablement une page de login, pas de données
        res.resume();
        return resolve(null);
      }
      if (res.statusCode >= 400) { res.resume(); return resolve(null); }

      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 200_000) req.destroy(); // Stoppe dès qu'on a assez
      });
      res.on('end', () => {
        try {
          // Cherche le og:description dans le HTML
          const ogMatch = raw.match(/property="og:description"\s+content="([^"]+)"/i)
                       || raw.match(/content="([^"]+)"\s+property="og:description"/i);

          if (ogMatch) {
            const desc = ogMatch[1];
            // Format : "1,234 Followers" ou "1 234 Followers" ou "12.5K Followers"
            const m = desc.match(/([\d\s,]+)\s+Followers?/i);
            if (m) {
              const cleaned = m[1].replace(/[\s,]/g, '');
              const count = parseInt(cleaned, 10);
              if (!isNaN(count) && count > 0) return resolve(count);
            }
          }

          // Fallback : cherche le JSON embarqué dans le HTML
          const jsonMatch = raw.match(/"edge_followed_by":\{"count":(\d+)\}/);
          if (jsonMatch) return resolve(parseInt(jsonMatch[1], 10));

          resolve(null);
        } catch { resolve(null); }
      });
    });

    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── Stratégie 2 : API interne Instagram (fonctionne depuis IPs résidentielles) ─
function fetchViaInternalAPI(handle) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'i.instagram.com',
      path: `/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
      method: 'GET',
      headers: {
        'x-ig-app-id': '936619743392459',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.8',
        'Referer': 'https://www.instagram.com/',
        'Origin': 'https://www.instagram.com',
      },
      timeout: 12000,
    };

    const req = https.get(options, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) { res.resume(); return resolve(null); }
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const count = json?.data?.user?.edge_followed_by?.count;
          resolve(count !== undefined ? parseInt(count, 10) : null);
        } catch { resolve(null); }
      });
    });

    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ── Essaie toutes les stratégies dans l'ordre jusqu'à obtenir un résultat ────
async function fetchFollowers(handle) {
  // Essaie d'abord chaque UA crawler sur la page publique
  for (const ua of CRAWLER_UAS) {
    const count = await fetchViaOG(handle, ua);
    if (count !== null) return count;
    await new Promise(r => setTimeout(r, 300)); // Mini-pause entre tentatives
  }
  // Dernier recours : API interne
  return fetchViaInternalAPI(handle);
}

// ── Pause ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Batch principal ───────────────────────────────────────────────────────────
// Scrape les artistes qui :
//  - ont un instagram_handle
//  - ET (ig_followers IS NULL  OU  ig_followers_scraped_at < il y a REFRESH_DAYS jours)
// Retourne le nombre de profils mis à jour.
async function runBatch(db, { limit = 100, verbose = false } = {}) {
  const cutoff = new Date(Date.now() - REFRESH_DAYS * 86400000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  let rows;
  try {
    rows = db.prepare(`
    SELECT id, instagram_handle
    FROM   tatoueurs
    WHERE  statut = 'active'
      AND  instagram_handle IS NOT NULL
      AND  instagram_handle != ''
      AND  (
             ig_followers IS NULL
          OR ig_followers_scraped_at IS NULL
          OR ig_followers_scraped_at < ?
           )
    LIMIT ?
    `).all(cutoff, limit);
  } catch (dbErr) {
    console.warn('[IG] Erreur DB runBatch:', dbErr.message);
    return 0;
  }

  if (!rows.length) {
    if (verbose) console.log('[IG] Aucun profil à scraper pour l\'instant.');
    return 0;
  }

  if (verbose) console.log(`[IG] Scraping ${rows.length} profils Instagram…`);

  let updated = 0;
  for (const row of rows) {
    const followers = await fetchFollowers(row.instagram_handle);

    if (followers !== null) {
      db.prepare(`
        UPDATE tatoueurs
        SET    ig_followers = ?, ig_followers_scraped_at = CURRENT_TIMESTAMP
        WHERE  id = ?
      `).run(followers, row.id);
      updated++;
      if (verbose) console.log(`  ✓ @${row.instagram_handle} → ${fmtFollowers(followers)}`);
    } else {
      // On marque quand même la date pour ne pas re-tenter trop vite
      db.prepare(`
        UPDATE tatoueurs
        SET    ig_followers_scraped_at = CURRENT_TIMESTAMP
        WHERE  id = ?
      `).run(row.id);
      if (verbose) console.log(`  – @${row.instagram_handle} → non disponible`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`[IG] Batch terminé : ${updated}/${rows.length} profils mis à jour.`);
  return updated;
}

// ── Lancement automatique au démarrage du serveur ────────────────────────────
// Attend 15s que la DB soit prête, puis scrape par tranches de 200 profils
// toutes les 10 minutes jusqu'à épuisement, puis relance toutes les 6h.
function startAutoScraper(db) {
  const BATCH_SIZE     = 200;
  const BETWEEN_BATCHES = 10 * 60 * 1000;  // 10 min entre deux tranches
  const FULL_CYCLE      =  6 * 60 * 60 * 1000; // 6h avant de recommencer le cycle

  async function cycle() {
    let total = 0;
    try {
      let keepGoing = true;
      while (keepGoing) {
        const n = await runBatch(db, { limit: BATCH_SIZE, verbose: true });
        total += n;
        if (n === 0) { keepGoing = false; break; }
        await sleep(BETWEEN_BATCHES);
      }
      console.log(`[IG] Cycle complet — ${total} profils mis à jour. Prochain cycle dans 6h.`);
    } catch (err) {
      console.warn('[IG] Erreur cycle scraper (non bloquant):', err.message);
    }
    // Relance dans 6h quoi qu'il arrive
    setTimeout(cycle, FULL_CYCLE);
  }

  // Démarre 15s après le lancement du serveur (laisse la DB s'initialiser)
  setTimeout(cycle, 15_000);
  console.log('[IG] Auto-scraper Instagram démarré (premier batch dans 15s).');
}

module.exports = { fetchFollowers, runBatch, startAutoScraper, fmtFollowers };
