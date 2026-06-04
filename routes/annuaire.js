const express = require('express');
const router  = express.Router();
const { db }  = require('../db/database');

// ── Migration : ajout des colonnes optionnelles si elles n'existent pas encore ─
// SQLite ne supporte pas IF NOT EXISTS sur ALTER TABLE → try/catch
['auto_reply TEXT DEFAULT \'\'', 'bio TEXT DEFAULT \'\'', 'telephone TEXT DEFAULT \'\'',
 'email TEXT DEFAULT \'\'', 'site_web TEXT DEFAULT \'\'', 'adresse TEXT DEFAULT \'\'',
 'cp TEXT DEFAULT \'\'', 'horaires TEXT DEFAULT \'\'', 'dispo_flash INTEGER DEFAULT 0',
 'user_id INTEGER DEFAULT NULL'].forEach(col => {
  try { db.exec(`ALTER TABLE tatoueurs ADD COLUMN ${col}`); } catch(_) {}
});

// Normalise un texte pour la comparaison (accents → ASCII, lowercase)
function norm(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim(); }

// Table de correspondance nom affiché → slug STYLES_DATA (frontend)
// Doit rester synchronisé avec STYLES_DATA dans index.html
const STYLE_SLUG_MAP = {
  'japonais':'japonais', 'fine line':'fineline', 'fineline':'fineline',
  'realisme':'realisme', 'réalisme':'realisme',
  'geometrique':'geometrique', 'géométrique':'geometrique',
  'tribal':'tribal', 'old school':'old-school', 'old-school':'old-school',
  'aquarelle':'aquarelle', 'animaux':'animaux', 'flash':'flash',
  'blackwork':'blackwork', 'minimaliste':'minimaliste',
  'lettering':'lettering', 'chicano':'chicano', 'dotwork':'dotwork',
  'neo traditionnel':'neo-traditionnel', 'néo traditionnel':'neo-traditionnel',
};
// Dérive des "slug de style" depuis le nom du style — doit correspondre aux slugs de STYLES_DATA
function styleSlug(s) {
  const key = norm(s).replace(/[\s\-]+/g,' ').trim();
  return STYLE_SLUG_MAP[key] || norm(s).replace(/[\s\-]+/g,'-').replace(/[^a-z0-9\-]/g,'');
}

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
    auto_reply: t.auto_reply || '',
    horaires:   t.horaires || '',
    dispo_flash: t.dispo_flash ? true : false,
    user_id:    t.user_id || null,
  };
}

// ─── GET /api/annuaire ─────────────────────────────────────────
// Params: ?ville=Paris&style=fineline&q=sofia&limit=50&offset=0
// Le paramètre style accepte le slug ("fineline") ou le nom d'affichage ("Fine Line").
router.get('/', (req, res) => {
  try {
    const { ville, style, q, limit=50, offset=0 } = req.query;
    let sql  = "SELECT * FROM tatoueurs WHERE statut='active'";
    const params = [];

    if (ville) {
      // Cherche dans ville ET cp. norm() normalise accents + casse.
      // On cherche aussi sans LOWER() pour compatibilité maximale.
      const vn = `%${norm(ville)}%`;
      sql += " AND (LOWER(ville) LIKE ? OR LOWER(cp) LIKE ? OR ville LIKE ? OR cp LIKE ?)";
      params.push(vn, vn, `%${ville}%`, `%${ville}%`);
    }
    if (style) {
      // Normalise le style : supprime espaces et tirets pour comparer "fine line" ↔ "fineline" ↔ "fine-line"
      // Fonctionne que le front envoie le slug (fineline) ou le nom affiché (Fine Line).
      const styleNorm = norm(style).replace(/[\s\-]+/g, '');
      sql += " AND REPLACE(REPLACE(LOWER(styles), ' ', ''), '-', '') LIKE ?";
      params.push(`%${styleNorm}%`);
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
// Note dev : INSERT simple sans transaction pour compatibilité node:sqlite et better-sqlite3
router.post('/import', (req, res) => {
  const secret = process.env.IMPORT_SECRET || 'inkr_import_2025';
  if (req.body.secret !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const list = req.body.artists || [];
  if (!list.length) return res.status(400).json({ error: 'Aucun artiste fourni' });

  const sql = `
    INSERT INTO tatoueurs
      (nom, nom_commercial, siren, adresse, cp, ville, telephone, email, instagram, site_web, styles, bio, lat, lng, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `;

  let inserted = 0, skipped = 0, errors = 0;

  for (const a of list) {
    // Seul `nom` est obligatoire — `ville` est optionnelle (certaines sources ne la fournissent pas)
    if (!a.nom) { skipped++; continue; }
    try {
      const styles = JSON.stringify(Array.isArray(a.styles) ? a.styles : []);
      const r = db.prepare(sql).run(
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
    } catch(e) {
      console.error('Import row error:', e.message, a.nom);
      errors++;
    }
  }

  res.json({ inserted, skipped, errors, total: list.length });
});

module.exports = router;
