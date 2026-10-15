#!/usr/bin/env bash
# Exécute les smoke tests infrastructure (JMAP, domaine, Bulwark, TEM) en CI.
# Récupère STALWART_API_KEY depuis la VM mail si absent (pas de secret GitHub dédié).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ROOT}/deploy/.generated/env.production"

# shellcheck source=lib/framm-common.sh
source "${ROOT}/deploy/scripts/lib/framm-common.sh"

framm_ci_setup_ssh
export MAIL_PUBLIC_IP="${MAIL_PUBLIC_IP:?MAIL_PUBLIC_IP requis}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${STALWART_API_KEY:-}" ]]; then
  STALWART_API_KEY="$(framm_ssh "$MAIL_PUBLIC_IP" \
    "grep '^STALWART_API_KEY=' /opt/framm/deploy/.generated/env.production | cut -d= -f2-" \
    2>/dev/null || true)"
  export STALWART_API_KEY
fi

export STALWART_URL="${STALWART_URL:-https://mail.kod.bzh}"
export WEBMAIL_URL="${WEBMAIL_URL:-https://webmail.kod.bzh}"
export PLATFORM_DOMAINS="${PLATFORM_DOMAINS:-kod.bzh}"
export PRIMARY_PLATFORM_DOMAIN="${PRIMARY_PLATFORM_DOMAIN:-kod.bzh}"

if [[ -z "${OUTBOUND_SMTP_RELAY_HOST:-}" ]]; then
  for key in OUTBOUND_SMTP_RELAY_HOST OUTBOUND_SMTP_RELAY_PORT OUTBOUND_SMTP_RELAY_USER OUTBOUND_SMTP_RELAY_SECRET; do
    if [[ -z "${!key:-}" ]]; then
      value="$(framm_ssh "$MAIL_PUBLIC_IP" \
        "grep '^${key}=' /opt/framm/deploy/.generated/env.production 2>/dev/null | cut -d= -f2-" \
        2>/dev/null || true)"
      [[ -n "$value" ]] && export "${key}=${value}"
    fi
  done
fi

cd "${ROOT}/apps/web"
node scripts/run-infra-health-checks.mjs
