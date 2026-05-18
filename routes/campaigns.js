const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { Resend } = require('resend');

// ============ MIDDLEWARE AUTH ============
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';

function requireAuth(req, res, next) {
  const token = req.cookies?.inkr_token;
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}

// ============ LISTE DES CAMPAGNES ============
router.get('/', requireAuth, (req, res) => {
  const campaigns = db.prepare('SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC').all(req.user.userId);
  res.json({ campaigns });
});

// ============ CRÉER UNE CAMPAGNE ============
router.post('/', requireAuth, (req, res) => {
  const { name, template, message, channels, audience, scheduled_at } = req.body;
  const result = db.prepare(
    'INSERT INTO campaigns (user_id, name, template, message, channels, audience, status, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.userId, name, template || 'libre', message, JSON.stringify(channels || []), audience || 'all', 'draft', scheduled_at || null);

  res.json({ success: true, id: result.lastInsertRowid });
});

// ============ ENVOYER UNE CAMPAGNE ============
router.post('/:id/send', requireAuth, async (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });

  const channels = JSON.parse(campaign.channels || '[]');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  const clients = db.prepare('SELECT * FROM clients WHERE user_id = ?').all(req.user.userId);

  const results = { email: 0, sms: 0, errors: [] };

  for (const client of clients) {
    const msg = campaign.message
      .replace(/\{\{prénom\}\}/g, client.name.split(' ')[0])
      .replace(/\{\{nom\}\}/g, client.name)
      .replace(/\{\{studio\}\}/g, user.studio_name || 'notre studio')
      .replace(/\{\{lien_résa\}\}/g, `http://localhost:3000`);

    // EMAIL
    if (channels.includes('email') && client.email) {
      try {
        await sendEmail(client.email, `Message de ${user.studio_name || user.name}`, msg);
        results.email++;
      } catch (e) {
        results.errors.push(`Email ${client.email}: ${e.message}`);
      }
    }

    // SMS via Twilio
    if (channels.includes('sms') && client.phone) {
      try {
        await sendSMS(client.phone, msg);
        results.sms++;
      } catch (e) {
        results.errors.push(`SMS ${client.phone}: ${e.message}`);
      }
    }
  }

  // Mettre à jour la campagne
  db.prepare('UPDATE campaigns SET status = ?, sent_count = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('sent', results.email + results.sms, campaign.id);

  res.json({ success: true, results });
});

// ============ SUPPRIMER UNE CAMPAGNE ============
router.delete('/:id', requireAuth, (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!campaign) return res.status(404).json({ error: 'Campagne introuvable' });
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============ TEST EMAIL (sans campagne) ============
router.post('/test/email', requireAuth, async (req, res) => {
  const { to, subject, message } = req.body;
  try {
    await sendEmail(to, subject || 'Test inkr', message || 'Ceci est un test depuis inkr 🎨');
    res.json({ success: true, message: `Email envoyé à ${to}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ TEST SMS ============
router.post('/test/sms', requireAuth, async (req, res) => {
  const { to, message } = req.body;
  try {
    await sendSMS(to, message || 'Test SMS depuis inkr 🎨');
    res.json({ success: true, message: `SMS envoyé à ${to}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ HELPERS ============
async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[EMAIL SIMULÉ] À: ${to} | Sujet: ${subject} | Message: ${text}`);
    return { simulated: true };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  return resend.emails.send({
    from: process.env.EMAIL_FROM || 'inkr <onboarding@resend.dev>',
    to,
    subject,
    text,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#FF5C35;padding:20px;text-align:center;">
        <h1 style="color:white;margin:0;font-size:28px;">inkr</h1>
      </div>
      <div style="padding:30px;background:#f9f9f9;">
        <p style="font-size:16px;line-height:1.6;">${text.replace(/\n/g, '<br>')}</p>
      </div>
      <div style="padding:16px;text-align:center;color:#888;font-size:12px;">
        Envoyé via inkr · La plateforme des tatoueurs
      </div>
    </div>`
  });
}

async function sendSMS(to, message) {
  if (!process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID.startsWith('ACxx')) {
    console.log(`[SMS SIMULÉ] À: ${to} | Message: ${message}`);
    return { simulated: true };
  }
  const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return twilio.messages.create({ body: message, from: process.env.TWILIO_PHONE, to });
}

module.exports = router;
module.exports.sendEmail = sendEmail;
module.exports.sendSMS = sendSMS;
