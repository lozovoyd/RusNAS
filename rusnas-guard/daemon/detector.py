"""
detector.py — inotify-based file system watcher + detection logic for rusnas-guard.

Requires: python3-inotify (apt install python3-inotify)
"""

import collections
import datetime
import logging
import os
import threading
import time

import inotify.adapters
import inotify.constants

from entropy  import compute as compute_entropy, should_skip as entropy_skip
from honeypot import is_bait, recreate_bait

logger = logging.getLogger("rusnas-guard.detector")

# Rate limit: if >200 events/sec from one path, skip entropy
ENTROPY_RATE_LIMIT = 200

# Ransomware extension check fires on these inotify events
EXT_EVENTS = {"IN_CREATE", "IN_MOVED_TO", "IN_CLOSE_WRITE"}


def _load_extensions(path="/etc/rusnas-guard/ransom_extensions.txt") -> set:
    exts = set()
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip().lower()
                if line and not line.startswith("#"):
                    if not line.startswith("."):
                        line = "." + line
                    exts.add(line)
    except OSError:
        logger.warning("ransom_extensions.txt not found at %s", path)
    return exts


class IOPSWindow:
    """60-second sliding window per monitored volume."""

    def __init__(self, window=60):
        self._window = window
        self._events = collections.deque()
        self._lock   = threading.Lock()

    def record(self):
        now = time.monotonic()
        with self._lock:
            self._events.append(now)
            # Trim old
            cutoff = now - self._window
            while self._events and self._events[0] < cutoff:
                self._events.popleft()

    def rate_per_min(self) -> int:
        now = time.monotonic()
        with self._lock:
            cutoff = now - self._window
            return sum(1 for t in self._events if t >= cutoff)


class BaselineTracker:
    """
    Tracks per-hour-of-day median + stddev over a 7-day learning period.
    After learning: triggers if rate > median + multiplier*stddev AND rate > min_rate.
    """
    LEARNING_DAYS = 7

    def __init__(self, multiplier=4, min_rate=50):
        self._multiplier  = multiplier
        self._min_rate    = min_rate
        self._start       = time.time()
        self._hourly: dict[int, list] = {h: [] for h in range(24)}
        self._lock        = threading.Lock()

    @property
    def learning_day(self) -> int:
        return int((time.time() - self._start) / 86400) + 1

    @property
    def is_learning(self) -> bool:
        return self.learning_day <= self.LEARNING_DAYS

    def record_rate(self, rate: int):
        hour = datetime.datetime.now().hour
        with self._lock:
            self._hourly[hour].append(rate)

    def is_anomaly(self, rate: int) -> bool:
        if self.is_learning:
            return False
        if rate < self._min_rate:
            return False
        hour = datetime.datetime.now().hour
        with self._lock:
            samples = self._hourly.get(hour, [])
        if len(samples) < 10:
            return False
        median = sorted(samples)[len(samples) // 2]
        mean   = sum(samples) / len(samples)
        stddev = (sum((x - mean) ** 2 for x in samples) / len(samples)) ** 0.5
        threshold = median + self._multiplier * stddev
        return rate > threshold

    def status_label(self) -> str:
        if self.is_learning:
            return f"Обучение (день {self.learning_day} из {self.LEARNING_DAYS})"
        return "Активен"


class Detector:
    def __init__(self, config: dict, state: dict, on_detection):
        """
        config: full guard config dict
        state:  shared mutable state dict (written to state.json)
        on_detection: callable(event_dict)
        """
        self._config       = config
        self._state        = state
        self._on_detection = on_detection
        self._stop_event   = threading.Event()

        self._ransom_exts  = _load_extensions()
        self._iops_windows: dict[str, IOPSWindow]    = {}
        self._baseline: dict[str, BaselineTracker]   = {}
        self._entropy_rate: dict[str, collections.deque] = {}

        self._thread = None

    def start(self):
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="detector")
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)

    def reload_config(self, config: dict):
        self._config = config
        self._ransom_exts = _load_extensions()

    # ── Internal ──────────────────────────────────────────────────────────────

    def _monitored(self):
        return [p for p in self._config.get("monitored_paths", []) if p.get("enabled", True)]

    def _run(self):
        paths = [p["path"] for p in self._monitored()]
        if not paths:
            logger.warning("No monitored paths configured — detector idle")
            return

        for p in paths:
            self._iops_windows[p] = IOPSWindow()
            mult = self._config.get("detection", {}).get("iops_multiplier", 4)
            self._baseline[p]     = BaselineTracker(multiplier=mult)
            self._entropy_rate[p] = collections.deque()

        watcher = inotify.adapters.InotifyTrees(paths)

        for event in watcher.event_gen(yield_nones=False):
            if self._stop_event.is_set():
                break

            (_, type_names, watch_path, filename) = event
            if not filename:
                continue

            full_path  = os.path.join(watch_path, filename)
            pconf      = self._path_config(watch_path)
            if not pconf:
                continue

            type_set = set(type_names)
            self._record_iops(watch_path)

            # ── Honeypot check ────────────────────────────────────────────────
            if pconf.get("honeypot", True) and self._config.get("detection", {}).get("honeypot", True):
                bait_registry = self._config.get("bait_registry", {})
                if is_bait(full_path, bait_registry):
                    logger.warning("BAIT TRIGGERED: %s", full_path)
                    self._fire("honeypot", watch_path, [filename], full_path)
                    recreate_bait(full_path, bait_registry)
                    continue

            # ── Known extensions check ────────────────────────────────────────
            if pconf.get("extensions", True) and self._config.get("detection", {}).get("extensions", True):
                if type_set & EXT_EVENTS:
                    _, ext = os.path.splitext(filename)
                    if ext.lower() in self._ransom_exts:
                        logger.warning("RANSOM EXTENSION: %s", full_path)
                        self._fire("extension", watch_path, [filename], full_path)

            # ── Entropy check ─────────────────────────────────────────────────
            if ("IN_CLOSE_WRITE" in type_set and
                    pconf.get("entropy", True) and
                    self._config.get("detection", {}).get("entropy", True)):
                if not self._entropy_rate_exceeded(watch_path):
                    threshold = self._config.get("detection", {}).get("entropy_threshold", 7.2)
                    ent = compute_entropy(full_path)
                    if ent is not None and ent > threshold:
                        logger.warning("HIGH ENTROPY %.4f: %s", ent, full_path)
                        self._fire("entropy", watch_path, [filename], full_path, entropy=ent)

            # ── IOPS anomaly ──────────────────────────────────────────────────
            if pconf.get("iops", True) and self._config.get("detection", {}).get("iops", True):
                rate = self._iops_windows[watch_path].rate_per_min()
                bl   = self._baseline.get(watch_path)
                if bl:
                    bl.record_rate(rate)
                    if bl.is_anomaly(rate):
                        logger.warning("IOPS ANOMALY %d ops/min: %s", rate, watch_path)
                        self._fire("iops", watch_path, [filename], full_path, iops_rate=rate)

        # Update baseline status in state
        for p, bl in self._baseline.items():
            self._state["baseline_status"] = bl.status_label()

    def _path_config(self, watch_path: str):
        for p in self._monitored():
            if watch_path.startswith(p["path"]):
                return p
        return None

    def _record_iops(self, watch_path: str):
        window = self._iops_windows.get(watch_path)
        if window:
            window.record()
        self._state["current_iops"] = sum(
            w.rate_per_min() for w in self._iops_windows.values()
        )

        # Update entropy rate bucket (events per second)
        bucket = self._entropy_rate.setdefault(watch_path, collections.deque())
        now    = time.monotonic()
        bucket.append(now)
        cutoff = now - 1.0
        while bucket and bucket[0] < cutoff:
            bucket.popleft()

    def _entropy_rate_exceeded(self, watch_path: str) -> bool:
        bucket = self._entropy_rate.get(watch_path, collections.deque())
        return len(bucket) > ENTROPY_RATE_LIMIT

    def _fire(self, method: str, path: str, files: list, full_path: str, **kwargs):
        event = {
            "method":    method,
            "path":      path,
            "files":     files,
            "source_ip": "unknown",  # inotify doesn't expose IP — future: parse samba logs
        }
        event.update(kwargs)
        self._on_detection(event)
