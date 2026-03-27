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
