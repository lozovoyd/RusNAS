#!/bin/bash
# install-filebrowser.sh — Деплой FileBrowser на VM rusNAS
# Запускать локально: ./install-filebrowser.sh

set -e

VM="rusnas@10.10.10.72"
PASS="kl4389qd"
SCP_OPTS="-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SSH_CMD="sshpass -p $PASS ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no $VM"

log() { echo "==> $*"; }

log "=== FileBrowser Quantum Deployment ==="

# Скачиваем бинарник локально если нет
FB_BIN_LOCAL="/tmp/filebrowser-bin"
if [ ! -f "$FB_BIN_LOCAL" ]; then
    log "Скачиваем FileBrowser v2.31.2 на Mac..."
    curl -fsSL --max-time 120 \
        "https://github.com/filebrowser/filebrowser/releases/download/v2.31.2/linux-amd64-filebrowser.tar.gz" \
        -o /tmp/filebrowser-linux.tar.gz
    tar -xzf /tmp/filebrowser-linux.tar.gz -C /tmp/ filebrowser
    mv /tmp/filebrowser "$FB_BIN_LOCAL"
    log "Бинарник готов: $(ls -lh $FB_BIN_LOCAL | awk '{print $5, $9}')"
fi

# Копируем бинарник и скрипты на VM
log "Копируем файлы на VM..."
sshpass -p "$PASS" scp $SCP_OPTS \
    "$FB_BIN_LOCAL" \
    cockpit/rusnas/scripts/fb-init.sh \
    cockpit/rusnas/scripts/fb-sync-user.py \
    cockpit/rusnas/scripts/fb-sync-all-users.py \
    cockpit/rusnas/cgi/fb-users-list.py \
    cockpit/rusnas/cgi/fb-set-user-access.py \
    "$VM:/tmp/"

# Создаём remote install скрипт
log "Подготавливаем remote install скрипт..."
cat > /tmp/fb-remote-install.sh << 'SCRIPT'
#!/bin/bash
set -e
log() { echo "  [vm] $*"; }

FB_BIN="/usr/local/bin/filebrowser"
FB_CONFIG_DIR="/etc/rusnas/filebrowser"
FB_DATA_DIR="/var/lib/rusnas/filebrowser"
FB_LOG_DIR="/var/log/rusnas"
FB_ADMIN_PASS="rusnas_admin_2026"

# 1. Бинарник
log "Устанавливаем бинарник..."
cp /tmp/filebrowser-bin "$FB_BIN"
chmod 755 "$FB_BIN"
log "Версия: $($FB_BIN version 2>/dev/null | head -1 || echo OK)"

# 2. Системный пользователь
if ! id rusnas-fb &>/dev/null; then
    log "Создаём пользователя rusnas-fb..."
    useradd -r -s /usr/sbin/nologin -d "$FB_DATA_DIR" rusnas-fb
fi

# 3. Директории
log "Создаём директории..."
mkdir -p "$FB_CONFIG_DIR" "$FB_DATA_DIR" "$FB_LOG_DIR"
chown rusnas-fb:rusnas-fb "$FB_DATA_DIR"
chmod 755 "$FB_CONFIG_DIR" "$FB_DATA_DIR" "$FB_LOG_DIR"

# 4. settings.json
log "Записываем settings.json..."
cat > "$FB_CONFIG_DIR/settings.json" << 'SETTINGS'
{
  "port": 8088,
  "baseURL": "/files",
  "address": "127.0.0.1",
  "log": "stdout",
  "database": "/var/lib/rusnas/filebrowser/users.db",
  "root": "/",
  "noauth": false,
  "auth": {"method": "json", "header": ""},
  "defaults": {
    "scope": "/",
    "locale": "ru",
    "viewMode": "list",
    "sorting": {"by": "name", "asc": true},
    "perm": {
      "admin": false, "execute": false, "create": true,
      "rename": true, "modify": true, "delete": true,
      "share": false, "download": true
    }
  }
}
SETTINGS

# 5. access_rules.json
[ -f "$FB_CONFIG_DIR/access_rules.json" ] || echo '{}' > "$FB_CONFIG_DIR/access_rules.json"
chmod 644 "$FB_CONFIG_DIR/settings.json" "$FB_CONFIG_DIR/access_rules.json"

# 6. admin_token placeholder
touch "$FB_CONFIG_DIR/admin_token"
chmod 600 "$FB_CONFIG_DIR/admin_token"

# 7. systemd unit
log "Создаём systemd unit..."
cat > /etc/systemd/system/rusnas-filebrowser.service << 'UNIT'
[Unit]
Description=rusNAS FileBrowser
After=network.target

[Service]
Type=simple
User=rusnas-fb
Group=rusnas-fb
ExecStart=/usr/local/bin/filebrowser --config /etc/rusnas/filebrowser/settings.json
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

# 8. Скрипты
log "Устанавливаем скрипты..."
mkdir -p /usr/share/cockpit/rusnas/scripts /usr/share/cockpit/rusnas/cgi
cp /tmp/fb-init.sh /usr/share/cockpit/rusnas/scripts/
cp /tmp/fb-sync-user.py /tmp/fb-sync-all-users.py /usr/share/cockpit/rusnas/scripts/
cp /tmp/fb-users-list.py /tmp/fb-set-user-access.py /usr/share/cockpit/rusnas/cgi/
chmod 755 /usr/share/cockpit/rusnas/scripts/fb-init.sh
chmod 644 /usr/share/cockpit/rusnas/scripts/fb-sync-user.py \
          /usr/share/cockpit/rusnas/scripts/fb-sync-all-users.py \
          /usr/share/cockpit/rusnas/cgi/fb-users-list.py \
          /usr/share/cockpit/rusnas/cgi/fb-set-user-access.py

# 9. Запускаем сервис
log "Запускаем rusnas-filebrowser..."
systemctl daemon-reload
systemctl enable rusnas-filebrowser
systemctl restart rusnas-filebrowser
sleep 3
systemctl is-active rusnas-filebrowser && log "Сервис активен ✅" || log "ВНИМАНИЕ: сервис не активен"

# 10. nginx
log "Настраиваем nginx..."
if ! command -v nginx &>/dev/null; then
    log "Устанавливаем nginx..."
    apt-get install -y nginx -q
fi

# SSL cert
if [ ! -f /etc/ssl/rusnas/rusnas.crt ]; then
    log "Генерируем SSL сертификат..."
    mkdir -p /etc/ssl/rusnas
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout /etc/ssl/rusnas/rusnas.key \
        -out /etc/ssl/rusnas/rusnas.crt \
        -subj "/C=RU/O=rusNAS/CN=$(hostname)" 2>/dev/null
    chmod 600 /etc/ssl/rusnas/rusnas.key
    chmod 644 /etc/ssl/rusnas/rusnas.crt
fi

# nginx sites-available
mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
cat > /etc/nginx/sites-available/rusnas-filebrowser.conf << 'NGINX'
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name _;
    ssl_certificate     /etc/ssl/rusnas/rusnas.crt;
    ssl_certificate_key /etc/ssl/rusnas/rusnas.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location /files/ {
        proxy_pass         http://127.0.0.1:8088/files/;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_read_timeout 300s;
        client_max_body_size 0;
    }
    location = /files { return 301 /files/; }
}

server {
    listen 80;
    listen [::]:80;
    server_name _;
    root /var/www/rusnas-landing;
    try_files $uri $uri/ =404;
}
NGINX

ln -sf /etc/nginx/sites-available/rusnas-filebrowser.conf \
       /etc/nginx/sites-enabled/rusnas-filebrowser.conf 2>/dev/null || true
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

nginx -t 2>&1 && (systemctl reload nginx 2>/dev/null || systemctl start nginx)
log "nginx настроен"

# 11. Sudoers
log "Настраиваем sudoers..."
cat > /etc/sudoers.d/rusnas-filebrowser << 'SUDOERS'
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/cgi/fb-users-list.py
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/cgi/fb-set-user-access.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/fb-sync-user.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/fb-sync-all-users.py
rusnas ALL=(ALL) NOPASSWD: /usr/bin/systemctl start rusnas-filebrowser
rusnas ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop rusnas-filebrowser
rusnas ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-active rusnas-filebrowser
SUDOERS
chmod 440 /etc/sudoers.d/rusnas-filebrowser

# 12. Инициализация (admin + пользователи)
log "Инициализация FileBrowser..."
export FB_ADMIN_PASS="$FB_ADMIN_PASS"
bash /usr/share/cockpit/rusnas/scripts/fb-init.sh || log "Ошибка инициализации (не критично)"

log "=== Установка завершена ==="
SCRIPT

sshpass -p "$PASS" scp $SCP_OPTS /tmp/fb-remote-install.sh "$VM:/tmp/"

# Запускаем с sudo через -S (пароль через stdin)
log "Запускаем установку на VM..."
echo "$PASS" | sshpass -p "$PASS" ssh $SCP_OPTS "$VM" "sudo -S bash /tmp/fb-remote-install.sh"

log ""
log "=== Деплой завершён ==="
log "FileBrowser: https://10.10.10.72/files/"
log ""
log "Проверка:"
log "  sshpass -p '$PASS' ssh $SCP_OPTS $VM 'curl -sf http://127.0.0.1:8088/health && echo OK'"
