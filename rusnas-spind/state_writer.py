#!/usr/bin/env python3
"""state_writer — atomically writes spindown_state.json and persists wakeup totals."""
import datetime
import json
import os
import time
import logging

log = logging.getLogger("rusnas-spind")

STATE_FILE   = "/run/rusnas/spindown_state.json"
TOTALS_FILE  = "/var/lib/rusnas/spindown_totals.json"


def load_totals():
    """Load persisted wakeup_count_total per array. Returns {} on any error."""
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
    return datetime.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")
