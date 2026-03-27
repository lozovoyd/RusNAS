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
