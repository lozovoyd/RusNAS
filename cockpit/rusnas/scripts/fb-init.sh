#!/bin/bash
# fb-init.sh — Инициализация FileBrowser: ждёт порт 8088, создаёт admin, синхронизирует пользователей
# Вызывается из install-filebrowser.sh после запуска сервиса

set -e

FB_BIN="/usr/local/bin/filebrowser"
FB_CFG="/etc/rusnas/filebrowser/settings.json"
ADMIN_PASS="${FB_ADMIN_PASS:-rusnas_admin_2026}"
TOKEN_FILE="/etc/rusnas/filebrowser/admin_token"

log() { echo "[fb-init] $*"; }

# Меняем дефолтный пароль admin через CLI (нужен остановленный сервис)
log "Настройка admin через CLI..."
systemctl stop rusnas-filebrowser 2>/dev/null || true
sleep 1

# Проверяем, есть ли admin уже с нашим паролем
$FB_BIN --config "$FB_CFG" users ls 2>/dev/null | grep -q "^1 " && {
    # Обновляем пароль admin
    $FB_BIN --config "$FB_CFG" users update admin --password="$ADMIN_PASS" 2>/dev/null || true
    log "Пароль admin обновлён"
} || log "Пользователь admin уже настроен"

# Синхронизируем Linux-пользователей (сервис остановлен — CLI работает)
log "Синхронизация Linux-пользователей..."
python3 /usr/share/cockpit/rusnas/scripts/fb-sync-all-users.py || log "Ошибка синхронизации (не критично)"

# Запускаем сервис
log "Запуск FileBrowser..."
systemctl start rusnas-filebrowser
sleep 2
systemctl is-active rusnas-filebrowser > /dev/null && log "FileBrowser запущен ✅" || log "ВНИМАНИЕ: сервис не запустился"

# Сохраняем токен для CGI скриптов (используется fb-users-list.py и др.)
log "Получение токена admin..."
FB_URL="http://127.0.0.1:8088"
for i in $(seq 1 15); do
    if curl -sf "$FB_URL/health" > /dev/null 2>&1; then break; fi
    sleep 1
done

TOKEN=$(curl -sf -X POST "$FB_URL/files/api/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASS\"}" 2>/dev/null || true)

if [ -n "$TOKEN" ]; then
    echo "$TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    log "Токен admin сохранён в $TOKEN_FILE"
else
    log "Не удалось получить токен — fb-users-list.py будет работать без него"
fi

log "Инициализация завершена"
