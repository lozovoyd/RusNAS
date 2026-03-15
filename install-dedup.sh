#!/bin/bash
# install-dedup.sh — deploy rusNAS Deduplication to VM
set -e

VM="rusnas@10.10.10.72"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== rusNAS Deduplication install ==="

# Deploy backend
scp "$SCRIPT_DIR/rusnas-dedup/rusnas-dedup-run.sh"  "$VM:/tmp/rusnas-dedup-run.sh"
scp "$SCRIPT_DIR/rusnas-dedup/rusnas-dedup.service" "$VM:/tmp/rusnas-dedup.service"

ssh "$VM" bash << 'REMOTE'
set -e
echo "Installing rusnas-dedup..."

sudo mkdir -p /etc/rusnas /var/lib/rusnas /var/log/rusnas

sudo cp /tmp/rusnas-dedup-run.sh /usr/local/bin/rusnas-dedup-run.sh
sudo chmod 755 /usr/local/bin/rusnas-dedup-run.sh

sudo cp /tmp/rusnas-dedup.service /etc/systemd/system/rusnas-dedup.service
sudo chmod 644 /etc/systemd/system/rusnas-dedup.service

# Sudoers
echo "rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-dedup-run.sh, /usr/bin/systemctl start rusnas-dedup.service, /usr/bin/systemctl stop rusnas-dedup.service, /usr/bin/tee /etc/rusnas/dedup-config.json, /usr/bin/tee /etc/cron.d/rusnas-dedup, /usr/bin/rm /etc/cron.d/rusnas-dedup" \
    | sudo tee /etc/sudoers.d/rusnas-dedup > /dev/null
sudo chmod 440 /etc/sudoers.d/rusnas-dedup

# Default config if not exists
if [ ! -f /etc/rusnas/dedup-config.json ]; then
    echo '{
  "volumes": [],
  "samba_vfs_btrfs": false,
  "duperemove_args": "--dedupe-options=block",
  "schedule_enabled": false,
  "schedule_cron": "0 3 * * 1-5"
}' | sudo tee /etc/rusnas/dedup-config.json > /dev/null
fi
sudo chmod 644 /etc/rusnas/dedup-config.json

sudo systemctl daemon-reload
echo "=== Backend installed ==="
REMOTE

# Deploy Cockpit UI
echo "Deploying Cockpit UI..."
scp -r "$SCRIPT_DIR/cockpit/rusnas/"* "$VM:/tmp/rusnas-plugin/"
ssh "$VM" "sudo cp -r /tmp/rusnas-plugin/* /usr/share/cockpit/rusnas/ && sudo chmod -R 644 /usr/share/cockpit/rusnas/ && sudo find /usr/share/cockpit/rusnas/ -type d -exec chmod 755 {} +"

echo "=== Deduplication installed ==="
echo "Open https://10.10.10.72:9090/rusnas/dedup to verify"
