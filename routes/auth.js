const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
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
 'en_tournee INTEGER DEFAULT 0',
 'reset_token TEXT DEFAULT NULL',
 'reset_token_expiry TEXT DEFAULT NULL',
 'otp_code TEXT DEFAULT NULL',
 'otp_expiry TEXT DEFAULT NULL',
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

    // Email de bienvenue — async, n'impacte pas la réponse
    try {
      const { sendEmail } = require('./campaigns');
      const appUrl = process.env.APP_URL || 'https://inkr-app-production.up.railway.app';
      await sendEmail(
        email,
        '🎨 Bienvenue dans la communauté inkr Pro !',
        `Bonjour ${name} !\n\nTon compte inkr Pro est actif — tu as 14 jours d'essai gratuit pour explorer tout ce qu'inkr a à t'offrir.\n\n👉 Accède à ton dashboard : ${appUrl}/dashboard\n\n📞 Ton call de présentation : https://calendly.com/inkr/onboarding\n\n💬 Une question ? Écris-nous à hello@inkr.club — on répond en moins de 2h.\n\nL'équipe inkr 🖤`,
        { name, prenom: name, studio_name, email },
        appUrl
      );
    } catch(emailErr) {
      console.warn('[Auth] Email bienvenue non envoyé:', emailErr.message);
    }

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

    // Pour les clients mobiles (app iOS) : inclure le JWT dans le body
    // L'app stocke ce token dans SecureStore et l'envoie via Authorization: Bearer
    const isMobile = req.headers['x-inkr-client'] === 'mobile';
    res.json({
      success: true,
      ...(isMobile ? { token } : {}),
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
  // Accepte cookie (web) OU Bearer token (mobile)
  const authHeader = req.headers['authorization'];
  const token = req.cookies?.inkr_token ||
    (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'Non connecté' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, email, name, prenom, nom_artiste, studio_name, city, adresse, phone, instagram, pinterest, auto_reply, bio, styles, photo_salon, photo_artiste, avatar_seed, en_tournee, created_at FROM users WHERE id = ?').get(decoded.userId);
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
    const { name, prenom, nom_artiste, studio_name, city, cp, adresse, phone, instagram, pinterest,
            auto_reply, bio, styles, en_tournee, horaires, dispo_flash } = req.body;

    // Mise à jour partielle : uniquement en_tournee (toggle tournée)
    if (en_tournee !== undefined && !name) {
      const val = en_tournee ? 1 : 0;
      db.prepare('UPDATE users SET en_tournee=? WHERE id=?').run(val, decoded.userId);
      return res.json({ success: true });
    }

    if (!name) return res.status(400).json({ error: 'Nom requis' });

    // styles est un tableau JSON envoyé depuis le dashboard
    const stylesJson = Array.isArray(styles) ? JSON.stringify(styles) : (styles || '[]');
    // horaires est un objet JSON { lun: {open, from, to}, ... }
    const horairesJson = (horaires && typeof horaires === 'object') ? JSON.stringify(horaires) : (horaires || '');

    db.prepare(`
      UPDATE users SET name=?, prenom=?, nom_artiste=?, studio_name=?, city=?, cp=?, adresse=?,
        phone=?, instagram=?, pinterest=?, auto_reply=?, bio=?, styles=?, horaires=?, dispo_flash=?
      WHERE id=?
    `).run(name, prenom||'', nom_artiste||'', studio_name||'', city||'', cp||'', adresse||'', phone||'',
           instagram||'', pinterest||'', auto_reply||'', bio||'', stylesJson,
           horairesJson, dispo_flash ? 1 : 0, decoded.userId);

    // ── Sync vers la fiche tatoueur publique (UPSERT par user_id) ────────────
    // Chaque artiste inkr Pro a une entrée dans tatoueurs (répertoire public).
    // Si la fiche existe déjà (même user_id), on la met à jour.
    // Sinon on crée une nouvelle entrée. Pas besoin d'un compte Instagram pour apparaître.
    try {
      const existingFiche = db.prepare('SELECT id FROM tatoueurs WHERE user_id = ?').get(decoded.userId);
      if (existingFiche) {
        db.prepare(`
          UPDATE tatoueurs SET nom=?, nom_commercial=?, ville=?, cp=?, adresse=?, telephone=?,
            instagram=?, styles=?, bio=?, auto_reply=?, horaires=?, dispo_flash=?, statut='active'
          WHERE user_id=?
        `).run(name, nom_artiste||name, city||'', cp||'', adresse||'', phone||'',
               instagram||'', stylesJson, bio||'', auto_reply||'',
               horairesJson, dispo_flash ? 1 : 0, decoded.userId);
      } else {
        db.prepare(`
          INSERT INTO tatoueurs
            (user_id, nom, nom_commercial, ville, cp, adresse, telephone, instagram,
             styles, bio, auto_reply, horaires, dispo_flash, source, statut)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inkr_pro', 'active')
        `).run(decoded.userId, name, nom_artiste||name, city||'', cp||'', adresse||'', phone||'',
               instagram||'', stylesJson, bio||'', auto_reply||'',
               horairesJson, dispo_flash ? 1 : 0);
      }
    } catch(syncErr) {
      // Ne bloque pas la réponse — la migration user_id est peut-être encore en cours
      console.warn('[Profile] Sync tatoueurs échoué (non bloquant):', syncErr.message);
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

// ============ MOT DE PASSE OUBLIÉ ============
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      // Ne pas révéler si l'email existe
      return res.json({ success: true, message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000).toISOString(); // 1 heure

    db.prepare('UPDATE users SET reset_token=?, reset_token_expiry=? WHERE id=?').run(token, expiry, user.id);

    const appUrl = process.env.APP_URL || 'https://inkr-app-production.up.railway.app';
    try {
      const { sendEmail } = require('./campaigns');
      await sendEmail(
        email,
        '🔑 Réinitialisation de ton mot de passe inkr',
        `Bonjour !\n\nClique sur ce lien pour réinitialiser ton mot de passe (valable 1h) :\n${appUrl}/dashboard?reset_token=${token}\n\nSi tu n'as pas demandé ça, ignore cet email.\n\nL'équipe inkr`,
        { name: user.name, email },
        appUrl
      );
    } catch (emailErr) {
      console.warn('[Auth] Email reset non envoyé:', emailErr.message);
    }

    res.json({ success: true, message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============ RÉINITIALISATION MOT DE PASSE ============
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ error: 'Token et mot de passe requis' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });
    }

    const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
    if (!user) {
      return res.status(400).json({ error: 'Lien invalide ou déjà utilisé' });
    }

    // Vérifier l'expiration
    if (!user.reset_token_expiry || new Date().toISOString() > user.reset_token_expiry) {
      return res.status(400).json({ error: 'Lien expiré, demande un nouveau lien' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    db.prepare('UPDATE users SET password_hash=?, reset_token=NULL, reset_token_expiry=NULL WHERE id=?').run(hash, user.id);

    const jwtToken = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('inkr_token', jwtToken, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });

    const isMobile = req.headers['x-inkr-client'] === 'mobile';
    res.json({
      success: true,
      ...(isMobile ? { token: jwtToken } : {}),
      user: { id: user.id, email: user.email, name: user.name, studio_name: user.studio_name, avatar_seed: user.avatar_seed }
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============ ENVOI OTP SMS ============
async function sendSMSOTP(to, code) {
  if (!process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID.startsWith('ACxx')) {
    console.log(`[OTP SIMULÉ] Code ${code} pour ${to}`);
    return { simulated: true, code }; // retourne le code en simulation pour faciliter les tests
  }
  const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return twilio.messages.create({
    body: `Ton code inkr : ${code}\nValable 10 minutes. Ne le partage avec personne.`,
    from: process.env.TWILIO_PHONE,
    to
  });
}

router.post('/send-otp', async (req, res) => {
  try {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Numéro de téléphone requis' });

    // Normaliser : supprimer les espaces, s'assurer que ça commence par +
    phone = phone.replace(/\s/g, '');
    if (!phone.startsWith('+')) phone = '+' + phone;

    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      return res.status(404).json({ error: 'Aucun compte trouvé avec ce numéro' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    db.prepare('UPDATE users SET otp_code=?, otp_expiry=? WHERE id=?').run(code, expiry, user.id);

    const result = await sendSMSOTP(phone, code);
    const simulated = !!(result && result.simulated);

    res.json({
      success: true,
      simulated,
      ...(simulated ? { code } : {})
    });
  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============ VÉRIFICATION OTP ============
router.post('/verify-otp', async (req, res) => {
  try {
    let { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Téléphone et code requis' });

    phone = phone.replace(/\s/g, '');
    if (!phone.startsWith('+')) phone = '+' + phone;

    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      return res.status(404).json({ error: 'Aucun compte trouvé avec ce numéro' });
    }

    // Vérifier l'expiration d'abord
    if (!user.otp_expiry || new Date().toISOString() > user.otp_expiry) {
      return res.status(400).json({ error: 'Code expiré, demande un nouveau code' });
    }

    // Vérifier le code
    if (user.otp_code !== String(code)) {
      return res.status(400).json({ error: 'Code incorrect' });
    }

    // Effacer l'OTP
    db.prepare('UPDATE users SET otp_code=NULL, otp_expiry=NULL WHERE id=?').run(user.id);

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('inkr_token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });

    const isMobile = req.headers['x-inkr-client'] === 'mobile';
    res.json({
      success: true,
      ...(isMobile ? { token } : {}),
      user: { id: user.id, email: user.email, name: user.name, studio_name: user.studio_name, avatar_seed: user.avatar_seed }
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
