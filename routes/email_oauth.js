/**
 * routes/email_oauth.js
 *
 * Connexion boîte mail via OAuth2 pour les artistes inkr.
 * L'artiste clique "Connecter Gmail" → s'identifie sur Google → connecté.
 * Aucun mot de passe d'application requis.
 *
 * ─── Fournisseurs supportés ───────────────────────────────────────────────
 *  Gmail   → Google OAuth2 + Gmail API
 *  Outlook → Microsoft OAuth2 + Microsoft Graph API
 *  (Yahoo / iCloud → IMAP + app password, dans email_imap.js)
 *
 * ─── Variables Railway requises ──────────────────────────────────────────
 *  GOOGLE_CLIENT_ID      → Google Cloud Console → APIs & Services → Identifiants
 *  GOOGLE_CLIENT_SECRET  → (même endroit)
 *  MICROSOFT_CLIENT_ID   → Azure Portal → App registrations (optionnel)
 *  MICROSOFT_CLIENT_SECRET → (même endroit, optionnel)
 *
 * ─── Routes ───────────────────────────────────────────────────────────────
 *  GET  /api/email/auth/google       → lance le flow OAuth Google
 *  GET  /api/email/callback/google   → reçoit le code Google
 *  GET  /api/email/auth/microsoft    → lance le flow OAuth Microsoft
 *  GET  /api/email/callback/microsoft → reçoit le code Microsoft
 *  GET  /api/email/status            → état de la connexion
 *  DELETE /api/email/disconnect      → déconnecter
 *  GET  /api/email/messages          → emails stockés en base
 *  POST /api/email/reply             → envoyer un email
 *  POST /api/email/sync              → sync manuelle
 * ──────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { db }  = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';
const BASE_URL   = process.env.APP_URL || process.env.BASE_URL || 'https://www.inkr.club';

// ── DB migrations ──────────────────────────────────────────────────────────────
[
  'ALTER TABLE users ADD COLUMN email_provider      TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN email_access_token  TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN email_refresh_token TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN email_token_expiry  DATETIME DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN imap_user           TEXT DEFAULT NULL',  // adresse email connectée
  'ALTER TABLE users ADD COLUMN imap_last_sync      DATETIME DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN subject          TEXT DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN email_to         TEXT DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN email_thread_id  TEXT DEFAULT NULL',
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// ── Middleware auth ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.inkr_token
    || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).userId;
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE OAUTH2 + GMAIL API
// ══════════════════════════════════════════════════════════════════════════════

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// ── GET /auth/google ──────────────────────────────────────────────────────────
// Redirige l'artiste vers Google pour autoriser l'accès à Gmail.
router.get('/auth/google', requireAuth, (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.redirect(`${BASE_URL}/dashboard?email_error=GOOGLE_CLIENT_ID+manquant+—+ajoutez-le+dans+Railway`);
  }

  const state = Buffer.from(JSON.stringify({ userId: req.userId, provider: 'google', ts: Date.now() }))
    .toString('base64url');

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  `${BASE_URL}/api/email/callback/google`,
    response_type: 'code',
    scope:         GOOGLE_SCOPES,
    access_type:   'offline',   // pour avoir le refresh_token
    prompt:        'consent',   // force l'affichage du consentement pour le refresh_token
    state,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ── GET /callback/google ──────────────────────────────────────────────────────
// Google redirige ici après que l'artiste a autorisé l'accès.
router.get('/callback/google', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${BASE_URL}/dashboard?email_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return res.redirect(`${BASE_URL}/dashboard?email_error=Paramètres+manquants`);
  }

  let userId;
  try {
    ({ userId } = JSON.parse(Buffer.from(state, 'base64url').toString()));
  } catch {
    return res.redirect(`${BASE_URL}/dashboard?email_error=State+invalide`);
  }

  try {
    // 1. Échange du code contre les tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${BASE_URL}/api/email/callback/google`,
        grant_type:    'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    // 2. Récupération de l'adresse email
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();
    const email = profile.email;
    if (!email) throw new Error('Email non récupéré depuis Google');

    // 3. Calcul de l'expiration
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

    // 4. Sauvegarde en base
    db.prepare(`
      UPDATE users SET
        email_provider      = 'google',
        imap_user           = ?,
        email_access_token  = ?,
        email_refresh_token = ?,
        email_token_expiry  = ?
      WHERE id = ?
    `).run(email, tokens.access_token, tokens.refresh_token || null, expiresAt, userId);

    console.log(`[Gmail OAuth] ✅ Artiste #${userId} → ${email}`);

    // 5. Sync initiale en arrière-plan
    syncGmailForUser(userId).catch(e => console.error('[Gmail sync init]', e.message));

    res.redirect(`${BASE_URL}/dashboard?email_connected=1`);
  } catch (e) {
    console.error('[Gmail callback]', e.message);
    res.redirect(`${BASE_URL}/dashboard?email_error=${encodeURIComponent(e.message)}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MICROSOFT OAUTH2 + GRAPH API (Outlook, Hotmail, Live)
// ══════════════════════════════════════════════════════════════════════════════

const MS_SCOPES = 'openid email profile Mail.Read Mail.Send offline_access';

// ── GET /auth/microsoft ───────────────────────────────────────────────────────
router.get('/auth/microsoft', requireAuth, (req, res) => {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    return res.redirect(`${BASE_URL}/dashboard?email_error=MICROSOFT_CLIENT_ID+manquant+—+ajoutez-le+dans+Railway`);
  }

  const state = Buffer.from(JSON.stringify({ userId: req.userId, provider: 'microsoft', ts: Date.now() }))
    .toString('base64url');

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  `${BASE_URL}/api/email/callback/microsoft`,
    response_type: 'code',
    scope:         MS_SCOPES,
    state,
    response_mode: 'query',
  });

  res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`);
});

// ── GET /callback/microsoft ───────────────────────────────────────────────────
router.get('/callback/microsoft', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.redirect(`${BASE_URL}/dashboard?email_error=${encodeURIComponent(error_description || error)}`);
  }
  if (!code || !state) {
    return res.redirect(`${BASE_URL}/dashboard?email_error=Paramètres+manquants`);
  }

  let userId;
  try {
    ({ userId } = JSON.parse(Buffer.from(state, 'base64url').toString()));
  } catch {
    return res.redirect(`${BASE_URL}/dashboard?email_error=State+invalide`);
  }

  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        redirect_uri:  `${BASE_URL}/api/email/callback/microsoft`,
        grant_type:    'authorization_code',
        scope:         MS_SCOPES,
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    // Récupérer l'email via /me
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const me = await meRes.json();
    const email = me.mail || me.userPrincipalName || me.id;

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

    db.prepare(`
      UPDATE users SET
        email_provider      = 'microsoft',
        imap_user           = ?,
        email_access_token  = ?,
        email_refresh_token = ?,
        email_token_expiry  = ?
      WHERE id = ?
    `).run(email, tokens.access_token, tokens.refresh_token || null, expiresAt, userId);

    console.log(`[Outlook OAuth] ✅ Artiste #${userId} → ${email}`);
    syncOutlookForUser(userId).catch(e => console.error('[Outlook sync init]', e.message));

    res.redirect(`${BASE_URL}/dashboard?email_connected=1`);
  } catch (e) {
    console.error('[Outlook callback]', e.message);
    res.redirect(`${BASE_URL}/dashboard?email_error=${encodeURIComponent(e.message)}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES COMMUNES
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /status ────────────────────────────────────────────────────────────────
router.get('/status', requireAuth, (req, res) => {
  try {
    const u = db.prepare(
      'SELECT email_provider, imap_user, imap_last_sync FROM users WHERE id=?'
    ).get(req.userId);
    res.json({
      connected: !!u?.imap_user,
      email:     u?.imap_user    || null,
      provider:  u?.email_provider || null,
      last_sync: u?.imap_last_sync  || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /disconnect ─────────────────────────────────────────────────────────
router.delete('/disconnect', requireAuth, (req, res) => {
  try {
    db.prepare(`
      UPDATE users SET
        email_provider=NULL, imap_user=NULL,
        email_access_token=NULL, email_refresh_token=NULL,
        email_token_expiry=NULL, imap_last_sync=NULL
      WHERE id=?
    `).run(req.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /messages ──────────────────────────────────────────────────────────────
router.get('/messages', requireAuth, (req, res) => {
  try {
    const { limit = 60, offset = 0 } = req.query;
    const msgs = db.prepare(`
      SELECT * FROM messages
      WHERE user_id=? AND channel='email'
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.userId, parseInt(limit), parseInt(offset));
    const unread = db.prepare(`
      SELECT COUNT(*) as cnt FROM messages
      WHERE user_id=? AND channel='email' AND direction='in' AND is_read=0
    `).get(req.userId)?.cnt || 0;
    res.json({ messages: msgs, unread });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /read/:id ─────────────────────────────────────────────────────────────
router.post('/read/:id', requireAuth, (req, res) => {
  try {
    db.prepare('UPDATE messages SET is_read=1 WHERE id=? AND user_id=?')
      .run(parseInt(req.params.id), req.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /reply ────────────────────────────────────────────────────────────────
// Envoie un email depuis la boîte connectée de l'artiste.
// Body: { to, subject, body, in_reply_to? }
router.post('/reply', requireAuth, async (req, res) => {
  const { to, subject, body, in_reply_to } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'Destinataire et corps requis' });

  try {
    const u = db.prepare(
      'SELECT email_provider, imap_user, email_access_token, email_refresh_token, email_token_expiry FROM users WHERE id=?'
    ).get(req.userId);

    if (!u?.imap_user) return res.status(400).json({ error: 'Email non connecté' });

    // Rafraîchir le token si nécessaire
    const token = await ensureFreshToken(req.userId, u);

    if (u.email_provider === 'google') {
      await sendGmail(token, u.imap_user, to, subject, body, in_reply_to);
    } else if (u.email_provider === 'microsoft') {
      await sendOutlookMail(token, to, subject, body);
    } else {
      throw new Error('Fournisseur non supporté pour l\'envoi');
    }

    // Sauvegarder en base
    db.prepare(`
      INSERT INTO messages (user_id, client_name, channel, direction, content, subject, sender_id, email_to, is_read)
      VALUES (?,?,?,?,?,?,?,?,1)
    `).run(req.userId, to, 'email', 'out', body, subject || '', u.imap_user, to);

    res.json({ ok: true });
  } catch (e) {
    console.error('[Email reply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /sync ─────────────────────────────────────────────────────────────────
router.post('/sync', requireAuth, async (req, res) => {
  const u = db.prepare('SELECT email_provider, imap_user FROM users WHERE id=?').get(req.userId);
  if (!u?.imap_user) return res.status(400).json({ error: 'Email non connecté' });
  try {
    const count = await syncEmailForUser(req.userId);
    res.json({ ok: true, new_messages: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// TOKEN REFRESH
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Vérifie si le token est expiré et le rafraîchit si nécessaire.
 * Retourne un access_token valide.
 */
async function ensureFreshToken(userId, u) {
  // Si expiration dans plus de 5 minutes → token encore valide
  if (u.email_token_expiry) {
    const expiresAt = new Date(u.email_token_expiry).getTime();
    if (Date.now() < expiresAt - 5 * 60 * 1000) {
      return u.email_access_token;
    }
  }

  if (!u.email_refresh_token) {
    throw new Error('Token expiré et pas de refresh_token — l\'artiste doit reconnecter son email');
  }

  // Rafraîchir le token
  let tokenUrl, params;
  if (u.email_provider === 'google') {
    tokenUrl = 'https://oauth2.googleapis.com/token';
    params = {
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: u.email_refresh_token,
      grant_type:    'refresh_token',
    };
  } else if (u.email_provider === 'microsoft') {
    tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    params = {
      client_id:     process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: u.email_refresh_token,
      grant_type:    'refresh_token',
      scope:         MS_SCOPES,
    };
  } else {
    throw new Error('Fournisseur inconnu pour le refresh');
  }

  const res = await fetch(tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams(params),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);

  const newToken    = data.access_token;
  const expiresAt   = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  const newRefresh  = data.refresh_token || u.email_refresh_token;

  db.prepare('UPDATE users SET email_access_token=?, email_token_expiry=?, email_refresh_token=? WHERE id=?')
    .run(newToken, expiresAt, newRefresh, userId);

  console.log(`[Token refresh] ✅ User #${userId} (${u.email_provider})`);
  return newToken;
}

// ══════════════════════════════════════════════════════════════════════════════
// SYNC GMAIL
// ══════════════════════════════════════════════════════════════════════════════

async function syncGmailForUser(userId) {
  const u = db.prepare(
    'SELECT imap_user, email_access_token, email_refresh_token, email_token_expiry, email_provider FROM users WHERE id=?'
  ).get(userId);
  if (!u?.imap_user) return 0;

  const token = await ensureFreshToken(userId, u);
  let newCount = 0;

  // 1. Lister les 50 derniers messages INBOX
  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=50',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const listData = await listRes.json();
  if (listData.error) throw new Error(listData.error.message);

  const messages = listData.messages || [];

  // 2. Pour chaque message, récupérer les détails (en parallèle, max 10 à la fois)
  const BATCH = 10;
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ id }) => {
      try {
        const externalId = `gmail_${id}`;
        const exists = db.prepare('SELECT id FROM messages WHERE external_id=?').get(externalId);
        if (exists) return;

        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const msg = await msgRes.json();
        if (msg.error) return;

        // Extraire headers
        const headers = msg.payload?.headers || [];
        const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        const from    = getHeader('From');
        const subject = getHeader('Subject') || '(sans objet)';
        const dateStr = getHeader('Date');

        // Extraire l'adresse email et le nom de l'expéditeur
        const fromMatch = from.match(/^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/);
        const senderName = fromMatch?.[1]?.trim() || fromMatch?.[2] || from;
        const senderAddr = fromMatch?.[2]?.trim() || from;

        // Extraire le corps texte
        const textBody = extractGmailText(msg.payload).slice(0, 3000) || msg.snippet || '';

        // Ignorer les emails envoyés par l'artiste lui-même
        if (senderAddr.toLowerCase() === u.imap_user.toLowerCase()) return;

        const createdAt = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

        db.prepare(`
          INSERT INTO messages
            (user_id, client_name, channel, direction, content, subject, external_id, sender_id, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(userId, senderName.slice(0, 200), 'email', 'in', textBody, subject.slice(0, 500), externalId, senderAddr, createdAt);

        newCount++;
      } catch (msgErr) {
        console.warn(`[Gmail] Erreur message ${id}:`, msgErr.message);
      }
    }));
  }

  db.prepare('UPDATE users SET imap_last_sync=CURRENT_TIMESTAMP WHERE id=?').run(userId);
  if (newCount > 0) console.log(`[Gmail sync] ✅ User #${userId} (${u.imap_user}) → +${newCount} emails`);
  return newCount;
}

/** Extrait le corps texte d'un message Gmail (format full). */
function extractGmailText(payload) {
  if (!payload) return '';

  // Corps direct text/plain
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Corps direct text/html (converti en texte)
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
      .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  // Multipart : chercher text/plain d'abord, puis text/html
  if (payload.parts?.length) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8')
          .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
      }
      // Multipart imbriqué
      if (part.parts) {
        const nested = extractGmailText(part);
        if (nested) return nested;
      }
    }
  }

  return payload.snippet || '';
}

/** Envoie un email via Gmail API. */
async function sendGmail(token, fromEmail, to, subject, body, inReplyTo) {
  const lines = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    `Subject: ${subject || 'Re: (sans objet)'}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`, `References: <${inReplyTo}>`] : []),
    '',
    body,
  ];
  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ raw }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Erreur envoi Gmail');
  return data;
}

// ══════════════════════════════════════════════════════════════════════════════
// SYNC OUTLOOK / MICROSOFT GRAPH
// ══════════════════════════════════════════════════════════════════════════════

async function syncOutlookForUser(userId) {
  const u = db.prepare(
    'SELECT imap_user, email_access_token, email_refresh_token, email_token_expiry, email_provider FROM users WHERE id=?'
  ).get(userId);
  if (!u?.imap_user) return 0;

  const token = await ensureFreshToken(userId, u);
  let newCount = 0;

  const listRes = await fetch(
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime+desc&$select=id,subject,from,receivedDateTime,body,bodyPreview',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const listData = await listRes.json();
  if (listData.error) throw new Error(listData.error.message);

  const messages = listData.value || [];

  for (const msg of messages) {
    try {
      const externalId = `outlook_${msg.id}`;
      const exists = db.prepare('SELECT id FROM messages WHERE external_id=?').get(externalId);
      if (exists) continue;

      const senderName = msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Inconnu';
      const senderAddr = msg.from?.emailAddress?.address || null;
      if (senderAddr?.toLowerCase() === u.imap_user.toLowerCase()) continue;

      const subject  = msg.subject || '(sans objet)';
      const textBody = (msg.body?.contentType === 'text'
        ? msg.body.content
        : (msg.body?.content || '').replace(/<[^>]+>/g, ' ')
      ).slice(0, 3000) || msg.bodyPreview || '';

      const createdAt = msg.receivedDateTime || new Date().toISOString();

      db.prepare(`
        INSERT INTO messages
          (user_id, client_name, channel, direction, content, subject, external_id, sender_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(userId, senderName.slice(0, 200), 'email', 'in', textBody, subject.slice(0, 500), externalId, senderAddr, createdAt);

      newCount++;
    } catch (msgErr) {
      console.warn('[Outlook] Erreur message:', msgErr.message);
    }
  }

  db.prepare('UPDATE users SET imap_last_sync=CURRENT_TIMESTAMP WHERE id=?').run(userId);
  if (newCount > 0) console.log(`[Outlook sync] ✅ User #${userId} (${u.imap_user}) → +${newCount} emails`);
  return newCount;
}

/** Envoie un email via Microsoft Graph API. */
async function sendOutlookMail(token, to, subject, body) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: subject || 'Re: (sans objet)',
        body:    { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Erreur Microsoft Graph ${res.status}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SYNC UNIVERSELLE + POLLING
// ══════════════════════════════════════════════════════════════════════════════

async function syncEmailForUser(userId) {
  const u = db.prepare('SELECT email_provider FROM users WHERE id=?').get(userId);
  if (!u) return 0;
  if (u.email_provider === 'google')    return syncGmailForUser(userId);
  if (u.email_provider === 'microsoft') return syncOutlookForUser(userId);
  return 0;
}

/**
 * Lance la boucle de sync automatique toutes les 5 minutes.
 * À appeler depuis server.js après le démarrage.
 */
function startEmailPolling() {
  // Sync initiale 20 secondes après le démarrage
  setTimeout(async () => {
    const users = db.prepare("SELECT id, imap_user FROM users WHERE imap_user IS NOT NULL AND email_provider IS NOT NULL").all();
    if (!users.length) return;
    console.log(`[Email polling] Sync initiale pour ${users.length} artiste(s)…`);
    for (const u of users) {
      syncEmailForUser(u.id).catch(e => console.error(`[Email polling] Init #${u.id}:`, e.message));
    }
  }, 20000);

  // Toutes les 5 minutes
  setInterval(() => {
    const users = db.prepare("SELECT id FROM users WHERE imap_user IS NOT NULL AND email_provider IS NOT NULL").all();
    for (const u of users) {
      syncEmailForUser(u.id).catch(e => console.error(`[Email polling] #${u.id}:`, e.message));
    }
  }, 5 * 60 * 1000);

  console.log('[Email polling] ✅ Démarré — sync toutes les 5 min');
}

module.exports = router;
module.exports.startEmailPolling = startEmailPolling;
module.exports.syncEmailForUser  = syncEmailForUser;
