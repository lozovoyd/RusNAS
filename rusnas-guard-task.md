# Task: rusnas-guard — Ransomware Protection Daemon for rusNAS

## Overview

`rusnas-guard` is a system daemon that monitors file activity on rusNAS shares and detects ransomware-like behavior using multiple detection methods. It integrates with the rusNAS Cockpit plugin as a new page section.

The daemon is **protocol-agnostic**: detection is based on inotify/fanotify at the kernel level, so it covers SMB, NFS, FTP, WebDAV, and local access equally.

---

## Architecture

### Daemon: `rusnas-guard`

- Written in **Python 3** (available on Debian 13, low dependency footprint)
- Runs as a **systemd service**: `rusnas-guard.service`
- Communicates with the Cockpit plugin via a **Unix socket** (`/run/rusnas-guard/control.sock`)
- Persists configuration in `/etc/rusnas-guard/config.json`
- Writes structured event log to `/var/log/rusnas-guard/events.jsonl` (JSON Lines)
- State file (current mode, stats) at `/run/rusnas-guard/state.json`

### Cockpit Plugin Page: `guard.html` / `js/guard.js`

New page in the rusNAS Cockpit plugin, order 4 in manifest.json.

---

## Detection Methods

Each method can be **independently enabled or disabled** via configuration.

### 1. Honeypot Files

Create hidden "bait" files inside each monitored directory. The files are named with low ASCII characters so they appear first in directory enumeration (e.g. `!~rusnas_guard_bait_a8f3.docx`, `!~rusnas_guard_bait_k2x9.xlsx`). Multiple file types and sizes to keep ransomware busy.

**Trigger:** any modification, rename, or deletion of a bait file = immediate alert regardless of other thresholds.

**Implementation:**
- On daemon start: scan all monitored paths, create bait files if missing
- Bait files are recreated automatically if deleted (after alert is fired)
- Store bait file names in config so they survive restarts
- Bait directory names should NOT contain words like "honeypot", "bait", "guard"

### 2. Entropy Analysis

On `IN_CLOSE_WRITE` event: read 16 random 4KB blocks from the modified file, compute Shannon entropy.

**Trigger:** entropy > 7.2 bits/byte (configurable threshold).

**Exclusions (skip entropy check, not worth computing):**
- Files with extensions: `.mp4`, `.mkv`, `.avi`, `.mov`, `.mp3`, `.flac`, `.zip`, `.gz`, `.bz2`, `.xz`, `.7z`, `.rar`, `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`
- Files smaller than 16KB (too small for reliable entropy)

**Performance:** sampling 16×4KB = 64KB max read per file. At 50 events/sec this is ~3MB/sec I/O — negligible.

**Rate limiting:** if events arrive faster than 200/sec from a single source path, skip entropy and rely on IOPS anomaly detection instead.

### 3. IOPS Anomaly Detection

Track file operation counts (create, write, rename, delete) in a **60-second sliding window** per monitored volume.

**Baseline:** computed over the first 7 days of operation (configurable). Stored as median + stddev per hour-of-day (to account for business hours vs night).

**Trigger:** current rate > baseline_median + 4×stddev AND rate > 50 ops/min (configurable minimum, to avoid false positives on fresh installs with no baseline).

During the first 7 days (baseline learning period): IOPS anomaly detection is disabled, all other methods work normally.

### 4. Known Ransomware Extensions

Maintain a list of known ransomware file extensions (e.g. `.locky`, `.cerber`, `.crypt`, `.encrypted`, `.enc`, `.locked`, `.wnry`, `.wncry`, etc.).

**Trigger:** any file created or renamed TO a known ransomware extension.

**Update mechanism:** list is stored in `/etc/rusnas-guard/ransom_extensions.txt`, one extension per line. Admin can update manually or via UI. Do NOT auto-update from external URLs in the daemon itself (security risk — separate maintenance task).

Include ~200 known extensions in the default list at install time, sourced from public lists (fsrm.experiant.ca format).

---

## Response Modes

Three modes, switchable from the UI (requires guard PIN):

### Mode 1: Monitor
- Log all detections to events log
- Send notifications (email + Telegram) per notification settings
- **No automatic blocking**

### Mode 2: Active
On detection trigger:
1. Create Btrfs snapshot of affected volume immediately (`btrfs subvolume snapshot`)
2. If replication configured: initiate async replication to remote NAS via `btrfs send | ssh`
3. Block the source IP via nftables: `nft add rule inet filter input ip saddr <IP> drop`
4. For SMB: `smbcontrol smbd close-share <sharename>` to drop active connections from that IP
5. Send notification with details: which files, which IP, which detection method triggered, snapshot name
6. Log event

### Mode 3: Super-Safe
On detection trigger:
1. Create Btrfs snapshot of ALL volumes immediately
2. If replication configured: initiate async replication
3. Send notification
4. Log event
5. Stop all file services: `systemctl stop smbd nmbd nfs-kernel-server vsftpd apache2 rsyncd`
6. Wait 30 seconds (allow notifications to be delivered and replication to start)
7. Execute: `systemctl poweroff`

**Super-safe mode requires explicit confirmation in the UI when enabling** — show a warning dialog: "This mode will shut down the entire device when an attack is detected. Are you sure?"

---

## Guard PIN

A separate PIN/password stored as bcrypt hash in `/etc/rusnas-guard/guard.pin`.

Required for:
- Starting the daemon
- Stopping the daemon
- Changing the response mode
- Changing any detection settings
- Acknowledging and clearing alerts

The Cockpit admin password does NOT grant access to guard controls. This is intentional — even if an attacker compromises the admin account, they cannot disable the guard.

**PIN setup:** on first visit to the Guard page, if no PIN is set, prompt to create one. PIN must be at least 6 characters.

**PIN verification:** Cockpit plugin sends PIN to daemon via Unix socket. Daemon verifies bcrypt hash. Returns `{"ok": true}` or `{"ok": false}`. Session token valid for 30 minutes (stored in daemon memory only, not persisted).

---

## Snapshot Configuration

Configurable per-volume:

```json
{
  "snapshot": {
    "enabled": true,
    "local": true,
    "remote": {
      "enabled": false,
      "host": "192.168.1.100",
      "user": "rusnas",
      "path": "/mnt/backup_pool",
      "ssh_key": "/etc/rusnas-guard/replication_key"
    }
  }
}
```

Remote replication uses `btrfs send` piped over SSH. SSH key is generated on first save of remote config (`ssh-keygen -t ed25519`). UI shows the public key for the admin to add to the remote NAS.

---

## Monitored Paths

Admin configures which paths to monitor. Default: all Btrfs mount points found via `findmnt --real -t btrfs`.

Each path entry:
```json
{
  "path": "/mnt/data",
  "enabled": true,
  "honeypot": true,
  "entropy": true,
  "iops": true,
  "extensions": true
}
```

---

## Cockpit Plugin: Guard Page (`guard.html` / `js/guard.js`)

### Layout

**Top bar:**
- Daemon status indicator: green "Running" / red "Stopped" / yellow "Starting"
- Start / Stop buttons (both require PIN dialog)
- Current mode selector: Monitor / Active / Super-Safe (requires PIN, Super-Safe shows confirmation dialog)

**PIN Dialog:** modal overlay, simple password input, submits to daemon socket.

### Dashboard Section

Real-time stats, refreshed every 5 seconds via `guardCmd("status")` через Unix socket:

- **Events today** — count of detection events in last 24h
- **Current IOPS** — ops/min across all monitored volumes (live, обновляется каждую секунду через `_update_state()` в daemon)
- **Baseline status** — "Обучение (день N из 7)" or "Активен"
- **Last snapshot** — timestamp of last auto-snapshot
- **Monitored paths** — count of active paths
- **Active blocks** — count of currently blocked IPs

> **Реализовано иначе:** в ТЗ предполагалось чтение `state.json` через `cockpit.file().watch()`. В реальности все данные приходят через socket `cmd=status`. Это надёжнее — нет race conditions при записи файла.

**Event Log Table** (last 50 events, newest first):
| Time | Path | Method | Source IP | Action Taken | Status |
|------|------|--------|-----------|--------------|--------|

Each row expandable to show: affected files list, entropy value if applicable, IOPS rate.

**Acknowledge button** per event (requires PIN) — marks event as reviewed, removes IP block if in Active mode.

**"Clear all blocks"** button (requires PIN) — removes all nftables rules added by the guard.

### Detection Settings Section

Toggle switches for each detection method (require PIN to change):
- Honeypot files: on/off
- Entropy analysis: on/off + threshold slider (6.5–7.5 bits/byte, default 7.2)
- IOPS anomaly: on/off + sensitivity (multiplier: 2×/3×/4× stddev)
- Known extensions: on/off + link to view/edit extension list

### Monitored Paths Section

Table of monitored paths with per-path toggles for each detection method.
"Add path" button — directory picker (text input).
"Remove" button per path.

### Snapshot Settings Section

Per-volume snapshot configuration:
- Local snapshot: on/off
- Remote replication: on/off, host/user/path fields
- "Generate SSH key" button — calls daemon to generate key, shows public key in textarea for copy

### Notifications

Reuse the existing rusNAS notification settings (email + Telegram) — guard uses the same configured channels. No separate notification config needed.

---

## Daemon Socket Protocol

Simple JSON over Unix socket. Each message is a single JSON object followed by newline.

**Сокет:** `/run/rusnas-guard/control.sock`, права **0o666** — доступен без root. Безопасность обеспечивается PIN-аутентификацией, а не правами ФС.

**Аутентификация:**
- Unauthenticated commands (без PIN): `status`, `get_events`, `get_config`, `has_pin`, `set_pin_initial`
- Authenticated commands: всё остальное. Принимают `pin` или `token`. При успехе возвращают новый `token` (TTL 30 мин, только в памяти daemon).

**Requests:**
```json
{"cmd": "status"}
{"cmd": "has_pin"}
{"cmd": "set_pin_initial", "pin": "123456"}
{"cmd": "auth", "pin": "123456"}
{"cmd": "start", "token": "..."}
{"cmd": "stop", "token": "..."}
{"cmd": "set_mode", "mode": "active", "token": "..."}
{"cmd": "get_events", "limit": 50}
{"cmd": "acknowledge", "event_id": "abc123", "token": "..."}
{"cmd": "clear_blocks", "token": "..."}
{"cmd": "set_config", "config": {...}, "token": "..."}
{"cmd": "get_config"}
{"cmd": "generate_ssh_key", "token": "..."}
{"cmd": "change_pin", "new_pin": "...", "token": "..."}
{"cmd": "acknowledge_post_attack", "token": "..."}
```

**Response:**
```json
{"ok": true, "data": {...}}
{"ok": false, "error": "Invalid PIN or session expired"}
```

**Важно (UI):** Функция `requirePin()` в guard.js **всегда** показывает PIN-диалог для sensitive операций, даже если session token уже есть. Это намеренно — двойная проверка для критических действий.

---

## File Structure

```
/etc/rusnas-guard/
    config.json          # main configuration
    guard.pin            # bcrypt hash of PIN
    ransom_extensions.txt # known ransomware extensions list
    replication_key      # SSH private key for remote replication
    replication_key.pub  # SSH public key

/var/log/rusnas-guard/
    events.jsonl         # append-only JSON Lines event log

/run/rusnas-guard/
    control.sock         # Unix domain socket
    state.json           # current runtime state (daemon writes, UI reads)

/usr/lib/rusnas-guard/
    guard.py             # main daemon
    detector.py          # inotify watcher + detection logic
    entropy.py           # entropy computation
    honeypot.py          # honeypot management
    response.py          # blocking, snapshots, notifications
    socket_server.py     # Unix socket server

/usr/share/cockpit/rusnas/
    guard.html
    js/guard.js

/lib/systemd/system/
    rusnas-guard.service
```

---

## systemd Service

```ini
[Unit]
Description=rusNAS Guard - Ransomware Protection Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/lib/rusnas-guard/guard.py
Restart=on-failure
RestartSec=5
User=root
RuntimeDirectory=rusnas-guard
RuntimeDirectoryMode=0755

[Install]
WantedBy=multi-user.target
```

> **Реализовано:** `RuntimeDirectory=rusnas-guard` автоматически создаёт `/run/rusnas-guard/` при запуске сервиса и удаляет его при остановке. `RuntimeDirectoryMode=0755` обязателен — без этого Cockpit bridge (не-root) не может подключиться к сокету, даже если сам сокет имеет права 0o666.

**Daemon lifecycle (отличие от ТЗ):**

В ТЗ предполагалось, что Start/Stop кнопки включают/выключают systemd-сервис. В реальности реализовано иначе:

- **systemd-сервис запущен всегда** (enabled=true на старте). Процесс не останавливается.
- **Start** в UI (`cmd=start`) запускает внутренний **Detector thread** — inotify watcher начинает мониторинг.
- **Stop** в UI (`cmd=stop`) останавливает Detector thread — мониторинг прекращается, но сокет-сервер остаётся доступен.

Преимущество: UI всегда может подключиться к сокету и прочитать статус, даже когда мониторинг выключен. Нет race condition между остановкой systemd и следующим обращением UI.

**Default state:** disabled. On fresh install the daemon is installed but not enabled (`systemctl disable rusnas-guard`).

Post-attack behavior: daemon writes `/etc/rusnas-guard/post_attack` flag before initiating shutdown. On next start, if flag exists, daemon starts in Monitor mode only and shows warning banner in UI. Admin must acknowledge (with PIN) to clear the flag.

---

## Dependencies

All available in Debian 13:
- `python3-inotify` (inotify bindings)
- `python3-bcrypt` (PIN hashing)
- `btrfs-progs` (snapshot commands)
- `nftables` (IP blocking)
- `openssh-client` (remote replication)

---

## Acceptance Criteria

1. Daemon starts and stops only with correct PIN from Cockpit UI.
2. All four detection methods work independently (each can be disabled without affecting others).
3. Honeypot files are created in each monitored path on daemon start and recreated after deletion.
4. Entropy check fires on high-entropy file writes (test: write random bytes to a file).
5. IOPS anomaly fires when operation rate exceeds configured threshold (test: `for i in $(seq 1 1000); do touch /mnt/data/test_$i; done`).
6. Known extensions trigger immediately on file rename to `.locked`, `.encrypted`, etc.
7. In Monitor mode: no blocking occurs, only logging and notifications.
8. In Active mode: source IP is blocked via nftables and snapshot is created on detection.
9. In Super-Safe mode: after detection — snapshot, stop services, poweroff. Test with dry-run flag.
10. Dashboard shows live IOPS and event log with 5-second refresh.
11. Acknowledge clears IP block and marks event as reviewed.
12. Remote replication SSH key generation works and public key is shown in UI.
13. Guard PIN is independent of Cockpit admin credentials.
14. Daemon CPU usage < 5% under normal load (50 file ops/min across all shares).
15. No regressions in existing rusNAS plugin pages (storage, disks, users).

---

## Known Bugs Fixed During Implementation

| Баг | Причина | Исправление |
|-----|---------|-------------|
| IOPS counter always 0 | `InotifyTrees` возвращает `watch_path` = поддиректория события (`/mnt/data/docs`), а `_iops_windows` заполнен ключами root-путей (`/mnt/data`) | Добавлен `_root_path(watch_path)` хелпер; нормализует поддиректорию до корневого пути перед lookup |
| Detector thread крашится молча | `_iops_windows[watch_path]` → `KeyError` на первом событии в поддиректории, поток падает | Та же причина; исправлено тем же фиксом |
| `current_iops` не обновляется без событий | `_update_state()` в guard.py не вызывал `get_iops()` — счётчик обновлялся только при inotify-событии | `_update_state()` теперь вызывает `self._detector.get_iops()` каждую секунду |
| Socket timeout при `superuser: "require"` | Cockpit polkit-эскалация не propagates между iframe Guard и shell когда admin уже разблокирован на другой странице | Убрано `superuser: "require"` из `cockpit.channel()`; сокет `chmod 0o666`; безопасность — PIN |
| Extensions list показывает "Файл не найден" | `/etc/rusnas-guard/` был `chmod 700`; Cockpit bridge (не-root) не мог войти в директорию | `chmod 755 /etc/rusnas-guard/` при установке |
| `/run/rusnas-guard/` пропадает после ребута | Tmpfs очищается при перезагрузке, папка не пересоздавалась | `RuntimeDirectory=rusnas-guard` в systemd unit автоматически создаёт папку при старте сервиса |

## Out of Scope

- iSCSI block-level entropy monitoring (future task — requires different approach at block device level)
- Machine learning model (future task)
- Auto-update of ransomware extension list from external URLs
- Windows FSRM integration
- Anti-virus scanning (separate feature: vfs_virusfilter + ClamAV)
