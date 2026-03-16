#!/usr/bin/env bash
# deploy-landing.sh — Deploy rusNAS landing page to Apache on VM
# Usage: ./deploy-landing.sh

set -e

VM="rusnas@10.10.10.72"
SSH_OPTS="-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
PASS="kl4389qd"
LANDING_DIR="/var/www/rusnas-landing"
APACHE_SITES="/etc/apache2/sites-available"

ssh_sudo() {
    sshpass -p "$PASS" ssh $SSH_OPTS "$VM" "echo '$PASS' | sudo -S $1"
}

echo "==> Copying landing files to VM..."
ssh_sudo "mkdir -p $LANDING_DIR"

sshpass -p "$PASS" scp $SSH_OPTS landing/index.html "$VM:/tmp/rusnas-index.html"
sshpass -p "$PASS" scp $SSH_OPTS landing/apache/rusnas-landing.conf "$VM:/tmp/rusnas-landing.conf"

echo "==> Installing files on VM..."
ssh_sudo "cp /tmp/rusnas-index.html $LANDING_DIR/index.html"
ssh_sudo "chmod 644 $LANDING_DIR/index.html"
ssh_sudo "chown -R www-data:www-data $LANDING_DIR"
ssh_sudo "cp /tmp/rusnas-landing.conf $APACHE_SITES/rusnas-landing.conf"
ssh_sudo "a2ensite rusnas-landing.conf"
ssh_sudo "a2dissite 000-default.conf 2>/dev/null || true"
ssh_sudo "a2enmod headers"
ssh_sudo "systemctl restart apache2"

echo ""
echo "✅  Landing page deployed: http://10.10.10.72/"
