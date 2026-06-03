/**
 * routes/webhooks.js
 *
 * Webhook unifié Meta — reçoit les messages WhatsApp Business + Instagram DMs.
 *
 * ─── Pour les développeurs ────────────────────────────────────────────────
 * Variables Railway requises :
 *   META_VERIFY_TOKEN    → Chaîne libre que VOUS définissez (ex: inkr_webhook_2026)
 *                          À copier telle quelle dans Meta Developer Console
 *   META_APP_SECRET      → App Secret (Meta Developer → App → Paramètres basiques)
 *   WHATSAPP_TOKEN       → System User Token ou Page Access Token permanent
 *   WHATSAPP_PHONE_ID    → ID du numéro WhatsApp Business (Meta Developer → WhatsApp → Configuration)
 *   INSTAGRAM_PAGE_TOKEN → Token Page Facebook liée au compte Instagram Business
 *
 * Webhook URL à configurer dans Meta Developer Console :
 *   https://inkr-app-production.up.railway.app/api/webhooks/meta
 *
 * Champs à souscrire :
 *   WhatsApp Business Account → messages
 *   Instagram → messages, messaging_postbacks
 *
 * ⚠️  Ce router DOIT être monté AVANT express.json() dans server.js
 *     pour pouvoir vérifier la signature HMAC sur le body brut.
 * ──────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/database');

// ─── GET /meta — Vérification du webhook par Meta ──────────────────────────
// Meta envoie une requête GET lors de la configuration du webhook pour vérifier
// que l'URL est bien contrôlée par le développeur.
router.get('/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('[Meta webhook] Webhook vérifié avec succès');
    return res.status(200).send(challenge);
  }

  console.warn('[Meta webhook] Vérification échouée — token invalide ou mode incorrect');
  res.status(403).json({ error: 'Vérification du webhook échouée' });
});

// ─── POST /meta — Réception des messages WhatsApp + Instagram ─────────────
// Meta envoie les événements ici en temps réel.
// ⚠️  express.raw() est indispensable avant express.json() pour la vérification HMAC.
router.post('/meta', express.raw({ type: 'application/json' }), (req, res) => {
  // Répondre 200 immédiatement pour éviter que Meta retente l'envoi
  res.sendStatus(200);

  // Traitement asynchrone pour ne pas bloquer
  (async () => {
    try {
      // ── Vérification de la signature HMAC-SHA256 ────────────────────────
      // Meta signe chaque requête avec l'App Secret pour prouver son authenticité.
      const appSecret = process.env.META_APP_SECRET;
      if (appSecret) {
        const signature = req.headers['x-hub-signature-256'];
        if (!signature) {
          console.warn('[Meta webhook] Requête sans signature X-Hub-Signature-256 — ignorée');
          return;
        }
        const expectedSig = 'sha256=' + crypto
          .createHmac('sha256', appSecret)
          .update(req.body)
          .digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
          console.warn('[Meta webhook] Signature invalide — requête rejetée');
          return;
        }
      }

      // Parser le body (Buffer → JSON)
      let body;
      try {
        body = JSON.parse(req.body.toString());
      } catch (parseErr) {
        console.error('[Meta webhook] Body JSON invalide:', parseErr.message);
        return;
      }

      const entries = body.entry || [];

      for (const entry of entries) {
        // ── WhatsApp Business — field: "messages" ─────────────────────────
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.field === 'messages') {
            await handleWhatsAppChange(change.value);
          }
        }

        // ── Instagram DMs — messaging array ──────────────────────────────
        const messaging = entry.messaging || [];
        for (const event of messaging) {
          if (event.message && !event.message.is_echo) {
            await handleInstagramDM(entry.id, event);
          }
        }
      }
    } catch (err) {
      // Ne jamais laisser une exception remonter — Meta retentera sinon
      console.error('[Meta webhook] Erreur non gérée:', err.message);
    }
  })();
});

// ─── Traitement d'un événement WhatsApp ────────────────────────────────────
async function handleWhatsAppChange(value) {
  try {
    const messages = value.messages || [];
    if (messages.length === 0) return;

    // Trouver l'artiste associé à ce numéro WhatsApp Business
    // meta_wa_phone_id est le Phone Number ID du compte WhatsApp Business
    let artist = null;
    if (value.metadata?.phone_number_id) {
      artist = db.prepare('SELECT * FROM users WHERE meta_wa_phone_id = ?')
        .get(value.metadata.phone_number_id);
    }
    // Fallback MVP mono-artiste : utiliser le premier utilisateur
    if (!artist) {
      artist = db.prepare('SELECT * FROM users LIMIT 1').get();
    }
    if (!artist) {
      console.warn('[WhatsApp webhook] Aucun artiste trouvé pour traiter le message');
      return;
    }

    for (const msg of messages) {
      // On ne traite que les messages texte pour l'instant
      if (msg.type !== 'text') {
        console.log(`[WhatsApp] Message type "${msg.type}" reçu de +${msg.from} — ignoré (non-texte)`);
        continue;
      }

      const from = msg.from; // Numéro E.164 sans le +, ex: "33612345678"
      const text = msg.text?.body || '';
      const waId = msg.id;

      console.log(`[WhatsApp] Message reçu de +${from}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

      // Déduplications : ne pas insérer deux fois le même message Meta
      const existing = db.prepare('SELECT id FROM messages WHERE external_id = ?').get(waId);
      if (existing) {
        console.log(`[WhatsApp] Message ${waId} déjà enregistré — ignoré`);
        continue;
      }

      // Chercher le client correspondant dans la base de l'artiste (par téléphone)
      const client = db.prepare(
        'SELECT * FROM clients WHERE user_id = ? AND (phone = ? OR whatsapp = ?)'
      ).get(artist.id, '+' + from, '+' + from);

      const clientName = client
        ? [client.prenom, client.name].filter(Boolean).join(' ')
        : `+${from}`;

      // Sauvegarder le message entrant en base
      db.prepare(
        'INSERT INTO messages (user_id, client_id, client_name, channel, direction, content, external_id, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        artist.id,
        client?.id || null,
        clientName,
        'whatsapp',
        'in',
        text,
        waId,
        '+' + from
      );

      // ── Vérifier si une réponse automatique WhatsApp est configurée ────
      const autoReply = db.prepare(
        "SELECT * FROM automations WHERE user_id = ? AND type = ? AND enabled = 1"
      ).get(artist.id, 'auto_reply_whatsapp');

      if (autoReply && autoReply.message) {
        const replyText = autoReply.message
          .replace(/\{\{prénom\}\}/g, client?.prenom || clientName)
          .replace(/\{\{studio\}\}/g, artist.studio_name || artist.name);

        // Délai de 2 secondes avant d'envoyer pour paraître plus naturel
        setTimeout(async () => {
          try {
            await sendWhatsAppMessage(from, replyText);
            // Sauvegarder le message sortant en base
            db.prepare(
              'INSERT INTO messages (user_id, client_id, client_name, channel, direction, content, phone) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(artist.id, client?.id || null, clientName, 'whatsapp', 'out', replyText, '+' + from);
          } catch (replyErr) {
            console.error('[WhatsApp auto_reply] Erreur:', replyErr.message);
          }
        }, 2000);
      }
    }
  } catch (err) {
    console.error('[WhatsApp handler] Erreur:', err.message);
  }
}

// ─── Traitement d'un message Instagram DM ──────────────────────────────────
async function handleInstagramDM(pageId, event) {
  try {
    const senderId = event.sender?.id;
    const text = event.message?.text || '';
    const mid = event.message?.mid;

    if (!senderId || !text) return;

    console.log(`[Instagram DM] Message reçu de ${senderId}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

    // Dédoublonnage par ID de message Meta
    if (mid) {
      const existing = db.prepare('SELECT id FROM messages WHERE external_id = ?').get(mid);
      if (existing) {
        console.log(`[Instagram DM] Message ${mid} déjà enregistré — ignoré`);
        return;
      }
    }

    // Trouver l'artiste associé à cette Page Instagram
    let artist = db.prepare('SELECT * FROM users WHERE meta_ig_page_id = ?').get(pageId);
    if (!artist) {
      // Fallback MVP mono-artiste
      artist = db.prepare('SELECT * FROM users LIMIT 1').get();
    }
    if (!artist) {
      console.warn('[Instagram webhook] Aucun artiste trouvé pour traiter le DM');
      return;
    }

    // Sauvegarder le message entrant en base
    db.prepare(
      'INSERT INTO messages (user_id, client_name, channel, direction, content, external_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      artist.id,
      `IG: ${senderId}`,
      'instagram',
      'in',
      text,
      mid || null
    );
  } catch (err) {
    console.error('[Instagram DM handler] Erreur:', err.message);
  }
}

// ─── Envoi d'un message WhatsApp via l'API Meta ───────────────────────────
// `to` est en format E.164 sans le + (ex: "33612345678")
async function sendWhatsAppMessage(to, text) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;

  if (!phoneId || !token) {
    console.log(`[WhatsApp SIMULÉ] → +${to}: ${text}`);
    return { simulated: true };
  }

  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || 'Erreur WhatsApp API');
  }
  return data;
}

// ─── Envoi d'un message Instagram DM via l'API Meta ──────────────────────
// `recipientId` est l'ID PSID de l'utilisateur Instagram
async function sendInstagramMessage(recipientId, text) {
  const token = process.env.INSTAGRAM_PAGE_TOKEN;

  if (!token) {
    console.log(`[IG DM SIMULÉ] → ${recipientId}: ${text}`);
    return { simulated: true };
  }

  const res = await fetch('https://graph.facebook.com/v19.0/me/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'RESPONSE',
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || 'Erreur Instagram DM');
  }
  return data;
}

module.exports = router;
module.exports.sendWhatsAppMessage = sendWhatsAppMessage;
module.exports.sendInstagramMessage = sendInstagramMessage;
