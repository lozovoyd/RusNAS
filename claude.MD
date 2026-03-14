# CLAUDE.md

> См. также: [project_history.md](./project_history.md) — хронология всех сессий
> UI правила и компоненты: [ui.md](./ui.md)
> Антишифровальщик: [rusnas-guard-task.md](./rusnas-guard-task.md) — ТЗ и архитектура Guard

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
│       ├── css/style.css
│       └── js/
│           ├── app.js      # Storage logic (SMB, NFS, iSCSI)
│           ├── disks.js
│           ├── users.js
│           └── guard.js    # Guard UI logic
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
├── deploy.sh               # Deploy Cockpit plugin to VM
├── install-guard.sh        # Deploy Guard daemon to VM
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

**app.js (Storage page):**
- Mount path dropdown from `findmnt --real`, filtered to `/dev/md|sd[b-z]|nvme`
- Edit `smb.conf` via `sed` range pattern `/^\[name\]/,/^\[/` (not Python regex — unreliable)
- NFS: delete old entry before adding: `sed -i '\|^/path |d'` before append (prevents duplication)

**disks.js:**
- Parse `/proc/mdstat` with states: `active` / `degraded` / `inactive` / `resyncing` / `reshaping`
  - Check BOTH `resync` AND `reshape` keywords
- Physical disk info via `sudo smartctl -i` (model, serial, S.M.A.R.T. health)
- Safe disk removal: `--fail → --remove → device/delete` with serial number confirmation
- **Replace disk** vs **Expand array** are separate operations
  - Expand: `--add` + `--grow --raid-devices=N` + auto `resize2fs`/`btrfs resize` on completion
- SCSI bus rescan: `echo "- - -" > /sys/class/scsi_host/host*/scan`
- Auto-refresh every 4 seconds during degraded or resyncing states

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

## Development Patterns

- Iterate and verify — confirm each step works before proceeding
- Transfer files via `scp`, not terminal paste (long commands get truncated)
- Test on the real VM, not theoretical correctness
- When regressions appear, check whether the last refactor broke a working approach
- Separate sessions for UI work (Cockpit plugin) vs infrastructure (Ansible)
