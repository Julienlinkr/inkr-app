/**
 * routes/quotes.js
 *
 * Gestion des devis artiste → client.
 *
 * ─── Flow complet ─────────────────────────────────────────────────────────────
 *  1. Artiste crée un devis (brouillon) depuis le dashboard
 *  2. Artiste envoie le devis → email au client avec boutons Accepter / Refuser
 *  3. Client clique Accepter → GET /api/quotes/respond/:token?action=accept
 *  4. Statut mis à jour en DB → artiste notifié par email
 *  5. Artiste peut demander un acompte directement depuis la fiche devis
 *
 * ─── Routes ───────────────────────────────────────────────────────────────────
 *  GET    /api/quotes              → liste des devis de l'artiste connecté
 *  POST   /api/quotes              → créer un devis
 *  GET    /api/quotes/:id          → détail d'un devis
 *  PUT    /api/quotes/:id          → mettre à jour un devis (brouillon)
 *  DELETE /api/quotes/:id          → supprimer un devis
 *  POST   /api/quotes/:id/send     → envoyer par email au client
 *  POST   /api/quotes/:id/acompte  → demander un acompte sur devis accepté
 *  GET    /api/quotes/respond/:token → client accepte ou refuse (public)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const { db }   = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'inkr_secret_dev';
const BASE_URL   = process.env.APP_URL || process.env.BASE_URL || 'https://inkr.club';

// ── Migration table quotes ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS quotes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL,
    client_id         INTEGER DEFAULT NULL,
    client_name       TEXT NOT NULL DEFAULT '',
    client_email      TEXT NOT NULL DEFAULT '',
    title             TEXT NOT NULL DEFAULT 'Devis tatouage',
    items             TEXT DEFAULT '[]',
    notes             TEXT DEFAULT '',
    valid_until       TEXT DEFAULT NULL,
    total             REAL DEFAULT 0,
    status            TEXT DEFAULT 'draft',
    token             TEXT DEFAULT NULL,
    acompte_requested INTEGER DEFAULT 0,
    acompte_amount    REAL DEFAULT 0,
    acompte_status    TEXT DEFAULT 'none',
    acompte_url       TEXT DEFAULT NULL,
    sent_at           DATETIME DEFAULT NULL,
    accepted_at       DATETIME DEFAULT NULL,
    refused_at        DATETIME DEFAULT NULL,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Migration table quote_products (modèles de prestations réutilisables) ─────
db.exec(`
  CREATE TABLE IF NOT EXISTS quote_products (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    price      REAL  DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Middleware auth artiste ───────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.inkr_token ||
    (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}

// ── Helper : calcul du total ──────────────────────────────────────────────────
function calcTotal(items) {
  try {
    const arr = typeof items === 'string' ? JSON.parse(items) : items;
    return arr.reduce((sum, it) => sum + (parseFloat(it.price) || 0) * (parseFloat(it.qty) || 1), 0);
  } catch { return 0; }
}

// ── Helper : envoyer email via le module campaigns ───────────────────────────
async function sendEmailQuote(toEmail, subject, htmlBody, artist) {
  try {
    const { Resend } = require('resend');
    if (!process.env.RESEND_API_KEY) {
      console.log(`[DEVIS EMAIL SIMULÉ] → ${toEmail}`);
      return { simulated: true };
    }
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.EMAIL_FROM || 'inkr <onboarding@resend.dev>';
    const result = await resend.emails.send({
      from,
      to: toEmail,
      subject,
      html: htmlBody,
      replyTo: artist?.email || undefined,
    });
    if (result.error) throw new Error(result.error.message);
    return result;
  } catch (e) {
    console.warn('[DEVIS EMAIL]', e.message);
    return { error: e.message };
  }
}

// ── Template email devis ──────────────────────────────────────────────────────
function buildQuoteEmail(quote, artist, items) {
  const artistName = [artist.prenom, artist.nom_artiste || artist.name].filter(Boolean).join(' ') || artist.name;
  const studioName = artist.studio_name || artistName;

  const acceptUrl = `${BASE_URL}/api/quotes/respond/${quote.token}?action=accept`;
  const refuseUrl = `${BASE_URL}/api/quotes/respond/${quote.token}?action=refuse`;

  const validText = quote.valid_until
    ? `<p style="font-size:13px;color:#888;margin:0 0 24px;">Ce devis est valable jusqu'au <strong>${new Date(quote.valid_until).toLocaleDateString('fr-FR')}</strong>.</p>`
    : '';

  const rows = items.map(it => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a1a1a;">${it.desc || '—'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#555;text-align:center;">${it.qty || 1}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#1a1a1a;text-align:right;font-weight:600;">${parseFloat(it.price || 0).toFixed(2)} €</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Devis — ${quote.title}</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- Header inkr -->
  <tr><td style="background:#0A0A0A;border-radius:16px 16px 0 0;padding:28px 36px;text-align:center;">
    <div style="font-size:38px;font-weight:900;letter-spacing:-1.5px;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899,#f97316);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;display:inline-block;">inkr</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.35);margin-top:6px;letter-spacing:1.5px;text-transform:uppercase;">DEVIS</div>
  </td></tr>

  <!-- Titre du devis -->
  <tr><td style="background:#ffffff;padding:36px 36px 24px;">
    <div style="font-size:22px;font-weight:800;color:#0a0a0a;margin-bottom:6px;">${quote.title}</div>
    <div style="font-size:13px;color:#888;">De la part de <strong style="color:#1a1a1a;">${studioName}</strong></div>
    ${validText}

    <!-- Tableau des prestations -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0f0f0;border-radius:8px;overflow:hidden;margin-top:16px;">
      <thead>
        <tr style="background:#f8f8f8;">
          <th style="padding:10px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#888;text-align:left;">Prestation</th>
          <th style="padding:10px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#888;text-align:center;">Qté</th>
          <th style="padding:10px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#888;text-align:right;">Prix</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        <tr style="background:#f8f8f8;">
          <td colspan="2" style="padding:13px 14px;font-size:15px;font-weight:800;color:#0a0a0a;text-align:right;">TOTAL</td>
          <td style="padding:13px 14px;font-size:18px;font-weight:900;color:#0a0a0a;text-align:right;">${quote.total.toFixed(2)} €</td>
        </tr>
      </tbody>
    </table>

    ${quote.notes ? `
    <div style="margin-top:20px;padding:14px;background:#f9f9f9;border-radius:8px;font-size:13px;color:#555;line-height:1.6;">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#aaa;margin-bottom:6px;">Notes & conditions</div>
      ${quote.notes.replace(/\n/g,'<br/>')}
    </div>` : ''}
  </td></tr>

  <!-- Boutons Accepter / Refuser -->
  <tr><td style="background:#ffffff;padding:8px 36px 36px;text-align:center;">
    <div style="margin-bottom:14px;font-size:14px;color:#555;">Que souhaitez-vous faire avec ce devis ?</div>
    <a href="${acceptUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#ffffff;border-radius:980px;font-size:15px;font-weight:700;text-decoration:none;margin:0 6px;">✅ Accepter</a>
    <a href="${refuseUrl}" style="display:inline-block;padding:14px 32px;background:#f1f1f1;color:#555;border-radius:980px;font-size:15px;font-weight:700;text-decoration:none;margin:0 6px;">❌ Refuser</a>
  </td></tr>

  <!-- Footer artiste -->
  <tr><td style="background:#0A0A0A;border-radius:0 0 16px 16px;padding:28px 36px;">
    <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:8px;">${studioName}</div>
    ${artist.city ? `<div style="font-size:13px;color:rgba(255,255,255,0.4);margin-bottom:4px;">📍 ${artist.city}</div>` : ''}
    ${artist.phone ? `<div style="font-size:13px;color:rgba(255,255,255,0.4);margin-bottom:4px;">📞 ${artist.phone}</div>` : ''}
    ${artist.email ? `<div style="font-size:13px;margin-bottom:4px;"><a href="mailto:${artist.email}" style="color:rgba(255,255,255,0.4);text-decoration:none;">✉️ ${artist.email}</a></div>` : ''}
    ${artist.instagram ? `<div style="font-size:13px;color:rgba(255,255,255,0.4);margin-bottom:4px;"><a href="https://instagram.com/${artist.instagram.replace('@','')}" style="color:rgba(255,255,255,0.4);text-decoration:none;">📸 ${artist.instagram}</a></div>` : ''}
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.07);font-size:11px;color:rgba(255,255,255,0.2);">
      Devis généré via <a href="https://inkr.club" style="color:rgba(255,255,255,0.3);text-decoration:none;">inkr</a> · La plateforme des tatoueurs
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  return html;
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/quotes/products ──────────────────────────────────────────────────
router.get('/products', requireAuth, (req, res) => {
  try {
    const products = db.prepare(
      'SELECT * FROM quote_products WHERE user_id = ? ORDER BY name ASC'
    ).all(req.user.userId);
    res.json({ products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/quotes/products ─────────────────────────────────────────────────
// Body: { name, price }
router.post('/products', requireAuth, (req, res) => {
  try {
    const { name, price } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
    const result = db.prepare(
      'INSERT INTO quote_products (user_id, name, price) VALUES (?, ?, ?)'
    ).run(req.user.userId, name.trim().slice(0, 100), parseFloat(price) || 0);
    const product = db.prepare('SELECT * FROM quote_products WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ product });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/quotes/products/:pid ─────────────────────────────────────────
router.delete('/products/:pid', requireAuth, (req, res) => {
  try {
    const p = db.prepare('SELECT id FROM quote_products WHERE id = ? AND user_id = ?')
      .get(req.params.pid, req.user.userId);
    if (!p) return res.status(404).json({ error: 'Produit introuvable' });
    db.prepare('DELETE FROM quote_products WHERE id = ?').run(p.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/quotes ───────────────────────────────────────────────────────────
// Params: ?client_id=X pour filtrer par client
router.get('/', requireAuth, (req, res) => {
  try {
    let sql = 'SELECT * FROM quotes WHERE user_id = ?';
    const params = [req.user.userId];
    if (req.query.client_id) {
      sql += ' AND client_id = ?';
      params.push(parseInt(req.query.client_id));
    }
    sql += ' ORDER BY created_at DESC';
    const quotes = db.prepare(sql).all(...params);
    res.json({ quotes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/quotes ──────────────────────────────────────────────────────────
// Body: { client_name, client_email, client_id?, title, items, notes, valid_until }
router.post('/', requireAuth, (req, res) => {
  try {
    const { client_name, client_email, client_id, title, items, notes, valid_until } = req.body;
    if (!client_email) return res.status(400).json({ error: 'Email client requis' });

    const itemsJson = typeof items === 'string' ? items : JSON.stringify(items || []);
    const total = calcTotal(itemsJson);

    const result = db.prepare(`
      INSERT INTO quotes (user_id, client_id, client_name, client_email, title, items, notes, valid_until, total, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `).run(req.user.userId, client_id || null, client_name || '', client_email, title || 'Devis tatouage', itemsJson, notes || '', valid_until || null, total);

    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ quote });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/quotes/:id ───────────────────────────────────────────────────────
router.get('/:id', requireAuth, (req, res) => {
  try {
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.userId);
    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
    res.json({ quote });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/quotes/:id ───────────────────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  try {
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.userId);
    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
    if (quote.status === 'sent' || quote.status === 'accepted') {
      return res.status(400).json({ error: 'Impossible de modifier un devis envoyé ou accepté' });
    }

    const { client_name, client_email, client_id, title, items, notes, valid_until } = req.body;
    const itemsJson = typeof items === 'string' ? items : JSON.stringify(items || JSON.parse(quote.items));
    const total = calcTotal(itemsJson);

    db.prepare(`
      UPDATE quotes SET
        client_name  = ?,
        client_email = ?,
        client_id    = ?,
        title        = ?,
        items        = ?,
        notes        = ?,
        valid_until  = ?,
        total        = ?,
        updated_at   = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      client_name  ?? quote.client_name,
      client_email ?? quote.client_email,
      client_id    ?? quote.client_id,
      title        ?? quote.title,
      itemsJson,
      notes        ?? quote.notes,
      valid_until  ?? quote.valid_until,
      total,
      quote.id
    );

    res.json({ quote: db.prepare('SELECT * FROM quotes WHERE id = ?').get(quote.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/quotes/:id ────────────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const q = db.prepare('SELECT id FROM quotes WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.userId);
    if (!q) return res.status(404).json({ error: 'Devis introuvable' });
    db.prepare('DELETE FROM quotes WHERE id = ?').run(q.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/quotes/:id/send ─────────────────────────────────────────────────
// Génère un token unique, envoie l'email au client, passe status → 'sent'
router.post('/:id/send', requireAuth, async (req, res) => {
  try {
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.userId);
    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
    if (!quote.client_email) return res.status(400).json({ error: 'Email client manquant' });

    // Récupérer les infos de l'artiste
    const artist = db.prepare(
      'SELECT name, prenom, nom_artiste, studio_name, email, city, phone, instagram FROM users WHERE id = ?'
    ).get(req.user.userId);

    // Générer / réutiliser le token
    const token = quote.token || crypto.randomBytes(24).toString('hex');
    const items = JSON.parse(quote.items || '[]');

    // Mettre à jour le statut et le token
    db.prepare(`
      UPDATE quotes SET status='sent', token=?, sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(token, quote.id);

    const updatedQuote = { ...quote, token, status: 'sent' };
    const html = buildQuoteEmail(updatedQuote, artist, items);
    const studioName = artist.studio_name || artist.name;

    const emailResult = await sendEmailQuote(
      quote.client_email,
      `📋 Votre devis de ${studioName} — ${quote.title}`,
      html,
      artist
    );

    res.json({
      ok: true,
      simulated: emailResult?.simulated || false,
      token,
      message: emailResult?.simulated
        ? 'Email simulé (configurez RESEND_API_KEY pour l\'envoi réel)'
        : `Email envoyé à ${quote.client_email}`,
    });
  } catch (e) {
    console.error('[quotes/send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/quotes/respond/:token ────────────────────────────────────────────
// Route publique — client accepte ou refuse le devis depuis son email
router.get('/respond/:token', async (req, res) => {
  const { token } = req.params;
  const { action } = req.query; // 'accept' ou 'refuse'

  try {
    const quote = db.prepare('SELECT * FROM quotes WHERE token = ?').get(token);
    if (!quote) {
      return res.send(pageResponse('❌ Lien invalide', 'Ce lien de devis est introuvable ou a expiré.', '#e53e3e'));
    }
    if (quote.status === 'accepted') {
      return res.send(pageResponse('✅ Devis déjà accepté', 'Vous avez déjà accepté ce devis. Nous vous contacterons prochainement.', '#22c55e'));
    }
    if (quote.status === 'refused') {
      return res.send(pageResponse('Devis refusé', 'Vous avez déjà refusé ce devis.', '#888'));
    }

    if (action === 'accept') {
      db.prepare(`UPDATE quotes SET status='accepted', accepted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(quote.id);

      // Notifier l'artiste par email
      try {
        const artist = db.prepare('SELECT * FROM users WHERE id = ?').get(quote.user_id);
        if (artist?.email) {
          const { sendEmail } = require('./campaigns');
          await sendEmail(
            artist.email,
            `✅ Devis accepté — ${quote.client_name || quote.client_email}`,
            `Bonne nouvelle !\n\n${quote.client_name || quote.client_email} vient d'accepter votre devis "${quote.title}" (${quote.total.toFixed(2)} €).\n\nConnectez-vous à inkr pour demander un acompte ou planifier le rendez-vous.`,
            artist,
            BASE_URL
          );
        }
      } catch (notifErr) {
        console.warn('[quotes/respond] Notif artiste échouée:', notifErr.message);
      }

      return res.send(pageResponse('✅ Devis accepté !', `Merci ! Vous avez accepté le devis "${quote.title}". Le tatoueur va vous contacter prochainement pour planifier votre rendez-vous.`, '#22c55e'));
    }

    if (action === 'refuse') {
      db.prepare(`UPDATE quotes SET status='refused', refused_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(quote.id);
      return res.send(pageResponse('Devis refusé', `Vous avez refusé le devis "${quote.title}". N'hésitez pas à contacter l'artiste si vous souhaitez discuter d'une autre proposition.`, '#888'));
    }

    // Action non reconnue
    return res.redirect(`${BASE_URL}/dashboard`);
  } catch (e) {
    console.error('[quotes/respond]', e.message);
    res.status(500).send(pageResponse('Erreur', 'Une erreur est survenue. Veuillez réessayer.', '#e53e3e'));
  }
});

// Page de réponse (HTML standalone)
function pageResponse(title, message, color) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${title} — inkr</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;background:#0a0a0a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
.card{background:#111;border:1px solid #1e1e1e;border-radius:20px;padding:48px 40px;max-width:440px;width:100%;text-align:center;}
.icon{font-size:48px;margin-bottom:20px;}
h1{font-size:22px;font-weight:800;color:#fff;margin-bottom:12px;}
p{font-size:14px;color:rgba(255,255,255,.5);line-height:1.7;margin-bottom:28px;}
a{display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#667eea,#a855f7);color:#fff;border-radius:980px;font-size:14px;font-weight:700;text-decoration:none;}
.brand{font-size:24px;font-weight:900;background:linear-gradient(135deg,#667eea,#a855f7,#ec4899,#f97316);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:32px;display:inline-block;}
</style></head>
<body><div class="card">
<div class="brand">inkr</div>
<div class="icon" style="color:${color};">${color === '#22c55e' ? '✅' : color === '#e53e3e' ? '❌' : '—'}</div>
<h1 style="color:${color};">${title}</h1>
<p>${message}</p>
<a href="https://inkr.club">Découvrir inkr →</a>
</div></body></html>`;
}

// ── POST /api/quotes/:id/acompte ──────────────────────────────────────────────
// Demande un acompte sur un devis accepté. Utilise Stripe ou PayPal.me de l'artiste.
// Body: { amount, method } (method: 'stripe' | 'paypal')
router.post('/:id/acompte', requireAuth, async (req, res) => {
  try {
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.userId);
    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
    if (quote.status !== 'accepted') return res.status(400).json({ error: 'Le devis doit être accepté pour demander un acompte' });

    const amount = parseFloat(req.body.amount || quote.total * 0.3); // 30% par défaut
    const method = req.body.method || 'stripe';

    if (method === 'paypal') {
      const artist = db.prepare('SELECT paypal_me_url FROM users WHERE id = ?').get(req.user.userId);
      const paypalBase = (artist?.paypal_me_url || '').replace(/\/+$/, '');
      if (!paypalBase) return res.status(400).json({ error: 'Configurez votre PayPal.me dans Mon profil' });
      const url = `${paypalBase}/${amount}`;
      db.prepare('UPDATE quotes SET acompte_requested=1, acompte_amount=?, acompte_status=\'pending\', acompte_url=? WHERE id=?')
        .run(amount, url, quote.id);
      return res.json({ ok: true, url, method: 'paypal' });
    }

    // Stripe
    if (!process.env.STRIPE_SECRET_KEY) {
      const fakeUrl = `${BASE_URL}/dashboard?payment=simulated&quote=${quote.id}`;
      db.prepare('UPDATE quotes SET acompte_requested=1, acompte_amount=?, acompte_status=\'pending\', acompte_url=? WHERE id=?')
        .run(amount, fakeUrl, quote.id);
      return res.json({ ok: true, url: fakeUrl, simulated: true });
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Acompte — ${quote.title}`,
            description: `Acompte sur devis pour ${quote.client_name || quote.client_email}`,
          },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      customer_email: quote.client_email || undefined,
      success_url: `${BASE_URL}/api/quotes/${quote.id}/acompte-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/dashboard`,
      metadata: { quote_id: String(quote.id), artist_id: String(req.user.userId) },
    });

    db.prepare('UPDATE quotes SET acompte_requested=1, acompte_amount=?, acompte_status=\'pending\', acompte_url=? WHERE id=?')
      .run(amount, session.url, quote.id);

    res.json({ ok: true, url: session.url, session_id: session.id });
  } catch (e) {
    console.error('[quotes/acompte]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/quotes/:id/acompte-success ───────────────────────────────────────
router.get('/:id/acompte-success', (req, res) => {
  try {
    db.prepare("UPDATE quotes SET acompte_status='paid' WHERE id=?").run(req.params.id);
    res.redirect(`${BASE_URL}/dashboard?payment=success&quote=${req.params.id}`);
  } catch (e) {
    res.redirect(`${BASE_URL}/dashboard`);
  }
});

module.exports = router;
