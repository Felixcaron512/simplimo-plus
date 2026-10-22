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
  fail "Le dossier $INSTALL_DIR n'est pas vide. Utilisez un autre dossier ou sauvegardez-le d'abord."
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
SOURCE_DIR="$(find "$TMP_DIR/source" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[ -n "$SOURCE_DIR" ] || fail "Archive GitHub vide ou invalide"
cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/

cd "$INSTALL_DIR"
[ -f docker-compose.yml ] || fail "docker-compose.yml absent dans l'archive"
[ -f .env.example ] || fail ".env.example absent dans l'archive"

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

printf 'Nom du domaine (exemple: simplimo.lan): '
if [ -z "$DOMAIN" ]; then
  read -r DOMAIN
fi
DOMAIN="${DOMAIN:-simplimo.lan}"
set_env DOMAIN "$DOMAIN"
set_env DB_CLIENT pg

if [ "$USE_PROXY" = true ]; then
  printf 'Démarrage de Simplimo+ avec Caddy sur %s...\n' "$DOMAIN"
  docker compose --profile proxy up -d --build
else
  printf 'Démarrage de Simplimo+ sans Caddy...\n'
  docker compose up -d --build
fi

printf '\nInstallation terminée.\n'
printf 'Dossier: %s\n' "$INSTALL_DIR"
printf 'État:    docker compose -C %s ps\n' "$INSTALL_DIR"
if [ "$USE_PROXY" = true ]; then
  printf 'URL:     https://%s\n' "$DOMAIN"
else
  printf 'URL:     http://IP_DU_TRUENAS:3000\n'
fi
printf 'Compte initial: admin / %s\n' "$ADMIN_PASSWORD"
printf '\nLe fichier .env contient les secrets générés: %s/.env\n' "$INSTALL_DIR"
