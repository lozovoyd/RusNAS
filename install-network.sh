#!/usr/bin/env bash
# install-network.sh — Deploy rusNAS Network module (sudoers + packages) to VM
# Run AFTER ./deploy.sh (which copies all plugin files)
set -e

VM="rusnas@10.10.10.72"
PASS="kl4389qd"
SSH="sshpass -p ${PASS} ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

echo "==> Installing packages..."
$SSH $VM "echo '${PASS}' | sudo -S apt-get install -y traceroute dnsutils netcat-openbsd netcat-traditional etherwake certbot 2>&1 | tail -5"

echo "==> Setting up sudoers for network management..."
SUDOERS_CONTENT="# rusNAS Network module
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/ifup
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/ifdown
rusnas ALL=(ALL) NOPASSWD: /sbin/ip
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/network-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/certs-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/etherwake
rusnas ALL=(ALL) NOPASSWD: /bin/rm -f /etc/resolv.conf
rusnas ALL=(ALL) NOPASSWD: /usr/bin/certbot
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/certbot
rusnas ALL=(ALL) NOPASSWD: /usr/bin/openssl
rusnas ALL=(ALL) NOPASSWD: /bin/mkdir -p /etc/rusnas/certs/*
rusnas ALL=(ALL) NOPASSWD: /bin/chmod * /etc/rusnas/certs/*"

echo "$SUDOERS_CONTENT" | sshpass -p "${PASS}" ssh \
  -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  $VM "cat > /tmp/rusnas-network-sudoers"

$SSH $VM "echo '${PASS}' | sudo -S cp /tmp/rusnas-network-sudoers /etc/sudoers.d/rusnas-network && \
          echo '${PASS}' | sudo -S chmod 440 /etc/sudoers.d/rusnas-network && \
          rm /tmp/rusnas-network-sudoers"
$SSH $VM "echo '${PASS}' | sudo -S visudo -c" && echo "sudoers OK"

echo "==> Making scripts executable..."
$SSH $VM "echo '${PASS}' | sudo -S chmod 755 /usr/share/cockpit/rusnas/scripts/network-api.py && \
          echo '${PASS}' | sudo -S chmod 755 /usr/share/cockpit/rusnas/scripts/certs-api.py"

echo "==> Creating cert directories..."
$SSH $VM "echo '${PASS}' | sudo -S mkdir -p /etc/rusnas/certs /var/log/rusnas && \
          echo '${PASS}' | sudo -S chmod 755 /etc/rusnas/certs && \
          echo '${PASS}' | sudo -S touch /var/log/rusnas/certcheck.log && \
          echo '${PASS}' | sudo -S chmod 644 /var/log/rusnas/certcheck.log"

echo "==> Deploying certcheck systemd timer..."
sshpass -p "${PASS}" scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  rusnas-certcheck/rusnas-certcheck.service \
  rusnas-certcheck/rusnas-certcheck.timer \
  $VM:/tmp/
$SSH $VM "echo '${PASS}' | sudo -S cp /tmp/rusnas-certcheck.service /etc/systemd/system/ && \
          echo '${PASS}' | sudo -S cp /tmp/rusnas-certcheck.timer /etc/systemd/system/ && \
          echo '${PASS}' | sudo -S systemctl daemon-reload && \
          echo '${PASS}' | sudo -S systemctl enable --now rusnas-certcheck.timer"
$SSH $VM "echo '${PASS}' | sudo -S systemctl is-active rusnas-certcheck.timer" && echo "timer OK"

echo "==> Installing domain packages (optional, may take a while)..."
$SSH $VM "echo '${PASS}' | sudo -S apt-get install -y --no-install-recommends realmd adcli winbind libnss-winbind libpam-winbind krb5-user samba-common-bin 2>&1 | tail -5" || echo "(некоторые пакеты домена недоступны — пропускаем)"

echo "==> Adding domain-api sudoers..."
DOMAIN_SUDOERS="# rusNAS Domain module
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/domain-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/realm
rusnas ALL=(ALL) NOPASSWD: /usr/bin/net
rusnas ALL=(ALL) NOPASSWD: /usr/bin/wbinfo
rusnas ALL=(ALL) NOPASSWD: /usr/bin/samba-tool
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart winbind
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart smbd
rusnas ALL=(ALL) NOPASSWD: /usr/bin/kinit"

echo "$DOMAIN_SUDOERS" | sshpass -p "${PASS}" ssh \
  -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  $VM "cat > /tmp/rusnas-domain-sudoers"

$SSH $VM "echo '${PASS}' | sudo -S cp /tmp/rusnas-domain-sudoers /etc/sudoers.d/rusnas-domain && \
          echo '${PASS}' | sudo -S chmod 440 /etc/sudoers.d/rusnas-domain && \
          rm /tmp/rusnas-domain-sudoers"
$SSH $VM "echo '${PASS}' | sudo -S visudo -c" && echo "domain sudoers OK"

echo "==> Making domain-api.py executable..."
$SSH $VM "echo '${PASS}' | sudo -S chmod 755 /usr/share/cockpit/rusnas/scripts/domain-api.py"

echo ""
echo "✅  Network module installed (including Certificates + Domain tabs)."
echo "    URL: https://10.10.10.72:9090/cockpit/@localhost/rusnas/network.html"
