#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${SIMPLIMO_REPO_URL:-https://github.com/Felixcaron512/simplimo-plus}"
BRANCH="${SIMPLIMO_BRANCH:-main}"
INSTALL_DIR="${SIMPLIMO_DIR:-}"
DOMAIN="${SIMPLIMO_DOMAIN:-}"
USE_PROXY=true

usage() {
  cat <<'EOF'
Installation de Simplimo+ sur TrueNAS SCALE

Usage:
  bash install-truenas.sh [options]

Options:
  --dir PATH       Dossier d'installation (par défaut: /mnt/<pool>/apps/simplimo)
  --domain NOM     Nom DNS utilisé par Caddy
  --no-proxy       Ne pas démarrer Caddy (reverse proxy externe)
  --help           Afficher cette aide

Variables d'environnement:
  SIMPLIMO_REPO_URL, SIMPLIMO_BRANCH, SIMPLIMO_DIR, SIMPLIMO_DOMAIN
EOF
}

fail() {
  printf 'Erreur: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || fail "Valeur manquante pour --dir"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --domain)
      [ "$#" -ge 2 ] || fail "Valeur manquante pour --domain"
      DOMAIN="$2"
      shift 2
      ;;
    --no-proxy)
      USE_PROXY=false
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Option inconnue: $1"
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || fail "curl est requis"
command -v unzip >/dev/null 2>&1 || fail "unzip est requis"
command -v docker >/dev/null 2>&1 || fail "Docker est requis"
docker compose version >/dev/null 2>&1 || fail "Le plugin Docker Compose est requis"

if [ -z "$INSTALL_DIR" ]; then
  printf 'Chemin du pool TrueNAS (exemple: /mnt/tank): '
  read -r POOL_DIR
  [ -n "$POOL_DIR" ] || fail "Le chemin du pool est requis"
  INSTALL_DIR="${POOL_DIR%/}/apps/simplimo"
fi

if [ -e "$INSTALL_DIR" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  if [ ! -f "$INSTALL_DIR/docker-compose.yml" ] || [ ! -f "$INSTALL_DIR/Dockerfile" ]; then
    fail "Le dossier $INSTALL_DIR contient déjà des fichiers mais n'est pas une installation Simplimo complète."
  fi
fi

mkdir -p "$INSTALL_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ARCHIVE="$TMP_DIR/simplimo.zip"
printf 'Téléchargement de %s...\n' "$REPO_URL"
curl -fL --retry 3 \
  -o "$ARCHIVE" \
  "${REPO_URL%/}/archive/refs/heads/${BRANCH}.zip"

unzip -q "$ARCHIVE" -d "$TMP_DIR/source"
SOURCE_DIR="$(find "$TMP_DIR/source" -type f -name docker-compose.yml -print -quit)"
[ -n "$SOURCE_DIR" ] || fail "docker-compose.yml absent dans l'archive"
SOURCE_DIR="$(dirname "$SOURCE_DIR")"
[ -f "$SOURCE_DIR/Dockerfile" ] || fail "Dockerfile absent dans l'archive"
[ -f "$SOURCE_DIR/.env.example" ] || fail ".env.example absent dans l'archive"
cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/

cd "$INSTALL_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
fi

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

random_password() {
  random_secret | cut -c1-24
}

generate_vapid_keys() {
  docker compose build app >/dev/null
  docker compose run --rm --no-deps app node -e \
    "const k=require('web-push').generateVAPIDKeys(); console.log(k.publicKey); console.log(k.privateKey);"
}

set_env() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

CURRENT_JWT="$(sed -n 's/^JWT_SECRET=//p' .env | head -n 1)"
if [ -z "$CURRENT_JWT" ] || [ "$CURRENT_JWT" = "change-me" ]; then
  set_env JWT_SECRET "$(random_secret)"
fi

CURRENT_DB_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | head -n 1)"
if [ -z "$CURRENT_DB_PASSWORD" ]; then
  set_env POSTGRES_PASSWORD "$(random_password)"
fi

CURRENT_ADMIN_PASSWORD="$(sed -n 's/^ADMIN_PASSWORD=//p' .env | head -n 1)"
if [ -z "$CURRENT_ADMIN_PASSWORD" ] || [ "$CURRENT_ADMIN_PASSWORD" = "ChangeMoi!2026" ]; then
  ADMIN_PASSWORD="$(random_password)"
  set_env ADMIN_PASSWORD "$ADMIN_PASSWORD"
else
  ADMIN_PASSWORD="$CURRENT_ADMIN_PASSWORD"
fi

CURRENT_VAPID_PUBLIC="$(sed -n 's/^VAPID_PUBLIC_KEY=//p' .env | head -n 1)"
CURRENT_VAPID_PRIVATE="$(sed -n 's/^VAPID_PRIVATE_KEY=//p' .env | head -n 1)"
if [ -z "$CURRENT_VAPID_PUBLIC" ] || [ -z "$CURRENT_VAPID_PRIVATE" ]; then
  printf 'Génération des clés VAPID pour les notifications push...\n'
  VAPID_KEYS="$(generate_vapid_keys)"
  VAPID_PUBLIC_KEY="$(printf '%s\n' "$VAPID_KEYS" | sed -n '1p')"
  VAPID_PRIVATE_KEY="$(printf '%s\n' "$VAPID_KEYS" | sed -n '2p')"
  [ -n "$VAPID_PUBLIC_KEY" ] && [ -n "$VAPID_PRIVATE_KEY" ] || fail "Impossible de générer les clés VAPID"
  set_env VAPID_PUBLIC_KEY "$VAPID_PUBLIC_KEY"
  set_env VAPID_PRIVATE_KEY "$VAPID_PRIVATE_KEY"
fi
set_env VAPID_SUBJECT "mailto:simplimo@fcho.net"

printf 'Nom du domaine (exemple: simplimo.lan): '
if [ -z "$DOMAIN" ]; then
  read -r DOMAIN
fi
DOMAIN="${DOMAIN:-simplimo.lan}"
set_env DOMAIN "$DOMAIN"
set_env DB_CLIENT pg

if [ "$USE_PROXY" = true ]; then
  printf 'Démarrage de Simplimo+ avec Caddy sur %s...\n' "$DOMAIN"
  docker compose --profile proxy up -d
else
  printf 'Démarrage de Simplimo+ sans Caddy...\n'
  docker compose up -d
fi

printf '\nInstallation terminée.\n'
printf '%s\n' '========================================'
printf 'Dossier: %s\n' "$INSTALL_DIR"
printf 'État:    docker compose -C %s ps\n' "$INSTALL_DIR"
if [ "$USE_PROXY" = true ]; then
  printf 'URL:     https://%s\n' "$DOMAIN"
else
  printf 'URL:     http://IP_DU_TRUENAS:3000\n'
fi
ADMIN_USER="$(sed -n 's/^ADMIN_USER=//p' .env | head -n 1)"
printf '\nIdentifiants initiaux de Simplimo+:\n'
printf '  Utilisateur admin : %s\n' "${ADMIN_USER:-admin}"
printf '  Mot de passe      : %s\n' "$ADMIN_PASSWORD"
printf 'Clé publique VAPID : %s\n' "$(sed -n 's/^VAPID_PUBLIC_KEY=//p' .env | head -n 1)"
printf '\nLes autres secrets sont conservés dans: %s/.env\n' "$INSTALL_DIR"
printf '%s\n' '========================================'
