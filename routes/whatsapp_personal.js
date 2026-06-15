/**
 * routes/whatsapp_personal.js
 *
 * WhatsApp perso via QR code (Baileys — @whiskeysockets/baileys).
 * L'artiste scanne le QR avec son téléphone → ses messages WhatsApp arrivent dans inkr.
 *
 * ⚠️  Avertissement affiché à l'artiste avant connexion :
 *  "Cette méthode utilise WhatsApp Web de manière non-officielle.
 *   Elle fonctionne pour des conversations individuelles avec vos clients.
 *   Évitez les envois en masse (campagnes). Risque de suspension faible
 *   mais existant. Vous pouvez déconnecter à tout moment."
 *
 * ─── Architecture multi-artistes ──────────────────────────────────────────────
 *  Chaque artiste a sa propre session Baileys stockée dans :
 *    {DB_PATH}/../wa-sessions/{userId}/
 *  Les sessions persistent → pas besoin de rescanner à chaque redémarrage.
 *
 * ─── Routes ───────────────────────────────────────────────────────────────────
 *  POST /api/whatsapp-personal/connect    → Démarre la session, génère QR
 *  GET  /api/whatsapp-personal/qr         → Retourne le QR code (polling)
 *  GET  /api/whatsapp-personal/status     → Statut de la session
 *  POST /api/whatsapp-personal/send       → Envoyer un message
 *  DELETE /api/whatsapp-personal/logout   → Déconnecter + supprimer la session
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const path     = require('path');
const fs       = require('fs');
const { db }   = require('../db/database');

// ── Migrations ─────────────────────────────────────────────────────────────────
[
  'ALTER TABLE users    ADD COLUMN wa_personal_connected  INTEGER DEFAULT 0',
  'ALTER TABLE users    ADD COLUMN wa_personal_phone      TEXT DEFAULT NULL',
  'ALTER TABLE users    ADD COLUMN wa_personal_name       TEXT DEFAULT NULL',
  'ALTER TABLE users    ADD COLUMN wa_personal_connected_at DATETIME DEFAULT NULL',
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// ── Sessions actives (en mémoire) ─────────────────────────────────────────────
// Map<userId, { sock, qr, status, qrRefreshed }>
const sessions = new Map();

// ── Répertoire de stockage des sessions ───────────────────────────────────────
function getSessionDir(userId) {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../db/inkr.db');
  const base   = path.dirname(dbPath);
  const dir    = path.join(base, 'wa-sessions', String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Middleware auth artiste ─────────────────────────────────────────────────────
function requireAuth(req, res, next) {
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

// ── Démarre une session Baileys pour un artiste ────────────────────────────────
async function startSession(userId) {
  // Éviter les sessions en double
  if (sessions.has(userId)) {
    const existing = sessions.get(userId);
    if (existing.status === 'connected' || existing.status === 'waiting_qr') {
      return existing;
    }
    // Session morte → nettoyer
    try { existing.sock?.end?.(); } catch (_) {}
    sessions.delete(userId);
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = await import('@whiskeysockets/baileys');

  const QRCode = require('qrcode');
  const sessionDir = getSessionDir(userId);

  const session = { status: 'initializing', qr: null, qrDataUrl: null, sock: null, qrRefreshed: Date.now() };
  sessions.set(userId, session);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth              : state,
    printQRInTerminal : false,
    browser           : ['inkr', 'Chrome', '120.0'],
    syncFullHistory   : false,
    getMessage        : async () => undefined,
  });

  session.sock = sock;

  // ── Événement : QR code ────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.status      = 'waiting_qr';
      session.qr          = qr;
      session.qrRefreshed = Date.now();
      // Convertir en data URL base64 pour l'afficher dans le dashboard
      session.qrDataUrl   = await QRCode.toDataURL(qr, { width: 256, margin: 1 });
      console.log(`[WA Perso] QR prêt pour artiste ${userId}`);
    }

    if (connection === 'open') {
      session.status    = 'connected';
      session.qr        = null;
      session.qrDataUrl = null;

      // Récupérer le numéro + nom du compte connecté
      const user = sock.user;
      const phone = user?.id?.split(':')[0] || user?.id || '';
      const name  = user?.name || '';

      // Mettre à jour la base
      db.prepare(`
        UPDATE users
        SET wa_personal_connected=1, wa_personal_phone=?, wa_personal_name=?, wa_personal_connected_at=datetime('now')
        WHERE id=?
      `).run(phone, name, userId);

      console.log(`[WA Perso] Artiste ${userId} connecté — ${phone} (${name})`);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(`[WA Perso] Artiste ${userId} — reconnexion automatique...`);
        session.status = 'reconnecting';
        // Attendre 3s puis relancer
        setTimeout(() => startSession(userId), 3000);
      } else {
        console.log(`[WA Perso] Artiste ${userId} — déconnexion manuelle (loggedOut)`);
        session.status = 'disconnected';
        sessions.delete(userId);
        db.prepare('UPDATE users SET wa_personal_connected=0, wa_personal_phone=NULL, wa_personal_name=NULL WHERE id=?').run(userId);
        // Supprimer les fichiers de session
        try { fs.rmSync(getSessionDir(userId), { recursive: true }); } catch (_) {}
      }
    }
  });

  // ── Événement : sauvegarde des credentials ────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Événement : messages entrants ─────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // Ignorer les messages de l'historique

    for (const msg of messages) {
      try {
        // Ignorer les messages envoyés par nous-mêmes
        if (msg.key.fromMe) continue;

        // Ignorer les messages de groupe (pour l'instant)
        const jid = msg.key.remoteJid || '';
        if (jid.endsWith('@g.us')) continue; // groupe
        if (jid === 'status@broadcast') continue; // status

        const from    = jid.split('@')[0]; // numéro E.164 sans +
        const msgId   = msg.key.id;
        const content = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || '[message non-texte]';

        if (!from || !content) continue;

        // Dédoublonnage
        const exists = db.prepare('SELECT id FROM messages WHERE external_id = ?').get(msgId);
        if (exists) continue;

        // Chercher le client dans la base de l'artiste
        const client = db.prepare(
          'SELECT * FROM clients WHERE user_id = ? AND (phone = ? OR phone = ? OR whatsapp = ? OR whatsapp = ?)'
        ).get(userId, '+' + from, from, '+' + from, from);

        const clientName = client
          ? [client.prenom, client.name].filter(Boolean).join(' ')
          : msg.pushName || ('+' + from);

        db.prepare(`
          INSERT INTO messages
            (user_id, client_id, client_name, channel, direction, content, external_id, phone)
          VALUES (?, ?, ?, 'whatsapp', 'in', ?, ?, ?)
        `).run(
          userId,
          client?.id || null,
          clientName,
          content.slice(0, 2000),
          msgId,
          '+' + from,
        );

        console.log(`[WA Perso] Message de ${clientName} (+${from}): "${content.slice(0, 60)}"`);

      } catch (err) {
        console.error('[WA Perso] Erreur message entrant:', err.message);
      }
    }
  });

  return session;
}

// ── Restaurer les sessions au démarrage du serveur ────────────────────────────
async function restoreActiveSessions() {
  const connected = db.prepare('SELECT id FROM users WHERE wa_personal_connected = 1').all();
  for (const user of connected) {
    const sessionDir = getSessionDir(user.id);
    // Vérifier qu'il y a bien des fichiers de session (credentials)
    const hasCreds = fs.existsSync(path.join(sessionDir, 'creds.json'));
    if (hasCreds) {
      console.log(`[WA Perso] Restauration session artiste ${user.id}…`);
      startSession(user.id).catch(e => console.error(`[WA Perso] Erreur restauration artiste ${user.id}:`, e.message));
    } else {
      // Pas de fichier → remettre à 0 en base
      db.prepare('UPDATE users SET wa_personal_connected=0 WHERE id=?').run(user.id);
    }
  }
}

// ── POST /connect — Démarrer la session + générer QR ──────────────────────────
router.post('/connect', requireAuth, async (req, res) => {
  try {
    const session = await startSession(req.userId);
    res.json({ ok: true, status: session.status });
  } catch (err) {
    console.error('[WA Perso /connect] Erreur:', err.message);
    res.status(500).json({ error: 'Impossible de démarrer la session : ' + err.message });
  }
});

// ── GET /qr — Retourner le QR code (polling frontend toutes les 2s) ────────────
router.get('/qr', requireAuth, (req, res) => {
  const session = sessions.get(req.userId);

  if (!session) {
    return res.json({ status: 'not_started' });
  }
  if (session.status === 'connected') {
    return res.json({ status: 'connected' });
  }
  if (session.qrDataUrl) {
    return res.json({ status: 'waiting_qr', qr: session.qrDataUrl, refreshed: session.qrRefreshed });
  }
  res.json({ status: session.status });
});

// ── GET /status — Statut de la connexion WhatsApp perso ───────────────────────
router.get('/status', requireAuth, (req, res) => {
  const u = db.prepare('SELECT wa_personal_connected, wa_personal_phone, wa_personal_name, wa_personal_connected_at FROM users WHERE id = ?').get(req.userId);
  const session = sessions.get(req.userId);

  res.json({
    connected  : !!(u?.wa_personal_connected && session?.status === 'connected'),
    phone      : u?.wa_personal_phone  || null,
    name       : u?.wa_personal_name   || null,
    connectedAt: u?.wa_personal_connected_at || null,
    sessionStatus: session?.status || 'not_started',
  });
});

// ── POST /send — Envoyer un message WhatsApp depuis inkr ──────────────────────
router.post('/send', requireAuth, async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'to et text requis' });

    const session = sessions.get(req.userId);
    if (!session || session.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp non connecté' });
    }

    // Formater le JID (numéro@s.whatsapp.net)
    const jid = to.replace(/\D/g, '') + '@s.whatsapp.net';
    await session.sock.sendMessage(jid, { text });

    // Sauvegarder le message sortant
    db.prepare(`
      INSERT INTO messages (user_id, client_name, channel, direction, content, phone)
      VALUES (?, ?, 'whatsapp', 'out', ?, ?)
    `).run(req.userId, to, text, to);

    res.json({ ok: true });

  } catch (err) {
    console.error('[WA Perso /send] Erreur:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /logout — Déconnecter + supprimer la session ───────────────────────
router.delete('/logout', requireAuth, async (req, res) => {
  try {
    const session = sessions.get(req.userId);
    if (session?.sock) {
      try { await session.sock.logout(); } catch (_) {}
      session.sock.end?.();
    }
    sessions.delete(req.userId);

    // Supprimer les fichiers de session
    try { fs.rmSync(getSessionDir(req.userId), { recursive: true }); } catch (_) {}

    // Mettre à jour la base
    db.prepare('UPDATE users SET wa_personal_connected=0, wa_personal_phone=NULL, wa_personal_name=NULL, wa_personal_connected_at=NULL WHERE id=?').run(req.userId);

    res.json({ ok: true });
  } catch (err) {
    console.error('[WA Perso /logout] Erreur:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.restoreActiveSessions = restoreActiveSessions;
