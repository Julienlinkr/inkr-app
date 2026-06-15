/**
 * routes/whatsapp_connect.js
 *
 * WhatsApp Business via Meta Embedded Signup.
 * L'artiste clique "Connecter WhatsApp" → popup Meta (comme connecter Stripe)
 * → 3 clics → connecté. Utilise Meta Cloud API officielle — ToS compliant.
 *
 * ─── Variables Railway requises ───────────────────────────────────────────────
 *  META_APP_ID         → App ID public  (déjà utilisé par meta_oauth.js)
 *  META_APP_SECRET     → App Secret     (déjà utilisé par meta_oauth.js)
 *  META_WA_CONFIG_ID   → Configuration ID de l'Embedded Signup WhatsApp
 *                         Meta Developers → Mon App → WhatsApp → Embedded Signup
 *                         → Create Configuration → copier l'ID
 *
 * ─── Routes ──────────────────────────────────────────────────────────────────
 *  GET    /api/whatsapp/config      → App ID + Config ID pour le SDK frontend
 *  POST   /api/whatsapp/setup       → Échange le code Embedded Signup → WABA
 *  GET    /api/whatsapp/status      → Statut connexion de l'artiste
 *  DELETE /api/whatsapp/disconnect  → Déconnecter WhatsApp
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { db }  = require('../db/database');

// ── Migrations ─────────────────────────────────────────────────────────────────
[
  'ALTER TABLE users ADD COLUMN meta_wa_access_token  TEXT    DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN meta_wa_business_id   TEXT    DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN meta_wa_connected_at  DATETIME DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN meta_wa_phone_display TEXT    DEFAULT NULL',
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// ── Middleware auth artiste ─────────────────────────────────────────────────────
function requireArtistAuth(req, res, next) {
  try {
    const token = req.cookies?.inkr_token
      || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'inkr_secret_dev');
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

// ── GET /config — Expose les valeurs publiques Meta au frontend ────────────────
// Ces identifiants sont intentionnellement publics (ils initialisent le SDK JS)
router.get('/config', (_req, res) => {
  res.json({
    metaAppId : process.env.META_APP_ID        || null,
    waConfigId: process.env.META_WA_CONFIG_ID  || null,
    configured: !!(process.env.META_APP_ID && process.env.META_WA_CONFIG_ID),
  });
});

// ── POST /setup — Échange le code Embedded Signup → WABA + Phone Number ID ────
router.post('/setup', requireArtistAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code manquant' });

    const { META_APP_ID: appId, META_APP_SECRET: appSecret } = process.env;
    if (!appId || !appSecret) {
      return res.status(500).json({ error: 'META_APP_ID / META_APP_SECRET manquants dans Railway' });
    }

    // 1. Échanger le code contre un user access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token` +
      `?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`
    );
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error('[WA Embedded Signup] Token exchange error:', tokenData.error);
      return res.status(400).json({ error: tokenData.error.message || 'Échange de code échoué' });
    }

    const userToken = tokenData.access_token;
    let wabaId      = null;
    let phoneId     = null;
    let phoneDisplay = null;

    // 2a. Route principale : /me/businesses → whatsapp_business_accounts → phone_numbers
    try {
      const bizRes = await fetch(
        `https://graph.facebook.com/v21.0/me/businesses` +
        `?fields=whatsapp_business_accounts{id,phone_numbers{id,display_phone_number,verified_name}}` +
        `&access_token=${userToken}`
      );
      const bizData = await bizRes.json();
      for (const biz of (bizData.data || [])) {
        const wabas = biz.whatsapp_business_accounts?.data || [];
        if (wabas.length > 0) {
          wabaId = wabas[0].id;
          const phones = wabas[0].phone_numbers?.data || [];
          if (phones.length > 0) {
            phoneId      = phones[0].id;
            phoneDisplay = phones[0].display_phone_number;
          }
          break;
        }
      }
    } catch (e) {
      console.warn('[WA Setup] Route principale failed:', e.message);
    }

    // 2b. Fallback : /me/whatsapp_business_accounts
    if (!wabaId) {
      const waRes = await fetch(
        `https://graph.facebook.com/v21.0/me/whatsapp_business_accounts` +
        `?access_token=${userToken}`
      );
      const waData = await waRes.json();
      if (waData.data?.length > 0) {
        wabaId = waData.data[0].id;
        const phonesRes = await fetch(
          `https://graph.facebook.com/v21.0/${wabaId}/phone_numbers` +
          `?fields=id,display_phone_number,verified_name&access_token=${userToken}`
        );
        const phonesData = await phonesRes.json();
        if (phonesData.data?.length > 0) {
          phoneId      = phonesData.data[0].id;
          phoneDisplay = phonesData.data[0].display_phone_number;
        }
      }
    }

    if (!wabaId || !phoneId) {
      return res.status(400).json({
        error:
          'Aucun compte WhatsApp Business trouvé. ' +
          'Assurez-vous d\'avoir ajouté et vérifié un numéro pendant la connexion Meta.',
      });
    }

    // 3. Souscrire aux webhooks pour ce WABA (le webhook est déjà sur /api/webhooks/meta)
    try {
      await fetch(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`, {
        method : 'POST',
        headers: { Authorization: `Bearer ${userToken}` },
      });
      console.log(`[WA Setup] Webhook souscrit pour WABA ${wabaId}`);
    } catch (e) {
      console.warn('[WA Setup] Webhook subscription (non-bloquant):', e.message);
    }

    // 4. Stocker en base
    db.prepare(`
      UPDATE users
      SET meta_wa_phone_id      = ?,
          meta_wa_access_token  = ?,
          meta_wa_business_id   = ?,
          meta_wa_phone_display = ?,
          meta_wa_connected_at  = datetime('now')
      WHERE id = ?
    `).run(phoneId, userToken, wabaId, phoneDisplay, req.userId);

    console.log(`[WA Setup] Artiste ${req.userId} connecté — WABA=${wabaId}, Phone=${phoneId} (${phoneDisplay})`);
    res.json({ ok: true, phone: phoneDisplay, phoneId, wabaId });

  } catch (err) {
    console.error('[WA Setup] Erreur:', err.message);
    res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
});

// ── GET /status — Statut WhatsApp de l'artiste ─────────────────────────────────
router.get('/status', requireArtistAuth, (req, res) => {
  const u = db.prepare(`
    SELECT meta_wa_phone_id, meta_wa_business_id, meta_wa_phone_display, meta_wa_connected_at
    FROM users WHERE id = ?
  `).get(req.userId);

  if (!u?.meta_wa_phone_id) return res.json({ connected: false });

  res.json({
    connected  : true,
    phoneId    : u.meta_wa_phone_id,
    wabaId     : u.meta_wa_business_id,
    phone      : u.meta_wa_phone_display,
    connectedAt: u.meta_wa_connected_at,
  });
});

// ── DELETE /disconnect — Déconnecter WhatsApp ──────────────────────────────────
router.delete('/disconnect', requireArtistAuth, (req, res) => {
  db.prepare(`
    UPDATE users
    SET meta_wa_phone_id=NULL, meta_wa_access_token=NULL,
        meta_wa_business_id=NULL, meta_wa_phone_display=NULL,
        meta_wa_connected_at=NULL
    WHERE id=?
  `).run(req.userId);
  res.json({ ok: true });
});

module.exports = router;
