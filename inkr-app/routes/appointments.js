const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';
const { sendEmail, sendSMS } = require('./campaigns');

function requireAuth(req, res, next) {
  const token = req.cookies?.inkr_token;
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expirée' }); }
}

// Liste RDV artiste
router.get('/', requireAuth, (req, res) => {
  const appts = db.prepare('SELECT * FROM appointments WHERE user_id = ? ORDER BY date ASC, time ASC').all(req.user.userId);
  res.json({ appointments: appts });
});

// Créer RDV (public depuis page client OU manuel depuis dashboard)
router.post('/', async (req, res) => {
  const token = req.cookies?.inkr_token;
  let artistId = req.body.user_id || 1;
  if (token) {
    try { const decoded = jwt.verify(token, JWT_SECRET); artistId = decoded.userId; } catch(e) {}
  }
  const { client_name, client_email, client_phone, style, body_zone, size, description, date, time, price, status } = req.body;

  const result = db.prepare(
    'INSERT INTO appointments (user_id, client_name, client_email, client_phone, style, body_zone, size, description, date, time, price, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(artistId, client_name||'', client_email||'', client_phone||'', style||'', body_zone||'', size||'', description||'', date||'', time||'', price||null, status||'pending');

  if (client_email && status !== 'manual') {
    try {
      await sendEmail(client_email, '✅ Demande de RDV reçue — inkr',
        `Bonjour ${client_name} !\n\nVotre demande a bien été reçue.\nDétails : ${style} · ${body_zone} · ${size}\n\nL'artiste vous contactera dans les 24h.\n\nRéférence : #INK-${result.lastInsertRowid} 🎨`);
    } catch(e) { console.log('Email err:', e.message); }
  }

  res.json({ success: true, id: result.lastInsertRowid });
});

// Modifier statut / prix / date
router.put('/:id', requireAuth, (req, res) => {
  const { status, date, time, price, acompte_amount, acompte_status, acompte_stripe_url } = req.body;
  db.prepare('UPDATE appointments SET status=?, date=?, time=?, price=?, acompte_amount=?, acompte_status=?, acompte_stripe_url=? WHERE id=? AND user_id=?')
    .run(status, date, time, price||null, acompte_amount||0, acompte_status||'none', acompte_stripe_url||'', req.params.id, req.user.userId);
  res.json({ success: true });
});

// Demander un acompte (génère un lien Stripe ou simule)
router.post('/:id/acompte', requireAuth, async (req, res) => {
  const { amount } = req.body;
  const appt = db.prepare('SELECT * FROM appointments WHERE id=? AND user_id=?').get(req.params.id, req.user.userId);
  if (!appt) return res.status(404).json({ error: 'RDV introuvable' });

  // En production : Stripe Payment Links API
  // const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  // const link = await stripe.paymentLinks.create({...});
  const simulatedUrl = `https://buy.stripe.com/test_inkr_${req.params.id}_${amount}€`;

  db.prepare('UPDATE appointments SET acompte_amount=?, acompte_status=?, acompte_stripe_url=? WHERE id=?')
    .run(amount, 'requested', simulatedUrl, req.params.id);

  if (appt.client_email) {
    try {
      await sendEmail(appt.client_email, `💳 Acompte de ${amount}€ requis — inkr`,
        `Bonjour ${appt.client_name} !\n\nVotre tatoueur demande un acompte de ${amount}€ pour confirmer votre RDV.\n\nPayez ici : ${simulatedUrl}\n\nCet acompte garantit votre créneau. 🎨`);
    } catch(e) { console.log('Acompte email err:', e.message); }
  }

  res.json({ success: true, url: simulatedUrl, amount });
});

// Supprimer RDV
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM appointments WHERE id=? AND user_id=?').run(req.params.id, req.user.userId);
  res.json({ success: true });
});

module.exports = router;
