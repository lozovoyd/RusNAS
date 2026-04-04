#!/bin/bash
# install-notify.sh — Deploy rusNAS notification system to VM
set -e

VM_HOST="10.10.10.72"
VM_USER="rusnas"
VM_PASS="kl4389qd"

SSH="sshpass -p ${VM_PASS} ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SCP="sshpass -p ${VM_PASS} scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Uploading notification daemon files..."
$SSH ${VM_USER}@${VM_HOST} "mkdir -p /tmp/rusnas-notify-install/daemon/channels /tmp/rusnas-notify-install/service /tmp/rusnas-notify-install/config"

$SCP ${DIR}/rusnas-notify/daemon/*.py ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/daemon/
$SCP ${DIR}/rusnas-notify/daemon/channels/*.py ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/daemon/channels/
$SCP ${DIR}/rusnas-notify/cli.py ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/
$SCP ${DIR}/rusnas-notify/config/notify.json ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/config/
$SCP ${DIR}/rusnas-notify/service/*.service ${DIR}/rusnas-notify/service/*.timer ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/service/
$SCP ${DIR}/cockpit/rusnas/scripts/notify-check.py ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/

echo "==> Uploading Cockpit UI files..."
$SCP ${DIR}/cockpit/rusnas/notifications.html ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/
$SCP ${DIR}/cockpit/rusnas/js/notifications.js ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/
$SCP ${DIR}/cockpit/rusnas/css/notifications.css ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/

echo "==> Installing on VM..."
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -s" << 'REMOTE'
set -e

# Install dependencies
apt-get install -y snmp 2>/dev/null || true

# ── Daemon files
mkdir -p /usr/lib/rusnas/notify/channels
cp /tmp/rusnas-notify-install/daemon/*.py /usr/lib/rusnas/notify/
cp /tmp/rusnas-notify-install/daemon/channels/*.py /usr/lib/rusnas/notify/channels/
chmod 644 /usr/lib/rusnas/notify/*.py /usr/lib/rusnas/notify/channels/*.py
chmod 755 /usr/lib/rusnas/notify/notifyd.py

# ── CLI
cp /tmp/rusnas-notify-install/cli.py /usr/lib/rusnas/notify/cli.py
chmod 755 /usr/lib/rusnas/notify/cli.py
ln -sf /usr/lib/rusnas/notify/cli.py /usr/local/bin/rusnas-notify

# ── Config (preserve existing)
mkdir -p /etc/rusnas
[ -f /etc/rusnas/notify.json ] || cp /tmp/rusnas-notify-install/config/notify.json /etc/rusnas/notify.json
chmod 640 /etc/rusnas/notify.json

# ── Directories
mkdir -p /var/lib/rusnas
mkdir -p /var/spool/rusnas-notify
mkdir -p /var/log/rusnas
mkdir -p /run/rusnas-notify
chmod 755 /run/rusnas-notify

# ── Systemd
cp /tmp/rusnas-notify-install/service/*.service /lib/systemd/system/
cp /tmp/rusnas-notify-install/service/*.timer /lib/systemd/system/
chmod 644 /lib/systemd/system/rusnas-notifyd.service
chmod 644 /lib/systemd/system/rusnas-notify-check.service
chmod 644 /lib/systemd/system/rusnas-notify-check.timer

# ── Sudoers
cat > /etc/sudoers.d/rusnas-notify << 'SUDOERS'
rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-notify
SUDOERS
chmod 440 /etc/sudoers.d/rusnas-notify

# ── Checker script
cp /tmp/rusnas-notify-install/notify-check.py /usr/share/cockpit/rusnas/scripts/notify-check.py
chmod 755 /usr/share/cockpit/rusnas/scripts/notify-check.py

# ── Cockpit UI
cp /tmp/rusnas-notify-install/notifications.html /usr/share/cockpit/rusnas/
cp /tmp/rusnas-notify-install/notifications.js /usr/share/cockpit/rusnas/js/
cp /tmp/rusnas-notify-install/notifications.css /usr/share/cockpit/rusnas/css/

# ── Init DB
python3 /usr/lib/rusnas/notify/notifyd.py --init-db

# ── Enable and start
systemctl daemon-reload
systemctl enable --now rusnas-notifyd.service
systemctl enable --now rusnas-notify-check.timer

# ── Cleanup
rm -rf /tmp/rusnas-notify-install

echo "==> rusnas-notify installed successfully"
REMOTE

echo "==> Done! Notification system deployed."
