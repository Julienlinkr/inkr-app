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

// ═══════════════════════════════════════════════════════════════════════════════
// CAMPAGNES MARKETING — accès Bearer token (mobile)
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/auth/mobile/campaigns ───────────────────────────────────────────
// Liste des campagnes de l'artiste connecté.
router.get('/campaigns', requireMobileAuth, (req, res) => {
  try {
    const campaigns = db.prepare(
      'SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC'
    ).all(req.userId);
    res.json(campaigns);
  } catch (e) {
    console.error('[mobile/campaigns GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/auth/mobile/campaigns ──────────────────────────────────────────
// Créer une nouvelle campagne (statut draft).
router.post('/campaigns', requireMobileAuth, (req, res) => {
  try {
    const { name, message, channels, audience } = req.body;
    if (!name?.trim() || !message?.trim()) {
      return res.status(400).json({ error: 'Nom et message requis' });
    }
    const result = db.prepare(
      'INSERT INTO campaigns (user_id, name, message, channels, audience, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      req.userId,
      name.trim(),
      message.trim(),
      JSON.stringify(channels || ['email']),
      audience || 'all',
      'draft'
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    console.error('[mobile/campaigns POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/auth/mobile/campaigns/:id/send ─────────────────────────────────
// Envoyer une campagne existante à tous les clients ciblés.
router.post('/campaigns/:id/send', requireMobileAuth, async (req, res) => {
  try {
    const campaign = db.prepare(
      'SELECT * FROM campaigns WHERE id = ? AND user_id = ?'
    ).get(req.params.id, req.userId);
    if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });

    const channels = JSON.parse(campaign.channels || '[]');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    const appUrl = process.env.APP_URL || 'https://www.inkr.club';

    const allClients = db.prepare('SELECT * FROM clients WHERE user_id = ?').all(req.userId);
    const results = { email: 0, sms: 0, errors: [], audience_count: allClients.length };

    const { sendEmail, sendSMS } = require('./campaigns');

    for (const client of allClients) {
      const prenom = client.prenom || (client.name || '').split(' ')[0];
      const msg = campaign.message
        .replace(/\{\{prénom\}\}/g, prenom)
        .replace(/\{\{nom\}\}/g, client.name || '')
        .replace(/\{\{studio\}\}/g, user.studio_name || 'notre studio')
        .replace(/\{\{lien_résa\}\}/g, appUrl);

      if (channels.includes('email') && client.email) {
        try {
          await sendEmail(client.email, `Message de ${user.studio_name || user.name}`, msg, user, appUrl, campaign.id);
          results.email++;
        } catch (e) { results.errors.push(`Email ${client.email}: ${e.message}`); }
      }
      if (channels.includes('sms') && client.phone) {
        try {
          await sendSMS(client.phone, msg);
          results.sms++;
        } catch (e) { results.errors.push(`SMS ${client.phone}: ${e.message}`); }
      }
    }

    db.prepare(
      'UPDATE campaigns SET status = ?, sent_count = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run('sent', results.email + results.sms, campaign.id);

    res.json({ success: true, results });
  } catch (e) {
    console.error('[mobile/campaigns/:id/send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/auth/mobile/campaigns/:id ────────────────────────────────────
// Supprimer une campagne.
router.delete('/campaigns/:id', requireMobileAuth, (req, res) => {
  try {
    const campaign = db.prepare(
      'SELECT id FROM campaigns WHERE id = ? AND user_id = ?'
    ).get(req.params.id, req.userId);
    if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('[mobile/campaigns DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOMATISATIONS — accès Bearer token (mobile)
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/auth/mobile/automations ─────────────────────────────────────────
// Liste les automatisations de l'artiste.
router.get('/automations', requireMobileAuth, (req, res) => {
  try {
    const automations = db.prepare(
      'SELECT * FROM automations WHERE user_id = ?'
    ).all(req.userId);
    res.json(automations);
  } catch (e) {
    console.error('[mobile/automations GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/auth/mobile/automations/:id ─────────────────────────────────────
// Activer/désactiver ou modifier le message d'une automatisation.
router.put('/automations/:id', requireMobileAuth, (req, res) => {
  try {
    const { enabled, message } = req.body;
    db.prepare(
      'UPDATE automations SET enabled = ?, message = ? WHERE id = ? AND user_id = ?'
    ).run(enabled ? 1 : 0, message || '', req.params.id, req.userId);
    res.json({ success: true });
  } catch (e) {
    console.error('[mobile/automations PUT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/auth/mobile/loyalty ─────────────────────────────────────────────
// Stats fidélité : top clients par points et dépenses.
router.get('/loyalty', requireMobileAuth, (req, res) => {
  try {
    const clients = db.prepare(
      'SELECT name, prenom, loyalty_points, total_spent, rdv_count FROM clients WHERE user_id = ? ORDER BY loyalty_points DESC, total_spent DESC LIMIT 20'
    ).all(req.userId);
    const stats = db.prepare(
      'SELECT SUM(loyalty_points) AS total_points, SUM(total_spent) AS total_revenue, COUNT(*) AS total_clients FROM clients WHERE user_id = ?'
    ).get(req.userId);
    res.json({ clients, stats });
  } catch (e) {
    console.error('[mobile/loyalty]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
