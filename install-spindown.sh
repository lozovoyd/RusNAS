#!/bin/bash
# install-spindown.sh — deploy rusNAS RAID Backup Mode (spindown) to VM
set -e

VM="rusnas@10.10.10.72"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== rusNAS RAID Backup Mode install ==="

# Ensure remote temp dir exists before scp
ssh "$VM" "mkdir -p /tmp/rusnas-spind"

# Copy daemon files
scp -r "$SCRIPT_DIR/rusnas-spind/"* "$VM:/tmp/rusnas-spind/"

# Copy CGI
scp "$SCRIPT_DIR/cockpit/rusnas/cgi/spindown_ctl.py" "$VM:/tmp/spindown_ctl.py"

ssh "$VM" bash << 'REMOTE'
set -e
echo "Installing rusnas-spind..."

# Directories
sudo mkdir -p /usr/lib/rusnas/spind /usr/lib/rusnas/cgi \
              /etc/rusnas /var/lib/rusnas /var/log/rusnas \
              /run/rusnas

# Install daemon
sudo cp /tmp/rusnas-spind/*.py /usr/lib/rusnas/spind/
sudo chmod 755 /usr/lib/rusnas/spind/*.py

# Install CGI
sudo cp /tmp/spindown_ctl.py /usr/lib/rusnas/cgi/spindown_ctl.py
sudo chmod 755 /usr/lib/rusnas/cgi/spindown_ctl.py

# Install hdparm if needed
which hdparm >/dev/null 2>&1 || sudo apt-get install -y hdparm

# Default config if not exists
if [ ! -f /etc/rusnas/spindown.json ]; then
    echo '{"version":1,"arrays":{}}' | sudo tee /etc/rusnas/spindown.json > /dev/null
fi
sudo chmod 644 /etc/rusnas/spindown.json

# Sudoers: allow spindown_ctl.py
echo "rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/cgi/spindown_ctl.py *" \
    | sudo tee /etc/sudoers.d/rusnas-spindown > /dev/null
sudo chmod 440 /etc/sudoers.d/rusnas-spindown

# systemd unit
sudo cp /tmp/rusnas-spind/rusnas-spind.service /etc/systemd/system/rusnas-spind.service
sudo chmod 644 /etc/systemd/system/rusnas-spind.service
sudo systemctl daemon-reload
sudo systemctl enable rusnas-spind
sudo systemctl restart rusnas-spind || sudo systemctl start rusnas-spind

sleep 2
sudo systemctl status rusnas-spind --no-pager

echo "Done! Daemon status above."
REMOTE

echo "=== Deploy complete ==="
