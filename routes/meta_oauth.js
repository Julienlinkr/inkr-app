/**
 * routes/meta_oauth.js
 *
 * Connexion Meta (Facebook / Instagram / WhatsApp) par OAuth pour les artistes.
 *
 * ─── Flow complet (3 clics artiste) ──────────────────────────────────────────
 *  1. Artiste clique "Connecter Meta" dans le dashboard
 *  2. GET /api/meta/oauth → redirect vers Facebook Login
 *  3. Artiste autorise → Facebook redirige vers /api/meta/callback
 *  4. On échange le code contre un token, on récupère la Page + compte IG
 *  5. On stocke en DB (users.meta_*) + on souscrit au webhook
 *  6. Redirect /dashboard?meta_connected=1 → toast "Connecté !"
 *
 * ─── Variables Railway requises ──────────────────────────────────────────────
 *  META_APP_ID       → App ID  (Meta Developers → Mon app → Paramètres basiques)
 *  META_APP_SECRET   → App Secret (même endroit)
 *  META_VERIFY_TOKEN → Déjà utilisé par webhooks.js — même valeur
 *  BASE_URL          → https://inkr.club (pour le redirect_uri)
 *
 * ─── Routes ──────────────────────────────────────────────────────────────────
 *  GET  /api/meta/oauth       → démarre le flow OAuth (artiste connecté requis)
 *  GET  /api/meta/callback    → callback OAuth de Facebook
 *  GET  /api/meta/status      → état de la connexion de l'artiste
 *  GET  /api/meta/messages    → messages reçus (WhatsApp + Instagram + Messenger)
 *  POST /api/meta/reply       → envoyer une réponse
 *  POST /api/meta/read/:id    → marquer un message comme lu
 *  DELETE /api/meta/disconnect → déconnecter
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { db }  = require('../db/database');

const {
  META_APP_ID     = '',
  META_APP_SECRET = '',
  BASE_URL        = 'https://inkr.club',
  JWT_SECRET      = 'inkr_secret_dev',
} = process.env;

// ── Migrations colonnes meta sur users ────────────────────────────────────────
[
  'ALTER TABLE users ADD COLUMN meta_page_id          TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN meta_page_name        TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN meta_page_token       TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN meta_ig_username      TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN meta_connected_at     DATETIME DEFAULT NULL',
  'ALTER TABLE messages       ADD COLUMN sender_id    TEXT DEFAULT NULL',
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// ── Middleware auth artiste ───────────────────────────────────────────────────
function requireArtistAuth(req, res, next) {
  try {
    const token = req.cookies?.inkr_token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non connecté' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}

// ─── GET /api/meta/oauth ─────────────────────────────────────────────────────
// Redirige l'artiste vers Facebook Login pour autoriser l'accès.
router.get('/oauth', requireArtistAuth, (req, res) => {
  if (!META_APP_ID) {
    return res.status(503).send(
      '<p style="font-family:sans-serif;padding:40px;">⚠️ META_APP_ID non configuré dans Railway.<br>' +
      'Ajoutez les variables META_APP_ID et META_APP_SECRET dans vos variables d\'environnement.</p>'
    );
  }

  // Encode l'userId dans le state pour le retrouver au callback
  const state = Buffer.from(JSON.stringify({ userId: req.userId, ts: Date.now() })).toString('base64url');

  const scopes = [
    'pages_manage_metadata',
    'pages_messaging',
    'instagram_manage_messages',
    'instagram_basic',
    'pages_read_engagement',
    'business_management',
  ].join(',');

  const redirectUri = `${BASE_URL}/api/meta/callback`;

  const url =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&state=${state}` +
    `&response_type=code`;

  res.redirect(url);
});

// ─── GET /api/meta/callback ──────────────────────────────────────────────────
// Facebook redirige ici après autorisation de l'artiste.
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    const msg = encodeURIComponent(error_description || error || 'Connexion Meta annulée');
    return res.redirect(`/dashboard?meta_error=${msg}`);
  }

  if (!code || !state) {
    return res.redirect('/dashboard?meta_error=Paramètres+OAuth+manquants');
  }

  let userId;
  try {
    ({ userId } = JSON.parse(Buffer.from(state, 'base64url').toString()));
  } catch {
    return res.redirect('/dashboard?meta_error=State+invalide');
  }

  try {
    const redirectUri = `${BASE_URL}/api/meta/callback`;

    // ── 1. Échange du code contre un token court ──────────────────────────
    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token` +
      `?client_id=${META_APP_ID}` +
      `&client_secret=${META_APP_SECRET}` +
      `&code=${code}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`
    );
    const tokenData = await tokenRes.json();
    if (tokenData.error || !tokenData.access_token) {
      throw new Error(tokenData.error?.message || 'Échange de token échoué');
    }

    // ── 2. Extension en token long (60 jours) ─────────────────────────────
    const llRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${META_APP_ID}` +
      `&client_secret=${META_APP_SECRET}` +
      `&fb_exchange_token=${tokenData.access_token}`
    );
    const llData = await llRes.json();
    const userLongToken = llData.access_token || tokenData.access_token;

    // ── 3. Récupération des Pages Facebook avec compte IG lié ─────────────
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts` +
      `?access_token=${userLongToken}` +
      `&fields=id,name,access_token,instagram_business_account`
    );
    const pagesData = await pagesRes.json();
    const pages = pagesData.data || [];

    if (pages.length === 0) {
      return res.redirect('/dashboard?meta_error=Aucune+Page+Facebook+trouvée.+Créez+une+Page+pro+liée+à+votre+compte+Instagram.');
    }

    // ── 4. Sélection de la meilleure page ─────────────────────────────────
    // Priorité : page avec compte Instagram lié
    const page = pages.find(p => p.instagram_business_account) || pages[0];
    const pageId    = page.id;
    const pageName  = page.name;
    const pageToken = page.access_token; // token de page (permanent tant que l'admin garde l'accès)

    // ── 5. Récupération du compte Instagram Business ───────────────────────
    let igPageId  = null;
    let igUsername = '';
    if (page.instagram_business_account?.id) {
      igPageId = page.instagram_business_account.id;
      try {
        const igRes = await fetch(
          `https://graph.facebook.com/v21.0/${igPageId}` +
          `?fields=username&access_token=${pageToken}`
        );
        const igData = await igRes.json();
        igUsername = igData.username || '';
      } catch (_) {}
    }

    // ── 6. Sauvegarde en base (users table) ───────────────────────────────
    db.prepare(`
      UPDATE users SET
        meta_page_id       = ?,
        meta_page_name     = ?,
        meta_page_token    = ?,
        meta_ig_page_id    = ?,
        meta_ig_username   = ?,
        meta_connected_at  = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(pageId, pageName, pageToken, igPageId, igUsername, userId);

    // ── 7. Souscription de la Page au webhook Meta ────────────────────────
    // Sans ça, les messages ne seront pas envoyés à notre webhook.
    try {
      await fetch(
        `https://graph.facebook.com/v21.0/${pageId}/subscribed_apps` +
        `?subscribed_fields=messages,messaging_postbacks` +
        `&access_token=${pageToken}`,
        { method: 'POST' }
      );
    } catch (subErr) {
      console.warn('[meta/callback] Souscription webhook échouée (non bloquant):', subErr.message);
    }

    console.log(`[meta/callback] Artiste ${userId} connecté — Page: "${pageName}" (${pageId}), IG: @${igUsername || 'non lié'}`);
    res.redirect('/dashboard?meta_connected=1');

  } catch (e) {
    console.error('[meta/callback] Erreur:', e.message);
    res.redirect(`/dashboard?meta_error=${encodeURIComponent(e.message)}`);
  }
});

// ─── GET /api/meta/status ────────────────────────────────────────────────────
// Retourne l'état de la connexion Meta de l'artiste connecté.
router.get('/status', requireArtistAuth, (req, res) => {
  try {
    const u = db.prepare(
      'SELECT meta_page_id, meta_page_name, meta_ig_page_id, meta_ig_username, meta_connected_at FROM users WHERE id=?'
    ).get(req.userId);

    if (!u?.meta_page_id) return res.json({ connected: false });

    const channels = ['facebook'];
    if (u.meta_ig_page_id) channels.push('instagram');
    // WhatsApp : connecté si meta_wa_phone_id est renseigné
    const waPhoneId = db.prepare('SELECT meta_wa_phone_id FROM users WHERE id=?').get(req.userId)?.meta_wa_phone_id;
    if (waPhoneId) channels.push('whatsapp');

    res.json({
      connected:    true,
      page_name:    u.meta_page_name,
      ig_username:  u.meta_ig_username,
      channels,
      connected_at: u.meta_connected_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/meta/messages ──────────────────────────────────────────────────
// Liste les messages reçus via Meta (WhatsApp, Instagram, Messenger).
// Groupés par expéditeur (sender_id / phone) pour la vue "conversations".
router.get('/messages', requireArtistAuth, (req, res) => {
  try {
    const { channel, limit = 60, offset = 0 } = req.query;
    let sql = 'SELECT * FROM messages WHERE user_id=? AND direction=\'in\'';
    const params = [req.userId];

    if (channel && channel !== 'all') {
      // Accepte "instagram", "whatsapp", "facebook"
      sql += ' AND channel=?';
      params.push(channel);
    } else {
      // Tous les canaux Meta (exclure email)
      sql += ' AND channel IN (\'instagram\',\'whatsapp\',\'facebook\')';
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const msgs = db.prepare(sql).all(...params);

    const unread = db.prepare(
      'SELECT COUNT(*) as cnt FROM messages WHERE user_id=? AND direction=\'in\' AND is_read=0 AND channel IN (\'instagram\',\'whatsapp\',\'facebook\')'
    ).get(req.userId)?.cnt || 0;

    res.json({ messages: msgs, unread });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/meta/read/:id ─────────────────────────────────────────────────
// Marque un message comme lu.
router.post('/read/:id', requireArtistAuth, (req, res) => {
  try {
    db.prepare('UPDATE messages SET is_read=1 WHERE id=? AND user_id=?')
      .run(parseInt(req.params.id), req.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/meta/reply ────────────────────────────────────────────────────
// Envoie une réponse via l'API Meta (Messenger ou Instagram DM).
// Pour WhatsApp, délègue à webhooks.js::sendWhatsAppMessage.
router.post('/reply', requireArtistAuth, async (req, res) => {
  const { channel, recipient_id, phone, message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message vide' });

  try {
    const u = db.prepare(
      'SELECT meta_page_id, meta_page_token, meta_ig_page_id FROM users WHERE id=?'
    ).get(req.userId);

    let sent = false;

    // ── Instagram DM ────────────────────────────────────────────────────────
    if (channel === 'instagram' && u?.meta_ig_page_id && recipient_id) {
      const r = await fetch(
        `https://graph.facebook.com/v21.0/${u.meta_ig_page_id}/messages` +
        `?access_token=${u.meta_page_token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient: { id: recipient_id }, message: { text: message.trim() } }),
        }
      );
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      sent = true;
    }

    // ── Facebook Messenger ───────────────────────────────────────────────────
    if (channel === 'facebook' && u?.meta_page_id && recipient_id) {
      const r = await fetch(
        `https://graph.facebook.com/v21.0/${u.meta_page_id}/messages` +
        `?access_token=${u.meta_page_token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: recipient_id },
            message: { text: message.trim() },
            messaging_type: 'RESPONSE',
          }),
        }
      );
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      sent = true;
    }

    // ── WhatsApp ─────────────────────────────────────────────────────────────
    if (channel === 'whatsapp' && phone) {
      const { sendWhatsAppMessage } = require('./webhooks');
      const to = phone.replace(/[^0-9]/g, '').replace(/^33/, '33');
      await sendWhatsAppMessage(to, message.trim());
      sent = true;
    }

    if (!sent) {
      return res.status(400).json({ error: 'Canal non supporté ou Meta non connecté' });
    }

    // Sauvegarder le message sortant en base
    db.prepare(
      'INSERT INTO messages (user_id, client_name, channel, direction, content, sender_id, phone) VALUES (?,?,?,\'out\',?,?,?)'
    ).run(req.userId, req.body.client_name || 'Client', channel, message.trim(), recipient_id || null, phone || null);

    res.json({ ok: true });
  } catch (e) {
    console.error('[meta/reply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/meta/disconnect ─────────────────────────────────────────────
// Révoque les tokens Meta stockés pour cet artiste.
router.delete('/disconnect', requireArtistAuth, (req, res) => {
  try {
    db.prepare(`
      UPDATE users SET
        meta_page_id      = NULL,
        meta_page_name    = NULL,
        meta_page_token   = NULL,
        meta_ig_page_id   = NULL,
        meta_ig_username  = NULL,
        meta_connected_at = NULL
      WHERE id = ?
    `).run(req.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
