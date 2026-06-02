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

// Liste clients
router.get('/', requireAuth, (req, res) => {
  const clients = db.prepare('SELECT * FROM clients WHERE user_id = ? ORDER BY created_at DESC').all(req.user.userId);
  res.json({ clients });
});

// Créer client
router.post('/', requireAuth, (req, res) => {
  const { name, prenom, email, phone, city, notes, tags, age, date_naissance, photo_url, instagram, whatsapp } = req.body;
  const result = db.prepare(
    'INSERT INTO clients (user_id, name, prenom, email, phone, city, notes, tags, age, date_naissance, photo_url, instagram, whatsapp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.userId, name||'', prenom||'', email||'', phone||'', city||'', notes||'', JSON.stringify(tags||[]), age||0, date_naissance||'', photo_url||'', instagram||'', whatsapp||'');
  res.json({ success: true, id: result.lastInsertRowid });
});

// Modifier client
router.put('/:id', requireAuth, (req, res) => {
  const { name, prenom, email, phone, city, notes, tags, age, date_naissance, photo_url, instagram, whatsapp } = req.body;
  db.prepare('UPDATE clients SET name=?, prenom=?, email=?, phone=?, city=?, notes=?, tags=?, age=?, date_naissance=?, photo_url=?, instagram=?, whatsapp=? WHERE id=? AND user_id=?')
    .run(name||'', prenom||'', email||'', phone||'', city||'', notes||'', JSON.stringify(tags||[]), age||0, date_naissance||'', photo_url||'', instagram||'', whatsapp||'', req.params.id, req.user.userId);
  res.json({ success: true });
});

// Supprimer client
router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ? AND user_id = ?').run(req.params.id, req.user.userId);
  res.json({ success: true });
});

// Automations d'un user
router.get('/automations', requireAuth, (req, res) => {
  const automations = db.prepare('SELECT * FROM automations WHERE user_id = ?').all(req.user.userId);
  res.json({ automations });
});

// Activer/désactiver + modifier message automation
router.put('/automations/:id', requireAuth, (req, res) => {
  const { enabled, message } = req.body;
  db.prepare('UPDATE automations SET enabled=?, message=? WHERE id=? AND user_id=?')
    .run(enabled ? 1 : 0, message||'', req.params.id, req.user.userId);
  res.json({ success: true });
});

// ============ ENVOYER EMAIL À UN CLIENT ============
router.post('/:id/email', requireAuth, async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  if (!client.email) return res.status(400).json({ error: 'Ce client n\'a pas d\'email' });

  const { subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'Sujet et message obligatoires' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  const prenom = client.name.split(' ')[0];
  const msg = message
    .replace(/\{\{prénom\}\}/g, prenom)
    .replace(/\{\{nom\}\}/g, client.name)
    .replace(/\{\{studio\}\}/g, user.studio_name || 'notre studio');

  try {
    const { sendEmail } = require('./campaigns');
    await sendEmail(client.email, subject, msg);

    // Logger dans messages
    db.prepare('INSERT INTO messages (user_id, client_name, client_seed, channel, direction, content) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.userId, client.name, client.name.toLowerCase().replace(/\s/g,''), 'email', 'out', `[${subject}] ${msg}`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
