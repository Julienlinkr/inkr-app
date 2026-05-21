const express = require('express');
const router  = express.Router();
const { db }  = require('../db/database');

// Normalise un texte pour la comparaison (accents → ASCII, lowercase)
function norm(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim(); }

// Dérive des "slug de style" depuis le nom du style
function styleSlug(s){ return norm(s).replace(/[\s\-]+/g,'-').replace(/[^a-z0-9\-]/g,''); }

// Transforme une ligne DB en objet compatible frontend
function toFront(t){
  let styles = [];
  try { styles = JSON.parse(t.styles || '[]'); } catch(e) { styles = []; }
  const nom = t.nom_commercial || t.nom;
  const initials = nom.split(/\s+/).map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
  return {
    id:         t.id,
    name:       nom,
    city:       t.ville,
    adresse:    t.adresse || '',
    cp:         t.cp || '',
    lat:        t.lat || 0,
    lng:        t.lng || 0,
    style:      styles,
    sk:         styles.map(styleSlug),
    rating:     null,
    reviews:    0,
    price:      null,
    flash:      false,
    img:        null,
    initials,
    instagram:  t.instagram || '',
    telephone:  t.telephone || '',
    email:      t.email || '',
    site_web:   t.site_web || '',
    bio:        t.bio || '',
    avail:      true,
    source:     t.source || 'import',
  };
}

// ─── GET /api/annuaire ─────────────────────────────────────────
// Params: ?ville=Paris&style=fineline&q=sofia&limit=50&offset=0
router.get('/', (req, res) => {
  try {
    const { ville, style, q, limit=50, offset=0 } = req.query;
    let sql  = "SELECT * FROM tatoueurs WHERE statut='active'";
    const params = [];

    if (ville) {
      sql += " AND (LOWER(ville) LIKE ? OR LOWER(cp) LIKE ?)";
      params.push(`%${norm(ville)}%`, `%${norm(ville)}%`);
    }
    if (style) {
      sql += " AND LOWER(styles) LIKE ?";
      params.push(`%${norm(style)}%`);
    }
    if (q) {
      const lq = `%${norm(q)}%`;
      sql += " AND (LOWER(nom) LIKE ? OR LOWER(nom_commercial) LIKE ? OR LOWER(ville) LIKE ? OR LOWER(instagram) LIKE ?)";
      params.push(lq, lq, lq, lq);
    }

    // Tri : ceux avec Instagram en premier, puis alphabétique ville
    sql += " ORDER BY (CASE WHEN instagram!='' THEN 0 ELSE 1 END), ville ASC, nom ASC";
    sql += " LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const rows  = db.prepare(sql).all(...params);

    // Count total
    let cntSql = sql.replace(/SELECT \*/, 'SELECT COUNT(*) as cnt').replace(/ORDER BY.*$/s, '').replace(/LIMIT.*$/s, '');
    const cntParams = params.slice(0, params.length - 2);
    let total = 0;
    try { total = db.prepare(cntSql).get(...cntParams)?.cnt || 0; } catch(e) { total = rows.length; }

    res.json({ total, limit: parseInt(limit), offset: parseInt(offset), artists: rows.map(toFront) });
  } catch(e) {
    console.error('GET /api/annuaire error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/annuaire/stats ────────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    const total  = db.prepare("SELECT COUNT(*) as cnt FROM tatoueurs WHERE statut='active'").get()?.cnt || 0;
    const villes = db.prepare("SELECT COUNT(DISTINCT ville) as cnt FROM tatoueurs WHERE statut='active'").get()?.cnt || 0;
    const withIg = db.prepare("SELECT COUNT(*) as cnt FROM tatoueurs WHERE statut='active' AND instagram!=''").get()?.cnt || 0;
    res.json({ total, villes, withInstagram: withIg });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/annuaire/:id ──────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const t = db.prepare("SELECT * FROM tatoueurs WHERE id=? AND statut='active'").get(parseInt(req.params.id));
    if (!t) return res.status(404).json({ error: 'Tatoueur introuvable' });
    res.json(toFront(t));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/annuaire/import ─────────────────────────────────
// Corps : { secret, artists: [{nom, ville, instagram, ...}] }
router.post('/import', (req, res) => {
  const secret = process.env.IMPORT_SECRET || 'inkr_import_2025';
  if (req.body.secret !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const list = req.body.artists || [];
  if (!list.length) return res.status(400).json({ error: 'Aucun artiste fourni' });

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO tatoueurs
      (nom, nom_commercial, siren, adresse, cp, ville, telephone, email, instagram, site_web, styles, bio, lat, lng, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let inserted = 0, skipped = 0;
  const insertMany = db.transaction((items) => {
    for (const a of items) {
      if (!a.nom || !a.ville) { skipped++; continue; }
      const styles = Array.isArray(a.styles) ? JSON.stringify(a.styles) : (a.styles || '[]');
      const r = stmt.run(
        (a.nom||'').slice(0,200),
        (a.nom_commercial||'').slice(0,200),
        (a.siren||'').slice(0,20),
        (a.adresse||'').slice(0,300),
        (a.cp||'').slice(0,10),
        (a.ville||'').slice(0,100),
        (a.telephone||'').slice(0,30),
        (a.email||'').slice(0,200),
        (a.instagram||'').slice(0,100),
        (a.site_web||'').slice(0,300),
        styles,
        (a.bio||'').slice(0,1000),
        parseFloat(a.lat)||0,
        parseFloat(a.lng)||0,
        (a.source||'import').slice(0,50)
      );
      if (r.changes > 0) inserted++; else skipped++;
    }
  });

  try {
    insertMany(list);
    res.json({ inserted, skipped, total: list.length });
  } catch(e) {
    console.error('Import error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
