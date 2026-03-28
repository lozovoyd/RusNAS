# CLAUDE.md

> См. также: [project_history.md](./project_history.md) — хронология всех сессий
> ⚠️ **UI правила и компоненты: [ui.md](./ui.md) — ОБЯЗАТЕЛЬНО читать перед любой работой с UI/CSS/branding (Cockpit Shell, страницы плагина, дизайн-токены, Ghost Pill nav, брендинг)**
> Антишифровальщик: [rusnas-guard-task.md](./rusnas-guard-task.md) — ТЗ и архитектура Guard
> RAID Manager: [rusnas-RAIDmanager.md](./rusnas-RAIDmanager.md) — ТЗ и архитектура RAID Manager
> Дедупликация: [rusnas-dedup-spec.md](./rusnas-dedup-spec.md) — ТЗ и архитектура Dedup
> ИБП / UPS: [rusnas-ups-nut_spec.md](./rusnas-ups-nut_spec.md) — ТЗ и архитектура UPS/NUT
> Storage Analyzer: [rusnas-storage-analyzer-task.md](./rusnas-storage-analyzer-task.md) — ТЗ и архитектура Анализатора пространства
> Storage Page (редизайн): [rusnas-storage-task.md](./rusnas-storage-task.md) — ТЗ и заметки по реализации редизайна страницы Хранилище
> SSD-кеширование: [rusnas-ssd-tier-task.md](./rusnas-ssd-tier-task.md) — ТЗ и архитектура SSD-кеша (dm-cache/LVM)
> MCP Server + AI Agent: [rusnas_mcp_ai.MD](./rusnas_mcp_ai.MD) — ТЗ + реализация Session 1 (2026-03-22/23)
> Управление сетью: [rusnas-network-task.md](./rusnas-network-task.md) — ТЗ и архитектура Network-модуля
> FileBrowser: [rusnas-filebrowser-task.md](./rusnas-filebrowser-task.md) — ТЗ и архитектура
> Roadmap: [roadmap.md](./roadmap.md) — детальные заметки по всем реализованным фичам
> Git Workflow: [git-workflow.md](./git-workflow.md) — правила веток, коммитов, merge
> История багов: [bugs.MD](./bugs.MD) — полная история всех багов и фиксов (BUG-01..30)
> Performance Tuner: [rusnas-performance-tuning-spec.md](./rusnas-performance-tuning-spec.md) — ТЗ авто-оптимизатора (12 уровней)
> Btrfs проблемы: [btrfs-problems.md](./btrfs-problems.md) — 15 известных проблем Btrfs+mdadm с решениями

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> ⚠️ **project_history.MD — только ДОПОЛНЯТЬ, никогда не перезаписывать целиком!**
> Всегда добавлять новую сессию в конец файла. Существующие записи не трогать.

Always write all changes on project in project_history.md and other files with techical specifications in header
Always update information in claud.md after deploy features, bugfixes, and new code
Always use MCP services what available

## Правила обновления внешних файлов

CLAUDE.md — оперативная шпаргалка. Детальный контент хранится в отдельных файлах. Правила:

| Файл | Когда обновлять |
|------|----------------|
| `project_history.md` | После каждой сессии — APPEND в конец, никогда не перезаписывать |
| `bugs.md` | При каждом новом баге/фиксе — добавить секцию BUG-NN. В CLAUDE.md Known Bugs — только активные "ловушки" (паттерны которые Claude может повторить) |
| `roadmap.md` | При завершении фичи (✅) или добавлении новой задачи. В CLAUDE.md — только таблица статусов |
| `git-workflow.md` | При изменении стратегии веток или правил коммитов. В CLAUDE.md — только текущая ветка + 2 строки |
| `rusnas-*-task.md` | При добавлении нового модуля или изменении архитектуры модуля — подробности туда, в CLAUDE.md — только "Critical notes" секция |
| `ui.md` | При изменении дизайн-системы, добавлении новых CSS-компонентов |

**Принцип:** Если секция в CLAUDE.md > 2,000 символов — подумать, можно ли её вынести. CLAUDE.md должен оставаться < 40,000 символов.

## ⚠️ Обязательное обновление MD-файлов после merge в main

**После каждого merge в ветку `main` — обязательно обновить:**

| Файл | Что записать |
|------|-------------|
| `project_history.md` | Новая сессия (APPEND в конец). Что сделано, какие файлы изменены, ключевые архитектурные находки |
| `CLAUDE.md` | Known Bugs — новые ловушки. Distribution/Git Workflow — если изменились. Roadmap таблица — обновить статусы |
| `ui.md` | Если изменялись CSS-компоненты, дизайн-токены, branding.css, паттерны навигации |
| `bugs.md` | Каждый новый баг → секция BUG-NN с описанием, симптомами, фиксом |
| `roadmap.md` | При завершении фичи (✅) или добавлении новой задачи (📋) |
| `rusnas-*-task.md` | При изменении архитектуры модуля |

**Правило:** Не спрашивать пользователя — просто обновить файлы. Если изменения были, запись должна быть сделана.



## Project Overview

**RusNAS** is a commercial NAS platform alternative to Synology DSM, targeting SMB customers at scale (1000+ devices). It replicates the functionality of a Synology RS1619xs+ using open-source Linux components on Debian 13 Trixie.

**Key architectural decision:** Btrfs + mdadm instead of ZFS — ZFS does not support online RAID level migration, which is a hard business requirement.

## Technical Stack

| Layer | Component |
|-------|-----------|
| OS | Debian 13 Trixie |
| RAID | mdadm (Basic, JBOD, RAID 0/1/5/6/10, RAID F1) |
| Filesystem | Btrfs (native snapshots, online resize) |
| SMB | Samba |
| NFS | knfsd + mountd fixed to port 20048 |
| FTP | vsftpd (passive ports 30000–30100) |
| WebDAV | Apache with digest authentication |
| iSCSI | targetcli-fb (LIO) |
| UPS | NUT (Network UPS Tools) 2.8.1 — nut-server + nut-client |
| Web UI | Cockpit + custom `rusnas` plugin |
| Updates | Custom deb repository (reprepro + nginx), devices pull via `apt upgrade` |
| Provisioning | Ansible monorepo, component-based roles |
| Firewall | nftables |

## Development Environment

- **Host:** Intel Mac with UTM (QEMU hypervisor)
- **VM:** Debian 13 Trixie, x86_64 — 1 system disk + multiple data disks for RAID testing
- **VM address:** 10.10.10.72, user: `rusnas` (root SSH disabled)
- **File transfer:** `scp` (long commands get truncated when pasted in terminal — create a file locally and `scp` to VM)

## Deploy / Update Workflow

The project source lives locally in `/Users/dvl92/projects/RusNAS/cockpit/` and is deployed to the VM with:

```bash
# Deploy all plugin files at once
scp -r cockpit/rusnas/* rusnas@10.10.10.72:/tmp/rusnas-plugin/
ssh rusnas@10.10.10.72 "sudo cp -r /tmp/rusnas-plugin/* /usr/share/cockpit/rusnas/"
```

Or use the deploy script:
```bash
./deploy.sh
```

Cockpit auto-reloads plugins on page refresh — no service restart needed after file changes.

**After every deploy:** verify the page loads correctly in the browser. Files must have `644` permissions and directories `755` — `scp` copies files with local permissions (often `600`), which makes them unreadable by Cockpit. The deploy script handles this automatically.

## Project Structure

```
RusNAS/
├── cockpit/
│   └── rusnas/                  # Cockpit plugin source (12 pages)
│       ├── manifest.json
│       ├── dashboard.html        # Dashboard 🏠 — метрики, Guard/RAID/Disk статус, Night Report
│       ├── index.html            # Хранилище — SMB/NFS шары + iSCSI + WORM + FTP/WebDAV
│       ├── disks.html            # Диски и RAID — массивы, SMART, SSD-кеш
│       ├── users.html            # Пользователи и группы
│       ├── guard.html            # Guard 🛡️ — антишифровальщик
│       ├── snapshots.html        # Снапшоты 📸 — Btrfs snapshots + репликация
│       ├── dedup.html            # Дедупликация — duperemove + reflinks
│       ├── ups.html              # ИБП 🔋 — NUT / Network UPS Tools
│       ├── storage-analyzer.html # Анализ 💾 — анализатор дискового пространства
│       ├── network.html          # Сеть 🌐 — сетевые интерфейсы, сертификаты, домен
│       ├── ai.html               # AI Ассистент 🤖 — MCP + Yandex GPT / Anthropic
│       ├── performance.html      # Performance ⚡ — авто-оптимизатор (12 уровней)
│       ├── css/
│       │   ├── style.css         # Основные стили плагина
│       │   └── dashboard.css     # Стили дашборда + Night Report (.nr-*)
│       └── js/
│           ├── app.js            # Storage: SMB, NFS, iSCSI, WORM, FTP, WebDAV
│           ├── dashboard.js      # Dashboard: метрики, Night Report, Guard/RAID/Disk/UPS карточки
│           ├── disks.js          # Disks: RAID lifecycle, SMART, SSD-кеш (dm-cache)
│           ├── users.js          # Users/Groups CRUD
│           ├── guard.js          # Guard: socket client, события, настройки
│           ├── snapshots.js      # Snapshots: list/create/delete, schedules, replication
│           ├── dedup.js          # Dedup: duperemove запуск, статистика, расписание
│           ├── ups.js            # UPS: NUT статус, конфиг, авто-shutdown
│           ├── storage-analyzer.js # Storage Analyzer: treemap, charts, forecast
│           ├── network.js        # Network: интерфейсы, bonding, VLAN, certbot, DDNS
│           ├── ai.js             # AI: MCP proxy → Yandex GPT 5 Pro / Anthropic Claude
│           ├── performance.js    # Performance Tuner: 12 уровней оптимизации
│           ├── eye.js            # Eye: вспомогательные утилиты (escHtml, fmtBytes...)
│           └── scripts/          # Backend Python-скрипты
│               ├── mcp-api.py    # AI API proxy (CORS fix, multi-provider)
│               ├── storage-collector.py  # Hourly storage metrics collector
│               └── storage-analyzer-api.py  # Storage Analyzer API (7 commands)
├── rusnas-guard/                 # Guard daemon source
│   ├── daemon/
│   │   ├── guard.py              # Main daemon entry point
│   │   ├── detector.py           # inotify watcher + detection logic
│   │   ├── entropy.py            # Shannon entropy computation
│   │   ├── honeypot.py           # Bait file management
│   │   ├── response.py           # Blocking, snapshots, notifications
│   │   └── socket_server.py      # Unix socket server
│   ├── config/
│   │   ├── config.json           # Default configuration
│   │   └── ransom_extensions.txt # ~200 known ransomware extensions
│   └── service/
│       └── rusnas-guard.service  # systemd unit
├── ansible/                      # Ansible monorepo (provisioning)
│   └── roles/
│       ├── base/           # Base system configuration
│       ├── mdadm/          # RAID arrays
│       ├── btrfs/          # Filesystem
│       ├── samba/          # SMB
│       ├── nfs/            # NFS
│       ├── ftp/            # vsftpd
│       ├── webdav/         # Apache WebDAV
│       ├── rsync/          # rsync daemon
│       ├── iscsi/          # targetcli / LIO
│       ├── cockpit/        # Cockpit + rusnas plugin
│       ├── firewall/       # nftables
│       └── notifications/  # email + Telegram
├── landing/                      # rusNAS landing page (Apache, port 80)
│   ├── index.html                # Main landing page — self-contained CSS/JS
│   └── apache/
│       └── rusnas-landing.conf   # Apache VirtualHost config
├── rusnas-dedup/
│   ├── rusnas-dedup-run.sh       # Wrapper script: duperemove + state JSON
│   └── rusnas-dedup.service      # systemd oneshot service
├── rusnas-metrics/
│   ├── metrics_server.py         # Prometheus + JSON metrics HTTP server (port 9100)
│   └── rusnas-metrics.service    # systemd unit
├── btrfs-problems.md             # Известные проблемы Btrfs+mdadm (15 разделов)
├── deploy.sh                     # Deploy Cockpit plugin to VM
├── deploy-landing.sh             # Deploy landing page to Apache on VM
├── install-guard.sh              # Deploy Guard daemon to VM
├── install-snapshots.sh          # Deploy snapshot system to VM
├── install-dedup.sh              # Deploy Dedup backend to VM
├── install-filebrowser.sh        # Deploy FileBrowser + Apache proxy to VM
├── install-mcp.sh                # Deploy MCP API proxy to VM
├── install-network.sh            # Deploy Network module backend to VM
├── install-ssd-tier.sh           # Deploy SSD caching (dm-cache) to VM
├── install-storage-analyzer.sh   # Deploy Storage Analyzer backend to VM
├── install-ups.sh                # Deploy NUT (UPS) to VM
├── install-worm.sh               # Deploy WORM backend to VM
├── rusnas-metrics-install.sh     # Deploy Metrics Server to VM
└── CLAUDE.md
```

## rusNAS Guard (Антишифровальщик)

Daemon-based ransomware protection. See [rusnas-guard-task.md](./rusnas-guard-task.md) for full spec.

**Deploy daemon to VM:**
```bash
./install-guard.sh
```

**Key architecture notes:**
- Daemon on VM: `/usr/lib/rusnas-guard/` — Python 3, systemd service `rusnas-guard`
- Config dir: `/etc/rusnas-guard/` — must be **chmod 755** (not 700) so Cockpit bridge can read `ransom_extensions.txt`
- Events log: `/var/log/rusnas-guard/events.jsonl`
- Socket: `/run/rusnas-guard/control.sock` — permissions **0o666** (world-accessible); Cockpit bridge connects as non-root without `superuser: "require"`
- `RuntimeDirectory=rusnas-guard` in systemd unit creates `/run/rusnas-guard/` on start; `RuntimeDirectoryMode=0755` makes it traversable
- Guard PIN stored as bcrypt hash at `/etc/rusnas-guard/guard.pin` — independent of Cockpit admin password
- **Daemon lifecycle:** the systemd service runs continuously; `Start/Stop` buttons in UI control the **Detector thread** only, not the process. This allows the socket server to always be reachable.
- Post-attack flag: `/etc/rusnas-guard/post_attack` — forces Monitor mode on next start
- PIN reset requires root/SSH access (security model: Cockpit admin password must NOT grant PIN reset)

**PIN reset (если забыт):**
```bash
sudo rusnas-guard --reset-pin
# Symlink: /usr/local/sbin/rusnas-guard → /usr/lib/rusnas-guard/guard.py
# После сброса — Guard покажет диалог установки нового PIN
```

PIN-диалог в UI показывает подсказку с этой командой.

**Critical guard.js notes:**
- Socket channel: `cockpit.channel({ payload: "stream", unix: SOCK_PATH })` — NO `superuser: "require"` (causes timeout in iframe context)
- `requirePin()` always shows PIN modal even when a session token is already active — this is intentional for sensitive operations
- Dashboard stats come from `guardCmd("status")` polled every 5 seconds, NOT from `cockpit.file(state.json).watch()`
- Extensions file read: `cockpit.file(EXTS_PATH).read()` works without superuser because `/etc/rusnas-guard/` is `755` and the file is `644`
- `detection.hide_smb_baits`: toggle in Guard → Настройки; `_apply_smb_hide(enabled)` in `guard.py` writes `hide files = /!~rng_*/` to `[global]` in smb.conf atomically, calls `systemctl reload smbd`; applied on daemon start + on config change

## rusNAS Snapshots (Btrfs Snapshot Manager)

Btrfs snapshot system: CLI + systemd timer + Cockpit UI + apt hook.

**Deploy to VM:**
```bash
./install-snapshots.sh [--setup-btrfs]   # --setup-btrfs creates loop image for testing
```

**Key architecture notes:**
- CLI: `/usr/local/bin/rusnas-snap` — Python 3, all output as JSON to stdout, log to stderr
- DB: `/var/lib/rusnas/snaps.db` — SQLite WAL, tables: `snapshots`, `schedules`, `events`
- Timer: `rusnas-snapd.timer` (every 5 min) → `rusnas-snap scheduled-run`
- Apt hook: `/etc/apt/apt.conf.d/99rusnas-snapshot` — `pre-update-all` before `apt upgrade`
- Snapshot layout: `/mnt/btrfspool/.snapshots/shares__public/@2026-03-14_03-03-40_manual`
- Sudoers: `rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-snap`
- Btrfs on test VM: loop image at `/var/lib/rusnas/btrfs-pool.img` mounted at `/mnt/btrfspool`

**Critical snapshots.js notes:**
- `schedule list` / `events` do NOT accept `--json` flag (always output JSON) — omit it
- `cockpit.spawn` uses `err: "message"` to keep stderr separate from JSON stdout
- `loadSubvols()` uses `schedule list` paths directly — skips `findBtrfsSubvols()` (bash not in sudoers NOPASSWD)
- `safeJson()` does `JSON.parse(str)` directly on clean stdout
- `replication list` returns `{tasks:[...], ok:true}` — parse as `data.tasks`
- Replication tab: infographic HTML is STATIC (before `#replication-content`); no JS rendering for it

**Replication architecture (реализовано 2026-03-23):**
- CLI: `rusnas-snap replication set/list/delete/run/check-ssh` (DB table: `replication_tasks`)
- Transport: `btrfs send [-p <parent>] | ssh user@host btrfs receive /path`
- First run: full transfer; subsequent: incremental (`-p <last_sent_snap>`)
- Scheduled via `rusnas-snapd.service` second `ExecStart=/usr/local/bin/rusnas-snap replication run-all`
- SSH keys must be pre-configured by admin; UI only takes host/user/path

## rusNAS Дедупликация (Dedup Manager)

Btrfs deduplication via duperemove + reflinks + SMB vfs_btrfs. See [rusnas-dedup-spec.md](./rusnas-dedup-spec.md) for full spec.

**Deploy backend to VM:**
```bash
./install-dedup.sh
```

**Key architecture notes:**
- Config: `/etc/rusnas/dedup-config.json` — `volumes`, `duperemove_args`, `schedule_enabled`, `schedule_cron`
- Run script: `/usr/local/bin/rusnas-dedup-run.sh` — wraps duperemove, writes state JSON
- State: `/var/lib/rusnas/dedup-last.json` — last run result (chmod 644, readable by Cockpit)
- History: `/var/lib/rusnas/dedup-history.json` — last 7 days (date + saved_bytes)
- Service: `rusnas-dedup.service` — Type=oneshot, Nice=19, IOSchedulingClass=idle
- Schedule: `/etc/cron.d/rusnas-dedup` — managed by Cockpit UI
- Log: `/var/log/rusnas/dedup.log`
- Sudoers: included in `install-dedup.sh` — allows `systemctl start/stop rusnas-dedup.service`, `tee /etc/rusnas/dedup-config.json`, `tee /etc/cron.d/rusnas-dedup`, `rm /etc/cron.d/rusnas-dedup`
- duperemove version on Debian 13: **v0.11.2** — does NOT support `--min-size` or `--hash` (added in v0.12+)
- Savings metric: `btrfs filesystem du -s $VOL | tail -1 | awk '{print $3}'` — total shared extents (includes reflinks + snapshots + duperemove)

**Critical dedup.js notes:**
- `writeConfig()`: uses `cockpit.file(DEDUP_CONFIG, {superuser:"require"}).replace(...)` — never `echo | sudo tee`
- `saveSchedule()`: writes `/etc/cron.d/rusnas-dedup` via `cockpit.file().replace()`, deletes via `cockpit.spawn(["rm", "-f", ...])`
- `loadSambaShares()`: writes Python script to `/tmp/rusnas_parse_smb.py` then executes — `configparser` fails on smb.conf inline comments
- Polling: `checkRunning()` every 5s, calls `setRunningState(false)` + 800ms delay + `loadLastRun()` when service goes inactive
- `systemctl start` for oneshot service blocks until completion — `.done()` fires AFTER run finishes
- `setRunningState(false)` clears "Выполняется" to "—" immediately, then `loadLastRun()` fills real status

## rusNAS ИБП / UPS (NUT)

UPS management via Network UPS Tools. See [rusnas-ups-nut_spec.md](./rusnas-ups-nut_spec.md) for full spec.

**Deploy to VM:**
```bash
./install-ups.sh
```

**Key architecture notes:**
- Package: `nut` (Debian 13: nut 2.8.1) — includes nut-server, nut-client, nut-scanner
- Config files: `/etc/nut/` — `nut.conf`, `ups.conf`, `upsd.conf`, `upsd.users`, `upsmon.conf`
- All configs written via `cockpit.file().replace()` — never `sudo tee`
- Status polling: `upsc -j <name>@localhost` (JSON, NUT 2.8+); fallback: text mode (line parsing)
- Notify script: `/usr/local/bin/rusnas-ups-notify` — called by upsmon NOTIFYCMD
- Sudoers: `/etc/sudoers.d/rusnas-nut` — upsc, nut-scanner, systemctl nut.target, journalctl
- NUT password (upsd.users): `rusnas_nut_2026` (hardcoded template, changeable via UI)

**ups.status flags:**
- `OL` = on line (green), `OB` = on battery (yellow), `OB LB` = critical (red)
- `CHRG` = charging (blue), `RB` = replace battery (orange), `COMMLOST` = no comm (gray)

**Dashboard widget:** UPS карточка в grid-4 нижней секции, обновляется каждые 10 сек.

**Critical ups.js notes:**
- `superuser:"require"` НЕ используется в spawn — polkit timeout в iframe; sudoers покрывает
- `upsc -j` завершается с ошибкой если драйвер не запущен — `renderUpsNoDevice()` fallback
- Конфиги `/etc/nut/` пишутся через `cockpit.file(path, {superuser:"require"}).replace()`
- `restartNut()`: сначала пробует `nut.target`, при ошибке — `nut-server` (разные дистрибутивы)

## rusNAS Storage Analyzer (Анализатор пространства)

Disk space analysis tool. See [rusnas-storage-analyzer-task.md](./rusnas-storage-analyzer-task.md) for full spec.

**Deploy backend to VM:**
```bash
# Use scp + ssh directly (install-storage-analyzer.sh has quoting issues with eval)
sshpass -p 'kl4389qd' scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  rusnas-storage-analyzer/storage-collector.py rusnas-storage-analyzer/storage-analyzer-api.py \
  rusnas@10.10.10.72:/tmp/
```

**Key architecture notes:**
- Navigation: Dashboard Storage card → `storage-analyzer.html` (updated from `/rusnas/disks`)
- Backend collector: `/usr/share/cockpit/rusnas/scripts/storage-collector.py` — hourly systemd timer
- API script: `/usr/share/cockpit/rusnas/scripts/storage-analyzer-api.py` — 7 commands via argv
- DB: `/var/lib/rusnas/storage_history.db` — SQLite, 4 tables: volume_snapshots, share_snapshots, user_snapshots, file_type_snapshots
- Cache: `/var/lib/rusnas/storage_cache.json` — fast load, avoids re-scan on page open
- Sudoers: `/etc/sudoers.d/rusnas-storage` — NOPASSWD for both python3 scripts + du
- Timer: `rusnas-storage-collector.timer` (hourly, RandomizedDelaySec=300)
- API call pattern: `cockpit.spawn(['sudo', '-n', 'python3', SA_API, cmd, ...], { err: 'message', superuser: 'try' })`

**5 tabs:**
1. **Обзор** — cards (total/used/free/forecast), volume map, fill chart (SVG), top consumers
2. **Шары** — shares table with inline expand + sparkline + forecast
3. **Папки и файлы** — interactive treemap (squarified algo) + list view + filters
4. **Пользователи** — usage by UID 1000–60000 with quota display
5. **Типы файлов** — donut chart + table; click row → jumps to Files tab with type filter

**Forecast algorithm:** linear regression (least squares) over history points; `forecast_days(history_points, free_bytes)` in API script. Needs ≥2 scan points to show forecast.

**Critical storage-analyzer.js notes:**
- `saApi(args)` wraps cockpit.spawn in a Promise; streams stdout into `out` string, parses JSON on done
- `squarify()` + `squarifyRow()` implement squarified treemap recursively; `worstRatio()` decides when to start a new row
- `renderDonut()` draws SVG arc paths with gap between segments for donut chart
- Treemap navigation: `navigateTo(path)` updates `filePath` global and reloads files view
- `guessColor(entry)` classifies files by extension client-side for treemap coloring

**Critical storage-analyzer-api.py notes:**
- `classify_ext()` и константы расширений определены ИНЛАЙН в api-файле (не импортируются из storage_collector_lib — модуль не существует)
- `cmd_files(path, sort, ftype, older_than)`: при `ftype != "all"` — рекурсивный `os.walk`, директории пропускаются (избегает таймаута от `du -sb`); файлы показываются с rel-путём от root
- При `ftype == "all"` — плоский `os.listdir` с `du -sb` для директорий (как раньше)

## Performance Tuner (performance.html / js/performance.js)

Авто-оптимизатор дисковой подсистемы и сети. Полное ТЗ: [rusnas-performance-tuning-spec.md](./rusnas-performance-tuning-spec.md)

**Deploy:** уже в составе `./deploy.sh` (файл в `cockpit/rusnas/`)

**12 уровней оптимизации:** vm.* (sysctl), I/O планировщик (udev), read-ahead, mdadm stripe_cache, Btrfs mount options, сеть (sysctl), NIC ethtool, Samba smb.conf, NFS nfsd threads, CPU governor, IRQ balancing, TuneD профиль.

**Ключевые архитектурные решения:**
- Чтение параметров: `cat /proc/sys/vm/swappiness` (не `sysctl -n`) — без sudoers
- Запись параметров: `writeSysFile(sysctlPath(param), val)` = `cockpit.file(path, {superuser:"require"}).replace(val)` — без sudoers
- `sysctlPath("vm.swappiness")` → `"/proc/sys/vm/swappiness"` — helper конвертации
- Persist: запись в `/etc/sysctl.d/99-rusnas-perf.conf` через `cockpit.file` superuser
- Каждый параметр: `readFn` (текущее) + `applyFn` (in-memory) + `persistFn` (на диск) + `rollbackFn`

**Critical performance.js notes:**
- `applySingleItem(id)` — null-guard на `actEl` перед `.innerHTML` (BUG-28)
- `detectProfile()` — `profile.netSpeed` инициализируется 0 (не 1000), чтобы корректно выбрать NIC
- Sudoers для Performance Tuner **не нужны** — всё через `cockpit.file superuser`

## Dashboard — Night Report (ночной отчёт)

Виджет на дашборде — «утренняя газета для инфраструктуры». Показывает сводку за последние 8 часов.

**HTML:** блок `#night-report` в `dashboard.html` (после `#db-alert-banner`)
**CSS:** классы `.nr-*`, `.db-night-report` в `dashboard.css`
**JS:** функции `initNightReport()`, `refreshNightReport()`, `nrCollect*()`, `nrRender*()` в `dashboard.js`

**Структура виджета:**
- Health Score (0–100, хранится в `localStorage`)
- 5 stat-карточек: инциденты, снапшоты, CPU peak, сеть за 8ч, SMART
- 3 колонки: Guard события / SMART дисков / Деdup и снапшоты
- Кнопка `#btn-nr-refresh` — ручное обновление

**Init:** `setTimeout(initNightReport, 800)` в DOMContentLoaded — задержка чтобы не конкурировать с основной загрузкой дашборда.

## Mobile / Responsive CSS Rules

Все HTML-страницы плагина **обязаны** иметь viewport meta (иначе мобильные браузеры игнорируют @media queries):
```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

**Breakpoints в `style.css`:**
- `@media (max-width: 768px)` — таблицы `display:block;overflow-x:auto`, snap-layout стек, advisor-tabs scroll, checkboxes 20px, select min-height 38px
- `@media (max-width: 480px)` — padding, кнопки full-width, модалы, iOS zoom fix (`font-size:16px !important`), tabs scroll

**`dashboard.css`:** `@media (max-width: 700px)` — guard-stats 2col, metrics-grid 1col

**Правило:** при добавлении новых HTML-страниц — **обязательно** добавить viewport meta и проверить на 390px.

## Cockpit Plugin Rules

```javascript
// Correct path to cockpit.js
<script src="../base1/cockpit.js"></script>

// CSP in manifest.json is required for JS to work
"content-security-policy": "... 'unsafe-inline' 'unsafe-eval' ..."

// Inline handlers are forbidden by CSP — use addEventListener only
element.addEventListener('click', handler);  // ✓
// onclick="handler()" — NOT ALLOWED          // ✗

// targetcli requires explicit sudo (superuser: "require" does NOT cover it)
cockpit.spawn(["sudo", "targetcli", ...]);   // ✓
```

### Key Implementation Details

**app.js (Storage page) — после редизайна 2026-03-19:**

Страница `/rusnas` переработана по принципу Synology DSM. Полное ТЗ: [rusnas-storage-task.md](./rusnas-storage-task.md)

**Структура страницы (4 вкладки, `advisor-tabs`):**
- `📂 Шары` — единая таблица SMB+NFS, загружается сразу при открытии страницы
- `🎯 iSCSI` — два раздела: LUN Manager + Target Manager; перезагружается при каждом клике
- `🔒 WORM` — WriteOnce paths, lazy load при первом клике (`_tabsLoaded.worm` guard)
- `⚙️ Сервисы` — FTP + WebDAV карточки, lazy load при первом клике

**Unified Share Modal (`#share-modal`):**
- Один modal с внутренними `.tab-btn` вкладками: `Основные | SMB | NFS`
- `openShareModal(null)` — create mode; `openShareModal(shareData)` — edit mode
- В edit mode volume `<select>` disabled, показывает только текущий путь
- `_shareModalMode` + `_shareModalData` — переменные состояния modal

**Ключевые функции:**
- `parseSmbConf()` — возвращает `Promise<SmbShare[]>` через `testparm -s` + python3 inline
- `parseNfsExports()` — возвращает `Promise<NfsShare[]>` из `/etc/exports`
- `loadAllShares()` — `Promise.all([parseSmbConf(), parseNfsExports()])`, merge по path, вызывает `renderSharesTable()`
- `renderSharesTable(shares)` — рендерит объединённую таблицу, хранит данные в `window._sharesData[]`
- `saveShareModal()` — mkdir + chmod + chown, затем SMB (sed+printf) и/или NFS (sed+echo) по состоянию toggles
- `deleteShareEntry(shareData)` — удаляет секции из smb.conf и/или /etc/exports, директорию НЕ удаляет
- `loadServiceStatus()` — badges `SMB ● / NFS ●` через `systemctl is-active smbd nfs-kernel-server`
- `loadVolumeSelects(callback, targetId)` — теперь принимает `targetId` (по умолчанию `"sm-volume"`)

**Паттерны smb.conf (без изменений):**
- Edit/delete: `sed -i '/^\[name\]/,/^\[/{/^\[name\]/d;/^\[/!d}'`
- Add: `printf '\n[name]\npath = ...\n...\n' >> /etc/samba/smb.conf`
- Reload: `systemctl reload smbd` (не restart — не рвёт соединения)

**NFS (без изменений):**
- Delete old entry before adding: `sed -i '\|^/path |d'` before append (prevents duplication)
- `exportfs -ra` после каждого изменения

**iSCSI (редизайн 2026-03-22):**
- Источник данных: `sudo cat /etc/rtslib-fb-target/saveconfig.json` (НЕ `/etc/target/`)
- Перед чтением всегда `targetcli saveconfig` (файл не обновляется автоматически)
- JSON структура: `storage_objects[]` — flat list, поле `plugin` (fileio/block); `targets[]` — flat list, поле `fabric === "iscsi"`
- `storage_object` в `luns[]` имеет префикс `/backstores/` → нормализуется strip при парсинге
- Состояние: `_iscsiState = { backstores, targets, loaded }`; `_iscsiDeleteCtx`
- LUN удаление: кнопка задисейблена если `inUseBy.length > 0`; опциональное удаление `.img`-файла (чекбокс, по умолчанию OFF)
- Target удаление: только конфиг, файлы не трогает
- `_esc(s)` — HTML-эскейп для safe innerHTML rendering

**disks.js:**
- Parse `/proc/mdstat` with states: `active` / `degraded` / `inactive` / `resyncing` / `reshaping`
  - Check BOTH `resync` AND `reshape` keywords
- Physical disk info via `sudo smartctl -i` (model, serial, S.M.A.R.T. health)
- Safe disk removal: `--fail → --remove → device/delete` with serial number confirmation
- **Replace disk** vs **Expand array** vs **Upgrade RAID level** are separate operations
  - Expand: `--add` + `--grow --raid-devices=N` + auto `resize2fs`/`btrfs resize` on completion
  - **Level upgrade (RAID 5→6):** `--add /dev/sdX` + `--grow --level=6 --raid-devices=N+1`; button "⬆ Апгрейд RAID5→6" shown for healthy RAID 5 arrays; modal `#modal-upgrade-raid` with free disk selector + SMART info + reshape warning; filesystem auto-resize via `checkReshapeComplete()` after done
- SCSI bus rescan: `echo "- - -" > /sys/class/scsi_host/host*/scan`
- Auto-refresh every 4 seconds during degraded or resyncing states
- **Full RAID lifecycle UI** (implemented 2026-03-14):
  - `+ Создать массив` — 2-step wizard: select level + disks → progress log → mdadm create + mkfs.btrfs + mount + fstab
  - `Удалить` — confirmation modal with member disk list → umount + fstab cleanup + mdadm --stop + zero-superblock
  - `Смонтировать` — blkid FS detection (disabled if no FS) → mkdir + mount + fstab
  - `Размонтировать` — confirm dialog → umount
  - `Субтома` (Btrfs only, when mounted) — list + create + delete subvolumes
  - Mount status shown on card: `📂 /mnt/data (btrfs)` or `— не смонтирован`
  - `currentMountMap{}` populated from `findmnt -rno SOURCE,TARGET,FSTYPE` on each load
- **Admin access required**: `superuser: "require"` works in disks.js (not nested iframe). User must enable "Turn on administrative access" in Cockpit main page before first use.
- **Backup Mode (HDD Spindown):** per-array panel toggled via "Резервный режим" button; `loadSpindownState()` polls CGI on page load; `_warnIfSleeping(md)` blocks destructive ops when array in standby; badge `#spindown-badge-<md>` shows Активен/Спит/Пробуждение

## rusNAS RAID Backup Mode (HDD Spindown)

Automatic RAID spindown for backup use-case. Full spec: `docs/superpowers/specs/` (feat/raid-backup-mode branch).

**Deploy:**
```bash
./install-spindown.sh
```

**Key architecture:**
- Daemon: `/usr/lib/rusnas/spind/spind.py` + `rusnas-spind.service` (--dry-run on QEMU VM)
- State: `/run/rusnas/spindown_state.json` (read by dashboard + Prometheus)
- Totals: `/var/lib/rusnas/spindown_totals.json` (wakeup_count_total persistence across restarts)
- CGI: `/usr/lib/rusnas/cgi/spindown_ctl.py` — 5 commands: get_state, get_config, set_config, wake_up, spindown_now
- Config: `/etc/rusnas/spindown.json`
- Sudoers: `/etc/sudoers.d/rusnas-spindown`

**State machine:** active → flushing → standby → waking → active
**Monitoring:** 5 Prometheus metrics in `rusnas-metrics/metrics_server.py` (rusnas_spindown_*)
**UI:** Backup Mode panel per array in `disks.js`; spindown badge + sub-line in dashboard
**Tests:** `tests/test_backup_mode_ui.py` (15 tests, all pass on VM with dry-run)

**Critical spindown notes:**
- `--dry-run` flag in systemd unit: QEMU VM doesn't support hdparm -Y; daemon logs `[DRY-RUN]` and skips actual spindown
- `suppress_check`: writes `idle` to `/sys/block/mdX/md/sync_action` to pause RAID check during standby
- `wakeup_count_total` persisted in `/var/lib/rusnas/spindown_totals.json` — survives daemon restarts
- CGI called as: `cockpit.spawn(["sudo", "-n", "python3", "/usr/lib/rusnas/cgi/spindown_ctl.py", cmd, ...], {err:"message"})`
- `_warnIfSleeping(md)` in disks.js: checks state before expand/replace/umount/subvol operations

## rusNAS Container Manager

Containerized app store for rusNAS. Deploy: `./install-containers.sh`

**Key architecture:**
- CGI: `/usr/lib/rusnas/cgi/container_api.py` — 14 commands via argv
- User: `rusnas-containers` (rootless Podman), subuid/subgid 100000:65536
- State: `/etc/rusnas/containers/installed.json` (chmod 644)
- Catalog: `/usr/share/cockpit/rusnas/catalog/` (10 apps)
- Compose dir: `/var/lib/rusnas-containers/compose/<appid>/`
- Nginx apps: `/var/lib/rusnas-containers/nginx-apps/<appid>.conf`
- Sudoers: `/etc/sudoers.d/rusnas-containers`

**Critical containers.js notes:**
- `cgiCall(cmd, args)` wraps cockpit.spawn in `new Promise()` — required for Promise.all()
- All catalog/installed buttons use `data-appid` + `addEventListener` (no inline onclick — CSP)
- `startStatsPolling()` uses `_statsTimer` stored ID to avoid timer leaks
- Compose template substitution: `{{VAR:-default}}` pattern in docker-compose.yml files
- Docker Compose DNS: service key names (under `services:`), NOT `container_name` values

**Catalog apps (10):** nextcloud, immich, jellyfin, vaultwarden, home-assistant, pihole, wireguard, mailcow, onlyoffice, rocketchat

## Known Bugs and Fixes

> Полная история: [bugs.md](./bugs.md). Ниже — только активные ловушки (паттерны которые легко повторить).

| Bug | Fix |
|-----|-----|
| `bash -c "sudo cmd | grep ..."` не работает | bash запускается без прав, inner sudo требует пароль; **правильно:** `cockpit.spawn(["sudo", "-n", "cmd", ...], {err:"message"})` |
| `cockpit.spawn().then()` не Promise | не работает с `Promise.all()`; всегда оборачивать: `new Promise(function(r,j){ cockpit.spawn(...).done(r).fail(j); })` |
| `superuser:"require"` в iframe → timeout | polkit не работает в iframe; использовать sudoers NOPASSWD вместо |
| smb.conf inline comments ломают configparser | `param = value ; comment` → значение читается с мусором; писать python regex парсер в tmpfile |
| duperemove v0.11.2 — нет `--min-size`/`--hash` | Debian 13 имеет v0.11.2; эти флаги добавлены в v0.12+ — не использовать |
| NFS entries дублируются при add | `sed -i '\|^/path |d'` перед append в /etc/exports |
| SMB share deletion/edit corrupts smb.conf | `sed` range pattern `/^\[name\]/,/^\[/` — НЕ python regex |
| iSCSI saveconfig.json неверный путь | `/etc/rtslib-fb-target/saveconfig.json` — НЕ `/etc/target/`; делать `targetcli saveconfig` перед чтением |
| `rusnas-snap schedule list` формат | возвращает `{schedules:[...], ok:true}` — НЕ bare array; парсить как `data.schedules` |
| `schedule list` с флагом `--json` | команда НЕ принимает `--json`; флаг вызывает ошибку |
| guard.py теряет `+x` после scp | `scp` копирует 644; `install-guard.sh` делает `chmod 755` — запускать при каждом обновлении guard.py |
| `/proc/mdstat` reshape не детектируется | проверять И `resync` И `reshape` keyword |
| `allow-hotplug` дублируется в interfaces | VM использует `allow-hotplug enp0s1` = `auto`; не добавлять оба |
| Offline-субволюм в снапшотах → ошибка | проверять `isSubvolOffline(path)` перед `rusnas-snap list` |
| Stale SMB/NFS шары после удаления RAID | `scanArrayDeps(mp)` чистит конфиги; `loadAllShares()` проверяет `[ -d path ]` |
| `sysctl -w` через `sudo -n` требует пароль | `sysctl` не в NOPASSWD sudoers; **правильно:** `writeSysFile("/proc/sys/vm/swappiness", val)` — через cockpit.file superuser без sudoers |
| `escHtml(null)` → TypeError | всегда `String(s \|\| "").replace(...)` — никогда `s.replace(...)` напрямую |
| Несколько `setInterval` открывают модал быстро | очищать старый interval `if (_interval) clearInterval(_interval)` в начале `open*Modal()` |
| `setInterval` без сохранения ID = утечка | всегда `var _timer = setInterval(...)` для возможности `clearInterval(_timer)` |
| tickFast делает N spawns каждые 2 сек | батчить `/proc` reads в один bash spawn с разделителем `===M===`; парсить в `_parse*Out()` функциях |
| `Promise.all(...).then(...)` без `.catch()` | необработанный rejection зависает UI; всегда добавлять `.catch(function(e) { /* show error */ })` |
| `results.push()` в параллельных spawn callbacks | race condition — порядок не гарантирован; использовать `results[idx] = ...` с индексом из `forEach(dev, idx)` |
| `renderX()` после `loadData()` через `setTimeout(300)` | ненадёжная гонка; `loadData()` должен возвращать Promise, `renderX()` вызывать через `.then()` |
| `worstStatus` при нескольких массивах перезаписывается | использовать явный приоритет: `inactive` > `degraded` > `resyncing` > `active`; не перезаписывать более критичный |
| `/var/lib/rusnas` права 750 → rusnas-fb crash loop | при создании поддиректорий для других пользователей — `chmod o+x /var/lib/rusnas` (traverse-бит для other) |
| `branding.css` `[aria-current]` матчит все nav-ссылки | PF6 ставит `aria-current="false"` на ВСЕ ссылки; использовать `[aria-current="page"]` |
| CSS переменные на `.pf-v6-c-nav` каскадируют на все дочерние | `--pf-v6-c-nav__link--m-current--BackgroundColor` на родителе попадает в inactive items; только прямые `!important` overrides на ссылке |

## FTP and WebDAV settings (app.js / index.html)

Settings sections added to the Storage page (`/rusnas`):

**FTP:**
- Status badge + start/stop buttons
- `loadFtp()`: reads `/etc/vsftpd.conf`, shows anonymous/write/chroot toggles and passive port range
- `saveFtp()`: writes config via Python inline script (`re.sub` for each key), then `systemctl restart vsftpd`
- Active connections from `/proc/net/tcp` port 0x7530 (21)

**WebDAV:**
- Status badge + start/stop buttons
- `loadWebdav()`: reads `/etc/apache2/sites-enabled/webdav.conf` (Alias + Directory block)
- `saveWebdav()`: writes full config block + `systemctl reload apache2`
- User management: list from `/etc/apache2/webdav.passwords`, add via `htdigest -b` (Python MD5 fallback), remove via `sed -i`

## Guard page structure (guard.html)

Three tabs:
- **Обзор** — stats + how-it-works infographic
- **Журнал событий** — filtered paginated event log
- **Настройки** — detection methods, monitored paths, snapshot config

Tab badge on "Журнал событий" shows unacknowledged event count.

## Guard event log (guard.js)

- `loadEvents(resetPage)` — main function; sends `get_events` with filters + pagination
- `eventsFilters = {method, status, date_from, date_to}` — global filter state
- `eventsPage` — 0-based page index; `PAGE_SIZE = 25`
- `exportEventsCsv()` — requests all matching events (limit=10000), builds Blob CSV with UTF-8 BOM, triggers download
- Backend: `load_events()` in response.py supports offset/method/status/date_from/date_to; returns `{events, total}`
- Backend: `clear_events` socket command (auth required) truncates `events.jsonl`

## Distribution Infrastructure

> **Все скрипты и планы используют эти значения. При смене VPS — обновить здесь.**

| Параметр | Текущее значение | Описание |
|----------|-----------------|----------|
| `RUSNAS_VPS_HOST` | `activate.rusnas.ru` | Публичный hostname license server + apt repo |
| `RUSNAS_VPS_SSH` | `rusnas-vps` | SSH-алиас в `~/.ssh/config` (указывает на VPS) |
| `RUSNAS_APT_URL` | `https://activate.rusnas.ru/apt/` | URL apt репозитория |
| `RUSNAS_INSTALL_URL` | `https://activate.rusnas.ru/install` | URL bootstrap-скрипта |
| `RUSNAS_LICENSE_PORT` | `8765` | Порт FastAPI license server |
| `RUSNAS_APT_AUTH_PORT` | `8766` | Порт apt-auth service |
| `RUSNAS_REPREPRO_BASE` | `/var/lib/reprepro` | Путь к reprepro на VPS |
| `RUSNAS_INSTALL_DIR` | `/opt/rusnas-license-server` | Путь к license server на VPS |
| `RUSNAS_WEBROOT` | `/var/www/rusnas-install` | Путь к bootstrap.sh и gpg-ключу на VPS |

**При смене VPS:**
1. Обновить таблицу выше
2. Обновить `~/.ssh/config`: алиас `rusnas-vps` → новый IP
3. Перевыпустить TLS-сертификат для нового домена
4. Обновить `RUSNAS_VPS_HOST` в `bootstrap.sh` и `rusnas-license-server/.env`

### Что реализовано (ветка feat/bootstrap-installer-spec, 2026-03-26)

| Компонент | Файл | Статус |
|-----------|------|--------|
| License server (FastAPI) | `rusnas-license-server/server.py` | ✅ реализован, 22 теста |
| Криптография Ed25519 + Base62 | `rusnas-license-server/crypto.py` | ✅ реализован |
| БД + CRUD | `rusnas-license-server/db.py` | ✅ реализован |
| Pydantic модели | `rusnas-license-server/models.py` | ✅ реализован |
| CLI оператора | `rusnas-license-server/admin.py` | ✅ реализован |
| Apt-auth service (port 8766) | `rusnas-license-server/apt_auth.py` | ✅ реализован |
| Web admin UI (Jinja2) | `rusnas-license-server/admin_web.py` | ✅ реализован |
| Страница активации клиента | `rusnas-license-server/static/activate.html` | ✅ реализован |
| Admin Jinja2 шаблоны (6 шт) | `rusnas-license-server/static/admin/` | ✅ реализован |
| Bootstrap installer | `bootstrap.sh` | ✅ реализован |
| Nginx конфиг VPS | `vps-setup/nginx-rusnas.conf` | ✅ реализован |
| Cockpit license page | `cockpit/rusnas/license.html` + `js/license.js` | ✅ реализован |
| Системд юниты | `rusnas-license.service`, `rusnas-apt-auth.service` | ✅ реализован |

**Публичный ключ оператора (тестовый):** `1d6UQHGzNP3wZPQVFpXUkc5qF+5UAyQlrUMSQAffdA0=`

> ⚠️ **При деплое на реальный VPS** — сгенерировать новую ключевую пару через `python3 keygen.py`, обновить `OPERATOR_PUBLIC_KEY_B64` в `cockpit/rusnas/js/license.js`, пересобрать и задеплоить. Тестовые ключи в коде — только для dev-среды.

**Pending (не сделано):**
- VPS деплой (apt-repo reprepro, systemd юниты на реальном сервере)
- Ansible role для раскатки license server
- Пакет `rusnas-system` (apt пакет, устанавливает Cockpit плагин)

**`~/.ssh/config` пример:**
```
Host rusnas-vps
    HostName <IP или домен VPS>
    User root
    IdentityFile ~/.ssh/rusnas_vps_key
```

## Git Workflow

> Полные правила: [git-workflow.md](./git-workflow.md)

Стратегия: Feature Branch Flow. `main` = задеплоенный код. После merge → `./deploy.sh`.
Формат коммитов: `feat:|fix:|docs:|refactor: описание` + `Authored-By: Dmitrii V. Lozovoi (lozovoyd@gmail.com)`
**Текущая ветка:** `feat/raid-backup-mode` (RAID Backup Mode / HDD Spindown 2026-03-28, не merged в main)

## Landing Page (marketing site, port 80)

**Файлы:** `landing/index.html` + `landing/apache/rusnas-landing.conf`

**Расположение на VM:** `/var/www/rusnas-landing/index.html`

**Деплой:**
```bash
./deploy-landing.sh
```

**Требование к сопровождению:**
> ⚠️ **Лендинг нужно поддерживать в актуальном состоянии** — при добавлении, изменении или удалении фич продукта (Cockpit-страницы, новые модули, Guard, UPS, Dedup, Snapshots, RAID и т.д.) **нужно обновлять `landing/index.html`**, отражая изменения.
>
> Правила:
> - Сохранять оригинальный стиль и дизайн (тёмная тема, шрифт Manrope, оранжевый/красный акцент)
> - Не добавлять внешние зависимости — всё CSS/JS инлайн в `index.html`
> - После любого изменения: `./deploy-landing.sh` + проверка `http://10.10.10.72/` в браузере
> - Раздел «Возможности» (features-grid) — основной для обновления при новых фичах
> - Раздел «Дорожная карта» — обновлять при завершении задач из Roadmap

**Структура страницы (разделы):**
1. Hero — заголовок, rack-визуализация
2. Features — 9+ карточек (SMB/NFS, снапшоты, RAID, Guard, Dedup, UPS, WebDAV/FTP/iSCSI, мониторинг, пользователи)
3. Modules — детальное описание ключевых модулей
4. Specs — технические характеристики (таблица)
5. Comparison — сравнение с Synology DSM / QNAP / TrueNAS
6. Roadmap — дорожная карта (что реализовано, что в планах)
7. CTA — призыв к действию / контакты

## Development Patterns

- Iterate and verify — confirm each step works before proceeding
- Transfer files via `scp`, not terminal paste (long commands get truncated)
- Test on the real VM, not theoretical correctness
- When regressions appear, check whether the last refactor broke a working approach
- Separate sessions for UI work (Cockpit plugin) vs infrastructure (Ansible)

---

## Roadmap

> Детальные заметки по каждой фиче: [roadmap.md](./roadmap.md)

| Модуль | Статус | Детали |
|--------|--------|--------|
| Dashboard | ✅ реализован 2026-03-15 | rusnas-dashboard-spec.md |
| Дедупликация | ✅ реализована 2026-03-15 | rusnas-dedup-spec.md |
| SSD-кеширование | ✅ реализовано 2026-03-17 | rusnas-ssd-tier-task.md |
| FileBrowser Quantum | ✅ реализован 2026-03-19 | rusnas-filebrowser-task.md |
| Network + Certs + Domain | ✅ реализовано 2026-03-21/22 | rusnas-network-task.md |
| MCP Server + AI Agent | ✅ Session 1 (2026-03-22/23) | rusnas_mcp_ai.MD |
| Снапшоты: репликация | ✅ реализовано 2026-03-23 | roadmap.md |
| Performance Tuner (⚡) | ✅ реализован 2026-03-24 | rusnas-performance-tuning-spec.md |
| Night Report (дашборд) | ✅ реализован 2026-03-25 | roadmap.md |
| Regression Testing + CPU opt | ✅ завершено 2026-03-25 | bugs.MD, project_history.MD |
| UI Cohesion + Ghost Pill Sidebar | ✅ завершено 2026-03-26 | ui.md, project_history.md |
| Bootstrap Installer + License Server | ✅ реализован 2026-03-26 | rusnas-license-server-task.md, ветка feat/bootstrap-installer-spec |
| Cockpit License Page | ✅ реализована 2026-03-26 | license.html + js/license.js, ветка feat/bootstrap-installer-spec |
| RAID Backup Mode (HDD Spindown) | ✅ реализован 2026-03-28 | feat/raid-backup-mode branch, tests/test_backup_mode_ui.py |
| Container Manager | ✅ реализован 2026-03-28 | containers.html + cgi/container_api.py + catalog/ (10 apps), 19 тестов |
| MCP Session 2 (SSE/Ollama) | 📋 следующая сессия | roadmap.md |
