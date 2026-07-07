/**
 * scripts/generate_bios.js
 *
 * Génère automatiquement une bio et des styles pour les tatoueurs importés
 * qui n'en ont pas encore. Utilise les données existantes : categorie, ville,
 * instagram_handle, telephone, site_web.
 *
 * Usage Railway : node scripts/generate_bios.js
 */

'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'inkr.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

// Mapping catégorie Google Maps → styles tatouage
const CATEGORIE_TO_STYLES = {
  'tattoo shop': ['Tous styles'],
  'tattoo artist': ['Tous styles'],
  'tatoueur': ['Tous styles'],
  'tatouage': ['Tous styles'],
  'salon de tatouage': ['Tous styles'],
  'studio de tatouage': ['Tous styles'],
  'piercing shop': [],
  'art studio': ['Tous styles'],
  'body art': ['Tous styles'],
  'custom tattoo': ['Sur-mesure'],
};

function getStylesFromCategorie(cat) {
  if (!cat) return [];
  const key = cat.toLowerCase().trim();
  for (const [k, v] of Object.entries(CATEGORIE_TO_STYLES)) {
    if (key.includes(k)) return v;
  }
  return [];
}

function generateBio(t) {
  const nom = t.nom_commercial || t.nom;
  const ville = t.ville || '';
  const ig = t.instagram_handle ? `@${t.instagram_handle}` : '';
  const tel = t.telephone || '';
  const site = t.site_web || '';

  const parts = [];

  // Phrase d'accroche
  const cat = (t.categorie || '').toLowerCase();
  if (cat.includes('studio') || cat.includes('shop') || cat.includes('salon')) {
    parts.push(`Studio de tatouage${ville ? ' à ' + ville : ''}.`);
  } else {
    parts.push(`Artiste tatoueur${ville ? ' basé à ' + ville : ''}.`);
  }

  // Contact
  const contacts = [];
  if (ig) contacts.push(`Instagram : ${ig}`);
  if (tel) contacts.push(`Tél : ${tel}`);
  if (site) contacts.push(`Site : ${site.replace(/^https?:\/\//,'').split('/')[0]}`);
  if (contacts.length) parts.push('Pour prendre rendez-vous — ' + contacts.join(' · ') + '.');

  // Mention fiche
  parts.push('Fiche référencée sur inkr.club — réclamez-la gratuitement pour la personnaliser.');

  return parts.join(' ');
}

const todo = db.prepare(`
  SELECT id, nom, nom_commercial, ville, categorie, instagram_handle, telephone, site_web
  FROM tatoueurs
  WHERE statut='active'
    AND (bio IS NULL OR bio = '')
    AND source = 'import_gmap'
`).all();

console.log(`📝 ${todo.length} tatoueurs sans bio à traiter`);

const updateBio    = db.prepare("UPDATE tatoueurs SET bio=? WHERE id=?");
const updateStyles = db.prepare("UPDATE tatoueurs SET styles=? WHERE id=? AND (styles IS NULL OR styles='[]' OR styles='')");

let bioDone = 0, stylesDone = 0;

db.exec('BEGIN');
for (const t of todo) {
  const bio = generateBio(t);
  updateBio.run(bio, t.id);
  bioDone++;

  const styles = getStylesFromCategorie(t.categorie);
  if (styles.length) {
    updateStyles.run(JSON.stringify(styles), t.id);
    stylesDone++;
  }
}
db.exec('COMMIT');

console.log(`✅ ${bioDone} bios générées`);
console.log(`✅ ${stylesDone} fiches avec styles ajoutés`);
console.log('Terminé !');
