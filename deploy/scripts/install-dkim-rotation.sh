#!/usr/bin/env bash
# Run on the mail VM after placing the authorized OVH credential in /etc/framm/ovh-dkim.ini.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ "$(id -u)" == 0 ]] || { echo "Run on mail VM as root" >&2; exit 1; }
[[ -s /etc/framm/ovh-dkim.ini ]] || { echo "OVH zone credential missing" >&2; exit 1; }
chmod 0600 /etc/framm/ovh-dkim.ini
for required in python3 openssl dig; do command -v "$required" >/dev/null; done
python3 "$ROOT/deploy/scripts/rotate-dkim-ovh.py" --configure
install -m 0644 "$ROOT/deploy/systemd/framm-dkim-rotation.service" /etc/systemd/system/
install -m 0644 "$ROOT/deploy/systemd/framm-dkim-rotation.timer" /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/framm-dkim-rotation.service /etc/systemd/system/framm-dkim-rotation.timer
systemctl daemon-reload
systemctl enable --now framm-dkim-rotation.timer
systemctl start framm-dkim-rotation.service
systemctl is-active framm-dkim-rotation.timer
