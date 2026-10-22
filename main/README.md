# Simplimo +

PWA d'inventaire, de suivi de matériel et de gestion événementielle (check-out / check-in par scan).
Node.js + Express, SQLite (test) ou PostgreSQL (production), front PWA sans build.

## Arborescence
```
simplimo/
├─ src/        server.js (API REST, scans, sync, exports) · db.js (schéma) · ldap.js
├─ public/     index.html · app.js · scanner.js (flash) · idb.js (hors ligne) · sw.js · manifest.json · style.css
├─ scripts/    migrate-sqlite-to-pg.js
├─ caddy/      Caddyfile (reverse proxy HTTPS optionnel)
├─ docs/       SCHEMA.md (modèle de données)
├─ Dockerfile · docker-compose.yml · .env.example
```

## Phase 1 : Windows 11 (test local)

1. Installer Node.js 22 LTS : `winget install OpenJS.NodeJS.LTS` puis rouvrir PowerShell.
2. Dans le dossier du projet :
```powershell
Copy-Item .env.example .env
notepad .env          # changer JWT_SECRET et ADMIN_PASSWORD ; laisser DB_CLIENT=sqlite
npm install
npm start
```
3. Ouvrir http://localhost:3000 et se connecter avec `ADMIN_USER` / `ADMIN_PASSWORD`.
   La base est créée dans `data\simplimo.db`, les photos et PDF dans `data\uploads`.

### Tester avec un téléphone (HTTPS obligatoire pour la caméra)
Les navigateurs n'autorisent la caméra que sur `localhost` ou en HTTPS. Avec mkcert :
```powershell
winget install FiloSottile.mkcert
mkcert -install
mkcert 10.0.0.27 localhost          # remplacer par l'IP du PC ; crée 2 fichiers .pem
```
Dans `.env` : `SSL_CERT=./10.0.0.27+1.pem` et `SSL_KEY=./10.0.0.27+1-key.pem`, puis ouvrir le pare-feu :
```powershell
New-NetFirewallRule -DisplayName "Simplimo" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```
Sur le téléphone, ouvrir `https://10.0.0.27:3000`. Il faut installer et approuver `rootCA.pem` (dossier affiché par `mkcert -CAROOT`) :
sur iPhone, Réglages > Général > Informations > Réglages des certificats ; sur Android, installer le certificat CA.
Ensuite « Ajouter à l'écran d'accueil » pour installer la PWA.

### Variante Docker Desktop
`docker compose up -d --build` (définir `POSTGRES_PASSWORD` dans `.env`) lance l'application et PostgreSQL sur http://localhost:3000.

## Phase 2 : serveur (production)

### Installation automatique sur TrueNAS SCALE

Le dépôt GitHub doit être public pour que cette commande fonctionne sans jeton :

```bash
curl -fsSL https://raw.githubusercontent.com/Felixcaron512/simplimo-plus/main/install-truenas.sh | bash
```

Le script demande le chemin du pool, télécharge l'archive GitHub, crée `.env`, génère les secrets PostgreSQL et JWT, puis démarre Docker Compose avec Caddy. Pour utiliser un reverse proxy déjà installé :

```bash
curl -fsSL https://raw.githubusercontent.com/Felixcaron512/simplimo-plus/main/install-truenas.sh | bash -s -- --no-proxy
```

Le dossier d'installation peut aussi être fourni directement :

```bash
curl -fsSL https://raw.githubusercontent.com/Felixcaron512/simplimo-plus/main/install-truenas.sh | bash -s -- --dir /mnt/tank/apps/simplimo --domain simplimo.example.com
```

1. Copier le projet sur le serveur, puis `cp .env.example .env` et renseigner : `JWT_SECRET` (`openssl rand -hex 32`), `POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `DOMAIN`, et le bloc LDAP si utilisé.
2. `docker compose up -d --build` (application + PostgreSQL).
3. HTTPS :
   - Reverse proxy existant (Nginx Proxy Manager, Traefik…) : pointer vers `app:3000` ou le port 3000 de l'hôte.
   - Sinon : `docker compose --profile proxy up -d --build` (Caddy, certificat Let's Encrypt si `DOMAIN` est public, certificat interne sinon).

### Migrer la base Windows (SQLite) vers le serveur (PostgreSQL)
```powershell
# 1. Arrêter le serveur local (Ctrl+C), puis sur le PC :
$env:PG_URL = "postgres://simplimo:MOT_DE_PASSE@IP_SERVEUR:5432/simplimo"
npm run migrate:pg -- .\data\simplimo.db $env:PG_URL
# 2. Copier les fichiers joints
scp -r .\data\uploads utilisateur@IP_SERVEUR:/tmp/uploads
```
Pour exposer PostgreSQL le temps de la migration, ajouter `ports: ["5432:5432"]` au service `db`, puis le retirer. Sinon, lancer le script depuis le serveur. Copier les fichiers joints dans le volume :
`docker cp /tmp/uploads/. $(docker compose ps -q app):/app/data/uploads/`.
Sauvegarde ultérieure : `docker compose exec db pg_dump -U simplimo simplimo > sauvegarde.sql`.

## LDAP
`LDAP_ENABLED=true` puis renseigner `LDAP_*` dans `.env`. Les rôles viennent de l'attribut `memberOf` (DN complets des groupes), recalculés à chaque connexion : Admin, Responsable événement (`manager`), Technicien (`technician`). Un utilisateur LDAP sans groupe autorisé est refusé. Les comptes locaux (dont `ADMIN_USER`) restent utilisables si le LDAP est indisponible. Active Directory : `LDAP_USER_FILTER=(sAMAccountName={{u}})`. OpenLDAP : activer l'overlay `memberOf`. Un outpost LDAP authentik expose `memberOf` et convient.

## Rôles
- Admin : tout, y compris utilisateurs et journal d'audit.
- Responsable événement : articles, événements, réservations, exports.
- Technicien : consultation et scans.

## Fonctionnement hors ligne
Les articles et événements consultés sont mis en cache (IndexedDB). Les scans faits sans réseau sont mis en file d'attente puis envoyés automatiquement (`/api/sync`) au retour de la connexion. Ouvrez l'événement une fois avec du réseau avant de partir.

## Notifications push
Pour recevoir les notifications même lorsque la PWA est fermée ou que le téléphone est verrouillé, configurer les clés VAPID dans `.env` :
```powershell
npx web-push generate-vapid-keys
```
L'installateur TrueNAS génère automatiquement les deux clés et configure `VAPID_SUBJECT=mailto:simplimo@fcho.net`. Chaque appareil doit ensuite activer les notifications dans Réglages. Le bouton **Test de notification** envoie un test à tous les appareils abonnés ; **Finir le rapport** envoie également une notification à tous.

## Fonctions ajoutées
- Inventaires persistants par scan, clôture et consultation des écarts.
- Catégories et emplacements administrables, import/export CSV des articles.
- Checklists de préparation, commentaires et signature de rapport.
- Duplication d'événements et export calendrier `.ics`.
- Préférences de notifications, alertes de stock bas et d'articles manquants/endommagés.
- Sauvegardes JSON locales avec restauration depuis l'administration.
- Limitation des tentatives de connexion.

## Limites connues
- Les notifications push nécessitent HTTPS (sauf `localhost`) et un navigateur compatible ; iOS nécessite une PWA ajoutée à l'écran d'accueil.
- Le flash (`torch`) fonctionne sur Chrome Android ; Safari iOS ne l'expose pas.
- Le thème, le logo et les raccourcis sont enregistrés par appareil (localStorage).
