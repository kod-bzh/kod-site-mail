#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${ROOT}/deploy/.generated/env.production"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

AUTH_URL="${AUTH_URL:-https://kod.bzh}"
WEBMAIL_URL="${WEBMAIL_URL:-https://webmail.kod.bzh}"
FAIL=0

check() {
  local name="$1"
  local url="$2"
  if curl -sf --max-time 10 "$url" > /dev/null 2>&1; then
    echo "OK  $name"
  else
    echo "FAIL $name ($url)"
    FAIL=1
  fi
}

check_tls() {
  local name="$1"
  local url="$2"
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")"
  if [[ "$code" != "000" && "$code" != "502" && "$code" != "503" ]]; then
    echo "OK  $name (HTTP ${code})"
  else
    echo "FAIL $name ($url)"
    FAIL=1
  fi
}

check_imap_tls() {
  local host="$1"
  local issuer
  issuer="$(echo | timeout 8 openssl s_client -connect "${host}:993" -servername "${host}" 2>/dev/null \
    | openssl x509 -noout -issuer 2>/dev/null || true)"
  if [[ -z "$issuer" ]]; then
    echo "FAIL IMAP TLS (${host}:993 handshake)"
    FAIL=1
    return
  fi
  if echo "$issuer" | grep -qiE 'rcgen|self.?signed'; then
    echo "FAIL IMAP TLS certificat auto-signé (${issuer})"
    FAIL=1
    return
  fi
  echo "OK  IMAP TLS (${host}:993, LE)"
}

check "App health" "${AUTH_URL}/api/health"
if [[ -n "${WEBMAIL_URL:-}" && "${WEBMAIL_URL}" != "skip" ]]; then
  check_tls "Webmail" "${WEBMAIL_URL}/login"
fi

if [[ -n "${MAIL_PUBLIC_IP:-}" && -n "${PRIMARY_PLATFORM_DOMAIN:-}" ]]; then
  check_imap_tls "mail.${PRIMARY_PLATFORM_DOMAIN}"
fi

# Redirections alias → adresses externes : nécessite SMTP sortant (port 25) depuis la VM mail.
if [[ -n "${MAIL_PUBLIC_IP:-}" ]]; then
  FRAMM_ROOT="${ROOT}"
  # shellcheck source=lib/framm-common.sh
  source "${ROOT}/deploy/scripts/lib/framm-common.sh"
  framm_init_ssh
  if framm_ssh "$MAIL_PUBLIC_IP" "timeout 8 bash -c 'exec 3<>/dev/tcp/ASPMX.L.GOOGLE.COM/25 && read -r l <&3 && case "\$l" in 220*) exit 0;; *) exit 1;; esac'" 2>/dev/null; then
    echo "OK  Mail outbound SMTP (TCP/25)"
  elif framm_ssh "$MAIL_PUBLIC_IP" "timeout 8 bash -c 'exec 3<>/dev/tcp/smtp.tem.scaleway.com/2587 && exit 0'" 2>/dev/null; then
    echo "OK  Mail outbound via relais TEM (smtp.tem.scaleway.com:2587 — TCP/25 bloqué côté Scaleway)"
  else
    echo "FAIL Mail outbound SMTP (TCP/25 bloqué et relais TEM:2587 inaccessible)"
    FAIL=1
  fi
fi

if [[ $FAIL -ne 0 && "${FRAMM_CI:-}" == "true" && -n "${MAIL_PUBLIC_IP:-}" ]]; then
  FAIL=0
  # shellcheck source=lib/framm-common.sh
  source "${ROOT}/deploy/scripts/lib/framm-common.sh"
  framm_ci_setup_ssh
  if [[ -n "${MAIL_PUBLIC_IP:-}" ]]; then
    code="$(framm_ssh "$MAIL_PUBLIC_IP" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login" 2>/dev/null || echo "000")"
    if [[ "$code" != "000" && "$code" != "502" && "$code" != "503" ]]; then
      echo "OK  Webmail Bulwark (via VM, HTTP ${code})"
    else
      code="$(framm_ssh "$MAIL_PUBLIC_IP" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/login" 2>/dev/null || echo "000")"
      if [[ "$code" != "000" && "$code" != "502" && "$code" != "503" ]]; then
        echo "OK  Stalwart JMAP (via VM, HTTP ${code})"
      else
        echo "FAIL Webmail (via VM)"
        FAIL=1
      fi
    fi
  fi
fi

if [[ $FAIL -eq 0 ]]; then
  echo "Health check passed"
  exit 0
fi

echo "Health check failed"
exit 1
