# inkr — Guide de déploiement Railway

## ⚠️ CRITIQUE — La base de données SERA EFFACÉE sans Volume

Railway redéploie l'application dans un conteneur neuf à chaque `git push`.
**Sans Volume persistant, la base SQLite est effacée à chaque déploiement.**
Il faut configurer un Volume Railway une seule fois. Ensuite, les données survivent à toutes les mises à jour.

---

## Étape 1 — Créer le Volume Railway (à faire UNE seule fois)

1. Ouvrir Railway → votre projet → onglet **Volumes**
2. Cliquer **"New Volume"**
3. Paramètres :
   - **Mount path** : `/app/data`
   - **Size** : 1 GB (suffisant pour des années)
4. Cliquer **Create**

C'est tout. Railway monte automatiquement `/app/data` dans chaque déploiement.
Les données écrites dans `/app/data` ne sont JAMAIS effacées lors d'un redéploiement.

---

## Étape 2 — Variables d'environnement requises

Dans Railway → projet → onglet **Variables**, définir :

```
# ─── BASE DE DONNÉES ───────────────────────────────────────────────────────────
DB_PATH=/app/data/inkr.db
# Chemin vers la base SQLite sur le Volume persistant.
# CRITIQUE : sans cette variable, la DB est dans /app/inkr.db (éphémère → effacée).

BACKUP_DIR=/app/data/backups
# Dossier de sauvegarde automatique (même Volume = survit aux redéploiements).
# Backups toutes les 6h, 14 fichiers conservés (.db + .json).

# ─── AUTHENTIFICATION ──────────────────────────────────────────────────────────
JWT_SECRET=une_chaine_aleatoire_longue_et_unique
# Signer les cookies de session artiste.
# Changer cette valeur déconnecte TOUS les utilisateurs connectés.

ADMIN_SECRET=un_mot_de_passe_admin_fort
# Accès admin via /admin?key=ADMIN_SECRET
# Protège aussi les endpoints d'analytics (/api/analytics/stats).

# ─── EMAIL ─────────────────────────────────────────────────────────────────────
SENDGRID_API_KEY=SG.xxx         # ou MAILGUN_API_KEY=key-xxx
FROM_EMAIL=contact@inkr.club
REPLY_TO_EMAIL=contact@inkr.club

# ─── META / INSTAGRAM / WHATSAPP ───────────────────────────────────────────────
META_APP_ID=xxx
META_APP_SECRET=xxx
META_VERIFY_TOKEN=xxx           # Token personnalisé pour la vérification webhook
META_WA_PHONE_NUMBER_ID=xxx     # WhatsApp Business (officiel)
META_WA_CONFIG_ID=xxx           # ID de configuration Embedded Signup

# ─── PAIEMENT ──────────────────────────────────────────────────────────────────
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_ID=price_xxx       # ID du plan mensuel 39€

# ─── TWILIO SMS (optionnel) ────────────────────────────────────────────────────
TWILIO_ACCOUNT_SID=xxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_FROM_NUMBER=+33xxx

# ─── PORT ──────────────────────────────────────────────────────────────────────
PORT=3000
# Railway l'injecte automatiquement — ne pas hardcoder.
```

---

## Étape 3 — Vérifier le déploiement

Après le prochain `git push`, ouvrir les logs Railway et vérifier :

```
✅ [Backup] Démarrage — DB: /app/data/inkr.db
   Dossier backups : /app/data/backups
   Rétention : 14 backups — Fréquence : toutes les 6h
[DB] SQLite prêt → /app/data/inkr.db
```

Si vous voyez `/app/inkr.db` au lieu de `/app/data/inkr.db` → la variable `DB_PATH` n'est pas définie.

---

## Architecture de stockage

```
/app/data/                  ← Volume Railway persistant (survit aux redéploiements)
  inkr.db                   ← Base principale SQLite (WAL mode, FK enforced)
  backups/
    inkr_backup_2026-...db  ← Copie binaire (restaurable en 1 commande)
    inkr_backup_2026-...json← Export JSON lisible (audit, migration)
    ...                     ← 14 derniers conservés
```

### Restaurer depuis un backup

```bash
# 1. Lister les backups disponibles
GET /api/admin/backups   (ou ls /app/data/backups/)

# 2. Remplacer la DB principale par le backup voulu
cp /app/data/backups/inkr_backup_2026-XX-XX.db /app/data/inkr.db

# 3. Redémarrer le service Railway (via le dashboard)
```

---

## Pour les développeurs

### Tables et migrations

Toutes les migrations sont dans `db/database.js` → fonction `runMigrations()`.
**Ne jamais** écrire de `ALTER TABLE` dans les fichiers de routes.
Pour ajouter une colonne :
1. Ajouter le `ALTER TABLE ... ADD COLUMN` dans `runMigrations()`
2. L'entourer d'un `try/catch` (SQLite ignore les colonnes déjà existantes)
3. Documenter avec un commentaire `-- v4 : description`

### Git workflow

```bash
# Le sandbox Claude ne peut pas pousser (lock file).
# Toujours pousser depuis le Mac :

cd ~/Desktop/inkr-app
rm -f .git/HEAD.lock .git/index.lock   # si erreur de lock
git add -A
git commit -m "description des changements"
git push origin main
```

---

## Données personnelles (RGPD)

- Les IPs des visiteurs ne sont **jamais stockées**. On stocke uniquement `SHA-256(IP + salt)` → irréversible.
- Endpoints RGPD à implémenter avant lancement commercial :
  - `GET /api/auth/me/export` → export de toutes les données personnelles
  - `DELETE /api/auth/me` → suppression du compte + données associées
- Les mots de passe sont hashés avec `bcrypt` (salt factor 10).
- Les exports de backup JSON masquent `password_hash`, `reset_token` et `otp_code`.
