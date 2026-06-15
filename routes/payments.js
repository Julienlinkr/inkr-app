/**
 * routes/payments.js
 *
 * Gestion des acomptes de rendez-vous via Stripe Checkout.
 *
 * ─── Pour les développeurs ────────────────────────────────────────────────
 * Variables Railway requises :
 *   STRIPE_SECRET_KEY      → sk_test_... (mode test) ou sk_live_...
 *   STRIPE_PUBLISHABLE_KEY → pk_test_... ou pk_live_...
 *   STRIPE_WEBHOOK_SECRET  → whsec_... (Dashboard Stripe → Webhooks → Signing secret)
 *   APP_URL                → https://inkr-app-production.up.railway.app
 *
 * Pour tester en local :
 *   stripe listen --forward-to localhost:3000/api/payments/webhook
 *
 * Flux acompte :
 *   Dashboard → POST /api/payments/create-checkout → URL Stripe Checkout
 *   → Client paie → Stripe webhook → UPDATE appointments SET acompte_status='paid'
 *   → Email de confirmation au client
 * ──────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';

// ─── Middleware auth ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  // Accepte cookie (web) OU Bearer token (mobile)
  const authHeader = req.headers['authorization'];
  const token = req.cookies?.inkr_token ||
    (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}

// ─── Chargement paresseux de Stripe ────────────────────────────────────────
// On ne charge Stripe que si la clé est présente, pour éviter des erreurs
// au démarrage sur des environnements sans Stripe configuré.
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY manquant — ajoutez-le dans les variables Railway');
  }
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ─── POST /create-checkout ──────────────────────────────────────────────────
// Crée une session Stripe Checkout pour un acompte de rendez-vous.
// Body : { appointment_id, amount, description }
// Retourne : { url, session_id }
router.post('/create-checkout', requireAuth, async (req, res) => {
  try {
    const { appointment_id, amount, description } = req.body;

    if (!appointment_id) {
      return res.status(400).json({ error: 'appointment_id requis' });
    }

    // Vérification que le RDV appartient bien à l'artiste connecté
    const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?')
      .get(appointment_id, req.user.userId);
    if (!appt) return res.status(404).json({ error: 'Rendez-vous introuvable' });

    const finalAmount = parseFloat(amount || appt.deposit || 50);
    const appUrl = process.env.APP_URL || 'https://inkr-app-production.up.railway.app';

    // ── Mode simulation (sans Stripe configuré) ────────────────────────────
    if (!process.env.STRIPE_SECRET_KEY) {
      console.log(`[Stripe SIMULÉ] Acompte ${finalAmount}€ pour RDV #${appointment_id}`);
      const fakeUrl = `${appUrl}/dashboard?payment=simulated&appt=${appointment_id}`;
      db.prepare('UPDATE appointments SET acompte_amount=?, acompte_status=?, acompte_stripe_url=? WHERE id=?')
        .run(finalAmount, 'pending', fakeUrl, appointment_id);
      return res.json({ url: fakeUrl, session_id: null, simulated: true });
    }

    // ── Mode Stripe réel ───────────────────────────────────────────────────
    const stripe = getStripe();

    // Vérifier si le tatoueur a un compte Stripe Connect
    const artistUser = db.prepare('SELECT stripe_connect_id FROM users WHERE id = ?').get(req.user.userId);
    const connectedAccountId = artistUser?.stripe_connect_id || null;

    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: description || `Acompte tatouage — ${appt.client_name || 'Client'}`,
            description: `RDV le ${appt.date || 'date à confirmer'} — ${appt.style || 'tatouage'}`,
          },
          unit_amount: Math.round(finalAmount * 100),
        },
        quantity: 1,
      }],
      customer_email: appt.client_email || undefined,
      success_url: `${appUrl}/api/payments/success?session_id={CHECKOUT_SESSION_ID}&appt=${appointment_id}`,
      cancel_url: `${appUrl}/api/payments/cancel?appt=${appointment_id}`,
      metadata: { appointment_id: String(appointment_id), artist_id: String(req.user.userId) },
    };

    // Si le tatoueur a connecté son Stripe → l'argent va directement chez lui
    if (connectedAccountId) {
      sessionParams.payment_intent_data = {
        transfer_data: { destination: connectedAccountId },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // Persister l'URL et le statut 'pending' en base
    db.prepare('UPDATE appointments SET acompte_amount=?, acompte_status=?, acompte_stripe_url=? WHERE id=?')
      .run(finalAmount, 'pending', session.url, appointment_id);

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[Stripe create-checkout]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /success ───────────────────────────────────────────────────────────
// Stripe redirige le client ici après un paiement réussi.
// On met à jour le statut et on redirige vers le dashboard.
router.get('/success', async (req, res) => {
  try {
    const { session_id, appt } = req.query;

    if (appt) {
      // Marquer l'acompte comme payé
      db.prepare("UPDATE appointments SET acompte_status='paid' WHERE id=?").run(appt);
      console.log(`[Stripe] Acompte payé (succès redirect) — RDV #${appt}`);
    }

    res.redirect(`/dashboard?payment=success&appt=${appt || ''}`);
  } catch (err) {
    console.error('[Stripe success]', err.message);
    res.redirect('/dashboard?payment=success');
  }
});

// ─── GET /cancel ────────────────────────────────────────────────────────────
// Stripe redirige ici quand le client abandonne la page de paiement.
router.get('/cancel', (req, res) => {
  const { appt } = req.query;
  res.redirect(`/dashboard?payment=cancel&appt=${appt || ''}`);
});

// ─── GET /status/:appt_id ───────────────────────────────────────────────────
// Retourne l'état du paiement pour un rendez-vous donné.
router.get('/status/:appt_id', requireAuth, (req, res) => {
  try {
    const appt = db.prepare(
      'SELECT id, acompte_amount, acompte_status, acompte_stripe_url FROM appointments WHERE id = ? AND user_id = ?'
    ).get(req.params.appt_id, req.user.userId);

    if (!appt) return res.status(404).json({ error: 'Rendez-vous introuvable' });

    res.json({
      appointment_id: appt.id,
      acompte_amount: appt.acompte_amount,
      acompte_status: appt.acompte_status,
      acompte_stripe_url: appt.acompte_stripe_url,
    });
  } catch (err) {
    console.error('[Stripe status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /config ─────────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    configured: !!process.env.STRIPE_SECRET_KEY,
    connectConfigured: !!process.env.STRIPE_SECRET_KEY, // Account Links — pas besoin de Client ID
    paypalLink: process.env.PAYPAL_SUBSCRIPTION_LINK || null,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// STRIPE CONNECT — chaque tatoueur connecte son propre compte Stripe
// Les acomptes clients vont directement sur leur compte, sans passer par inkr.
// ══════════════════════════════════════════════════════════════════════════════

// ─── GET /connect/start ───────────────────────────────────────────────────────
// Crée un compte Stripe Express pour le tatoueur (ou réutilise l'existant)
// et génère un lien d'onboarding Stripe — pas de Client ID nécessaire.
router.get('/connect/start', requireAuth, async (req, res) => {
  const appUrl = process.env.APP_URL || 'https://inkr.club';

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.redirect(`${appUrl}/dashboard?stripe_error=STRIPE_SECRET_KEY+manquant+dans+Railway`);
  }

  try {
    const stripe  = getStripe();
    const userId  = req.user.userId;

    // Récupérer ou créer le compte Express de l'artiste
    let user = db.prepare('SELECT stripe_connect_id, email FROM users WHERE id = ?').get(userId);
    let accountId = user?.stripe_connect_id;

    if (!accountId) {
      // Créer un nouveau compte Stripe Express
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'FR',
        email: user?.email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers:     { requested: true },
        },
        business_type: 'individual',
        settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'monday' } } },
      });
      accountId = account.id;
      db.prepare('UPDATE users SET stripe_connect_id = ? WHERE id = ?').run(accountId, userId);
      console.log(`[Stripe Connect] ✅ Compte Express créé → user #${userId} → ${accountId}`);
    }

    // Générer le lien d'onboarding (valable 24h)
    const accountLink = await stripe.accountLinks.create({
      account:     accountId,
      refresh_url: `${appUrl}/api/payments/connect/start`, // si le lien expire → recommencer
      return_url:  `${appUrl}/dashboard?stripe_connected=1`,
      type:        'account_onboarding',
    });

    res.redirect(accountLink.url);
  } catch (e) {
    console.error('[Stripe Connect] Start erreur:', e.message);
    res.redirect(`${appUrl}/dashboard?stripe_error=${encodeURIComponent(e.message)}`);
  }
});

// ─── GET /connect/status ──────────────────────────────────────────────────────
router.get('/connect/status', requireAuth, (req, res) => {
  try {
    const user = db.prepare('SELECT stripe_connect_id FROM users WHERE id = ?').get(req.user.userId);
    res.json({ connected: !!user?.stripe_connect_id, account_id: user?.stripe_connect_id || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /connect ──────────────────────────────────────────────────────────
router.delete('/connect', requireAuth, (req, res) => {
  try {
    db.prepare('UPDATE users SET stripe_connect_id = NULL WHERE id = ?').run(req.user.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /subscribe ─────────────────────────────────────────────────────────
// Crée une session Stripe Checkout pour l'abonnement inkr Pro 39€/mois.
// Pas de compte requis — utilisé depuis la page /pricing.
// Body (optionnel) : { email }
// Retourne : { url } → redirect vers Stripe Checkout
router.post('/subscribe', async (req, res) => {
  try {
    const appUrl = process.env.APP_URL || 'https://inkr.club';

    // ── Mode simulation ────────────────────────────────────────────────────
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.json({
        url: `${appUrl}/dashboard?action=register&plan=pro`,
        simulated: true,
      });
    }

    const stripe = getStripe();
    const email = req.body?.email || undefined;

    // Utilise le STRIPE_PRICE_ID si configuré, sinon crée un prix inline
    let line_items;
    if (process.env.STRIPE_PRICE_ID) {
      line_items = [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }];
    } else {
      line_items = [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'inkr Pro',
            description: 'Agenda, messagerie, CRM, campagnes, documents et plus',
            images: [`${appUrl}/images/inkr_logo.png`],
          },
          unit_amount: 3900, // 39.00€
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }];
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items,
      customer_email: email,
      allow_promotion_codes: true,
      success_url: `${appUrl}/dashboard?subscribed=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/pricing?cancelled=1`,
      metadata: { plan: 'inkr_pro' },
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[Stripe subscribe]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /webhook ──────────────────────────────────────────────────────────
// Endpoint Stripe Webhook — DOIT être monté AVANT express.json() via webhookRouter
// car la vérification de signature Stripe nécessite le body brut (Buffer).
//
// Ce router séparé est exporté en tant que `webhookRouter` et monté dans server.js
// AVANT le middleware express.json().
const webhookRouter = express.Router();

webhookRouter.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  // Répondre immédiatement 200 à Stripe pour éviter les retry
  res.sendStatus(200);

  // Traitement asynchrone pour ne pas bloquer la réponse
  (async () => {
    try {
      const sig = req.headers['stripe-signature'];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!webhookSecret) {
        // Pas de secret configuré → on parse quand même pour les tests locaux
        console.warn('[Stripe webhook] STRIPE_WEBHOOK_SECRET non configuré — signature non vérifiée');
        const event = JSON.parse(req.body.toString());
        await handleStripeEvent(event);
        return;
      }

      // Vérification de la signature HMAC pour s'assurer que la requête vient bien de Stripe
      let event;
      try {
        const stripe = getStripe();
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (signErr) {
        console.error('[Stripe webhook] Signature invalide:', signErr.message);
        return; // On a déjà répondu 200 — on log juste l'erreur
      }

      await handleStripeEvent(event);
    } catch (err) {
      console.error('[Stripe webhook] Erreur non gérée:', err.message);
    }
  })();
});

// ─── Gestionnaire d'événements Stripe ──────────────────────────────────────
async function handleStripeEvent(event) {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const appointmentId = session.metadata?.appointment_id;

    if (!appointmentId) {
      console.warn('[Stripe webhook] checkout.session.completed sans appointment_id dans metadata');
      return;
    }

    // Mettre à jour le statut de l'acompte en base
    db.prepare("UPDATE appointments SET acompte_status='paid' WHERE id=?").run(appointmentId);
    console.log(`[Stripe webhook] Acompte payé — RDV #${appointmentId}`);

    // Envoyer un email de confirmation au client
    const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(appointmentId);
    if (appt?.client_email) {
      try {
        const { sendEmail } = require('./campaigns');
        const appUrl = process.env.APP_URL || 'https://inkr-app-production.up.railway.app';
        const amount = appt.acompte_amount || session.amount_total / 100;
        await sendEmail(
          appt.client_email,
          '✅ Acompte reçu — votre RDV est confirmé !',
          `Bonjour ${appt.client_name || 'cher client'} !\n\nNous avons bien reçu votre acompte de ${amount}€. Votre rendez-vous est maintenant confirmé.\n\nDétails : ${appt.style || 'tatouage'} · ${appt.date || 'date à confirmer'} à ${appt.time || ''}\n\nÀ très bientôt ! 🎨`,
          {},
          appUrl
        );
      } catch (emailErr) {
        console.warn('[Stripe webhook] Email confirmation non envoyé:', emailErr.message);
      }
    }
  }
  // D'autres événements peuvent être gérés ici (payment_intent.payment_failed, etc.)
}

module.exports = router;
module.exports.webhookRouter = webhookRouter;
