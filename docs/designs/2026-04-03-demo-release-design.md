# rusNAS Demo Release — Design Spec
**Date:** 2026-04-03
**Status:** Draft
**Scope:** Монолитный .deb пакет + demo-install.sh для внутренней демонстрации без VPS/лицензирования

---

## 1. Overview

Единый установочный комплект для демонстрации rusNAS внутри компании. Устанавливается на чистый Debian 13 одной командой. Не требует сервера лицензирования, VPS или интернет-соединения.

**Доставка:** `.deb` пакет + `demo-install.sh` скрипт. Передаётся через USB/scp/шару.

**Защита исходников:**
- JS → minified через `terser` (только `.min.js` в пакете)
- Python → compiled через `compileall` (только `.pyc` в пакете)
- Исходные `.js` и `.py` файлы НЕ включаются

---

## 2. Что входит в пакет

### Cockpit plugin (14 HTML, 15 JS, 7 CSS, manifest.json)
Все страницы: dashboard, storage, disks, users, guard, snapshots, dedup, ups, storage-analyzer, network, ai, performance, containers, license.

### Backend daemons (6 штук)
| Daemon | Source dir | Target dir | Service |
|--------|-----------|------------|---------|
| Guard | rusnas-guard/daemon/ | /usr/lib/rusnas-guard/ | rusnas-guard.service |
| Spindown | rusnas-spind/ | /usr/lib/rusnas/spind/ | rusnas-spind.service |
| Metrics | rusnas-metrics/ | /usr/local/lib/rusnas/ | rusnas-metrics.service |
| Perf Collector | rusnas-perf-collector/ | /usr/lib/rusnas/ | rusnas-perf-collector.service |
| Snapshots | rusnas-snap/ | /usr/local/bin/ | rusnas-snapd.service + timer |
| Dedup | rusnas-dedup/ | /usr/local/bin/ | rusnas-dedup.service |

### CGI/API scripts (8 штук)
container_api.py, spindown_ctl.py, storage-collector.py, storage-analyzer-api.py, network-api.py, certs-api.py, domain-api.py, mcp-api.py + FileBrowser CGI (fb-users-list, fb-set-user-access, fb-sync-*)

### Security Self-Test
sectest.py + 9 check modules + wordlists + service + monthly timer

### WORM enforcement
rusnas-worm.py + service + timer

### Container catalog
10 приложений (nextcloud, immich, jellyfin, vaultwarden, home-assistant, pihole, wireguard, mailcow, onlyoffice, rocketchat)

### Branding
branding.css → /usr/share/cockpit/branding/debian/

### Config files (defaults)
- /etc/rusnas-guard/config.json + ransom_extensions.txt
- /etc/rusnas/spindown.json, dedup-config.json, ssd-tiers.json, worm.json
- /etc/rusnas/containers/installed.json

### Systemd units
10 services + 5 timers

### Sudoers
Единый файл /etc/sudoers.d/rusnas — все правила из всех модулей

---

## 3. Архитектура файлов пакета

```
rusnas-system_1.0.0-demo_amd64.deb
├── DEBIAN/
│   ├── control           # Package metadata + Depends
│   ├── postinst          # Setup: dirs, users, permissions, systemctl enable
│   ├── prerm             # Stop services before removal
│   └── conffiles         # Protect configs on upgrade
├── etc/
│   ├── rusnas/
│   │   ├── spindown.json
│   │   ├── dedup-config.json
│   │   ├── ssd-tiers.json
│   │   ├── worm.json
│   │   └── containers/
│   │       └── installed.json
│   ├── rusnas-guard/
│   │   ├── config.json
│   │   └── ransom_extensions.txt
│   └── sudoers.d/
│       └── rusnas
├── lib/
│   └── systemd/system/
│       ├── rusnas-guard.service
│       ├── rusnas-sectest.service
│       └── rusnas-sectest.timer
├── usr/
│   ├── share/cockpit/
│   │   ├── rusnas/
│   │   │   ├── manifest.json
│   │   │   ├── *.html (14 files)
│   │   │   ├── css/*.css (7 files)
│   │   │   ├── js/*.min.js (15 files, minified)
│   │   │   ├── scripts/*.pyc (compiled Python, no sources)
│   │   │   ├── cgi/*.pyc
│   │   │   └── catalog/ (10 apps, JSON manifests)
│   │   └── branding/debian/
│   │       └── branding.css
│   ├── lib/rusnas/
│   │   ├── spind/*.pyc (spindown daemon, compiled)
│   │   ├── cgi/*.pyc (container_api, spindown_ctl, compiled)
│   │   └── sectest/
│   │       ├── *.pyc (sectest + checks, compiled)
│   │       └── wordlists/
│   │           └── rusnas-paths.txt
│   └── local/
│       ├── bin/
│       │   ├── rusnas-snap (Python, compiled or kept as-is — CLI tool)
│       │   ├── rusnas-dedup-run.sh
│       │   ├── rusnas-worm (compiled)
│       │   └── rusnas-ups-notify
│       └── lib/rusnas/
│           └── metrics_server.pyc
├── var/lib/rusnas/ (empty dir, created by postinst)
└── (systemd units in /etc/systemd/system/ — via postinst)
```

### Python compilation strategy

Python скрипты, которые вызываются через `cockpit.spawn(["python3", "/path/script.py"])` — **нельзя просто скомпилировать в .pyc**, потому что `python3 script.pyc` не работает напрямую. Стратегия:

**Для CGI/API скриптов и daemon'ов:**
- Компилируем `.py` → `.pyc` через `compileall -b`
- Создаём stub `.py` файл-загрузчик:
  ```python
  #!/usr/bin/env python3
  import importlib.util, sys, os
  spec = importlib.util.spec_from_file_location("__main__", os.path.join(os.path.dirname(__file__), "__pycache__", os.path.basename(__file__) + "c"))
  ```

  **Проще:** используем `python3 -B -c "exec(open('/path/script.pyc','rb').read())"` — нет, тоже не работает.

**Реальное решение:**
- Для Python backend скриптов: оставляем `.py` файлы, но пропускаем через `pyminifier` или `pyarmor` для обфускации
- Для JS: terser minification (полностью работает)
- **Или:** просто не включаем .py исходники в пакет, вместо них — stub loader + .pyc в __pycache__

**Принятое решение:** Для демо-релиза — JS минификация (terser), Python скрипты остаются как `.py` но без комментариев и docstrings (через `python3 -OO -m compileall` генерирует .pyo, а исходники всё равно нужны для запуска). Полная обфускация Python — задача для production release.

**Итого:**
- **JS:** terser → `.min.js` (исходники не включаются) ✅
- **Python:** остаются как `.py` (Python требует исходники для запуска через `python3 script.py`). Для production — pyarmor/nuitka.
- **HTML:** ссылки переписываются `.js` → `.min.js` ✅

---

## 4. demo-install.sh

Единый скрипт, запускается на целевой машине от root. Не требует интернета для установки .deb (только для apt зависимостей).

```
Usage: sudo bash demo-install.sh [--offline]
  --offline: не устанавливать apt-зависимости (для pre-provisioned машин)
```

### Шаги:

1. **Preflight**
   - Root check
   - Debian 13 check (lsb_release)
   - Найти .deb файл (в текущей директории или по аргументу)

2. **Зависимости** (если не --offline)
   ```
   apt-get install -y cockpit cockpit-storaged python3 python3-bcrypt python3-inotify \
     python3-croniter samba nfs-kernel-server mdadm btrfs-progs smartmontools hdparm \
     targetcli-fb vsftpd apache2 lvm2 thin-provisioning-tools nut nginx \
     podman podman-compose slirp4netns fuse-overlayfs crun uidmap \
     traceroute dnsutils netcat-openbsd certbot nmap \
     python3-flask python3-requests
   ```

3. **Установка .deb**
   ```
   dpkg -i rusnas-system_*.deb
   apt-get install -f -y  # fix missing deps if any
   ```

4. **Post-install (то что postinst не может)**
   - Создать пользователя rusnas (если нет)
   - Настроить Cockpit: `cockpit.conf` → `AllowUnencrypted = true` (для демо)
   - Создать demo serial: `/etc/rusnas/serial` → `RUSNAS-DEMO-INTE-RNAL-ONLY`
   - Создать demo license: `/etc/rusnas/license.json` → perpetual, all features
   - Включить admin access в Cockpit
   - FireBrowser setup (download binary if online, skip if offline)
   - nginx primary config (landing + Cockpit proxy + container apps)
   - Landing page → /var/www/rusnas-landing/

5. **Enable & start services**
   ```
   systemctl daemon-reload
   systemctl enable --now cockpit.socket
   systemctl enable --now rusnas-guard
   systemctl enable rusnas-snapd.timer
   systemctl enable rusnas-sectest.timer
   systemctl enable rusnas-storage-collector.timer
   systemctl enable rusnas-perf-collector
   systemctl enable rusnas-metrics
   ```

6. **Финальный вывод**
   ```
   ╔══════════════════════════════════════════════════════════════╗
   ║  rusNAS Demo установлен успешно!                            ║
   ╠══════════════════════════════════════════════════════════════╣
   ║  Cockpit:    https://<IP>:9090                              ║
   ║  Landing:    http://<IP>                                    ║
   ║  Логин:      rusnas / <password>                            ║
   ║                                                              ║
   ║  Лицензия:   Demo (все функции активны)                     ║
   ║  Serial:     RUSNAS-DEMO-INTE-RNAL-ONLY                     ║
   ╚══════════════════════════════════════════════════════════════╝
   ```

---

## 5. build-deb.sh

Скрипт сборки .deb пакета. Запускается на Mac (dev-машине).

### Зависимости на Mac:
- `npm install -g terser` (JS minification)
- `dpkg-deb` (через `brew install dpkg`)
- `python3` (для compileall)

### Логика:
1. Очистить `pkg/usr/share/cockpit/rusnas/`
2. JS: `terser *.js → *.min.js` в `pkg/usr/share/cockpit/rusnas/js/`
3. HTML: `sed 's/.js"/.min.js"/g'` → `pkg/usr/share/cockpit/rusnas/`
4. CSS: copy as-is
5. manifest.json: copy, rewrite JS refs to .min.js
6. Python scripts: copy as-is (protection — production задача)
7. Catalog: copy as-is (JSON, не требует защиты)
8. Backend daemons: copy all .py files to target dirs
9. Config files: copy defaults
10. Systemd units: copy all .service и .timer
11. Branding: copy branding.css
12. Guard config: copy config.json + ransom_extensions.txt
13. Sudoers: generate consolidated /etc/sudoers.d/rusnas
14. Update DEBIAN/control version
15. `dpkg-deb --build pkg/ rusnas-system_VERSION-demo_amd64.deb`

---

## 6. DEBIAN/control

```
Package: rusnas-system
Version: 1.0.0-demo
Architecture: amd64
Maintainer: rusNAS <support@rusnas.ru>
Depends: cockpit (>= 300), python3 (>= 3.11), samba, nfs-kernel-server,
 mdadm, btrfs-progs, smartmontools, targetcli-fb, hdparm, nginx
Recommends: podman, podman-compose, nut, vsftpd, apache2, lvm2,
 thin-provisioning-tools, certbot, nmap
Description: rusNAS NAS Management System (Demo)
 Enterprise-grade NAS management platform. Cockpit-based web UI with
 RAID management, Btrfs snapshots, ransomware protection (Guard),
 deduplication, UPS monitoring, container apps, and more.
```

---

## 7. DEBIAN/postinst

```bash
#!/bin/bash
set -e

# Create directories
mkdir -p /var/lib/rusnas /var/log/rusnas /var/log/rusnas-guard /run/rusnas
mkdir -p /etc/rusnas /etc/rusnas-guard /etc/rusnas/containers /etc/rusnas/certs
mkdir -p /var/lib/rusnas-containers/compose /etc/nginx/conf.d/rusnas-apps
mkdir -p /var/www/rusnas-landing

# Permissions
chmod 755 /etc/rusnas-guard
chmod 755 /var/lib/rusnas
chmod 755 /var/log/rusnas-guard

# Guard daemon symlink
ln -sf /usr/lib/rusnas-guard/guard.py /usr/local/sbin/rusnas-guard

# Executable permissions
chmod 755 /usr/lib/rusnas-guard/guard.py
chmod 755 /usr/local/bin/rusnas-snap 2>/dev/null || true
chmod 755 /usr/local/bin/rusnas-dedup-run.sh 2>/dev/null || true
chmod 755 /usr/local/bin/rusnas-worm 2>/dev/null || true
chmod 755 /usr/local/bin/rusnas-ups-notify 2>/dev/null || true

# Config defaults (don't overwrite existing)
[ -f /etc/rusnas/spindown.json ] || echo '{"version":1,"arrays":{}}' > /etc/rusnas/spindown.json
[ -f /etc/rusnas/dedup-config.json ] || echo '{"volumes":[],"schedule_enabled":false}' > /etc/rusnas/dedup-config.json
[ -f /etc/rusnas/ssd-tiers.json ] || echo '{"tiers":[]}' > /etc/rusnas/ssd-tiers.json
[ -f /etc/rusnas/worm.json ] || echo '{"paths":[]}' > /etc/rusnas/worm.json
[ -f /etc/rusnas/containers/installed.json ] || echo '{}' > /etc/rusnas/containers/installed.json

# Touch state files
touch /var/lib/rusnas/perf-history.json
chmod 666 /var/lib/rusnas/perf-history.json

# Reload systemd
systemctl daemon-reload

# Enable core services (but don't start — demo-install.sh handles that)
systemctl enable cockpit.socket 2>/dev/null || true
systemctl enable rusnas-guard 2>/dev/null || true
systemctl enable rusnas-snapd.timer 2>/dev/null || true
systemctl enable rusnas-metrics 2>/dev/null || true

exit 0
```

---

## 8. DEBIAN/prerm

```bash
#!/bin/bash
set -e
for svc in rusnas-guard rusnas-metrics rusnas-perf-collector rusnas-spind; do
    systemctl stop "$svc" 2>/dev/null || true
done
for tmr in rusnas-snapd.timer rusnas-sectest.timer rusnas-storage-collector.timer rusnas-worm.timer rusnas-certcheck.timer; do
    systemctl stop "$tmr" 2>/dev/null || true
done
exit 0
```

---

## 9. Demo License (bypass)

Для демо-релиза лицензия предустановлена. Файл `/etc/rusnas/license.json`:

```json
{
  "ver": 1,
  "type": "demo",
  "serial": "RUSNAS-DEMO-INTE-RNAL-ONLY",
  "license_type": "enterprise",
  "customer": "Internal Demo",
  "expires_at": null,
  "features": {
    "core": true,
    "guard": true,
    "snapshots": true,
    "ssd_tier": true,
    "storage_analyzer": true,
    "dedup": true,
    "updates_security": true,
    "updates_features": true,
    "ha_cluster": true,
    "fleet_mgmt": true
  },
  "max_volumes": 16
}
```

`license.js` проверяет наличие этого файла и показывает статус "Demo (Enterprise)".

---

## 10. Landing page

Копируется из `landing/index.html` → `/var/www/rusnas-landing/index.html` через demo-install.sh. nginx обслуживает на порту 80.

---

## 11. Deliverables

После сборки пользователь получает 2 файла:

```
rusnas-demo-1.0.0/
├── rusnas-system_1.0.0-demo_amd64.deb   (~5-10 MB)
└── demo-install.sh                       (~5 KB)
```

Установка на чистый Debian 13:
```bash
# Скопировать файлы на машину любым способом (scp, USB, etc.)
sudo bash demo-install.sh
```

Одна команда. Всё остальное автоматически.

---

## 12. Out of Scope

- Сервер лицензирования (VPS, activate.rusnas.ru)
- apt-репозиторий (reprepro)
- GPG-подпись пакета
- Online updates
- Python обфускация (production задача, pyarmor/nuitka)
- Multi-architecture (только amd64)
- FileBrowser binary (скачивается demo-install.sh если есть интернет)
- Pentest tools (nuclei, ffuf — скачиваются если есть интернет)
