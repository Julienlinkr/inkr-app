/**
 * routes/loyalty.js
 *
 * Programme de fidélité inkr — points par séance, paliers, récompenses.
 *
 * ─── Pour les développeurs ────────────────────────────────────────────────
 * Système de paliers :
 *   Bronze  → 0–199 pts   → 5% réduction
 *   Silver  → 200–499 pts → 10% réduction
 *   Gold    → 500+ pts    → 15% + flash offert/an
 *
 * Attribution automatique : 1 point par euro dépensé (configurable)
 * Déclencheurs manuels : bonus anniversaire, parrainage, etc.
 *
 * Routes :
 *   GET  /                   → Tous les clients + leurs points (vue dashboard)
 *   GET  /:client_id         → Solde + historique d'un client
 *   POST /:client_id/award   → Attribuer des points manuellement
 *   POST /:client_id/redeem  → Utiliser des points (récompense)
 *   POST /auto-award         → Appelé quand RDV → 'completed' (points auto)
 * ──────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';

// ─── Middleware auth ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
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

// ─── Définition des paliers de fidélité ─────────────────────────────────────
// Chaque palier définit le seuil minimum de points, le nom et les avantages.
const TIERS = [
  {
    name: 'Gold',
    min: 500,
    discount: 15,
    perks: '15% de réduction + 1 flash offert par an',
    color: '#FFD700',
  },
  {
    name: 'Silver',
    min: 200,
    discount: 10,
    perks: '10% de réduction',
    color: '#C0C0C0',
  },
  {
    name: 'Bronze',
    min: 0,
    discount: 5,
    perks: '5% de réduction',
    color: '#CD7F32',
  },
];

// Retourne le palier correspondant à un total de points
function getTier(totalPoints) {
  for (const tier of TIERS) {
    if (totalPoints >= tier.min) return tier;
  }
  return TIERS[TIERS.length - 1]; // Bronze par défaut
}

// ─── GET / ───────────────────────────────────────────────────────────────────
// Retourne tous les clients avec leur total de points et leur palier.
// Vue principale du tableau de bord fidélité.
router.get('/', requireAuth, (req, res) => {
  try {
    // Jointure LEFT pour inclure les clients sans points (total = 0)
    const clients = db.prepare(`
      SELECT
        c.id,
        c.name,
        c.prenom,
        c.email,
        COALESCE(SUM(lp.points), 0) AS total_points
      FROM clients c
      LEFT JOIN loyalty_points lp ON lp.client_id = c.id AND lp.artist_id = ?
      WHERE c.user_id = ?
      GROUP BY c.id
      ORDER BY total_points DESC, c.name ASC
    `).all(req.user.userId, req.user.userId);

    // Calculer le palier pour chaque client
    const clientsWithTier = clients.map(c => ({
      ...c,
      tier: getTier(c.total_points).name,
    }));

    res.json({ clients: clientsWithTier });
  } catch (err) {
    console.error('[Loyalty GET /]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /:client_id ──────────────────────────────────────────────────────────
// Retourne le solde, l'historique et les infos de palier d'un client.
router.get('/:client_id', requireAuth, (req, res) => {
  try {
    // Vérifier que le client appartient bien à cet artiste
    const client = db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?')
      .get(req.params.client_id, req.user.userId);
    if (!client) return res.status(404).json({ error: 'Client introuvable' });

    // Calcul du total de points
    const totRow = db.prepare(
      'SELECT COALESCE(SUM(points), 0) AS total FROM loyalty_points WHERE client_id = ? AND artist_id = ?'
    ).get(req.params.client_id, req.user.userId);
    const totalPoints = totRow.total;

    // Historique des transactions de points (les plus récentes en premier)
    const history = db.prepare(
      'SELECT * FROM loyalty_points WHERE client_id = ? AND artist_id = ? ORDER BY created_at DESC'
    ).all(req.params.client_id, req.user.userId);

    const currentTier = getTier(totalPoints);

    res.json({
      client_id: client.id,
      client_name: [client.prenom, client.name].filter(Boolean).join(' '),
      total_points: totalPoints,
      tier: currentTier.name,
      // Détail de tous les paliers pour affichage de la progression
      tiers: TIERS.map(t => ({
        name: t.name,
        min: t.min,
        discount: t.discount,
        perks: t.perks,
        color: t.color,
        active: t.name === currentTier.name,
        // Points restants avant d'atteindre ce palier (0 si déjà atteint)
        points_needed: Math.max(0, t.min - totalPoints),
      })),
      history,
    });
  } catch (err) {
    console.error('[Loyalty GET /:client_id]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /:client_id/award ───────────────────────────────────────────────────
// Attribuer des points manuellement à un client.
// Cas d'usage : bonus anniversaire, parrainage, geste commercial...
// Body : { points, reason, appointment_id? }
router.post('/:client_id/award', requireAuth, (req, res) => {
  try {
    const { points, reason, appointment_id } = req.body;

    if (!points || isNaN(parseInt(points)) || parseInt(points) <= 0) {
      return res.status(400).json({ error: 'Le nombre de points doit être un entier positif' });
    }

    // Vérification d'appartenance du client
    const client = db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?')
      .get(req.params.client_id, req.user.userId);
    if (!client) return res.status(404).json({ error: 'Client introuvable' });

    db.prepare(
      'INSERT INTO loyalty_points (client_id, artist_id, points, reason, appointment_id) VALUES (?, ?, ?, ?, ?)'
    ).run(
      req.params.client_id,
      req.user.userId,
      parseInt(points),
      reason || 'Attribution manuelle',
      appointment_id || null
    );

    // Recalcul du total après attribution
    const totRow = db.prepare(
      'SELECT COALESCE(SUM(points), 0) AS total FROM loyalty_points WHERE client_id = ? AND artist_id = ?'
    ).get(req.params.client_id, req.user.userId);
    const newTotal = totRow.total;

    res.json({
      success: true,
      points_awarded: parseInt(points),
      new_total: newTotal,
      tier: getTier(newTotal).name,
    });
  } catch (err) {
    console.error('[Loyalty POST /:client_id/award]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /:client_id/redeem ──────────────────────────────────────────────────
// Utiliser des points pour une récompense (réduction, cadeau...).
// Insère une transaction négative.
// Body : { points, reason }
router.post('/:client_id/redeem', requireAuth, (req, res) => {
  try {
    const { points, reason } = req.body;

    if (!points || isNaN(parseInt(points)) || parseInt(points) <= 0) {
      return res.status(400).json({ error: 'Le nombre de points à utiliser doit être un entier positif' });
    }

    const pointsToRedeem = parseInt(points);

    // Vérification d'appartenance du client
    const client = db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?')
      .get(req.params.client_id, req.user.userId);
    if (!client) return res.status(404).json({ error: 'Client introuvable' });

    // Vérifier que le client a suffisamment de points
    const totRow = db.prepare(
      'SELECT COALESCE(SUM(points), 0) AS total FROM loyalty_points WHERE client_id = ? AND artist_id = ?'
    ).get(req.params.client_id, req.user.userId);
    const currentTotal = totRow.total;

    if (currentTotal < pointsToRedeem) {
      return res.status(400).json({
        error: `Solde insuffisant : ${currentTotal} point(s) disponible(s), ${pointsToRedeem} demandé(s)`,
        available: currentTotal,
      });
    }

    // Insertion d'une transaction négative (utilisation de points)
    db.prepare(
      'INSERT INTO loyalty_points (client_id, artist_id, points, reason) VALUES (?, ?, ?, ?)'
    ).run(
      req.params.client_id,
      req.user.userId,
      -pointsToRedeem, // Valeur négative = utilisation
      reason || 'Utilisation de points'
    );

    const newTotal = currentTotal - pointsToRedeem;

    res.json({
      success: true,
      points_redeemed: pointsToRedeem,
      new_total: newTotal,
      tier: getTier(newTotal).name,
    });
  } catch (err) {
    console.error('[Loyalty POST /:client_id/redeem]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /auto-award ─────────────────────────────────────────────────────────
// Appelé automatiquement quand un rendez-vous passe au statut 'completed'.
// Calcule et attribue les points selon le prix du RDV (1 point = 1 euro).
// Body : { appointment_id }
router.post('/auto-award', requireAuth, (req, res) => {
  try {
    const { appointment_id } = req.body;
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id requis' });

    const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?')
      .get(appointment_id, req.user.userId);
    if (!appt) return res.status(404).json({ error: 'Rendez-vous introuvable' });

    if (!appt.client_id) {
      return res.status(400).json({ error: 'Ce RDV n\'a pas de client associé (client_id manquant)' });
    }

    // Calcul des points : 1 point par euro dépensé (prix arrondi à l'entier inférieur)
    const price = parseFloat(appt.price || 0);
    const pointsToAward = Math.floor(price);

    if (pointsToAward <= 0) {
      return res.json({
        success: true,
        points_awarded: 0,
        message: 'Aucun point attribué (prix nul ou absent)',
      });
    }

    // Vérifier qu'on n'a pas déjà attribué des points pour ce RDV
    const alreadyAwarded = db.prepare(
      'SELECT id FROM loyalty_points WHERE appointment_id = ? AND artist_id = ?'
    ).get(appointment_id, req.user.userId);

    if (alreadyAwarded) {
      return res.json({
        success: false,
        message: 'Points déjà attribués pour ce rendez-vous',
      });
    }

    db.prepare(
      'INSERT INTO loyalty_points (client_id, artist_id, points, reason, appointment_id) VALUES (?, ?, ?, ?, ?)'
    ).run(
      appt.client_id,
      req.user.userId,
      pointsToAward,
      `Séance du ${appt.date || 'date inconnue'} — ${appt.style || 'tatouage'} (${price}€)`,
      appointment_id
    );

    // Total mis à jour
    const totRow = db.prepare(
      'SELECT COALESCE(SUM(points), 0) AS total FROM loyalty_points WHERE client_id = ? AND artist_id = ?'
    ).get(appt.client_id, req.user.userId);
    const newTotal = totRow.total;

    res.json({
      success: true,
      points_awarded: pointsToAward,
      new_total: newTotal,
      tier: getTier(newTotal).name,
    });
  } catch (err) {
    console.error('[Loyalty POST /auto-award]', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
