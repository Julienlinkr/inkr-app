/**
 * services/backup.js
 *
 * Sauvegarde automatique de la base de données SQLite.
 *
 * ─── Pour les développeurs ────────────────────────────────────────────────
 *
 * Stratégie :
 *   - Backup au démarrage du serveur (capture toute donnée avant un crash)
 *   - Backup toutes les 6 heures (4 sauvegardes par jour)
 *   - Conservation des 14 derniers backups (14 jours de rétention)
 *   - Stockage dans /app/data/backups/ (volume Railway persistant)
 *
 * Fichiers générés :
 *   inkr_backup_2026-06-04T14-30-00.db   ← copie binaire SQLite (restaurable)
 *   inkr_backup_2026-06-04T14-30-00.json ← export JSON lisible (audit, migration)
 *
 * Restauration manuelle en cas de problème :
 *   cp /app/data/backups/inkr_backup_XXXX.db /app/data/inkr.db
 *   (puis redémarrer le serveur)
 *
 * Endpoint de backup manuel (admin) :
 *   POST /api/admin/backup   → déclenche un backup immédiat
 *   GET  /api/admin/backups  → liste les backups disponibles
 * ──────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

// Dossier de backup — Railway en prod, dossier local en dev
const BACKUP_DIR = process.env.BACKUP_DIR
  || path.join(__dirname, '../db/backups');

// Nombre de backups à conserver
const MAX_BACKUPS = 14;

// Intervalle entre les backups automatiques (6 heures)
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Crée un backup de la DB SQLite.
 * Copie le fichier .db ET exporte un JSON lisible.
 * @returns {{ file: string, size: number, tables: object }} infos du backup
 */
function runBackup() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../db/inkr.db');

  // Vérifier que la DB source existe
  if (!fs.existsSync(dbPath)) {
    console.warn('[Backup] DB source introuvable :', dbPath);
    return null;
  }

  // Créer le dossier de backup si nécessaire
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // Nom du fichier de backup avec timestamp ISO (compatible filesystem)
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const backupFile = path.join(BACKUP_DIR, `inkr_backup_${timestamp}.db`);
  const jsonFile   = path.join(BACKUP_DIR, `inkr_backup_${timestamp}.json`);

  try {
    // 1. Copie binaire SQLite (restaurable directement)
    fs.copyFileSync(dbPath, backupFile);
    const stats = fs.statSync(backupFile);

    // 2. Export JSON (lisible, utile pour audit ou migration)
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readonly: true });

      const tables = ['users', 'clients', 'appointments', 'campaigns', 'messages',
                      'automations', 'loyalty_points', 'tatoueurs', 'tournee_dates'];
      const export_data = { exported_at: new Date().toISOString(), tables: {} };

      tables.forEach(table => {
        try {
          export_data.tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
        } catch(_) {
          export_data.tables[table] = []; // table pas encore créée
        }
      });

      // Masquer les données sensibles dans l'export JSON
      if (export_data.tables.users) {
        export_data.tables.users = export_data.tables.users.map(u => ({
          ...u,
          password_hash: '[MASQUÉ]',
          reset_token: u.reset_token ? '[MASQUÉ]' : null,
          otp_code: u.otp_code ? '[MASQUÉ]' : null,
        }));
      }

      fs.writeFileSync(jsonFile, JSON.stringify(export_data, null, 2));

      // Résumé dans les logs
      const counts = Object.entries(export_data.tables)
        .filter(([, rows]) => rows.length > 0)
        .map(([t, rows]) => `${t}:${rows.length}`)
        .join(' | ');

      console.log(`✅ [Backup] ${path.basename(backupFile)} — ${(stats.size / 1024).toFixed(1)} KB — ${counts || 'DB vide'}`);
      db.close();

      return { file: backupFile, json: jsonFile, size: stats.size, tables: export_data.tables };

    } catch (jsonErr) {
      // Le backup .db est créé même si l'export JSON échoue
      console.warn('[Backup] Export JSON échoué (backup .db OK) :', jsonErr.message);
      return { file: backupFile, size: stats.size };
    }

  } catch (err) {
    console.error('[Backup] Erreur backup :', err.message);
    return null;
  }
}

/**
 * Nettoie les anciens backups en gardant uniquement les N plus récents.
 */
function cleanOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('inkr_backup_') && f.endsWith('.db'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time); // plus récent en premier

  // Supprimer les backups excédentaires (.db + .json)
  const toDelete = files.slice(MAX_BACKUPS);
  toDelete.forEach(({ name }) => {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, name));
      const jsonName = name.replace('.db', '.json');
      if (fs.existsSync(path.join(BACKUP_DIR, jsonName))) {
        fs.unlinkSync(path.join(BACKUP_DIR, jsonName));
      }
      console.log(`[Backup] Ancien backup supprimé : ${name}`);
    } catch(_) {}
  });
}

/**
 * Liste tous les backups disponibles.
 * @returns {Array} liste des backups avec nom, taille, date
 */
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];

  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('inkr_backup_') && f.endsWith('.db'))
    .map(f => {
      const stats = fs.statSync(path.join(BACKUP_DIR, f));
      return {
        name: f,
        size_kb: Math.round(stats.size / 1024),
        created_at: stats.mtime.toISOString(),
        path: path.join(BACKUP_DIR, f),
      };
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/**
 * Démarre le système de backup automatique.
 * À appeler une seule fois au démarrage du serveur.
 */
function startAutoBackup() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../db/inkr.db');
  console.log(`\n💾 [Backup] Démarrage — DB: ${dbPath}`);
  console.log(`   Dossier backups : ${BACKUP_DIR}`);
  console.log(`   Rétention : ${MAX_BACKUPS} backups — Fréquence : toutes les 6h`);

  // Backup immédiat au démarrage (après 5s pour laisser la DB s'initialiser)
  setTimeout(() => {
    runBackup();
    cleanOldBackups();
  }, 5000);

  // Backup automatique toutes les 6 heures
  setInterval(() => {
    console.log('[Backup] Backup automatique déclenché...');
    runBackup();
    cleanOldBackups();
  }, BACKUP_INTERVAL_MS);
}

module.exports = { startAutoBackup, runBackup, listBackups, cleanOldBackups, BACKUP_DIR };
