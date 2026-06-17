/**
 * routes/email_imap.js
 *
 * Connexion boîte mail IMAP pour les artistes inkr.
 * Supporte Gmail, Outlook, Yahoo, iCloud et toute boîte IMAP standard.
 *
 * ─── Flow artiste (2 clics) ────────────────────────────────────────────────
 *  1. Artiste choisit Gmail / Outlook / Yahoo dans le dashboard
 *  2. Saisit son email + mot de passe d'application
 *  3. inkr teste la connexion IMAP → sauvegarde → sync initiale des 50 derniers emails
 *  4. Tous les emails apparaissent dans Messagerie → filtre ✉️ Email
 *  5. L'artiste peut répondre directement depuis inkr (SMTP)
 *  6. Sync automatique toutes les 5 minutes en arrière-plan
 *
 * ─── Variables Railway (pas nécessaires — credentials stockés par artiste) ──
 *  Aucune variable Railway requise. Chaque artiste saisit ses propres identifiants.
 *
 * ─── Aide Gmail ────────────────────────────────────────────────────────────
 *  Gmail nécessite un "Mot de passe d'application" (pas votre vrai mdp).
 *  myaccount.google.com → Sécurité → Connexion → Mots de passe d'application
 * ──────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const { db }   = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';

// ── Migrations DB ──────────────────────────────────────────────────────────────
[
  'ALTER TABLE users ADD COLUMN imap_host TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN imap_port INTEGER DEFAULT 993',
  'ALTER TABLE users ADD COLUMN imap_user TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN imap_password TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN smtp_host TEXT DEFAULT NULL',
  'ALTER TABLE users ADD COLUMN smtp_port INTEGER DEFAULT 587',
  'ALTER TABLE users ADD COLUMN imap_last_sync DATETIME DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN subject TEXT DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN email_to TEXT DEFAULT NULL',
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// ── Auth middleware ────────────────────────────────────────────────────────────
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

// ── Presets IMAP/SMTP par fournisseur ─────────────────────────────────────────
const PRESETS = {
  gmail:   { imap_host: 'imap.gmail.com',          imap_port: 993, smtp_host: 'smtp.gmail.com',          smtp_port: 587 },
  outlook: { imap_host: 'outlook.office365.com',    imap_port: 993, smtp_host: 'smtp.office365.com',      smtp_port: 587 },
  yahoo:   { imap_host: 'imap.mail.yahoo.com',      imap_port: 993, smtp_host: 'smtp.mail.yahoo.com',     smtp_port: 465 },
  icloud:  { imap_host: 'imap.mail.me.com',         imap_port: 993, smtp_host: 'smtp.mail.me.com',        smtp_port: 587 },
  orange:  { imap_host: 'imap.orange.fr',           imap_port: 993, smtp_host: 'smtp.orange.fr',          smtp_port: 587 },
  sfr:     { imap_host: 'imap.sfr.fr',              imap_port: 993, smtp_host: 'smtp.sfr.fr',             smtp_port: 465 },
  free:    { imap_host: 'imap.free.fr',             imap_port: 993, smtp_host: 'smtp.free.fr',            smtp_port: 465 },
};

// ── POST /connect ──────────────────────────────────────────────────────────────
// Teste la connexion IMAP et sauvegarde les credentials.
// Body: { provider, email, password, imap_host?, imap_port?, smtp_host?, smtp_port? }
router.post('/connect', requireAuth, async (req, res) => {
  const {
    provider, email: imapUser, password: imapPass,
    imap_host, imap_port, smtp_host, smtp_port,
  } = req.body;

  if (!imapUser || !imapPass) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  const preset = PRESETS[provider] || {};
  const cfg = {
    imap_host:  imap_host  || preset.imap_host  || '',
    imap_port:  parseInt(imap_port  || preset.imap_port  || 993),
    smtp_host:  smtp_host  || preset.smtp_host  || '',
    smtp_port:  parseInt(smtp_port  || preset.smtp_port  || 587),
    imap_user:  imapUser.trim(),
    imap_pass:  imapPass,
  };

  if (!cfg.imap_host) {
    return res.status(400).json({ error: 'Serveur IMAP manquant — choisissez un fournisseur ou entrez l\'adresse manuellement' });
  }

  // ── Test de connexion IMAP ─────────────────────────────────────────────────
  try {
    const { ImapFlow } = require('imapflow');
    const client = new ImapFlow({
      host: cfg.imap_host,
      port: cfg.imap_port,
      secure: true,
      auth: { user: cfg.imap_user, pass: cfg.imap_pass },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    await client.connect();
    await client.logout();
    console.log(`[Email IMAP] Connexion testée OK — ${cfg.imap_user}@${cfg.imap_host}`);
  } catch (e) {
    let hint = '';
    if (e.message?.includes('auth') || e.message?.includes('credentials')) {
      hint = ' — Gmail : utilisez un "Mot de passe d\'application" (myaccount.google.com → Sécurité)';
    }
    return res.status(400).json({ error: `Connexion impossible : ${e.message}${hint}` });
  }

  // ── Sauvegarde en base ─────────────────────────────────────────────────────
  db.prepare(`
    UPDATE users
    SET imap_host=?, imap_port=?, imap_user=?, imap_password=?, smtp_host=?, smtp_port=?
    WHERE id=?
  `).run(cfg.imap_host, cfg.imap_port, cfg.imap_user, cfg.imap_pass,
         cfg.smtp_host, cfg.smtp_port, req.userId);

  console.log(`[Email IMAP] Artiste #${req.userId} connecté → ${cfg.imap_user}`);

  // ── Sync initiale en arrière-plan ─────────────────────────────────────────
  syncEmailsForUser(req.userId)
    .catch(e => console.error('[Email sync initial]', e.message));

  res.json({ ok: true, email: cfg.imap_user });
});

// ── GET /status ────────────────────────────────────────────────────────────────
router.get('/status', requireAuth, (req, res) => {
  try {
    const u = db.prepare('SELECT imap_user, imap_last_sync FROM users WHERE id=?').get(req.userId);
    res.json({
      connected:  !!u?.imap_user,
      email:      u?.imap_user || null,
      last_sync:  u?.imap_last_sync || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /disconnect ─────────────────────────────────────────────────────────
router.delete('/disconnect', requireAuth, (req, res) => {
  try {
    db.prepare(`
      UPDATE users
      SET imap_host=NULL, imap_port=NULL, imap_user=NULL, imap_password=NULL,
          smtp_host=NULL, smtp_port=NULL, imap_last_sync=NULL
      WHERE id=?
    `).run(req.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /sync ─────────────────────────────────────────────────────────────────
// Déclenche une synchronisation manuelle des emails.
router.post('/sync', requireAuth, async (req, res) => {
  const u = db.prepare('SELECT imap_user FROM users WHERE id=?').get(req.userId);
  if (!u?.imap_user) return res.status(400).json({ error: 'Email non connecté' });
  try {
    const count = await syncEmailsForUser(req.userId);
    res.json({ ok: true, new_messages: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /messages ──────────────────────────────────────────────────────────────
// Retourne les emails stockés (tous canaux email) pour l'artiste.
router.get('/messages', requireAuth, (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
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

// ── POST /reply ────────────────────────────────────────────────────────────────
// Envoie un email via SMTP depuis la boîte connectée de l'artiste.
// Body: { to, subject, body, in_reply_to? }
router.post('/reply', requireAuth, async (req, res) => {
  const { to, subject, body, in_reply_to } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'Destinataire et corps requis' });

  const u = db.prepare(
    'SELECT imap_user, imap_password, smtp_host, smtp_port FROM users WHERE id=?'
  ).get(req.userId);
  if (!u?.imap_user) return res.status(400).json({ error: 'Email non connecté — configurez votre boîte dans Profil' });

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: u.smtp_host,
      port: u.smtp_port,
      secure: u.smtp_port === 465,
      auth: { user: u.imap_user, pass: u.imap_password },
      tls: { rejectUnauthorized: false },
    });

    const mailOptions = {
      from: u.imap_user,
      to,
      subject: subject || 'Re: (sans objet)',
      text: body,
      ...(in_reply_to ? { inReplyTo: in_reply_to, references: [in_reply_to] } : {}),
    };

    await transporter.sendMail(mailOptions);

    // Sauvegarder le message sortant en base
    db.prepare(`
      INSERT INTO messages (user_id, client_name, channel, direction, content, subject, sender_id, email_to, is_read)
      VALUES (?,?,?,?,?,?,?,?,1)
    `).run(req.userId, to, 'email', 'out', body, subject || '', u.imap_user, to);

    res.json({ ok: true });
  } catch (e) {
    console.error('[Email reply SMTP]', e.message);
    res.status(500).json({ error: `Envoi échoué : ${e.message}` });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SYNC IMAP — Récupération des emails et stockage en base
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Synchronise les 50 derniers emails INBOX de l'artiste.
 * Stocke les nouveaux emails dans la table messages.
 * @param {number} userId - ID de l'artiste
 * @returns {number} - Nombre de nouveaux emails insérés
 */
async function syncEmailsForUser(userId) {
  const u = db.prepare(
    'SELECT imap_host, imap_port, imap_user, imap_password FROM users WHERE id=?'
  ).get(userId);

  if (!u?.imap_user || !u?.imap_password) return 0;

  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');

  const client = new ImapFlow({
    host: u.imap_host,
    port: u.imap_port,
    secure: true,
    auth: { user: u.imap_user, pass: u.imap_password },
    logger: false,
    tls: { rejectUnauthorized: false },
    // Timeout pour éviter les blocages
    socketTimeout: 15000,
    greetingTimeout: 10000,
    connectionTimeout: 10000,
  });

  let newCount = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const total = client.mailbox?.exists || 0;
      if (total === 0) return 0;

      // Récupère les 50 derniers messages
      const start = Math.max(1, total - 49);
      const range = `${start}:${total}`;

      for await (const msg of client.fetch(range, { source: true, uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const msgId = parsed.messageId || `${u.imap_user}_uid_${msg.uid}`;
          const externalId = `email_${msgId.replace(/[<>\s]/g, '_').slice(0, 200)}`;

          // Déduplication par ID de message
          const exists = db.prepare('SELECT id FROM messages WHERE external_id=?').get(externalId);
          if (exists) continue;

          const fromAddr = parsed.from?.value?.[0];
          const senderName = fromAddr?.name || fromAddr?.address || 'Inconnu';
          const senderAddr = fromAddr?.address || null;
          const subject    = (parsed.subject || '(sans objet)').slice(0, 500);

          // Corps : texte brut en priorité, sinon extrait du HTML, tronqué à 3000 chars
          const textBody = (parsed.text || '').replace(/\r\n/g, '\n').trim().slice(0, 3000)
            || (parsed.html || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 3000)
            || '';

          db.prepare(`
            INSERT INTO messages
              (user_id, client_name, channel, direction, content, subject, external_id, sender_id)
            VALUES (?,?,?,?,?,?,?,?)
          `).run(userId, senderName, 'email', 'in', textBody, subject, externalId, senderAddr);

          newCount++;
        } catch (parseErr) {
          // Ignorer les emails qui ne peuvent pas être parsés
          console.warn(`[Email sync] Parse error msg #${msg.uid}:`, parseErr.message);
        }
      }
    } finally {
      lock.release();
    }

    // Mettre à jour la date de dernière sync
    db.prepare('UPDATE users SET imap_last_sync=CURRENT_TIMESTAMP WHERE id=?').run(userId);
    if (newCount > 0) {
      console.log(`[Email sync] ✅ User #${userId} (${u.imap_user}) → +${newCount} nouveaux emails`);
    }

  } catch (e) {
    console.error(`[Email sync] ❌ User #${userId} (${u.imap_user}):`, e.message);
    throw e;
  } finally {
    try { await client.logout(); } catch (_) {}
  }

  return newCount;
}

// ── startEmailPolling ──────────────────────────────────────────────────────────
/**
 * Lance la boucle de synchronisation IMAP automatique.
 * Appelle syncEmailsForUser() pour chaque artiste qui a connecté sa boîte.
 * À appeler depuis server.js après le démarrage.
 */
function startEmailPolling() {
  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // Sync initiale au démarrage (après 15 secondes pour laisser le temps à la DB)
  setTimeout(async () => {
    const users = db.prepare('SELECT id, imap_user FROM users WHERE imap_user IS NOT NULL').all();
    if (users.length === 0) return;
    console.log(`[Email polling] Sync initiale pour ${users.length} artiste(s)...`);
    for (const u of users) {
      syncEmailsForUser(u.id)
        .catch(e => console.error(`[Email polling] Init user #${u.id}:`, e.message));
    }
  }, 15000);

  // Sync toutes les 5 minutes
  setInterval(() => {
    const users = db.prepare('SELECT id, imap_user FROM users WHERE imap_user IS NOT NULL').all();
    for (const u of users) {
      syncEmailsForUser(u.id)
        .catch(e => console.error(`[Email polling] User #${u.id}:`, e.message));
    }
  }, INTERVAL_MS);

  console.log('[Email polling] ✅ Démarré — sync IMAP toutes les 5 min');
}

module.exports = router;
module.exports.syncEmailsForUser  = syncEmailsForUser;
module.exports.startEmailPolling  = startEmailPolling;
