#!/usr/bin/env bash
# install-network.sh — Deploy rusNAS Network module (sudoers + packages) to VM
# Run AFTER ./deploy.sh (which copies all plugin files)
set -e

VM="rusnas@10.10.10.72"
PASS="kl4389qd"
SSH="sshpass -p ${PASS} ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

echo "==> Installing packages..."
$SSH $VM "echo '${PASS}' | sudo -S apt-get install -y traceroute dnsutils netcat-openbsd netcat-traditional etherwake 2>&1 | tail -5"

echo "==> Setting up sudoers for network management..."
SUDOERS_CONTENT="# rusNAS Network module
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/ifup
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/ifdown
rusnas ALL=(ALL) NOPASSWD: /sbin/ip
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/network-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/etherwake
rusnas ALL=(ALL) NOPASSWD: /bin/rm -f /etc/resolv.conf"

echo "$SUDOERS_CONTENT" | sshpass -p "${PASS}" ssh \
  -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  $VM "cat > /tmp/rusnas-network-sudoers"

$SSH $VM "echo '${PASS}' | sudo -S cp /tmp/rusnas-network-sudoers /etc/sudoers.d/rusnas-network && \
          echo '${PASS}' | sudo -S chmod 440 /etc/sudoers.d/rusnas-network && \
          rm /tmp/rusnas-network-sudoers"
$SSH $VM "echo '${PASS}' | sudo -S visudo -c" && echo "sudoers OK"

echo "==> Making network-api.py executable..."
$SSH $VM "echo '${PASS}' | sudo -S chmod 755 /usr/share/cockpit/rusnas/scripts/network-api.py"

echo ""
echo "✅  Network module installed."
echo "    URL: https://10.10.10.72:9090/cockpit/@localhost/rusnas/network.html"
