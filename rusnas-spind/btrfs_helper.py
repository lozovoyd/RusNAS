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
