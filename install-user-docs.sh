#!/usr/bin/env bash
# ============================================================
# Deploy RusNAS User Documentation to VM
# Builds MkDocs site and deploys to /usr/share/rusnas-help/
# Accessible at https://<IP>/help/
# ============================================================
set -euo pipefail

VM_USER="rusnas"
VM_HOST="10.10.10.72"
VM_PASS="kl4389qd"
SSH_OPTS="-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SSH="sshpass -p $VM_PASS ssh $SSH_OPTS"
SCP="sshpass -p $VM_PASS scp $SSH_OPTS"
SUDO="echo $VM_PASS | sudo -S"

echo "╔══════════════════════════════════════════╗"
echo "║  Деплой документации пользователя        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# 1. Build
echo "▸ [1/4] Сборка документации..."
cd user-docs
python3 -m mkdocs build -d site --clean 2>&1 | grep -E "INFO|WARNING|ERROR" | head -5
cd ..
echo ""

# 2. Copy to VM
echo "▸ [2/4] Копирование на VM..."
$SSH $VM_USER@$VM_HOST "echo $VM_PASS | sudo -S mkdir -p /usr/share/rusnas-help && echo $VM_PASS | sudo -S chown $VM_USER:$VM_USER /usr/share/rusnas-help"
$SCP -r user-docs/site/* $VM_USER@$VM_HOST:/usr/share/rusnas-help/
$SSH $VM_USER@$VM_HOST "echo $VM_PASS | sudo -S chown -R root:root /usr/share/rusnas-help && echo $VM_PASS | sudo -S chmod -R 644 /usr/share/rusnas-help && echo $VM_PASS | sudo -S find /usr/share/rusnas-help -type d -exec chmod 755 {} +"
echo ""

# 3. Install nginx config
echo "▸ [3/4] Настройка nginx..."
$SCP user-docs/nginx-rusnas-help.conf $VM_USER@$VM_HOST:/tmp/rusnas-help.conf
$SSH $VM_USER@$VM_HOST "echo $VM_PASS | sudo -S cp /tmp/rusnas-help.conf /etc/nginx/conf.d/rusnas-apps/rusnas-help.conf && echo $VM_PASS | sudo -S nginx -t 2>&1 && echo $VM_PASS | sudo -S systemctl reload nginx"
echo ""

# 4. Verify
echo "▸ [4/4] Проверка..."
HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" "https://$VM_HOST/help/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo "  ✓ Документация доступна: https://$VM_HOST/help/"
else
    echo "  ⚠ HTTP $HTTP_CODE — проверьте nginx конфигурацию"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✓ Деплой завершён!                      ║"
echo "║  URL: https://$VM_HOST/help/             ║"
echo "╚══════════════════════════════════════════╝"
