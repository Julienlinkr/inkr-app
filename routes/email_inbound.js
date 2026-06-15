/**
 * routes/email_inbound.js
 *
 * Emails entrants @inkr.club — chaque artiste reçoit une adresse dédiée.
 * Les clients écrivent à julien@inkr.club → le message arrive dans la messagerie inkr.
 * L'artiste répond depuis inkr → envoyé via Resend en son nom (@inkr.club).
 *
 * ─── Setup externe requis ─────────────────────────────────────────────────────
 *
 * OPTION A — Mailgun (recommandé, gratuit jusqu'à 5000 emails/mois) :
 *  1. Mailgun Dashboard → Domains → Add Domain → inkr.club (Receiving mode)
 *  2. Ajouter les MX records dans Cloudflare/DNS de inkr.club
 *  3. Routes → Create Route → match_recipient(".*@inkr\.club") ou match_all()
 *     → forward("https://inkr.club/api/email/inbound/webhook")
 *  4. Railway → MAILGUN_WEBHOOK_SIGNING_KEY (Mailgun → Sending → Webhooks)
 *
 * OPTION B — Cloudflare Email Routing (100 % gratuit) :
 *  1. Cloudflare Dashboard → Email Routing → Enable
 *  2. Catch-all address → Send to a Worker
 *  3. Le Worker transforme l'email en JSON → POST /api/email/inbound/webhook
 *     avec header "X-Inkr-Secret: {EMAIL_INBOUND_SECRET}"
 *  4. Railway → EMAIL_INBOUND_SECRET (chaîne libre, ex: inkr_email_2026)
 *
 * ─── Variables Railway ─────────────────────────────────────────────────────────
 *  MAILGUN_WEBHOOK_SIGNING_KEY → Clé de vérification Mailgun (option A)
 *  EMAIL_INBOUND_SECRET        → Secret pour Cloudflare Workers (option B)
 *  RESEND_API_KEY              → Pour envoyer les réponses (déjà configuré)
 *  INKR_DOMAIN                 → inkr.club
 *
 * ─── Routes ───────────────────────────────────────────────────────────────────
 *  GET  /api/email/inbound/address     → Adresse @inkr.club de l'artiste
 *  POST /api/email/inbound/generate    → Générer / personnaliser l'adresse
 *  POST /api/email/inbound/webhook     → Webhook Mailgun / Cloudflare
 *  POST /api/email/inbound/reply       → L'artiste répond à un email
 * ──────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { db }  = require('../db/database');

const INKR_DOMAIN = process.env.INKR_DOMAIN || 'inkr.club';

// ── Migrations ─────────────────────────────────────────────────────────────────
[
  'ALTER TABLE users    ADD COLUMN inkr_email_slug  TEXT    DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN email_from_addr  TEXT    DEFAULT NULL',
  'ALTER TABLE messages ADD COLUMN email_to_addr    TEXT    DEFAULT NULL',
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// ── Middleware auth artiste ────────────────────────────────────────────────────
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

// ── Génère un slug unique à partir du nom ──────────────────────────────────────
function makeSlug(name, userId) {
  let base = (name || 'artiste')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // ôter les accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'artiste';

  let slug = base;
  let n    = 0;
  while (true) {
    const taken = db.prepare('SELECT id FROM users WHERE inkr_email_slug = ? AND id != ?').get(slug, userId);
    if (!taken) break;
    slug = `${base}${++n}`;
  }
  return slug;
}

// ── GET /address — Adresse @inkr.club de l'artiste connecté ───────────────────
router.get('/address', requireArtistAuth, (req, res) => {
  const u = db.prepare('SELECT inkr_email_slug, name, studio_name FROM users WHERE id = ?').get(req.userId);
  if (!u?.inkr_email_slug) return res.json({ configured: false, email: null });
  res.json({
    configured: true,
    email     : `${u.inkr_email_slug}@${INKR_DOMAIN}`,
    slug      : u.inkr_email_slug,
  });
});

// ── POST /generate — Créer ou personnaliser l'adresse @inkr.club ──────────────
router.post('/generate', requireArtistAuth, (req, res) => {
  const u = db.prepare('SELECT name, studio_name, inkr_email_slug FROM users WHERE id = ?').get(req.userId);

  // Si l'artiste propose un slug custom
  if (req.body.slug) {
    const custom = req.body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 25);
    if (!custom || custom.length < 2) return res.status(400).json({ error: 'Adresse trop courte (min 2 caractères)' });
    const taken = db.prepare('SELECT id FROM users WHERE inkr_email_slug = ? AND id != ?').get(custom, req.userId);
    if (taken) return res.status(409).json({ error: `${custom}@${INKR_DOMAIN} est déjà pris` });
    db.prepare('UPDATE users SET inkr_email_slug = ? WHERE id = ?').run(custom, req.userId);
    return res.json({ ok: true, email: `${custom}@${INKR_DOMAIN}`, slug: custom });
  }

  // Sinon, générer automatiquement si pas encore de slug
  if (u?.inkr_email_slug) {
    return res.json({ ok: true, email: `${u.inkr_email_slug}@${INKR_DOMAIN}`, slug: u.inkr_email_slug });
  }

  const slug = makeSlug(u?.studio_name || u?.name || '', req.userId);
  db.prepare('UPDATE users SET inkr_email_slug = ? WHERE id = ?').run(slug, req.userId);
  console.log(`[Email Inbound] Artiste ${req.userId} → ${slug}@${INKR_DOMAIN}`);
  res.json({ ok: true, email: `${slug}@${INKR_DOMAIN}`, slug });
});

// ── POST /webhook — Reçoit les emails entrants (Mailgun / Cloudflare) ─────────
// ⚠️  Cette route est appelée par Mailgun/Cloudflare — PAS par le navigateur artiste.
//     Pas de cookie auth — vérification par signature ou secret header.
router.post('/webhook', async (req, res) => {
  // Répondre immédiatement pour éviter les renvois de Mailgun
  res.sendStatus(200);

  (async () => {
    try {
      // ── Vérification signature Mailgun ────────────────────────────────────
      const sigKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
      if (sigKey && req.body.timestamp && req.body.token && req.body.signature) {
        const expected = crypto
          .createHmac('sha256', sigKey)
          .update(req.body.timestamp + req.body.token)
          .digest('hex');
        if (expected !== req.body.signature) {
          console.warn('[Email Inbound] Signature Mailgun invalide — ignoré');
          return;
        }
      }

      // ── Vérification secret Cloudflare Workers ────────────────────────────
      const inboundSecret = process.env.EMAIL_INBOUND_SECRET;
      if (inboundSecret && req.headers['x-inkr-secret'] !== inboundSecret) {
        console.warn('[Email Inbound] Secret Cloudflare invalide — ignoré');
        return;
      }

      // ── Extraire les champs email ─────────────────────────────────────────
      // Mailgun : body-plain, body-html, sender, recipient, subject
      // JSON générique (Cloudflare) : from, to, text, html, subject
      const from     = req.body.sender    || req.body.from    || '';
      const to       = req.body.recipient || req.body.to      || '';
      const subject  = req.body.subject   || '(sans objet)';
      const textBody = req.body['body-plain'] || req.body.text  || req.body.body || '';
      const htmlBody = req.body['body-html']  || req.body.html  || '';
      const msgId    = req.body['Message-Id'] || req.body['message-id'] || null;

      if (!from || !to) {
        console.warn('[Email Inbound] Champs from/to manquants — ignoré');
        return;
      }

      // ── Trouver l'artiste destinataire via le slug ────────────────────────
      const toClean = to.toLowerCase().split(/[\s,<>]/)[0].trim();
      const m       = toClean.match(/^([^@]+)@/);
      if (!m) { console.warn('[Email Inbound] Adresse destinataire invalide:', to); return; }

      const slug   = m[1];
      const artist = db.prepare('SELECT * FROM users WHERE inkr_email_slug = ?').get(slug);
      if (!artist) { console.warn(`[Email Inbound] Aucun artiste pour slug "${slug}"`); return; }

      // ── Dédoublonnage ─────────────────────────────────────────────────────
      if (msgId) {
        const exists = db.prepare('SELECT id FROM messages WHERE external_id = ?').get(msgId);
        if (exists) { console.log(`[Email Inbound] Message ${msgId} déjà reçu — ignoré`); return; }
      }

      // ── Parser l'adresse expéditeur "Jean Dupont <jean@gmail.com>" ────────
      const fromMatch = from.match(/^(.*?)\s*<([^>]+)>/);
      const fromName  = fromMatch ? (fromMatch[1].trim() || fromMatch[2]) : from;
      const fromEmail = fromMatch ? fromMatch[2] : from;

      // ── Chercher le client correspondant (par email) ──────────────────────
      const client = db.prepare(
        'SELECT * FROM clients WHERE user_id = ? AND email = ?'
      ).get(artist.id, fromEmail.toLowerCase());

      // ── Corps du message (texte brut prioritaire) ─────────────────────────
      const content = (textBody || htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 2000);

      // ── Stocker en base ───────────────────────────────────────────────────
      db.prepare(`
        INSERT INTO messages
          (user_id, client_id, client_name, channel, direction, content,
           subject, external_id, email_from_addr, email_to_addr)
        VALUES (?, ?, ?, 'email', 'in', ?, ?, ?, ?, ?)
      `).run(
        artist.id,
        client?.id   || null,
        fromName     || fromEmail,
        content,
        subject.slice(0, 200),
        msgId,
        fromEmail,
        `${slug}@${INKR_DOMAIN}`,
      );

      console.log(`[Email Inbound] ✉️  ${fromName} → ${slug}@${INKR_DOMAIN} | "${subject}"`);

    } catch (err) {
      console.error('[Email Inbound] Erreur:', err.message);
    }
  })();
});

// ── POST /reply — L'artiste répond à un email entrant ─────────────────────────
// Envoie depuis {slug}@inkr.club via Resend
router.post('/reply', requireArtistAuth, async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Destinataire (to) et corps (body) requis' });

    const user = db.prepare('SELECT name, studio_name, inkr_email_slug FROM users WHERE id = ?').get(req.userId);
    if (!user?.inkr_email_slug) {
      return res.status(400).json({ error: 'Adresse @inkr.club non configurée. Allez dans Profil → Messagerie unifiée.' });
    }

    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) return res.status(503).json({ error: 'RESEND_API_KEY manquant dans Railway' });

    const displayName = user.studio_name || user.name || 'Artiste inkr';
    const fromAddr    = `${displayName} <${user.inkr_email_slug}@${INKR_DOMAIN}>`;
    const mailSubject = subject || 'Re: votre message';

    const emailRes = await fetch('https://api.resend.com/emails', {
      method : 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body   : JSON.stringify({ from: fromAddr, to: [to], subject: mailSubject, text: body }),
    });

    const emailData = await emailRes.json();
    if (!emailRes.ok || emailData.error) {
      console.error('[Email Inbound Reply] Resend error:', emailData);
      return res.status(500).json({ error: emailData.error?.message || 'Erreur Resend' });
    }

    // Sauvegarder le message sortant
    db.prepare(`
      INSERT INTO messages
        (user_id, client_name, channel, direction, content, subject, email_from_addr, email_to_addr)
      VALUES (?, ?, 'email', 'out', ?, ?, ?, ?)
    `).run(req.userId, to, body, mailSubject, fromAddr, to);

    console.log(`[Email Inbound Reply] ${fromAddr} → ${to}`);
    res.json({ ok: true, messageId: emailData.id });

  } catch (err) {
    console.error('[Email Inbound Reply] Erreur:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
