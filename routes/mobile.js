/**
 * routes/mobile.js
 *
 * Routes dédiées à l'application mobile inkr Pro (iOS).
 *
 * ─── Pour les développeurs ──────────────────────────────────────────────────
 *  Ces routes sont utilisées exclusivement par l'app native React Native/Expo.
 *  Authentification : Bearer token JWT (pas de cookie httpOnly comme le web).
 *  Le token est extrait du header Authorization: Bearer <jwt>
 *
 *  Toutes les routes sont préfixées /api/auth/mobile (voir server.js).
 *
 *  Routes :
 *    GET  /api/auth/mobile/conversations         → liste des convs du tatoueur
 *    GET  /api/auth/mobile/conversations/:id     → détail conv + messages
 *    POST /api/auth/mobile/conversations/:id/reply → artiste répond
 *    POST /api/auth/mobile/push-token            → enregistre le token push APNs
 * ────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { db }  = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';

// ── Migration : table push_tokens pour les notifications ─────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      token      TEXT    NOT NULL,
      platform   TEXT    DEFAULT 'ios',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, token)
    )
  `);
} catch(_) {}

// ── Migration : colonne unread_artist sur les messages ────────────────────────
try { db.exec(`ALTER TABLE client_messages ADD COLUMN read_by_artist INTEGER DEFAULT 0`); } catch(_) {}

// ── Middleware auth Bearer token ──────────────────────────────────────────────
function requireMobileAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }
  try {
    const token    = auth.slice(7);
    const decoded  = jwt.verify(token, JWT_SECRET);
    req.userId     = decoded.userId;
    req.userEmail  = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

// ── Helper : trouver le tatoueur public lié à l'artiste inkr Pro ─────────────
// Le lien se fait par le handle Instagram (même @handle dans les deux tables).
function getLinkedTatoueurId(userId) {
  const user = db.prepare('SELECT instagram FROM users WHERE id = ?').get(userId);
  if (!user?.instagram) return null;
  const handle = user.instagram.replace('@', '').toLowerCase().trim();
  const tatoueur = db.prepare(
    "SELECT id FROM tatoueurs WHERE LOWER(REPLACE(instagram,'@','')) = ?"
  ).get(handle);
  return tatoueur?.id || null;
}

// ── GET /api/auth/mobile/conversations ───────────────────────────────────────
// Retourne toutes les conversations des clients avec cet artiste.
// Triées par dernier message (plus récent en premier).
router.get('/conversations', requireMobileAuth, (req, res) => {
  try {
    const tatoueurId = getLinkedTatoueurId(req.userId);
    if (!tatoueurId) {
      // Artiste pas encore lié à une fiche tatoueur (pas d'Instagram renseigné)
      return res.json([]);
    }

    const convs = db.prepare(`
      SELECT
        cc.*,
        ca.prenom AS client_prenom,
        ca.name   AS client_name,
        ca.email  AS client_email,
        (SELECT content FROM client_messages
         WHERE conversation_id = cc.id
         ORDER BY created_at DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM client_messages
         WHERE conversation_id = cc.id
         ORDER BY created_at DESC LIMIT 1) AS last_message_at,
        (SELECT COUNT(*) FROM client_messages
         WHERE conversation_id = cc.id
           AND sender = 'client'
           AND read_by_artist = 0) AS unread_count
      FROM client_conversations cc
      LEFT JOIN client_accounts ca ON ca.id = cc.client_id
      WHERE cc.tatoueur_id = ?
      ORDER BY last_message_at DESC
    `).all(tatoueurId);

    res.json(convs);
  } catch (e) {
    console.error('[mobile/conversations]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/auth/mobile/conversations/:id ────────────────────────────────────
// Détail d'une conversation + tous ses messages.
// Marque les messages clients comme lus.
router.get('/conversations/:id', requireMobileAuth, (req, res) => {
  try {
    const convId     = parseInt(req.params.id);
    const tatoueurId = getLinkedTatoueurId(req.userId);

    // Vérification : la conv appartient bien à cet artiste
    const conv = db.prepare(
      'SELECT * FROM client_conversations WHERE id = ? AND tatoueur_id = ?'
    ).get(convId, tatoueurId);

    if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });

    // Marquer les messages clients comme lus
    db.prepare(
      "UPDATE client_messages SET read_by_artist = 1 WHERE conversation_id = ? AND sender = 'client'"
    ).run(convId);

    const messages = db.prepare(
      'SELECT * FROM client_messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(convId);

    res.json({ conversation: conv, messages });
  } catch (e) {
    console.error('[mobile/conversations/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/auth/mobile/conversations/:id/reply ─────────────────────────────
// L'artiste envoie un message dans une conversation.
router.post('/conversations/:id/reply', requireMobileAuth, (req, res) => {
  try {
    const convId     = parseInt(req.params.id);
    const tatoueurId = getLinkedTatoueurId(req.userId);
    const { content } = req.body;

    if (!content?.trim()) return res.status(400).json({ error: 'Message vide' });

    // Vérification appartenance
    const conv = db.prepare(
      'SELECT id FROM client_conversations WHERE id = ? AND tatoueur_id = ?'
    ).get(convId, tatoueurId);
    if (!conv) return res.status(403).json({ error: 'Accès refusé' });

    // Insérer le message
    const result = db.prepare(
      "INSERT INTO client_messages (conversation_id, sender, content) VALUES (?, 'artist', ?)"
    ).run(convId, content.trim());

    // TODO : envoyer une notification push au client (à implémenter avec APNs)

    res.json({ ok: true, message_id: result.lastInsertRowid });
  } catch (e) {
    console.error('[mobile/reply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/auth/mobile/push-token ─────────────────────────────────────────
// Enregistre le token push Expo/APNs de l'appareil.
// Appelé au démarrage de l'app après que l'utilisateur a accordé la permission.
router.post('/push-token', requireMobileAuth, (req, res) => {
  try {
    const { token, platform = 'ios' } = req.body;
    if (!token) return res.status(400).json({ error: 'Token requis' });

    db.prepare(`
      INSERT INTO push_tokens (user_id, token, platform)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, token) DO UPDATE SET platform = excluded.platform
    `).run(req.userId, token, platform);

    res.json({ ok: true });
  } catch (e) {
    console.error('[mobile/push-token]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
