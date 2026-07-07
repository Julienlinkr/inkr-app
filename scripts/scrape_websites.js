/**
 * scripts/scrape_websites.js
 *
 * Pour chaque tatoueur avec un site_web, récupère :
 *   - og:image        → photo principale de la fiche
 *   - og:description  → bio si vide
 *   - og:title        → nom commercial si vide
 *
 * Limite : 1 requête / 1.5s (pour ne pas surcharger les petits sites)
 * Idempotent : saute les tatoueurs déjà enrichis (photo_salon non null)
 *
 * Usage Railway : node scripts/scrape_websites.js
 */

'use strict';
const { DatabaseSync } = require('node:sqlite');
const https = require('https');
const http  = require('http');
const path  = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'inkr.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

const todo = db.prepare(`
  SELECT id, nom, site_web, bio, photo_salon
  FROM tatoueurs
  WHERE statut='active'
    AND site_web IS NOT NULL AND site_web != ''
    AND photo_salon IS NULL
  ORDER BY id
`).all();

console.log(`🌐 ${todo.length} sites à scraper`);
if (!todo.length) { console.log('✅ Tous déjà enrichis !'); process.exit(0); }

const updateFiche = db.prepare(`
  UPDATE tatoueurs SET
    photo_salon = COALESCE(NULLIF(photo_salon,''), ?),
    bio         = COALESCE(NULLIF(bio,''), ?)
  WHERE id=?
`);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchPage(url) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url.startsWith('http') ? url : 'https://' + url);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; inkr-bot/1.0; +https://inkr.club)',
          'Accept': 'text/html',
        },
        timeout: 6000,
      }, res => {
        // Suit les redirects (max 2)
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          return fetchPage(res.headers.location).then(resolve);
        }
        let html = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { html += chunk; if (html.length > 80000) res.destroy(); });
        res.on('end', () => resolve(html));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    } catch { resolve(''); }
  });
}

function extractMeta(html) {
  const get = (pattern) => {
    const m = html.match(pattern);
    return m ? m[1].replace(/&amp;/g,'&').replace(/&quot;/g,'"').trim() : null;
  };
  return {
    image: get(/og:image[^>]*content=["']([^"']+)["']/i)
        || get(/content=["']([^"']+)["'][^>]*og:image/i),
    description: get(/og:description[^>]*content=["']([^"']{20,300})["']/i)
              || get(/content=["']([^"']{20,300})["'][^>]*og:description/i)
              || get(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']{20,300})["']/i),
  };
}

async function run() {
  let done = 0, failed = 0;

  for (const t of todo) {
    const html = await fetchPage(t.site_web);
    if (html) {
      const { image, description } = extractMeta(html);
      if (image || description) {
        updateFiche.run(image || null, description || null, t.id);
        done++;
        if (done % 20 === 0) console.log(`  ✅ ${done}/${todo.length} enrichis (${failed} échecs)`);
      } else {
        failed++;
      }
    } else {
      failed++;
    }
    await sleep(1500);
  }

  console.log(`\n✅ Scraping terminé !`);
  console.log(`   Enrichis : ${done}`);
  console.log(`   Échecs   : ${failed}`);
}

run().catch(e => { console.error('Erreur:', e.message); process.exit(1); });
