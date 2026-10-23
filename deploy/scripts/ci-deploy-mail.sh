#!/usr/bin/env bash
# Déploiement CI : VM Mail uniquement (app sur Kapsule)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export FRAMM_CI=true
export FRAMM_ROOT="$ROOT"

# shellcheck source=lib/framm-common.sh
source "${ROOT}/deploy/scripts/lib/framm-common.sh"

framm_ci_setup_ssh
export MAIL_PUBLIC_IP="${MAIL_PUBLIC_IP:?MAIL_PUBLIC_IP requis}"

echo "GitOps deploy → Mail ${MAIL_PUBLIC_IP}"

framm_rsync_mail

if [[ -n "${BULWARK_SESSION_SECRET:-}" ]]; then
  framm_mail_ensure_env_key "BULWARK_SESSION_SECRET" "$BULWARK_SESSION_SECRET"
fi

framm_ssh "$MAIL_PUBLIC_IP" bash <<'REMOTE'
set -euo pipefail
set -a
# shellcheck source=/dev/null
source /opt/framm/deploy/.generated/env.production
set +a
if [[ -z "${BULWARK_SESSION_SECRET:-}" ]]; then
  BULWARK_SESSION_SECRET="$(openssl rand -hex 32)"
  printf 'BULWARK_SESSION_SECRET=%s\n' "$BULWARK_SESSION_SECRET" >> /opt/framm/deploy/.generated/env.production
  export BULWARK_SESSION_SECRET
  echo "AVERTISSEMENT: BULWARK_SESSION_SECRET généré sur la VM — alignez deploy/.generated/env.production (terraform) et secrets.BULWARK_SESSION_SECRET (CI)" >&2
fi
# shellcheck source=lib/stalwart-setup.sh
source /opt/framm/deploy/scripts/lib/stalwart-setup.sh
# shellcheck source=lib/host-setup.sh
source /opt/framm/deploy/scripts/lib/host-setup.sh
# shellcheck source=lib/mail-nginx.sh
source /opt/framm/deploy/scripts/lib/mail-nginx.sh
framm_host_setup mail
framm_host_migrate_stalwart
install -d -o 2000 -g 2000 -m 0700 /opt/framm/mail-receipts
mkdir -p /opt/framm/bulwark-data/admin /opt/framm/bulwark-data/admin-state /opt/framm/bulwark-data/settings /opt/framm/bulwark-data/telemetry
cd /opt/framm/deploy/docker
export COMPOSE_PROJECT_NAME=framm-mail
docker compose -f docker-compose.mail.yml pull
docker compose -f docker-compose.mail.yml up -d
framm_stalwart_ensure_ready
bash /opt/framm/deploy/scripts/install-mail-receipts.sh
DOMAIN="${PRIMARY_PLATFORM_DOMAIN}"
framm_mail_apply_nginx "$DOMAIN"
framm_mail_obtain_missing_certs "$DOMAIN" "${BUREAU_ADMIN_EMAIL:-}"
framm_mail_apply_nginx "$DOMAIN"
REMOTE

WEBMAIL_URL="${WEBMAIL_URL:-https://webmail.kod.bzh}" "${ROOT}/deploy/scripts/health-check.sh"
echo "Déploiement mail terminé"
