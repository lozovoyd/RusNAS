#!/bin/bash
# install-guard.sh — Deploy rusnas-guard daemon to VM and install dependencies
set -e

VM_HOST="10.10.10.72"
VM_USER="rusnas"
VM_PASS="kl4389qd"

SSH="sshpass -p ${VM_PASS} ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SCP="sshpass -p ${VM_PASS} scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Uploading daemon files..."
$SSH ${VM_USER}@${VM_HOST} "mkdir -p /tmp/rusnas-guard-install/daemon /tmp/rusnas-guard-install/config"

$SCP "${DIR}/rusnas-guard/daemon/guard.py"         ${VM_USER}@${VM_HOST}:/tmp/rusnas-guard-install/daemon/
$SCP "${DIR}/rusnas-guard/daemon/detector.py"      ${VM_USER}@${VM_HOST}:/tmp/rusnas-guard-install/daemon/
$SCP "${DIR}/rusnas-guard/daemon/entropy.py"       ${VM_USER}@${VM_HOST}:/tmp/rusnas-guard-install/daemon/
$SCP "${DIR}/rusnas-guard/daemon/honeypot.py"      ${VM_USER}@${VM_HOST}:/tmp/rusnas-guard-install/daemon/
$SCP "${DIR}/rusnas-guard/daemon/response.py"      ${VM_USER}@${VM_HOST}:/tmp/rusnas-guard-install/daemon/
$SCP "${DIR}/rusnas-guard/daemon/socket_server.py" ${VM_USER}@${VM_HOST}:/tmp/rusnas-guard-install/daemon/
$SCP "${DIR}/rusnas-guard/service/rusnas-guard.service" ${VM_USER}@${VM_HOST}:/tmp/rusnas-guard-install/
$SCP "${DIR}/rusnas-guard/config/config.json"           ${VM_USER}@${VM_HOST}:/tmp/rusnas-guard-install/config/
$SCP "${DIR}/rusnas-guard/config/ransom_extensions.txt" ${VM_USER}@${VM_HOST}:/tmp/rusnas-guard-install/config/

echo "==> Installing on VM..."
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -s" << 'REMOTE'
set -e

# Install Python dependencies
apt-get install -y python3-inotify python3-bcrypt btrfs-progs nftables openssh-client 2>/dev/null || true

# Create directories
mkdir -p /usr/lib/rusnas-guard
mkdir -p /etc/rusnas-guard
mkdir -p /var/log/rusnas-guard
mkdir -p /run/rusnas-guard

# Copy daemon
cp /tmp/rusnas-guard-install/daemon/* /usr/lib/rusnas-guard/
chmod 755 /usr/lib/rusnas-guard/guard.py
chmod 644 /usr/lib/rusnas-guard/*.py

# Copy service
cp /tmp/rusnas-guard-install/rusnas-guard.service /lib/systemd/system/
chmod 644 /lib/systemd/system/rusnas-guard.service

# Copy default config (only if not exists)
[ -f /etc/rusnas-guard/config.json ] || cp /tmp/rusnas-guard-install/config/config.json /etc/rusnas-guard/
[ -f /etc/rusnas-guard/ransom_extensions.txt ] || cp /tmp/rusnas-guard-install/config/ransom_extensions.txt /etc/rusnas-guard/

# Permissions
chmod 700 /etc/rusnas-guard
chmod 640 /etc/rusnas-guard/config.json || true
chmod 644 /etc/rusnas-guard/ransom_extensions.txt || true

# Symlink for CLI convenience: sudo rusnas-guard --reset-pin
ln -sf /usr/lib/rusnas-guard/guard.py /usr/local/sbin/rusnas-guard

# Enable and start daemon — it always runs (idle until monitoring is activated via PIN in UI)
systemctl daemon-reload
systemctl enable --now rusnas-guard
echo "rusnas-guard installed and started. Monitoring is inactive until activated from Cockpit UI with PIN."

# Cleanup
rm -rf /tmp/rusnas-guard-install
REMOTE

echo "==> Deploying Cockpit plugin (guard.html + guard.js + manifest)..."
bash "${DIR}/deploy.sh"

echo ""
echo "==> Done!"
echo "    Open https://${VM_HOST}:9090 → Guard 🛡️ to configure."
