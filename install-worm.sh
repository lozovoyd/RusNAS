#!/bin/bash
# install-worm.sh — deploy rusNAS WORM enforcement to VM
set -e

VM="rusnas@10.10.10.72"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== rusNAS WORM install ==="

scp "$SCRIPT_DIR/rusnas-worm/rusnas-worm.py"      "$VM:/tmp/rusnas-worm.py"
scp "$SCRIPT_DIR/rusnas-worm/rusnas-worm.service"  "$VM:/tmp/rusnas-worm.service"
scp "$SCRIPT_DIR/rusnas-worm/rusnas-worm.timer"    "$VM:/tmp/rusnas-worm.timer"

ssh "$VM" bash << 'REMOTE'
set -e
echo "Installing rusnas-worm..."

sudo mkdir -p /etc/rusnas

sudo cp /tmp/rusnas-worm.py /usr/local/bin/rusnas-worm
sudo chmod 755 /usr/local/bin/rusnas-worm

sudo cp /tmp/rusnas-worm.service /etc/systemd/system/rusnas-worm.service
sudo cp /tmp/rusnas-worm.timer   /etc/systemd/system/rusnas-worm.timer
sudo chmod 644 /etc/systemd/system/rusnas-worm.service /etc/systemd/system/rusnas-worm.timer

# Sudoers
echo "rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-worm" | sudo tee /etc/sudoers.d/rusnas-worm > /dev/null
sudo chmod 440 /etc/sudoers.d/rusnas-worm

# Default config if not exists
if [ ! -f /etc/rusnas/worm.json ]; then
    echo '{"paths":[]}' | sudo tee /etc/rusnas/worm.json > /dev/null
fi
sudo chmod 644 /etc/rusnas/worm.json

sudo systemctl daemon-reload
sudo systemctl enable --now rusnas-worm.timer

echo "Timer status:"
systemctl is-active rusnas-worm.timer
echo "=== Done ==="
REMOTE

echo "=== WORM installed ==="
