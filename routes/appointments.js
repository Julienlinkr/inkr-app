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

  // Utilise Stripe si configuré, sinon génère un lien simulé
  try {
    // Créer la session Stripe via la logique interne
    if (!process.env.STRIPE_SECRET_KEY) {
      const fakeUrl = `/dashboard?payment=simulated&appt=${appt.id}`;
      db.prepare('UPDATE appointments SET acompte_amount=?, acompte_status=?, acompte_stripe_url=? WHERE id=?')
        .run(amount || appt.deposit || 50, 'pending', fakeUrl, appt.id);

      if (appt.client_email) {
        try {
          await sendEmail(appt.client_email, `💳 Acompte de ${amount || appt.deposit || 50}€ requis — inkr`,
            `Bonjour ${appt.client_name} !\n\nVotre tatoueur demande un acompte de ${amount || appt.deposit || 50}€ pour confirmer votre RDV.\n\nPayez ici : ${(process.env.APP_URL || 'https://inkr-app-production.up.railway.app') + fakeUrl}\n\nCet acompte garantit votre créneau. 🎨`);
        } catch(e) { console.log('Acompte email err:', e.message); }
      }

      return res.json({ url: fakeUrl, simulated: true });
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const appUrl = process.env.APP_URL || 'https://inkr-app-production.up.railway.app';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Acompte tatouage — ${appt.client_name || 'Client'}`,
            description: `RDV le ${appt.date || 'date à confirmer'} — ${appt.style || 'tatouage'}`,
          },
          unit_amount: Math.round(parseFloat(amount || appt.deposit || 50) * 100),
        },
        quantity: 1,
      }],
      customer_email: appt.client_email || undefined,
      success_url: `${appUrl}/api/payments/success?session_id={CHECKOUT_SESSION_ID}&appt=${appt.id}`,
      cancel_url: `${appUrl}/api/payments/cancel?appt=${appt.id}`,
      metadata: { appointment_id: String(appt.id), artist_id: String(req.user.userId) },
    });

    db.prepare('UPDATE appointments SET acompte_amount=?, acompte_status=?, acompte_stripe_url=? WHERE id=?')
      .run(amount || appt.deposit || 50, 'pending', session.url, appt.id);

    // Email avec le vrai lien Stripe
    if (appt.client_email) {
      try {
        await sendEmail(appt.client_email, `💳 Acompte de ${amount || appt.deposit || 50}€ requis — inkr`,
          `Bonjour ${appt.client_name} !\n\nVotre tatoueur demande un acompte de ${amount || appt.deposit || 50}€ pour confirmer votre RDV.\n\nPayez ici : ${session.url}\n\nCet acompte garantit votre créneau. 🎨`);
      } catch(e) { console.log('Acompte email err:', e.message); }
    }

    return res.json({ url: session.url, session_id: session.id });
  } catch(stripeErr) {
    console.error('[Stripe acompte]', stripeErr.message);
    return res.status(500).json({ error: stripeErr.message });
  }
});

// Supprimer RDV
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM appointments WHERE id=? AND user_id=?').run(req.params.id, req.user.userId);
  res.json({ success: true });
});

module.exports = router;
