/**
 * routes/client_auth.js
 *
 * Système de compte client inkr — distinct des comptes artistes.
 *
 * ─── Pour les développeurs ──────────────────────────────────────────────────
 *  Les comptes clients ("grand public") sont séparés des comptes artistes
 *  (table `users`). Chaque client peut :
 *    - Créer un compte avec Prénom, Nom, Email, Téléphone, Mot de passe
 *    - Se connecter / se déconnecter
 *    - Suivre des artistes (bookmarks persistants côté serveur)
 *    - Consulter son historique de séances de tatouage
 *    - Recevoir des notifications (nouveautés des artistes suivis)
 *
 *  JWT stocké dans le cookie `inkr_client_token` (httpOnly, 30 jours)
 *
 *  Tables SQLite créées ici :
 *    - client_accounts        : données du compte client
 *    - client_follows         : artistes suivis par le client
 *    - client_history         : historique des séances de tatouage
 *    - client_notifications   : notifications plateforme (nouveautés artistes)
 *
 *  Routes :
 *    POST   /api/client/register
 *    POST   /api/client/login
 *    POST   /api/client/logout
 *    GET    /api/client/me
 *    PUT    /api/client/profile
 *    GET    /api/client/follows
 *    POST   /api/client/follow/:tatoueur_id
 *    DELETE /api/client/follow/:tatoueur_id
 *    GET    /api/client/history
 *    POST   /api/client/history
 *    DELETE /api/client/history/:id
 *    GET    /api/client/notifications
 *    PUT    /api/client/notifications/read-all
 * ────────────────────────────────────────────────────────────────────────────
 */

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { db }   = require('../db/database');

const JWT_SECRET  = process.env.JWT_SECRET || 'inkr_secret_dev';
const COOKIE_NAME = 'inkr_client_token';
const COOKIE_OPTS = { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' };

// ── Création des tables ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS client_accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    prenom        TEXT    NOT NULL DEFAULT '',
    nom           TEXT    NOT NULL DEFAULT '',
    email         TEXT    UNIQUE NOT NULL,
    telephone     TEXT    DEFAULT '',
    password_hash TEXT    NOT NULL,
    avatar_color  TEXT    DEFAULT '#a855f7',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS client_follows (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER NOT NULL,
    tatoueur_id INTEGER NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_id, tatoueur_id),
    FOREIGN KEY (client_id) REFERENCES client_accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS client_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     INTEGER NOT NULL,
    tatoueur_id   INTEGER,
    tatoueur_nom  TEXT    NOT NULL DEFAULT '',
    date_seance   TEXT    DEFAULT '',
    description   TEXT    DEFAULT '',
    zone_corps    TEXT    DEFAULT '',
    photo_url     TEXT    DEFAULT '',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES client_accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS client_notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER NOT NULL,
    tatoueur_id INTEGER,
    type        TEXT    DEFAULT 'info',
    title       TEXT    NOT NULL DEFAULT '',
    body        TEXT    DEFAULT '',
    link        TEXT    DEFAULT '',
    is_read     INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES client_accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS client_conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id       INTEGER NOT NULL,
    tatoueur_id     INTEGER,
    tatoueur_nom    TEXT    NOT NULL DEFAULT '',
    booking_style   TEXT    DEFAULT '',
    booking_zone    TEXT    DEFAULT '',
    booking_taille  TEXT    DEFAULT '',
    booking_date    TEXT    DEFAULT '',
    booking_desc    TEXT    DEFAULT '',
    status          TEXT    DEFAULT 'pending',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES client_accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS client_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender          TEXT    NOT NULL DEFAULT 'client',
    content         TEXT    NOT NULL DEFAULT '',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES client_conversations(id) ON DELETE CASCADE
  );
`);

// ── Middleware auth client ───────────────────────────────────────────────────
function requireClientAuth(req, res, next) {
  try {
    const token   = req.cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Non connecté' });
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.clientId) return res.status(401).json({ error: 'Token invalide' });
    req.clientId  = decoded.clientId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expirée, veuillez vous reconnecter' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function toPublicClient(c) {
  return {
    id:           c.id,
    prenom:       c.prenom,
    nom:          c.nom,
    email:        c.email,
    telephone:    c.telephone,
    avatar_color: c.avatar_color,
    initials:     ((c.prenom?.[0]||'') + (c.nom?.[0]||'')).toUpperCase(),
    created_at:   c.created_at,
  };
}

// ── POST /api/client/register ────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { prenom, nom, email, telephone, password } = req.body;
    if (!prenom || !nom || !email || !password)
      return res.status(400).json({ error: 'Prénom, nom, email et mot de passe requis' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });

    // Vérifier si l'email existe déjà
    const existing = db.prepare('SELECT id FROM client_accounts WHERE LOWER(email)=LOWER(?)').get(email);
    if (existing) return res.status(409).json({ error: 'Un compte avec cet email existe déjà' });

    const password_hash = await bcrypt.hash(password, 10);
    // Couleur d'avatar générée depuis l'email (diversité visuelle)
    const colors = ['#a855f7','#ec4899','#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4'];
    const avatar_color = colors[email.charCodeAt(0) % colors.length];

    const result = db.prepare(
      'INSERT INTO client_accounts (prenom, nom, email, telephone, password_hash, avatar_color) VALUES (?,?,?,?,?,?)'
    ).run(prenom.trim(), nom.trim(), email.toLowerCase().trim(), (telephone||'').trim(), password_hash, avatar_color);

    const token = jwt.sign({ clientId: result.lastInsertRowid, email }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);

    const client = db.prepare('SELECT * FROM client_accounts WHERE id=?').get(result.lastInsertRowid);
    res.json({ ok: true, client: toPublicClient(client) });
  } catch (e) {
    console.error('[client/register]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/client/login ───────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const client = db.prepare('SELECT * FROM client_accounts WHERE LOWER(email)=LOWER(?)').get(email);
    if (!client) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const ok = await bcrypt.compare(password, client.password_hash);
    if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const token = jwt.sign({ clientId: client.id, email: client.email }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ ok: true, client: toPublicClient(client) });
  } catch (e) {
    console.error('[client/login]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/client/logout ──────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ── GET /api/client/me ───────────────────────────────────────────────────────
router.get('/me', requireClientAuth, (req, res) => {
  try {
    const client = db.prepare('SELECT * FROM client_accounts WHERE id=?').get(req.clientId);
    if (!client) return res.status(404).json({ error: 'Compte introuvable' });
    res.json(toPublicClient(client));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/client/profile ──────────────────────────────────────────────────
router.put('/profile', requireClientAuth, (req, res) => {
  try {
    const { prenom, nom, telephone } = req.body;
    db.prepare('UPDATE client_accounts SET prenom=?, nom=?, telephone=? WHERE id=?')
      .run(prenom||'', nom||'', telephone||'', req.clientId);
    const client = db.prepare('SELECT * FROM client_accounts WHERE id=?').get(req.clientId);
    res.json({ ok: true, client: toPublicClient(client) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/client/follows ──────────────────────────────────────────────────
router.get('/follows', requireClientAuth, (req, res) => {
  try {
    const follows = db.prepare(`
      SELECT cf.tatoueur_id, cf.created_at,
             t.nom, t.nom_commercial, t.ville, t.instagram, t.styles
      FROM client_follows cf
      LEFT JOIN tatoueurs t ON t.id = cf.tatoueur_id
      WHERE cf.client_id = ?
      ORDER BY cf.created_at DESC
    `).all(req.clientId);
    res.json(follows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/client/follow/:tatoueur_id ─────────────────────────────────────
router.post('/follow/:tatoueur_id', requireClientAuth, (req, res) => {
  try {
    const tid = parseInt(req.params.tatoueur_id);
    db.prepare('INSERT OR IGNORE INTO client_follows (client_id, tatoueur_id) VALUES (?,?)').run(req.clientId, tid);
    res.json({ ok: true, following: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/client/follow/:tatoueur_id ───────────────────────────────────
router.delete('/follow/:tatoueur_id', requireClientAuth, (req, res) => {
  try {
    const tid = parseInt(req.params.tatoueur_id);
    db.prepare('DELETE FROM client_follows WHERE client_id=? AND tatoueur_id=?').run(req.clientId, tid);
    res.json({ ok: true, following: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/client/history ──────────────────────────────────────────────────
router.get('/history', requireClientAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM client_history WHERE client_id=? ORDER BY date_seance DESC, created_at DESC').all(req.clientId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/client/history ─────────────────────────────────────────────────
router.post('/history', requireClientAuth, (req, res) => {
  try {
    const { tatoueur_id, tatoueur_nom, date_seance, description, zone_corps, photo_url } = req.body;
    if (!tatoueur_nom) return res.status(400).json({ error: 'Nom du tatoueur requis' });
    const result = db.prepare(`
      INSERT INTO client_history (client_id, tatoueur_id, tatoueur_nom, date_seance, description, zone_corps, photo_url)
      VALUES (?,?,?,?,?,?,?)
    `).run(req.clientId, tatoueur_id||null, tatoueur_nom, date_seance||'', description||'', zone_corps||'', photo_url||'');
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/client/history/:id ───────────────────────────────────────────
router.delete('/history/:id', requireClientAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM client_history WHERE id=? AND client_id=?').run(parseInt(req.params.id), req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/client/notifications ────────────────────────────────────────────
router.get('/notifications', requireClientAuth, (req, res) => {
  try {
    const notifs = db.prepare(
      'SELECT * FROM client_notifications WHERE client_id=? ORDER BY created_at DESC LIMIT 50'
    ).all(req.clientId);
    const unread = db.prepare('SELECT COUNT(*) as cnt FROM client_notifications WHERE client_id=? AND is_read=0').get(req.clientId)?.cnt || 0;
    res.json({ notifications: notifs, unread });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/client/notifications/read-all ───────────────────────────────────
router.put('/notifications/read-all', requireClientAuth, (req, res) => {
  try {
    db.prepare('UPDATE client_notifications SET is_read=1 WHERE client_id=?').run(req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CONVERSATIONS — Messagerie client ↔ artiste
//
//  Chaque demande de RDV crée une conversation.
//  Les messages sont stockés par ordre chronologique dans client_messages.
//  Le premier message (sender='artist') est la réponse automatique de l'artiste.
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/client/conversations ── Créer une conversation (demande de RDV) ─
router.post('/conversations', requireClientAuth, (req, res) => {
  try {
    const {
      tatoueur_id, tatoueur_nom,
      booking_style, booking_zone, booking_taille, booking_date, booking_desc,
      auto_reply,   // message de réponse automatique de l'artiste
    } = req.body;

    if (!tatoueur_nom) return res.status(400).json({ error: 'Nom du tatoueur requis' });

    // Créer la conversation
    const result = db.prepare(`
      INSERT INTO client_conversations
        (client_id, tatoueur_id, tatoueur_nom, booking_style, booking_zone, booking_taille, booking_date, booking_desc)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      req.clientId,
      tatoueur_id || null,
      tatoueur_nom,
      booking_style  || '',
      booking_zone   || '',
      booking_taille || '',
      booking_date   || '',
      booking_desc   || '',
    );

    const convId = result.lastInsertRowid;

    // Insérer la réponse automatique de l'artiste comme premier message
    const replyText = auto_reply ||
      `Bonjour ! J'ai bien reçu ta demande 🎨 Je reviendrai vers toi dans les 48h pour qu'on discute de ton projet. Tu peux m'envoyer d'autres références ici si tu en as.\n\nÀ très vite ! ✌️`;

    db.prepare(`
      INSERT INTO client_messages (conversation_id, sender, content) VALUES (?,?,?)
    `).run(convId, 'artist', replyText);

    res.json({ ok: true, id: convId });
  } catch (e) {
    console.error('[client/conversations POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/client/guest-booking ── Demande de RDV sans compte client ─────────
// Permet aux visiteurs non connectés de soumettre une demande de RDV.
// client_id = 0 (SQLite ne vérifie pas les FK sans PRAGMA foreign_keys=ON).
// Les infos du visiteur sont stockées dans les colonnes guest_* de client_conversations.
router.post('/guest-booking', (req, res) => {
  try {
    const {
      tatoueur_id, tatoueur_nom,
      booking_style, booking_zone, booking_taille, booking_date, booking_desc,
      auto_reply,
      guest_prenom, guest_nom, guest_email, guest_telephone,
    } = req.body;

    if (!tatoueur_nom)   return res.status(400).json({ error: 'Nom du tatoueur requis' });
    if (!guest_email)    return res.status(400).json({ error: 'Email requis' });

    const result = db.prepare(`
      INSERT INTO client_conversations
        (client_id, tatoueur_id, tatoueur_nom,
         booking_style, booking_zone, booking_taille, booking_date, booking_desc,
         guest_prenom, guest_nom, guest_email, guest_telephone)
      VALUES (NULL,?,?, ?,?,?,?,?, ?,?,?,?)
    `).run(
      tatoueur_id   || null,
      tatoueur_nom,
      booking_style  || '',
      booking_zone   || '',
      booking_taille || '',
      booking_date   || '',
      booking_desc   || '',
      guest_prenom   || '',
      guest_nom      || '',
      guest_email    || '',
      guest_telephone|| '',
    );

    const convId = result.lastInsertRowid;

    // Premier message automatique de l'artiste
    const replyText = auto_reply ||
      `Bonjour ! J'ai bien reçu ta demande 🎨 Je reviendrai vers toi dans les 48h pour qu'on discute de ton projet. Tu peux m'envoyer d'autres références ici si tu en as.\n\nÀ très vite ! ✌️`;
    db.prepare(
      'INSERT INTO client_messages (conversation_id, sender, content) VALUES (?,?,?)'
    ).run(convId, 'artist', replyText);

    res.json({ ok: true, id: convId });
  } catch (e) {
    console.error('[client/guest-booking POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/client/guest-conversations/:id/messages ── Message invité ─────────
// Permet d'envoyer un message dans une conversation invité sans être connecté.
// Sécurité minimale : le conv_id doit appartenir à un booking invité (client_id=0).
router.post('/guest-conversations/:id/messages', (req, res) => {
  try {
    const convId = parseInt(req.params.id);
    const conv = db.prepare(
      'SELECT id FROM client_conversations WHERE id=? AND client_id=0'
    ).get(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });

    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message vide' });

    const result = db.prepare(
      'INSERT INTO client_messages (conversation_id, sender, content) VALUES (?,\'client\',?)'
    ).run(convId, content.trim());

    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    console.error('[client/guest-conversations/:id/messages POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/client/conversations ── Lister les conversations du client ───────
router.get('/conversations', requireClientAuth, (req, res) => {
  try {
    const convs = db.prepare(`
      SELECT cc.*,
             (SELECT content FROM client_messages
              WHERE conversation_id=cc.id ORDER BY created_at DESC LIMIT 1) as last_message,
             (SELECT COUNT(*) FROM client_messages WHERE conversation_id=cc.id) as msg_count
      FROM client_conversations cc
      WHERE cc.client_id = ?
      ORDER BY cc.created_at DESC
    `).all(req.clientId);
    res.json(convs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/client/conversations/:id ── Détail d'une conversation + messages ─
router.get('/conversations/:id', requireClientAuth, (req, res) => {
  try {
    const conv = db.prepare(
      'SELECT * FROM client_conversations WHERE id=? AND client_id=?'
    ).get(parseInt(req.params.id), req.clientId);
    if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });

    const messages = db.prepare(
      'SELECT * FROM client_messages WHERE conversation_id=? ORDER BY created_at ASC'
    ).all(conv.id);

    res.json({ ...conv, messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/client/conversations/:id/messages ── Envoyer un message ─────────
router.post('/conversations/:id/messages', requireClientAuth, (req, res) => {
  try {
    const convId = parseInt(req.params.id);
    // Vérifier que la conversation appartient bien à ce client
    const conv = db.prepare(
      'SELECT id FROM client_conversations WHERE id=? AND client_id=?'
    ).get(convId, req.clientId);
    if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });

    const { content, sender = 'client' } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message vide' });

    const result = db.prepare(
      'INSERT INTO client_messages (conversation_id, sender, content) VALUES (?,?,?)'
    ).run(convId, sender, content.trim());

    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
