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
SSH="sshpass -p '$VM_PASS' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SCP="sshpass -p '$VM_PASS' scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

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
eval $SSH $VM_USER@$VM_HOST "sudo mkdir -p /usr/share/rusnas-help && sudo chown $VM_USER:$VM_USER /usr/share/rusnas-help"
eval $SCP -r user-docs/site/* $VM_USER@$VM_HOST:/usr/share/rusnas-help/
eval $SSH $VM_USER@$VM_HOST "sudo chown -R root:root /usr/share/rusnas-help && sudo chmod -R 644 /usr/share/rusnas-help && sudo find /usr/share/rusnas-help -type d -exec chmod 755 {} +"
echo ""

# 3. Install nginx config
echo "▸ [3/4] Настройка nginx..."
eval $SCP user-docs/nginx-rusnas-help.conf $VM_USER@$VM_HOST:/tmp/rusnas-help.conf
eval $SSH $VM_USER@$VM_HOST "sudo cp /tmp/rusnas-help.conf /etc/nginx/conf.d/rusnas-apps/rusnas-help.conf && sudo nginx -t 2>&1 && sudo systemctl reload nginx"
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
