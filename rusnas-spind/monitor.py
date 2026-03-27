#!/usr/bin/env python3
"""SpindownMonitor — tracks I/O delta for mdX devices via /proc/diskstats."""
import time
import logging

log = logging.getLogger("rusnas-spind")

# States stored in state.json
STATE_ACTIVE   = "active"
STATE_FLUSHING = "flushing"
STATE_STANDBY  = "standby"
STATE_WAKING   = "waking"


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

        # STATE_ACTIVE: idle countdown logic
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
