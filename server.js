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

// ============ PAGES ============
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

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

app.listen(PORT, () => {
  console.log('\n🎨 ========================================');
  console.log(`   inkr — Serveur démarré avec succès !`);
  console.log(`   👉 http://localhost:${PORT}`);
  console.log('==========================================');
  console.log('\n📋 Services configurés :');
  console.log(`   Email  : ${process.env.EMAIL_USER && process.env.EMAIL_USER !== 'ton.email@gmail.com' ? '✅ Prêt' : '⚠️  Mode simulation (voir .env)'}`);
  console.log(`   SMS    : ${process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.startsWith('ACxx') ? '✅ Prêt' : '⚠️  Mode simulation (voir .env)'}`);
  console.log(`   Meta   : ${process.env.META_APP_ID ? '✅ Configuré' : '⚠️  Non configuré (voir .env)'}`);
  console.log('\n💡 Tous les envois non configurés sont simulés dans le terminal.');
  console.log('   Ouvre http://localhost:3000 dans ton navigateur !\n');
});
