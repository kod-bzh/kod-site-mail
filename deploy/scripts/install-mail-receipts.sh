#!/usr/bin/env bash
set -euo pipefail
install -d -o 2000 -g 2000 -m 0700 /opt/framm/mail-receipts
# Refresh the shared network namespace after any Stalwart recreation.
docker compose --env-file /opt/framm/deploy/.generated/env.production -p framm-mail -f /opt/framm/deploy/docker/docker-compose.mail.yml up -d --force-recreate mail-receipts
for attempt in $(seq 1 15); do
  if docker exec framm-mail-mail-receipts-1 python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8791/health',timeout=2)"; then
    python3 /opt/framm/deploy/scripts/ensure-mail-receipts.py
    exit 0
  fi
  sleep 1
done
echo "Mail receipt bridge unavailable" >&2
exit 1
