# CLAUDE.md

> См. также: [project_history.md](./project_history.md) — хронология всех сессий
> UI правила и компоненты: [ui.md](./ui.md)
> Антишифровальщик: [rusnas-guard-task.md](./rusnas-guard-task.md) — ТЗ и архитектура Guard
> RAID Manager: [rusnas-RAIDmanager.md](./rusnas-RAIDmanager.md) — ТЗ и архитектура RAID Manager
> Дедупликация: [rusnas-dedup-spec.md](./rusnas-dedup-spec.md) — ТЗ и архитектура Dedup
> ИБП / UPS: [rusnas-ups-nut_spec.md](./rusnas-ups-nut_spec.md) — ТЗ и архитектура UPS/NUT
> Storage Analyzer: [rusnas-storage-analyzer-task.md](./rusnas-storage-analyzer-task.md) — ТЗ и архитектура Анализатора пространства
> Storage Page (редизайн): [rusnas-storage-task.md](./rusnas-storage-task.md) — ТЗ и заметки по реализации редизайна страницы Хранилище
> SSD-кеширование: [rusnas-ssd-tier-task.md](./rusnas-ssd-tier-task.md) — ТЗ и архитектура SSD-кеша (dm-cache/LVM)
> MCP Server + AI Agent: [rusnas_mcp_ai.MD](./rusnas_mcp_ai.MD) — ТЗ (планируется)
> FileBrowser: [rusnas-filebrowser-task.md](./rusnas-filebrowser-task.md) — ТЗ и архитектура

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> ⚠️ **project_history.MD — только ДОПОЛНЯТЬ, никогда не перезаписывать целиком!**
> Всегда добавлять новую сессию в конец файла. Существующие записи не трогать.

Always write all changes on project in project_history.md and other files with techical specifications in header
Always update information in claud.md after deploy features, bugfixes, and new code
Always use MCP services what available



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
│   └── rusnas/             # Cockpit plugin source
│       ├── manifest.json
│       ├── index.html      # Storage: SMB shares + iSCSI targets
│       ├── disks.html      # Disks and RAID arrays
│       ├── users.html      # User management
│       ├── guard.html      # Guard 🛡️ — ransomware protection
│       ├── snapshots.html  # Snapshots — Btrfs snapshot manager
│       ├── dedup.html      # Дедупликация — duperemove + reflinks + vfs_btrfs
│       ├── css/style.css
│       └── js/
│           ├── app.js      # Storage logic (SMB, NFS, iSCSI)
│           ├── disks.js
│           ├── users.js
│           ├── guard.js    # Guard UI logic
│           ├── snapshots.js
│           └── dedup.js    # Dedup UI logic
├── rusnas-guard/           # Guard daemon source
│   ├── daemon/
│   │   ├── guard.py        # Main daemon entry point
│   │   ├── detector.py     # inotify watcher + detection logic
│   │   ├── entropy.py      # Shannon entropy computation
│   │   ├── honeypot.py     # Bait file management
│   │   ├── response.py     # Blocking, snapshots, notifications
│   │   └── socket_server.py # Unix socket server
│   ├── config/
│   │   ├── config.json     # Default configuration
│   │   └── ransom_extensions.txt  # ~200 known ransomware extensions
│   └── service/
│       └── rusnas-guard.service   # systemd unit
├── ansible/                # Ansible monorepo (provisioning)
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
├── landing/                # rusNAS landing page (Apache, port 80)
│   ├── index.html          # Main landing page — single-file, self-contained CSS/JS
│   ├── assets/             # Images, logos (if needed in future)
│   └── apache/
│       └── rusnas-landing.conf  # Apache VirtualHost config
├── deploy.sh               # Deploy Cockpit plugin to VM
├── deploy-landing.sh       # Deploy landing page to Apache on VM
├── install-guard.sh        # Deploy Guard daemon to VM
├── install-snapshots.sh    # Deploy snapshot system to VM
├── install-dedup.sh        # Deploy Dedup backend to VM
├── rusnas-dedup/
│   ├── rusnas-dedup-run.sh    # Wrapper script: duperemove + state JSON
│   └── rusnas-dedup.service   # systemd oneshot service
├── rusnas-metrics-install.sh  # Deploy Metrics Server to VM
├── rusnas-metrics/
│   ├── metrics_server.py   # Prometheus + JSON metrics HTTP server (port 9100)
│   └── rusnas-metrics.service  # systemd unit
├── rusnas-guard-task.md    # Guard ТЗ и архитектура
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
- `🎯 iSCSI` — таблица targets, lazy load при первом клике
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

**disks.js:**
- Parse `/proc/mdstat` with states: `active` / `degraded` / `inactive` / `resyncing` / `reshaping`
  - Check BOTH `resync` AND `reshape` keywords
- Physical disk info via `sudo smartctl -i` (model, serial, S.M.A.R.T. health)
- Safe disk removal: `--fail → --remove → device/delete` with serial number confirmation
- **Replace disk** vs **Expand array** are separate operations
  - Expand: `--add` + `--grow --raid-devices=N` + auto `resize2fs`/`btrfs resize` on completion
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

## Known Bugs and Fixes

| Bug | Fix |
|-----|-----|
| SMB share deletion/edit corrupts smb.conf | Use `sed` range pattern `/^\[name\]/,/^\[/` instead of Python regex |
| NFS entries duplicate on each add | `sed -i '\|^/path |d'` before append |
| iSCSI targetcli fails silently | Add explicit `sudo` to `cockpit.spawn()` |
| mdadm reshape shows "Active" in UI | Check both `resync` and `reshape` in /proc/mdstat parser |
| macOS NFS mount fails | Add `insecure` option to /etc/exports |
| Binaries not in PATH (mdadm, mkfs.btrfs) | Add `/sbin` to PATH in `.bashrc` |
| Guard IOPS counter always 0 | `InotifyTrees` returns subdirectory watch_path; normalize with `_root_path()` before lookup in `_iops_windows` dict |
| Guard detector thread crashes silently | Same root cause: `_iops_windows[watch_path]` raises `KeyError` on first subdirectory event, killing the thread |
| Guard socket channel timeout | `superuser: "require"` in iframe context causes polkit timeout; removed — security maintained by PIN auth |
| Guard extensions list shows "Файл не найден" | `/etc/rusnas-guard/` had `chmod 700`; must be `755` so Cockpit bridge (non-root) can read `ransom_extensions.txt` |
| `/run/rusnas-guard/` disappears after reboot | Add `RuntimeDirectory=rusnas-guard` + `RuntimeDirectoryMode=0755` to systemd unit |
| Guard crash on enable: `AttributeError: get_iops` | `guard.py:_update_state()` called non-existent method; `Detector._record_iops()` already writes to shared state dict directly |
| Guard crash on enable: `FileNotFoundError` in `InotifyTrees` | Filter paths with `os.path.isdir()` before passing to `InotifyTrees`; non-existent configured paths are skipped with warning |
| Dashboard disk health block shows nothing | `ls /dev/sd? /dev/nvme?n?` exits with code 1 when no nvme devices → cockpit.spawn calls `.fail()`; fixed by appending `; true` |
| Dedup SMB shares "не найдены" | `configparser` fails on smb.conf inline comments (`param = value ; comment`); fixed: write Python regex parser to tmpfile + execute |
| Dedup invalid args (exit code 22) | duperemove v0.11.2 (Debian 13) doesn't support `--min-size`/`--hash`; removed from advanced form and saveAdvancedConfig |
| Dedup status stays "Выполняется" after run | `setRunningState(false)` didn't clear status text; fixed: clear to "—" immediately, `loadLastRun()` fills real status |
| Dedup stale JSON after run completion | Race: polling detected inactive before script finished writing JSON; fixed: 800ms delay before `loadLastRun()` in polling callback |
| Dedup schedule controls active when disabled | No disabled state on time/days when "Включена" unchecked; fixed: change listener + `populateSettings()` sets `.disabled` |
| Guard PIN modal not appearing after `--reset-pin` | Socket unavailable after reset → `guardCmd("has_pin")` silently fails; added `checkPinSetup()` with `test -f` fallback called from both DOMContentLoaded and refreshStatus error branch |
| Dashboard dark mode не работал | `dashboard.css` использовал несуществующие переменные (`--color-bg-secondary`, `--color-card-bg`, `--color-text-muted`) с fallback к светлым hex-значениям; исправлено: заменены на `--bg-th`, `--bg-card`, `--color-muted` из `style.css` |
| Guard bait files visible in SMB clients | Toggle `detection.hide_smb_baits` in Guard settings; `_apply_smb_hide()` writes `hide files = /!~rng_*/` into `[global]` section of smb.conf + `systemctl reload smbd`; atomic write via `.guard.tmp`; applied on daemon start |

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

## Git Branching & Versioning Rules

### Стратегия: Feature Branch Flow

```
main              ──●────────────●────────────●──  ← production
                                 ↑            ↑
feature/dashboard  ──●──●──●────┘            │
feature/replication         ──●──●──●────────┘
hotfix/bug-name                     ──●──────┘
```

### Правила

| Ветка | Назначение | Создаётся от | Вливается в |
|-------|-----------|-------------|------------|
| `main` | Production. То что деплоено на VM | — | — |
| `feature/<name>` | Новая фича (дашборд, репликация и т.д.) | `main` | `main` (merge --no-ff) |
| `hotfix/<name>` | Срочный баг в production | `main` | `main` (прямой commit) |

**`main` всегда = задеплоенный код.** После merge → сразу `./deploy.sh`.

### Как начать новую фичу

```bash
git checkout main
git pull origin main           # синхронизировать с GitHub
git checkout -b feature/replication
# ... работа ...
git push -u origin feature/replication
```

### Как влить фичу в main

```bash
git checkout main
git merge feature/replication --no-ff   # --no-ff сохраняет историю ветки
git push origin main
./deploy.sh                             # деплой на VM
```

### Если main обновился пока работаешь над фичей

```bash
git checkout feature/replication
git rebase main    # перенести коммиты ветки поверх нового main
# при конфликтах: исправить файл → git add → git rebase --continue
git push origin feature/replication --force-with-lease   # нужен force после rebase
```

### Баг-фиксы

- **Срочный**: коммит прямо в `main` → `./deploy.sh`
- **В рамках текущей фичи**: коммит в feature-ветку как обычно
- **Нужен в нескольких ветках**: `git cherry-pick <commit-hash>`

### Правила коммитов

Формат: `тип: краткое описание`

| Тип | Когда |
|-----|-------|
| `feat:` | Новая функциональность |
| `fix:` | Исправление бага |
| `docs:` | Только документация (CLAUDE.md, project_history.MD) |
| `refactor:` | Рефактор без изменения поведения |

Всегда добавлять в конец:
```
Authored-By: Dmitrii V. Lozovoi (lozovoyd@gmail.com)
```

### Текущие ветки

- `main` — стабильная production, задеплоена на VM
- `feature/dashboard` — слита в main (2026-03-15)
- `feature/dedup` — слита в main (2026-03-15)

---

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

## Roadmap — следующие задачи

### ✅ Dashboard (реализован 2026-03-15, ветка feature/dashboard)
- `dashboard.html` + `css/dashboard.css` + `js/dashboard.js` — полный дашборд
- `rusnas-metrics/metrics_server.py` — Prometheus + JSON API на порту 9100
- `rusnas-metrics.service` — задеплоен и работает на VM

**rusNAS Dashboard — ключевые факты:**
- Интервалы: `TICK_FAST=1000` (CPU/Net/IO), `TICK_STORAGE=10000`, `TICK_SMART=300000`, `TICK_GUARD=5000`, `TICK_UPS=10000`
- Sparklines — чистый SVG, без внешних библиотек
- SMART cache TTL 5мин (`smartCache[device].time`)
- Guard state из `/run/rusnas-guard/state.json`
- UPS widget: `loadUpsStatus()` → `upsc -j` → `renderDashUps()` / `renderUpsNoDevice()`; карточка в grid-4 нижней секции
- **Dark mode fix (2026-03-16):** dashboard.css использовал `--color-bg-secondary`/`--color-card-bg`/`--color-text-muted` → заменено на `--bg-th`/`--bg-card`/`--color-muted`
- Metrics server: warmup 1 сек перед первым delta-расчётом
- Metrics endpoint: `http://<IP>:9100/metrics` (Prometheus) + `/metrics.json` (JSON)

### ✅ Дедупликация (реализована 2026-03-15, ветка feature/dedup)
- `dedup.html` + `js/dedup.js` — полная страница управления дедупликацией
- `rusnas-dedup/rusnas-dedup-run.sh` — backend: duperemove + state JSON
- `rusnas-dedup/rusnas-dedup.service` — systemd oneshot, Nice=19, IOSchedulingClass=idle
- `install-dedup.sh` — деплой бэкенда на VM
- Функции: запуск/стоп, лог, расписание (cron), тома, SMB vfs_btrfs per-шара, продвинутые параметры
- Метрики: shared extents через `btrfs filesystem du -s`, история 7 дней, SVG timeline + бар-чарт

### Снапшоты: репликация (следующая сессия)

**Суть:** вынос снапшотов за пределы NAS. Три уровня:

#### Уровень 1 — кастомный `snap_dir` per-schedule (средний приоритет)
Позволяет хранить снапшоты на другом томе того же NAS (например `/mnt/data2/.snapshots/...`).
- Добавить поле `snap_dir TEXT` в таблицу `schedules` (с дефолтом `NULL` = автовычисление)
- Добавить поле в модал создания/редактирования расписания (с подсказкой и кнопкой "по умолчанию")
- CLI: `--snap-dir` параметр в `schedule set`
- В `cmd_create()` использовать `snap_dir` из расписания если задан, иначе авто

#### Уровень 2 — репликация на удалённый хост (главная задача)
Инкрементальная репликация через `btrfs send/receive` по SSH.

**Архитектура:**
- Новая таблица `replication_tasks`: `id, subvol_path, remote_user, remote_host, remote_path, method, last_sent_snap, enabled, cron_expr`
- CLI команда: `rusnas-snap replicate <subvol_path> [--snap-id <id>]` — делает `btrfs send -p <parent> | ssh user@host btrfs receive /path`
- CLI команда: `rusnas-snap replication set <subvol_path> --host ... --user ... --path ... --cron ...`
- CLI команда: `rusnas-snap replication list/delete`
- Новая вкладка "Репликация" в `snapshots.html` (рядом с Расписанием)

**Метод `btrfs send/receive`:**
```bash
# Первая передача (полный снапшот):
btrfs send /mnt/data/.snapshots/docs/@2026-03-14_... | ssh user@host btrfs receive /backup/docs/

# Инкрементальная (только diff от предыдущего):
btrfs send -p /mnt/data/.snapshots/docs/@prev | ssh user@host btrfs receive /backup/docs/
```
CLI отслеживает `last_sent_snap` в БД — при следующем запуске передаёт только diff.

**UI — вкладка Репликация:**
- Список задач репликации (subvol → host:/path, последняя передача, статус)
- Кнопки: + Добавить, Изменить, Запустить сейчас, Удалить
- Модал добавления: субволюм, SSH host, user, remote path, расписание
- Журнал репликаций (отдельный от событий снапшотов)

#### Уровень 3 — S3/rclone (низкий приоритет, позже)
- `rclone copy snap_path s3:bucket/path` как альтернативный метод
- Конфигурация rclone remote через UI

**Что уже готово:**
- `rusnas-snap storage-info` — глобальная статистика
- `rusnas-snap schedule delete` — удаление расписания
- Sidebar с деревом папок, offline-группы
- `snap_dir` показывается в per-folder header и в карточке расписания

**Что НЕ делать при репликации:**
- Не использовать rsync для Btrfs-снапшотов — не сохраняет read-only subvol структуру
- Не передавать через SMB/FTP — слишком медленно и ненадёжно
- SSH ключи должны быть преднастроены вручную (безопасность), UI только вводит host/user/path

### ✅ SSD-кеширование (реализовано 2026-03-17)

Ускорение HDD RAID-массивов через SSD-кеш на базе LVM dm-cache. Полное ТЗ: [rusnas-ssd-tier-task.md](./rusnas-ssd-tier-task.md)

**Реализованные компоненты:**
- `install-ssd-tier.sh` — деплой: lvm2, sudoers, ssd-tiers.json
- Секция "⚡ SSD-кеширование" в `disks.html` (после физических дисков)
- Полная логика в `disks.js` — ~350 строк: getSsdCandidates, getSsdTierStatus, renderSsdTiers, loadSsdTiers, doCreateSsdTier, doChangeCacheMode, doRemoveSsdTier
- CSS-классы `ssd-bar-wrap`, `ssd-bar-fill`, `ssd-mode-wt`, `ssd-mode-wb` в `style.css`

**Архитектура стека:**
```
Btrfs → /dev/rusnas_vgN/data_lv (dm-cache LV) → /dev/mdX (mdadm RAID HDD) + /dev/sdY (SSD)
```

**Key architecture notes:**
- Технология: lvmcache (dm-cache) через LVM — НЕ bcache (опасен с Btrfs в writeback)
- Конфиг: `/etc/rusnas/ssd-tiers.json` — список активных тиров
- Судоерс: `/etc/sudoers.d/rusnas-ssd-tier` — NOPASSWD для pvcreate/vgcreate/lvcreate/lvconvert/lvchange/dmsetup
- LVM команды в `/sbin/` (Debian 13) — sudo через `secure_path` находит их
- Polling статуса каждые 10 сек через `setInterval(loadSsdTiers, 10000)`
- SSD-кандидаты: `lsblk -d -o NAME,SIZE,ROTA,TYPE --json` → фильтр `rota=false`, не в `/proc/mdstat`
- Создание кеша: 8 шагов (pvcreate×2 → vgcreate → lvcreate data_lv → lvcreate cache_meta(512M) → lvcreate cache_data → lvconvert cache-pool → lvconvert cache)
- Откат при ошибке: `vgremove -f <vgName>`
- VG именование: `rusnas_vg<N>` (N = count existing vgs)
- Режимы: writethrough (безопасный, по умолчанию) / writeback (требует ИБП — показывает предупреждение)

**Critical disks.js notes (SSD tier):**
- `getSsdCandidates()` uses lsblk JSON + filters mdstat members — returns `[{dev, size}]`
- `getSsdTierStatus(vgName, lvName)` parses `lvs --noheadings -o ...cache_read_hits...` — 8 fields
- Hit rate = `read_hits / (read_hits + read_misses) * 100`
- Cache fill = `cache_used_blocks / cache_total_blocks * 100`
- `loadSsdTiers()` reads `/etc/rusnas/ssd-tiers.json` via `cockpit.file().read()` (no superuser needed — file is 644)
- `saveSsdTier()` / `removeSsdTierFromJson()` write via `cockpit.file(path, {superuser:"require"}).replace()`
- Progress log via `appendSsdLog(logId, msg)` — separate from RAID's `appendCreateLog`

### ✅ FileBrowser Quantum (реализовано 2026-03-19, ветка feature/filebrowser)

Веб-файловый менеджер для просмотра файлов шар через браузер. Открывается в новой вкладке по `/files/`.

**Архитектура:**
```
Браузер → Apache :80 → /files/ → FileBrowser :8088 (127.0.0.1)
```

**Компоненты:**
- Бинарник: `/usr/local/bin/filebrowser` (v2.31.2, Go)
- Конфиг: `/etc/rusnas/filebrowser/settings.json` (port 8088, baseURL="/files", root="/")
- БД: `/var/lib/rusnas/filebrowser/users.db` (BoltDB)
- Сервис: `rusnas-filebrowser.service` (user: rusnas-fb)
- Apache proxy: `/etc/apache2/sites-enabled/rusnas-filebrowser.conf`
- Admin pass: `rusnas_admin_2026`, пользователи: `rusnas_<user>_2026`

**Скрипты:**
- `install-filebrowser.sh` — деплой (бинарник на Mac → scp → VM)
- `cockpit/rusnas/scripts/fb-init.sh` — инициализация (admin + sync пользователей)
- `cockpit/rusnas/scripts/fb-sync-user.py` — sync одного пользователя (CLI stop/start)
- `cockpit/rusnas/scripts/fb-sync-all-users.py` — первичная синхронизация
- `cockpit/rusnas/cgi/fb-users-list.py` — список пользователей → JSON (GET API)
- `cockpit/rusnas/cgi/fb-set-user-access.py` — изменение scope (CLI stop/start)

**Критические заметки:**
- FileBrowser v2.31.2 API POST `/api/users` возвращает "invalid data type" (баг) — только GET работает
- Все write-операции (создание/обновление/удаление пользователей) через CLI с кратким `systemctl stop/start`
- API URL с baseURL prefix: `http://127.0.0.1:8088/files/api/...` (не `/api/...`)
- Apache вместо nginx: порт 80 занят Apache (лендинг)
- Token файл: `/etc/rusnas/filebrowser/admin_token` (chmod 600)
- Sudoers: `/etc/sudoers.d/rusnas-filebrowser`

**Cockpit UI:**
- Storage страница: 5-я вкладка «📁 Файловый менеджер» — управление сервисом + таблица пользователей
- Таблица шар: кнопка «📂 Файлы» → FileBrowser с path параметром
- Storage Analyzer: кнопки «Открыть» → FileBrowser deep-links
- Dashboard: карточка статуса FileBrowser в grid-4

### MCP Server + AI Agent (после репликации)
Полное ТЗ: [rusnas_mcp_ai.MD](./rusnas_mcp_ai.MD)
- MCP-сервер на Python, инструменты для всех функций NAS
- Встроенный AI-чат в Cockpit (Ollama / Claude API)
- HTTP-транспорт для внешних клиентов (Claude Desktop, Cursor)
