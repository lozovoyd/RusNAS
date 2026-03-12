# CLAUDE.md

> См. также: [project_history.md](./project_history.md) — хронология всех сессий

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
│       ├── css/style.css
│       └── js/
│           ├── app.js      # Storage logic (SMB, NFS, iSCSI)
│           ├── disks.js
│           └── users.js
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
├── deploy.sh               # Deploy plugin to VM
└── CLAUDE.md
```

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

## Development Patterns

- Iterate and verify — confirm each step works before proceeding
- Transfer files via `scp`, not terminal paste (long commands get truncated)
- Test on the real VM, not theoretical correctness
- When regressions appear, check whether the last refactor broke a working approach
- Separate sessions for UI work (Cockpit plugin) vs infrastructure (Ansible)
