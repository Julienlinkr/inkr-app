const express = require('express');
const router  = express.Router();
const { db }  = require('../db/database');

// ── Migration : ajout des colonnes optionnelles si elles n'existent pas encore ─
// SQLite ne supporte pas IF NOT EXISTS sur ALTER TABLE → try/catch
['auto_reply TEXT DEFAULT \'\'', 'bio TEXT DEFAULT \'\'', 'telephone TEXT DEFAULT \'\'',
 'email TEXT DEFAULT \'\'', 'site_web TEXT DEFAULT \'\'', 'adresse TEXT DEFAULT \'\'',
 'cp TEXT DEFAULT \'\'', 'horaires TEXT DEFAULT \'\'', 'dispo_flash INTEGER DEFAULT 0',
 'user_id INTEGER DEFAULT NULL', 'studio_nom TEXT DEFAULT \'\'',
 'ig_followers INTEGER DEFAULT NULL'].forEach(col => {
  try { db.exec(`ALTER TABLE tatoueurs ADD COLUMN ${col}`); } catch(_) {}
});

// ── Table de tracking des vues de profil ─────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS profile_views (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    viewer_ip   TEXT DEFAULT NULL,
    visited_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

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
    instagram:        t.instagram || '',
    instagram_handle: ((t.instagram_handle || t.instagram || '').replace(/^@/,'').replace(/.*instagram\.com\//i,'').replace(/[/?#].*/,'').trim()),
    facebook:         t.facebook || '',
    telephone:        t.telephone || '',
    email:            t.email || '',
    site_web:         t.site_web || '',
    bio:              t.bio || '',
    avail:            true,
    source:           t.source || 'import',
    auto_reply:       t.auto_reply || '',
    horaires:         t.horaires || '',
    dispo_flash:      t.dispo_flash ? true : false,
    user_id:          t.user_id || null,
    claimed:          t.claimed === 1 || !!t.user_id,
    dept:             (t.cp || '').slice(0,2),
    studio_nom:       t.studio_nom || '',
    ig_followers:     t.ig_followers || null,
  };
}

// ─── Table avis ───────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS tatoueur_reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tatoueur_id  INTEGER NOT NULL,
  author_name  TEXT NOT NULL DEFAULT 'Anonyme',
  rating       INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment      TEXT DEFAULT '',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ─── GET /api/annuaire ─────────────────────────────────────────
// Params: ?ville=Paris&style=fineline&q=sofia&dept=75&min_rating=4&has_ig=1&limit=50&offset=0
router.get('/', (req, res) => {
  try {
    const { ville, style, q, dept, min_rating, has_ig, claimed, limit=50, offset=0 } = req.query;
    let sql  = "SELECT t.*, COALESCE(r.avg_rating,0) as avg_rating, COALESCE(r.nb_reviews,0) as nb_reviews FROM tatoueurs t LEFT JOIN (SELECT tatoueur_id, ROUND(AVG(rating),1) as avg_rating, COUNT(*) as nb_reviews FROM tatoueur_reviews GROUP BY tatoueur_id) r ON r.tatoueur_id=t.id WHERE t.statut='active'";

    // Exclure les enregistrements sans nom réel (noms numériques courts)
    sql += " AND LENGTH(TRIM(t.nom)) > 1 AND TRIM(t.nom) != '0'";

    const params = [];

    if (ville) {
      const vn = `%${norm(ville)}%`;
      sql += " AND (LOWER(t.ville) LIKE ? OR LOWER(t.cp) LIKE ? OR t.ville LIKE ? OR t.cp LIKE ?)";
      params.push(vn, vn, `%${ville}%`, `%${ville}%`);
    }
    if (dept) {
      sql += " AND (t.cp LIKE ? OR t.cp LIKE ?)";
      params.push(`${dept}%`, `0${dept}%`);
    }
    if (style) {
      const styleNorm = norm(style).replace(/[\s\-]+/g, '');
      sql += " AND REPLACE(REPLACE(LOWER(t.styles), ' ', ''), '-', '') LIKE ?";
      params.push(`%${styleNorm}%`);
    }
    if (q) {
      const lq = `%${norm(q)}%`;
      // Recherche élargie : nom, ville, adresse, instagram, studio
      sql += " AND (LOWER(t.nom) LIKE ? OR LOWER(t.nom_commercial) LIKE ? OR LOWER(t.ville) LIKE ? OR LOWER(t.adresse) LIKE ? OR LOWER(t.instagram) LIKE ? OR LOWER(t.instagram_handle) LIKE ? OR LOWER(t.studio_nom) LIKE ?)";
      params.push(lq, lq, lq, lq, lq, lq, lq);
    }
    if (has_ig === '1') {
      sql += " AND t.instagram_handle != '' AND t.instagram_handle IS NOT NULL";
    }
    if (req.query.dispo_flash === '1') {
      sql += " AND t.dispo_flash = 1";
    }
    const { min_followers } = req.query;
    if (min_followers) {
      sql += " AND t.ig_followers >= ?";
      params.push(parseInt(min_followers));
    }
    if (min_rating) {
      sql += " AND COALESCE(r.avg_rating,0) >= ?";
      params.push(parseFloat(min_rating));
    }
    if (claimed === '1') sql += " AND (t.claimed=1 OR t.user_id IS NOT NULL)";
    if (claimed === '0') sql += " AND t.claimed=0 AND t.user_id IS NULL";

    // Tri : vérifiés + avis + Instagram en premier
    sql += " ORDER BY (CASE WHEN t.user_id IS NOT NULL THEN 0 ELSE 1 END), COALESCE(r.nb_reviews,0) DESC, (CASE WHEN t.instagram_handle!='' AND t.instagram_handle IS NOT NULL THEN 0 ELSE 1 END), t.ville ASC, t.nom ASC";
    sql += " LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const rows = db.prepare(sql).all(...params);

    // Count total
    let cntSql = sql.replace(/SELECT t\.\*.*?WHERE/, 'SELECT COUNT(*) as cnt FROM tatoueurs t LEFT JOIN (SELECT tatoueur_id, ROUND(AVG(rating),1) as avg_rating, COUNT(*) as nb_reviews FROM tatoueur_reviews GROUP BY tatoueur_id) r ON r.tatoueur_id=t.id WHERE').replace(/ORDER BY.*$/s, '').replace(/LIMIT.*$/s, '');
    const cntParams = params.slice(0, params.length - 2);
    let total = 0;
    try { total = db.prepare(cntSql).get(...cntParams)?.cnt || 0; } catch(e) { total = rows.length; }

    res.json({ total, limit: parseInt(limit), offset: parseInt(offset), artists: rows.map(r => ({...toFront(r), avg_rating: r.avg_rating || 0, nb_reviews: r.nb_reviews || 0})) });
  } catch(e) {
    console.error('GET /api/annuaire error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/annuaire/:id/review ────────────────────────────
router.post('/:id/review', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { author_name, rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Note 1-5 requise' });
    const t = db.prepare("SELECT id FROM tatoueurs WHERE id=? AND statut='active'").get(id);
    if (!t) return res.status(404).json({ error: 'Tatoueur introuvable' });
    db.prepare("INSERT INTO tatoueur_reviews (tatoueur_id, author_name, rating, comment) VALUES (?,?,?,?)")
      .run(id, (author_name||'Anonyme').slice(0,60), parseInt(rating), (comment||'').slice(0,500));
    const avg = db.prepare("SELECT ROUND(AVG(rating),1) as avg, COUNT(*) as n FROM tatoueur_reviews WHERE tatoueur_id=?").get(id);
    res.json({ success: true, avg_rating: avg.avg, nb_reviews: avg.n });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/annuaire/:id/reviews ────────────────────────────
router.get('/:id/reviews', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const reviews = db.prepare("SELECT * FROM tatoueur_reviews WHERE tatoueur_id=? ORDER BY created_at DESC LIMIT 20").all(id);
    const avg = db.prepare("SELECT ROUND(AVG(rating),1) as avg, COUNT(*) as n FROM tatoueur_reviews WHERE tatoueur_id=?").get(id);
    res.json({ reviews, avg_rating: avg.avg || 0, nb_reviews: avg.n || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/annuaire/map ─────────────────────────────────────────────────
// Endpoint léger pour la carte : uniquement les champs nécessaires aux marqueurs
// Retourne TOUS les tatoueurs géocodés (lat != 0) en une seule requête
router.get('/map', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, nom, nom_commercial, ville, lat, lng, styles, instagram_handle, instagram, cp
      FROM tatoueurs
      WHERE statut='active'
        AND lat IS NOT NULL AND lat != 0
        AND lng IS NOT NULL AND lng != 0
        AND LENGTH(TRIM(nom)) > 1 AND TRIM(nom) != '0'
      ORDER BY id
    `).all();

    const artists = rows.map(t => {
      let styles = [];
      try { styles = JSON.parse(t.styles || '[]'); } catch(e) {}
      const nom = t.nom_commercial || t.nom;
      const igHandle = t.instagram_handle || (t.instagram || '').replace(/.*instagram\.com\//i,'').replace(/[/?#].*/,'').trim();
      return {
        id: t.id,
        name: nom,
        city: t.ville || '',
        lat: t.lat,
        lng: t.lng,
        style: styles,
        sk: styles.map(s => s.toLowerCase().replace(/[\s\-]+/g,'-').replace(/[^a-z0-9\-]/g,'')),
        instagram_handle: igHandle,
        cp: t.cp || '',
      };
    });

    res.json({ total: artists.length, artists });
  } catch(e) {
    console.error('GET /api/annuaire/map error:', e);
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

    // ── Tracking vue de profil ─────────────────────────────────────────────
    // Si la fiche est liée à un compte artiste inkr, on enregistre la visite.
    // IP anonymisée (3 octets seulement) pour la vie privée.
    if (t.user_id) {
      try {
        const rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
        const anonIp = rawIp.split('.').slice(0, 3).join('.') + '.x'; // ex: 92.184.97.x
        db.prepare('INSERT INTO profile_views (user_id, viewer_ip) VALUES (?, ?)').run(t.user_id, anonIp);
      } catch(_) {} // non bloquant
    }

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
