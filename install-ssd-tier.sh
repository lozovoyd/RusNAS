#!/bin/bash
# install-ssd-tier.sh — deploy SSD-кеширование (dm-cache / LVM) на VM
set -e

VM="rusnas@10.10.10.72"
PASS="kl4389qd"
SSH_OPTS="-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

SCP="sshpass -p '$PASS' scp $SSH_OPTS"
SSH="sshpass -p '$PASS' ssh $SSH_OPTS $VM"

echo "==> Deploying Cockpit plugin files..."
sshpass -p "$PASS" scp $SSH_OPTS \
    cockpit/rusnas/disks.html \
    cockpit/rusnas/css/style.css \
    cockpit/rusnas/js/disks.js \
    $VM:/tmp/

sshpass -p "$PASS" ssh $SSH_OPTS $VM "
set -e

echo '==> Copying Cockpit plugin files...'
sudo cp /tmp/disks.html  /usr/share/cockpit/rusnas/disks.html
sudo cp /tmp/style.css   /usr/share/cockpit/rusnas/css/style.css
sudo cp /tmp/disks.js    /usr/share/cockpit/rusnas/js/disks.js
sudo chmod 644 /usr/share/cockpit/rusnas/disks.html \
               /usr/share/cockpit/rusnas/css/style.css \
               /usr/share/cockpit/rusnas/js/disks.js

echo '==> Installing packages...'
sudo apt-get install -y lvm2 thin-provisioning-tools

echo '==> Creating sudoers for SSD-tier...'
sudo tee /etc/sudoers.d/rusnas-ssd-tier > /dev/null << 'EOF'
rusnas ALL=(ALL) NOPASSWD: /sbin/pvcreate, /sbin/pvremove, /sbin/pvs
rusnas ALL=(ALL) NOPASSWD: /sbin/vgcreate, /sbin/vgremove, /sbin/vgs
rusnas ALL=(ALL) NOPASSWD: /sbin/lvcreate, /sbin/lvremove, /sbin/lvs
rusnas ALL=(ALL) NOPASSWD: /sbin/lvconvert, /sbin/lvchange, /sbin/lvdisplay
rusnas ALL=(ALL) NOPASSWD: /sbin/dmsetup
rusnas ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/rusnas/ssd-tiers.json
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/pvcreate, /usr/sbin/pvremove, /usr/sbin/pvs
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/vgcreate, /usr/sbin/vgremove, /usr/sbin/vgs
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/lvcreate, /usr/sbin/lvremove, /usr/sbin/lvs
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/lvconvert, /usr/sbin/lvchange, /usr/sbin/lvdisplay
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/dmsetup
EOF
sudo chmod 440 /etc/sudoers.d/rusnas-ssd-tier

echo '==> Creating /etc/rusnas/ssd-tiers.json...'
sudo mkdir -p /etc/rusnas
if [ ! -f /etc/rusnas/ssd-tiers.json ]; then
    echo '{\"tiers\": []}' | sudo tee /etc/rusnas/ssd-tiers.json > /dev/null
    sudo chmod 644 /etc/rusnas/ssd-tiers.json
fi

echo '==> Done!'
"

echo ""
echo "Install complete. Refresh Cockpit in browser."
