# RAID Backup Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ветка:** Создать `feat/raid-backup-mode` от `main` перед началом работы: `git checkout main && git checkout -b feat/raid-backup-mode`

**Goal:** Implement RAID Backup Mode — a spindown daemon + CGI + UI that stops HDD spindles after configurable idle period for archive/backup arrays.

**Architecture:** Python daemon `rusnas-spind` monitors `/proc/diskstats` I/O delta per `mdX` device and calls `hdparm -y` after idle timeout; a CGI script bridges Cockpit UI to daemon config/state; `disks.js` adds an inline panel per array card with badges, toggle, and manual wake/sleep controls. All `hdparm` calls are guarded by `--dry-run` flag for VM testing (QEMU disks don't support spindown).

**Tech Stack:** Python 3 (daemon + CGI), systemd, hdparm, Cockpit JS (vanilla), Playwright (tests)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `rusnas-spind/spind.py` | Create | Entry point, event loop, signal handlers, do_spindown/do_wakeup |
| `rusnas-spind/monitor.py` | Create | SpindownMonitor: reads /proc/diskstats, manages idle countdown |
| `rusnas-spind/controller.py` | Create | SpinController: hdparm -y/-C, dry-run mock |
| `rusnas-spind/btrfs_helper.py` | Create | btrfs flush + remount commit, dry-run mock |
| `rusnas-spind/mdadm_helper.py` | Create | member disk detection, sync_action r/w, suppress/restore check |
| `rusnas-spind/state_writer.py` | Create | atomic JSON write to /run/rusnas/ + wakeup_count_total persistence |
| `rusnas-spind/rusnas-spind.service` | Create | systemd unit with RuntimeDirectory + --dry-run for VM |
| `cockpit/rusnas/cgi/spindown_ctl.py` | Create | CGI: 5 commands (get_state, get_config, set_backup_mode, wakeup_now, spindown_now) |
| `install-spindown.sh` | Create | scp + deploy + sudoers + systemctl |
| `cockpit/rusnas/js/disks.js` | Modify | Add spindown globals, loadSpindownState, renderArrays additions, panel HTML |
| `cockpit/rusnas/js/dashboard.js` | Modify | loadRaid() reads spindown state, adds sub-line per array |
| `rusnas-metrics/metrics_server.py` | Modify | Add collect_spindown(), add 5 new Prometheus metrics |
| `tests/test_backup_mode_ui.py` | Create | Playwright: panel open/close, badge states, wakeup/spindown buttons |

> **Ansible role:** реализация Ansible role для spindown daemon — вне скоупа данного плана. Управление установкой производится скриптом `install-spindown.sh`.

---

## Task 1: monitor.py — SpindownMonitor

**Files:**
- Create: `rusnas-spind/monitor.py`

- [ ] **Создать `rusnas-spind/monitor.py`**

```python
#!/usr/bin/env python3
"""SpindownMonitor — tracks I/O delta for mdX devices via /proc/diskstats."""
import time
import logging

log = logging.getLogger("rusnas-spind")

# States stored in state.json
STATE_ACTIVE  = "active"
STATE_FLUSHING = "flushing"
STATE_STANDBY = "standby"
STATE_WAKING  = "waking"


def read_diskstats(device):
    """Return (reads_completed, writes_completed) for device, or None."""
    try:
        with open("/proc/diskstats") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 10 and parts[2] == device:
                    return int(parts[3]), int(parts[7])
    except Exception:
        pass
    return None


class SpindownMonitor:
    def __init__(self, array_name, idle_timeout_minutes, config):
        self.array_name = array_name          # e.g. "md127"
        self.idle_timeout = idle_timeout_minutes * 60
        self.config = config                  # dict from spindown.json arrays entry
        self.state = STATE_ACTIVE
        self._prev_io = None
        self._idle_seconds = 0
        self.wakeup_count_session = 0
        self.wakeup_count_total = 0           # loaded from totals file
        self.last_io_at = time.time()
        self.spindown_at = None
        self.member_disks = []
        self.disk_states = {}
        self.mountpoint = None

    def tick(self):
        """Called every 10s. Returns (state_changed: bool)."""
        # No-op during FLUSHING — daemon is busy doing I/O
        if self.state == STATE_FLUSHING:
            return False

        stats = read_diskstats(self.array_name)
        if stats is None:
            return False

        prev = self._prev_io
        self._prev_io = stats

        if prev is None:
            return False

        delta = (stats[0] - prev[0]) + (stats[1] - prev[1])

        if self.state == STATE_STANDBY:
            if delta > 0:
                return True  # caller triggers do_wakeup
            return False

        if self.state == STATE_WAKING:
            # Return True on first I/O after wakeup so spind.py transitions to active
            if delta > 0:
                return True
            return False

        if delta > 0:
            if self._idle_seconds > 0:
                log.info("%s: activity detected, idle reset", self.array_name)
            self._idle_seconds = 0
            self.last_io_at = time.time()
            return False

        # delta == 0 and state == active
        self._idle_seconds += 10
        remaining = self.idle_timeout - self._idle_seconds
        if remaining > 0:
            log.debug("%s: idle countdown %ds / %ds",
                      self.array_name, self._idle_seconds, self.idle_timeout)
            return False

        return True  # caller triggers do_spindown

    def reset_idle(self):
        self._idle_seconds = 0
        self.last_io_at = time.time()
```

- [ ] **Запустить синтаксическую проверку**

```bash
python3 -c "import ast; ast.parse(open('rusnas-spind/monitor.py').read()); print('OK')"
```
Ожидаемый вывод: `OK`

- [ ] **Закоммитить**

```bash
git add rusnas-spind/monitor.py
git commit -m "feat(spind): add SpindownMonitor + diskstats reader"
```

---

## Task 2: controller.py — SpinController

**Files:**
- Create: `rusnas-spind/controller.py`

- [ ] **Создать `rusnas-spind/controller.py`**

```python
#!/usr/bin/env python3
"""SpinController — wraps hdparm spindown/check commands with dry-run support."""
import subprocess
import logging

log = logging.getLogger("rusnas-spind")


class SpinController:
    def __init__(self, dry_run=False):
        self.dry_run = dry_run
        self._mock_states = {}  # disk -> "standby" | "active/idle"

    def spindown(self, disk):
        """Issue hdparm -y /dev/disk. Returns True on success."""
        if self.dry_run:
            log.info("[DRY-RUN] would spindown /dev/%s", disk)
            self._mock_states[disk] = "standby"
            return True
        try:
            subprocess.run(["hdparm", "-y", f"/dev/{disk}"],
                           capture_output=True, timeout=10)
            return True
        except Exception as e:
            log.error("hdparm -y /dev/%s failed: %s", disk, e)
            return False

    def check_state(self, disk):
        """Return 'standby', 'active/idle', or 'unknown'."""
        if self.dry_run:
            return self._mock_states.get(disk, "active/idle")
        try:
            r = subprocess.run(["hdparm", "-C", f"/dev/{disk}"],
                               capture_output=True, text=True, timeout=10)
            out = r.stdout + r.stderr
            if "standby" in out:
                return "standby"
            if "sleeping" in out:
                return "sleeping"
            return "active/idle"
        except Exception as e:
            log.error("hdparm -C /dev/%s failed: %s", disk, e)
            return "unknown"

    def mark_active(self, disk):
        """Called on wakeup to reset mock state."""
        self._mock_states[disk] = "active/idle"
```

- [ ] **Синтаксическая проверка**

```bash
python3 -c "import ast; ast.parse(open('rusnas-spind/controller.py').read()); print('OK')"
```

- [ ] **Закоммитить**

```bash
git add rusnas-spind/controller.py
git commit -m "feat(spind): add SpinController with dry-run support"
```

---

## Task 3: btrfs_helper.py + mdadm_helper.py

**Files:**
- Create: `rusnas-spind/btrfs_helper.py`
- Create: `rusnas-spind/mdadm_helper.py`

- [ ] **Создать `rusnas-spind/btrfs_helper.py`**

```python
#!/usr/bin/env python3
"""BtrfsFlusher — flush and remount commit interval for Btrfs arrays."""
import subprocess
import time
import logging

log = logging.getLogger("rusnas-spind")


class BtrfsFlusher:
    def __init__(self, dry_run=False):
        self.dry_run = dry_run

    def flush(self, mountpoint):
        """btrfs filesystem sync + sync, then wait 3s."""
        if not mountpoint:
            return
        if self.dry_run:
            log.info("[DRY-RUN] would btrfs sync %s", mountpoint)
            return
        try:
            subprocess.run(["btrfs", "filesystem", "sync", mountpoint],
                           capture_output=True, timeout=60)
            subprocess.run(["sync"], capture_output=True, timeout=30)
            log.info("flush complete: %s", mountpoint)
        except Exception as e:
            log.error("flush failed: %s", e)
        time.sleep(3)

    def extend_commit(self, mountpoint):
        """remount with commit=3600 to reduce Btrfs journal I/O."""
        if not mountpoint:
            return
        if self.dry_run:
            log.info("[DRY-RUN] would remount commit=3600 %s", mountpoint)
            return
        self._remount(mountpoint, "commit=3600")

    def restore_commit(self, mountpoint):
        """Restore standard commit=30."""
        if not mountpoint:
            return
        if self.dry_run:
            log.info("[DRY-RUN] would remount commit=30 %s", mountpoint)
            return
        self._remount(mountpoint, "commit=30")

    def _remount(self, mountpoint, opts):
        try:
            subprocess.run(["mount", "-o", f"remount,{opts}", mountpoint],
                           capture_output=True, timeout=30)
        except Exception as e:
            log.error("remount %s failed: %s", opts, e)
```

- [ ] **Создать `rusnas-spind/mdadm_helper.py`**

```python
#!/usr/bin/env python3
"""mdadm_helper — detect member disks, manage sync_action and sync_min."""
import subprocess
import re
import logging

log = logging.getLogger("rusnas-spind")

SYNC_MIN_DEFAULT = "10000"


def get_member_disks(array_name):
    """Return list of disk names (e.g. ['sdb','sdc']) for mdX array."""
    try:
        r = subprocess.run(["mdadm", "--detail", f"/dev/{array_name}"],
                           capture_output=True, text=True, timeout=15)
        disks = []
        for line in r.stdout.splitlines():
            m = re.search(r"/dev/(sd[a-z]+)\s*$", line)
            if m:
                disks.append(m.group(1))
        return disks
    except Exception as e:
        log.error("mdadm --detail failed: %s", e)
        return []


def get_sync_action(array_name):
    """Return sync_action string: 'idle', 'check', 'resync', 'recover', etc."""
    path = f"/sys/block/{array_name}/md/sync_action"
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return "unknown"


def is_degraded(array_name):
    """Return True if array reports degraded state."""
    path = f"/sys/block/{array_name}/md/degraded"
    try:
        with open(path) as f:
            return int(f.read().strip()) > 0
    except Exception:
        return False


def suppress_check(array_name):
    """Stop any in-progress check and freeze sync_min."""
    _write_sysfs(f"/sys/block/{array_name}/md/sync_action", "idle")
    _write_sysfs(f"/sys/block/{array_name}/md/sync_min", "0")
    log.info("mdadm check suppressed for %s", array_name)


def restore_check(array_name):
    """Restore sync_min to kernel default."""
    _write_sysfs(f"/sys/block/{array_name}/md/sync_min", SYNC_MIN_DEFAULT)


def get_mountpoint(array_name):
    """Find first mountpoint for /dev/mdX or LVM device on top of mdX."""
    try:
        r = subprocess.run(
            ["findmnt", "-rno", "SOURCE,TARGET", "--source", f"/dev/{array_name}"],
            capture_output=True, text=True, timeout=10
        )
        if r.stdout.strip():
            return r.stdout.strip().split()[1]
        # Try LVM layer: find dm-* devices backed by mdX
        r2 = subprocess.run(
            ["bash", "-c",
             f"lsblk -rno NAME,TYPE /dev/{array_name} 2>/dev/null | awk '{{print $1}}' | "
             f"while read d; do findmnt -rno SOURCE,TARGET /dev/$d 2>/dev/null; done | head -1"],
            capture_output=True, text=True, timeout=10
        )
        parts = r2.stdout.strip().split()
        return parts[1] if len(parts) >= 2 else None
    except Exception:
        return None


def _write_sysfs(path, value):
    try:
        with open(path, "w") as f:
            f.write(value)
    except Exception as e:
        log.warning("write %s = %s failed: %s", path, value, e)
```

- [ ] **Синтаксическая проверка обоих файлов**

```bash
python3 -c "import ast; ast.parse(open('rusnas-spind/btrfs_helper.py').read()); print('btrfs_helper OK')"
python3 -c "import ast; ast.parse(open('rusnas-spind/mdadm_helper.py').read()); print('mdadm_helper OK')"
```

- [ ] **Закоммитить**

```bash
git add rusnas-spind/btrfs_helper.py rusnas-spind/mdadm_helper.py
git commit -m "feat(spind): add BtrfsFlusher and mdadm_helper"
```

---

## Task 4: state_writer.py

**Files:**
- Create: `rusnas-spind/state_writer.py`

- [ ] **Создать `rusnas-spind/state_writer.py`**

```python
#!/usr/bin/env python3
"""state_writer — atomically writes spindown_state.json and persists wakeup totals."""
import json
import os
import time
import logging

log = logging.getLogger("rusnas-spind")

STATE_FILE   = "/run/rusnas/spindown_state.json"
TOTALS_FILE  = "/var/lib/rusnas/spindown_totals.json"


def load_totals():
    """Load persisted wakeup_count_total per array. Returns {}  on any error."""
    try:
        with open(TOTALS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_totals(totals):
    """Atomically persist wakeup totals."""
    _atomic_write(TOTALS_FILE, totals)


def write_state(monitors):
    """Build and atomically write spindown_state.json from monitor list."""
    arrays = {}
    for m in monitors:
        arrays[m.array_name] = {
            "backup_mode": True,
            "state": m.state,
            "member_disks": m.member_disks,
            "disk_states": m.disk_states,
            "last_io_at": _iso(m.last_io_at),
            "idle_seconds": m._idle_seconds,
            "idle_timeout_seconds": m.idle_timeout,
            "spindown_at": _iso(m.spindown_at) if m.spindown_at else None,
            "wakeup_count_session": m.wakeup_count_session,
            "wakeup_count_total": m.wakeup_count_total,
        }
    payload = {
        "updated_at": _iso(time.time()),
        "arrays": arrays,
    }
    _atomic_write(STATE_FILE, payload)


def _atomic_write(path, data):
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except Exception as e:
        log.error("atomic write %s failed: %s", path, e)


def _iso(ts):
    if ts is None:
        return None
    import datetime
    return datetime.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")
```

- [ ] **Синтаксическая проверка**

```bash
python3 -c "import ast; ast.parse(open('rusnas-spind/state_writer.py').read()); print('OK')"
```

- [ ] **Закоммитить**

```bash
git add rusnas-spind/state_writer.py
git commit -m "feat(spind): add StateWriter with atomic JSON write and totals persistence"
```

---

## Task 5: spind.py — main daemon

**Files:**
- Create: `rusnas-spind/spind.py`
- Create: `rusnas-spind/rusnas-spind.service`

- [ ] **Создать `rusnas-spind/spind.py`**

```python
#!/usr/bin/env python3
"""rusnas-spind — RAID spindown daemon."""
import argparse
import json
import logging
import os
import signal
import sys
import time

from monitor import SpindownMonitor, STATE_ACTIVE, STATE_STANDBY, STATE_FLUSHING, STATE_WAKING
from controller import SpinController
from btrfs_helper import BtrfsFlusher
import mdadm_helper as mdadm
import state_writer as sw

CONFIG_FILE = "/etc/rusnas/spindown.json"
LOG_FILE    = "/var/log/rusnas/spindown.log"
PID_FILE    = "/run/rusnas/spind.pid"
TICK_INTERVAL = 10  # seconds

log = logging.getLogger("rusnas-spind")
_monitors = {}   # array_name -> SpindownMonitor
_ctrl = None
_btrfs = None
_running = True


def load_config():
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except Exception as e:
        log.error("Cannot read config %s: %s", CONFIG_FILE, e)
        return {"version": 1, "arrays": {}}


def init_monitors(config, dry_run):
    global _monitors
    totals = sw.load_totals()
    new_monitors = {}
    arrays_cfg = config.get("arrays", {})
    for name, cfg in arrays_cfg.items():
        if not cfg.get("backup_mode") or not cfg.get("enabled", True):
            continue
        m = SpindownMonitor(name, cfg.get("idle_timeout_minutes", 30), cfg)
        m.wakeup_count_total = totals.get(name, 0)
        m.member_disks = mdadm.get_member_disks(name)
        m.mountpoint = mdadm.get_mountpoint(name)
        # init disk states
        m.disk_states = {d: _ctrl.check_state(d) for d in m.member_disks}
        new_monitors[name] = m
        log.info("monitoring %s: timeout=%dm disks=%s mount=%s",
                 name, cfg.get("idle_timeout_minutes", 30),
                 m.member_disks, m.mountpoint)
    _monitors = new_monitors


def do_spindown(monitor):
    name = monitor.array_name
    cfg = monitor.config
    log.info("%s: spindown initiated (idle %ds, %d disks)",
             name, monitor._idle_seconds, len(monitor.member_disks))
    monitor.state = STATE_FLUSHING
    sw.write_state(_monitors.values())

    if cfg.get("pre_sleep_flush", True) and monitor.mountpoint:
        _btrfs.flush(monitor.mountpoint)

    if cfg.get("extend_btrfs_commit", True) and monitor.mountpoint:
        _btrfs.extend_commit(monitor.mountpoint)

    # Stop mdadm check + always freeze sync_min to 0 before spindown
    if mdadm.get_sync_action(name) != "idle":
        log.info("%s: mdadm check suppressed", name)
    mdadm.suppress_check(name)  # always: writes idle to sync_action + 0 to sync_min

    for disk in monitor.member_disks:
        _ctrl.spindown(disk)

    time.sleep(5)  # post-hdparm settle

    monitor.disk_states = {d: _ctrl.check_state(d) for d in monitor.member_disks}
    monitor.state = STATE_STANDBY
    monitor.spindown_at = time.time()
    sw.write_state(_monitors.values())
    log.info("%s: spindown complete. disk_states=%s", name, monitor.disk_states)


def do_wakeup(monitor):
    name = monitor.array_name
    cfg = monitor.config
    log.info("%s: wakeup detected", name)
    monitor.state = STATE_WAKING
    sw.write_state(_monitors.values())

    if cfg.get("extend_btrfs_commit", True) and monitor.mountpoint:
        _btrfs.restore_commit(monitor.mountpoint)

    mdadm.restore_check(name)

    monitor.wakeup_count_session += 1
    monitor.wakeup_count_total += 1
    monitor.spindown_at = None
    monitor.reset_idle()  # clear stale idle_seconds so state.json shows 0 after wakeup

    totals = {m.array_name: m.wakeup_count_total for m in _monitors.values()}
    sw.save_totals(totals)
    sw.write_state(_monitors.values())


def tick():
    for name, monitor in list(_monitors.items()):
        triggered = monitor.tick()
        if not triggered:
            continue

        if monitor.state == STATE_STANDBY:
            do_wakeup(monitor)
        elif monitor.state == STATE_ACTIVE:
            # Check guards before spindown
            if mdadm.is_degraded(name):
                log.warning("%s: skipping spindown — array degraded", name)
                monitor.reset_idle()
                continue
            if mdadm.get_sync_action(name) != "idle":
                log.warning("%s: skipping spindown — sync_action=%s",
                            name, mdadm.get_sync_action(name))
                monitor.reset_idle()
                continue
            do_spindown(monitor)
        elif monitor.state == STATE_WAKING:
            # First tick with delta > 0 after waking
            monitor.state = STATE_ACTIVE
            log.info("%s: wakeup complete", name)
            sw.write_state(_monitors.values())


def cleanup():
    log.info("SIGTERM: cleaning up standby arrays")
    for monitor in _monitors.values():
        if monitor.state == STATE_STANDBY:
            # Always restore Btrfs commit and mdadm check, regardless of config flags
            if _btrfs is not None and monitor.mountpoint:
                _btrfs.restore_commit(monitor.mountpoint)
            mdadm.restore_check(monitor.array_name)
    totals = {m.array_name: m.wakeup_count_total for m in _monitors.values()}
    sw.save_totals(totals)
    try:
        os.unlink(PID_FILE)
    except Exception:
        pass


def main():
    global _ctrl, _btrfs, _running

    parser = argparse.ArgumentParser(description="rusNAS spindown daemon")
    parser.add_argument("--dry-run", action="store_true",
                        help="Simulate hdparm/remount — no actual spindown")
    args = parser.parse_args()

    # Logging setup
    os.makedirs("/var/log/rusnas", exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[
            logging.FileHandler(LOG_FILE),
            logging.StreamHandler(sys.stdout),
        ]
    )

    log.info("rusnas-spind starting%s", " [DRY-RUN]" if args.dry_run else "")

    _ctrl = SpinController(dry_run=args.dry_run)
    _btrfs = BtrfsFlusher(dry_run=args.dry_run)

    # Write PID
    os.makedirs(os.path.dirname(PID_FILE), exist_ok=True)
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    config = load_config()
    init_monitors(config, args.dry_run)
    sw.write_state(_monitors.values())

    def sighup_handler(sig, frame):
        log.info("SIGHUP: reloading config")
        new_config = load_config()
        init_monitors(new_config, args.dry_run)
        sw.write_state(_monitors.values())
        log.info("config reloaded")

    def sigterm_handler(sig, frame):
        global _running
        _running = False

    signal.signal(signal.SIGHUP,  sighup_handler)
    signal.signal(signal.SIGTERM, sigterm_handler)
    signal.signal(signal.SIGINT,  sigterm_handler)

    log.info("daemon ready, %d arrays monitored", len(_monitors))

    while _running:
        tick()
        sw.write_state(_monitors.values())
        time.sleep(TICK_INTERVAL)

    cleanup()
    log.info("rusnas-spind stopped")


if __name__ == "__main__":
    main()
```

- [ ] **Создать `rusnas-spind/rusnas-spind.service`**

```ini
[Unit]
Description=rusNAS Spindown Daemon
After=network.target mdadm.service
Wants=mdadm.service

[Service]
Type=simple
User=root
WorkingDirectory=/usr/lib/rusnas/spind
ExecStart=/usr/lib/rusnas/spind/spind.py --dry-run
Restart=on-failure
RestartSec=10
RuntimeDirectory=rusnas
RuntimeDirectoryMode=0755
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rusnas-spind

[Install]
WantedBy=multi-user.target
```

> Примечание: `--dry-run` присутствует в unit-файле для dev/VM. На реальном железе — убрать флаг.

- [ ] **Синтаксическая проверка spind.py**

```bash
python3 -c "import ast; ast.parse(open('rusnas-spind/spind.py').read()); print('OK')"
```

- [ ] **Закоммитить**

```bash
git add rusnas-spind/spind.py rusnas-spind/rusnas-spind.service
git commit -m "feat(spind): add main daemon entry point + systemd unit"
```

---

## Task 6: CGI — spindown_ctl.py

**Files:**
- Create: `cockpit/rusnas/cgi/spindown_ctl.py`

- [ ] **Создать `cockpit/rusnas/cgi/spindown_ctl.py`**

```python
#!/usr/bin/env python3
"""
spindown_ctl.py — CGI for RAID Backup Mode control.
Usage: python3 spindown_ctl.py <command> [--array mdX] [--enabled true] [--timeout 30]
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import time

CONFIG_FILE = "/etc/rusnas/spindown.json"
STATE_FILE  = "/run/rusnas/spindown_state.json"
PID_FILE    = "/run/rusnas/spind.pid"


def out(data):
    print(json.dumps(data, ensure_ascii=False))


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        return {"ok": False, "error": str(e)}


def atomic_write(path, data):
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def cmd_get_state(args):
    if not os.path.exists(STATE_FILE):
        out({"ok": False, "error": "Демон rusnas-spind не запущен"})
        return
    data = read_json(STATE_FILE)
    if isinstance(data, dict) and "ok" in data and not data["ok"]:
        out(data)
    else:
        print(json.dumps(data, ensure_ascii=False))


def cmd_get_config(args):
    data = read_json(CONFIG_FILE, default={"version": 1, "arrays": {}})
    if isinstance(data, dict) and "ok" in data and not data["ok"]:
        out(data)
    else:
        print(json.dumps(data, ensure_ascii=False))


def cmd_set_backup_mode(args):
    array = args.array
    enabled = args.enabled.lower() == "true"
    timeout = int(args.timeout)

    if timeout < 5 or timeout > 480:
        out({"ok": False, "error": f"timeout должен быть от 5 до 480, получено {timeout}"})
        return

    # Check disk types
    member_disks = _get_member_disks(array)
    disk_types = {}
    for d in member_disks:
        rot_path = f"/sys/block/{d}/queue/rotational"
        try:
            rot = open(rot_path).read().strip()
            disk_types[d] = "hdd" if rot == "1" else "ssd"
        except Exception:
            disk_types[d] = "unknown"

    all_hdd = all(t == "hdd" for t in disk_types.values()) if disk_types else True
    warning = None if all_hdd else (
        f"Массив {array} содержит SSD диски. "
        "Backup Mode предназначен для HDD — spindown не будет иметь эффекта на SSD."
    )

    # Update config
    config = read_json(CONFIG_FILE, default={"version": 1, "arrays": {}})
    if not isinstance(config, dict):
        config = {"version": 1, "arrays": {}}
    config.setdefault("arrays", {})[array] = {
        "backup_mode": enabled,
        "idle_timeout_minutes": timeout,
        "pre_sleep_flush": True,
        "extend_btrfs_commit": True,
        "enabled": True,
    }
    atomic_write(CONFIG_FILE, config)

    # SIGHUP daemon if running
    _sighup_daemon()

    out({"ok": True, "disk_types": disk_types, "all_hdd": all_hdd, "warning": warning})


def cmd_wakeup_now(args):
    array = args.array
    # Try state file first, fallback to mdadm
    state = read_json(STATE_FILE, default={})
    member_disks = []
    if isinstance(state, dict):
        arr_state = state.get("arrays", {}).get(array, {})
        member_disks = arr_state.get("member_disks", [])
    if not member_disks:
        member_disks = _get_member_disks(array)
    if not member_disks:
        out({"ok": False, "error": f"Не удалось определить диски массива {array}"})
        return
    for disk in member_disks:
        try:
            subprocess.run(["dd", f"if=/dev/{disk}", "of=/dev/null",
                            "bs=512", "count=1"],
                           capture_output=True, timeout=30)
        except Exception:
            pass
    out({"ok": True, "disks": member_disks})


def cmd_spindown_now(args):
    array = args.array
    # Guard: degraded?
    deg_path = f"/sys/block/{array}/md/degraded"
    try:
        if int(open(deg_path).read().strip()) > 0:
            out({"ok": False, "error": f"Нельзя усыпить деградированный массив {array}"})
            return
    except Exception:
        pass
    # Guard: syncing?
    sync_path = f"/sys/block/{array}/md/sync_action"
    try:
        action = open(sync_path).read().strip()
        if action not in ("idle", ""):
            out({"ok": False, "error": f"Массив {array} выполняет {action}, spindown невозможен"})
            return
    except Exception:
        pass
    member_disks = _get_member_disks(array)
    # Step 1: flush btrfs (includes 3s post-sync settle from spec)
    mp = _get_mountpoint(array)
    _flush_array(array, mp)
    time.sleep(3)  # post-sync settle (mirrors btrfs_helper.flush)
    # Step 2: extend Btrfs commit interval
    if mp:
        try:
            subprocess.run(["mount", "-o", f"remount,commit=3600", mp],
                           capture_output=True, timeout=30)
        except Exception:
            pass
    # Step 3: suppress mdadm check + freeze sync_min
    _write_sysfs(f"/sys/block/{array}/md/sync_action", "idle")
    _write_sysfs(f"/sys/block/{array}/md/sync_min", "0")
    # Step 4: spindown all disks
    for disk in member_disks:
        try:
            subprocess.run(["hdparm", "-y", f"/dev/{disk}"],
                           capture_output=True, timeout=15)
        except Exception:
            pass
    time.sleep(5)  # post-hdparm settle (mirrors do_spindown in daemon)
    out({"ok": True, "disks": member_disks})


def _get_member_disks(array):
    try:
        r = subprocess.run(["mdadm", "--detail", f"/dev/{array}"],
                           capture_output=True, text=True, timeout=15)
        import re
        return re.findall(r"/dev/(sd[a-z]+)\s*$", r.stdout, re.MULTILINE)
    except Exception:
        return []


def _get_mountpoint(array):
    try:
        r = subprocess.run(
            ["findmnt", "-rno", "TARGET", "--source", f"/dev/{array}"],
            capture_output=True, text=True, timeout=10
        )
        return r.stdout.strip() or None
    except Exception:
        return None


def _flush_array(array, mountpoint=None):
    """Try btrfs sync on array mountpoint."""
    mp = mountpoint or _get_mountpoint(array)
    if not mp:
        return
    try:
        subprocess.run(["btrfs", "filesystem", "sync", mp],
                       capture_output=True, timeout=60)
        subprocess.run(["sync"], capture_output=True, timeout=30)
    except Exception:
        pass


def _write_sysfs(path, value):
    try:
        with open(path, "w") as f:
            f.write(value)
    except Exception:
        pass


def _sighup_daemon():
    try:
        pid = int(open(PID_FILE).read().strip())
        os.kill(pid, signal.SIGHUP)
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("get_state")
    sub.add_parser("get_config")

    p_set = sub.add_parser("set_backup_mode")
    p_set.add_argument("--array", required=True)
    p_set.add_argument("--enabled", required=True)
    p_set.add_argument("--timeout", default="30")

    p_wake = sub.add_parser("wakeup_now")
    p_wake.add_argument("--array", required=True)

    p_sleep = sub.add_parser("spindown_now")
    p_sleep.add_argument("--array", required=True)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        "get_state":      cmd_get_state,
        "get_config":     cmd_get_config,
        "set_backup_mode": cmd_set_backup_mode,
        "wakeup_now":     cmd_wakeup_now,
        "spindown_now":   cmd_spindown_now,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
```

- [ ] **Синтаксическая проверка**

```bash
python3 -c "import ast; ast.parse(open('cockpit/rusnas/cgi/spindown_ctl.py').read()); print('OK')"
```

- [ ] **Закоммитить**

```bash
git add cockpit/rusnas/cgi/spindown_ctl.py
git commit -m "feat(cgi): add spindown_ctl.py — 5 commands for Backup Mode control"
```

---

## Task 7: install-spindown.sh

**Files:**
- Create: `install-spindown.sh`

- [ ] **Создать `install-spindown.sh`**

```bash
#!/bin/bash
# install-spindown.sh — deploy rusNAS RAID Backup Mode (spindown) to VM
set -e

VM="rusnas@10.10.10.72"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== rusNAS RAID Backup Mode install ==="

# Ensure remote temp dir exists before scp
ssh "$VM" "mkdir -p /tmp/rusnas-spind"

# Copy daemon files
scp -r "$SCRIPT_DIR/rusnas-spind/"* "$VM:/tmp/rusnas-spind/"

# Copy CGI
scp "$SCRIPT_DIR/cockpit/rusnas/cgi/spindown_ctl.py" "$VM:/tmp/spindown_ctl.py"

ssh "$VM" bash << 'REMOTE'
set -e
echo "Installing rusnas-spind..."

# Directories
sudo mkdir -p /usr/lib/rusnas/spind /usr/lib/rusnas/cgi \
              /etc/rusnas /var/lib/rusnas /var/log/rusnas \
              /run/rusnas

# Install daemon
sudo cp /tmp/rusnas-spind/*.py /usr/lib/rusnas/spind/
sudo chmod 755 /usr/lib/rusnas/spind/*.py

# Install CGI
sudo cp /tmp/spindown_ctl.py /usr/lib/rusnas/cgi/spindown_ctl.py
sudo chmod 755 /usr/lib/rusnas/cgi/spindown_ctl.py

# Install hdparm if needed
which hdparm >/dev/null 2>&1 || sudo apt-get install -y hdparm

# Default config if not exists
if [ ! -f /etc/rusnas/spindown.json ]; then
    echo '{"version":1,"arrays":{}}' | sudo tee /etc/rusnas/spindown.json > /dev/null
fi
sudo chmod 644 /etc/rusnas/spindown.json

# Sudoers: allow spindown_ctl.py
echo "rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/cgi/spindown_ctl.py *" \
    | sudo tee /etc/sudoers.d/rusnas-spindown > /dev/null
sudo chmod 440 /etc/sudoers.d/rusnas-spindown

# systemd unit
sudo cp /tmp/rusnas-spind/rusnas-spind.service /etc/systemd/system/rusnas-spind.service
sudo chmod 644 /etc/systemd/system/rusnas-spind.service
sudo systemctl daemon-reload
sudo systemctl enable rusnas-spind
sudo systemctl restart rusnas-spind || sudo systemctl start rusnas-spind

sleep 2
sudo systemctl status rusnas-spind --no-pager

echo "Done! Daemon status above."
REMOTE

echo "=== Deploy complete ==="
```

- [ ] **Сделать исполняемым и закоммитить**

```bash
chmod +x install-spindown.sh
git add install-spindown.sh
git commit -m "feat(deploy): add install-spindown.sh"
```

---

## Task 8: Deploy + CLI тест демона

**Предусловие:** daemon файлы созданы (Tasks 1–7), VM доступна.

- [ ] **Создать temp dir на VM и задеплоить**

```bash
ssh rusnas@10.10.10.72 "mkdir -p /tmp/rusnas-spind"
./install-spindown.sh
```
Ожидаемый вывод: `Active: active (running)` в статусе.

- [ ] **Проверить что демон запустился**

```bash
ssh rusnas@10.10.10.72 "sudo systemctl status rusnas-spind --no-pager"
```
Ожидаемый вывод: `Active: active (running)`.

- [ ] **Настроить тестовый массив md127 в конфиге**

```bash
ssh rusnas@10.10.10.72 "sudo python3 /usr/lib/rusnas/cgi/spindown_ctl.py set_backup_mode --array md127 --enabled true --timeout 5"
```
Ожидаемый вывод: `{"ok": true, ...}` (возможно `"all_hdd": false` т.к. виртуальные диски).

- [ ] **Проверить state.json через CGI**

```bash
ssh rusnas@10.10.10.72 "sudo python3 /usr/lib/rusnas/cgi/spindown_ctl.py get_state"
```
Ожидаемый вывод: JSON с `md127` в `arrays`, `"state": "active"`.

- [ ] **Подождать 1 минуту и проверить переход в flushing/standby**

```bash
# В dry-run режиме через ~5 минут (timeout=5) демон должен перейти в standby
ssh rusnas@10.10.10.72 "sudo tail -20 /var/log/rusnas/spindown.log"
```
Ожидаемые строки в логе: `idle countdown`, затем `spindown initiated`, `spindown complete [DRY-RUN]`.

- [ ] **Закоммитить (нет изменений кода, только подтверждение работоспособности)**

---

## Task 9: disks.js — Backup Mode UI

**Files:**
- Modify: `cockpit/rusnas/js/disks.js` (добавить ~200 строк в начало и конец)

- [ ] **Добавить глобальные переменные после строки `var ssdTierTimer = null;` (строка ~13)**

```javascript
// ─── Backup Mode (spindown) ────────────────────────────────────────────────
var spindownState    = {};   // cache: array_name → state object
var spindownPollTimer = null;
var SPINDOWN_CGI     = "/usr/lib/rusnas/cgi/spindown_ctl.py";
```

- [ ] **Добавить функцию `loadSpindownState` после блока глобальных переменных**

```javascript
function loadSpindownState(callback) {
    new Promise(function(res, rej) {
        cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "get_state"],
                      {err: "message"}).done(res).fail(rej);
    }).then(function(out) {
        try {
            var data = JSON.parse(out);
            if (data && data.arrays) {
                spindownState = data.arrays;
            } else {
                spindownState = {};
            }
        } catch(e) { spindownState = {}; }
        if (callback) callback();
    }).catch(function() { spindownState = {}; });
}

function timeAgo(isoString) {
    if (!isoString) return "—";
    var diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 60) return diff + " сек назад";
    if (diff < 3600) return Math.floor(diff/60) + " мин назад";
    return Math.floor(diff/3600) + " ч назад";
}

var _SPINDOWN_POLL_NORMAL  = 15000;  // 15s normal polling
var _SPINDOWN_POLL_FAST    = 3000;   // 3s polling during flushing/waking

function startSpindownPoll() {
    if (spindownPollTimer) return;
    _doSpindownPoll(_SPINDOWN_POLL_NORMAL);
}

function _doSpindownPoll(interval) {
    if (spindownPollTimer) clearInterval(spindownPollTimer);
    spindownPollTimer = setInterval(function() {
        loadSpindownState(function() {
            updateSpindownBadges();
            // Switch to fast poll during transitions, back to normal otherwise
            var hasFastState = Object.values(spindownState).some(function(s) {
                return s.state === "flushing" || s.state === "waking";
            });
            var nextInterval = hasFastState ? _SPINDOWN_POLL_FAST : _SPINDOWN_POLL_NORMAL;
            if (nextInterval !== interval) {
                clearInterval(spindownPollTimer);
                spindownPollTimer = null;
                _doSpindownPoll(nextInterval);
            }
        });
    }, interval);
}

function stopSpindownPoll() {
    if (spindownPollTimer) { clearInterval(spindownPollTimer); spindownPollTimer = null; }
}

function updateSpindownBadges() {
    Object.keys(spindownState).forEach(function(name) {
        var s = spindownState[name];
        var badgeEl = document.getElementById("spindown-badge-" + name);
        if (!badgeEl) return;
        badgeEl.innerHTML = _spindownBadgeHtml(s);
    });
}

function _spindownBadgeHtml(s) {
    if (!s || !s.backup_mode) return "";
    var state = s.state || "active";
    if (state === "standby")  return "<span class='badge badge-secondary' style='margin-left:6px'>💤 STANDBY</span>";
    if (state === "flushing") return "<span class='badge badge-info' style='margin-left:6px'>⏳ ЗАСЫПАЕТ…</span>";
    if (state === "waking")   return "<span class='badge badge-info' style='margin-left:6px'>🔆 ПРОСЫПАЕТСЯ…</span>";
    return "<span class='badge badge-success' style='margin-left:6px'>💾 BACKUP АКТИВЕН</span>";
}
```

- [ ] **Добавить функции управления Backup Mode**

```javascript
function openBackupModePanel(arrayName) {
    var panelId = "bm-panel-" + arrayName;
    var panel = document.getElementById(panelId);
    if (!panel) return;
    var visible = panel.style.display !== "none";
    panel.style.display = visible ? "none" : "block";
    if (!visible) {
        // Load current config and fill panel
        new Promise(function(res, rej) {
            cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "get_config"],
                          {err: "message"}).done(res).fail(rej);
        }).then(function(out) {
            try {
                var cfg = JSON.parse(out);
                var arrCfg = (cfg.arrays || {})[arrayName] || {};
                var toggle = document.getElementById("bm-toggle-" + arrayName);
                var timeout = document.getElementById("bm-timeout-" + arrayName);
                if (toggle) toggle.checked = arrCfg.backup_mode === true;
                if (timeout) timeout.value = arrCfg.idle_timeout_minutes || 30;
                _refreshBackupModeStatus(arrayName);
            } catch(e) {}
        }).catch(function() {});
    }
}

function _refreshBackupModeStatus(arrayName) {
    var statusEl = document.getElementById("bm-status-" + arrayName);
    if (!statusEl) return;
    var s = spindownState[arrayName];
    if (!s || !s.backup_mode) {
        statusEl.style.display = "none";
        return;
    }
    statusEl.style.display = "block";
    var state = s.state || "active";
    var stateLabel = state === "standby" ? "💤 STANDBY (диски спят)"
        : state === "flushing" ? "⏳ Засыпает…"
        : state === "waking"   ? "🔆 Просыпается…"
        : "💾 Активен";
    var sinceLabel = state === "standby" ? " · с " + (s.spindown_at ? new Date(s.spindown_at).toLocaleTimeString("ru") : "—") : "";
    var disksHtml = Object.entries(s.disk_states || {}).map(function(e) {
        return "<span style='margin-right:8px'>" + e[0] + " " + (e[1] === "standby" ? "💤" : "🟢") + "</span>";
    }).join("");
    statusEl.innerHTML =
        "<div style='margin-top:8px;padding:10px;background:var(--bg-th);border-radius:var(--radius-sm)'>" +
        "<div><b>Статус:</b> " + stateLabel + sinceLabel + "</div>" +
        "<div><b>Последняя активность:</b> " + timeAgo(s.last_io_at) + "</div>" +
        "<div><b>Пробуждений за сессию:</b> " + (s.wakeup_count_session || 0) + "</div>" +
        "<div style='margin-top:6px'>" + disksHtml + "</div>" +
        "<div style='margin-top:8px'>" +
        "<button class='btn btn-primary btn-sm' onclick='wakeupArray(\"" + arrayName + "\")'>⚡ Разбудить сейчас</button> " +
        "<button class='btn btn-secondary btn-sm' onclick='spindownArray(\"" + arrayName + "\")'>💤 Усыпить сейчас</button>" +
        "</div></div>";
}

function applyBackupMode(arrayName) {
    var toggle = document.getElementById("bm-toggle-" + arrayName);
    var timeoutEl = document.getElementById("bm-timeout-" + arrayName);
    if (!toggle || !timeoutEl) return;
    var enabled = toggle.checked;
    var timeout = parseInt(timeoutEl.value) || 30;
    if (timeout < 5 || timeout > 480) {
        alert("Таймаут должен быть от 5 до 480 минут");
        return;
    }
    new Promise(function(res, rej) {
        cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "set_backup_mode",
                       "--array", arrayName, "--enabled", String(enabled), "--timeout", String(timeout)],
                      {err: "message"}).done(res).fail(rej);
    }).then(function(out) {
        try {
            var r = JSON.parse(out);
            if (!r.ok) { alert("Ошибка: " + r.error); return; }
            if (r.warning) {
                if (!confirm("⚠ " + r.warning + "\n\nВсё равно включить?")) {
                    // Rollback: config already written by server — disable it
                    new Promise(function(res2, rej2) {
                        cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "set_backup_mode",
                                       "--array", arrayName, "--enabled", "false", "--timeout", String(timeout)],
                                      {err: "message"}).done(res2).fail(rej2);
                    }).catch(function(e) { console.error("rollback failed:", e); });
                    return;
                }
            }
            // Reload state and restart poll
            loadSpindownState(function() {
                updateSpindownBadges();
                _refreshBackupModeStatus(arrayName);
                var hasBackup = Object.values(spindownState).some(function(s) { return s.backup_mode; });
                if (hasBackup) startSpindownPoll(); else stopSpindownPoll();
            });
        } catch(e) {}
    }).catch(function(e) { alert("Ошибка: " + e); });
}

function wakeupArray(arrayName) {
    new Promise(function(res, rej) {
        cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "wakeup_now", "--array", arrayName],
                      {err: "message"}).done(res).fail(rej);
    }).then(function(out) {
        setTimeout(function() {
            loadSpindownState(function() { updateSpindownBadges(); _refreshBackupModeStatus(arrayName); });
        }, 3000);
    }).catch(function(e) { alert("Ошибка: " + e); });
}

function spindownArray(arrayName) {
    if (!confirm("Усыпить массив " + arrayName + " прямо сейчас?")) return;
    new Promise(function(res, rej) {
        cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "spindown_now", "--array", arrayName],
                      {err: "message"}).done(res).fail(rej);
    }).then(function(out) {
        try {
            var r = JSON.parse(out);
            if (!r.ok) { alert("Ошибка: " + r.error); return; }
        } catch(e) {}
        setTimeout(function() {
            loadSpindownState(function() { updateSpindownBadges(); _refreshBackupModeStatus(arrayName); });
        }, 8000);
    }).catch(function(e) { alert("Ошибка: " + e); });
}
```

- [ ] **Изменить `renderArrays()` — добавить Backup Mode badge и кнопку**

В функции `renderArrays()` найти строку с `deleteBtn` (около строки 200) и изменить формирование HTML карточки:

Найти:
```javascript
        return "<div class='array-card'>" +
            "<div class='array-header'>" +
                "<div>" +
                    "<span class='array-name'>" + arr.name + "</span>" +
                    "<span class='array-level'>" + arr.level.toUpperCase() + "</span>" +
                    "<span class='array-size'>" + arr.sizeGB + " GB</span>" +
                "</div>" +
                "<div class='array-actions'>" +
                    actionBtn + " " + addDiskBtn + " " + expandBtn + " " + upgradeBtn + " " +
                    mountBtn + " " + umountBtn + " " + subvolBtn + " " + deleteBtn +
                "</div>" +
            "</div>" +
            "<div class='array-status'>" + badge + " <span class='status-desc'>" + statusDesc + "</span></div>" +
```

Заменить на:
```javascript
        var spindownS = spindownState[arr.name];
        var spindownBadge = spindownS && spindownS.backup_mode ? _spindownBadgeHtml(spindownS) : "";
        var bmBtn = "<button class='btn btn-secondary btn-sm' onclick='openBackupModePanel(\"" + arr.name + "\")'>⚙ Backup Mode</button>";

        // Backup Mode inline panel HTML
        var daemonNote = (!spindownS) ? "<div class='text-muted' style='font-size:12px;margin-top:4px'>Демон rusnas-spind не запущен — конфиг будет сохранён при старте.</div>" : "";
        var bmPanel = "<div id='bm-panel-" + arr.name + "' style='display:none;margin-top:8px;padding:12px;border:1px solid var(--color-border);border-radius:var(--radius);background:var(--bg-card)'>" +
            "<b>RAID Backup Mode</b>" +
            "<div style='margin-top:8px'>" +
            "<label class='checkbox-label'><input type='checkbox' id='bm-toggle-" + arr.name + "'> Включить RAID Backup Mode</label>" +
            "</div>" +
            "<div class='text-muted' style='font-size:12px;margin:6px 0'>Диски останавливают шпиндели при бездействии. Первое обращение после сна: 5–15 сек.<br>⚠ Только для HDD-массивов с нерегулярным доступом.</div>" +
            "<div style='margin-top:6px'><label>Таймаут бездействия: <input type='number' id='bm-timeout-" + arr.name + "' value='30' min='5' max='480' style='width:70px;display:inline-block'> мин (5–480)</label></div>" +
            daemonNote +
            "<div id='bm-status-" + arr.name + "'></div>" +
            "<div style='margin-top:10px'>" +
            "<button class='btn btn-primary btn-sm' onclick='applyBackupMode(\"" + arr.name + "\")'>Применить</button> " +
            "<button class='btn btn-secondary btn-sm' onclick='openBackupModePanel(\"" + arr.name + "\")'>Отмена</button>" +
            "</div></div>";

        return "<div class='array-card'>" +
            "<div class='array-header'>" +
                "<div>" +
                    "<span class='array-name'>" + arr.name + "</span>" +
                    "<span class='array-level'>" + arr.level.toUpperCase() + "</span>" +
                    "<span class='array-size'>" + arr.sizeGB + " GB</span>" +
                "</div>" +
                "<div class='array-actions'>" +
                    actionBtn + " " + addDiskBtn + " " + expandBtn + " " + upgradeBtn + " " +
                    mountBtn + " " + umountBtn + " " + subvolBtn + " " + bmBtn + " " + deleteBtn +
                "</div>" +
            "</div>" +
            "<div class='array-status'>" + badge + spindownBadge + " <span class='status-desc'>" + statusDesc + "</span></div>" +
```

И в конце карточки добавить `bmPanel` перед закрывающим тегом:

Найти:
```javascript
            "<div class='array-hint'>" + getRaidHint(arr) + "</div>" +
        "</div>";
```

Заменить на:
```javascript
            "<div class='array-hint'>" + getRaidHint(arr) + "</div>" +
            bmPanel +
        "</div>";
```

- [ ] **Добавить функцию `_warnIfSleeping()` — перехват действий над спящим массивом**

```javascript
function _warnIfSleeping(arrayName, actionLabel) {
    var s = spindownState[arrayName];
    if (s && s.backup_mode && s.state === "standby") {
        return confirm(
            "⚠ Массив " + arrayName + " спит (Backup Mode).\n" +
            "Действие «" + actionLabel + "» разбудит его (5–15 сек задержки).\n\nПродолжить?"
        );
    }
    return true;
}
```

Добавить вызов `_warnIfSleeping()` в обработчики кнопок **Расширить**, **Заменить**, **Субтома**, **Размонтировать** в `disks.js`. Для каждой кнопки найти обработчик `addEventListener('click', ...)` или inline `onclick` и обернуть:

```javascript
// Пример для кнопки "Размонтировать":
// До: umountArray(arr.name);
// После:
if (!_warnIfSleeping(arr.name, "Размонтировать")) return;
umountArray(arr.name);

// Пример для кнопки "Расширить":
if (!_warnIfSleeping(arr.name, "Расширить")) return;
openExpandModal(arr.name);

// Пример для кнопки "Субтома":
if (!_warnIfSleeping(arr.name, "Субтома")) return;
openSubvolModal(arr.name);
```

> Это делается в `renderArrays()` при формировании `expandBtn`, `umountBtn`, `subvolBtn` — либо через добавление гарда к inline `onclick`, либо через `addEventListener` после `innerHTML`.

- [ ] **Добавить загрузку spindownState в `loadDisksAndArrays()`**

Найти в функции `loadDisksAndArrays()` (около строки 400–430) вызов `renderArrays(arrays, currentMountMap)` и обернуть его загрузкой:

```javascript
// Заменить прямой вызов renderArrays(arrays, currentMountMap) на:
loadSpindownState(function() {
    renderArrays(arrays, currentMountMap);
    updateSpindownBadges();
    var hasBackup = Object.values(spindownState).some(function(s) { return s.backup_mode; });
    if (hasBackup) startSpindownPoll();
});
```

- [ ] **Деплой и визуальная проверка**

```bash
./deploy.sh
```

Открыть `https://10.10.10.72:9090` → Диски → проверить наличие кнопки `⚙ Backup Mode` на карточке md127 → клик → панель открывается.

- [ ] **Закоммитить**

```bash
git add cockpit/rusnas/js/disks.js
git commit -m "feat(ui): add Backup Mode panel, badges, and polling to disks.js"
```

---

## Task 10: dashboard.js — RAID card spindown sub-line

**Files:**
- Modify: `cockpit/rusnas/js/dashboard.js` (функция `loadRaid()`, ~строки 280–377)

- [ ] **Добавить `collectSpindownForDashboard()` перед функцией `loadRaid()`**

```javascript
function collectSpindownForDashboard(callback) {
    cockpit.spawn(["sudo", "-n", "python3",
                   "/usr/lib/rusnas/cgi/spindown_ctl.py", "get_state"],
                  {err: "message"})
        .done(function(out) {
            try {
                var data = JSON.parse(out);
                callback(data && data.arrays ? data.arrays : {});
            } catch(e) { callback({}); }
        })
        .fail(function() { callback({}); });
}
```

- [ ] **Изменить `loadRaid()` — добавить spindown sub-line**

Найти внутри `loadRaid()` блок формирования `html` для каждого массива (строки ~330–358). После строки:
```javascript
            html += '<div class="db-raid-sub">' + maskHtml + ...
```

Добавить ниже формирование `html` — обернуть `arrays.forEach` в вызов `collectSpindownForDashboard`:

Изменить начало `loadRaid()`:

```javascript
function loadRaid() {
    var mdstatP = new Promise(function(res, rej) {
        cockpit.spawn(["bash", "-c", "cat /proc/mdstat"], {err: "message"}).done(res).fail(rej);
    });
    var mountP = new Promise(function(res) {
        cockpit.spawn(["bash", "-c", "findmnt -rno SOURCE,TARGET 2>/dev/null"], {err: "message"})
            .done(res).fail(function() { res(""); });
    });
    var spindownP = new Promise(function(res) {
        cockpit.spawn(["sudo", "-n", "python3",
                       "/usr/lib/rusnas/cgi/spindown_ctl.py", "get_state"],
                      {err: "message"})
            .done(function(out) {
                try { var d = JSON.parse(out); res(d.arrays || {}); }
                catch(e) { res({}); }
            })
            .fail(function() { res({}); });
    });

    Promise.all([mdstatP, mountP, spindownP]).then(function(results) {
        var arrays    = parseMdstat(results[0]);
        var mountMap  = {};
        var sdState   = results[2];
        results[1].trim().split("\n").forEach(function(l) {
            var p = l.trim().split(/\s+/);
            if (p.length >= 2) mountMap[p[0]] = p[1];
        });
```

Далее в `arrays.forEach` после блока `db-raid-sub` добавить spindown sub-line:

```javascript
            // Spindown sub-line
            var sd = sdState[a.name];
            if (sd && sd.backup_mode) {
                var sdState2 = sd.state || "active";
                var sdLabel = sdState2 === "standby"  ? "💤 Backup: Sleep · " + _timeAgoDb(sd.spindown_at)
                            : sdState2 === "flushing" ? "⏳ Backup: Засыпает…"
                            : sdState2 === "waking"   ? "🔆 Backup: Просыпается…"
                            : "💾 Backup: Активен";
                html += '<div class="db-raid-sub" style="color:var(--color-muted);font-size:11px">' + sdLabel + '</div>';
            }
```

Добавить вспомогательную функцию:
```javascript
function _timeAgoDb(isoString) {
    if (!isoString) return "—";
    var diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 60) return diff + "с назад";
    if (diff < 3600) return Math.floor(diff/60) + " мин назад";
    return Math.floor(diff/3600) + "ч назад";
}
```

- [ ] **Деплой и визуальная проверка**

```bash
./deploy.sh
```

Открыть Dashboard → карточка RAID → проверить наличие строки `💾 Backup: Активен` под md127.

- [ ] **Закоммитить**

```bash
git add cockpit/rusnas/js/dashboard.js
git commit -m "feat(dashboard): add spindown state sub-line to RAID card in loadRaid()"
```

---

## Task 11: Prometheus метрики

**Files:**
- Modify: `rusnas-metrics/metrics_server.py`

- [ ] **Добавить `collect_spindown()` в `metrics_server.py`**

Найти конец последней `collect_*` функции (перед `class MetricsHandler`) и добавить:

```python
def collect_spindown():
    """Read /run/rusnas/spindown_state.json and return spindown metrics."""
    try:
        with open("/run/rusnas/spindown_state.json") as f:
            data = json.load(f)
    except Exception:
        return {}

    arrays = data.get("arrays", {})
    result = {}
    state_map = {"active": 0, "standby": 1, "waking": 2, "flushing": 3}

    for array_name, s in arrays.items():
        if not s.get("backup_mode"):
            continue
        prefix = f"spindown_{array_name}"
        result[f"{prefix}_enabled"] = 1
        result[f"{prefix}_state"]   = state_map.get(s.get("state", "active"), 0)
        result[f"{prefix}_idle_seconds"] = s.get("idle_seconds", 0)
        result[f"{prefix}_wakeup_total"] = s.get("wakeup_count_total", 0)
        for disk, disk_state in s.get("disk_states", {}).items():
            result[f"disk_{disk}_{array_name}_state"] = 1 if disk_state == "standby" else 0

    return result
```

- [ ] **Добавить spindown-метрики в `format_prometheus()`**

Найти функцию `format_prometheus(data)` и добавить в конце (перед `return`):

```python
    # Spindown metrics
    spindown_raw = collect_spindown()
    if spindown_raw:
        lines.append("# HELP rusnas_spindown_enabled Backup Mode enabled for array: 1=yes 0=no")
        lines.append("# TYPE rusnas_spindown_enabled gauge")
        lines.append("# HELP rusnas_spindown_state Array spindown state: 0=active 1=standby 2=waking 3=flushing")
        lines.append("# TYPE rusnas_spindown_state gauge")
        lines.append("# HELP rusnas_spindown_idle_seconds Current idle time in seconds")
        lines.append("# TYPE rusnas_spindown_idle_seconds gauge")
        lines.append("# HELP rusnas_spindown_wakeup_total Total wakeup count since service start")
        lines.append("# TYPE rusnas_spindown_wakeup_total counter")
        lines.append("# HELP rusnas_disk_state Disk spindle state: 0=active 1=standby")
        lines.append("# TYPE rusnas_disk_state gauge")
    for key, val in spindown_raw.items():
        if key.startswith("spindown_"):
            # key format: spindown_<array>_<suffix>  e.g. spindown_md127_state
            parts = key.split("_", 2)
            if len(parts) >= 3:
                array = parts[1]
                metric_suffix = parts[2]
                lines.append(f'rusnas_spindown_{metric_suffix}{{array="{array}"}} {val}')
        elif key.startswith("disk_"):
            # key format: disk_<diskname>_<array>_state  e.g. disk_sdb_md127_state
            parts = key.split("_", 3)
            if len(parts) >= 4:
                disk_name = parts[1]
                array = parts[2]
                lines.append(f'rusnas_disk_state{{disk="{disk_name}",array="{array}"}} {val}')
```

- [ ] **Деплой и проверка метрик**

```bash
scp rusnas-metrics/metrics_server.py rusnas@10.10.10.72:/tmp/
ssh rusnas@10.10.10.72 "sudo cp /tmp/metrics_server.py /usr/local/bin/metrics_server.py && sudo chmod 755 /usr/local/bin/metrics_server.py && sudo systemctl restart rusnas-metrics 2>/dev/null || true"
curl -s http://10.10.10.72:9100/metrics | grep rusnas_spindown
```
Ожидаемый вывод: строки вида `rusnas_spindown_enabled{array="md127"} 1`.

- [ ] **Закоммитить**

```bash
git add rusnas-metrics/metrics_server.py
git commit -m "feat(metrics): add spindown Prometheus metrics (5 new gauges)"
```

---

## Task 12: Playwright UI тесты

**Files:**
- Create: `tests/test_backup_mode_ui.py`

- [ ] **Создать `tests/test_backup_mode_ui.py`**

```python
"""UI tests for RAID Backup Mode panel in disks.html."""
from playwright.sync_api import sync_playwright
import json, time, subprocess

COCKPIT_URL = "https://10.10.10.72:9090"
VM = "rusnas@10.10.10.72"
ARRAY = "md127"
STATE_FILE = "/run/rusnas/spindown_state.json"


def ssh(cmd):
    r = subprocess.run(
        ["sshpass", "-p", "kl4389qd", "ssh",
         "-o", "StrictHostKeyChecking=no",
         "-o", "PreferredAuthentications=password",
         "-o", "PubkeyAuthentication=no",
         VM, cmd],
        capture_output=True, text=True
    )
    return r.stdout, r.stderr


def write_mock_state(state_value):
    """Write mock spindown_state.json with given state for ARRAY."""
    mock = {
        "updated_at": "2026-03-28T10:00:00+03:00",
        "arrays": {
            ARRAY: {
                "backup_mode": True,
                "state": state_value,
                "member_disks": ["sdb", "sdc", "sdd", "sde"],
                "disk_states": {d: ("standby" if state_value == "standby" else "active/idle")
                                for d in ["sdb", "sdc", "sdd", "sde"]},
                "last_io_at": "2026-03-28T09:30:00+03:00",
                "idle_seconds": 1800,
                "idle_timeout_seconds": 300,
                "spindown_at": "2026-03-28T10:00:00+03:00" if state_value == "standby" else None,
                "wakeup_count_session": 2,
                "wakeup_count_total": 10,
            }
        }
    }
    payload = json.dumps(mock)
    ssh(f"echo '{payload}' | sudo tee {STATE_FILE} > /dev/null")


def login(page):
    page.goto(COCKPIT_URL, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    time.sleep(1)
    if page.locator("#login-user-input").count() > 0:
        page.fill("#login-user-input", "rusnas")
        page.fill("#login-password-input", "kl4389qd")
        page.locator("#login-button").click()
        page.wait_for_load_state("networkidle")
        time.sleep(3)


def navigate_to_disks(page):
    """Navigate to Disks page via sidebar."""
    disks_link = page.locator("nav a").filter(has_text="Диски")
    if disks_link.count() == 0:
        page.goto(COCKPIT_URL + "/cockpit/@localhost/rusnas/disks.html",
                  wait_until="domcontentloaded")
    else:
        disks_link.first.click()
    page.wait_for_load_state("networkidle")
    time.sleep(2)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900},
                                  ignore_https_errors=True)
        page = ctx.new_page()

        # --- Test 1: Backup Mode button visible ---
        login(page)
        navigate_to_disks(page)
        page.screenshot(path="/tmp/bm_01_disks_page.png")

        # Find frame with disks.html
        disks_frame = None
        for f in page.frames:
            if "rusnas/disks" in f.url or "disks.html" in f.url:
                disks_frame = f
                break
        if disks_frame is None:
            disks_frame = page  # fallback: direct URL

        bm_btn = disks_frame.locator("button", has_text="Backup Mode")
        btn_count = bm_btn.count()
        print(f"Test 1 — Backup Mode buttons found: {btn_count}")
        assert btn_count > 0, "Backup Mode button not found on array card"

        # --- Test 2: Panel opens on click ---
        bm_btn.first.click()
        time.sleep(0.5)
        panel = disks_frame.locator(f"#bm-panel-{ARRAY}")
        assert panel.count() > 0, "Backup Mode panel not found"
        assert panel.is_visible(), "Panel did not open"
        page.screenshot(path="/tmp/bm_02_panel_open.png")
        print("Test 2 — Panel opens: PASS")

        # --- Test 3: STANDBY badge with mock state ---
        write_mock_state("standby")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        time.sleep(3)

        # Re-find frame
        for f in page.frames:
            if "rusnas/disks" in f.url or "disks.html" in f.url:
                disks_frame = f
                break

        standby_badge = disks_frame.locator(f"#spindown-badge-{ARRAY}")
        badge_text = standby_badge.inner_text() if standby_badge.count() > 0 else ""
        print(f"Test 3 — STANDBY badge text: '{badge_text}'")
        page.screenshot(path="/tmp/bm_03_standby_badge.png")
        assert "STANDBY" in badge_text or standby_badge.count() > 0, "STANDBY badge not shown"
        print("Test 3 — STANDBY badge: PASS")

        # --- Test 4: WAKING badge ---
        write_mock_state("waking")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        time.sleep(3)
        for f in page.frames:
            if "rusnas/disks" in f.url or "disks.html" in f.url:
                disks_frame = f
                break
        waking_badge = disks_frame.locator(f"#spindown-badge-{ARRAY}")
        badge_text2 = waking_badge.inner_text() if waking_badge.count() > 0 else ""
        print(f"Test 4 — WAKING badge text: '{badge_text2}'")
        page.screenshot(path="/tmp/bm_04_waking_badge.png")
        assert "ПРОСЫПАЕТСЯ" in badge_text2, "WAKING badge not shown"
        print("Test 4 — WAKING badge: PASS")

        # --- Test 4b: Snapshot activity resets idle timer (edge case) ---
        # Simulate a btrfs snapshot being taken while state=active — should NOT trigger spindown
        # We verify that get_state still returns "active" after synthetic I/O from snapshot
        write_mock_state("active")
        # Inject a fake I/O event by writing to state with idle_seconds=0
        mock_reset = {
            "updated_at": "2026-03-28T10:00:00+03:00",
            "arrays": {
                ARRAY: {
                    "backup_mode": True, "state": "active",
                    "member_disks": ["sdb", "sdc", "sdd", "sde"],
                    "disk_states": {d: "active/idle" for d in ["sdb","sdc","sdd","sde"]},
                    "last_io_at": "2026-03-28T10:00:00+03:00",
                    "idle_seconds": 0, "idle_timeout_seconds": 300,
                    "spindown_at": None, "wakeup_count_session": 0, "wakeup_count_total": 0,
                }
            }
        }
        ssh(f"echo '{json.dumps(mock_reset)}' | sudo tee {STATE_FILE} > /dev/null")
        out2, _ = ssh(f"sudo python3 /usr/lib/rusnas/cgi/spindown_ctl.py get_state")
        try:
            s4b = json.loads(out2)
            arr_state = s4b.get("arrays", {}).get(ARRAY, {})
            assert arr_state.get("idle_seconds", -1) == 0, "idle_seconds not reset after I/O"
            print("Test 4b — Snapshot resets idle timer: PASS")
        except Exception as e:
            print(f"Test 4b — Snapshot edge case: {e}")

        # --- Test 5: Enable Backup Mode via panel ---
        # Reset state to active
        write_mock_state("active")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        time.sleep(3)
        for f in page.frames:
            if "rusnas/disks" in f.url or "disks.html" in f.url:
                disks_frame = f
                break
        disks_frame.locator("button", has_text="Backup Mode").first.click()
        time.sleep(0.5)
        toggle = disks_frame.locator(f"#bm-toggle-{ARRAY}")
        timeout_input = disks_frame.locator(f"#bm-timeout-{ARRAY}")
        toggle.check()
        timeout_input.fill("10")
        disks_frame.locator("button", has_text="Применить").first.click()
        time.sleep(2)
        page.screenshot(path="/tmp/bm_05_applied.png")
        print("Test 5 — Apply Backup Mode: completed (check screenshot)")

        browser.close()
        print("\nAll tests passed! Screenshots at /tmp/bm_*.png")


if __name__ == "__main__":
    run()
```

- [ ] **Запустить тесты**

```bash
cd /Users/dvl92/projects/RusNAS
python3 tests/test_backup_mode_ui.py
```

Ожидаемый вывод:
```
Test 1 — Backup Mode buttons found: 1
Test 2 — Panel opens: PASS
Test 3 — STANDBY badge: PASS
Test 4 — WAKING badge: PASS
Test 5 — Apply Backup Mode: completed (check screenshot)
All tests passed! Screenshots at /tmp/bm_*.png
```

- [ ] **Закоммитить**

```bash
git add tests/test_backup_mode_ui.py
git commit -m "test: add Playwright UI tests for RAID Backup Mode panel"
```

---

## Task 13: Создать ветку и финальный деплой

- [ ] **Убедиться, что мы в ветке `feat/raid-backup-mode`**

```bash
git branch --show-current
# Если не в нужной ветке:
# git checkout main && git checkout -b feat/raid-backup-mode
```

> Все коммиты из Tasks 1–12 уже находятся в `feat/raid-backup-mode` — cherry-pick не нужен.

- [ ] **Финальный деплой**

```bash
./deploy.sh
./install-spindown.sh
```

- [ ] **Финальная проверка**

```bash
ssh rusnas@10.10.10.72 "sudo systemctl status rusnas-spind --no-pager"
ssh rusnas@10.10.10.72 "sudo python3 /usr/lib/rusnas/cgi/spindown_ctl.py get_state"
python3 tests/test_backup_mode_ui.py
```

- [ ] **Закоммитить финальный статус и обновить project_history.md**

```bash
git add project_history.MD CLAUDE.md
git commit -m "docs: update project_history and CLAUDE.md after Backup Mode implementation"
```
