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
  const appUrl = process.env.APP_URL || 'https://inkr-app-production.up.railway.app';

  // ── Ciblage par audience ──
  const audience = campaign.audience || 'all';
  let clients;
  if (audience === 'all') {
    clients = db.prepare('SELECT * FROM clients WHERE user_id = ?').all(req.user.userId);
  } else if (audience.startsWith('tag:')) {
    const tag = audience.replace('tag:', '').toLowerCase();
    const all = db.prepare('SELECT * FROM clients WHERE user_id = ?').all(req.user.userId);
    clients = all.filter(c => {
      try { return JSON.parse(c.tags || '[]').some(t => t.toLowerCase() === tag); }
      catch { return false; }
    });
  } else {
    clients = db.prepare('SELECT * FROM clients WHERE user_id = ?').all(req.user.userId);
  }

  const results = { email: 0, sms: 0, errors: [], audience_count: clients.length };

  for (const client of clients) {
    const prenom = (client.prenom || client.name.split(' ')[0]);
    const msg = campaign.message
      .replace(/\{\{prénom\}\}/g, prenom)
      .replace(/\{\{nom\}\}/g, client.name)
      .replace(/\{\{studio\}\}/g, user.studio_name || 'notre studio')
      .replace(/\{\{lien_résa\}\}/g, appUrl);

    // EMAIL
    if (channels.includes('email') && client.email) {
      try {
        await sendEmail(client.email, `Message de ${user.studio_name || user.name}`, msg, user, appUrl, campaign.id);
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

// ============ TRACKING OUVERTURE (pixel 1x1, pas d'auth) ============
router.get('/:id/track/open', (req, res) => {
  try {
    db.prepare('UPDATE campaigns SET open_count = open_count + 1 WHERE id = ?').run(req.params.id);
  } catch(e) {}
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache'
  });
  res.end(pixel);
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

// ============ DIAGNOSTIC EMAIL ============
router.get('/email/status', requireAuth, async (req, res) => {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'inkr <onboarding@resend.dev>';
  if (!key) return res.json({ ok: false, reason: 'RESEND_API_KEY manquant dans les variables Railway' });
  try {
    const resend = new Resend(key);
    const domains = await resend.domains.list();
    const verified = domains?.data?.filter(d => d.status === 'verified').map(d => d.name) || [];
    const usingDefault = from.includes('onboarding@resend.dev');
    res.json({
      ok: true,
      from,
      apiKey: key.slice(0,8) + '...',
      verifiedDomains: verified,
      warning: usingDefault
        ? 'Vous utilisez onboarding@resend.dev — envoi limité à votre propre email Resend. Vérifiez inkr.club pour envoyer à tous.'
        : null
    });
  } catch(e) {
    res.json({ ok: false, reason: e.message });
  }
});

// ============ HELPERS ============
async function sendEmail(to, subject, text, user = {}, appUrl = 'https://inkr-app-production.up.railway.app', campaignId = null) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`⚠️  [EMAIL] Pas de RESEND_API_KEY — email simulé vers ${to}`);
    return { simulated: true };
  }
  const from = process.env.EMAIL_FROM || 'inkr <onboarding@resend.dev>';
  console.log(`📧 [EMAIL] Envoi depuis "${from}" vers ${to} | Sujet: ${subject}`);

  const studioName = user.studio_name || user.name || '';
  const replyTo = user.email || undefined;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background:#0A0A0A;border-radius:16px 16px 0 0;padding:28px 36px;text-align:center;">
    <div style="font-size:38px;font-weight:900;letter-spacing:-1.5px;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899,#f97316);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">inkr</div>
    ${studioName ? `<div style="font-size:12px;color:rgba(255,255,255,0.35);margin-top:5px;letter-spacing:1px;text-transform:uppercase;">${studioName}</div>` : ''}
  </td></tr>
  <tr><td style="background:#ffffff;padding:40px 36px;">
    <p style="font-size:16px;line-height:1.85;color:#1a1a1a;margin:0 0 0 0;">${text.replace(/\n/g, '<br/>')}</p>
  </td></tr>
  <tr><td style="background:#ffffff;padding:0 36px 32px;text-align:center;">
    <a href="${appUrl}/dashboard" style="display:inline-block;padding:13px 30px;background:linear-gradient(135deg,#667eea,#a855f7);color:#ffffff;border-radius:980px;font-size:14px;font-weight:700;text-decoration:none;">💬 Répondre via inkr</a>
  </td></tr>
  <tr><td style="background:#0A0A0A;border-radius:0 0 16px 16px;padding:28px 36px;">
    ${studioName ? `<div style="font-size:14px;font-weight:700;color:#ffffff;margin-bottom:10px;">${studioName}</div>` : ''}
    ${user.city ? `<div style="font-size:13px;color:rgba(255,255,255,0.4);margin-bottom:4px;">📍 &nbsp;${user.city}</div>` : ''}
    ${user.phone ? `<div style="font-size:13px;color:rgba(255,255,255,0.4);margin-bottom:4px;">📞 &nbsp;${user.phone}</div>` : ''}
    ${user.email ? `<div style="font-size:13px;margin-bottom:4px;"><a href="mailto:${user.email}" style="color:rgba(255,255,255,0.4);text-decoration:none;">✉️ &nbsp;${user.email}</a></div>` : ''}
    <div style="margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.07);font-size:11px;color:rgba(255,255,255,0.2);">
      Envoyé via <a href="https://inkr.club" style="color:rgba(255,255,255,0.3);text-decoration:none;">inkr</a> · La plateforme des tatoueurs
    </div>
  </td></tr>
</table>
${campaignId ? `<img src="${appUrl}/api/campaigns/${campaignId}/track/open" width="1" height="1" style="display:none;border:0;" alt=""/>` : ''}
</td></tr>
</table>
</body></html>`;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const payload = { from, to, subject, text, html };
  if (replyTo) payload.replyTo = replyTo;

  const result = await resend.emails.send(payload);
  if (result.error) {
    console.error(`❌ [EMAIL] Erreur Resend:`, result.error);
    throw new Error(result.error.message || 'Erreur Resend inconnue');
  }
  console.log(`✅ [EMAIL] Envoyé avec succès. ID: ${result.data?.id}`);
  return result;
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
