/**
 * scripts/import_tatoueurs.js
 *
 * Importe 7 900+ tatoueurs depuis data/tatoueurs_import.json dans la DB.
 * Dédoublonne par instagram_handle (priorité) puis par nom+ville.
 * Les fiches importées ont : claimed=0, source='import_gmap', user_id=NULL
 *
 * Usage (local ou Railway CLI) :
 *   node scripts/import_tatoueurs.js
 *   DB_PATH=/app/data/inkr.db node scripts/import_tatoueurs.js
 *
 * Idempotent : relancer le script ne crée pas de doublons.
 */

'use strict';

require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'inkr.db');
const DATA_PATH = path.join(__dirname, 'tatoueurs_import.json');

if (!fs.existsSync(DATA_PATH)) {
  console.error('❌ Fichier data/tatoueurs_import.json introuvable.');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = OFF'); // off pendant l'import

const records = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
console.log(`📂 ${records.length} tatoueurs à importer depuis ${DATA_PATH}`);

// ── Migrations préalables (au cas où le serveur n'a pas encore tourné) ────────
const migrations = [
  'ALTER TABLE tatoueurs ADD COLUMN facebook TEXT DEFAULT NULL',
  'ALTER TABLE tatoueurs ADD COLUMN instagram_handle TEXT DEFAULT NULL',
  'ALTER TABLE tatoueurs ADD COLUMN categorie TEXT DEFAULT NULL',
  'ALTER TABLE tatoueurs ADD COLUMN claimed INTEGER DEFAULT 0',
];
migrations.forEach(sql => { try { db.exec(sql); } catch (_) {} });

// ── Préparer les requêtes ──────────────────────────────────────────────────────
const checkByIg   = db.prepare("SELECT id FROM tatoueurs WHERE instagram_handle = ? AND instagram_handle != '' LIMIT 1");
const checkByNom  = db.prepare('SELECT id FROM tatoueurs WHERE nom = ? AND ville = ? LIMIT 1');
const insert      = db.prepare(`
  INSERT INTO tatoueurs
    (nom, nom_commercial, adresse, cp, ville, telephone, instagram, instagram_handle,
     site_web, facebook, categorie, source, statut, claimed)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import_gmap', 'active', 0)
`);

let inserted = 0;
let skipped  = 0;

// Tout dans une transaction pour la performance (x50 plus rapide)
db.exec('BEGIN');
try {
  for (const r of records) {
    // Vérifier doublon par Instagram handle
    if (r.instagram_handle) {
      const exists = checkByIg.get(r.instagram_handle);
      if (exists) { skipped++; continue; }
    } else {
      // Fallback : doublon par nom + ville
      const exists = checkByNom.get(r.nom, r.ville || '');
      if (exists) { skipped++; continue; }
    }

    insert.run(
      r.nom,
      r.nom,          // nom_commercial = nom par défaut
      r.adresse || '',
      r.cp || '',
      r.ville || '',
      r.telephone || '',
      r.instagram || '',
      r.instagram_handle || '',
      r.site_web || '',
      r.facebook || '',
      r.categorie || 'Tatoueur',
    );
    inserted++;
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('❌ Erreur pendant l\'import :', err.message);
  process.exit(1);
}

db.exec('PRAGMA foreign_keys = ON');

const total = db.prepare('SELECT COUNT(*) as n FROM tatoueurs').get();
console.log(`\n✅ Import terminé !`);
console.log(`   Insérés  : ${inserted}`);
console.log(`   Skippés  : ${skipped} (doublons)`);
console.log(`   Total DB : ${total.n} tatoueurs`);
