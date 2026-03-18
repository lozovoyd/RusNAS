#!/bin/bash
# install-ups.sh — Deploy UPS/NUT support to rusNAS VM
set -e

VM="rusnas@10.10.10.72"
PASS="kl4389qd"
SSH="sshpass -p '$PASS' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

echo "=== [1/5] Устанавливаем NUT на VM ==="
sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    "$VM" "sudo apt-get install -y nut 2>&1 | tail -5 && echo '✓ NUT установлен'"

echo "=== [2/5] Создаём директорию /etc/nut ==="
sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    "$VM" "sudo mkdir -p /etc/nut && sudo chmod 755 /etc/nut"

echo "=== [3/5] Копируем скрипт уведомлений ==="
sshpass -p "$PASS" scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    rusnas-ups/rusnas-ups-notify.sh "$VM":/tmp/rusnas-ups-notify.sh
sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    "$VM" "sudo cp /tmp/rusnas-ups-notify.sh /usr/local/bin/rusnas-ups-notify && \
           sudo chmod +x /usr/local/bin/rusnas-ups-notify && \
           echo '✓ Notify script установлен'"

echo "=== [4/5] Настраиваем sudoers ==="
sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    "$VM" "sudo tee /etc/sudoers.d/rusnas-nut > /dev/null <<'EOF'
rusnas ALL=(ALL) NOPASSWD: /usr/bin/upsc
rusnas ALL=(ALL) NOPASSWD: /usr/bin/nut-scanner
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl start nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl stop nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl status nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart nut-server
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart nut-monitor
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/upsdrvctl
rusnas ALL=(ALL) NOPASSWD: /usr/bin/journalctl
rusnas ALL=(ALL) NOPASSWD: /usr/bin/apt-get install -y nut
EOF
sudo chmod 440 /etc/sudoers.d/rusnas-nut && echo '✓ Sudoers настроены'"

echo "=== [5/5] Деплоим Cockpit plugin ==="
./deploy.sh

echo ""
echo "✅ UPS/NUT поддержка установлена!"
echo "   Откройте Cockpit → ИБП 🔋 для настройки"
echo ""
echo "   Если ИБП подключён по USB:"
echo "   Перейдите в Конфигурация → нажмите '🔍 Определить автоматически'"
