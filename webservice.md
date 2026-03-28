# rusNAS Web Services Architecture

> ⚠️ **ОБЯЗАТЕЛЬНО читать перед любой работой с веб-сервисами, установкой контейнеров, настройкой Apache/nginx, FileBrowser, WebDAV.**

## Принцип: nginx как единая точка входа

С версии Container Manager, nginx является **единственным публичным веб-сервером** rusNAS.

```
Интернет / локальная сеть
         │
    :80 / :443
         │
       nginx  ◄─── единая точка входа
         │
    ┌────┼──────────────────────────────────┐
    │    │                                  │
    ▼    ▼                                  ▼
  /    /files/      /webdav/       /office/ /nextcloud/ ...
  │      │              │               │
Landing  FileBrowser   Apache        Container apps
(static) :8080 (int)  :8091 (int)  :8090+ (int)
                       (WebDAV only)  (per-app)

         /cockpit/ ──► Cockpit :9090 (int)
```

## Сервисы и порты

| Сервис | Публичный путь | Внутренний порт | Назначение |
|--------|---------------|-----------------|------------|
| Landing page | `/` | — (static) | Маркетинговый сайт |
| Cockpit | `/cockpit/` | `:9090` | Web UI управления NAS |
| FileBrowser | `/files/` | `:8088` | Веб-файловый менеджер |
| Apache WebDAV | `/webdav/` | `:8091` | WebDAV сервер (только для WebDAV) |
| Container apps | `/<app_path>/` | `:8090–:8999` | Nextcloud, Immich, Jellyfin и т.д. |

> **Apache больше НЕ слушает :80** — только :8091 (WebDAV backend). Все внешние запросы идут через nginx.

## nginx конфигурация

**Основной конфиг:** `/etc/nginx/sites-enabled/rusnas.conf`

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name _;

    # Landing page (статика)
    root /var/www/rusnas-landing;
    index index.html;

    # Cockpit
    location /cockpit/ {
        proxy_pass http://127.0.0.1:9090/cockpit/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # FileBrowser (internal :8088)
    location /files/ {
        proxy_pass http://127.0.0.1:8088/files/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 4G;
    }

    # WebDAV (Apache backend, внутренний :8091)
    location /webdav/ {
        proxy_pass http://127.0.0.1:8091/webdav/;
        proxy_set_header Host $host;
        proxy_set_header Destination $http_destination;
        proxy_pass_header Authorization;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 4G;
    }

    # Container apps (авто-генерируются Container Manager)
    include /etc/nginx/conf.d/rusnas-apps/*.conf;

    # Fallback: отдаём landing как SPA
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## Директория конфигов контейнеров

`/etc/nginx/conf.d/rusnas-apps/` — автогенерируемые location-блоки.

**Каждый установленный контейнер** создаёт файл `<app_id>.conf` в этой директории:

```nginx
# rusNAS auto-generated — nextcloud
location /nextcloud/ {
    proxy_pass http://127.0.0.1:8090/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    client_max_body_size 4G;
}
```

При установке контейнера: файл создаётся → `systemctl reload nginx`.
При удалении контейнера: файл удаляется → `systemctl reload nginx`.

## Apache WebDAV — внутренний backend

Apache перенесён на **port :8091** и обслуживает ТОЛЬКО WebDAV.

**Apache конфиг:** `/etc/apache2/sites-enabled/webdav.conf`
```apache
Listen 127.0.0.1:8091
<VirtualHost 127.0.0.1:8091>
    ...
</VirtualHost>
```

Внешний доступ к WebDAV: `http://nas-ip/webdav/` (через nginx).

## FileBrowser

- Процесс: `rusnas-fb.service` (systemd)
- Слушает: `127.0.0.1:8080`
- Внешний путь: `/files/`
- База данных: `/var/lib/rusnas/filebrowser.db`
- Данные: `/mnt/data` (btrfs volume)

## Cockpit

- Слушает: `0.0.0.0:9090` (собственный TLS)
- Также доступен через nginx proxy на `/cockpit/`
- Плагин rusNAS: `/usr/share/cockpit/rusnas/`

## Диапазон портов контейнеров

| Диапазон | Назначение |
|----------|------------|
| `:8090–:8099` | Первые 10 приложений каталога |
| `:8100–:8999` | Дополнительные / кастомные контейнеры |
| `:8088` | Зарезервирован: FileBrowser |
| `:8091` | Зарезервирован: Apache WebDAV |
| `:9090` | Зарезервирован: Cockpit |

Перед установкой контейнера `container_api.py` проверяет доступность порта через `socket.bind()`.
Если порт занят — автоматически предлагается следующий свободный.

## Установка nginx как primary (миграция)

Для миграции с Apache-primary на nginx-primary используется скрипт:

```bash
sudo ./install-nginx-primary.sh
```

**Что делает скрипт:**
1. Устанавливает nginx (если не установлен)
2. Создаёт `/etc/nginx/sites-enabled/rusnas.conf`
3. Создаёт директорию `/etc/nginx/conf.d/rusnas-apps/`
4. Переводит Apache на :8091 (только WebDAV)
5. Обновляет sudoers — добавляет `nginx -t` и `systemctl reload nginx`
6. Перезапускает nginx и Apache

## sudoers для nginx

Файл `/etc/sudoers.d/rusnas-nginx`:
```
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx
```

## Правила для Container Manager

При добавлении новых приложений в каталог:

1. Каждое приложение должно иметь `nginx_path` в `rusnas-app.json` (напр. `"/nextcloud/"`)
2. `default_port` не должен конфликтовать с зарезервированными (8080, 8091, 9090)
3. После установки `installed.json` содержит:
   - `proxy_url` — публичный URL через nginx (`http://nas-ip/app_path/`)
   - `direct_url` — прямой URL (`http://nas-ip:port/`)
   - `proxy_active` — `true` (nginx proxy активен)

## Проверка конфигурации

```bash
# Тест конфига nginx
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx

# Статус сервисов
sudo systemctl status nginx apache2 rusnas-fb

# Проверка портов
ss -tlnp | grep -E '80|8080|8091|9090'

# Логи nginx
sudo journalctl -u nginx -f
```
