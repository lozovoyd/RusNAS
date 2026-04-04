#!/usr/bin/env python3
"""Spool directory watcher — picks up JSON files dropped by CLI fallback."""

import json
import logging
import os
import threading
import time

logger = logging.getLogger("rusnas-notify.spool")

SPOOL_DIR = "/var/spool/rusnas-notify"


class SpoolWatcher:
    def __init__(self, daemon):
        self._daemon = daemon
        self._running = False
        self._thread = None

    def start(self):
        os.makedirs(SPOOL_DIR, exist_ok=True)
        self._running = True
        self._thread = threading.Thread(target=self._watch_loop, daemon=True)
        self._thread.start()
        logger.info("Spool watcher started on %s", SPOOL_DIR)

    def stop(self):
        self._running = False

    def _watch_loop(self):
        while self._running:
            try:
                files = sorted(f for f in os.listdir(SPOOL_DIR) if f.endswith(".json"))
                for fname in files:
                    path = os.path.join(SPOOL_DIR, fname)
                    try:
                        with open(path, "r") as f:
                            req = json.load(f)
                        os.unlink(path)
                        req["cmd"] = "send"
                        self._daemon.handle_event(req)
                        logger.info("Processed spool file: %s", fname)
                    except Exception as e:
                        logger.error("Failed to process spool file %s: %s", fname, e)
                        # Move bad file so we don't retry forever
                        try:
                            os.rename(path, path + ".bad")
                        except OSError:
                            pass
            except Exception as e:
                logger.error("Spool watcher error: %s", e)
            time.sleep(2)
