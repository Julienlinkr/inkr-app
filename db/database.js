// node:sqlite est intégré à Node.js v22.5+ — aucune compilation requise
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'inkr.db'));

// Activation WAL pour meilleures performances
db.exec('PRAGMA journal_mode = WAL');

// ============ CRÉATION DES TABLES ============

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    studio_name TEXT,
    city TEXT,
    phone TEXT,
    role TEXT DEFAULT 'artist',
    avatar_seed TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    city TEXT,
    notes TEXT,
    tags TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    client_id INTEGER,
    client_name TEXT,
    client_email TEXT,
    client_phone TEXT,
    style TEXT,
    body_zone TEXT,
    size TEXT,
    description TEXT,
    date TEXT,
    time TEXT,
    duration INTEGER DEFAULT 2,
    price REAL,
    deposit REAL DEFAULT 50,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    template TEXT,
    message TEXT NOT NULL,
    channels TEXT DEFAULT '[]',
    audience TEXT DEFAULT 'all',
    status TEXT DEFAULT 'draft',
    sent_count INTEGER DEFAULT 0,
    open_count INTEGER DEFAULT 0,
    scheduled_at DATETIME,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    client_name TEXT,
    client_seed TEXT,
    channel TEXT DEFAULT 'email',
    direction TEXT DEFAULT 'in',
    content TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    message TEXT,
    delay_value INTEGER DEFAULT 1,
    delay_unit TEXT DEFAULT 'day',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS tournee_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    city TEXT NOT NULL,
    date_from TEXT NOT NULL,
    date_to TEXT NOT NULL,
    description TEXT DEFAULT '',
    spots INTEGER DEFAULT 5,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Automations par défaut pour les nouveaux utilisateurs
function initDefaultAutomations(userId) {
  const defaults = [
    { type: 'sms_24h_before', enabled: 1, message: 'Bonjour {{prénom}} ! Rappel de votre séance demain chez {{studio}}. À préparer : pas d\'alcool 24h avant, bien s\'hydrater, manger avant de venir, ne pas se raser la zone. À demain ! 🎨', delay_value: 24, delay_unit: 'hour' },
    { type: 'followup_j5', enabled: 1, message: 'Bonjour {{prénom}} ! Comment va votre tatouage ? 🩹 5 jours après la séance c\'est le bon moment pour vérifier la cicatrisation. N\'hésitez pas si vous avez des questions !', delay_value: 5, delay_unit: 'day' },
    { type: 'retouche_j30', enabled: 0, message: 'Bonjour {{prénom}} ! Votre tatouage a maintenant 1 mois 🎉 Si vous souhaitez une petite retouche, je vous offre la première retouche gratuite. Réservez ici : {{lien_résa}}', delay_value: 30, delay_unit: 'day' },
    { type: 'relance_m3', enabled: 0, message: 'Bonjour {{prénom}} ! Ça fait un moment qu\'on ne s\'est pas vus... J\'ai de nouveaux designs qui pourraient vous plaire ! Envie d\'en discuter ? 😊', delay_value: 3, delay_unit: 'month' },
    { type: 'birthday', enabled: 1, message: 'Joyeux anniversaire {{prénom}} ! 🎂 Pour fêter ça, je vous offre -15% sur votre prochain tatouage. Valable 1 mois !', delay_value: 0, delay_unit: 'day' },
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO automations (user_id, type, enabled, message, delay_value, delay_unit) VALUES (?, ?, ?, ?, ?, ?)');
  defaults.forEach(a => insert.run(userId, a.type, a.enabled, a.message, a.delay_value, a.delay_unit));
}

// Migrations pour colonnes ajoutées après création initiale
function runMigrations() {
  const migrations = [
    'ALTER TABLE clients ADD COLUMN prenom TEXT DEFAULT ""',
    'ALTER TABLE clients ADD COLUMN age INTEGER DEFAULT 0',
    'ALTER TABLE clients ADD COLUMN date_naissance TEXT DEFAULT ""',
    'ALTER TABLE clients ADD COLUMN photo_url TEXT DEFAULT ""',
    'ALTER TABLE appointments ADD COLUMN acompte_amount REAL DEFAULT 0',
    'ALTER TABLE appointments ADD COLUMN acompte_status TEXT DEFAULT "none"',
    'ALTER TABLE appointments ADD COLUMN acompte_stripe_url TEXT DEFAULT ""',
  ];
  migrations.forEach(sql => { try { db.exec(sql); } catch(e) { /* colonne déjà existante */ } });
}
runMigrations();

module.exports = { db, initDefaultAutomations };
