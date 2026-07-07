/**
 * routes/artist_photos.js
 *
 * Galerie photo des artistes inkr — DA similaire à Instagram.
 *
 * ─── Pour les développeurs ──────────────────────────────────────────────────
 *  Les artistes inkr Pro peuvent uploader leurs propres photos de tatouage
 *  directement depuis leur dashboard. Ces photos s'affichent sur leur fiche
 *  publique dans une grille carrée 3 colonnes (même DA qu'Instagram).
 *
 *  Stockage : fichiers dans public/uploads/artist-photos/
 *  Table SQLite : artist_photos
 *
 *  Lien tatoueur public ↔ artiste inkr Pro : par handle Instagram
 *  (les deux partagent le même @handle)
 *
 *  Routes publiques (sans auth) :
 *    GET  /api/artist-photos/by-instagram/:handle
 *      → Photos d'un artiste trouvé par son @instagram (pour la fiche publique)
 *    GET  /api/artist-photos/user/:userId
 *      → Photos par user_id direct
 *
 *  Routes privées (artiste connecté) :
 *    GET    /api/artist-photos/me         → Mes photos
 *    POST   /api/artist-photos/upload     → Uploader une photo (multipart)
 *    PUT    /api/artist-photos/:id        → Modifier la légende
 *    DELETE /api/artist-photos/:id        → Supprimer
 *
 *  Multer : max 10 MB par fichier, formats jpg/png/webp/gif acceptés.
 *  Les fichiers sont stockés dans public/uploads/artist-photos/ (servis en statique).
 * ────────────────────────────────────────────────────────────────────────────
 */

const express   = require('express');
const router    = express.Router();
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const jwt       = require('jsonwebtoken');
const { db }    = require('../db/database');

const JWT_SECRET  = process.env.JWT_SECRET || 'inkr_secret_dev';
const UPLOAD_DIR  = path.join(__dirname, '..', 'public', 'uploads', 'artist-photos');
const UPLOAD_URL  = '/uploads/artist-photos';

// S'assurer que le dossier d'upload existe
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Création de la table ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS artist_photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    filename    TEXT    NOT NULL,
    caption     TEXT    DEFAULT '',
    sort_order  INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

// ── Middleware auth artiste (inkr Pro) ────────────────────────────────────────
function requireArtistAuth(req, res, next) {
  const token = req.cookies?.inkr_token;
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}

// ── Multer — stockage local ────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|jpg|png|webp|gif)/.test(file.mimetype);
    cb(ok ? null : new Error('Format non supporté (jpg, png, webp, gif uniquement)'), ok);
  },
});

// ── Helper : transformer une ligne DB en objet public ────────────────────────
function toPublic(p) {
  return {
    id:         p.id,
    user_id:    p.user_id,
    caption:    p.caption || '',
    sort_order: p.sort_order || 0,
    created_at: p.created_at,
    url:        `${UPLOAD_URL}/${p.filename}`,
  };
}

// ── GET /api/artist-photos/by-instagram/:handle ──────────────────────────────
// Route publique — utilisée par la fiche artiste (index.html) pour afficher
// les photos inkr en priorité sur la grille portfolio.
router.get('/by-instagram/:handle', (req, res) => {
  try {
    const handle = (req.params.handle || '').replace(/^@/, '').toLowerCase().trim();
    if (!handle) return res.json([]);

    // Trouver l'artiste inkr Pro par son instagram
    const user = db.prepare(
      "SELECT id FROM users WHERE LOWER(REPLACE(instagram,'@','')) = ?"
    ).get(handle);

    if (!user) return res.json([]); // Pas encore sur inkr Pro

    const photos = db.prepare(
      'SELECT * FROM artist_photos WHERE user_id=? ORDER BY sort_order ASC, created_at DESC'
    ).all(user.id);

    res.json(photos.map(toPublic));
  } catch (e) {
    console.error('[artist-photos/by-instagram]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/artist-photos/user/:userId ──────────────────────────────────────
router.get('/user/:userId', (req, res) => {
  try {
    const photos = db.prepare(
      'SELECT * FROM artist_photos WHERE user_id=? ORDER BY sort_order ASC, created_at DESC'
    ).all(parseInt(req.params.userId));
    res.json(photos.map(toPublic));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/artist-photos/me ─────────────────────────────────────────────────
router.get('/me', requireArtistAuth, (req, res) => {
  try {
    const photos = db.prepare(
      'SELECT * FROM artist_photos WHERE user_id=? ORDER BY sort_order ASC, created_at DESC'
    ).all(req.userId);
    res.json(photos.map(toPublic));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/artist-photos/upload ───────────────────────────────────────────
// Limite : 10 photos max pour les comptes gratuits (is_pro=0)
//          Illimité pour les comptes inkr Pro (is_pro=1)
const FREE_PHOTO_LIMIT = 10;
router.post('/upload', requireArtistAuth, upload.single('photo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

    // Vérifier la limite pour les comptes gratuits
    const user = db.prepare('SELECT is_pro FROM users WHERE id=?').get(req.userId);
    if (!user?.is_pro) {
      const count = db.prepare('SELECT COUNT(*) as n FROM artist_photos WHERE user_id=?').get(req.userId)?.n || 0;
      if (count >= FREE_PHOTO_LIMIT) {
        // Supprimer le fichier uploadé (on a quand même laissé multer le stocker)
        try { require('fs').unlinkSync(require('path').join(UPLOAD_DIR, req.file.filename)); } catch(_) {}
        return res.status(403).json({
          error: `Limite de ${FREE_PHOTO_LIMIT} photos atteinte. Passe en inkr Pro pour en ajouter plus !`,
          limit_reached: true,
        });
      }
    }

    const caption = (req.body.caption || '').trim();
    const result = db.prepare(
      'INSERT INTO artist_photos (user_id, filename, caption) VALUES (?,?,?)'
    ).run(req.userId, req.file.filename, caption);
    res.json({ ok: true, photo: toPublic({ id: result.lastInsertRowid, user_id: req.userId, filename: req.file.filename, caption, sort_order: 0, created_at: new Date().toISOString() }) });
  } catch (e) {
    console.error('[artist-photos/upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/artist-photos/:id — modifier la légende ─────────────────────────
router.put('/:id', requireArtistAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const photo = db.prepare('SELECT * FROM artist_photos WHERE id=? AND user_id=?').get(id, req.userId);
    if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
    const caption = (req.body.caption || '').trim();
    db.prepare('UPDATE artist_photos SET caption=? WHERE id=?').run(caption, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/artist-photos/:id ────────────────────────────────────────────
router.delete('/:id', requireArtistAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const photo = db.prepare('SELECT * FROM artist_photos WHERE id=? AND user_id=?').get(id, req.userId);
    if (!photo) return res.status(404).json({ error: 'Photo introuvable' });

    // Supprimer le fichier physique
    const filePath = path.join(UPLOAD_DIR, photo.filename);
    try { fs.unlinkSync(filePath); } catch (_) { /* fichier déjà supprimé */ }

    db.prepare('DELETE FROM artist_photos WHERE id=?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
