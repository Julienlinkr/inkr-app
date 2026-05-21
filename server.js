require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ MIDDLEWARE ============
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ============ ROUTES API ============
app.use('/api/auth', require('./routes/auth'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/tournee', require('./routes/tournee'));
app.use('/api/annuaire', require('./routes/annuaire'));

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

// ============ STATUS ============
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    services: {
      email: !!(process.env.EMAIL_USER && process.env.EMAIL_USER !== 'ton.email@gmail.com'),
      sms: !!(process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.startsWith('ACxx')),
      meta: !!(process.env.META_APP_ID)
    }
  });
});

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
  console.log(`   DB     : ${process.env.DB_PATH || 'db/inkr.db (local)'}`);
  console.log('\n');
});
