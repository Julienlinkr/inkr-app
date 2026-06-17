/**
 * services/automations.js
 *
 * Exécution automatique des automatisations inkr.
 * Tourne en arrière-plan via setInterval (toutes les heures).
 *
 * Types gérés :
 *   sms_24h_before  → rappel RDV la veille (24h avant)
 *   followup_j5     → suivi cicatrisation 5j après RDV terminé
 *   retouche_j30    → relance retouche 30j après RDV terminé
 *   relance_m3      → relance commerciale 3 mois après dernier RDV
 *   birthday        → message d'anniversaire le jour J
 *
 * Chaque exécution est loguée dans automation_logs (évite les doublons).
 * Les messages utilisent {{prénom}}, {{studio}}, {{lien_résa}} comme variables.
 */

'use strict';

const { db } = require('../db/database');

// ── Créer la table de logs si elle n'existe pas ────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_logs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id  INTEGER NOT NULL,
      target_id      TEXT    NOT NULL,  -- appointment_id ou client_id selon le type
      sent_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      channel        TEXT    DEFAULT 'sms',
      status         TEXT    DEFAULT 'sent',
      UNIQUE(automation_id, target_id)
    );
  `);
} catch(_) {}

// ── Utilitaire : formater un message en remplaçant les variables ───────────────
function formatMessage(template, vars) {
  return template
    .replace(/\{\{prénom\}\}/gi,    vars.prenom    || vars.name || 'cher client')
    .replace(/\{\{studio\}\}/gi,    vars.studio    || 'votre tatoueur inkr')
    .replace(/\{\{lien_résa\}\}/gi, vars.linkResa  || 'https://inkr.club');
}

// ── Envoi d'un message : SMS (Twilio) ou simulation ───────────────────────────
async function sendAutoMessage(to, message, channel = 'sms') {
  if (!to) return { simulated: true, reason: 'Pas de contact' };

  if (channel === 'sms') {
    if (!process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID.startsWith('ACxx')) {
      console.log(`[Automations SIMULÉ] SMS → ${to}: ${message.slice(0, 60)}...`);
      return { simulated: true };
    }
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE || process.env.TWILIO_FROM_NUMBER,
        to,
      });
      return { ok: true };
    } catch (err) {
      console.error('[Automations] SMS échec:', err.message);
      return { error: err.message };
    }
  }

  if (channel === 'email') {
    try {
      const { sendEmail } = require('../routes/campaigns');
      await sendEmail(to, '💬 Message de votre tatoueur inkr', message, {}, '');
      return { ok: true };
    } catch (err) {
      console.error('[Automations] Email échec:', err.message);
      return { error: err.message };
    }
  }

  return { simulated: true, reason: `Canal ${channel} non supporté` };
}

// ── Marquer comme envoyé (évite les doublons) ─────────────────────────────────
function logSent(automationId, targetId, channel = 'sms') {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO automation_logs (automation_id, target_id, channel, status)
      VALUES (?, ?, ?, 'sent')
    `).run(automationId, String(targetId), channel);
    return true;
  } catch(_) {
    return false;
  }
}

function alreadySent(automationId, targetId) {
  try {
    const row = db.prepare(
      'SELECT id FROM automation_logs WHERE automation_id=? AND target_id=?'
    ).get(automationId, String(targetId));
    return !!row;
  } catch(_) {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TYPE 1 — sms_24h_before : rappel 24h avant le RDV
// ══════════════════════════════════════════════════════════════════════════════
async function runRappelVeille() {
  const automations = db.prepare(`
    SELECT a.*, u.name AS studio, u.city, u.phone AS studio_phone
    FROM automations a
    JOIN users u ON u.id = a.user_id
    WHERE a.type = 'sms_24h_before' AND a.enabled = 1
  `).all();

  for (const auto of automations) {
    // RDV demain (entre H+22 et H+26 pour attraper la fenêtre horaire)
    const appts = db.prepare(`
      SELECT ap.*, c.date_naissance
      FROM appointments ap
      LEFT JOIN clients c ON c.id = ap.client_id
      WHERE ap.user_id = ?
        AND ap.status NOT IN ('cancelled', 'done')
        AND date(ap.date) = date('now', '+1 day')
    `).all(auto.user_id);

    for (const appt of appts) {
      if (alreadySent(auto.id, `appt_${appt.id}`)) continue;

      const prenom = (appt.client_name || '').split(' ')[0];
      const msg = formatMessage(auto.message, {
        prenom,
        studio: auto.studio,
        linkResa: `https://inkr.club/t/${auto.user_id}`,
      });

      const contact = appt.client_phone || appt.client_email;
      const channel = appt.client_phone ? 'sms' : (appt.client_email ? 'email' : null);
      if (!channel) continue;

      const result = await sendAutoMessage(contact, msg, channel);
      if (!result.error) {
        logSent(auto.id, `appt_${appt.id}`, channel);
        console.log(`[Automations] sms_24h_before → ${prenom} (RDV #${appt.id})`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TYPE 2 — followup_j5 : suivi 5 jours après RDV terminé
// ══════════════════════════════════════════════════════════════════════════════
async function runFollowupJ5() {
  const automations = db.prepare(`
    SELECT a.*, u.name AS studio
    FROM automations a JOIN users u ON u.id = a.user_id
    WHERE a.type = 'followup_j5' AND a.enabled = 1
  `).all();

  for (const auto of automations) {
    const appts = db.prepare(`
      SELECT ap.* FROM appointments ap
      WHERE ap.user_id = ?
        AND ap.status = 'done'
        AND date(ap.date) = date('now', '-5 days')
    `).all(auto.user_id);

    for (const appt of appts) {
      if (alreadySent(auto.id, `appt_${appt.id}`)) continue;

      const prenom = (appt.client_name || '').split(' ')[0];
      const msg = formatMessage(auto.message, { prenom, studio: auto.studio, linkResa: `https://inkr.club/t/${auto.user_id}` });
      const contact = appt.client_phone || appt.client_email;
      const channel = appt.client_phone ? 'sms' : (appt.client_email ? 'email' : null);
      if (!channel) continue;

      const result = await sendAutoMessage(contact, msg, channel);
      if (!result.error) {
        logSent(auto.id, `appt_${appt.id}`, channel);
        console.log(`[Automations] followup_j5 → ${prenom} (RDV #${appt.id})`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TYPE 3 — retouche_j30 : relance retouche 30 jours après RDV
// ══════════════════════════════════════════════════════════════════════════════
async function runRetoucheJ30() {
  const automations = db.prepare(`
    SELECT a.*, u.name AS studio
    FROM automations a JOIN users u ON u.id = a.user_id
    WHERE a.type = 'retouche_j30' AND a.enabled = 1
  `).all();

  for (const auto of automations) {
    const appts = db.prepare(`
      SELECT ap.* FROM appointments ap
      WHERE ap.user_id = ?
        AND ap.status = 'done'
        AND date(ap.date) = date('now', '-30 days')
    `).all(auto.user_id);

    for (const appt of appts) {
      if (alreadySent(auto.id, `appt_${appt.id}`)) continue;

      const prenom = (appt.client_name || '').split(' ')[0];
      const msg = formatMessage(auto.message, { prenom, studio: auto.studio, linkResa: `https://inkr.club/t/${auto.user_id}` });
      const contact = appt.client_phone || appt.client_email;
      const channel = appt.client_phone ? 'sms' : (appt.client_email ? 'email' : null);
      if (!channel) continue;

      const result = await sendAutoMessage(contact, msg, channel);
      if (!result.error) {
        logSent(auto.id, `appt_${appt.id}`, channel);
        console.log(`[Automations] retouche_j30 → ${prenom} (RDV #${appt.id})`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TYPE 4 — relance_m3 : relance 3 mois après le dernier RDV du client
// ══════════════════════════════════════════════════════════════════════════════
async function runRelanceM3() {
  const automations = db.prepare(`
    SELECT a.*, u.name AS studio
    FROM automations a JOIN users u ON u.id = a.user_id
    WHERE a.type = 'relance_m3' AND a.enabled = 1
  `).all();

  for (const auto of automations) {
    // Clients dont le dernier RDV était exactement il y a 3 mois
    const clients = db.prepare(`
      SELECT c.*, MAX(ap.date) AS last_appt_date
      FROM clients c
      JOIN appointments ap ON ap.client_id = c.id
      WHERE c.user_id = ?
        AND ap.status = 'done'
      GROUP BY c.id
      HAVING date(MAX(ap.date)) = date('now', '-3 months')
    `).all(auto.user_id);

    for (const client of clients) {
      if (alreadySent(auto.id, `client_${client.id}_3m`)) continue;

      const prenom = (client.name || '').split(' ')[0];
      const msg = formatMessage(auto.message, { prenom, studio: auto.studio, linkResa: `https://inkr.club/t/${auto.user_id}` });
      const contact = client.phone || client.email;
      const channel = client.phone ? 'sms' : (client.email ? 'email' : null);
      if (!channel) continue;

      const result = await sendAutoMessage(contact, msg, channel);
      if (!result.error) {
        logSent(auto.id, `client_${client.id}_3m`, channel);
        console.log(`[Automations] relance_m3 → ${client.name}`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TYPE 5 — birthday : message le jour de l'anniversaire du client
// ══════════════════════════════════════════════════════════════════════════════
async function runBirthday() {
  const automations = db.prepare(`
    SELECT a.*, u.name AS studio
    FROM automations a JOIN users u ON u.id = a.user_id
    WHERE a.type = 'birthday' AND a.enabled = 1
  `).all();

  // Aujourd'hui au format MM-DD pour comparer avec la date de naissance
  const today = new Date();
  const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  for (const auto of automations) {
    // Clients dont la date_naissance correspond à aujourd'hui (format YYYY-MM-DD ou MM-DD)
    const clients = db.prepare(`
      SELECT * FROM clients
      WHERE user_id = ?
        AND date_naissance != ''
        AND date_naissance IS NOT NULL
        AND (
          substr(date_naissance, 6, 5) = ?
          OR substr(date_naissance, 1, 5) = ?
        )
    `).all(auto.user_id, mmdd, mmdd);

    const year = today.getFullYear();
    for (const client of clients) {
      const logKey = `client_${client.id}_bday_${year}`;
      if (alreadySent(auto.id, logKey)) continue;

      const prenom = (client.name || '').split(' ')[0];
      const msg = formatMessage(auto.message, { prenom, studio: auto.studio, linkResa: `https://inkr.club/t/${auto.user_id}` });
      const contact = client.phone || client.email;
      const channel = client.phone ? 'sms' : (client.email ? 'email' : null);
      if (!channel) continue;

      const result = await sendAutoMessage(contact, msg, channel);
      if (!result.error) {
        logSent(auto.id, logKey, channel);
        console.log(`[Automations] birthday → ${client.name} 🎂`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ORCHESTRATEUR — lance tous les checks en parallèle
// ══════════════════════════════════════════════════════════════════════════════
async function runAllAutomations() {
  console.log('[Automations] Vérification en cours…');
  try {
    await Promise.allSettled([
      runRappelVeille(),
      runFollowupJ5(),
      runRetoucheJ30(),
      runRelanceM3(),
      runBirthday(),
    ]);
    console.log('[Automations] ✅ Cycle terminé');
  } catch (err) {
    console.error('[Automations] Erreur cycle:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE — appelé depuis server.js après app.listen()
// ══════════════════════════════════════════════════════════════════════════════
function startAutomations() {
  console.log('[Automations] ⏰ Scheduler démarré — vérification toutes les heures');

  // Premier run 2 minutes après le démarrage (laisser la DB s'initialiser)
  setTimeout(runAllAutomations, 2 * 60 * 1000);

  // Puis toutes les heures
  setInterval(runAllAutomations, 60 * 60 * 1000);
}

module.exports = { startAutomations, runAllAutomations };
