require('dotenv').config(); // inkr v3.1 — restart 2026-07-07
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

// ============ DÉTECTION MOBILE ============
// Sert mobile.html pour iPhone/Android, index.html pour desktop.
// La version desktop n'est JAMAIS modifiée par ce code.
function isMobile(req) {
  const ua = req.headers['user-agent'] || '';
  return /iPhone|Android.*Mobile|iPod|BlackBerry|Windows Phone|Opera Mini|IEMobile/i.test(ua);
}

// ============ PAGES (no-cache pour forcer le rechargement) ============
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const file = isMobile(req) ? 'mobile.html' : 'index.html';
  res.sendFile(path.join(__dirname, 'public', file));
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
  const igHandle = ((t.instagram_handle || t.instagram || '').replace(/^@/,'').replace(/.*instagram\.com\//i,'').replace(/[/?#].*/,'').trim());
  const claimed = t.claimed === 1 || !!t.user_id;
  const appUrl = process.env.APP_URL || 'https://inkr.club';

  // Photo de profil : Instagram via unavatar, sinon gradient
  const avatarUrl = igHandle ? `https://unavatar.io/instagram/${igHandle}` : null;

  // Adresse formatée
  const adresseFull = [t.adresse, t.cp, t.ville].filter(Boolean).join(', ');

  // Google Maps embed
  const mapsQuery = encodeURIComponent(adresseFull || nom + ' tatoueur ' + (t.ville||'France'));
  const mapsEmbedUrl = `https://maps.google.com/maps?q=${mapsQuery}&output=embed`;
  const mapsLink = `https://maps.google.com/maps?q=${mapsQuery}`;

  res.set('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${nom} — Tatoueur${t.ville ? ' à ' + t.ville : ''} | inkr</title>
  <meta name="description" content="${(t.bio||'').slice(0,155) || `${nom}, tatoueur${t.ville?' à '+t.ville:''}. Coordonnées, portfolio et prise de RDV sur inkr.`}">
  <meta property="og:title" content="${nom} | inkr">
  <meta property="og:description" content="${(t.bio||'').slice(0,155) || `Tatoueur${t.ville?' à '+t.ville:''}`}">
  ${t.photo_salon ? `<meta property="og:image" content="${t.photo_salon}">` : ''}
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0d0d1a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
    .header{padding:14px 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #1f2937;position:sticky;top:0;background:#0d0d1a;z-index:10}
    .logo{font-size:22px;font-weight:800;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
    .back{color:#6b7280;font-size:13px;text-decoration:none;margin-left:auto;display:flex;align-items:center;gap:4px}
    .back:hover{color:#a855f7}
    .wrap{max-width:740px;margin:0 auto;padding:32px 20px 60px}
    /* Hero */
    .hero-top{display:flex;gap:20px;align-items:flex-start;margin-bottom:28px}
    .avatar-wrap{flex-shrink:0}
    .avatar{width:100px;height:100px;border-radius:16px;object-fit:cover;background:linear-gradient(135deg,#667eea,#a855f7);display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:900;color:#fff}
    .hero-info h1{font-size:26px;font-weight:800;color:#fff;margin-bottom:6px;line-height:1.2}
    .hero-loc{color:#9ca3af;font-size:14px;margin-bottom:10px;display:flex;align-items:center;gap:6px}
    .badges{display:flex;gap:8px;flex-wrap:wrap}
    .badge{display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600}
    .badge-pro{background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.3);color:#a855f7}
    .badge-import{background:rgba(107,114,128,.1);border:1px solid #374151;color:#9ca3af}
    /* Section titre */
    .sec-title{font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
    /* Bio */
    .bio-box{background:#111827;border-radius:12px;padding:16px 20px;margin-bottom:24px;color:#d1d5db;line-height:1.7;font-size:14px}
    /* Styles tags */
    .tags{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
    .tag{background:#1f2937;border:1px solid #374151;border-radius:20px;padding:5px 14px;font-size:13px;color:#d1d5db}
    /* Portfolio Instagram */
    .ig-portfolio{margin-bottom:28px}
    .ig-preview-card{background:#111827;border-radius:14px;overflow:hidden;text-decoration:none;display:block;transition:.15s;border:1px solid #1f2937}
    .ig-preview-card:hover{border-color:#a855f7}
    .ig-header{display:flex;align-items:center;gap:12px;padding:14px 16px}
    .ig-avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)}
    .ig-info-name{font-size:14px;font-weight:700;color:#fff}
    .ig-info-sub{font-size:12px;color:#9ca3af}
    .ig-cta{background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045);color:#fff;font-size:13px;font-weight:700;padding:10px 20px;display:flex;align-items:center;justify-content:space-between}
    /* Photo du salon (og:image) */
    .salon-photo{width:100%;height:220px;object-fit:cover;border-radius:14px;margin-bottom:24px}
    /* Contacts */
    .contacts{display:flex;flex-direction:column;gap:10px;margin-bottom:28px}
    .contact-row{display:flex;align-items:center;gap:12px;padding:13px 16px;background:#111827;border-radius:12px;text-decoration:none;color:#e5e7eb;transition:.15s;border:1px solid transparent}
    .contact-row:hover{background:#1f2937;border-color:#374151}
    .cicon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
    .clabel{font-size:11px;color:#6b7280;margin-bottom:1px}
    .cval{font-size:14px;font-weight:600;color:#e5e7eb}
    /* CTA RDV */
    .cta-rdv{display:block;width:100%;padding:16px;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899);border:none;border-radius:14px;color:#fff;font-size:16px;font-weight:800;text-align:center;text-decoration:none;cursor:pointer;margin-bottom:12px;transition:.15s;letter-spacing:-.2px}
    .cta-rdv:hover{opacity:.9;transform:translateY(-1px);box-shadow:0 8px 32px rgba(168,85,247,.4)}
    /* Map */
    .map-wrap{border-radius:14px;overflow:hidden;margin-bottom:28px;border:1px solid #1f2937}
    .map-wrap iframe{display:block;width:100%;height:200px;border:none}
    /* Claim */
    .claim-box{background:linear-gradient(135deg,rgba(245,158,11,.08),rgba(245,158,11,.03));border:1px solid rgba(245,158,11,.25);border-radius:16px;padding:24px;text-align:center;margin-top:8px}
    .claim-box h3{color:#f59e0b;font-size:17px;font-weight:800;margin-bottom:8px}
    .claim-box p{color:#9ca3af;font-size:13px;line-height:1.6;margin-bottom:18px}
    .claim-btn{display:inline-flex;align-items:center;gap:8px;padding:12px 28px;background:#f59e0b;border-radius:10px;color:#000;font-size:14px;font-weight:800;text-decoration:none;transition:.15s}
    .claim-btn:hover{background:#fbbf24;transform:translateY(-1px)}
    .footer{text-align:center;padding:28px 24px;color:#4b5563;font-size:12px;border-top:1px solid #1f2937;margin-top:20px}
    .footer a{color:#a855f7;text-decoration:none}
    /* ── Mobile fiche (/t/:id) ── */
    @media(max-width:768px){
      body { padding-bottom: 0; }
      .header { padding: 10px 14px; padding-top: calc(env(safe-area-inset-top) + 10px); }
      .logo { font-size: 20px; }
      .back { font-size: 13px; }
      .wrap { padding: 20px 14px 48px; }
      .hero-top { flex-direction: column; gap: 14px; margin-bottom: 20px; }
      .avatar { width: 80px; height: 80px; border-radius: 14px; font-size: 30px; }
      .hero-info h1 { font-size: 22px; }
      .cta-rdv {
        position: fixed; bottom: 0; left: 0; right: 0; z-index: 100;
        border-radius: 0; margin-bottom: 0;
        padding: 18px 20px; padding-bottom: calc(18px + env(safe-area-inset-bottom));
        font-size: 16px;
      }
      /* push content so it's not hidden under fixed CTA */
      .wrap { padding-bottom: calc(90px + env(safe-area-inset-bottom)); }
      .map-wrap iframe { height: 160px; }
      .contacts { gap: 8px; }
      .contact-row { padding: 11px 14px; }
      .cicon { width: 34px; height: 34px; font-size: 16px; }
      .badges { flex-wrap: wrap; gap: 6px; }
      .footer { padding: 20px 16px; font-size: 11px; }
    }
  </style>
</head>
<body>
<header class="header">
  <a href="/" class="logo">inkr</a>
  <a href="/" class="back">← Tous les tatoueurs</a>
</header>

<div class="wrap">

  <!-- HERO -->
  <div class="hero-top">
    <div class="avatar-wrap">
      ${avatarUrl
        ? `<img src="${avatarUrl}" alt="${nom}" class="avatar" onerror="this.outerHTML='<div class=\\'avatar\\'>${initials}</div>'">`
        : `<div class="avatar">${initials}</div>`}
    </div>
    <div class="hero-info">
      <h1>${nom}</h1>
      <div class="hero-loc">📍 ${adresseFull || t.ville || 'France'}</div>
      <div class="badges">
        <span class="badge ${claimed ? 'badge-pro' : 'badge-import'}">
          ${claimed ? '✅ Vérifié inkr' : '🗂 Fiche non réclamée'}
        </span>
        ${t.telephone ? `<span class="badge" style="background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:#4ade80">📞 Disponible</span>` : ''}
        ${igHandle ? `<span class="badge" style="background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.3);color:#c084fc">📸 Instagram</span>` : ''}
      </div>
    </div>
  </div>

  <!-- CTA RDV -->
  <a href="${igHandle ? 'https://instagram.com/'+igHandle : (t.telephone ? 'tel:'+t.telephone : '#')}"
     ${igHandle || t.telephone ? 'target="_blank" rel="noopener"' : ''}
     class="cta-rdv">
    📅 Prendre rendez-vous
  </a>

  <!-- PHOTO DU SALON (si scrappée depuis site web) -->
  ${t.photo_salon ? `<img src="${t.photo_salon}" alt="Photo ${nom}" class="salon-photo" onerror="this.style.display='none'">` : ''}

  <!-- BIO -->
  ${t.bio ? `
  <div class="sec-title">À propos</div>
  <div class="bio-box">${t.bio.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</div>
  ` : ''}

  <!-- STYLES -->
  ${styles.length ? `
  <div class="sec-title">Styles</div>
  <div class="tags" style="margin-bottom:28px">
    ${styles.map(s=>`<span class="tag">${s}</span>`).join('')}
  </div>` : ''}

  <!-- PORTFOLIO INSTAGRAM -->
  ${igHandle ? `
  <div class="sec-title ig-portfolio">Portfolio</div>
  <a href="https://instagram.com/${igHandle}" target="_blank" rel="noopener" class="ig-preview-card" style="margin-bottom:28px">
    <div class="ig-header">
      <img src="https://unavatar.io/instagram/${igHandle}" alt="${nom}" class="ig-avatar" onerror="this.style.background='linear-gradient(135deg,#833ab4,#fd1d1d)'">
      <div>
        <div class="ig-info-name">@${igHandle}</div>
        <div class="ig-info-sub">Voir les tatouages sur Instagram</div>
      </div>
      <div style="margin-left:auto;font-size:20px">→</div>
    </div>
    <div class="ig-cta">
      <span>📸 Voir le portfolio complet</span>
      <span style="opacity:.8;font-size:11px">instagram.com/${igHandle}</span>
    </div>
  </a>` : ''}

  <!-- CONTACTS -->
  <div class="sec-title">Contacts</div>
  <div class="contacts">
    ${t.telephone ? `<a href="tel:${t.telephone}" class="contact-row">
      <div class="cicon" style="background:#1f2937">📞</div>
      <div><div class="clabel">Téléphone</div><div class="cval">${t.telephone}</div></div>
    </a>` : ''}
    ${igHandle ? `<a href="https://instagram.com/${igHandle}" target="_blank" rel="noopener" class="contact-row">
      <div class="cicon" style="background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)">📸</div>
      <div><div class="clabel">Instagram</div><div class="cval">@${igHandle}</div></div>
    </a>` : ''}
    ${t.site_web ? `<a href="${t.site_web}" target="_blank" rel="noopener" class="contact-row">
      <div class="cicon" style="background:#1f2937">🌐</div>
      <div><div class="clabel">Site web</div><div class="cval">${t.site_web.replace(/^https?:\/\//,'').split('/')[0]}</div></div>
    </a>` : ''}
    ${t.facebook ? `<a href="${t.facebook}" target="_blank" rel="noopener" class="contact-row">
      <div class="cicon" style="background:#1877f2">📘</div>
      <div><div class="clabel">Facebook</div><div class="cval">Page Facebook</div></div>
    </a>` : ''}
    ${t.email ? `<a href="mailto:${t.email}" class="contact-row">
      <div class="cicon" style="background:#1f2937">✉️</div>
      <div><div class="clabel">Email</div><div class="cval">${t.email}</div></div>
    </a>` : ''}
    ${adresseFull ? `<a href="${mapsLink}" target="_blank" rel="noopener" class="contact-row">
      <div class="cicon" style="background:#1f2937">📍</div>
      <div><div class="clabel">Adresse</div><div class="cval">${adresseFull}</div></div>
    </a>` : ''}
  </div>

  <!-- MAP GOOGLE -->
  ${adresseFull ? `
  <div class="sec-title">Localisation</div>
  <div class="map-wrap">
    <iframe src="${mapsEmbedUrl}" allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
  </div>` : ''}

  <!-- CLAIM BANNER -->
  ${!claimed ? `
  <div class="claim-box">
    <h3>🎨 C'est votre fiche ?</h3>
    <p>Inscrivez-vous gratuitement pour la personnaliser : ajoutez vos photos, vos horaires, vos disponibilités et gérez vos rendez-vous directement depuis inkr.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-bottom:18px;">
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#9ca3af;"><span style="color:#4ade80;font-size:14px;">✓</span> Profil personnalisé</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#9ca3af;"><span style="color:#4ade80;font-size:14px;">✓</span> 10 photos gratuites</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#9ca3af;"><span style="color:#4ade80;font-size:14px;">✓</span> Prise de RDV en ligne</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#9ca3af;"><span style="color:#4ade80;font-size:14px;">✓</span> 100% gratuit</div>
    </div>
    <a href="${appUrl}/claim/${t.id}" class="claim-btn">
      ✨ Personnaliser ma fiche — c'est gratuit
    </a>
    <p style="font-size:11px;color:#6b7280;margin-top:10px;">Aucune CB requise · Inscription en 2 minutes</p>
  </div>` : ''}

</div>

<footer class="footer">
  <p>Fiche référencée sur <a href="${appUrl}">inkr.club</a> — l'annuaire N°1 des tatoueurs professionnels</p>
  ${!claimed ? `<p style="margin-top:6px"><a href="${appUrl}/claim/${t.id}">Réclamer ou corriger cette fiche</a></p>` : ''}
</footer>
</body>
</html>`);
});

// ============ CLAIM — Page d'inscription tatoueur depuis sa fiche ============
// GET /claim/:id  → formulaire d'inscription pré-rempli avec les infos de la fiche
// POST /api/claim/:id → crée le compte + lie la fiche + set cookie JWT
// ─────────────────────────────────────────────────────────────────────────────
app.get('/claim/:id', (req, res) => {
  const { db } = require('./db/database');
  const t = db.prepare("SELECT * FROM tatoueurs WHERE id=? AND statut='active'").get(parseInt(req.params.id));
  if (!t) return res.status(404).redirect('/');
  if (t.claimed === 1 || t.user_id) return res.redirect('/dashboard'); // déjà réclamée

  const nom = t.nom_commercial || t.nom || '';
  const appUrl = process.env.APP_URL || 'https://inkr.club';

  res.set('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Personnaliser ma fiche — inkr</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0d0d1a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
    .header{padding:14px 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #1f2937}
    .logo{font-size:22px;font-weight:800;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
    .wrap{max-width:560px;margin:0 auto;padding:36px 20px 60px}
    /* Badge fiche */
    .fiche-badge{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:16px 20px;margin-bottom:32px;display:flex;align-items:center;gap:14px}
    .fiche-avatar{width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,#667eea,#a855f7);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:#fff;flex-shrink:0}
    .fiche-info-name{font-size:16px;font-weight:700;color:#fff}
    .fiche-info-sub{font-size:13px;color:#6b7280;margin-top:2px}
    /* Titre */
    h1{font-size:26px;font-weight:800;color:#fff;margin-bottom:6px;line-height:1.2}
    .subtitle{color:#9ca3af;font-size:14px;margin-bottom:32px;line-height:1.6}
    /* Form */
    .form-section{margin-bottom:28px}
    .form-section-title{font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
    .form-row{display:flex;gap:12px;margin-bottom:14px}
    .form-group{flex:1;display:flex;flex-direction:column;gap:6px}
    label{font-size:12px;font-weight:600;color:#9ca3af}
    input[type=text],input[type=email],input[type=tel],input[type=password]{width:100%;padding:12px 14px;background:#111827;border:1px solid #374151;border-radius:10px;color:#e5e7eb;font-size:14px;outline:none;transition:.15s}
    input:focus{border-color:#a855f7;box-shadow:0 0 0 2px rgba(168,85,247,.15)}
    /* Toggle dispo */
    .toggle-row{display:flex;align-items:center;justify-content:space-between;background:#111827;border:1px solid #374151;border-radius:10px;padding:14px 16px;cursor:pointer;margin-bottom:14px}
    .toggle-label{font-size:14px;color:#e5e7eb}
    .toggle-sub{font-size:12px;color:#6b7280;margin-top:2px}
    .toggle-switch{width:44px;height:24px;background:#374151;border-radius:12px;position:relative;transition:.2s;flex-shrink:0}
    .toggle-switch.on{background:#a855f7}
    .toggle-switch::after{content:'';position:absolute;width:18px;height:18px;background:#fff;border-radius:9px;top:3px;left:3px;transition:.2s}
    .toggle-switch.on::after{transform:translateX(20px)}
    /* Horaires */
    .horaires-grid{display:flex;flex-direction:column;gap:8px}
    .h-row{display:flex;align-items:center;gap:10px;background:#111827;border:1px solid #374151;border-radius:10px;padding:10px 14px}
    .h-day{width:32px;font-size:13px;font-weight:700;color:#9ca3af;flex-shrink:0}
    .h-toggle{width:36px;height:20px;background:#374151;border-radius:10px;position:relative;cursor:pointer;transition:.2s;flex-shrink:0}
    .h-toggle.on{background:#a855f7}
    .h-toggle::after{content:'';position:absolute;width:14px;height:14px;background:#fff;border-radius:7px;top:3px;left:3px;transition:.2s}
    .h-toggle.on::after{transform:translateX(16px)}
    .h-times{display:flex;align-items:center;gap:6px;margin-left:6px}
    .h-times input{width:78px;padding:5px 8px;background:#0d0d1a;border:1px solid #374151;border-radius:7px;color:#e5e7eb;font-size:12px}
    .h-times span{color:#6b7280;font-size:12px}
    .h-closed{font-size:12px;color:#4b5563;margin-left:6px}
    /* CTA */
    .submit-btn{width:100%;padding:16px;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899);border:none;border-radius:14px;color:#fff;font-size:16px;font-weight:800;cursor:pointer;margin-top:8px;transition:.15s;letter-spacing:-.2px}
    .submit-btn:hover{opacity:.9;transform:translateY(-1px)}
    .submit-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
    .error-msg{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:12px 16px;color:#f87171;font-size:13px;margin-bottom:16px;display:none}
    .already{font-size:13px;color:#6b7280;text-align:center;margin-top:16px}
    .already a{color:#a855f7}
    .avantages{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:32px}
    .av{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:12px}
    .av-num{font-size:20px;font-weight:900;background:linear-gradient(135deg,#667eea,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;flex-shrink:0;min-width:28px;line-height:1}
    .av-text{font-size:13px;color:#d1d5db;line-height:1.4}
    .welcome{margin-bottom:32px}
    .welcome h1{font-size:28px;font-weight:900;color:#fff;line-height:1.15;margin-bottom:10px}
    .welcome h1 .grad{background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .welcome p{color:#9ca3af;font-size:14px;line-height:1.7}
    .fiche-badge{background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.18);border-radius:14px;padding:14px 18px;margin-bottom:28px;display:flex;align-items:center;gap:14px}
    .fiche-badge-tag{margin-left:auto;background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.3);border-radius:6px;padding:4px 10px;font-size:11px;color:#a855f7;font-weight:700;white-space:nowrap;flex-shrink:0}
    .styles-grid{display:flex;flex-wrap:wrap;gap:8px}
    .style-pill{background:#111827;border:1px solid #374151;border-radius:20px;padding:7px 14px;font-size:13px;color:#9ca3af;cursor:pointer;transition:.15s;font-family:inherit;outline:none}
    .style-pill:hover{border-color:#a855f7;color:#d1d5db}
    .style-pill.active{background:rgba(168,85,247,.15);border-color:#a855f7;color:#c084fc;font-weight:600}
    .divider{border:none;border-top:1px solid #1f2937;margin:24px 0}
    .req{color:#ef4444}
  </style>
</head>
<body>
<header class="header">
  <a href="/" class="logo">inkr</a>
</header>

<div class="wrap">

  <!-- Welcome -->
  <div class="welcome">
    <h1>Bienvenue, <span class="grad">${nom}</span> 👋</h1>
    <p>Nous sommes ravis de t'accueillir dans la communauté inkr.<br>Crée ton compte gratuit et prends le contrôle de ta fiche en 2 minutes.</p>
  </div>

  <!-- Fiche -->
  <div class="fiche-badge">
    <div class="fiche-avatar">${nom.slice(0,1).toUpperCase()}</div>
    <div>
      <div class="fiche-info-name">${nom}</div>
      <div class="fiche-info-sub">📍 ${t.ville || 'France'}${t.cp ? ' · ' + t.cp : ''}</div>
    </div>
    <div class="fiche-badge-tag">Ta fiche</div>
  </div>

  <div class="avantages">
    <div class="av"><div class="av-num">10</div><div class="av-text">photos portfolio gratuites</div></div>
    <div class="av"><div class="av-num">RDV</div><div class="av-text">en ligne intégrés</div></div>
    <div class="av"><div class="av-num">★</div><div class="av-text">Horaires & dispo flash</div></div>
    <div class="av"><div class="av-num">♥</div><div class="av-text">100% Gratuit à vie</div></div>
  </div>

  <div id="errMsg" class="error-msg"></div>

  <form id="claimForm" onsubmit="submitClaim(event)">

    <!-- IDENTITÉ -->
    <div class="form-section">
      <div class="form-section-title">Ton identité</div>
      <div class="form-row">
        <div class="form-group">
          <label>Nom d'artiste / Studio *</label>
          <input type="text" id="f_nom" value="${nom.replace(/"/g,'&quot;')}" placeholder="ex: Julien Tattoo Studio" required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Email *</label>
          <input type="email" id="f_email" value="${(t.email||'').replace(/"/g,'&quot;')}" placeholder="toi@monmail.fr" required>
        </div>
        <div class="form-group">
          <label>Téléphone</label>
          <input type="tel" id="f_tel" value="${(t.telephone||'').replace(/"/g,'&quot;')}" placeholder="06 12 34 56 78">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Mot de passe * (6 car. min.)</label>
          <input type="password" id="f_pwd" placeholder="••••••••" required minlength="6">
        </div>
      </div>
    </div>

    <hr class="divider">

    <!-- SPÉCIALITÉS -->
    <div class="form-section">
      <div class="form-section-title">Tes spécialités <span class="req">*</span></div>
      <p style="font-size:12px;color:#6b7280;margin-bottom:14px">Sélectionne tes styles de tatouage — plusieurs choix possibles</p>
      <div class="styles-grid" id="stylesGrid"></div>
      <input type="hidden" id="f_styles" value="[]">
    </div>

    <hr class="divider">

    <!-- DISPONIBILITÉ FLASH -->
    <div class="form-section">
      <div class="form-section-title">Disponibilité</div>
      <div class="toggle-row" onclick="toggleDispo()">
        <div>
          <div class="toggle-label">⚡ Disponible pour tatouer aujourd'hui</div>
          <div class="toggle-sub">Votre fiche sera mise en avant dans les résultats "Dispo aujourd'hui"</div>
        </div>
        <div class="toggle-switch" id="dispoSwitch"></div>
      </div>
      <input type="hidden" id="f_dispo" value="0">
    </div>

    <!-- HORAIRES -->
    <div class="form-section">
      <div class="form-section-title">Horaires d'ouverture</div>
      <div class="horaires-grid" id="horairesGrid"></div>
    </div>

    <button type="submit" class="submit-btn" id="submitBtn">
      Créer mon compte — c'est gratuit ♥
    </button>

    <p class="already">Déjà inscrit ? <a href="/dashboard">Accéder à mon espace</a></p>
  </form>

</div>

<script>
const TATOUEUR_ID = ${t.id};
const DAYS = [
  {key:'lun',label:'Lun'},{key:'mar',label:'Mar'},{key:'mer',label:'Mer'},
  {key:'jeu',label:'Jeu'},{key:'ven',label:'Ven'},{key:'sam',label:'Sam'},{key:'dim',label:'Dim'}
];
const defaults = {lun:true,mar:true,mer:true,jeu:true,ven:true,sam:false,dim:false};

// Build horaires grid
const grid = document.getElementById('horairesGrid');
DAYS.forEach(d => {
  const isOpen = defaults[d.key];
  const row = document.createElement('div');
  row.className = 'h-row';
  row.id = 'row_'+d.key;
  row.innerHTML = \`
    <div class="h-day">\${d.label}</div>
    <div class="h-toggle \${isOpen?'on':''}" id="ht_\${d.key}" onclick="toggleDay('\${d.key}')"></div>
    <div class="h-times" id="ht_times_\${d.key}" style="\${isOpen?'':'display:none'}">
      <input type="time" id="ht_from_\${d.key}" value="10:00">
      <span>→</span>
      <input type="time" id="ht_to_\${d.key}" value="19:00">
    </div>
    <div class="h-closed" id="ht_closed_\${d.key}" style="\${isOpen?'display:none':''}">Fermé</div>
  \`;
  grid.appendChild(row);
});

// Build styles pills
const TATTOO_STYLES = ['Fine Line','Japonais','Réalisme','Géométrique','Tribal','Old School','Aquarelle','Blackwork','Minimaliste','Lettering','Chicano','Dotwork','Néo-traditionnel','Animaux','Flash','Sur-mesure'];
const selectedStyles = new Set();
const stylesGrid = document.getElementById('stylesGrid');
TATTOO_STYLES.forEach(s => {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'style-pill';
  pill.textContent = s;
  pill.onclick = () => {
    if (selectedStyles.has(s)) { selectedStyles.delete(s); pill.classList.remove('active'); }
    else { selectedStyles.add(s); pill.classList.add('active'); }
    document.getElementById('f_styles').value = JSON.stringify([...selectedStyles]);
  };
  stylesGrid.appendChild(pill);
});

function toggleDay(key) {
  const t = document.getElementById('ht_'+key);
  const times = document.getElementById('ht_times_'+key);
  const closed = document.getElementById('ht_closed_'+key);
  t.classList.toggle('on');
  const isOn = t.classList.contains('on');
  times.style.display = isOn ? '' : 'none';
  closed.style.display = isOn ? 'none' : '';
}

function toggleDispo() {
  const sw = document.getElementById('dispoSwitch');
  sw.classList.toggle('on');
  document.getElementById('f_dispo').value = sw.classList.contains('on') ? '1' : '0';
}

function getHoraires() {
  const h = {};
  DAYS.forEach(d => {
    const open = document.getElementById('ht_'+d.key).classList.contains('on');
    h[d.key] = {
      open,
      from: document.getElementById('ht_from_'+d.key)?.value || '10:00',
      to: document.getElementById('ht_to_'+d.key)?.value || '19:00'
    };
  });
  return JSON.stringify(h);
}

async function submitClaim(e) {
  e.preventDefault();
  const err = document.getElementById('errMsg');
  const btn = document.getElementById('submitBtn');
  err.style.display = 'none';

  if (selectedStyles.size === 0) {
    err.textContent = 'Sélectionne au moins une spécialité pour continuer.';
    err.style.display = 'block';
    document.getElementById('stylesGrid').scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Création en cours…';

  const body = {
    nom: document.getElementById('f_nom').value.trim(),
    email: document.getElementById('f_email').value.trim(),
    telephone: document.getElementById('f_tel').value.trim(),
    password: document.getElementById('f_pwd').value,
    dispo_flash: document.getElementById('f_dispo').value === '1',
    horaires: getHoraires(),
    styles: [...selectedStyles],
  };

  try {
    const r = await fetch('/api/claim/' + TATOUEUR_ID, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      err.textContent = data.error || 'Une erreur est survenue.';
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = "Créer mon compte — c'est gratuit ♥";
      return;
    }
    // Succès → dashboard
    window.location.href = '/dashboard?welcome=1';
  } catch(_) {
    err.textContent = 'Erreur réseau, réessayez.';
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = '✨ Créer mon compte gratuit →';
  }
}
</script>
</body>
</html>`);
});

// POST /api/claim/:id — crée le compte artiste + lie la fiche tatoueur
app.post('/api/claim/:id', async (req, res) => {
  try {
    const { db } = require('./db/database');
    const bcrypt = require('bcryptjs');
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';

    const ficheId = parseInt(req.params.id);
    const { nom, email, telephone, password, dispo_flash, horaires, styles } = req.body;

    if (!nom || !email || !password) return res.status(400).json({ error: 'Nom, email et mot de passe requis.' });
    if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min.).' });

    // Vérifier que la fiche existe et n'est pas encore réclamée
    const fiche = db.prepare("SELECT * FROM tatoueurs WHERE id=? AND statut='active'").get(ficheId);
    if (!fiche) return res.status(404).json({ error: 'Fiche introuvable.' });
    if (fiche.claimed === 1 || fiche.user_id) return res.status(409).json({ error: 'Cette fiche est déjà réclamée.' });

    // Vérifier que l'email n'est pas déjà utilisé
    const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé. Connectez-vous.' });

    const hash = await bcrypt.hash(password, 10);
    const igHandle = (fiche.instagram_handle || '').replace(/^@/,'').replace(/.*instagram\.com\//i,'').replace(/[/?#].*/,'').trim();

    // Créer le compte artiste
    const userResult = db.prepare(`
      INSERT INTO users (email, password_hash, name, studio_name, city, phone, instagram, avatar_seed, is_pro, role)
      VALUES (?,?,?,?,?,?,?,?,0,'artist')
    `).run(
      email.toLowerCase().trim(),
      hash,
      nom.trim(),
      nom.trim(),
      fiche.ville || '',
      (telephone || '').trim(),
      igHandle ? '@' + igHandle : (fiche.instagram || ''),
      nom.toLowerCase().replace(/\s/g, '')
    );
    const userId = userResult.lastInsertRowid;

    // Lier la fiche tatoueur au nouveau compte + enrichir avec les données du formulaire
    db.prepare(`
      UPDATE tatoueurs SET
        user_id        = ?,
        claimed        = 1,
        nom_commercial = ?,
        telephone      = COALESCE(NULLIF(?, ''), telephone),
        horaires       = ?,
        dispo_flash    = ?,
        styles         = ?
      WHERE id=?
    `).run(
      userId,
      nom.trim(),
      (telephone || '').trim(),
      horaires || '',
      dispo_flash ? 1 : 0,
      JSON.stringify(Array.isArray(styles) ? styles : []),
      ficheId
    );

    // Initialiser les automations par défaut si dispo
    try {
      const { initDefaultAutomations } = require('./db/database');
      if (typeof initDefaultAutomations === 'function') initDefaultAutomations(userId);
    } catch(_) {}

    // Émettre le cookie JWT (90 jours)
    const token = jwt.sign({ userId, email: email.toLowerCase().trim() }, JWT_SECRET, { expiresIn: '90d' });
    res.cookie('inkr_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 90 * 24 * 3600 * 1000,
    });

    res.json({ ok: true, userId, ficheId });
  } catch(e) {
    console.error('[claim]', e.message);
    res.status(500).json({ error: 'Erreur serveur : ' + e.message });
  }
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

// ============ API OUTREACH — mise à jour statut CRM ============
app.post('/api/admin/outreach', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(401).json({ error: 'Non autorisé' });
  const { id, status, notes } = req.body;
  if (!id) return res.status(400).json({ error: 'id requis' });
  const { db } = require('./db/database');
  const date = status !== 'non_contacte' ? new Date().toISOString().slice(0,10) : null;
  db.prepare("UPDATE tatoueurs SET outreach_status=?, outreach_date=?, outreach_notes=? WHERE id=?")
    .run(status, date, notes||null, id);
  res.json({ success: true });
});

// ============ CRM OUTREACH — page de suivi des contacts ============
app.get('/admin/outreach', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) {
    return res.redirect(`/admin?next=/admin/outreach`);
  }
  const { db } = require('./db/database');
  const statusFilter = req.query.status || '';
  const deptFilter   = req.query.dept   || '';
  const search       = req.query.q      || '';

  let sql = `SELECT id, nom, ville, cp, instagram_handle, telephone, outreach_status, outreach_date, outreach_notes
             FROM tatoueurs WHERE statut='active' AND instagram_handle != '' AND instagram_handle IS NOT NULL`;
  const params = [];
  if (statusFilter) { sql += ' AND outreach_status=?'; params.push(statusFilter); }
  if (deptFilter)   { sql += ' AND cp LIKE ?'; params.push(deptFilter+'%'); }
  if (search)       { sql += ' AND (LOWER(nom) LIKE ? OR LOWER(ville) LIKE ? OR instagram_handle LIKE ?)'; params.push('%'+search.toLowerCase()+'%','%'+search.toLowerCase()+'%','%'+search+'%'); }
  sql += ' ORDER BY CASE outreach_status WHEN "non_contacte" THEN 0 WHEN "contacte" THEN 1 WHEN "repondu" THEN 2 WHEN "inscrit" THEN 3 ELSE 4 END, ville ASC LIMIT 200';

  const rows = db.prepare(sql).all(...params);

  const stats = db.prepare(`SELECT outreach_status, COUNT(*) as n FROM tatoueurs WHERE instagram_handle!='' AND instagram_handle IS NOT NULL GROUP BY outreach_status`).all();
  const statMap = {};
  stats.forEach(s => statMap[s.outreach_status] = s.n);
  const totalWithIg = Object.values(statMap).reduce((a,b)=>a+b,0);

  const STATUS_LABELS = { non_contacte:'🔵 Non contacté', contacte:'📨 Contacté', repondu:'💬 A répondu', inscrit:'✅ Inscrit' };
  const STATUS_COLORS = { non_contacte:'#374151', contacte:'#1d4ed8', repondu:'#d97706', inscrit:'#16a34a' };

  const tableRows = rows.map(t => `
    <tr id="row-${t.id}">
      <td><strong>${t.nom}</strong></td>
      <td style="color:#9ca3af">${t.ville||'—'}</td>
      <td>
        ${t.instagram_handle ? `<a href="https://instagram.com/${t.instagram_handle}" target="_blank" style="color:#a855f7;text-decoration:none;">@${t.instagram_handle}</a>` : '—'}
      </td>
      <td>
        <a href="/t/${t.id}" target="_blank" style="color:#60a5fa;font-size:12px;text-decoration:none;">🔗 Fiche</a>
      </td>
      <td>
        <select onchange="updateStatus(${t.id},this.value)"
          style="background:${STATUS_COLORS[t.outreach_status]||'#374151'};border:none;border-radius:6px;color:#fff;padding:4px 8px;font-size:12px;cursor:pointer;">
          <option value="non_contacte" ${t.outreach_status==='non_contacte'?'selected':''}>🔵 Non contacté</option>
          <option value="contacte"     ${t.outreach_status==='contacte'?'selected':''}>📨 Contacté</option>
          <option value="repondu"      ${t.outreach_status==='repondu'?'selected':''}>💬 A répondu</option>
          <option value="inscrit"      ${t.outreach_status==='inscrit'?'selected':''}>✅ Inscrit</option>
        </select>
      </td>
      <td style="color:#9ca3af;font-size:12px">${t.outreach_date||'—'}</td>
      <td>
        <input type="text" placeholder="Note..." value="${(t.outreach_notes||'').replace(/"/g,'&quot;')}"
          onblur="saveNote(${t.id},this.value)"
          style="background:#1f2937;border:1px solid #374151;border-radius:6px;color:#e5e7eb;padding:4px 8px;font-size:12px;width:160px;"/>
      </td>
      <td>
        <a href="https://instagram.com/${t.instagram_handle}" target="_blank"
          onclick="updateStatus(${t.id},'contacte')"
          style="padding:4px 10px;background:#a855f7;border-radius:6px;color:#fff;font-size:12px;text-decoration:none;white-space:nowrap;">
          ✉️ DM
        </a>
      </td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>inkr · CRM Outreach</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d1a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px}
h1{font-size:24px;font-weight:800;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
.sub{color:#6b7280;font-size:13px;margin-bottom:20px}
.stats{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.stat{background:#1a1a2e;border:1px solid #2a2a3e;border-radius:10px;padding:12px 20px;cursor:pointer;transition:.15s}
.stat:hover{border-color:#a855f7}
.stat-n{font-size:28px;font-weight:800}
.stat-l{font-size:11px;color:#6b7280;margin-top:2px}
.filters{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filters input,.filters select{background:#1a1a2e;border:1px solid #374151;border-radius:8px;color:#e5e7eb;padding:8px 12px;font-size:13px}
.filters input{width:220px}
table{width:100%;border-collapse:collapse;background:#111827;border-radius:12px;overflow:hidden;font-size:13px}
th{background:#0d0d1a;padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
td{padding:10px 12px;border-top:1px solid #1f2937}
tr:hover td{background:#1a1a2e}
.back{display:inline-block;margin-bottom:16px;color:#a855f7;text-decoration:none;font-size:13px}
.tip{background:#1a1a2e;border:1px solid #374151;border-radius:10px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#9ca3af;line-height:1.6}
.tip strong{color:#e5e7eb}
</style></head>
<body>
<a href="/admin?key=${secret}" class="back">← Back office</a>
<h1>CRM Outreach Instagram</h1>
<div class="sub">${totalWithIg.toLocaleString('fr-FR')} tatoueurs avec Instagram à contacter</div>

<div class="tip">
  <strong>🎯 Comment utiliser :</strong> clique sur <strong>✉️ DM</strong> → ça ouvre Instagram + marque automatiquement "Contacté". Change le statut au fur et à mesure. Ajoute des notes si besoin.
</div>

<div class="stats">
  <div class="stat" onclick="filterStatus('')"><div class="stat-n">${totalWithIg.toLocaleString()}</div><div class="stat-l">Total avec Instagram</div></div>
  <div class="stat" onclick="filterStatus('non_contacte')"><div class="stat-n" style="color:#60a5fa">${(statMap['non_contacte']||0).toLocaleString()}</div><div class="stat-l">🔵 Non contactés</div></div>
  <div class="stat" onclick="filterStatus('contacte')"><div class="stat-n" style="color:#a855f7">${(statMap['contacte']||0).toLocaleString()}</div><div class="stat-l">📨 Contactés</div></div>
  <div class="stat" onclick="filterStatus('repondu')"><div class="stat-n" style="color:#f59e0b">${(statMap['repondu']||0).toLocaleString()}</div><div class="stat-l">💬 Ont répondu</div></div>
  <div class="stat" onclick="filterStatus('inscrit')"><div class="stat-n" style="color:#4ade80">${(statMap['inscrit']||0).toLocaleString()}</div><div class="stat-l">✅ Inscrits</div></div>
</div>

<div class="filters">
  <input type="text" id="search" placeholder="🔍 Nom, ville, @handle..." value="${search}" oninput="debounceSearch(this.value)"/>
  <select id="dept" onchange="applyFilters()" >
    <option value="">📍 Département</option>
    <option value="75" ${deptFilter==='75'?'selected':''}>75 — Paris</option>
    <option value="13" ${deptFilter==='13'?'selected':''}>13 — Marseille</option>
    <option value="69" ${deptFilter==='69'?'selected':''}>69 — Lyon</option>
    <option value="31" ${deptFilter==='31'?'selected':''}>31 — Toulouse</option>
    <option value="33" ${deptFilter==='33'?'selected':''}>33 — Bordeaux</option>
    <option value="59" ${deptFilter==='59'?'selected':''}>59 — Lille</option>
    <option value="06" ${deptFilter==='06'?'selected':''}>06 — Nice</option>
    <option value="44" ${deptFilter==='44'?'selected':''}>44 — Nantes</option>
    <option value="67" ${deptFilter==='67'?'selected':''}>67 — Strasbourg</option>
    <option value="35" ${deptFilter==='35'?'selected':''}>35 — Rennes</option>
  </select>
  <select id="status-filter" onchange="applyFilters()">
    <option value="" ${!statusFilter?'selected':''}>Tous les statuts</option>
    <option value="non_contacte" ${statusFilter==='non_contacte'?'selected':''}>🔵 Non contactés</option>
    <option value="contacte"     ${statusFilter==='contacte'?'selected':''}>📨 Contactés</option>
    <option value="repondu"      ${statusFilter==='repondu'?'selected':''}>💬 Ont répondu</option>
    <option value="inscrit"      ${statusFilter==='inscrit'?'selected':''}>✅ Inscrits</option>
  </select>
</div>

<table>
  <thead><tr><th>Nom</th><th>Ville</th><th>Instagram</th><th>Fiche</th><th>Statut</th><th>Date</th><th>Notes</th><th>Action</th></tr></thead>
  <tbody>${tableRows||'<tr><td colspan="8" style="text-align:center;padding:40px;color:#666">Aucun résultat</td></tr>'}</tbody>
</table>

<script>
const SECRET = '${secret}';
let searchTimer;

async function updateStatus(id, status) {
  const notes = document.querySelector('#row-'+id+' input')?.value||'';
  await fetch('/api/admin/outreach?secret='+SECRET, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({id, status, notes})
  });
  // Update select color
  const sel = document.querySelector('#row-'+id+' select');
  if(sel){
    const colors={non_contacte:'#374151',contacte:'#1d4ed8',repondu:'#d97706',inscrit:'#16a34a'};
    sel.style.background = colors[status]||'#374151';
    sel.value = status;
  }
  // Update date
  const dateCells = document.querySelectorAll('#row-'+id+' td');
  if(dateCells[5] && status !== 'non_contacte') dateCells[5].textContent = new Date().toISOString().slice(0,10);
}

async function saveNote(id, notes) {
  const sel = document.querySelector('#row-'+id+' select');
  const status = sel?.value || 'contacte';
  await fetch('/api/admin/outreach?secret='+SECRET, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({id, status, notes})
  });
}

function filterStatus(s) {
  const url = new URL(window.location);
  url.searchParams.set('status', s);
  url.searchParams.set('secret', SECRET);
  window.location = url;
}

function applyFilters() {
  const url = new URL(window.location);
  url.searchParams.set('status', document.getElementById('status-filter').value);
  url.searchParams.set('dept', document.getElementById('dept').value);
  url.searchParams.set('q', document.getElementById('search').value);
  url.searchParams.set('secret', SECRET);
  window.location = url;
}

function debounceSearch(v) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilters, 600);
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
