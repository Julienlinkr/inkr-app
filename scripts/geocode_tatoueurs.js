/**
 * scripts/geocode_tatoueurs.js
 *
 * Géocode les tatoueurs sans lat/lng via OpenStreetMap Nominatim (gratuit).
 * Limite : 1 requête/seconde max (respect des CGU Nominatim).
 * Idempotent : reprend là où il s'est arrêté.
 *
 * Usage : node scripts/geocode_tatoueurs.js
 * Sur Railway : DB_PATH=/app/data/inkr.db node scripts/geocode_tatoueurs.js
 */

'use strict';
require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const https = require('https');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'inkr.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

// Tatoueurs sans coordonnées mais avec une ville
const todo = db.prepare(`
  SELECT id, nom, adresse, cp, ville
  FROM tatoueurs
  WHERE statut='active'
    AND (lat IS NULL OR lat=0)
    AND (ville IS NOT NULL AND ville != '')
  ORDER BY id
`).all();

console.log(`🗺  ${todo.length} tatoueurs à géocoder`);
if (!todo.length) { console.log('✅ Tous déjà géocodés !'); process.exit(0); }

const updateLatLng = db.prepare('UPDATE tatoueurs SET lat=?, lng=? WHERE id=?');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function geocode(adresse, cp, ville) {
  return new Promise((resolve) => {
    // Construit la requête : adresse complète en priorité, ville en fallback
    const query = encodeURIComponent(`${adresse ? adresse + ', ' : ''}${cp ? cp + ' ' : ''}${ville}, France`);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&countrycodes=fr`;

    const options = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?q=${query}&format=json&limit=1&countrycodes=fr`,
      headers: { 'User-Agent': 'inkr.club/1.0 (hello@inkr.club)' }
    };

    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results && results[0]) {
            resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

async function run() {
  let done = 0, failed = 0;
  const startTime = Date.now();

  for (const t of todo) {
    const result = await geocode(t.adresse, t.cp, t.ville);
    if (result) {
      updateLatLng.run(result.lat, result.lng, t.id);
      done++;
      if (done % 50 === 0) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const remaining = Math.round((todo.length - done - failed) * 1.1);
        console.log(`  ✅ ${done}/${todo.length} géocodés (${failed} échecs) — ~${remaining}s restantes`);
      }
    } else {
      failed++;
    }
    // Respect limite Nominatim : 1 req/sec
    await sleep(1100);
  }

  console.log(`\n✅ Géocodage terminé !`);
  console.log(`   Géocodés : ${done}`);
  console.log(`   Échecs   : ${failed}`);
  console.log(`   Total    : ${done + failed}/${todo.length}`);
}

run().catch(err => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
