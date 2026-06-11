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
app.use('/api/meta',    require('./routes/meta_oauth')); // OAuth Meta + lecture/envoi messages

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

// GET /api/admin/users?secret=XXX  → liste tous les artistes (debug)
app.get('/api/admin/users', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(401).json({ error: 'Non autorisé' });
  const { db } = require('./db/database');
  const users = db.prepare('SELECT id, email, name, is_pro, role, created_at FROM users ORDER BY id').all();
  res.json({ users });
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
});
