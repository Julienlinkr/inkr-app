# PROMPT REPLIT — inkr, plateforme SaaS pour tatoueurs

## CONTEXTE

Tu vas créer **inkr** — une plateforme SaaS complète pour tatoueurs professionnels. C'est un produit à 39€/mois qui remplace Planity/Booksy en ajoutant CRM, campagnes marketing, programme de fidélité, channel manager (WhatsApp + Instagram), et paiements Stripe.

Stack : **Node.js + Express + SQLite (node:sqlite natif Node 22+) + HTML/CSS/JS vanilla**. Pas de framework frontend. Pas de React. Tout en fichiers statiques servis par Express.

---

## ARCHITECTURE

```
inkr-app/
├── server.js              ← point d'entrée Express
├── db/database.js         ← SQLite + migrations
├── routes/
│   ├── auth.js            ← auth artiste (register/login JWT)
│   ├── client_auth.js     ← auth client (compte client séparé)
│   ├── clients.js         ← CRM clients
│   ├── appointments.js    ← rendez-vous + acomptes Stripe
│   ├── campaigns.js       ← campagnes email/SMS + Resend + Twilio
│   ├── payments.js        ← Stripe Checkout pour acomptes
│   ├── webhooks.js        ← webhook Meta (WhatsApp + Instagram DMs)
│   ├── loyalty.js         ← programme de fidélité (points/paliers)
│   ├── annuaire.js        ← annuaire public des artistes
│   ├── artist_photos.js   ← upload photos portfolio
│   ├── tournee.js         ← mode tournée (artiste en déplacement)
│   └── mobile.js          ← API mobile artiste
├── public/
│   ├── index.html         ← site client (annuaire + landing + tarifs)
│   └── dashboard.html     ← back-office artiste
└── emails/
    └── welcome.html       ← template email bienvenue
```

---

## BASE DE DONNÉES (SQLite node:sqlite)

### Tables à créer :

```sql
-- Artistes
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  prenom TEXT DEFAULT '',
  nom_artiste TEXT DEFAULT '',
  studio_name TEXT,
  city TEXT,
  adresse TEXT DEFAULT '',
  phone TEXT,
  instagram TEXT DEFAULT '',
  pinterest TEXT DEFAULT '',
  meta_wa_phone_id TEXT,   -- WhatsApp Business phone ID
  meta_ig_page_id TEXT,    -- Instagram Page ID
  en_tournee INTEGER DEFAULT 0,
  role TEXT DEFAULT 'artist',
  avatar_seed TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Clients (CRM par artiste)
CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  prenom TEXT DEFAULT '',
  email TEXT,
  phone TEXT,
  whatsapp TEXT DEFAULT '',
  instagram TEXT DEFAULT '',
  city TEXT,
  age INTEGER DEFAULT 0,
  date_naissance TEXT DEFAULT '',
  notes TEXT,
  tags TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Rendez-vous
CREATE TABLE appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  client_id INTEGER,
  client_name TEXT,
  client_email TEXT,
  client_phone TEXT,
  style TEXT,
  body_zone TEXT,
  size TEXT,
  description TEXT,
  date TEXT,
  time TEXT,
  duration INTEGER DEFAULT 2,
  price REAL,
  deposit REAL DEFAULT 50,
  acompte_amount REAL DEFAULT 0,
  acompte_status TEXT DEFAULT 'none',  -- none / pending / paid
  acompte_stripe_url TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',       -- pending / confirmed / completed / cancelled
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Campagnes marketing
CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  template TEXT,
  message TEXT NOT NULL,
  channels TEXT DEFAULT '[]',  -- ["email","sms","whatsapp"]
  audience TEXT DEFAULT 'all', -- 'all' ou 'tags:flash,japonais'
  status TEXT DEFAULT 'draft', -- draft / sent
  sent_count INTEGER DEFAULT 0,
  open_count INTEGER DEFAULT 0,
  scheduled_at DATETIME,
  sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Messagerie unifiée (Instagram DMs + WhatsApp + email)
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  client_id INTEGER DEFAULT NULL,
  client_name TEXT,
  client_seed TEXT,
  channel TEXT DEFAULT 'email',   -- email / whatsapp / instagram
  direction TEXT DEFAULT 'in',    -- in / out
  content TEXT NOT NULL,
  external_id TEXT DEFAULT NULL,  -- ID message WhatsApp/Instagram
  phone TEXT DEFAULT NULL,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Automatisations (rappels, suivis, anniversaires)
CREATE TABLE automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,     -- sms_24h_before / followup_j5 / birthday / auto_reply_whatsapp...
  enabled INTEGER DEFAULT 1,
  message TEXT,
  delay_value INTEGER DEFAULT 1,
  delay_unit TEXT DEFAULT 'day',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Programme de fidélité
CREATE TABLE loyalty_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  artist_id INTEGER NOT NULL,
  points INTEGER NOT NULL,        -- positif = gain, négatif = utilisation
  reason TEXT DEFAULT '',
  appointment_id INTEGER DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Artistes annuaire (tatoueurs importés + inscrits)
CREATE TABLE tatoueurs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  ville TEXT NOT NULL,
  instagram TEXT DEFAULT '',
  styles TEXT DEFAULT '[]',
  bio TEXT DEFAULT '',
  lat REAL DEFAULT 0,
  lng REAL DEFAULT 0,
  statut TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Dates de tournée
CREATE TABLE tournee_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  city TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  description TEXT DEFAULT '',
  spots INTEGER DEFAULT 5,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## BACKEND — server.js

```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();

// ⚠️ WEBHOOKS avant express.json() — body brut requis pour vérification HMAC
const { webhookRouter } = require('./routes/payments');
app.use('/api/payments/webhook', webhookRouter);
app.use('/api/webhooks', require('./routes/webhooks'));

// Middlewares
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Routes API
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/clients',      require('./routes/clients'));
app.use('/api/campaigns',    require('./routes/campaigns'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/payments',     require('./routes/payments'));
app.use('/api/loyalty',      require('./routes/loyalty'));
app.use('/api/annuaire',     require('./routes/annuaire'));
app.use('/api/tournee',      require('./routes/tournee'));
app.use('/api/artist-photos',require('./routes/artist_photos'));
app.use('/api/client',       require('./routes/client_auth'));

// Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// Status
app.get('/api/status', (req, res) => res.json({
  status: 'ok',
  services: {
    email:       !!process.env.RESEND_API_KEY,
    sms:         !!(process.env.TWILIO_ACCOUNT_SID),
    stripe:      !!process.env.STRIPE_SECRET_KEY,
    whatsapp:    !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
    instagram:   !!process.env.INSTAGRAM_PAGE_TOKEN,
    meta_webhook:!!process.env.META_VERIFY_TOKEN,
  }
}));

app.listen(process.env.PORT || 3000, '0.0.0.0');
```

---

## VARIABLES D'ENVIRONNEMENT (.env)

```env
# Auth
JWT_SECRET=inkr_secret_changeme_en_prod

# Email (resend.com — gratuit 3000/mois)
RESEND_API_KEY=re_xxxxxxxxxxxx
EMAIL_FROM=inkr <noreply@inkr.club>

# SMS (twilio.com)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxx
TWILIO_PHONE=+33xxxxxxxxx

# Stripe (stripe.com — mode test)
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx

# Meta (developers.facebook.com)
META_VERIFY_TOKEN=inkr_webhook_2026
META_APP_SECRET=xxxxxxxxxxxx
WHATSAPP_TOKEN=xxxxxxxxxxxx
WHATSAPP_PHONE_ID=xxxxxxxxxxxx
INSTAGRAM_PAGE_TOKEN=xxxxxxxxxxxx

# App
APP_URL=https://www.inkr.club
DB_PATH=db/inkr.db
```

---

## FEATURES FRONTEND — index.html (site client public)

### Landing / Hero
- Vidéo fullscreen en fond (`public/videos/hero.mp4`), autoplay muted loop
- Overlay blanc semi-transparent gauche pour lisibilité du texte noir
- H1 : "Ton prochain tatouage, commence ici."
- Badge animé "Plateforme N°1 en Europe · +4 200 artistes"
- Barre de recherche pill avec bordure prismatique (effet Apple Vision Pro) :
  - Champ "Où" avec autocomplétion villes françaises + géolocalisation
  - Champ "Style" (select : Fine Line, Japonais, Réalisme, Blackwork, etc.)
  - Bouton CTA "Trouver mon tatoueur →"

### Annuaire artistes
- Grille de cards artistes avec photo/avatar, nom, ville, styles, note
- Filtres : ville, style, disponibilité, tournée
- Vue split : liste à gauche + carte Leaflet droite (sticky)
- Carte Leaflet avec tuiles CartoDB Voyager (fond clair)
- Marqueurs : cercles noirs (#0A0A0A) avec initiales blanches
- Popups dark : nom artiste, ville, styles, bouton "Voir le profil"
- Modal profil artiste : portfolio photos, styles, bio, bouton réservation

### Page Tarifs
- Offre unique : **39€/mois tout inclus, sans commission**
- Tableau comparatif vs Planity / Booksy
- Cartes features avec animation au clic (démo interactive) :
  - Agenda & Réservation en ligne
  - Channel Manager (Instagram + WhatsApp)
  - Campagnes marketing flash
  - Programme de fidélité
  - CRM Clients complet
  - Acomptes Stripe
  - Automatisations (rappels, suivi cicatrisation, anniversaire)
  - IA Portfolio SEO (coming soon)
- Garanties : Sans commission · Sans engagement · Support 7j/7
- CTA : "Démarrer gratuitement 14 jours" → animation dermographe → redirect dashboard register

### Navigation SPA
- Onglets : Accueil / Artistes / Flash / Tarifs
- `showView(id)` pour switcher entre vues sans rechargement
- Animation dermographe (machine à tatouer) entre les transitions

---

## FEATURES DASHBOARD — dashboard.html (back-office artiste)

**Design : noir/blanc éditorial (thème dark, style Linear/Vercel)**

### Auth artiste
- Login / Register sur la même page
- JWT stocké en cookie httpOnly
- Redirect automatique si déjà connecté

### Vues dashboard (menu latéral noir)

**1. Vue d'ensemble**
- Compteurs : RDV du jour, revenus du mois, clients total, messages non lus
- Planning hebdomadaire
- Prochains rendez-vous
- Sélecteur de date (avec dark mode pour l'icône calendrier)

**2. Agenda**
- Calendrier mensuel avec points de couleur par statut
- Liste des RDV avec statut (pending/confirmed/completed/cancelled)
- Bouton "Demander un acompte" → Stripe Checkout → email confirmation client
- Modifier statut, date, prix

**3. Clients (CRM)**
- Liste avec recherche, tri, tags
- Fiche client : nom, prénom, email, téléphone, WhatsApp, Instagram, notes, tags, historique RDV
- Tags par style (flash, japonais, réalisme...)
- Bouton "Envoyer message" depuis la fiche

**4. Messagerie unifiée**
- Canaux : Instagram DM / WhatsApp / Email (tabs)
- Liste conversations à gauche, chat à droite
- Indicateur de messages non lus
- Réponse directe depuis le dashboard
- Auto-reply configurable par canal

**5. Campagnes marketing**
- Créer campagne : nom, message (avec variables {{prénom}} {{studio}}), canaux (email/SMS/WhatsApp), audience (tous / par tags)
- Envoyer immédiatement ou planifier
- Tracking : envoyés / ouverts
- Templates : Flash promo / Relance / Anniversaire / Nouveau design

**6. Programme de fidélité**
- Paliers : Bronze (0-199 pts) / Silver (200-499 pts) / Gold (500+ pts)
- 1 point par euro dépensé, attribution automatique quand RDV → completed
- Attribution manuelle depuis la fiche client
- Utilisation : réductions, flash offert

**7. Automatisations**
- Rappel SMS/email 24h avant RDV
- Suivi cicatrisation J+5
- Retouche gratuite J+30 (optionnel)
- Relance inactivité 3 mois
- Message anniversaire avec code promo
- Auto-reply WhatsApp/Instagram (message d'absence)
- Chaque automation : toggle on/off + message personnalisable

**8. Portfolio**
- Upload photos (multer)
- Grille Instagram-style
- Lien vers profil public dans l'annuaire

**9. Profil artiste**
- Studio name, bio, styles (multi-select), ville, adresse
- Instagram, Pinterest
- Mode "En tournée" (toggle) → apparaît en tournée dans l'annuaire
- Dates de tournée (villes + dates)

**10. Paiements**
- Historique des acomptes (paid / pending / none)
- Lien vers Stripe Dashboard

---

## INTÉGRATIONS

### Stripe (acomptes de réservation)
- `POST /api/payments/create-checkout` → session Stripe Checkout
- Webhook `checkout.session.completed` → update `acompte_status = 'paid'` + email confirmation
- Mode test disponible : carte `4242 4242 4242 4242`
- Fallback simulation si `STRIPE_SECRET_KEY` absent

### Email — Resend (resend.com)
- `sendEmail(to, subject, text, artistUser, appUrl, campaignId?)`
- Template HTML : header noir inkr, body blanc, footer artiste avec coordonnées
- Tracking pixel 1x1 GIF pour les opens de campagne
- Fallback simulation si `RESEND_API_KEY` absent

### SMS — Twilio
- `sendSMS(to, message)` depuis campaigns.js
- Fallback simulation si clés absentes

### WhatsApp — Meta Cloud API (gratuit)
- `POST https://graph.facebook.com/v19.0/{WHATSAPP_PHONE_ID}/messages`
- Réception via webhook `POST /api/webhooks/meta`
- Vérification signature HMAC-SHA256 avec `META_APP_SECRET`
- Vérification webhook `GET /api/webhooks/meta?hub.mode=subscribe&hub.verify_token=...`

### Instagram DMs — Meta Graph API
- Réception messages via `entry.messaging` dans le webhook Meta
- Envoi : `POST https://graph.facebook.com/v19.0/me/messages`

---

## CHARTE GRAPHIQUE

**Couleurs :**
- Noir : `#0A0A0A`
- Blanc : `#FFFFFF`
- Gris texte : `#6E6E73`
- Gris fond : `#F5F5F7`
- Accent gradient : `linear-gradient(135deg, #a855f7, #ec4899)` (violet → rose, UNIQUEMENT pour les CTAs)

**Typographie :**
- Font : `-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`
- Poids : 400 / 600 / 700 / 900
- Letter-spacing négatif sur les titres

**Dashboard (dark) :**
- Background : `#0A0A0A`
- Cards : `#111` avec border `rgba(255,255,255,.07)`
- Texte primaire : `#FFFFFF`
- Texte secondaire : `rgba(255,255,255,.45)`
- Inputs : `background:#1a1a1a; border:1px solid rgba(255,255,255,.1)`

**Site client (light) :**
- Background : `#FFFFFF`
- Sections alternées : `#F5F5F7`
- Texte : `#0A0A0A`

---

## RÈGLES DE DÉVELOPPEMENT

1. **Pas de dépendances inutiles** — utilise node:sqlite natif (Node 22+), pas better-sqlite3
2. **Graceful degradation** — chaque service (Stripe, Resend, Twilio, Meta) fonctionne en mode simulation si les clés sont absentes
3. **Auth dual** — cookie httpOnly pour le web, Bearer token pour le mobile
4. **runMigrations()** — toutes les colonnes ajoutées après création initiale passent par le pattern `ALTER TABLE ... ADD COLUMN` dans un try/catch
5. **Commentaires développeur** — chaque fichier route commence par un bloc de commentaires expliquant les variables d'environnement requises et le flux de données
6. **Pas de SQL injection** — toujours utiliser les prepared statements (`db.prepare(...).run(...)`)
7. **CORS** — `origin: true, credentials: true` pour supporter les cookies cross-origin en dev

---

## PACKAGE.JSON

```json
{
  "name": "inkr-app",
  "version": "1.0.0",
  "main": "server.js",
  "engines": { "node": ">=22.5.0" },
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^4.18.2",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2",
    "dotenv": "^16.4.1",
    "cors": "^2.8.5",
    "resend": "^3.0.0",
    "multer": "^1.4.5-lts.1",
    "twilio": "^4.23.0",
    "cookie-parser": "^1.4.6",
    "stripe": "^14.0.0"
  }
}
```

---

## DEPLOY (Railway)

- `npm start` → `node server.js`
- Volume persistant monté sur `/data` pour la SQLite en prod (`DB_PATH=/data/inkr.db`)
- Variables d'environnement dans Railway → Variables tab
- Auto-deploy depuis GitHub sur push `main`

---

Crée le projet complet avec toutes ces fonctionnalités. Commence par le backend (server.js + db + routes), puis le dashboard.html, puis index.html. Teste que le serveur démarre sans erreur avant de passer au frontend.
