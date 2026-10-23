#!/usr/bin/env bash
# Déploie Stalwart sur la VM Mail (app sur Kapsule)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=lib/framm-common.sh
source "${ROOT}/deploy/scripts/lib/framm-common.sh"

framm_load_env
framm_load_tf_outputs

framm_wait_ssh "$MAIL_PUBLIC_IP"

echo "Synchronisation VM Mail..."
framm_rsync_mail
framm_push_env

echo "Déploiement stack Mail (Stalwart)..."
framm_ssh "$MAIL_PUBLIC_IP" bash <<'REMOTE'
set -euo pipefail
set -a
source /opt/framm/deploy/.generated/env.production
set +a
# shellcheck source=lib/host-setup.sh
source /opt/framm/deploy/scripts/lib/host-setup.sh
framm_host_setup mail
framm_host_migrate_stalwart
install -d -o 2000 -g 2000 -m 0700 /opt/framm/mail-receipts
cd /opt/framm/deploy/docker
export COMPOSE_PROJECT_NAME=framm-mail
docker compose -f docker-compose.mail.yml pull
docker compose -f docker-compose.mail.yml up -d
# shellcheck source=lib/stalwart-setup.sh
source /opt/framm/deploy/scripts/lib/stalwart-setup.sh
framm_stalwart_ensure_ready
bash /opt/framm/deploy/scripts/install-mail-receipts.sh
REMOTE

echo "Nginx mail (TLS si certificats présents)..."
framm_ssh "$MAIL_PUBLIC_IP" bash -s "$PRIMARY_PLATFORM_DOMAIN" <<'REMOTE'
set -euo pipefail
set -a
# shellcheck source=/dev/null
source /opt/framm/deploy/.generated/env.production
set +a
# shellcheck source=lib/mail-nginx.sh
source /opt/framm/deploy/scripts/lib/mail-nginx.sh
framm_mail_apply_nginx "$1"
framm_mail_obtain_missing_certs "$1" "${BUREAU_ADMIN_EMAIL:-}"
framm_mail_apply_nginx "$1"
framm_mail_install_certbot_hooks
# shellcheck source=lib/stalwart-setup.sh
source /opt/framm/deploy/scripts/lib/stalwart-setup.sh
framm_stalwart_sync_le_certs || true
framm_stalwart_ensure_le_tls || true
systemctl enable nginx
REMOTE

framm_ssh "$MAIL_PUBLIC_IP" bash <<'REMOTE'
if [[ -s /etc/framm/ovh-dkim.ini ]]; then
  bash /opt/framm/deploy/scripts/install-dkim-rotation.sh
fi
REMOTE

echo "Déploiement mail terminé"
