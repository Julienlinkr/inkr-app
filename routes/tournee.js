const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';

function requireAuth(req, res, next) {
  const token = req.cookies?.inkr_token;
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expirée' }); }
}

// Liste des tournées de l'artiste
router.get('/', requireAuth, (req, res) => {
  const dates = db.prepare('SELECT * FROM tournee_dates WHERE user_id = ? ORDER BY date_from ASC').all(req.user.userId);
  res.json({ dates });
});

// Tournées publiques d'un artiste (pour la page publique)
router.get('/artist/:id', (req, res) => {
  const dates = db.prepare('SELECT * FROM tournee_dates WHERE user_id = ? AND active = 1 AND date_to >= date("now") ORDER BY date_from ASC').all(req.params.id);
  res.json({ dates });
});

// Tournées dans une ville (pour le filtre page principale)
router.get('/city/:city', (req, res) => {
  const dates = db.prepare(`
    SELECT t.*, u.name as artist_name, u.studio_name, u.avatar_seed
    FROM tournee_dates t
    JOIN users u ON t.user_id = u.id
    WHERE t.city LIKE ? AND t.active = 1 AND t.date_to >= date("now")
    ORDER BY t.date_from ASC
  `).all('%' + req.params.city + '%');
  res.json({ dates });
});

// Ajouter une date de tournée
router.post('/', requireAuth, (req, res) => {
  const { city, date_from, date_to, description, spots } = req.body;
  if (!city || !date_from || !date_to) {
    return res.status(400).json({ error: 'Ville et dates requises' });
  }
  const result = db.prepare(
    'INSERT INTO tournee_dates (user_id, city, date_from, date_to, description, spots) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.userId, city, date_from, date_to, description || '', spots || 5);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Modifier une date
router.put('/:id', requireAuth, (req, res) => {
  const { active, description, spots } = req.body;
  db.prepare('UPDATE tournee_dates SET active=?, description=?, spots=? WHERE id=? AND user_id=?')
    .run(active ? 1 : 0, description || '', spots || 5, req.params.id, req.user.userId);
  res.json({ success: true });
});

// Supprimer une date
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM tournee_dates WHERE id = ? AND user_id = ?').run(req.params.id, req.user.userId);
  res.json({ success: true });
});

module.exports = router;
