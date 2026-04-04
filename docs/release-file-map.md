# rusNAS Release — File Map

Карта всех файлов rusNAS, устанавливаемых на целевой системе через `rusnas-system_*.deb` + `demo-install.sh`.

---

## Защита исходного кода

| Тип файлов | Метод защиты | Результат |
|-----------|-------------|-----------|
| **JavaScript** (15 файлов) | terser minification | Одна строка, переменные сокращены, нечитаемо |
| **Vendor JS** (Chart.js, 2 файла) | Уже минифицированы | Копируются as-is |
| **Python** (39 файлов) | AST strip (tools/pystrip.py) | Удалены все docstrings, комментарии, форматирование |
| **HTML / CSS** | Без обфускации | As-is (не содержат бизнес-логики) |
| **JSON / YAML** | Без обфускации | Конфигурация, не код |

**Для production-релиза:** планируется pyarmor (полная обфускация Python с шифрованием байткода). Требует сборку на Linux.

---

## Cockpit plugin — `/usr/share/cockpit/rusnas/`

Веб-интерфейс управления. Загружается Cockpit при открытии страницы.

```
/usr/share/cockpit/rusnas/
├── manifest.json                    # Регистрация плагина в Cockpit
├── *.html (14 файлов)               # Страницы UI
│   ├── dashboard.html               #   Dashboard (метрики, Night Report)
│   ├── index.html                   #   Хранилище (SMB/NFS, iSCSI, WORM, FTP/WebDAV)
│   ├── disks.html                   #   Диски и RAID
│   ├── users.html                   #   Пользователи и группы
│   ├── guard.html                   #   Guard (антишифровальщик)
│   ├── snapshots.html               #   Снапшоты Btrfs
│   ├── dedup.html                   #   Дедупликация
│   ├── ups.html                     #   ИБП (NUT)
│   ├── storage-analyzer.html        #   Анализатор пространства
│   ├── network.html                 #   Сеть и сертификаты
│   ├── ai.html                      #   AI Ассистент
│   ├── performance.html             #   Performance Tuner
│   ├── license.html                 #   Лицензия
│   └── containers.html              #   Приложения (контейнеры)
├── js/                              # JavaScript (минифицировано)
│   ├── dashboard.min.js             #   → dashboard.js
│   ├── app.min.js                   #   → app.js (Storage page)
│   ├── disks.min.js                 #   → disks.js
│   ├── users.min.js                 #   → users.js
│   ├── guard.min.js                 #   → guard.js
│   ├── snapshots.min.js             #   → snapshots.js
│   ├── dedup.min.js                 #   → dedup.js
│   ├── ups.min.js                   #   → ups.js
│   ├── storage-analyzer.min.js      #   → storage-analyzer.js
│   ├── network.min.js               #   → network.js
│   ├── ai.min.js                    #   → ai.js
│   ├── performance.min.js           #   → performance.js
│   ├── license.min.js               #   → license.js
│   ├── containers.min.js            #   → containers.js
│   ├── eye.min.js                   #   → eye.js (утилиты)
│   ├── chart.umd.min.js             #   Chart.js 4.x (vendor)
│   └── chartjs-adapter-date-fns.bundle.min.js  # date-fns adapter (vendor)
├── css/                             # Стили
│   ├── style.css                    #   Основные стили
│   ├── dashboard.css                #   Dashboard + Night Report
│   ├── eye.css                      #   Sidebar navigation
│   ├── network.css                  #   Network page
│   ├── storage-analyzer.css         #   Storage Analyzer
│   ├── ai.css                       #   AI page
│   └── containers.css               #   Container Manager
├── scripts/                         # Python backend (stripped)
│   ├── perf-collector.py            #   Сбор метрик производительности
│   ├── storage-collector.py         #   Сбор статистики дисков
│   ├── storage-analyzer-api.py      #   API анализатора (7 commands)
│   ├── network-api.py               #   API сети
│   ├── certs-api.py                 #   API сертификатов
│   ├── domain-api.py                #   API домена (AD/LDAP)
│   ├── mcp-api.py                   #   AI API proxy
│   ├── fb-init.sh                   #   FileBrowser init
│   ├── fb-sync-user.py              #   FileBrowser user sync
│   └── fb-sync-all-users.py         #   FileBrowser batch sync
├── cgi/                             # CGI-скрипты (stripped)
│   ├── container_api.py             #   Container Manager backend (16 commands)
│   ├── spindown_ctl.py              #   Spindown CGI (5 commands)
│   ├── fb-users-list.py             #   FileBrowser users list
│   └── fb-set-user-access.py        #   FileBrowser access control
├── catalog/                         # Каталог контейнерных приложений
│   ├── index.json                   #   Индекс (10 apps)
│   ├── nextcloud/                   #   Nextcloud (rusnas-app.json + docker-compose.yml)
│   ├── immich/                      #   Immich (фото)
│   ├── jellyfin/                    #   Jellyfin (медиа)
│   ├── vaultwarden/                 #   Vaultwarden (пароли)
│   ├── home-assistant/              #   Home Assistant (IoT)
│   ├── pihole/                      #   Pi-hole (DNS)
│   ├── wireguard/                   #   WireGuard (VPN)
│   ├── mailcow/                     #   Mailcow (почта)
│   ├── onlyoffice/                  #   OnlyOffice (документы)
│   └── rocketchat/                  #   Rocket.Chat (мессенджер)
└── assets/                          # Иконки
    ├── favicon.svg                  #   Favicon (NAS drive bay icon)
    └── logo.svg                     #   Логотип rusNAS
```

---

## Backend daemons

### Guard — `/usr/lib/rusnas-guard/` (stripped)

Антишифровальщик: inotify мониторинг + entropy анализ + honeypot ловушки.

```
/usr/lib/rusnas-guard/
├── guard.py            # Main daemon (socket server + lifecycle)
├── detector.py         # inotify watcher + detection logic
├── entropy.py          # Shannon entropy computation
├── honeypot.py         # Bait file management
├── response.py         # Blocking, snapshots, notifications
└── socket_server.py    # Unix socket API
```

Symlink: `/usr/local/sbin/rusnas-guard` → `guard.py`

### Spindown — `/usr/lib/rusnas/spind/` (stripped)

HDD spindown для backup-массивов (dm-cache aware).

```
/usr/lib/rusnas/spind/
├── spind.py            # Main daemon
├── controller.py       # Spindown/wakeup state machine
├── monitor.py          # I/O activity monitor
├── state_writer.py     # JSON state output
├── btrfs_helper.py     # Btrfs flush helper
└── mdadm_helper.py     # mdadm array helper
```

### CGI backend — `/usr/lib/rusnas/cgi/` (stripped)

```
/usr/lib/rusnas/cgi/
├── container_api.py    # 16 commands (install/uninstall/start/stop/logs/...)
└── spindown_ctl.py     # 5 commands (get_state/set_config/wake_up/...)
```

### Security Self-Test — `/usr/lib/rusnas/sectest/` (stripped)

```
/usr/lib/rusnas/sectest/
├── sectest.py                  # Orchestrator (9 phases, OWASP Top 10)
├── checks/
│   ├── __init__.py
│   ├── recon.py                # Phase 1: Reconnaissance
│   ├── web_headers.py          # Phase 2: HTTP security headers
│   ├── auth.py                 # Phase 3: Authentication testing
│   ├── injection.py            # Phase 4: SQL/command injection
│   ├── access_control.py       # Phase 5: Access control
│   ├── misconfig.py            # Phase 6: Security misconfig
│   ├── vuln_scan.py            # Phase 7: Vulnerability scan
│   ├── endpoint_fuzz.py        # Phase 8: Endpoint fuzzing
│   └── network_services.py     # Phase 9: Network services
└── wordlists/
    └── rusnas-paths.txt        # Path wordlist for fuzzing
```

### Metrics — `/usr/local/lib/rusnas/` (stripped)

```
/usr/local/lib/rusnas/
└── metrics_server.py    # Prometheus + JSON HTTP endpoint (:9100)
```

---

## CLI tools — `/usr/local/bin/`

```
/usr/local/bin/
├── rusnas-snap              # Btrfs snapshot CLI (Python)
├── rusnas-worm              # WORM enforcement CLI (Python, stripped)
├── rusnas-dedup-run.sh      # Dedup wrapper (bash)
└── rusnas-ups-notify        # UPS notification script (bash)
```

---

## Configuration — `/etc/`

```
/etc/
├── rusnas/
│   ├── serial               # Serial number (RUSNAS-DEMO-INTE-RNAL-ONLY)
│   ├── license.json          # License data (demo: Enterprise, all features)
│   ├── spindown.json         # Spindown config (per-array)
│   ├── dedup-config.json     # Dedup config (volumes, schedule)
│   ├── ssd-tiers.json        # SSD cache tiers
│   ├── worm.json             # WORM paths
│   └── containers/
│       └── installed.json    # Installed container apps state
├── rusnas-guard/
│   ├── config.json           # Guard detection config (conffile — preserved on upgrade)
│   └── ransom_extensions.txt # ~200 known ransomware extensions (conffile)
├── sudoers.d/
│   └── rusnas               # Consolidated NOPASSWD rules (~80 rules)
├── cockpit/
│   └── cockpit.conf          # Cockpit config (AllowUnencrypted, LoginTitle)
└── apt/apt.conf.d/
    └── 99rusnas-snapshot     # Pre-upgrade auto-snapshot hook
```

---

## Systemd units — `/lib/systemd/system/`

### Services (10)
| Service | Type | Description |
|---------|------|-------------|
| `rusnas-guard.service` | simple | Guard anti-ransomware daemon |
| `rusnas-spind.service` | simple | HDD spindown daemon |
| `rusnas-metrics.service` | simple | Prometheus metrics server (:9100) |
| `rusnas-perf-collector.service` | simple | Performance metrics collector (10s interval) |
| `rusnas-dedup.service` | oneshot | Dedup run (duperemove) |
| `rusnas-snapd.service` | oneshot | Scheduled snapshot execution |
| `rusnas-sectest.service` | oneshot | Security self-test run |
| `rusnas-worm.service` | oneshot | WORM enforcement check |
| `rusnas-storage-collector.service` | oneshot | Storage metrics collection |
| `rusnas-certcheck.service` | oneshot | Certificate expiry check |

### Timers (5)
| Timer | Schedule | Triggers |
|-------|----------|----------|
| `rusnas-snapd.timer` | Every 5 min | rusnas-snapd.service |
| `rusnas-storage-collector.timer` | Hourly | rusnas-storage-collector.service |
| `rusnas-sectest.timer` | Monthly (1st, 04:00) | rusnas-sectest.service |
| `rusnas-worm.timer` | Daily | rusnas-worm.service |
| `rusnas-certcheck.timer` | Daily | rusnas-certcheck.service |

---

## Web content

### Landing page — `/var/www/rusnas-landing/`

```
/var/www/rusnas-landing/
├── index.html          # Marketing landing page (fully offline, no CDN)
├── favicon.svg         # NAS drive bay icon
└── fonts/
    ├── manrope-400.ttf # Regular
    ├── manrope-500.ttf # Medium
    ├── manrope-600.ttf # SemiBold
    ├── manrope-700.ttf # Bold
    └── manrope-800.ttf # ExtraBold
```

### User documentation — `/usr/share/rusnas-help/`

MkDocs Material static site. 32 страницы, 36 скриншотов, тёмная тема, поиск.

Доступна по: `http://<IP>/help/`

### Cockpit branding — `/usr/share/cockpit/branding/debian/`

```
/usr/share/cockpit/branding/debian/
├── branding.css        # Login page styling (rusNAS theme)
└── brand.js            # Branding JavaScript
```

---

## nginx routing

| URL | Backend |
|-----|---------|
| `http://<IP>/` | Landing page (`/var/www/rusnas-landing/`) |
| `http://<IP>/help/` | User docs (`/usr/share/rusnas-help/`) |
| `http://<IP>/cockpit/` | Cockpit reverse proxy (`https://127.0.0.1:9090`) |
| `https://<IP>:9090/` | Cockpit direct (self-signed SSL) |
| `http://<IP>:8091/` | Apache WebDAV |
| `http://<IP>/apps/*` | Container apps (nginx conf.d/rusnas-apps/) |
