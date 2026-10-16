#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ "$(id -u)" == 0 ]] || { echo "Run on mail VM as root" >&2; exit 1; }
for required in python3 dig; do command -v "$required" >/dev/null; done
install -d -o 2000 -g 2000 -m 0750 /opt/framm/mail-data/logs
install -m 0644 "$ROOT/deploy/systemd/framm-mail-routing.service" /etc/systemd/system/
install -m 0644 "$ROOT/deploy/systemd/framm-mail-routing.timer" /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/framm-mail-routing.service /etc/systemd/system/framm-mail-routing.timer
systemctl daemon-reload
systemctl enable --now framm-mail-routing.timer
systemctl start framm-mail-routing.service
