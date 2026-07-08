/**
 * db/database.js
 *
 * Point d'entrée unique de la base de données SQLite.
 * Utilise node:sqlite natif (Node.js 22+) — aucune dépendance binaire à compiler.
 * Doc : https://nodejs.org/api/sqlite.html
 *
 * ─── Architecture ─────────────────────────────────────────────────────────────
 *
 *  1. PRAGMAS           → WAL + foreign keys activés au démarrage
 *  2. CREATE TABLE      → définition du schéma complet (idempotent)
 *  3. runMigrations()   → toutes les colonnes ajoutées après création initiale
 *                         ← TOUJOURS ajouter les nouvelles colonnes ICI, pas
 *                            dans les fichiers de routes.
 *  4. createIndexes()   → index de performance (idempotents)
 *  5. initDefaultAutomations(userId) → appelé à l'inscription d'un artiste
 *
 * ─── Configuration Railway ────────────────────────────────────────────────────
 *
 *  DB_PATH=/app/data/inkr.db   ← OBLIGATOIRE sur Railway.
 *                                 Ce chemin doit pointer vers un Volume Persistant.
 *                                 Sans volume, les données sont effacées à chaque deploy.
 *
 *  Pour ajouter un volume sur Railway :
 *    Dashboard → projet → Add Service → Volume
 *    Mount path : /app/data
 *    Puis DB_PATH=/app/data/inkr.db dans les Variables.
 *
 * ─── Migrations ───────────────────────────────────────────────────────────────
 *
 *  Règle : toute nouvelle colonne SQL va dans runMigrations(), UNIQUEMENT ici.
 *  Le try/catch sur chaque migration est intentionnel : SQLite ne supporte pas
 *  "ADD COLUMN IF NOT EXISTS". Une colonne déjà existante lève une erreur
 *  qu'on ignore silencieusement.
 *
 * ─── Développeur — points importants ─────────────────────────────────────────
 *
 *  • DatabaseSync est synchrone (pas de callbacks, pas de Promises).
 *    C'est un choix délibéré : SQLite est rapide et le code est plus lisible.
 *
 *  • Les colonnes JSON (styles, tags, channels) sont stockées en TEXT.
 *    Toujours parser avec JSON.parse() au read et JSON.stringify() au write.
 *    La validation de format est à la charge des routes.
 *
 *  • foreign_keys est activé. Les INSERT/DELETE échouent si la FK est violée.
 *    Conséquence : supprimer un user supprime en cascade ses données
 *    uniquement si ON DELETE CASCADE est déclaré (voir RGPD route).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// ─── Chemin de la base ───────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'inkr.db');
const db = new DatabaseSync(DB_PATH);

// ─── PRAGMAs système ─────────────────────────────────────────────────────────
// WAL : Writes non-bloquantes + meilleures perfs en lecture concurrente.
// foreign_keys : Enforce les contraintes FK déclarées dans le schéma.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ─── SCHÉMA — Tables principales ─────────────────────────────────────────────
// Toutes les tables sont créées en IF NOT EXISTS → idempotent au redémarrage.
db.exec(`

  /* ── Artistes (comptes inkr Pro) ─────────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT    UNIQUE NOT NULL,
    password_hash   TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    studio_name     TEXT,
    city            TEXT,
    phone           TEXT,
    role            TEXT    DEFAULT 'artist',   -- 'artist' | 'admin' | 'dev'
    avatar_seed     TEXT,
    is_pro          INTEGER DEFAULT 0,          -- 0 = gratuit, 1 = abonné PRO
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── Clients d'un artiste ─────────────────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS clients (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    email           TEXT,
    phone           TEXT,
    city            TEXT,
    notes           TEXT,
    tags            TEXT    DEFAULT '[]',       -- JSON array de strings
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── Rendez-vous ──────────────────────────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS appointments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_name     TEXT,
    client_email    TEXT,
    client_phone    TEXT,
    style           TEXT,
    body_zone       TEXT,
    size            TEXT,
    description     TEXT,
    date            TEXT,
    time            TEXT,
    duration        INTEGER DEFAULT 2,
    price           REAL,
    deposit         REAL    DEFAULT 50,
    status          TEXT    DEFAULT 'pending',  -- 'pending'|'confirmed'|'cancelled'|'done'
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── Campagnes marketing ──────────────────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS campaigns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    template        TEXT,
    message         TEXT    NOT NULL,
    channels        TEXT    DEFAULT '[]',       -- JSON array: ['sms','email','whatsapp']
    audience        TEXT    DEFAULT 'all',
    status          TEXT    DEFAULT 'draft',    -- 'draft'|'scheduled'|'sent'
    sent_count      INTEGER DEFAULT 0,
    open_count      INTEGER DEFAULT 0,
    scheduled_at    DATETIME,
    sent_at         DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── Messages (messagerie unifiée : Instagram, WhatsApp, Email) ───────────── */
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_name     TEXT,
    client_seed     TEXT,
    channel         TEXT    DEFAULT 'email',    -- 'email'|'whatsapp'|'instagram'|'sms'
    direction       TEXT    DEFAULT 'in',       -- 'in'|'out'
    content         TEXT    NOT NULL,
    subject         TEXT,
    external_id     TEXT    UNIQUE,             -- ID Meta / Mailgun (dédoublonnage)
    phone           TEXT,
    is_read         INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── Automatisations (rappels, relances, anniversaires…) ─────────────────── */
  CREATE TABLE IF NOT EXISTS automations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            TEXT    NOT NULL,
    enabled         INTEGER DEFAULT 1,
    message         TEXT,
    delay_value     INTEGER DEFAULT 1,
    delay_unit      TEXT    DEFAULT 'day',      -- 'hour'|'day'|'month'
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, type)                       -- 1 automation par type par artiste
  );

  /* ── Répertoire public des tatoueurs (annuaire inkr) ─────────────────────── */
  CREATE TABLE IF NOT EXISTS tatoueurs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL, -- null si import externe
    nom             TEXT    NOT NULL,
    nom_commercial  TEXT    DEFAULT '',
    siren           TEXT    DEFAULT '',
    adresse         TEXT    DEFAULT '',
    cp              TEXT    DEFAULT '',
    ville           TEXT    NOT NULL,
    telephone       TEXT    DEFAULT '',
    email           TEXT    DEFAULT '',
    instagram       TEXT    DEFAULT '',
    site_web        TEXT    DEFAULT '',
    styles          TEXT    DEFAULT '[]',       -- JSON array
    bio             TEXT    DEFAULT '',
    auto_reply      TEXT    DEFAULT '',
    horaires        TEXT    DEFAULT '',         -- JSON {lundi:{open,close}, …}
    dispo_flash     INTEGER DEFAULT 0,
    lat             REAL    DEFAULT 0,
    lng             REAL    DEFAULT 0,
    source          TEXT    DEFAULT 'import',   -- 'import'|'inkr_pro'
    statut          TEXT    DEFAULT 'active',   -- 'active'|'inactive'
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── Dates de tournée (artiste itinérant) ────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS tournee_dates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    city            TEXT    NOT NULL,
    date_from       TEXT    NOT NULL,
    date_to         TEXT    NOT NULL,
    description     TEXT    DEFAULT '',
    spots           INTEGER DEFAULT 5,
    active          INTEGER DEFAULT 1,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── Programme fidélité ──────────────────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS loyalty_points (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    artist_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    points          INTEGER NOT NULL,
    reason          TEXT    DEFAULT '',
    appointment_id  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── Conversations clients (booking public inkr.club → artiste) ─────────── */
  /* Schéma aligné avec routes/auth.js (artist-conversations) et               */
  /* routes/client_auth.js (vue client). La FK tatoueur_id → tatoueurs.id      */
  /* est la clé de jointure principale utilisée des deux côtés.                */
  CREATE TABLE IF NOT EXISTS client_conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tatoueur_id     INTEGER REFERENCES tatoueurs(id) ON DELETE CASCADE,
    client_id       INTEGER REFERENCES client_accounts(id) ON DELETE SET NULL,
    guest_prenom    TEXT    DEFAULT '',
    guest_nom       TEXT    DEFAULT '',
    guest_email     TEXT    DEFAULT '',
    guest_telephone TEXT    DEFAULT '',
    tatoueur_nom    TEXT    DEFAULT '',
    booking_style   TEXT    DEFAULT '',
    booking_zone    TEXT    DEFAULT '',
    booking_taille  TEXT    DEFAULT '',
    booking_date    TEXT    DEFAULT '',
    booking_desc    TEXT    DEFAULT '',
    status          TEXT    DEFAULT 'pending',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── Messages dans les conversations client ──────────────────────────────── */
  CREATE TABLE IF NOT EXISTS client_messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id     INTEGER NOT NULL REFERENCES client_conversations(id) ON DELETE CASCADE,
    sender              TEXT    DEFAULT 'client',  -- 'client'|'artist'
    content             TEXT    NOT NULL,
    is_read_by_artist   INTEGER DEFAULT 0,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── Devis ───────────────────────────────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS quotes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id         INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_name       TEXT    DEFAULT '',
    client_email      TEXT    DEFAULT '',
    title             TEXT    DEFAULT 'Devis tatouage',
    items             TEXT    DEFAULT '[]',
    total             REAL    DEFAULT 0,
    status            TEXT    DEFAULT 'draft',
    notes             TEXT    DEFAULT '',
    valid_until       TEXT    DEFAULT NULL,
    token             TEXT    DEFAULT NULL,
    acompte_requested INTEGER DEFAULT 0,
    acompte_amount    REAL    DEFAULT 0,
    acompte_status    TEXT    DEFAULT 'none',
    acompte_url       TEXT    DEFAULT NULL,
    sent_at           DATETIME DEFAULT NULL,
    accepted_at       DATETIME DEFAULT NULL,
    refused_at        DATETIME DEFAULT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );

`);

// ─── MIGRATIONS — colonnes ajoutées après déploiement initial ─────────────────
// Règle absolue : toute nouvelle colonne va dans ce tableau, JAMAIS dans les routes.
// SQLite ne supporte pas "ADD COLUMN IF NOT EXISTS" → on ignore les erreurs
// "duplicate column name" qui indiquent que la migration a déjà été appliquée.
function runMigrations() {
  const migrations = [

    // ── v1 : champs complémentaires clients ───────────────────────────────────
    'ALTER TABLE clients ADD COLUMN prenom TEXT DEFAULT ""',
    'ALTER TABLE clients ADD COLUMN age INTEGER DEFAULT 0',
    'ALTER TABLE clients ADD COLUMN date_naissance TEXT DEFAULT ""',
    'ALTER TABLE clients ADD COLUMN photo_url TEXT DEFAULT ""',
    'ALTER TABLE clients ADD COLUMN instagram TEXT DEFAULT ""',
    'ALTER TABLE clients ADD COLUMN whatsapp TEXT DEFAULT ""',

    // ── v1 : acomptes Stripe sur les RDV ──────────────────────────────────────
    'ALTER TABLE appointments ADD COLUMN acompte_amount REAL DEFAULT 0',
    'ALTER TABLE appointments ADD COLUMN acompte_status TEXT DEFAULT "none"',
    'ALTER TABLE appointments ADD COLUMN acompte_stripe_url TEXT DEFAULT ""',

    // ── v1 : champs profil artiste ────────────────────────────────────────────
    'ALTER TABLE users ADD COLUMN prenom TEXT DEFAULT ""',
    'ALTER TABLE users ADD COLUMN nom_artiste TEXT DEFAULT ""',
    'ALTER TABLE users ADD COLUMN adresse TEXT DEFAULT ""',
    'ALTER TABLE users ADD COLUMN cp TEXT DEFAULT ""',
    'ALTER TABLE users ADD COLUMN instagram TEXT DEFAULT ""',
    'ALTER TABLE users ADD COLUMN pinterest TEXT DEFAULT ""',
    'ALTER TABLE users ADD COLUMN en_tournee INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN styles TEXT DEFAULT "[]"',
    'ALTER TABLE users ADD COLUMN auto_reply TEXT DEFAULT ""',
    'ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ""',
    'ALTER TABLE users ADD COLUMN horaires TEXT DEFAULT ""',
    'ALTER TABLE users ADD COLUMN dispo_flash INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN is_pro INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN paypal_me_url TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN stripe_me_link TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN stripe_connect_id TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN photo_salon TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN photo_artiste TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN reset_token TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN reset_token_expires DATETIME DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN otp_code TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN otp_expires DATETIME DEFAULT NULL',

    // ── v1 : messagerie unifiée ───────────────────────────────────────────────
    'ALTER TABLE messages ADD COLUMN client_id INTEGER DEFAULT NULL',
    'ALTER TABLE messages ADD COLUMN external_id TEXT DEFAULT NULL',
    'ALTER TABLE messages ADD COLUMN phone TEXT DEFAULT NULL',
    'ALTER TABLE messages ADD COLUMN subject TEXT DEFAULT NULL',
    'ALTER TABLE messages ADD COLUMN email_from_addr TEXT DEFAULT NULL',
    'ALTER TABLE messages ADD COLUMN email_to_addr TEXT DEFAULT NULL',

    // ── v2 : intégrations Meta ────────────────────────────────────────────────
    'ALTER TABLE users ADD COLUMN meta_wa_phone_id TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN meta_wa_access_token TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN meta_wa_business_id TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN meta_wa_connected_at DATETIME DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN meta_wa_phone_display TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN meta_ig_page_id TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN meta_ig_access_token TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN meta_ig_username TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN meta_ig_connected_at DATETIME DEFAULT NULL',

    // ── v2 : WhatsApp perso (Baileys QR) ─────────────────────────────────────
    'ALTER TABLE users ADD COLUMN wa_personal_connected INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN wa_personal_phone TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN wa_personal_name TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN wa_personal_connected_at DATETIME DEFAULT NULL',

    // ── v2 : email @inkr.club ─────────────────────────────────────────────────
    'ALTER TABLE users ADD COLUMN inkr_email_slug TEXT DEFAULT NULL',

    // ── v2 : annuaire public (lien tatoueurs ↔ users) ─────────────────────────
    'ALTER TABLE tatoueurs ADD COLUMN user_id INTEGER DEFAULT NULL',
    'ALTER TABLE tatoueurs ADD COLUMN horaires TEXT DEFAULT ""',
    'ALTER TABLE tatoueurs ADD COLUMN dispo_flash INTEGER DEFAULT 0',
    'ALTER TABLE tatoueurs ADD COLUMN auto_reply TEXT DEFAULT ""',

    // ── v3 : RGPD — consentement au traitement des données ────────────────────
    'ALTER TABLE users ADD COLUMN rgpd_consent INTEGER DEFAULT 0',
    'ALTER TABLE users ADD COLUMN rgpd_consent_at DATETIME DEFAULT NULL',
    'ALTER TABLE clients ADD COLUMN rgpd_consent INTEGER DEFAULT 0',
    'ALTER TABLE clients ADD COLUMN rgpd_consent_at DATETIME DEFAULT NULL',

    // ── v4 : fix client_conversations — alignement schéma auth.js / client_auth.js
    // Les installs existantes avaient artist_id/client_user_id — on ajoute les bonnes colonnes.
    'ALTER TABLE client_conversations ADD COLUMN tatoueur_id INTEGER DEFAULT NULL',
    'ALTER TABLE client_conversations ADD COLUMN client_id INTEGER DEFAULT NULL',
    'ALTER TABLE client_conversations ADD COLUMN tatoueur_nom TEXT DEFAULT ""',
    'ALTER TABLE client_conversations ADD COLUMN booking_style TEXT DEFAULT ""',
    'ALTER TABLE client_conversations ADD COLUMN booking_zone TEXT DEFAULT ""',
    'ALTER TABLE client_conversations ADD COLUMN booking_taille TEXT DEFAULT ""',
    'ALTER TABLE client_conversations ADD COLUMN booking_date TEXT DEFAULT ""',
    'ALTER TABLE client_conversations ADD COLUMN booking_desc TEXT DEFAULT ""',

    // ── v4 : fix quotes — colonnes manquantes dans le schéma initial
    'ALTER TABLE quotes ADD COLUMN token TEXT DEFAULT NULL',
    'ALTER TABLE quotes ADD COLUMN accepted_at DATETIME DEFAULT NULL',
    'ALTER TABLE quotes ADD COLUMN refused_at DATETIME DEFAULT NULL',
    'ALTER TABLE quotes ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP',
    'ALTER TABLE quotes ADD COLUMN acompte_requested INTEGER DEFAULT 0',
    'ALTER TABLE quotes ADD COLUMN acompte_amount REAL DEFAULT 0',
    'ALTER TABLE quotes ADD COLUMN acompte_status TEXT DEFAULT "none"',
    'ALTER TABLE quotes ADD COLUMN acompte_url TEXT DEFAULT NULL',

    // ── v4 : persistance fidélité + facturation (plus de localStorage)
    'ALTER TABLE users ADD COLUMN loyalty_config TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN billing_json TEXT DEFAULT NULL',

    // ── v4 : méta-page token (connexion Facebook/Instagram)
    'ALTER TABLE users ADD COLUMN meta_page_id TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN meta_page_token TEXT DEFAULT NULL',
    // ── v4 : Stripe customer_id pour lier abonnements Pro
    'ALTER TABLE users ADD COLUMN stripe_customer_id TEXT DEFAULT NULL',

    // ── v5 : import tatoueurs Google Maps — champs supplémentaires
    'ALTER TABLE tatoueurs ADD COLUMN facebook TEXT DEFAULT NULL',
    'ALTER TABLE tatoueurs ADD COLUMN instagram_handle TEXT DEFAULT NULL',
    'ALTER TABLE tatoueurs ADD COLUMN categorie TEXT DEFAULT NULL',
    // claimed = 0 → fiche importée non réclamée | 1 → artiste a créé son compte
    'ALTER TABLE tatoueurs ADD COLUMN claimed INTEGER DEFAULT 0',

    // ── v6 : CRM outreach — suivi des contacts Instagram
    "ALTER TABLE tatoueurs ADD COLUMN outreach_status TEXT DEFAULT 'non_contacte'",
    'ALTER TABLE tatoueurs ADD COLUMN outreach_date TEXT DEFAULT NULL',
    'ALTER TABLE tatoueurs ADD COLUMN outreach_notes TEXT DEFAULT NULL',

    // ── v7 : studio + followers Instagram (scraping auto) ────────────────────
    'ALTER TABLE users ADD COLUMN ig_followers INTEGER DEFAULT NULL',
    "ALTER TABLE tatoueurs ADD COLUMN studio_nom TEXT DEFAULT ''",
    'ALTER TABLE tatoueurs ADD COLUMN ig_followers INTEGER DEFAULT NULL',
    'ALTER TABLE tatoueurs ADD COLUMN ig_followers_scraped_at DATETIME DEFAULT NULL',
  ];

  let applied = 0;
  migrations.forEach(sql => {
    try {
      db.exec(sql);
      applied++;
    } catch (_) {
      // Colonne déjà existante — ignoré intentionnellement
    }
  });

  if (applied > 0) {
    console.log(`[DB] ${applied} migration(s) appliquée(s)`);
  }
}

// ─── INDEX de performance ─────────────────────────────────────────────────────
// Tous les index sont en IF NOT EXISTS → idempotents.
function createIndexes() {
  const indexes = [
    // Lookup des clients d'un artiste (requête la plus fréquente)
    'CREATE INDEX IF NOT EXISTS idx_clients_user_id ON clients(user_id)',
    // Lookup des RDV d'un artiste (tri par date)
    'CREATE INDEX IF NOT EXISTS idx_appointments_user_date ON appointments(user_id, date)',
    // Lookup des messages d'un artiste (messagerie unifiée)
    'CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id, created_at)',
    // Dédoublonnage des messages Meta/Mailgun (external_id unique)
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_id ON messages(external_id) WHERE external_id IS NOT NULL',
    // Recherche d'un artiste par son email (login)
    'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
    // Lien tatoueurs ↔ users (sync profil → annuaire)
    'CREATE INDEX IF NOT EXISTS idx_tatoueurs_user_id ON tatoueurs(user_id)',
    // Lookup des points fidélité d'un client
    'CREATE INDEX IF NOT EXISTS idx_loyalty_client ON loyalty_points(client_id, artist_id)',
  ];

  indexes.forEach(sql => {
    try { db.exec(sql); } catch (_) { /* index déjà existant */ }
  });
}

// ─── AUTOMATIONS par défaut ───────────────────────────────────────────────────
/**
 * Insère les automatisations par défaut pour un nouvel artiste.
 * Appelé une seule fois à l'inscription (routes/auth.js → register).
 * INSERT OR IGNORE → sans effet si les automations existent déjà.
 *
 * @param {number} userId - ID de l'artiste nouvellement inscrit
 */
function initDefaultAutomations(userId) {
  const defaults = [
    {
      type: 'sms_24h_before',
      enabled: 1,
      message: "Bonjour {{prénom}} ! Rappel de votre séance demain chez {{studio}}. À préparer : pas d'alcool 24h avant, bien s'hydrater, manger avant de venir, ne pas se raser la zone. À demain ! 🎨",
      delay_value: 24,
      delay_unit: 'hour',
    },
    {
      type: 'followup_j5',
      enabled: 1,
      message: "Bonjour {{prénom}} ! Comment va votre tatouage ? 🩹 5 jours après la séance c'est le bon moment pour vérifier la cicatrisation. N'hésitez pas si vous avez des questions !",
      delay_value: 5,
      delay_unit: 'day',
    },
    {
      type: 'retouche_j30',
      enabled: 0,
      message: "Bonjour {{prénom}} ! Votre tatouage a maintenant 1 mois 🎉 Si vous souhaitez une petite retouche, je vous offre la première retouche gratuite. Réservez ici : {{lien_résa}}",
      delay_value: 30,
      delay_unit: 'day',
    },
    {
      type: 'relance_m3',
      enabled: 0,
      message: "Bonjour {{prénom}} ! Ça fait un moment qu'on ne s'est pas vus... J'ai de nouveaux designs qui pourraient vous plaire ! Envie d'en discuter ? 😊",
      delay_value: 3,
      delay_unit: 'month',
    },
    {
      type: 'birthday',
      enabled: 1,
      message: "Joyeux anniversaire {{prénom}} ! 🎂 Pour fêter ça, je vous offre -15% sur votre prochain tatouage. Valable 1 mois !",
      delay_value: 0,
      delay_unit: 'day',
    },
  ];

  const insert = db.prepare(
    'INSERT OR IGNORE INTO automations (user_id, type, enabled, message, delay_value, delay_unit) VALUES (?, ?, ?, ?, ?, ?)'
  );
  defaults.forEach(a => insert.run(userId, a.type, a.enabled, a.message, a.delay_value, a.delay_unit));
}

// ─── Initialisation ───────────────────────────────────────────────────────────
runMigrations();
createIndexes();

// ─── Log de démarrage ─────────────────────────────────────────────────────────
const waMode = db.prepare("PRAGMA journal_mode").get();
const fkMode  = db.prepare("PRAGMA foreign_keys").get();
console.log(`[DB] SQLite prêt → ${DB_PATH}`);
console.log(`[DB] WAL: ${waMode?.journal_mode || '?'} | FK: ${fkMode?.foreign_keys === 1 ? 'ON ✓' : 'OFF ⚠️'}`);

module.exports = { db, initDefaultAutomations };
