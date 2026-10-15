#!/usr/bin/env bash
# Attend que le domaine registrar soit actif chez Scaleway, puis applique les records DNS
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ZONE="${1:-kod.bzh}"
MAX_ATTEMPTS="${2:-60}"
SLEEP_SEC="${3:-30}"

echo "Attente activation DNS pour ${ZONE} (max ${MAX_ATTEMPTS} tentatives)..."

for i in $(seq 1 "$MAX_ATTEMPTS"); do
  if scw dns record list "$ZONE" &>/dev/null; then
    echo "Domaine actif après ${i} tentative(s)."
    export DNS_ENABLED=true
    export APP_BZH_ENABLED="${APP_BZH_ENABLED:-false}"
    exec "${ROOT}/deploy/scripts/tf-apply.sh"
  fi
  echo "[${i}/${MAX_ATTEMPTS}] Domaine pas encore actif — nouvelle tentative dans ${SLEEP_SEC}s..."
  sleep "$SLEEP_SEC"
done

echo "Timeout : le domaine ${ZONE} n'est pas encore actif chez Scaleway."
echo "Réessayez plus tard : bin/framm enable-dns"
exit 1
