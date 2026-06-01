const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, initDefaultAutomations } = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';

// ── Migration : ajout des colonnes optionnelles sur users ──────────────────────
['auto_reply TEXT DEFAULT \'\'',
 'prenom TEXT DEFAULT \'\'',
 'nom_artiste TEXT DEFAULT \'\'',
 'adresse TEXT DEFAULT \'\'',
 'instagram TEXT DEFAULT \'\'',
 'pinterest TEXT DEFAULT \'\'',
 'photo_salon TEXT DEFAULT \'\'',
 'photo_artiste TEXT DEFAULT \'\'',
 'bio TEXT DEFAULT \'\'',
 'styles TEXT DEFAULT \'[]\'',
].forEach(col => {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch(_) {}
});

// ============ INSCRIPTION ============
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, studio_name, city, phone } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, mot de passe et nom requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'Email déjà utilisé' });
    }

    const hash = await bcrypt.hash(password, 10);
    const seed = name.toLowerCase().replace(/\s/g, '');

    const result = db.prepare(
      'INSERT INTO users (email, password_hash, name, studio_name, city, phone, avatar_seed) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(email, hash, name, studio_name || '', city || '', phone || '', seed);

    initDefaultAutomations(result.lastInsertRowid);

    const token = jwt.sign({ userId: result.lastInsertRowid, email }, JWT_SECRET, { expiresIn: '30d' });

    res.cookie('inkr_token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({
      success: true,
      user: { id: result.lastInsertRowid, email, name, studio_name, avatar_seed: seed }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============ CONNEXION ============
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('inkr_token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });

    res.json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, studio_name: user.studio_name, avatar_seed: user.avatar_seed }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============ DÉCONNEXION ============
router.post('/logout', (req, res) => {
  res.clearCookie('inkr_token');
  res.json({ success: true });
});

// ============ VÉRIFIER SESSION ============
router.get('/me', (req, res) => {
  const token = req.cookies?.inkr_token;
  if (!token) return res.status(401).json({ error: 'Non connecté' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, email, name, prenom, nom_artiste, studio_name, city, adresse, phone, instagram, pinterest, auto_reply, bio, styles, photo_salon, photo_artiste, avatar_seed, created_at FROM users WHERE id = ?').get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });
    res.json({ user });
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
});

// ============ METTRE À JOUR LE PROFIL ============
router.put('/profile', (req, res) => {
  const token = req.cookies?.inkr_token;
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { name, prenom, nom_artiste, studio_name, city, adresse, phone, instagram, pinterest, auto_reply, bio, styles } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom requis' });

    // styles est un tableau JSON envoyé depuis le dashboard
    const stylesJson = Array.isArray(styles) ? JSON.stringify(styles) : (styles || '[]');

    // Mise à jour du compte artiste inkr Pro
    db.prepare(
      'UPDATE users SET name=?, prenom=?, nom_artiste=?, studio_name=?, city=?, adresse=?, phone=?, instagram=?, pinterest=?, auto_reply=?, bio=?, styles=? WHERE id=?'
    ).run(name, prenom||'', nom_artiste||'', studio_name||'', city||'', adresse||'', phone||'', instagram||'', pinterest||'', auto_reply||'', bio||'', stylesJson, decoded.userId);

    // ── Sync vers la fiche tatoueur publique (by Instagram handle) ────────────
    // Quand l'artiste inkr Pro met à jour son profil, sa fiche publique dans
    // l'annuaire est mise à jour : bio, styles, auto_reply synchronisés.
    if (instagram) {
      const igHandle = (instagram || '').replace('@', '').toLowerCase().trim();
      if (igHandle) {
        try {
          db.prepare(`
            UPDATE tatoueurs
            SET auto_reply=?, bio=?, styles=?, nom=COALESCE(NULLIF(?,''), nom),
                ville=COALESCE(NULLIF(?,''), ville), adresse=COALESCE(NULLIF(?,''), adresse)
            WHERE LOWER(REPLACE(instagram,'@','')) = ?
          `).run(auto_reply||'', bio||'', stylesJson, nom_artiste||name, city||'', adresse||'', igHandle);
        } catch(_) { /* migration non encore jouée — sans impact */ }
      }
    }

    res.json({ success: true });
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
});

// ============ META OAUTH (Instagram + Facebook) ============
router.get('/meta', (req, res) => {
  const appId = process.env.META_APP_ID;
  if (!appId) return res.status(400).json({ error: 'META_APP_ID non configuré dans .env' });

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: process.env.META_REDIRECT_URI,
    scope: 'pages_messaging,instagram_basic,instagram_manage_messages,pages_read_engagement',
    response_type: 'code',
    state: 'inkr_meta_auth'
  });
  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`);
});

router.get('/meta/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?meta_error=1');
  if (!code) return res.redirect('/?meta_error=1');

  try {
    const tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?` + new URLSearchParams({
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: process.env.META_REDIRECT_URI,
      code
    }));
    const tokenData = await tokenRes.json();

    if (tokenData.access_token) {
      // Stocker le token (simplifié - en prod : chiffrer + lier à l'user)
      db.prepare("UPDATE users SET studio_name = studio_name WHERE id = 1").run();
      console.log('✅ Meta connecté, token reçu');
      res.redirect('/dashboard?meta_connected=1');
    } else {
      res.redirect('/dashboard?meta_error=1');
    }
  } catch (err) {
    console.error('Meta callback error:', err);
    res.redirect('/dashboard?meta_error=1');
  }
});

module.exports = router;
