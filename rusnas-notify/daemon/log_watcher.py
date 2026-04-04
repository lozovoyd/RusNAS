#!/usr/bin/env python3
"""Custom log file monitor — watches log files and matches regex patterns."""

import logging
import os
import re
import subprocess
import threading

logger = logging.getLogger("rusnas-notify.logwatcher")


class LogWatcher:
    def __init__(self, daemon, watchers_config):
        self._daemon = daemon
        self._watchers = [w for w in watchers_config if w.get("enabled", True)]
        self._threads = []
        self._running = False

    def start(self):
        if not self._watchers:
            return
        self._running = True
        # Group watchers by file
        by_file = {}
        for w in self._watchers:
            f = w.get("file", "")
            if f:
                by_file.setdefault(f, []).append(w)

        for filepath, rules in by_file.items():
            t = threading.Thread(target=self._tail_file, args=(filepath, rules), daemon=True)
            t.start()
            self._threads.append(t)
            logger.info("Watching %s with %d rules", filepath, len(rules))

    def stop(self):
        self._running = False

    def _tail_file(self, filepath, rules):
        """Tail a log file and match lines against rules."""
        compiled = []
        for r in rules:
            try:
                compiled.append({
                    "name": r.get("name", "unnamed"),
                    "pattern": re.compile(r["pattern"]),
                    "severity": r.get("severity", "warning"),
                })
            except re.error as e:
                logger.error("Invalid regex in rule '%s': %s", r.get("name", "?"), e)

        if not compiled:
            return

        try:
            proc = subprocess.Popen(
                ["tail", "-F", "-n", "0", filepath],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True
            )
        except Exception as e:
            logger.error("Cannot tail %s: %s", filepath, e)
            return

        while self._running:
            line = proc.stdout.readline()
            if not line:
                break
            line = line.strip()
            for rule in compiled:
                if rule["pattern"].search(line):
                    self._daemon.handle_event({
                        "source": "custom",
                        "severity": rule["severity"],
                        "title": rule["name"],
                        "body": line[:500],
                        "extra": '{"rule":"%s","file":"%s"}' % (rule["name"], filepath)
                    })

        proc.terminate()
