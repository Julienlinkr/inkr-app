require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ WEBHOOKS — doivent être montés AVANT express.json() ============
// Stripe et Meta signent leurs requêtes avec HMAC sur le body brut.
// Si express.json() parse le body en premier, la signature ne peut plus être vérifiée.

// Stripe webhook (signature HMAC sur body brut)
const { webhookRouter } = require('./routes/payments');
app.use('/api/payments/webhook', webhookRouter);

// Meta webhook (WhatsApp + Instagram — signature HMAC sur body brut)
app.use('/api/webhooks', require('./routes/webhooks'));

// ============ MIDDLEWARE (après les webhooks) ============
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ============ ROUTES API ============
app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth/mobile', require('./routes/mobile')); // App iOS artiste inkr Pro
app.use('/api/clients', require('./routes/clients'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/tournee', require('./routes/tournee'));
app.use('/api/annuaire',   require('./routes/annuaire'));
app.use('/api/instagram',     require('./routes/instagram'));
app.use('/api/client',        require('./routes/client_auth'));
app.use('/api/artist-photos', require('./routes/artist_photos'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/loyalty', require('./routes/loyalty'));
app.use('/api/meta',       require('./routes/meta_oauth'));       // OAuth Meta (Instagram + Facebook)
app.use('/api/whatsapp',          require('./routes/whatsapp_connect'));  // WhatsApp Business (officiel)
app.use('/api/whatsapp-personal', require('./routes/whatsapp_personal')); // WhatsApp perso QR code
app.use('/api/email',         require('./routes/email_oauth'));        // Gmail/Outlook OAuth2 artiste
app.use('/api/email/inbound', require('./routes/email_inbound')); // Adresses @inkr.club + inbound webhook
app.use('/api/quotes',    require('./routes/quotes'));           // Devis artiste → client
app.use('/api/analytics', require('./routes/analytics'));        // Trafic site inkr.club (RGPD-safe)

// ============ PAGES (no-cache pour forcer le rechargement) ============
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/dashboard', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
// ============ ACCÈS ADMIN RAPIDE ============
// GET /admin         → page de connexion admin (formulaire mot de passe unique)
// GET /admin?key=XXX → connexion directe via ADMIN_SECRET, redirige vers /dashboard
// Pas besoin d'email — un seul mot de passe (ADMIN_SECRET défini dans Railway)
app.get('/admin', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return res.status(503).send('<h2 style="font-family:sans-serif;padding:40px">ADMIN_SECRET non configuré dans les variables Railway.</h2>');
  }

  // ── Connexion directe via ?key=XXX (URL bookmarkable) ──
  if (req.query.key) {
    if (req.query.key !== secret) {
      return res.status(401).send(`
        <html><head><title>Accès refusé</title></head>
        <body style="font-family:sans-serif;background:#0d0d1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center"><div style="font-size:48px;margin-bottom:16px">🔐</div>
          <h2>Clé incorrecte</h2>
          <a href="/admin" style="color:#a855f7">← Retour</a></div>
        </body></html>`);
    }
    // Clé valide → trouver ou créer le compte dev
    const { db } = require('./db/database');
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';

    let user = db.prepare("SELECT * FROM users WHERE role='dev' OR role='admin' ORDER BY id LIMIT 1").get();
    if (!user) user = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
    if (!user) {
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;background:#0d0d1a;color:#fff;padding:40px">
          <h2>Aucun compte trouvé</h2>
          <p>Crée d'abord un compte sur <a href="/" style="color:#a855f7">inkr.club</a>, puis reviens ici.</p>
        </body></html>`);
    }
    // Activer PRO + rôle dev sur ce compte automatiquement
    db.prepare("UPDATE users SET is_pro=1, role='dev' WHERE id=?").run(user.id);

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' });
    res.cookie('inkr_token', token, { httpOnly: true, maxAge: 90 * 24 * 60 * 60 * 1000 });
    console.log(`[Admin] Connexion rapide → ${user.email} (id=${user.id})`);
    return res.redirect('/dashboard');
  }

  // ── Page de login admin (formulaire) ──
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>inkr · Accès Admin</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0d0d1a;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    .card{background:#1a1a2e;border:1px solid #2a2a3e;border-radius:16px;padding:40px 36px;width:100%;max-width:380px;text-align:center}
    .logo{font-size:32px;font-weight:800;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px;letter-spacing:-1px}
    .sub{color:#666;font-size:13px;margin-bottom:32px;letter-spacing:2px;text-transform:uppercase}
    label{display:block;text-align:left;font-size:12px;color:#888;margin-bottom:6px;letter-spacing:.5px}
    input{width:100%;padding:12px 14px;background:#0d0d1a;border:1px solid #333;border-radius:10px;color:#fff;font-size:15px;outline:none;transition:.2s}
    input:focus{border-color:#a855f7}
    button{margin-top:20px;width:100%;padding:13px;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899);border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:700;cursor:pointer;letter-spacing:.3px;transition:.15s}
    button:hover{opacity:.9;transform:translateY(-1px)}
    .err{margin-top:14px;color:#f87171;font-size:13px;display:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">inkr</div>
    <div class="sub">Back Office</div>
    <form method="GET" action="/admin">
      <label>Mot de passe admin</label>
      <input type="password" name="key" placeholder="••••••••••••" autofocus autocomplete="current-password">
      <button type="submit">Accéder au dashboard →</button>
    </form>
  </div>
</body>
</html>`);
});

// ============ FICHE PUBLIQUE TATOUEUR (/t/:id) ============
// Page publique de chaque tatoueur — accessible sans compte
// Si claimed=0 → affiche un bandeau "Réclamer ma fiche"
app.get('/t/:id', (req, res) => {
  const { db } = require('./db/database');
  const t = db.prepare("SELECT * FROM tatoueurs WHERE id=? AND statut='active'").get(parseInt(req.params.id));
  if (!t) return res.status(404).send(`
    <html><head><meta charset="UTF-8"><title>inkr · Fiche introuvable</title>
    <style>body{background:#0d0d1a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
    a{color:#a855f7}</style></head>
    <body><div><div style="font-size:48px">🔍</div><h2>Fiche introuvable</h2>
    <a href="/">← Retour à l'annuaire inkr</a></div></body></html>`);

  let styles = [];
  try { styles = JSON.parse(t.styles || '[]'); } catch(e) {}
  const nom = t.nom_commercial || t.nom;
  const initials = nom.split(/\s+/).map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
  const igHandle = t.instagram_handle || (t.instagram || '').replace(/.*instagram\.com\//i,'').replace(/\/$/,'');
  const claimed = t.claimed === 1 || t.user_id;
  const appUrl = process.env.APP_URL || 'https://inkr.club';

  res.set('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${nom} — Tatoueur${t.ville ? ' à ' + t.ville : ''} | inkr</title>
  <meta name="description" content="${t.bio ? t.bio.slice(0,155) : `${nom}, tatoueur${t.ville ? ' à ' + t.ville : ''}. Retrouvez ses coordonnées et prenez rendez-vous sur inkr.`}">
  <meta property="og:title" content="${nom} | inkr">
  <meta property="og:description" content="${t.bio ? t.bio.slice(0,155) : `Tatoueur${t.ville ? ' à ' + t.ville : ''}`}">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0d0d1a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
    .header{padding:16px 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #1f2937}
    .logo{font-size:22px;font-weight:800;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
    .back{color:#6b7280;font-size:14px;text-decoration:none;margin-left:auto}
    .back:hover{color:#a855f7}
    .hero{padding:40px 24px 32px;max-width:700px;margin:0 auto}
    .avatar{width:90px;height:90px;border-radius:50%;background:linear-gradient(135deg,#667eea,#a855f7);display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:800;color:#fff;margin-bottom:20px;flex-shrink:0}
    .hero-top{display:flex;gap:20px;align-items:flex-start;margin-bottom:24px}
    .hero-info h1{font-size:28px;font-weight:800;color:#fff;margin-bottom:4px}
    .hero-info .ville{color:#9ca3af;font-size:15px;margin-bottom:10px}
    .badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
    .badge-pro{background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.3);color:#a855f7}
    .badge-import{background:rgba(107,114,128,.1);border:1px solid #374151;color:#9ca3af}
    .bio{color:#d1d5db;line-height:1.6;font-size:15px;margin-bottom:24px}
    .styles{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
    .style-tag{background:#1f2937;border:1px solid #374151;border-radius:20px;padding:4px 14px;font-size:13px;color:#d1d5db}
    .contacts{display:flex;flex-direction:column;gap:10px;margin-bottom:32px}
    .contact-row{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#111827;border-radius:10px;text-decoration:none;color:#e5e7eb;transition:.15s}
    .contact-row:hover{background:#1f2937}
    .contact-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
    .contact-label{font-size:14px;color:#9ca3af;font-size:12px}
    .contact-value{font-size:15px;font-weight:500}
    .cta-booking{display:block;width:100%;padding:16px;background:linear-gradient(135deg,#667eea,#a855f7);border:none;border-radius:12px;color:#fff;font-size:16px;font-weight:700;text-align:center;text-decoration:none;cursor:pointer;margin-bottom:16px;transition:.15s}
    .cta-booking:hover{opacity:.9;transform:translateY(-1px)}
    .claim-banner{background:rgba(245,158,11,.05);border:1px solid rgba(245,158,11,.2);border-radius:12px;padding:20px;text-align:center;margin-top:32px}
    .claim-banner h3{color:#f59e0b;font-size:16px;font-weight:700;margin-bottom:6px}
    .claim-banner p{color:#9ca3af;font-size:13px;line-height:1.5;margin-bottom:16px}
    .claim-btn{display:inline-block;padding:10px 24px;background:#f59e0b;border-radius:8px;color:#000;font-size:14px;font-weight:700;text-decoration:none;transition:.15s}
    .claim-btn:hover{background:#fbbf24}
    .footer{text-align:center;padding:32px 24px;color:#4b5563;font-size:13px;border-top:1px solid #1f2937;margin-top:40px}
    .footer a{color:#a855f7;text-decoration:none}
    @media(max-width:480px){.hero-top{flex-direction:column}.avatar{width:70px;height:70px;font-size:24px}}
  </style>
</head>
<body>
  <header class="header">
    <a href="/" class="logo">inkr</a>
    <a href="/" class="back">← Tous les tatoueurs</a>
  </header>

  <div class="hero">
    <div class="hero-top">
      <div class="avatar">${initials}</div>
      <div class="hero-info">
        <h1>${nom}</h1>
        <div class="ville">📍 ${[t.adresse, t.ville].filter(Boolean).join(', ') || 'France'}</div>
        <span class="badge ${claimed ? 'badge-pro' : 'badge-import'}">
          ${claimed ? '✅ Artiste vérifié inkr' : '🗂 Fiche non réclamée'}
        </span>
      </div>
    </div>

    ${t.bio ? `<p class="bio">${t.bio.replace(/</g,'&lt;')}</p>` : ''}

    ${styles.length ? `
    <div class="styles">
      ${styles.map(s=>`<span class="style-tag">${s}</span>`).join('')}
    </div>` : ''}

    <a href="/book/${t.id}" class="cta-booking">📅 Prendre rendez-vous</a>

    <div class="contacts">
      ${t.telephone ? `<a href="tel:${t.telephone}" class="contact-row">
        <div class="contact-icon" style="background:#1f2937">📞</div>
        <div><div class="contact-label">Téléphone</div><div class="contact-value">${t.telephone}</div></div>
      </a>` : ''}
      ${igHandle ? `<a href="https://instagram.com/${igHandle}" target="_blank" rel="noopener" class="contact-row">
        <div class="contact-icon" style="background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)">📸</div>
        <div><div class="contact-label">Instagram</div><div class="contact-value">@${igHandle}</div></div>
      </a>` : ''}
      ${t.site_web ? `<a href="${t.site_web}" target="_blank" rel="noopener" class="contact-row">
        <div class="contact-icon" style="background:#1f2937">🌐</div>
        <div><div class="contact-label">Site web</div><div class="contact-value">${t.site_web.replace(/^https?:\/\//,'').split('/')[0]}</div></div>
      </a>` : ''}
      ${t.facebook ? `<a href="${t.facebook}" target="_blank" rel="noopener" class="contact-row">
        <div class="contact-icon" style="background:#1877f2">📘</div>
        <div><div class="contact-label">Facebook</div><div class="contact-value">Page Facebook</div></div>
      </a>` : ''}
      ${t.email ? `<a href="mailto:${t.email}" class="contact-row">
        <div class="contact-icon" style="background:#1f2937">✉️</div>
        <div><div class="contact-label">Email</div><div class="contact-value">${t.email}</div></div>
      </a>` : ''}
    </div>

    ${!claimed ? `
    <div class="claim-banner">
      <h3>📋 C'est votre salon ?</h3>
      <p>Cette fiche a été créée automatiquement depuis des données publiques.<br>
      Réclamez-la gratuitement pour la personnaliser et gérer vos rendez-vous.</p>
      <a href="${appUrl}/?claim=${t.id}&ig=${encodeURIComponent(igHandle)}" class="claim-btn">
        ✨ Réclamer ma fiche — c'est gratuit
      </a>
    </div>` : ''}
  </div>

  <footer class="footer">
    <p>Fiche référencée sur <a href="${appUrl}">inkr.club</a> — l'annuaire des tatoueurs professionnels</p>
    ${!claimed ? `<p style="margin-top:8px"><a href="${appUrl}/?claim=${t.id}">Réclamer ou corriger cette fiche</a></p>` : ''}
  </footer>
</body>
</html>`);
});

// /pricing → SPA index.html (la vue "pricing" est affichée via showView côté client)
app.get('/pricing', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ ADMIN — Backup manuel ============
// GET  /api/admin/backups  → liste les backups disponibles
// POST /api/admin/backup   → déclenche un backup immédiat
// Protégé par ADMIN_SECRET (variable Railway optionnelle)
app.get('/api/admin/backups', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.query.secret !== secret) return res.status(401).json({ error: 'Non autorisé' });
  const { listBackups } = require('./services/backup');
  res.json({ backups: listBackups() });
});
app.post('/api/admin/backup', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.query.secret !== secret) return res.status(401).json({ error: 'Non autorisé' });
  const { runBackup } = require('./services/backup');
  const result = runBackup();
  if (result) res.json({ success: true, file: require('path').basename(result.file), size_kb: Math.round(result.size / 1024) });
  else res.status(500).json({ error: 'Backup échoué — voir les logs Railway' });
});

// ============ ADMIN — Gestion PRO / rôles ============
// POST /api/admin/set-pro?secret=XXX  { email, is_pro: 1|0 }
// Permet d'activer/désactiver le statut PRO d'un artiste sans passer par Stripe
app.post('/api/admin/set-pro', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) {
    return res.status(401).json({ error: 'Non autorisé — ADMIN_SECRET requis' });
  }
  const { email, is_pro, role } = req.body;
  if (!email) return res.status(400).json({ error: 'email requis' });
  const { db } = require('./db/database');
  const user = db.prepare('SELECT id, email, name, is_pro, role FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: `Utilisateur "${email}" introuvable` });
  if (is_pro !== undefined) db.prepare('UPDATE users SET is_pro=? WHERE email=?').run(is_pro ? 1 : 0, email);
  if (role)    db.prepare('UPDATE users SET role=? WHERE email=?').run(role, email);
  const updated = db.prepare('SELECT id, email, name, is_pro, role FROM users WHERE email=?').get(email);
  console.log(`[Admin] PRO mis à jour → ${email} : is_pro=${updated.is_pro}, role=${updated.role}`);
  res.json({ success: true, user: updated });
});

// GET /api/admin/users?secret=XXX  → liste tous les artistes (JSON)
app.get('/api/admin/users', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(401).json({ error: 'Non autorisé' });
  const { db } = require('./db/database');
  const users = db.prepare('SELECT id, email, name, city, is_pro, role, created_at FROM users ORDER BY id DESC').all();
  res.json({ users });
});

// GET /admin/comptes?secret=XXX  → page HTML avec la liste des artistes inscrits
app.get('/admin/comptes', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) {
    return res.status(401).send(`
      <html><head><meta charset="UTF-8"><title>inkr · Admin</title>
      <style>body{background:#0d0d1a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .box{background:#1a1a2e;border:1px solid #333;border-radius:16px;padding:40px;text-align:center}
      form{margin-top:20px}input{padding:10px 14px;background:#111;border:1px solid #444;border-radius:8px;color:#fff;font-size:15px;margin-right:8px}
      button{padding:10px 20px;background:#a855f7;border:none;border-radius:8px;color:#fff;font-size:15px;cursor:pointer}</style></head>
      <body><div class="box"><div style="font-size:32px;font-weight:800;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent">inkr</div>
      <p style="color:#888;margin:8px 0 20px">Accès admin requis</p>
      <form method="GET"><input type="password" name="secret" placeholder="Mot de passe admin" autofocus>
      <button type="submit">Accéder →</button></form></div></body></html>`);
  }
  const { db } = require('./db/database');
  const users = db.prepare('SELECT id, email, name, city, is_pro, role, created_at FROM users ORDER BY id DESC').all();
  const rows = users.map(u => `
    <tr>
      <td>${u.id}</td>
      <td>${u.name || '—'}</td>
      <td>${u.email}</td>
      <td>${u.city || '—'}</td>
      <td>${u.is_pro ? '<span style="color:#4ade80;font-weight:700">✅ PRO</span>' : '<span style="color:#888">Free</span>'}</td>
      <td>${u.role || 'artist'}</td>
      <td style="color:#888;font-size:13px">${u.created_at ? u.created_at.slice(0,16) : '—'}</td>
      <td>
        <button onclick="togglePro(${u.id},'${u.email}',${u.is_pro})" style="padding:4px 10px;background:${u.is_pro ? '#374151' : '#7c3aed'};border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:12px">
          ${u.is_pro ? '⬇ Passer Free' : '⬆ Passer PRO'}
        </button>
      </td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>inkr · Comptes artistes</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0d0d1a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px}
  h1{font-size:28px;font-weight:800;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
  .sub{color:#666;font-size:14px;margin-bottom:28px}
  .stats{display:flex;gap:16px;margin-bottom:28px}
  .stat{background:#1a1a2e;border:1px solid #2a2a3e;border-radius:12px;padding:16px 24px}
  .stat-n{font-size:32px;font-weight:800;color:#a855f7}
  .stat-l{font-size:12px;color:#888;margin-top:2px}
  table{width:100%;border-collapse:collapse;background:#1a1a2e;border-radius:12px;overflow:hidden}
  th{background:#111827;padding:12px 16px;text-align:left;font-size:12px;color:#6b7280;font-weight:600;letter-spacing:.5px;text-transform:uppercase}
  td{padding:12px 16px;border-top:1px solid #1f2937;font-size:14px}
  tr:hover td{background:#1f2937}
  .back{display:inline-block;margin-bottom:20px;color:#a855f7;text-decoration:none;font-size:14px}
</style></head>
<body>
  <a href="/admin" class="back">← Back office</a>
  <h1>inkr · Artistes inscrits</h1>
  <div class="sub">${users.length} compte${users.length > 1 ? 's' : ''} au total</div>
  <div class="stats">
    <div class="stat"><div class="stat-n">${users.length}</div><div class="stat-l">Total inscrits</div></div>
    <div class="stat"><div class="stat-n" style="color:#4ade80">${users.filter(u=>u.is_pro).length}</div><div class="stat-l">Abonnés PRO</div></div>
    <div class="stat"><div class="stat-n" style="color:#f59e0b">${users.filter(u=>!u.is_pro).length}</div><div class="stat-l">Comptes Free</div></div>
    <div class="stat"><div class="stat-n" style="color:#60a5fa">${users.filter(u=>{const d=new Date(u.created_at);const now=new Date();return (now-d)<7*24*3600*1000;}).length}</div><div class="stat-l">Inscrits cette semaine</div></div>
  </div>
  <table>
    <thead><tr>
      <th>#</th><th>Nom</th><th>Email</th><th>Ville</th><th>Statut</th><th>Rôle</th><th>Inscrit le</th><th>Action</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="8" style="text-align:center;padding:40px;color:#666">Aucun compte encore — sois patient 😄</td></tr>'}</tbody>
  </table>
<script>
const SECRET = '${secret}';
async function togglePro(id, email, isPro) {
  const newPro = isPro ? 0 : 1;
  const action = newPro ? 'PRO' : 'Free';
  if (!confirm('Passer ' + email + ' en ' + action + ' ?')) return;
  const r = await fetch('/api/admin/set-pro?secret=' + SECRET, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email, is_pro: newPro })
  });
  if (r.ok) location.reload();
  else alert('Erreur');
}
</script>
</body></html>`);
});

// ============ STATUS ============
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    services: {
      email: !!process.env.RESEND_API_KEY,
      sms: !!(process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.startsWith('ACxx')),
      stripe: !!process.env.STRIPE_SECRET_KEY,
      whatsapp: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
      instagram: !!process.env.INSTAGRAM_PAGE_TOKEN,
      meta_webhook: !!process.env.META_VERIFY_TOKEN,
    }
  });
});

// ============ BACKUP AUTOMATIQUE ============
const { startAutoBackup } = require('./services/backup');

// ============ EMAIL POLLING ============
const { startEmailPolling } = require('./routes/email_oauth');

// ============ WHATSAPP PERSO — Restauration des sessions ============
const { restoreActiveSessions } = require('./routes/whatsapp_personal');

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎨 ========================================');
  console.log(`   inkr — Serveur démarré sur le port ${PORT}`);
  console.log(`   Node.js ${process.version}`);
  console.log('==========================================');
  console.log('\n📋 Services :');
  const hasResend = !!process.env.RESEND_API_KEY;
  const emailFrom = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  console.log(`   EMAIL  : ${hasResend ? `✅ Resend actif (from: ${emailFrom})` : '⚠️  RESEND_API_KEY manquant — mode simulation'}`);
  if (hasResend && emailFrom.includes('onboarding@resend.dev')) {
    console.log(`   EMAIL  : ⚠️  Domaine non vérifié — envoi limité à votre email Resend`);
    console.log(`             → Vérifiez inkr.club sur resend.com/domains`);
    console.log(`             → Puis ajoutez EMAIL_FROM=inkr <noreply@inkr.club> dans Railway`);
  }
  console.log(`   SMS    : ${process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.startsWith('ACxx') ? '✅ Twilio actif' : '⚠️  Mode simulation'}`);
  console.log(`   STRIPE : ${process.env.STRIPE_SECRET_KEY ? '✅ Configuré' : '⚠️  Mode simulation (STRIPE_SECRET_KEY manquant)'}`);
  console.log(`   WHATSAPP: ${process.env.WHATSAPP_TOKEN ? '✅ Configuré' : '⚠️  Mode simulation (WHATSAPP_TOKEN manquant)'}`);
  console.log(`   DB     : ${process.env.DB_PATH || 'db/inkr.db (local)'}`);
  console.log('\n');

  // Démarrage du backup automatique (après initialisation complète)
  startAutoBackup();
  // Démarrage du polling email (sync Gmail/Outlook toutes les 5 min)
  startEmailPolling();
  // Restauration des sessions WhatsApp perso (artistes déjà connectés)
  setTimeout(() => restoreActiveSessions(), 5000); // délai pour laisser le serveur s'initialiser
  // Démarrage du scheduler d'automatisations (rappels, relances, anniversaires)
  const { startAutomations } = require('./services/automations');
  startAutomations();
});
