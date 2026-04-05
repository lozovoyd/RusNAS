# rusNAS — FileBrowser Quantum: Спецификация интеграции

> Статус: **к реализации**  
> Целевая платформа: Debian 13 Trixie, Cockpit-плагин rusnas  
> Файл для Claude Code — содержит полное ТЗ с командами, конфигами и паттернами

---

## 1. Обзор и архитектурные решения

### 1.1 Выбор продукта

**FileBrowser Quantum** — Go-бинарник (форк filebrowser с доп. функциями), единственный файл без зависимостей.

- Репозиторий: `https://github.com/gtsteffaniak/filebrowser`
- Установка: единый бинарник `/usr/local/bin/filebrowser`
- Конфигурация: `/etc/rusnas/filebrowser/settings.json`
- База пользователей: `/var/lib/rusnas/filebrowser/users.db` (bbolt/SQLite)
- Логи: `/var/log/rusnas/filebrowser.log`

### 1.2 Сетевая топология

```
Клиент (LAN)   ──────────┐
                          ├──▶  nginx :443  ──▶  /files/   ──▶  filebrowser :8088
Клиент (WAN)   ──────────┘                  (reverse proxy)
                                             /             ──▶  Cockpit :9090

filebrowser слушает только 127.0.0.1:8088 — никогда не напрямую в интернет.
```

**Важно:** FileBrowser **не встраивается через iframe** в Cockpit из-за CSP. Из Cockpit — только кнопки/ссылки, открывающие FileBrowser в новой вкладке с правильным путём.

### 1.3 URL-схема

| Назначение | URL |
|---|---|
| Корень FileBrowser | `https://<NAS_IP>/files/` |
| Конкретная папка | `https://<NAS_IP>/files/?path=/shares/docs` |
| Конкретная папка шары | `https://<NAS_IP>/files/?path=/shares/<share_name>` |
| Deep link из Storage Analyzer | `https://<NAS_IP>/files/?path=<abspath>&sort=size&order=desc` |

---

## 2. Установка и systemd-сервис

### 2.1 Установка бинарника

```bash
# Скачать последний релиз (amd64)
FB_VERSION=$(curl -s https://api.github.com/repos/gtsteffaniak/filebrowser/releases/latest | grep tag_name | cut -d'"' -f4)
curl -L "https://github.com/gtsteffaniak/filebrowser/releases/download/${FB_VERSION}/filebrowser-linux-amd64" \
     -o /usr/local/bin/filebrowser
chmod 755 /usr/local/bin/filebrowser

# Создать директории
mkdir -p /etc/rusnas/filebrowser
mkdir -p /var/lib/rusnas/filebrowser
```

### 2.2 Конфигурация `/etc/rusnas/filebrowser/settings.json`

```json
{
  "port": 8088,
  "address": "127.0.0.1",
  "baseURL": "/files",
  "database": "/var/lib/rusnas/filebrowser/users.db",
  "log": "/var/log/rusnas/filebrowser.log",
  "root": "/",
  "auth": {
    "method": "json",
    "header": ""
  },
  "defaults": {
    "scope": "/shares",
    "locale": "ru",
    "viewMode": "list",
    "singleClick": false,
    "sorting": {
      "by": "name",
      "asc": true
    },
    "commands": [],
    "hideDotfiles": true,
    "dateFormat": false
  },
  "server": {
    "enableThumbnails": true,
    "resizePreview": true,
    "enableExec": false,
    "typeDetectionByHeader": true
  }
}
```

**Ключевые параметры:**
- `root: "/"` — filebrowser видит всю ФС, но каждый пользователь имеет свой scope (см. раздел 4)
- `enableExec: false` — запрет выполнения команд (безопасность)
- `baseURL: "/files"` — совпадает с nginx location

### 2.3 Systemd unit `/etc/systemd/system/rusnas-filebrowser.service`

```ini
[Unit]
Description=rusNAS FileBrowser
After=network.target
Documentation=https://github.com/gtsteffaniak/filebrowser

[Service]
Type=simple
User=rusnas-fb
Group=rusnas-fb
ExecStart=/usr/local/bin/filebrowser --config /etc/rusnas/filebrowser/settings.json
Restart=on-failure
RestartSec=5s

# Безопасность
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=/var/lib/rusnas/filebrowser /var/log/rusnas /shares /mnt

StandardOutput=journal
StandardError=journal
SyslogIdentifier=rusnas-filebrowser

[Install]
WantedBy=multi-user.target
```

**Системный пользователь:**
```bash
useradd -r -s /usr/sbin/nologin -d /var/lib/rusnas/filebrowser rusnas-fb
# Добавить в группы шар (если нужны права чтения/записи)
# Права на папки шар определяются через ACL (см. раздел 4)
```

---

## 3. Nginx reverse proxy

### 3.1 Конфиг `/etc/nginx/sites-available/rusnas`

```nginx
server {
    listen 443 ssl http2;
    server_name _;

    ssl_certificate     /etc/ssl/rusnas/rusnas.crt;
    ssl_certificate_key /etc/ssl/rusnas/rusnas.key;

    # Cockpit — проксируем всё кроме /files/
    location / {
        proxy_pass https://127.0.0.1:9090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }

    # FileBrowser
    location /files/ {
        proxy_pass http://127.0.0.1:8088/files/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket для live preview
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Таймаут для больших файлов (upload/download)
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 0;  # без ограничений на upload
    }
}

# HTTP → HTTPS redirect
server {
    listen 80;
    return 301 https://$host$request_uri;
}
```

### 3.2 Самоподписанный сертификат (при первичной установке)

```bash
mkdir -p /etc/ssl/rusnas
openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
  -keyout /etc/ssl/rusnas/rusnas.key \
  -out /etc/ssl/rusnas/rusnas.crt \
  -subj "/CN=rusnas-device" \
  -addext "subjectAltName=IP:$(hostname -I | awk '{print $1}')"
```

---

## 4. Управление пользователями и доступом

### 4.1 Концепция

Каждый пользователь rusNAS имеет **зеркальный аккаунт** в FileBrowser:

| Параметр | Значение |
|---|---|
| Логин | совпадает с Linux-пользователем |
| Пароль | совпадает с паролем Samba (синхронизируется при изменении) |
| Scope | `/shares/<allowed_shares>` — только разрешённые шары |
| Права | read-only или read-write — берётся из prefs шары в smb.conf |
| Режим доступа | LAN-only или LAN+WAN (см. 4.3) |

### 4.2 Синхронизация пользователей

Скрипт `/usr/share/cockpit/rusnas/scripts/fb-sync-user.py`:

```python
#!/usr/bin/env python3
"""
Синхронизирует пользователей rusNAS → FileBrowser API.
Вызывается из Cockpit CGI при создании/изменении/удалении пользователя.
"""

import sys
import json
import subprocess
import requests

FB_API = "http://127.0.0.1:8088/api"
FB_ADMIN_TOKEN_FILE = "/etc/rusnas/filebrowser/admin_token"


def get_admin_token():
    """Получить JWT-токен admin-аккаунта FileBrowser."""
    with open(FB_ADMIN_TOKEN_FILE) as f:
        creds = json.load(f)
    resp = requests.post(f"{FB_API}/login", json=creds, timeout=5)
    resp.raise_for_status()
    return resp.text.strip().strip('"')


def get_user_scope(username):
    """
    Определить scope пользователя: список путей шар, к которым у него есть доступ.
    Парсим smb.conf — ищем шары, где username в valid users.
    """
    result = subprocess.run(
        ["bash", "-c", "testparm -s 2>/dev/null"],
        capture_output=True, text=True
    )
    shares = []
    current_share = None
    current_path = None
    valid_users = []

    for line in result.stdout.splitlines():
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            name = line[1:-1]
            if name not in ("global", "homes", "printers"):
                current_share = name
                current_path = None
                valid_users = []
        elif current_share:
            if line.startswith("path ="):
                current_path = line.split("=", 1)[1].strip()
            elif line.startswith("valid users ="):
                valid_users = [u.strip() for u in line.split("=", 1)[1].split(",")]
            elif line.startswith("["):
                # конец секции — проверяем доступ
                if current_path and (not valid_users or username in valid_users):
                    shares.append(current_path)

    if not shares:
        return "/shares"
    # Если 1 папка — scope = эта папка. Если несколько — общий родитель.
    return shares[0] if len(shares) == 1 else "/shares"


def sync_user(action, username, password=None, shares=None):
    """
    action: create | update | delete
    """
    token = get_admin_token()
    headers = {"X-Auth": token, "Content-Type": "application/json"}

    if action == "delete":
        # Найти id пользователя
        users = requests.get(f"{FB_API}/users", headers=headers).json()
        for u in users:
            if u["username"] == username:
                requests.delete(f"{FB_API}/users/{u['id']}", headers=headers)
                break
        return

    scope = get_user_scope(username)
    user_data = {
        "username": username,
        "password": password or "",
        "scope": scope,
        "locale": "ru",
        "viewMode": "list",
        "perm": {
            "admin": False,
            "execute": False,
            "create": True,
            "rename": True,
            "modify": True,
            "delete": True,
            "share": False,
            "download": True
        },
        "commands": [],
        "lockPassword": False,
        "hideDotfiles": True
    }

    if action == "create":
        requests.post(f"{FB_API}/users", headers=headers, json=user_data)
    elif action == "update":
        users = requests.get(f"{FB_API}/users", headers=headers).json()
        for u in users:
            if u["username"] == username:
                requests.put(f"{FB_API}/users/{u['id']}", headers=headers, json=user_data)
                break


if __name__ == "__main__":
    # Вызов: fb-sync-user.py create|update|delete <username> [password]
    action = sys.argv[1]
    username = sys.argv[2]
    password = sys.argv[3] if len(sys.argv) > 3 else None
    sync_user(action, username, password)
```

### 4.3 Контроль доступа: LAN-only vs WAN

Реализуется через nginx — не через FileBrowser (который не знает откуда клиент).

**Таблица пользователей доступа** хранится в `/etc/rusnas/filebrowser/access_rules.json`:

```json
{
  "users": {
    "alice": { "wan_allowed": false },
    "bob":   { "wan_allowed": true },
    "admin": { "wan_allowed": false }
  },
  "lan_networks": ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"]
}
```

Скрипт генерации nginx include `/usr/share/cockpit/rusnas/scripts/fb-generate-acl.py`:

```python
#!/usr/bin/env python3
"""
Генерирует nginx access control для FileBrowser.
Вызывается при изменении настроек доступа пользователя.
Перезагружает nginx.
"""

import json
import subprocess

RULES_FILE = "/etc/rusnas/filebrowser/access_rules.json"
NGINX_INCLUDE = "/etc/nginx/rusnas-fb-acl.conf"

def generate():
    with open(RULES_FILE) as f:
        rules = json.load(f)

    lan_networks = rules.get("lan_networks", ["192.168.0.0/16", "10.0.0.0/8"])
    users = rules.get("users", {})

    lines = ["# Auto-generated by rusNAS — do not edit manually\n"]

    # Определяем LAN через geo-модуль (если есть) или через map
    lines.append("# LAN detection via geo module")
    lines.append("geo $is_lan {")
    lines.append("    default 0;")
    for net in lan_networks:
        lines.append(f"    {net} 1;")
    lines.append("}\n")

    # Для каждого пользователя с wan_allowed=false генерируем
    # auth_basic restriction (ограничение на уровне location невозможно без lu-map)
    # Практичный подход: отдельный location /files/api/login с проверкой IP
    # и запретом логина WAN-пользователей через lua или sub-request.
    # Простая реализация: deny_users_from_wan — список в отдельном файле,
    # который читает middleware (Python CGI).

    lan_only_users = [u for u, cfg in users.items() if not cfg.get("wan_allowed", True)]

    lines.append("# Users restricted to LAN only")
    lines.append(f"# LAN-only users: {', '.join(lan_only_users) if lan_only_users else 'none'}")

    with open(NGINX_INCLUDE, "w") as f:
        f.write("\n".join(lines))

    subprocess.run(["nginx", "-s", "reload"], check=True)

generate()
```

**Middleware для проверки WAN-доступа** `/usr/share/cockpit/rusnas/cgi/fb-login-guard.py`:

FileBrowser при логине вызывает `/api/login` (POST). Nginx перехватывает этот запрос и проксирует через CGI-guard, который проверяет: если пользователь WAN-only restricted и IP внешний — возвращает 403.

```nginx
# В блоке location /files/:
location /files/api/login {
    # Сначала пропускаем через guard
    auth_request /rusnas-fb-login-check;
    proxy_pass http://127.0.0.1:8088/files/api/login;
}

location = /rusnas-fb-login-check {
    internal;
    proxy_pass http://127.0.0.1:9100/cgi-bin/fb-login-guard.py;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Original-Body $request_body;
    proxy_pass_request_body on;
}
```

---

## 5. Интеграция с Cockpit — точки входа

### 5.1 Кнопка в разделе Шары (Storage)

В таблице шар добавить колонку с кнопкой «Открыть файлы»:

**В `app.js` — функция `renderShareRow(share)`:**

```javascript
function getFileBrowserUrl(sharePath, options) {
    // options: { sort: 'size', order: 'desc' } — опционально
    var base = window.location.protocol + '//' + window.location.hostname + '/files/';
    var params = new URLSearchParams();
    params.set('path', sharePath);
    if (options && options.sort) params.set('sort', options.sort);
    if (options && options.order) params.set('order', options.order);
    return base + '?' + params.toString();
}

// В строке таблицы шары:
function renderShareRow(share) {
    var fbUrl = getFileBrowserUrl(share.path);
    return `
        <tr>
            <td>${share.name}</td>
            <td>${share.path}</td>
            <td>
                <button class="btn btn-sm btn-default"
                        onclick="window.open('${fbUrl}', '_blank')">
                    📂 Файлы
                </button>
                <button class="btn btn-sm btn-default" onclick="editShare('${share.name}')">Настроить</button>
                <button class="btn btn-sm btn-danger"  onclick="deleteShare('${share.name}')">Удалить</button>
            </td>
        </tr>
    `;
}
```

### 5.2 Кнопки из Storage Analyzer

В Storage Analyzer (`storage-analyzer.js`) в следующих местах:

**Блок "Топ пожирателей" (вкладка Обзор):**
```javascript
function renderTopConsumer(item) {
    var fbUrl = getFileBrowserUrl(item.path, { sort: 'size', order: 'desc' });
    return `
        <div class="consumer-item">
            <span class="consumer-icon">${item.icon}</span>
            <span class="consumer-path">${item.path}</span>
            <span class="consumer-size">${formatBytes(item.size)}</span>
            <a href="${fbUrl}" target="_blank" class="btn btn-sm btn-primary">
                Открыть в FileBrowser
            </a>
        </div>
    `;
}
```

**Treemap (вкладка Папки) — hover-кнопка:**
```javascript
// При hover на прямоугольник treemap
function onTreemapHover(node) {
    var fbUrl = getFileBrowserUrl(node.path);
    showTooltip(node, `
        <strong>${node.name}</strong><br>
        ${formatBytes(node.size)}<br>
        <a href="${fbUrl}" target="_blank" class="fb-link">📂 Открыть</a>
    `);
}
```

**Таблица крупных файлов:**
```javascript
function renderFileRow(file) {
    var dirPath = file.path.substring(0, file.path.lastIndexOf('/'));
    var fbUrl = getFileBrowserUrl(dirPath);
    return `<tr>
        <td>${file.name}</td>
        <td>${formatBytes(file.size)}</td>
        <td>${file.path}</td>
        <td>${file.mtime}</td>
        <td><a href="${fbUrl}" target="_blank" class="btn btn-xs btn-default">Открыть папку</a></td>
    </tr>`;
}
```

**Таблица шар (вкладка Шары) — кнопка в раскрывающемся блоке:**
```javascript
function renderShareExpanded(share) {
    var fbUrl = getFileBrowserUrl(share.path);
    return `
        <div class="share-expanded">
            <!-- ... sparkline, прогноз ... -->
            <div class="share-actions">
                <a href="${fbUrl}" target="_blank" class="btn btn-primary">
                    📂 Открыть в FileBrowser
                </a>
                <button onclick="openQuotaModal('${share.name}')">Настроить квоту</button>
            </div>
        </div>
    `;
}
```

### 5.3 Guard — открытие карантинных файлов

В Guard при обнаружении атаки создаются снапшоты. В UI Guard добавить ссылку на FileBrowser для просмотра поражённой директории:

```javascript
// В блоке отображения event'а атаки:
function renderAttackEvent(event) {
    var fbUrl = getFileBrowserUrl(event.path);
    return `
        <div class="alert alert-danger">
            ⚠️ Атака обнаружена в ${event.path}<br>
            <small>${event.timestamp}</small><br>
            <a href="${fbUrl}" target="_blank" class="btn btn-sm btn-default" style="margin-top:8px">
                📂 Просмотреть файлы
            </a>
        </div>
    `;
}
```

---

## 6. Управление FileBrowser из Cockpit — страница настроек

### 6.1 Новая вкладка/секция в Cockpit: "Файловый менеджер"

Добавить в `manifest.json` пункт меню или секцию на странице Storage.

**UI-блок (добавляется в `index.html` как новая секция):**

```html
<div class="section" id="filebrowser-section">
    <div class="section-toolbar">
        <h2>📂 Файловый менеджер</h2>
        <div style="display:flex;gap:8px;align-items:center;">
            <span id="fb-status-badge" class="badge badge-success">Работает</span>
            <a id="fb-open-link" href="/files/" target="_blank" class="btn btn-primary">
                Открыть FileBrowser
            </a>
        </div>
    </div>

    <!-- Таблица пользователей FileBrowser -->
    <div class="card" style="margin-top:12px">
        <div class="card-header">Доступ пользователей</div>
        <table class="table">
            <thead>
                <tr>
                    <th>Пользователь</th>
                    <th>Scope (папки)</th>
                    <th>Доступ из интернета</th>
                    <th>Действия</th>
                </tr>
            </thead>
            <tbody id="fb-users-table">
                <tr><td colspan="4" class="text-muted">Загрузка...</td></tr>
            </tbody>
        </table>
    </div>
</div>
```

### 6.2 Логика загрузки пользователей `loadFileBrowserUsers()`

```javascript
function loadFileBrowserUsers() {
    cockpit.spawn(["bash", "-c",
        "python3 /usr/share/cockpit/rusnas/cgi/fb-users-list.py"
    ], {superuser: "require"})
    .done(function(out) {
        var data = JSON.parse(out);
        renderFbUsersTable(data.users);
    })
    .fail(function(err) {
        document.getElementById("fb-users-table").innerHTML =
            `<tr><td colspan="4" class="text-danger">Ошибка: ${err}</td></tr>`;
    });
}

function renderFbUsersTable(users) {
    var html = users.map(function(u) {
        var wanBadge = u.wan_allowed
            ? '<span class="badge badge-warning">LAN + WAN</span>'
            : '<span class="badge badge-success">Только LAN</span>';
        return `<tr>
            <td>${u.username}</td>
            <td><code style="font-size:11px">${u.scope}</code></td>
            <td>${wanBadge}</td>
            <td>
                <button class="btn btn-xs btn-default"
                        onclick="openFbUserModal('${u.username}', ${u.wan_allowed})">
                    Настроить
                </button>
            </td>
        </tr>`;
    }).join("");
    document.getElementById("fb-users-table").innerHTML = html || '<tr><td colspan="4">Нет пользователей</td></tr>';
}
```

### 6.3 Модал настройки доступа пользователя

```html
<!-- Modal: FileBrowser User Settings -->
<div class="modal-overlay hidden" id="fb-user-modal">
    <div class="modal-box">
        <h3>Настройка доступа в FileBrowser</h3>
        <p>Пользователь: <strong id="fb-modal-username"></strong></p>

        <div class="form-group">
            <label>Scope (доступные папки)</label>
            <input type="text" id="fb-modal-scope" placeholder="/shares">
            <small class="text-muted">Пользователь увидит только файлы внутри этого пути</small>
        </div>

        <div class="form-group">
            <label>Доступ из интернета</label>
            <div class="radio-group">
                <label class="radio-label">
                    <input type="radio" name="fb-wan" value="0" checked>
                    🔒 Только из локальной сети (LAN)
                    <small class="text-muted">— рекомендуется для большинства пользователей</small>
                </label>
                <label class="radio-label" style="margin-top:8px">
                    <input type="radio" name="fb-wan" value="1">
                    🌐 LAN + интернет
                    <small class="text-muted">— требует надёжного пароля и SSL-сертификата</small>
                </label>
            </div>
        </div>

        <div class="form-group">
            <label>Права на файлы</label>
            <select id="fb-modal-perm">
                <option value="rw">Чтение и запись</option>
                <option value="ro">Только чтение</option>
            </select>
        </div>

        <div class="modal-footer">
            <button class="btn btn-primary" id="btn-fb-user-save">Сохранить</button>
            <button class="btn btn-default" id="btn-fb-user-cancel">Отмена</button>
        </div>
    </div>
</div>
```

---

## 7. CGI-скрипты бэкенда

### 7.1 `/usr/share/cockpit/rusnas/cgi/fb-users-list.py`

```python
#!/usr/bin/env python3
"""Список пользователей FileBrowser + их настройки WAN-доступа."""

import json
import requests

FB_API = "http://127.0.0.1:8088/api"
RULES_FILE = "/etc/rusnas/filebrowser/access_rules.json"
FB_ADMIN_TOKEN_FILE = "/etc/rusnas/filebrowser/admin_token"


def get_token():
    with open(FB_ADMIN_TOKEN_FILE) as f:
        creds = json.load(f)
    r = requests.post(f"{FB_API}/login", json=creds, timeout=5)
    return r.text.strip().strip('"')


def main():
    try:
        with open(RULES_FILE) as f:
            rules = json.load(f)
    except FileNotFoundError:
        rules = {"users": {}}

    token = get_token()
    headers = {"X-Auth": token}
    fb_users = requests.get(f"{FB_API}/users", headers=headers, timeout=5).json()

    result = []
    for u in fb_users:
        if u["username"] == "admin":
            continue
        user_rules = rules.get("users", {}).get(u["username"], {})
        result.append({
            "username": u["username"],
            "scope": u.get("scope", "/shares"),
            "wan_allowed": user_rules.get("wan_allowed", False),
            "perm_modify": u.get("perm", {}).get("modify", True)
        })

    print(json.dumps({"users": result}))


main()
```

### 7.2 `/usr/share/cockpit/rusnas/cgi/fb-set-user-access.py`

```python
#!/usr/bin/env python3
"""Обновить настройки доступа пользователя в FileBrowser."""

import sys
import json
import requests
import subprocess

FB_API = "http://127.0.0.1:8088/api"
RULES_FILE = "/etc/rusnas/filebrowser/access_rules.json"
FB_ADMIN_TOKEN_FILE = "/etc/rusnas/filebrowser/admin_token"


def main():
    params = json.loads(sys.stdin.read())
    username = params["username"]
    wan_allowed = params.get("wan_allowed", False)
    scope = params.get("scope", "/shares")
    perm_modify = params.get("perm_modify", True)

    # 1. Обновить FileBrowser user через API
    with open(FB_ADMIN_TOKEN_FILE) as f:
        creds = json.load(f)
    r = requests.post(f"{FB_API}/login", json=creds, timeout=5)
    token = r.text.strip().strip('"')
    headers = {"X-Auth": token, "Content-Type": "application/json"}

    users = requests.get(f"{FB_API}/users", headers=headers).json()
    for u in users:
        if u["username"] == username:
            u["scope"] = scope
            u["perm"]["modify"] = perm_modify
            u["perm"]["create"] = perm_modify
            u["perm"]["delete"] = perm_modify
            u["perm"]["rename"] = perm_modify
            requests.put(f"{FB_API}/users/{u['id']}", headers=headers, json=u)
            break

    # 2. Обновить rules.json
    try:
        with open(RULES_FILE) as f:
            rules = json.load(f)
    except FileNotFoundError:
        rules = {"users": {}, "lan_networks": ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"]}

    rules.setdefault("users", {})[username] = {"wan_allowed": wan_allowed}
    with open(RULES_FILE, "w") as f:
        json.dump(rules, f, indent=2)

    # 3. Перегенерировать nginx ACL и перезагрузить nginx
    subprocess.run(
        ["python3", "/usr/share/cockpit/rusnas/scripts/fb-generate-acl.py"],
        check=True
    )

    print(json.dumps({"ok": True}))


main()
```

---

## 8. Интеграция с системой снапшотов

### 8.1 Browsing снапшотов через FileBrowser

Btrfs снапшоты лежат в `<volume>/.snapshots/<subvol>/<timestamp>/snapshot/`.

FileBrowser по умолчанию скрывает dotfiles (`hideDotfiles: true`). Для доступа к снапшотам нужен специальный URL:

```javascript
// Из UI снапшотов — кнопка "Просмотреть содержимое снапшота"
function openSnapshotInFileBrowser(snapshotPath) {
    // snapshotPath = /mnt/data/volume1/.snapshots/shares/2026-03-15T10:00:00/snapshot
    var url = getFileBrowserUrl(snapshotPath);
    // Добавляем параметр для отображения dotfiles
    url += '&showDotfiles=true';
    window.open(url, '_blank');
}
```

**Примечание:** Права файловой системы — снапшоты Btrfs read-only, FileBrowser отобразит их в режиме read-only автоматически.

### 8.2 Restore файла через FileBrowser + CLI

Если пользователь нашёл нужный файл в снапшоте через FileBrowser, он может скачать его напрямую (download в FileBrowser) — это работает без дополнительной интеграции.

Для полноценного in-place restore (не скачивая) — добавить кнопку в UI снапшотов (не в FileBrowser).

---

## 9. Первоначальная инициализация

Скрипт `/usr/share/cockpit/rusnas/scripts/fb-init.sh`:

```bash
#!/bin/bash
# Инициализация FileBrowser при первом запуске rusNAS.
# Запускается из Ansible роли один раз.
set -e

FB_DB="/var/lib/rusnas/filebrowser/users.db"
FB_TOKEN_FILE="/etc/rusnas/filebrowser/admin_token"
FB_API="http://127.0.0.1:8088"

# Ждём запуска сервиса
for i in $(seq 1 10); do
    curl -sf "$FB_API/health" > /dev/null 2>&1 && break
    sleep 2
done

# Сгенерировать случайный пароль admin
ADMIN_PASS=$(openssl rand -base64 24 | tr -d '=+/' | head -c 20)

# Инициализировать БД
/usr/local/bin/filebrowser \
    --config /etc/rusnas/filebrowser/settings.json \
    users add admin "$ADMIN_PASS" --perm.admin

# Сохранить credentials admin для API-вызовов
cat > "$FB_TOKEN_FILE" << EOF
{"username": "admin", "password": "$ADMIN_PASS"}
EOF
chmod 600 "$FB_TOKEN_FILE"

# Синхронизировать существующих пользователей Linux/Samba → FileBrowser
python3 /usr/share/cockpit/rusnas/scripts/fb-sync-all-users.py

echo "FileBrowser инициализирован. Admin пароль сохранён в $FB_TOKEN_FILE"
```

---

## 10. Ansible роль

Создать роль `roles/filebrowser/`:

```yaml
# tasks/main.yml
---
- name: Download FileBrowser Quantum binary
  get_url:
    url: "{{ filebrowser_download_url }}"
    dest: /usr/local/bin/filebrowser
    mode: '0755'
  vars:
    filebrowser_download_url: "https://github.com/gtsteffaniak/filebrowser/releases/download/{{ filebrowser_version }}/filebrowser-linux-amd64"

- name: Create system user rusnas-fb
  user:
    name: rusnas-fb
    system: yes
    shell: /usr/sbin/nologin
    home: /var/lib/rusnas/filebrowser

- name: Create directories
  file:
    path: "{{ item }}"
    state: directory
    owner: rusnas-fb
    group: rusnas-fb
    mode: '0750'
  loop:
    - /etc/rusnas/filebrowser
    - /var/lib/rusnas/filebrowser
    - /var/log/rusnas

- name: Deploy FileBrowser config
  template:
    src: settings.json.j2
    dest: /etc/rusnas/filebrowser/settings.json
    owner: rusnas-fb
    mode: '0640'

- name: Deploy access rules template
  copy:
    content: '{"users": {}, "lan_networks": ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"]}'
    dest: /etc/rusnas/filebrowser/access_rules.json
    owner: rusnas-fb
    mode: '0640'
  when: not (access_rules_file.stat.exists | default(false))

- name: Install systemd service
  copy:
    src: rusnas-filebrowser.service
    dest: /etc/systemd/system/rusnas-filebrowser.service

- name: Enable and start FileBrowser
  systemd:
    name: rusnas-filebrowser
    enabled: yes
    state: started
    daemon_reload: yes

- name: Wait for FileBrowser to start
  wait_for:
    port: 8088
    host: 127.0.0.1
    timeout: 30

- name: Initialize FileBrowser
  command: /usr/share/cockpit/rusnas/scripts/fb-init.sh
  args:
    creates: /etc/rusnas/filebrowser/admin_token

- name: Deploy nginx config
  template:
    src: rusnas-nginx.conf.j2
    dest: /etc/nginx/sites-available/rusnas
  notify: reload nginx

- name: Enable nginx site
  file:
    src: /etc/nginx/sites-available/rusnas
    dest: /etc/nginx/sites-enabled/rusnas
    state: link
  notify: reload nginx

- name: Deploy CGI scripts
  copy:
    src: "{{ item }}"
    dest: /usr/share/cockpit/rusnas/cgi/
    mode: '0755'
  loop:
    - fb-users-list.py
    - fb-set-user-access.py
    - fb-login-guard.py

- name: Deploy sync scripts
  copy:
    src: "{{ item }}"
    dest: /usr/share/cockpit/rusnas/scripts/
    mode: '0755'
  loop:
    - fb-sync-user.py
    - fb-sync-all-users.py
    - fb-generate-acl.py
    - fb-init.sh

handlers:
  - name: reload nginx
    systemd:
      name: nginx
      state: reloaded
```

---

## 11. Глубокая интеграция — дополнительные возможности

### 11.1 FileBrowser как точка загрузки резервных копий (Upload Zone)

Создать специальную шару `/shares/uploads` с правами только-запись для внешних пользователей. FileBrowser настроить с scope на эту папку, отображая UI только загрузки (без листинга). Полезно для сценария: клиент/партнёр загружает файлы на NAS без доступа к остальным данным.

Scope такого пользователя: `/shares/uploads`  
Права: `create: true`, `download: false`, `delete: false` — загрузка без просмотра.

### 11.2 Публичные ссылки на файлы (Share Links)

FileBrowser поддерживает создание временных публичных ссылок (`/api/shares`). Интегрировать в Cockpit:
- В таблице шар — кнопка "Получить ссылку для скачивания"
- Ссылка вида `https://<NAS_IP>/files/share/<token>`
- Параметры: срок действия (1ч / 24ч / 7д / бессрочно), пароль на ссылку

### 11.3 Webhook при загрузке файла

FileBrowser Quantum поддерживает хуки на события (upload, delete, rename). Добавить webhook → rusNAS-скрипт, который:
- Логирует событие в `/var/log/rusnas/filebrowser-events.log`
- Если файл загружен в `/shares/backup/incoming/` → автоматически запускает `rusnas-snap` (снапшот после импорта)
- Отправляет уведомление в Telegram при загрузке файла >1GB

Конфигурация в `settings.json`:
```json
"hooks": {
    "after.upload": "/usr/share/cockpit/rusnas/scripts/fb-hook-upload.sh",
    "before.delete": "/usr/share/cockpit/rusnas/scripts/fb-hook-delete.sh"
}
```

### 11.4 Интеграция с rusNAS Guard

Guard отслеживает файловую активность. При обнаружении атаки Guard может:
1. Выставить scope всех non-admin FileBrowser пользователей в `/dev/null` (заблокировать доступ через FileBrowser немедленно)
2. Переключить всех пользователей в read-only mode

Добавить в `guard.py` команду `restrict_filebrowser()`:

```python
def restrict_filebrowser():
    """Переключить всех FB-пользователей в read-only при обнаружении атаки."""
    # Вызвать fb-sync-user.py update <user> с perm.modify=false для всех
    import subprocess
    token = get_fb_token()
    headers = {"X-Auth": token}
    users = requests.get(f"{FB_API}/users", headers=headers).json()
    for u in users:
        if not u.get("perm", {}).get("admin"):
            u["perm"]["modify"] = False
            u["perm"]["create"] = False
            u["perm"]["delete"] = False
            u["perm"]["rename"] = False
            requests.put(f"{FB_API}/users/{u['id']}", headers=headers, json=u)
```

### 11.5 Prometheus метрики FileBrowser

Добавить в `/var/lib/node_exporter/textfile_collector/filebrowser.prom`:

```bash
# /usr/share/cockpit/rusnas/scripts/collect-fb-metrics.sh
#!/bin/bash
# Собирает метрики FileBrowser для Prometheus

FB_LOG="/var/log/rusnas/filebrowser.log"
PROM_FILE="/var/lib/node_exporter/textfile_collector/filebrowser.prom"

# Количество активных сессий (approximation via log)
ACTIVE=$(journalctl -u rusnas-filebrowser --since "5 minutes ago" | grep "GET\|POST" | wc -l)

# Размер БД пользователей
DB_SIZE=$(stat -c %s /var/lib/rusnas/filebrowser/users.db 2>/dev/null || echo 0)

cat > "$PROM_FILE" << EOF
# HELP rusnas_filebrowser_requests_5m HTTP requests in last 5 minutes
# TYPE rusnas_filebrowser_requests_5m gauge
rusnas_filebrowser_requests_5m $ACTIVE

# HELP rusnas_filebrowser_db_bytes Size of users database
# TYPE rusnas_filebrowser_db_bytes gauge
rusnas_filebrowser_db_bytes $DB_SIZE

# HELP rusnas_filebrowser_up FileBrowser service status
# TYPE rusnas_filebrowser_up gauge
rusnas_filebrowser_up $(systemctl is-active rusnas-filebrowser | grep -c active)
EOF
```

### 11.6 Quota enforcement через FileBrowser

При превышении Btrfs qgroup квоты пользователем — автоматически переключать его FileBrowser-аккаунт в read-only. Интегрировать в скрипт-коллектор Storage Analyzer:

```python
# В storage-collector.py — после проверки квот
def check_and_enforce_quotas():
    for user, usage in get_user_quotas().items():
        if usage['percent'] >= 100:
            # Переключить в read-only
            subprocess.run([
                "python3", "/usr/share/cockpit/rusnas/cgi/fb-set-user-access.py"
            ], input=json.dumps({
                "username": user,
                "perm_modify": False,
                "scope": get_user_scope(user),
                "wan_allowed": get_user_wan(user)
            }).encode())
```

---

## 12. Статусный блок в Dashboard

Добавить в `rusnas-dashboard-spec.md` / дашборд секцию:

```
┌─────────────────────────────────────────────────────────┐
│  📂 ФАЙЛОВЫЙ МЕНЕДЖЕР                    ● Работает     │
│                                                         │
│  Активных сессий: 3                                     │
│  Пользователей с WAN-доступом: 1                        │
│                                                         │
│  [Открыть FileBrowser ↗]  [Настройки доступа]          │
└─────────────────────────────────────────────────────────┘
```

Prometheus-метрика: `rusnas_filebrowser_up{version="..."}` + `rusnas_filebrowser_requests_5m`.

---

## 13. Порядок реализации (фазы)

### Фаза 1 — Базовая установка (приоритет: высокий)
- [ ] Установка бинарника FileBrowser Quantum
- [ ] Systemd unit `rusnas-filebrowser.service`
- [ ] Nginx reverse proxy `/files/`
- [ ] Самоподписанный SSL если нет сертификата
- [ ] Скрипт инициализации `fb-init.sh`
- [ ] Синхронизация пользователей из rusNAS → FileBrowser при создании/изменении

### Фаза 2 — Интеграция с Cockpit UI
- [ ] Кнопка "📂 Файлы" в таблице шар (Storage)
- [ ] Кнопки "Открыть в FileBrowser" в Storage Analyzer (все 4 точки входа)
- [ ] Секция "Файловый менеджер" в Cockpit с таблицей пользователей
- [ ] Модал настройки LAN/WAN доступа пользователя
- [ ] Виджет в Dashboard

### Фаза 3 — Продвинутая интеграция
- [ ] Блокировка FileBrowser при срабатывании Guard (restrict_filebrowser)
- [ ] Просмотр снапшотов через FileBrowser (deep link из UI снапшотов)
- [ ] Webhooks при загрузке → автоснапшот
- [ ] Quota enforcement → read-only в FileBrowser
- [ ] Prometheus метрики

### Фаза 4 — Публичный доступ и sharing
- [ ] Публичные ссылки из Cockpit UI
- [ ] Upload-only зона (`/shares/uploads`)
- [ ] Уведомления при загрузке крупных файлов

---

## 14. AD-интеграция (реализуется в v0.4)

> **Статус:** заложена архитектурно сейчас, реализуется когда rusNAS получит AD-поддержку (winbind/sssd).

### 14.1 Почему нативная AD-авторизация в FileBrowser невозможна

FileBrowser использует собственную базу пользователей (bbolt/SQLite). Он **не поддерживает LDAP/AD/Kerberos natively** — ни в оригинале, ни в Quantum-форке. Обходить это нужно на уровне nginx.

### 14.2 Целевая архитектура: Proxy Auth через nginx + PAM

При включённом AD (winbind или sssd) — nginx аутентифицирует пользователя через PAM, и передаёт FileBrowser уже проверенный логин через заголовок. FileBrowser работает в режиме `proxy` auth — полностью доверяет заголовку, свой экран логина не показывает.

```
Браузер
   │  Basic Auth (доменный логин/пароль)
   ▼
nginx — ngx_http_auth_pam_module
   │  PAM → winbind/sssd → AD LDAP
   │  [аутентификация прошла]
   │  X-Auth-User: DOMAIN\alice → alice
   ▼
FileBrowser (proxy auth mode)
   │  доверяет заголовку X-Auth-User
   │  scope берётся из FileBrowser user record
   ▼
Файловая система
```

Альтернатива для SSO (браузер с Kerberos ticket): nginx + `mod_auth_gssapi` или `ngx_http_spnego_auth_module`. Для SMB-клиентов rusNAS это необязательно — достаточно Basic Auth через nginx.

### 14.3 Конфигурация nginx в AD-режиме

Файл `/etc/nginx/sites-available/rusnas` — блок `/files/` заменяется:

```nginx
# AD-режим: PAM-аутентификация через nginx
location /files/ {
    # Аутентификация через PAM (winbind/sssd должен быть настроен)
    auth_pam "rusNAS Files";
    auth_pam_service_name "rusnas-nginx";

    # Нормализовать логин: убрать домен DOMAIN\user → user
    set $clean_user $remote_user;
    # (нормализация через lua или map — см. ниже)

    proxy_pass http://127.0.0.1:8088/files/;
    proxy_set_header X-Auth-User $clean_user;
    proxy_set_header Host $host;
    proxy_read_timeout 300s;
    client_max_body_size 0;

    # Убрать заголовок Authorization — FileBrowser его не должен видеть
    proxy_set_header Authorization "";
}
```

**PAM-сервис** `/etc/pam.d/rusnas-nginx`:
```
auth    required    pam_winbind.so   # или pam_sss.so для sssd
account required    pam_winbind.so
```

**Нормализация DOMAIN\user → user** через nginx `map`:
```nginx
map $remote_user $clean_user {
    ~^[^\\]+\\(?<user>.+)$  $user;   # DOMAIN\alice → alice
    ~^(?<user>[^@]+)@.+$    $user;   # alice@domain → alice
    default                  $remote_user;
}
```

### 14.4 Настройка FileBrowser в proxy-режиме

При переключении в AD-режим меняется `settings.json`:

```json
{
  "auth": {
    "method": "proxy",
    "header": "X-Auth-User"
  }
}
```

**Важно:** в proxy-режиме FileBrowser создаёт пользователя автоматически при первом входе, если его нет в БД — с дефолтным scope (`/shares`). Scope нужно корректировать отдельным скриптом после первого входа.

### 14.5 Скрипт синхронизации AD-групп → scope FileBrowser

`/usr/share/cockpit/rusnas/scripts/fb-sync-ad-users.py`:

```python
#!/usr/bin/env python3
"""
Синхронизирует AD-пользователей и их группы → scope в FileBrowser.
Запускается по cron каждые 5 минут или при изменении состава AD-групп.

Логика:
- Группа "rusnas-admins" (или "NASAdmins") → scope = "/", perm.admin = true
- Группа "rusnas-readonly" → scope = "/shares", perm.modify = false
- Остальные доменные пользователи → scope = "/shares", perm по умолчанию
- Пользователи с явным scope в access_rules.json → их scope имеет приоритет
"""

import json
import subprocess
import requests

FB_API = "http://127.0.0.1:8088/api"
FB_ADMIN_TOKEN_FILE = "/etc/rusnas/filebrowser/admin_token"
RULES_FILE = "/etc/rusnas/filebrowser/access_rules.json"

AD_ADMIN_GROUP = "rusnas-admins"     # настраивается через Cockpit UI
AD_READONLY_GROUP = "rusnas-readonly"


def get_token():
    with open(FB_ADMIN_TOKEN_FILE) as f:
        creds = json.load(f)
    r = requests.post(f"{FB_API}/login", json=creds, timeout=5)
    return r.text.strip().strip('"')


def get_ad_group_members(group):
    """Получить список членов AD-группы через wbinfo."""
    try:
        r = subprocess.run(
            ["wbinfo", "--group-info", group],
            capture_output=True, text=True, timeout=10
        )
        # Парсим: Members: alice,bob,carol
        for line in r.stdout.splitlines():
            if line.startswith("Members:"):
                return [m.strip().split("\\")[-1]  # убрать DOMAIN\
                        for m in line.split(":", 1)[1].split(",")
                        if m.strip()]
    except Exception:
        pass
    return []


def sync():
    token = get_token()
    headers = {"X-Auth": token, "Content-Type": "application/json"}

    # Загрузить существующих FB-пользователей
    fb_users = {u["username"]: u
                for u in requests.get(f"{FB_API}/users", headers=headers).json()
                if u["username"] != "admin"}

    # Загрузить явные правила (приоритет над AD-группами)
    try:
        with open(RULES_FILE) as f:
            rules = json.load(f)
    except FileNotFoundError:
        rules = {"users": {}}

    admin_members = set(get_ad_group_members(AD_ADMIN_GROUP))
    readonly_members = set(get_ad_group_members(AD_READONLY_GROUP))

    for username, fb_user in fb_users.items():
        user_rules = rules.get("users", {}).get(username, {})

        # Определить права по группе
        if username in admin_members:
            scope = user_rules.get("scope", "/")
            perm_modify = True
            perm_admin = True
        elif username in readonly_members:
            scope = user_rules.get("scope", "/shares")
            perm_modify = False
            perm_admin = False
        else:
            scope = user_rules.get("scope", "/shares")
            perm_modify = user_rules.get("perm_modify", True)
            perm_admin = False

        updated = dict(fb_user)
        updated["scope"] = scope
        updated["perm"]["admin"] = perm_admin
        updated["perm"]["modify"] = perm_modify
        updated["perm"]["create"] = perm_modify
        updated["perm"]["delete"] = perm_modify
        updated["perm"]["rename"] = perm_modify

        requests.put(f"{FB_API}/users/{fb_user['id']}",
                     headers=headers, json=updated)


sync()
```

**Cron** (добавляется Ansible-ролью при включении AD):
```
*/5 * * * * root /usr/share/cockpit/rusnas/scripts/fb-sync-ad-users.py >> /var/log/rusnas/fb-ad-sync.log 2>&1
```

### 14.6 UI в Cockpit — переключатель режима аутентификации

В секции "Файловый менеджер" → подраздел "Аутентификация":

```
┌────────────────────────────────────────────────────────┐
│  АУТЕНТИФИКАЦИЯ ПОЛЬЗОВАТЕЛЕЙ                          │
│                                                        │
│  Режим:  ○ Локальные пользователи rusNAS               │
│          ● Active Directory (DOMAIN\users)  ←          │
│                                                        │
│  Домен: CORP.LOCAL  [подключён ✓]                      │
│  Группа администраторов FileBrowser: [rusnas-admins ▾] │
│  Группа только чтение:              [rusnas-readonly▾] │
│                                                        │
│  [Синхронизировать пользователей сейчас]               │
└────────────────────────────────────────────────────────┘
```

Переключатель активен только если AD настроен в разделе "Пользователи" Cockpit. При переключении:
1. Меняет `settings.json` → `auth.method: "proxy"`
2. Заменяет nginx-конфиг FileBrowser на PAM-версию
3. Перезапускает `rusnas-filebrowser` и перезагружает nginx
4. Запускает `fb-sync-ad-users.py` немедленно

При обратном переключении (AD → локальные):
1. Восстанавливает `auth.method: "json"`
2. Восстанавливает nginx-конфиг без `auth_pam`
3. Предупреждение: "Пользователи FileBrowser потребуют сброса паролей"

### 14.7 Зависимости (устанавливаются Ansible при включении AD)

```bash
# PAM-модуль для nginx
apt install libpam-pwdfile libnginx-mod-http-auth-pam

# Для winbind (если выбран winbind)
apt install winbind libpam-winbind libnss-winbind

# Для sssd (если выбран sssd)
apt install sssd libpam-sss libnss-sss
```

### 14.8 Добавить в раздел "Фаза 2" (таблица ограничений)

| Ограничение | Решение |
|---|---|
| FileBrowser не поддерживает LDAP/AD natively | nginx proxy auth + PAM winbind/sssd |
| DOMAIN\user vs username нормализация | nginx `map` директива |
| Scope для новых AD-пользователей | Автосоздание с дефолтным scope + cron-синхронизация |
| Kerberos SSO (опционально) | `ngx_http_spnego_auth_module` (не в MVP) |

---

## 15. Известные ограничения и решения

| Ограничение | Решение |
|---|---|
| Cockpit CSP запрещает iframe | FileBrowser открывается в новой вкладке, не встраивается |
| FileBrowser не знает о Samba-пользователях | Синхронизация через API при каждом изменении пользователя в Cockpit |
| FileBrowser не поддерживает per-user IP фильтрацию | nginx geo + auth_request guard |
| Btrfs снапшоты скрыты hideDotfiles | Deep link с параметром `showDotfiles=true` |
| Большие файлы — timeout | `proxy_read_timeout 300s` + `client_max_body_size 0` в nginx |
| FileBrowser не поддерживает AD/LDAP natively | nginx PAM proxy auth (реализуется в v0.4) |
