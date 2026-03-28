/# rusNAS Container Manager — Полная спецификация

> **Файл:** `rusnas-container-manager-spec.md`
> **Версия:** 1.0
> **Статус:** Готово к реализации
> **Зависимости:** Cockpit plugin (vanilla JS + Python CGI), Podman, podman-compose, nginx

---

## 1. Обзор

Container Manager — модуль rusNAS для управления контейнеризированными приложениями через Cockpit UI. Превращает NAS в полноценную корпоративную платформу: облако для смартфонов, совместная работа с документами, почта, мессенджер — всё на собственном железе клиента.

### 1.1 Почему Podman, а не Docker

| Критерий | Podman | Docker |
|----------|--------|--------|
| Демон | Нет (fork-exec) | dockerd (SPOF) |
| Root | Rootless by default | Root by default |
| systemd | Нативная интеграция (`podman generate systemd`) | Требует дополнительной настройки |
| Debian 13 | В стандартных репозиториях | Требует добавления Docker repo |
| Совместимость | CLI-совместим с Docker, читает docker-compose | — |
| Безопасность | Нет root-демона = меньшая поверхность атаки | Root-демон = потенциальный вектор |
| Лицензия | Apache 2.0 | Apache 2.0 (engine) |

**Решение:** Podman + `podman-compose` (pip). Все docker-compose.yml файлы работают без модификации.

### 1.2 Архитектурное место в rusNAS

```
┌─────────────────────────────────────────────────┐
│  Cockpit UI                                      │
│  ┌──────────┬──────────┬──────────┬────────────┐ │
│  │Dashboard │ Storage  │ Disks    │ Containers │ │
│  │          │          │ & RAID   │ (новый)    │ │
│  └──────────┴──────────┴──────────┴────────────┘ │
├─────────────────────────────────────────────────┤
│  Python CGI Backend                              │
│  ┌──────────────────────────────────────────────┐│
│  │ container_api.py                             ││
│  │ - Обёртка над podman CLI (JSON output)       ││
│  │ - Чтение/запись app catalog                  ││
│  │ - Генерация compose + systemd units          ││
│  │ - Nginx reverse proxy конфигурация           ││
│  └──────────────────────────────────────────────┘│
├─────────────────────────────────────────────────┤
│  Podman (rootless, systemd-managed)              │
│  ┌────────┬────────┬─────────┬─────────────────┐│
│  │Nextcl. │Immich  │Jellyfin │ ... user apps   ││
│  └────────┴────────┴─────────┴─────────────────┘│
│           │ volumes mounted on Btrfs             │
├─────────────────────────────────────────────────┤
│  Btrfs / mdadm / LVM                            │
│  (snapshots защищают данные контейнеров)          │
└─────────────────────────────────────────────────┘
```

---

## 2. Системные требования и установка

### 2.1 Пакеты (Ansible role: `rusnas-containers`)

```yaml
# roles/rusnas-containers/tasks/main.yml
- name: Install Podman stack
  apt:
    name:
      - podman
      - podman-compose        # Debian 13 включает
      - buildah               # Для сборки образов (опционально)
      - slirp4netns           # Rootless networking
      - fuse-overlayfs        # Rootless storage
      - crun                  # OCI runtime (быстрее runc)
      - uidmap                # Для rootless user namespaces
    state: present

- name: Create containers system user
  user:
    name: rusnas-containers
    system: yes
    shell: /usr/sbin/nologin
    home: /var/lib/rusnas-containers
    create_home: yes

- name: Enable lingering for rootless Podman
  command: loginctl enable-linger rusnas-containers

- name: Create app data directories
  file:
    path: "{{ item }}"
    state: directory
    owner: rusnas-containers
    group: rusnas-containers
    mode: "0750"
  loop:
    - /var/lib/rusnas-containers/apps
    - /var/lib/rusnas-containers/catalog
    - /var/lib/rusnas-containers/compose
    - /var/lib/rusnas-containers/nginx-apps
    - /etc/rusnas/containers

- name: Install catalog index
  copy:
    src: catalog/index.json
    dest: /var/lib/rusnas-containers/catalog/index.json
    owner: rusnas-containers
    group: rusnas-containers
    mode: "0640"

- name: Deploy nginx apps config include
  template:
    src: nginx-apps.conf.j2
    dest: /etc/nginx/conf.d/rusnas-apps.conf
  notify: reload nginx

- name: Deploy Cockpit container-manager plugin
  copy:
    src: cockpit/containers/
    dest: /usr/share/cockpit/rusnas/
    owner: root
    group: root
    mode: "0644"
```

### 2.2 Podman конфигурация

```ini
# /etc/containers/registries.conf.d/rusnas.conf
[registries.search]
registries = ['docker.io', 'ghcr.io', 'quay.io']

[registries.block]
registries = []
```

```toml
# /etc/containers/containers.conf.d/rusnas.conf
[engine]
runtime = "crun"

[containers]
log_driver = "journald"
log_size_max = 10485760   # 10MB per container
```

### 2.3 Хранение данных контейнеров

**Принцип:** Данные контейнеров ВСЕГДА хранятся на Btrfs-томах rusNAS, НЕ в overlay хранилище Podman.

Структура на Btrfs-томе:
```
/mnt/<volume>/containers/
├── nextcloud/
│   ├── data/            # Nextcloud user files
│   ├── config/          # Nextcloud config
│   └── db/              # MariaDB data
├── immich/
│   ├── upload/          # Photo uploads
│   ├── library/         # Processed library
│   └── db/              # PostgreSQL data
├── jellyfin/
│   ├── config/
│   └── cache/
└── ...
```

Выбор тома — при установке приложения пользователь выбирает Btrfs-том из dropdown (аналогично созданию шар). По умолчанию — том с наибольшим свободным местом.

---

## 3. Каталог приложений

### 3.1 Трёхуровневая архитектура

```
Уровень 1: Курируемый каталог rusNAS      ← тестировано, гарантировано
Уровень 2: Пользовательские контейнеры     ← свобода, своя ответственность
Уровень 3: Внешние каталоги (опционально)  ← CasaOS/Portainer import
```

### 3.2 Формат rusnas-app.json (каталог)

Каждое приложение в каталоге — директория с двумя файлами:

```
catalog/
├── index.json                  # Общий индекс всех приложений
├── nextcloud/
│   ├── rusnas-app.json         # Метаданные
│   └── docker-compose.yml      # Compose-файл (шаблон)
├── immich/
│   ├── rusnas-app.json
│   └── docker-compose.yml
├── jellyfin/
│   ├── rusnas-app.json
│   └── docker-compose.yml
└── ...
```

#### index.json — общий индекс

```json
{
  "version": "1.0",
  "updated": "2026-03-26T00:00:00Z",
  "apps": [
    {
      "id": "nextcloud",
      "version": "29.0",
      "category": "cloud",
      "featured": true
    },
    {
      "id": "immich",
      "version": "1.115",
      "category": "photos",
      "featured": true
    }
  ]
}
```

#### rusnas-app.json — метаданные приложения

```json
{
  "id": "nextcloud",
  "name": {
    "ru": "Nextcloud",
    "en": "Nextcloud"
  },
  "description": {
    "ru": "Облачное хранилище с синхронизацией файлов, календарём, контактами. Замена Google Drive / Dropbox.",
    "en": "Cloud storage with file sync, calendar, contacts. Google Drive / Dropbox replacement."
  },
  "icon": "nextcloud.svg",
  "category": "cloud",
  "tags": ["sync", "files", "calendar", "contacts", "office"],
  "homepage": "https://nextcloud.com",
  "source": "https://github.com/nextcloud/server",
  "license": "AGPL-3.0",

  "requirements": {
    "ram_mb": 512,
    "ram_recommended_mb": 2048,
    "cpu_cores": 1,
    "disk_gb": 5,
    "arch": ["amd64", "arm64"]
  },

  "containers": ["nextcloud-app", "nextcloud-db", "nextcloud-redis"],

  "ports": {
    "web": {
      "container": 80,
      "default_host": 8080,
      "protocol": "http",
      "proxy_path": "/nextcloud/"
    }
  },

  "volumes": {
    "data": {
      "description": {
        "ru": "Файлы пользователей",
        "en": "User files"
      },
      "container_path": "/var/www/html/data",
      "host_subdir": "data",
      "size_hint": "large",
      "backup": true
    },
    "config": {
      "description": {
        "ru": "Конфигурация",
        "en": "Configuration"
      },
      "container_path": "/var/www/html/config",
      "host_subdir": "config",
      "size_hint": "small",
      "backup": true
    },
    "db": {
      "description": {
        "ru": "База данных MariaDB",
        "en": "MariaDB database"
      },
      "container_path": "/var/lib/mysql",
      "host_subdir": "db",
      "size_hint": "medium",
      "backup": true
    }
  },

  "env_vars": {
    "MYSQL_ROOT_PASSWORD": {
      "description": "MySQL root password",
      "type": "password",
      "auto_generate": true,
      "length": 32
    },
    "MYSQL_DATABASE": {
      "type": "string",
      "default": "nextcloud"
    },
    "NEXTCLOUD_ADMIN_USER": {
      "description": "Admin username",
      "type": "string",
      "default": "admin"
    },
    "NEXTCLOUD_ADMIN_PASSWORD": {
      "description": "Admin password",
      "type": "password",
      "auto_generate": true,
      "length": 16,
      "show_after_install": true
    },
    "NEXTCLOUD_TRUSTED_DOMAINS": {
      "type": "string",
      "auto": "hostname"
    }
  },

  "post_install": {
    "message": {
      "ru": "Nextcloud доступен по адресу {url}. Первый запуск занимает 1-2 минуты.",
      "en": "Nextcloud is available at {url}. First launch takes 1-2 minutes."
    },
    "ready_check": {
      "type": "http",
      "path": "/status.php",
      "expect": "installed",
      "timeout_sec": 120
    }
  },

  "integrations": {
    "onlyoffice": {
      "description": {
        "ru": "Совместное редактирование документов",
        "en": "Collaborative document editing"
      },
      "app_id": "onlyoffice",
      "auto_configure": true
    }
  },

  "featured": true,
  "sort_order": 1
}
```

### 3.3 Шаблонный docker-compose.yml

```yaml
# catalog/nextcloud/docker-compose.yml
# Переменные {{VARIABLE}} заменяются при установке

version: "3.8"

services:
  nextcloud-app:
    image: nextcloud:{{IMAGE_TAG:-29-apache}}
    container_name: rusnas-nextcloud-app
    restart: unless-stopped
    ports:
      - "{{HOST_PORT:-8080}}:80"
    environment:
      - MYSQL_HOST=nextcloud-db
      - MYSQL_DATABASE={{MYSQL_DATABASE:-nextcloud}}
      - MYSQL_USER=nextcloud
      - MYSQL_PASSWORD={{MYSQL_PASSWORD}}
      - MYSQL_ROOT_PASSWORD={{MYSQL_ROOT_PASSWORD}}
      - NEXTCLOUD_ADMIN_USER={{NEXTCLOUD_ADMIN_USER:-admin}}
      - NEXTCLOUD_ADMIN_PASSWORD={{NEXTCLOUD_ADMIN_PASSWORD}}
      - NEXTCLOUD_TRUSTED_DOMAINS={{NEXTCLOUD_TRUSTED_DOMAINS}}
      - REDIS_HOST=nextcloud-redis
    volumes:
      - {{VOLUME_PATH}}/data:/var/www/html/data
      - {{VOLUME_PATH}}/config:/var/www/html/config
      - {{VOLUME_PATH}}/apps2:/var/www/html/custom_apps
    depends_on:
      - nextcloud-db
      - nextcloud-redis
    networks:
      - rusnas-nextcloud

  nextcloud-db:
    image: mariadb:11
    container_name: rusnas-nextcloud-db
    restart: unless-stopped
    environment:
      - MYSQL_ROOT_PASSWORD={{MYSQL_ROOT_PASSWORD}}
      - MYSQL_DATABASE={{MYSQL_DATABASE:-nextcloud}}
      - MYSQL_USER=nextcloud
      - MYSQL_PASSWORD={{MYSQL_PASSWORD}}
    volumes:
      - {{VOLUME_PATH}}/db:/var/lib/mysql
    networks:
      - rusnas-nextcloud

  nextcloud-redis:
    image: redis:7-alpine
    container_name: rusnas-nextcloud-redis
    restart: unless-stopped
    networks:
      - rusnas-nextcloud

networks:
  rusnas-nextcloud:
    driver: bridge
```

### 3.4 Стартовый каталог приложений (v1.0)

| ID | Название | Категория | Описание (RU) | Образы | RAM min |
|----|----------|-----------|---------------|--------|---------|
| `nextcloud` | Nextcloud | cloud | Облако: файлы, календарь, контакты, синхронизация смартфонов | nextcloud + mariadb + redis | 512 MB |
| `immich` | Immich | photos | Замена Google Photos: автозагрузка с телефона, AI-распознавание лиц, поиск | immich-server + immich-ml + postgres + redis | 2 GB |
| `jellyfin` | Jellyfin | media | Домашний медиасервер: фильмы, сериалы, музыка | jellyfin | 512 MB |
| `vaultwarden` | Vaultwarden | security | Менеджер паролей (Bitwarden-совместимый) | vaultwarden | 64 MB |
| `home-assistant` | Home Assistant | iot | Умный дом: автоматизация, IoT | homeassistant | 256 MB |
| `pihole` | Pi-hole | network | DNS-фильтрация рекламы и трекеров | pihole | 128 MB |
| `wireguard` | WireGuard Easy | vpn | VPN-сервер с веб-интерфейсом | wg-easy | 64 MB |
| `mailcow` | Mailcow | mail | Почтовый сервер: Postfix + Dovecot + SOGo (веб-почта) + антиспам | mailcow (multi) | 2 GB |
| `onlyoffice` | ONLYOFFICE Docs | office | Совместное редактирование документов (DOCX/XLSX/PPTX) | onlyoffice-ds | 2 GB |
| `rocketchat` | Rocket.Chat | messenger | Корпоративный мессенджер: каналы, треды, видеозвонки, LDAP | rocketchat + mongodb | 1 GB |

**Интеграции между приложениями:**
- Nextcloud + ONLYOFFICE → совместное редактирование прямо в файловом облаке
- Nextcloud + Immich → общие альбомы через внешнее хранилище
- Rocket.Chat + LDAP (v0.4 roadmap) → единая корпоративная авторизация
- Все приложения + Btrfs Snapshots → защита данных контейнеров

---

## 4. Backend — Python CGI API

### 4.1 Файл: `cgi/container_api.py`

**Маршруты:**

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `?action=catalog` | Список приложений каталога |
| GET | `?action=installed` | Список установленных приложений |
| GET | `?action=status&app=<id>` | Статус контейнеров приложения |
| GET | `?action=logs&app=<id>&lines=100` | Логи контейнера (journald) |
| GET | `?action=stats` | CPU/RAM/Net всех контейнеров |
| GET | `?action=volumes` | Доступные Btrfs-тома для маппинга |
| POST | `?action=install` | Установить приложение из каталога |
| POST | `?action=uninstall&app=<id>` | Удалить приложение |
| POST | `?action=start&app=<id>` | Запустить |
| POST | `?action=stop&app=<id>` | Остановить |
| POST | `?action=restart&app=<id>` | Перезапустить |
| POST | `?action=update&app=<id>` | Обновить образы |
| POST | `?action=custom_install` | Установить пользовательский контейнер |
| POST | `?action=import_compose` | Импортировать docker-compose.yml |
| GET | `?action=external_catalog&source=<url>` | Загрузить внешний каталог |

### 4.2 Установка приложения — процесс

```python
#!/usr/bin/env python3
"""container_api.py — rusNAS Container Manager backend"""

import json, os, subprocess, sys, secrets, string, shutil, re

CATALOG_DIR = "/var/lib/rusnas-containers/catalog"
COMPOSE_DIR = "/var/lib/rusnas-containers/compose"
APPS_STATE  = "/etc/rusnas/containers/installed.json"
NGINX_APPS  = "/var/lib/rusnas-containers/nginx-apps"
CONTAINER_USER = "rusnas-containers"

def run_podman(args, as_user=True):
    """Выполнить podman-команду от имени контейнерного пользователя"""
    cmd = []
    if as_user:
        cmd = ["sudo", "-u", CONTAINER_USER, "podman"] + args
    else:
        cmd = ["podman"] + args
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    return result

def run_compose(compose_dir, action, as_user=True):
    """Выполнить podman-compose action в директории compose"""
    cmd_prefix = ["sudo", "-u", CONTAINER_USER] if as_user else []
    cmd = cmd_prefix + ["podman-compose", "-f",
           os.path.join(compose_dir, "docker-compose.yml")] + action
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    return result

def generate_password(length=32):
    """Криптографически стойкий пароль"""
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))

def get_btrfs_volumes():
    """Получить список Btrfs-томов (аналог storage dropdown)"""
    result = subprocess.run(
        ["findmnt", "--real", "-t", "btrfs", "-n", "-o", "TARGET,SIZE,AVAIL"],
        capture_output=True, text=True
    )
    volumes = []
    for line in result.stdout.strip().split('\n'):
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) >= 3:
            volumes.append({
                "path": parts[0],
                "size": parts[1],
                "avail": parts[2]
            })
    return volumes

def install_app(app_id, volume_path, host_port=None, env_overrides=None):
    """
    Установка приложения из каталога:
    1. Прочитать rusnas-app.json + docker-compose.yml
    2. Сгенерировать пароли (auto_generate)
    3. Подставить переменные в compose-шаблон
    4. Создать директории данных на Btrfs-томе
    5. Записать compose-файл
    6. podman-compose up -d
    7. Сгенерировать systemd unit
    8. Сгенерировать nginx reverse proxy конфиг
    9. Обновить installed.json
    """
    # 1. Читаем метаданные
    app_dir = os.path.join(CATALOG_DIR, app_id)
    with open(os.path.join(app_dir, "rusnas-app.json")) as f:
        app_meta = json.load(f)
    with open(os.path.join(app_dir, "docker-compose.yml")) as f:
        compose_template = f.read()

    # 2. Генерируем пароли и переменные
    env_vars = {}
    generated_secrets = {}
    for var_name, var_def in app_meta.get("env_vars", {}).items():
        if env_overrides and var_name in env_overrides:
            env_vars[var_name] = env_overrides[var_name]
        elif var_def.get("auto_generate"):
            pwd = generate_password(var_def.get("length", 32))
            env_vars[var_name] = pwd
            if var_def.get("show_after_install"):
                generated_secrets[var_name] = pwd
        elif var_def.get("auto") == "hostname":
            hostname = subprocess.run(
                ["hostname", "-f"], capture_output=True, text=True
            ).stdout.strip()
            env_vars[var_name] = f"localhost {hostname}"
        elif "default" in var_def:
            env_vars[var_name] = str(var_def["default"])

    # 3. Подставляем переменные в compose
    container_data_path = os.path.join(volume_path, "containers", app_id)
    compose_content = compose_template.replace("{{VOLUME_PATH}}", container_data_path)

    port_info = app_meta.get("ports", {}).get("web", {})
    actual_port = host_port or port_info.get("default_host", 8080)
    compose_content = compose_content.replace("{{HOST_PORT}}", str(actual_port))

    for var_name, var_value in env_vars.items():
        compose_content = re.sub(
            r'\{\{' + var_name + r'(?::-[^}]*)?\}\}',
            var_value,
            compose_content
        )
    # Убрать оставшиеся шаблоны с дефолтами
    compose_content = re.sub(
        r'\{\{(\w+):-([^}]*)\}\}',
        r'\2',
        compose_content
    )

    # 4. Создаём директории данных
    for vol_key, vol_def in app_meta.get("volumes", {}).items():
        dir_path = os.path.join(container_data_path, vol_def["host_subdir"])
        os.makedirs(dir_path, exist_ok=True)
        # Устанавливаем владельца для rootless Podman
        subprocess.run(["chown", "-R",
                       f"{CONTAINER_USER}:{CONTAINER_USER}", dir_path])

    # 5. Записываем compose-файл
    compose_out_dir = os.path.join(COMPOSE_DIR, app_id)
    os.makedirs(compose_out_dir, exist_ok=True)
    compose_file = os.path.join(compose_out_dir, "docker-compose.yml")
    with open(compose_file, 'w') as f:
        f.write(compose_content)
    subprocess.run(["chown", "-R",
                   f"{CONTAINER_USER}:{CONTAINER_USER}", compose_out_dir])

    # 6. Запускаем
    result = run_compose(compose_out_dir, ["up", "-d"])
    if result.returncode != 0:
        return {"error": result.stderr, "phase": "compose_up"}

    # 7. Генерируем systemd unit для автозапуска
    generate_systemd_unit(app_id, compose_out_dir)

    # 8. Nginx reverse proxy
    if port_info.get("proxy_path"):
        generate_nginx_proxy(app_id, actual_port, port_info["proxy_path"])

    # 9. Сохраняем состояние
    save_installed_app(app_id, {
        "app_id": app_id,
        "name": app_meta["name"],
        "version": app_meta.get("version", "latest"),
        "volume_path": volume_path,
        "data_path": container_data_path,
        "compose_dir": compose_out_dir,
        "host_port": actual_port,
        "proxy_path": port_info.get("proxy_path"),
        "env_vars": {k: v for k, v in env_vars.items()
                     if app_meta["env_vars"].get(k, {}).get("type") != "password"},
        "secrets": generated_secrets,
        "installed_at": now_iso(),
        "status": "running"
    })

    return {
        "ok": True,
        "app_id": app_id,
        "url": port_info.get("proxy_path", f":{actual_port}"),
        "secrets": generated_secrets
    }


def generate_systemd_unit(app_id, compose_dir):
    """Создаёт systemd unit для автозапуска стека при загрузке"""
    unit_content = f"""[Unit]
Description=rusNAS App: {app_id}
After=network-online.target
Wants=network-online.target
RequiresMountsFor={compose_dir}

[Service]
Type=oneshot
RemainAfterExit=yes
User={CONTAINER_USER}
WorkingDirectory={compose_dir}
ExecStart=/usr/bin/podman-compose -f {compose_dir}/docker-compose.yml up -d
ExecStop=/usr/bin/podman-compose -f {compose_dir}/docker-compose.yml down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
"""
    unit_path = f"/etc/systemd/system/rusnas-app-{app_id}.service"
    with open(unit_path, 'w') as f:
        f.write(unit_content)
    subprocess.run(["systemctl", "daemon-reload"])
    subprocess.run(["systemctl", "enable", f"rusnas-app-{app_id}.service"])


def generate_nginx_proxy(app_id, host_port, proxy_path):
    """Генерирует nginx location block для reverse proxy"""
    conf_content = f"""# Auto-generated by rusNAS Container Manager
# App: {app_id}
location {proxy_path} {{
    proxy_pass http://127.0.0.1:{host_port}/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_redirect off;
    proxy_buffering off;
    client_max_body_size 10G;
    proxy_read_timeout 86400;
}}
"""
    conf_path = os.path.join(NGINX_APPS, f"{app_id}.conf")
    with open(conf_path, 'w') as f:
        f.write(conf_content)
    subprocess.run(["nginx", "-t"], capture_output=True)
    subprocess.run(["systemctl", "reload", "nginx"])
```

### 4.3 Пользовательские контейнеры

```python
def install_custom_container(image, name, ports=None, env=None,
                              volumes=None, restart="unless-stopped"):
    """
    Установка пользовательского контейнера.
    Генерирует compose-файл и запускает.

    ports: {"8080": "80", "8443": "443"}  # host:container
    env: {"KEY": "value"}
    volumes: [{"host": "/mnt/data/myapp", "container": "/data"}]
    """
    app_id = f"custom-{name}"
    compose_dir = os.path.join(COMPOSE_DIR, app_id)
    os.makedirs(compose_dir, exist_ok=True)

    # Генерируем compose
    services = {
        name: {
            "image": image,
            "container_name": f"rusnas-{name}",
            "restart": restart
        }
    }

    if ports:
        services[name]["ports"] = [
            f"{hp}:{cp}" for hp, cp in ports.items()
        ]

    if env:
        services[name]["environment"] = [
            f"{k}={v}" for k, v in env.items()
        ]

    if volumes:
        services[name]["volumes"] = [
            f"{v['host']}:{v['container']}" for v in volumes
        ]
        # Создаём host-директории
        for v in volumes:
            os.makedirs(v["host"], exist_ok=True)

    compose = {
        "version": "3.8",
        "services": services
    }

    # Пишем YAML (без зависимости от PyYAML — simple dump)
    compose_file = os.path.join(compose_dir, "docker-compose.yml")
    write_simple_compose(compose_file, compose)

    # Запуск
    subprocess.run(["chown", "-R",
                   f"{CONTAINER_USER}:{CONTAINER_USER}", compose_dir])
    result = run_compose(compose_dir, ["up", "-d"])

    if result.returncode != 0:
        return {"error": result.stderr}

    generate_systemd_unit(app_id, compose_dir)

    save_installed_app(app_id, {
        "app_id": app_id,
        "name": {"ru": name, "en": name},
        "custom": True,
        "image": image,
        "compose_dir": compose_dir,
        "host_ports": ports or {},
        "installed_at": now_iso(),
        "status": "running"
    })

    return {"ok": True, "app_id": app_id}


def import_compose_file(compose_content, name, volume_path=None):
    """
    Импорт произвольного docker-compose.yml.
    Пользователь загружает файл — rusNAS парсит и запускает.
    """
    app_id = f"imported-{name}"
    compose_dir = os.path.join(COMPOSE_DIR, app_id)
    os.makedirs(compose_dir, exist_ok=True)

    compose_file = os.path.join(compose_dir, "docker-compose.yml")
    with open(compose_file, 'w') as f:
        f.write(compose_content)

    subprocess.run(["chown", "-R",
                   f"{CONTAINER_USER}:{CONTAINER_USER}", compose_dir])

    result = run_compose(compose_dir, ["up", "-d"])
    if result.returncode != 0:
        return {"error": result.stderr}

    generate_systemd_unit(app_id, compose_dir)

    save_installed_app(app_id, {
        "app_id": app_id,
        "name": {"ru": name, "en": name},
        "imported": True,
        "compose_dir": compose_dir,
        "installed_at": now_iso(),
        "status": "running"
    })

    return {"ok": True, "app_id": app_id}
```

### 4.4 Мониторинг контейнеров

```python
def get_container_stats():
    """Получить CPU/RAM/Net для всех rusNAS контейнеров"""
    result = run_podman([
        "stats", "--no-stream", "--format",
        "json"
    ])
    if result.returncode != 0:
        return []

    stats = json.loads(result.stdout)
    # Фильтруем только rusNAS-контейнеры
    return [s for s in stats if s.get("Name", "").startswith("rusnas-")]

def get_container_logs(app_id, lines=100):
    """Логи через journald (podman с log_driver=journald)"""
    installed = load_installed_apps()
    app = installed.get(app_id)
    if not app:
        return {"error": "App not found"}

    # Получаем имена контейнеров приложения
    compose_dir = app["compose_dir"]
    result = run_compose(compose_dir, ["ps", "--format", "json"])

    logs = {}
    containers = json.loads(result.stdout) if result.returncode == 0 else []
    for c in containers:
        name = c.get("Name", c.get("name"))
        log_result = run_podman(["logs", "--tail", str(lines), name])
        logs[name] = log_result.stdout + log_result.stderr

    return logs
```

---

## 5. Cockpit UI — страница «Приложения»

### 5.1 Навигация

Новый пункт в sidebar: **Приложения** (иконка: `grid-2x2` или `package`).
Позиция: после «Снапшоты», перед «Дедупликация».

### 5.2 Файлы

```
cockpit/rusnas/
├── containers.html          # Главная страница
├── js/containers.js         # Логика
└── css/containers.css       # Стили (минимум, основное из style.css)
```

### 5.3 manifest.json — добавление страницы

```json
{
  "menu": {
    "containers": {
      "label": "Приложения",
      "order": 55,
      "path": "containers.html"
    }
  }
}
```

### 5.4 Структура страницы — 3 вкладки

```
┌─────────────────────────────────────────────────────────────┐
│  📦 Приложения                                              │
│                                                              │
│  [Каталог]  [Установленные]  [Свой контейнер]                │
│                                                              │
│  ─────────────────────────────────────────────────────────   │
│                                                              │
│  (содержимое вкладки)                                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

Вкладки реализуются через `advisor-tabs` (обязательно, не Bootstrap tabs).

### 5.5 Вкладка 1 — Каталог

**Фильтры по категориям:**

```
[Все] [Облако] [Фото] [Медиа] [Офис] [Почта] [Чат] [Безопасность] [Сеть] [IoT]
```

Реализация: горизонтальный ряд кнопок `.btn-sm .btn-secondary`, активная — `.btn-primary`.

**Карточки приложений:**

```
┌─────────────────────────────────────────────┐
│                                              │
│  ┌──────┐  Nextcloud                ★ Хит   │
│  │ icon │  Облачное хранилище с              │
│  │ 64px │  синхронизацией файлов...          │
│  └──────┘                                    │
│                                              │
│  cloud  │  RAM: 512 MB  │  3 контейнера      │
│                                              │
│  [Установить]                   [Подробнее]  │
│                                              │
└─────────────────────────────────────────────┘
```

CSS-класс: `.app-card` (расширение `db-card` паттерна). Grid: `display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px;`

Карточка уже установленного приложения показывает зелёную метку «Установлено» вместо кнопки.

**Модал установки:**

```
┌─────────────────────────────────────────────────────┐
│  Установка: Nextcloud                           ✕   │
│  ─────────────────────────────────────────────────── │
│                                                      │
│  Том для данных *                                    │
│  ┌──────────────────────────────────────────────┐    │
│  │ /mnt/data1 (RAID5, 3.2 TB свободно)     ▾ │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  Порт веб-интерфейса                                 │
│  ┌──────────┐                                        │
│  │ 8080     │  (по умолчанию)                        │
│  └──────────┘                                        │
│                                                      │
│  Имя администратора                                  │
│  ┌──────────────────┐                                │
│  │ admin            │                                │
│  └──────────────────┘                                │
│                                                      │
│  Пароль администратора                               │
│  ┌──────────────────────────┐  🔄 Сгенерировать      │
│  │ ●●●●●●●●●●●●           │                        │
│  └──────────────────────────┘                        │
│                                                      │
│  ⓘ Потребуется ~512 MB RAM, ~5 GB диска.             │
│    Первый запуск занимает 1–2 минуты.                │
│                                                      │
│  ────────────────────────────────────────────         │
│                           [Отмена]  [Установить]     │
│                                                      │
└─────────────────────────────────────────────────────┘
```

Модал: `.modal-box-wide` (820px). Dropdown тома — `findmnt --real -t btrfs`.

**Прогресс установки:**

После нажатия «Установить» — модал переходит в режим прогресса:
```
┌─────────────────────────────────────────────────────┐
│  Установка: Nextcloud                               │
│  ─────────────────────────────────────────────────── │
│                                                      │
│  ✅ Создание директорий...                           │
│  ✅ Загрузка образа nextcloud:29-apache...           │
│  ⏳ Загрузка образа mariadb:11...          [43%]    │
│  ⬜ Запуск контейнеров...                            │
│  ⬜ Настройка reverse proxy...                       │
│  ⬜ Проверка готовности...                           │
│                                                      │
│  ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░  43%                    │
│                                                      │
└─────────────────────────────────────────────────────┘
```

Реализация: `cockpit.spawn()` с потоковым чтением stdout. Парсинг podman pull output для процента.

**Результат установки:**

```
┌─────────────────────────────────────────────────────┐
│  ✅ Nextcloud установлен                             │
│  ─────────────────────────────────────────────────── │
│                                                      │
│  🌐 Адрес: http://nas.local/nextcloud/               │
│                                                      │
│  👤 Логин:  admin                                    │
│  🔑 Пароль: Jk8mNp2xQwLr4sTv   [Копировать]        │
│                                                      │
│  ⚠ Сохраните пароль! Он больше не будет показан.     │
│                                                      │
│  💡 Мобильные приложения:                            │
│     iOS: Nextcloud в App Store                       │
│     Android: Nextcloud в Google Play                 │
│                                                      │
│  ────────────────────────────────────────────         │
│                           [Открыть]  [Закрыть]       │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### 5.6 Вкладка 2 — Установленные

**Список установленных приложений:**

```
┌────────────────────────────────────────────────────────────────────┐
│  ┌──────┐  Nextcloud          ● Работает    CPU 3%  RAM 245 MB    │
│  │ icon │  http://nas/nextcloud/             Uptime: 14д 3ч       │
│  └──────┘  /mnt/data1/containers/nextcloud   Данные: 12.4 GB      │
│                                                                    │
│            [Открыть]  [Перезапустить]  [Остановить]  [⋮ Ещё]       │
├────────────────────────────────────────────────────────────────────┤
│  ┌──────┐  Immich             ● Работает    CPU 8%  RAM 1.2 GB    │
│  │ icon │  http://nas/photos/                Uptime: 14д 3ч       │
│  └──────┘  /mnt/data1/containers/immich      Данные: 89.1 GB      │
│                                                                    │
│            [Открыть]  [Перезапустить]  [Остановить]  [⋮ Ещё]       │
├────────────────────────────────────────────────────────────────────┤
│  ┌──────┐  my-custom-app      ● Работает    CPU 1%  RAM 64 MB     │
│  │  🔧  │  :9000               Uptime: 2д 1ч                      │
│  └──────┘  Пользовательский                 Данные: 256 MB        │
│                                                                    │
│            [Открыть]  [Перезапустить]  [Остановить]  [⋮ Ещё]       │
└────────────────────────────────────────────────────────────────────┘
```

Меню «⋮ Ещё»:
- Логи
- Обновить образы
- Изменить порт
- Пересоздать контейнеры
- Удалить (с подтверждением: «Удалить данные тоже?»)

**Статусы контейнеров:**
- `● Работает` — `.live-dot` зелёный
- `● Остановлен` — серый
- `● Ошибка` — `.live-dot--warn` красный с blink
- `⏳ Запускается` — жёлтый

**Обновление stats:** каждые 5 секунд через `podman stats --no-stream --format json`.

### 5.7 Вкладка 3 — Свой контейнер

**Два режима:**

```
┌─────────────────────────────────────────────────────┐
│  Добавить свой контейнер                             │
│                                                      │
│  ┌────────────────────┐  ┌────────────────────────┐  │
│  │  📝 Простая форма  │  │  📄 Импорт Compose     │  │
│  │                    │  │                        │  │
│  │  Укажите образ,    │  │  Загрузите свой        │  │
│  │  порты и volumes   │  │  docker-compose.yml    │  │
│  └────────────────────┘  └────────────────────────┘  │
│                                                      │
└─────────────────────────────────────────────────────┘
```

**Простая форма:**

```
┌─────────────────────────────────────────────────────┐
│  Новый контейнер                                     │
│  ─────────────────────────────────────────────────── │
│                                                      │
│  Название *                                          │
│  ┌──────────────────────────────────────────────┐    │
│  │ my-app                                      │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  Docker-образ *                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ nginx:latest                                │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  Порты (host → контейнер)                            │
│  ┌────────┐  →  ┌────────┐  [+ Добавить порт]       │
│  │ 9090   │     │ 80     │                           │
│  └────────┘     └────────┘                           │
│                                                      │
│  Переменные окружения                                │
│  ┌────────────────┐  =  ┌───────────────┐  [+]      │
│  │ DB_HOST        │     │ localhost     │            │
│  └────────────────┘     └───────────────┘            │
│                                                      │
│  Volumes                                             │
│  Том: ┌─────────────────────────────────┐            │
│       │ /mnt/data1                  ▾ │            │
│       └─────────────────────────────────┘            │
│  Папка: ┌──────────┐  →  ┌──────────────┐  [+]      │
│         │ mydata   │     │ /data        │            │
│         └──────────┘     └──────────────┘            │
│                                                      │
│  Политика перезапуска                                │
│  ◉ Всегда перезапускать  ○ Никогда  ○ При ошибке    │
│                                                      │
│  ────────────────────────────────────────────         │
│                           [Отмена]  [Запустить]      │
│                                                      │
└─────────────────────────────────────────────────────┘
```

**Импорт Compose:**

```
┌─────────────────────────────────────────────────────┐
│  Импорт docker-compose.yml                           │
│  ─────────────────────────────────────────────────── │
│                                                      │
│  Название проекта *                                  │
│  ┌──────────────────────────────────────────────┐    │
│  │ my-stack                                    │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │                                              │    │
│  │   📄 Перетащите docker-compose.yml сюда      │    │
│  │      или нажмите для выбора                  │    │
│  │                                              │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ version: "3.8"                               │    │
│  │ services:                                    │    │
│  │   web:                                       │    │
│  │     image: nginx:latest                      │    │
│  │     ...                                      │    │
│  └──────────────────────────────────────────────┘    │
│  (предпросмотр загруженного файла, monospace)        │
│                                                      │
│  ⚠ Убедитесь что volumes указывают на               │
│    существующие пути на NAS.                         │
│                                                      │
│  ────────────────────────────────────────────         │
│                           [Отмена]  [Запустить]      │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## 6. Nginx Reverse Proxy

### 6.1 Архитектура

Каждое установленное приложение получает nginx location block. Все конфиги автогенерируются в `/var/lib/rusnas-containers/nginx-apps/` и включаются через:

```nginx
# /etc/nginx/conf.d/rusnas-apps.conf
# Auto-managed by rusNAS Container Manager — do not edit

include /var/lib/rusnas-containers/nginx-apps/*.conf;
```

### 6.2 Маршруты по умолчанию

| Приложение | URL | Порт |
|-----------|-----|------|
| Nextcloud | `/nextcloud/` | 8080 |
| Immich | `/photos/` | 2283 |
| Jellyfin | `/jellyfin/` | 8096 |
| Vaultwarden | `/vault/` | 8880 |
| Home Assistant | `/hass/` | 8123 |
| Pi-hole | `/pihole/` | 8053 |
| WireGuard | `/vpn/` | 51821 |
| Mailcow | `/mail/` | 8443 |
| ONLYOFFICE | `/office/` | 8044 |
| Rocket.Chat | `/chat/` | 3000 |
| FileBrowser | `/files/` | 8085 |

Пользователь может изменить порт и path при установке или после.

---

## 7. Интеграция с rusNAS

### 7.1 Btrfs Snapshots

Данные контейнеров (`/mnt/<vol>/containers/<app>/`) — обычные директории на Btrfs. Они автоматически покрываются снапшотами тома (rusnas-snap). Дополнительной настройки не требуется.

Для приложений с БД (PostgreSQL, MariaDB, MongoDB) рекомендуется pre-snapshot hook:
```bash
# /etc/rusnas/containers/hooks/pre-snapshot.d/flush-dbs.sh
#!/bin/bash
# Flush MariaDB tables перед снапшотом
for db_container in $(podman ps --filter name=rusnas-*-db --format '{{.Names}}'); do
    sudo -u rusnas-containers podman exec "$db_container" \
        mariadb -u root -e "FLUSH TABLES WITH READ LOCK; SYSTEM sleep 2; UNLOCK TABLES;" \
        2>/dev/null || true
done
```

### 7.2 rusNAS-Guard

Контейнерные данные защищаются Guard как обычные шары. Honeypot-файлы размещаются в data-директориях приложений.

### 7.3 Dashboard — виджет контейнеров

Новая карточка на Dashboard:

```
┌─────────────────────────┐
│  📦 ПРИЛОЖЕНИЯ           │
│                         │
│  10 приложений          │
│  9 ● работают  1 ⚠      │
│                         │
│  CPU: 12%  RAM: 3.8 GB  │
│  Клик → Приложения      │
└─────────────────────────┘
```

CSS: `.db-card` (существующий паттерн). Цвет по наихудшему статусу (как RAID-карточка).

### 7.4 Prometheus метрики

Добавить в `rusnas-metrics/metrics_server.py`:

```
# HELP rusnas_container_count Total container count by status
# TYPE rusnas_container_count gauge
rusnas_container_count{status="running"} 9
rusnas_container_count{status="stopped"} 1
rusnas_container_count{status="error"} 0

# HELP rusnas_container_cpu_percent Container CPU usage percent
# TYPE rusnas_container_cpu_percent gauge
rusnas_container_cpu_percent{name="rusnas-nextcloud-app"} 3.2
rusnas_container_cpu_percent{name="rusnas-immich-server"} 8.1

# HELP rusnas_container_memory_bytes Container memory usage bytes
# TYPE rusnas_container_memory_bytes gauge
rusnas_container_memory_bytes{name="rusnas-nextcloud-app"} 256901120
rusnas_container_memory_bytes{name="rusnas-immich-server"} 1288490188
```

---

## 8. Внешние каталоги (Уровень 3, опционально)

### 8.1 Конвертер CasaOS App Store

CasaOS хранит приложения как docker-compose.yml с расширением `x-casaos`. Конвертер:

```python
def import_casaos_catalog(source_url):
    """
    Загружает CasaOS catalog JSON и конвертирует в rusnas-app формат.
    source_url: https://casaos-appstore.github.io/index.json или аналог
    """
    import urllib.request
    response = urllib.request.urlopen(source_url)
    catalog = json.loads(response.read())

    apps = []
    for app in catalog.get("list", []):
        converted = {
            "id": f"external-{app['name']}",
            "name": {"en": app.get("title", app["name"]), "ru": app.get("title", app["name"])},
            "description": {"en": app.get("description", ""), "ru": app.get("description", "")},
            "icon": app.get("icon", ""),
            "category": app.get("category", "other"),
            "source": "casaos",
            "verified": False,
            "compose_url": app.get("compose_url", "")
        }
        apps.append(converted)

    return apps
```

### 8.2 UI для внешних каталогов

Настройки → Внешние каталоги:
```
┌─────────────────────────────────────────────────────┐
│  Внешние каталоги приложений                         │
│                                                      │
│  ⚠ Приложения из внешних каталогов не тестировались  │
│    на rusNAS. Устанавливайте на свой риск.           │
│                                                      │
│  URL каталога                                        │
│  ┌──────────────────────────────────────────────┐    │
│  │ https://...                                 │    │
│  └──────────────────────────────────────────────┘    │
│                                       [Добавить]     │
│                                                      │
│  Подключённые:                                       │
│  • CasaOS App Store (127 приложений)    [Удалить]    │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## 9. Безопасность

### 9.1 Rootless Podman

- Все контейнеры работают от `rusnas-containers` (не root)
- User namespace mapping через `/etc/subuid` и `/etc/subgid`
- Контейнер не может выйти за пределы namespace

### 9.2 Сетевая изоляция

- Каждое приложение — своя bridge network (`rusnas-<app>`)
- Контейнеры разных приложений не видят друг друга (кроме явных зависимостей)
- Внешний доступ — только через nginx reverse proxy

### 9.3 Ограничение ресурсов

При установке из каталога применяются лимиты из `rusnas-app.json`:

```yaml
# Автоматически добавляется в compose
deploy:
  resources:
    limits:
      memory: 2G
      cpus: '2.0'
    reservations:
      memory: 512M
```

Пользовательские контейнеры — без лимитов по умолчанию, с предупреждением.

### 9.4 Автоматические обновления (опционально)

```ini
# /etc/systemd/system/rusnas-container-updates.timer
[Unit]
Description=Check for rusNAS container image updates

[Timer]
OnCalendar=Sun 03:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
```

Логика: `podman pull <image>` для каждого установленного приложения. Если новый digest — уведомление в Dashboard (не авто-перезапуск).

---

## 10. Ansible Role

### 10.1 Структура

```
roles/rusnas-containers/
├── tasks/
│   ├── main.yml              # Установка Podman, создание пользователя
│   ├── cockpit.yml           # Деплой Cockpit-плагина
│   └── catalog.yml           # Деплой каталога приложений
├── templates/
│   ├── nginx-apps.conf.j2    # Nginx include
│   ├── containers.conf.j2    # Podman config
│   └── subuid.j2             # UID mapping
├── files/
│   ├── catalog/              # Каталог приложений
│   │   ├── index.json
│   │   ├── nextcloud/
│   │   ├── immich/
│   │   ├── jellyfin/
│   │   ├── vaultwarden/
│   │   ├── home-assistant/
│   │   ├── pihole/
│   │   ├── wireguard/
│   │   ├── mailcow/
│   │   ├── onlyoffice/
│   │   └── rocketchat/
│   └── cockpit/
│       └── containers/
│           ├── containers.html
│           ├── js/containers.js
│           └── css/containers.css
├── handlers/
│   └── main.yml              # reload nginx, daemon-reload
└── defaults/
    └── main.yml              # Переменные по умолчанию
```

### 10.2 defaults/main.yml

```yaml
rusnas_container_user: rusnas-containers
rusnas_container_home: /var/lib/rusnas-containers
rusnas_catalog_dir: "{{ rusnas_container_home }}/catalog"
rusnas_compose_dir: "{{ rusnas_container_home }}/compose"
rusnas_nginx_apps_dir: "{{ rusnas_container_home }}/nginx-apps"

# Podman registries
rusnas_registries:
  - docker.io
  - ghcr.io
  - quay.io

# Container log limits
rusnas_container_log_max_size: 10485760  # 10MB

# Auto-update check
rusnas_container_auto_update_check: true
rusnas_container_auto_update_day: "Sun"
rusnas_container_auto_update_hour: "03:00"
```

---

## 11. CLI — rusnas-containers

Для администрирования без UI:

```bash
# Список каталога
rusnas-containers catalog list
rusnas-containers catalog list --category cloud

# Установка
rusnas-containers install nextcloud --volume /mnt/data1 --port 8080
rusnas-containers install immich --volume /mnt/data1

# Управление
rusnas-containers list                  # Установленные
rusnas-containers status nextcloud      # Детальный статус
rusnas-containers logs nextcloud        # Логи
rusnas-containers start|stop|restart nextcloud
rusnas-containers update nextcloud      # Pull новых образов
rusnas-containers uninstall nextcloud [--keep-data]

# Пользовательские
rusnas-containers run --name myapp --image nginx:latest --port 9090:80
rusnas-containers import my-stack docker-compose.yml

# Обслуживание
rusnas-containers prune                 # Удалить неиспользуемые образы
rusnas-containers stats                 # Ресурсы всех контейнеров
rusnas-containers backup nextcloud      # Дамп БД + архив данных
```

Реализация: Python-скрипт `/usr/local/bin/rusnas-containers`, аналогично `rusnas-snap`.

---

## 12. Что НЕ делать

| Решение | Почему нет |
|---------|------------|
| Docker вместо Podman | Root-демон, не в Debian 13 по умолчанию, SPOF |
| cockpit-podman как основной UI | Слишком техничный для SMB-пользователей, нет каталога |
| Kubernetes / K3s | Overkill для single-node NAS |
| Snap / Flatpak для серверных приложений | Не предназначены для серверных сервисов |
| Собственный container runtime | Reinventing the wheel |
| Автообновление контейнеров без уведомления | Ломает production-среды |
| Хранение данных в overlay Podman | Не покрывается Btrfs-снапшотами |
| iframe для встраивания веб-интерфейсов | Cockpit CSP блокирует |
| `docker-compose` (v1) | Deprecated, Podman совместим с v2 формат |

---

## 13. Roadmap модуля

| Фаза | Содержание | Зависимости |
|------|-----------|-------------|
| **v1.0** | Каталог 10 приложений, установка/удаление, nginx proxy, systemd units, простые пользовательские контейнеры | Podman, nginx |
| **v1.1** | Импорт compose, внешние каталоги (CasaOS), мониторинг stats | v1.0 |
| **v1.2** | Pre-snapshot DB hooks, backup/restore контейнерных данных | rusnas-snap |
| **v2.0** | GPU passthrough (Immich ML, Jellyfin transcoding), resource limits UI | Hardware detection |
| **v2.1** | LDAP интеграция (Nextcloud, Rocket.Chat, Mailcow — единая авторизация) | v0.4 AD roadmap |
| **v2.2** | Fleet: централизованная установка приложений на парк устройств | Fleet management |
