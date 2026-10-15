#!/usr/bin/env bash
# Fonctions partagées — sourcer, ne pas exécuter directement
set -euo pipefail

FRAMM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

framm_load_env() {
  local env_file="${FRAMM_ROOT}/.env"
  if [[ ! -f "$env_file" ]]; then
    echo "Fichier .env manquant. Copiez .env.example vers .env"
    exit 1
  fi
  set -a
  # shellcheck source=/dev/null
  source "$env_file"
  set +a

  for var in SCW_ACCESS_KEY SCW_SECRET_KEY SCW_PROJECT_ID ADMIN_PASSWORD BUREAU_ADMIN_EMAIL; do
    if [[ -z "${!var:-}" ]]; then
      echo "Variable $var requise dans .env"
      exit 1
    fi
  done

  unset SCW_PROFILE 2>/dev/null || true
  export SCW_DEFAULT_PROJECT_ID="$SCW_PROJECT_ID"
  export SCW_DEFAULT_REGION="${SCW_DEFAULT_REGION:-fr-par}"
  export SCW_DEFAULT_ZONE="${SCW_DEFAULT_ZONE:-fr-par-1}"

  if [[ -z "${SSH_PUBLIC_KEY:-}" ]]; then
    for key_file in "${HOME}/.ssh/id_ed25519.pub" "${HOME}/.ssh/id_rsa.pub"; do
      if [[ -f "$key_file" ]]; then
        SSH_PUBLIC_KEY="$(tr -d '\n' < "$key_file")"
        break
      fi
    done
  fi

  if [[ -z "${SSH_PUBLIC_KEY:-}" ]]; then
    echo "SSH_PUBLIC_KEY manquante — ajoutez-la dans .env ou placez une clé dans ~/.ssh/"
    exit 1
  fi

  PRIMARY_PLATFORM_DOMAIN="${PRIMARY_PLATFORM_DOMAIN:-kod.bzh}"
  framm_init_ssh
}

framm_init_ssh() {
  FRAMM_KNOWN_HOSTS="/tmp/framm-ssh-known-hosts-${UID:-0}"
  touch "$FRAMM_KNOWN_HOSTS"
  SSH_OPTS=(
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
    -o UserKnownHostsFile="${FRAMM_KNOWN_HOSTS}"
    -o ConnectTimeout=15
  )
  if [[ -n "${SSH_PRIVATE_KEY_FILE:-}" && -f "${SSH_PRIVATE_KEY_FILE}" ]]; then
    SSH_OPTS+=(-i "${SSH_PRIVATE_KEY_FILE}")
  fi
}

framm_ci_setup_ssh() {
  if [[ -z "${SSH_PRIVATE_KEY:-}" ]]; then
    echo "Secret CI SSH_PRIVATE_KEY requis (clé privée correspondant à la VM)"
    exit 1
  fi
  if [[ -f "${SSH_PRIVATE_KEY}" ]]; then
    SSH_PRIVATE_KEY_FILE="${SSH_PRIVATE_KEY}"
  else
    mkdir -p "${HOME}/.ssh"
    chmod 700 "${HOME}/.ssh"
    SSH_PRIVATE_KEY_FILE="${HOME}/.ssh/framm_ci_deploy"
    printf '%s\n' "${SSH_PRIVATE_KEY}" > "${SSH_PRIVATE_KEY_FILE}"
    chmod 600 "${SSH_PRIVATE_KEY_FILE}"
  fi
  export SSH_PRIVATE_KEY_FILE
  framm_init_ssh
}

framm_load_deploy_context() {
  PRIMARY_PLATFORM_DOMAIN="${PRIMARY_PLATFORM_DOMAIN:-kod.bzh}"

  if [[ -n "${MAIL_PUBLIC_IP:-}" ]]; then
    export MAIL_PUBLIC_IP
    [[ -n "${APP_PUBLIC_IP:-}" ]] && export APP_PUBLIC_IP
    return 0
  fi

  if [[ -f "${FRAMM_ROOT}/.env" ]]; then
    framm_load_tf_outputs
    return 0
  fi

  echo "MAIL_PUBLIC_IP requis (variables CI ou terraform output local)"
  exit 1
}

framm_reset_known_hosts() {
  framm_load_tf_outputs 2>/dev/null || true
  : > "/tmp/framm-ssh-known-hosts-${UID}"
  ssh-keygen -R "${MAIL_PUBLIC_IP:-}" -f "${HOME}/.ssh/known_hosts" 2>/dev/null || true
}

framm_load_tf_outputs() {
  local tf_dir="${FRAMM_ROOT}/terraform/environments/prod"
  APP_PUBLIC_IP="$(cd "$tf_dir" && terraform output -raw app_public_ip)"
  MAIL_PUBLIC_IP="$(cd "$tf_dir" && terraform output -raw mail_public_ip)"
  export APP_PUBLIC_IP MAIL_PUBLIC_IP
}

framm_ssh() {
  local host="$1"
  shift
  ssh "${SSH_OPTS[@]}" "root@${host}" "$@"
}

framm_wait_ssh() {
  local host="$1"
  local max="${2:-40}"
  echo "Attente SSH sur ${host} (max ${max}×10s)..."
  for i in $(seq 1 "$max"); do
    if framm_ssh "$host" "command -v docker >/dev/null && systemctl is-active docker >/dev/null" 2>/dev/null; then
      echo "SSH OK sur ${host} (${i} tentative(s))"
      return 0
    fi
    echo "[${i}/${max}] SSH pas encore prêt..."
    sleep 10
  done
  echo "Timeout SSH sur ${host}"
  return 1
}

framm_rsync_prepare() {
  cp "${FRAMM_ROOT}/deploy/scripts/lib/ssh-rsync.sh" /tmp/framm-ssh-rsync.sh
  chmod +x /tmp/framm-ssh-rsync.sh
}

framm_rsync_app() {
  framm_rsync_prepare
  rsync -az --delete -e /tmp/framm-ssh-rsync.sh \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '.next' \
    --exclude 'terraform/.terraform' \
    --exclude 'terraform/**/terraform.tfstate*' \
    --exclude '.env' \
    --exclude 'deploy/.generated' \
    "${FRAMM_ROOT}/" "root@${APP_PUBLIC_IP}:/opt/framm/"
}

framm_rsync_mail() {
  framm_rsync_prepare
  rsync -az --delete -e /tmp/framm-ssh-rsync.sh \
    --exclude '.git' \
    --exclude '.generated' \
    "${FRAMM_ROOT}/deploy/" "root@${MAIL_PUBLIC_IP}:/opt/framm/deploy/"
}


framm_mail_ensure_env_key() {
  local key="$1"
  local value="$2"
  [[ -n "$value" ]] || return 0
  framm_ssh "$MAIL_PUBLIC_IP" bash -s "$key" "$value" <<'REMOTE'
set -euo pipefail
key="$1"
value="$2"
target=/opt/framm/deploy/.generated/env.production
mkdir -p "$(dirname "$target")"
touch "$target"
if grep -q "^${key}=" "$target" 2>/dev/null; then
  current="$(grep "^${key}=" "$target" | head -1 | cut -d= -f2-)"
  if [[ -z "$current" ]]; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$target"
  fi
else
  printf '%s=%s\n' "$key" "$value" >> "$target"
fi
REMOTE
  echo "Clé ${key} synchronisée sur la VM mail (si absente ou vide)"
}

# Dépose env.production sur les VMs (le rsync exclut .generated pour ne pas
# écraser les valeurs mises à jour côté VM, comme la clé API Stalwart
# régénérée). Si le fichier existe déjà sur la VM, seules les clés absentes
# sont ajoutées — ex: nouvelles variables ALERT_SMTP_*.
framm_push_env() {
  local env_file="${FRAMM_ROOT}/deploy/.generated/env.production"
  [[ -f "$env_file" ]] || return 0
  local host="$MAIL_PUBLIC_IP"
  framm_ssh "$host" "mkdir -p /opt/framm/deploy/.generated"
  if framm_ssh "$host" "test -f /opt/framm/deploy/.generated/env.production" 2>/dev/null; then
    scp "${SSH_OPTS[@]}" "$env_file" "root@${host}:/tmp/framm-env.new"
    framm_ssh "$host" bash <<'MERGE'
set -euo pipefail
target=/opt/framm/deploy/.generated/env.production
terraform_managed_keys=(
  OUTBOUND_SMTP_RELAY_HOST
  OUTBOUND_SMTP_RELAY_PORT
  OUTBOUND_SMTP_RELAY_USER
  OUTBOUND_SMTP_RELAY_SECRET
  ALERT_SMTP_HOST
  ALERT_SMTP_PORT
  ALERT_SMTP_USER
  ALERT_SMTP_PASSWORD
  ALERT_SMTP_FROM
)
while IFS= read -r line; do
  [[ "$line" == *=* ]] || continue
  key="${line%%=*}"
  value="${line#*=}"
  if grep -q "^${key}=" "$target" 2>/dev/null; then
    update=false
    for managed in "${terraform_managed_keys[@]}"; do
      if [[ "$key" == "$managed" && -n "$value" ]]; then
        update=true
        break
      fi
    done
    if $update; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$target"
    fi
  else
    printf '%s\n' "$line" >> "$target"
  fi
done < /tmp/framm-env.new
rm -f /tmp/framm-env.new
MERGE
  else
    scp "${SSH_OPTS[@]}" "$env_file" "root@${host}:/opt/framm/deploy/.generated/env.production"
    echo "env.production déposé sur ${host}"
  fi
}

framm_render_nginx() {
  local template="$1"
  local output="$2"
  local domain="${PRIMARY_PLATFORM_DOMAIN}"
  sed "s/\${PRIMARY_DOMAIN}/${domain}/g" "$template" > "$output"
}

framm_wait_dns_public() {
  local domain="${PRIMARY_PLATFORM_DOMAIN}"
  local expected_ip="$APP_PUBLIC_IP"
  local max="${1:-60}"
  echo "Attente propagation DNS publique pour ${domain} → ${expected_ip}..."
  for i in $(seq 1 "$max"); do
    local resolved
    resolved="$(dig +short "$domain" A @1.1.1.1 2>/dev/null | head -1 || true)"
    if [[ "$resolved" == "$expected_ip" ]]; then
      echo "DNS public OK après ${i} tentative(s)"
      return 0
    fi
    echo "[${i}/${max}] DNS: '${resolved:-vide}' — attente 30s..."
    sleep 30
  done
  echo "DNS public pas encore propagé — poursuite (certificats peuvent échouer)"
  return 1
}
