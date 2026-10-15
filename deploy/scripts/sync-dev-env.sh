#!/usr/bin/env bash
# Génère apps/web/.env.local pour le dev avec la DB prod (connexion TLS directe)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROD_ENV="${ROOT}/deploy/.generated/env.production"
OUT="${ROOT}/apps/web/.env.local"

# shellcheck source=lib/framm-common.sh
source "${ROOT}/deploy/scripts/lib/framm-common.sh"

if [[ ! -f "$PROD_ENV" ]]; then
  echo "Fichier manquant: deploy/.generated/env.production"
  echo "Lancez d'abord: bin/framm bootstrap (ou terraform apply en local)"
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "$PROD_ENV"
set +a

if [[ -z "${DEV_DATABASE_URL:-}" ]]; then
  if [[ -z "${RDB_PASSWORD:-}" || -z "${RDB_PUBLIC_HOST:-}" ]]; then
    echo "DEV_DATABASE_URL ou RDB_PUBLIC_* absent de env.production"
    echo "Relancez terraform apply après mise à jour RDB (endpoint public + ACL)"
    exit 1
  fi
  framm_urlencode() {
    python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"
  }
  RDB_PASSWORD_ENCODED="$(framm_urlencode "$RDB_PASSWORD")"
  RDB_PUBLIC_PORT="${RDB_PUBLIC_PORT:-5432}"
  DEV_DATABASE_URL="postgresql://framm:${RDB_PASSWORD_ENCODED}@${RDB_PUBLIC_HOST}:${RDB_PUBLIC_PORT}/framm?sslmode=require"
fi

WEBMAIL_URL="${WEBMAIL_URL:-https://webmail.${PRIMARY_PLATFORM_DOMAIN:-kod.bzh}}"
STALWART_JMAP_URL="${STALWART_URL:-https://mail.${PRIMARY_PLATFORM_DOMAIN:-kod.bzh}}"

framm_load_env 2>/dev/null || true
if [[ -z "${MAIL_PUBLIC_IP:-}" ]]; then
  framm_load_tf_outputs 2>/dev/null || true
fi
if [[ -n "${MAIL_PUBLIC_IP:-}" ]]; then
  framm_init_ssh
  LIVE_STALWART_KEY="$(framm_ssh "$MAIL_PUBLIC_IP" "grep '^STALWART_API_KEY=' /opt/framm/deploy/.generated/env.production | cut -d= -f2-" 2>/dev/null || true)"
  if [[ -n "$LIVE_STALWART_KEY" ]]; then
    STALWART_API_KEY="$LIVE_STALWART_KEY"
    echo "STALWART_API_KEY synchronisée depuis la VM Mail"
  fi
fi

# Conserver AUTH_SECRET entre les runs pour ne pas invalider les JWT NextAuth (sessions dev).
framm_env_get() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  grep "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- || true
}

PRESERVED_AUTH_SECRET="$(framm_env_get "$OUT" "AUTH_SECRET")"
if [[ -z "$PRESERVED_AUTH_SECRET" ]]; then
  PRESERVED_AUTH_SECRET="$(framm_env_get "${ROOT}/.env" "DEV_AUTH_SECRET")"
fi
if [[ -n "$PRESERVED_AUTH_SECRET" ]]; then
  AUTH_SECRET="$PRESERVED_AUTH_SECRET"
  echo "AUTH_SECRET dev conservé (sessions NextAuth stables)"
elif [[ -z "${AUTH_SECRET:-}" ]]; then
  AUTH_SECRET="dev-secret-change-in-production"
  echo "AUTH_SECRET dev par défaut (fixe — voir apps/web/env.example)"
fi

cat > "$OUT" <<EOF
# Dev local → RDB prod (TLS direct, sans tunnel)
DATABASE_URL=${DEV_DATABASE_URL}
AUTH_SECRET=${AUTH_SECRET}
AUTH_URL=http://localhost:3000
PLATFORM_DOMAINS=${PLATFORM_DOMAINS:-kod.bzh}
PRIMARY_PLATFORM_DOMAIN=${PRIMARY_PLATFORM_DOMAIN:-kod.bzh}
WEBMAIL_URL=${WEBMAIL_URL}
STALWART_URL=${STALWART_JMAP_URL}
STALWART_API_KEY=${STALWART_API_KEY:-}
OUTBOUND_SMTP_RELAY_HOST=${OUTBOUND_SMTP_RELAY_HOST:-}
OUTBOUND_SMTP_RELAY_PORT=${OUTBOUND_SMTP_RELAY_PORT:-2587}
OUTBOUND_SMTP_RELAY_USER=${OUTBOUND_SMTP_RELAY_USER:-}
OUTBOUND_SMTP_RELAY_SECRET=${OUTBOUND_SMTP_RELAY_SECRET:-}
BUREAU_ADMIN_EMAIL=${BUREAU_ADMIN_EMAIL}
BUREAU_ADMIN_PASSWORD=${BUREAU_ADMIN_PASSWORD}
S3_ENDPOINT=${S3_ENDPOINT:-}
S3_REGION=${S3_REGION:-fr-par}
S3_BUCKET_UPLOADS=${S3_BUCKET_UPLOADS:-}
S3_ACCESS_KEY=${S3_ACCESS_KEY:-}
S3_SECRET_KEY=${S3_SECRET_KEY:-}
EOF

echo "Écrit: apps/web/.env.local (DB prod TLS → ${RDB_PUBLIC_HOST:-endpoint public})"
echo "Puis: cd apps/web && npm run dev"
echo "Fallback tunnel (optionnel): bin/framm db-tunnel"
