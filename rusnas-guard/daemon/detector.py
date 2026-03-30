"""inotify-based filesystem watcher and detection engine for rusnas-guard.

Monitors configured Btrfs volumes via InotifyTrees and applies four detection
methods in real time: honeypot trigger, known ransomware extension matching,
Shannon entropy analysis, and IOPS anomaly detection against a learned baseline.
Events that pass detection thresholds are forwarded to the response module.

Requires:
    python3-inotify (``apt install python3-inotify``)
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
from honeypot import is_bait, recreate_bait, is_guard_creating

logger = logging.getLogger("rusnas-guard.detector")

# Rate limit: if >200 events/sec from one path, skip entropy
ENTROPY_RATE_LIMIT = 200

# Ransomware extension check fires on these inotify events
EXT_EVENTS = {"IN_CREATE", "IN_MOVED_TO", "IN_CLOSE_WRITE"}

# Honeypot fires only on WRITE/DELETE/RENAME — not on reads.
# Samba's streams_xattr vfs module opens files to read xattrs (IN_OPEN/IN_ACCESS),
# which would create false positives if we fired on all event types.
HONEYPOT_EVENTS = {"IN_CLOSE_WRITE", "IN_CREATE", "IN_MOVED_TO",
                   "IN_DELETE", "IN_MOVED_FROM"}


def _dedup_watch_paths(paths: list) -> list:
    """Remove paths that are subdirectories of other monitored paths.
    InotifyTrees watches recursively — having both /mnt/data and
    /mnt/data/documents would cause every event in /mnt/data/documents
    to fire twice (once per watch root)."""
    sorted_paths = sorted(set(paths))  # shortest (parent) paths first
    result = []
    for p in sorted_paths:
        p_norm = p.rstrip('/')
        if not any(p_norm.startswith(r.rstrip('/') + '/') for r in result):
            result.append(p)
    return result


def _load_extensions(path="/etc/rusnas-guard/ransom_extensions.txt") -> set:
    """Load known ransomware file extensions from a text file.

    Args:
        path: Path to the extensions file, one extension per line.
            Lines starting with ``#`` are treated as comments.

    Returns:
        Set of lowercase extensions including the leading dot
        (e.g., ``{".encrypted", ".locked"}``).
    """
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
    """Thread-safe sliding window counter for I/O operations per volume.

    Maintains a deque of event timestamps within the last ``window`` seconds
    and provides the current event rate.
    """

    def __init__(self, window=60):
        self._window = window
        self._events = collections.deque()
        self._lock   = threading.Lock()

    def record(self):
        """Record a single I/O event at the current time."""
        now = time.monotonic()
        with self._lock:
            self._events.append(now)
            # Trim old
            cutoff = now - self._window
            while self._events and self._events[0] < cutoff:
                self._events.popleft()

    def rate_per_min(self) -> int:
        """Return the number of events within the sliding window.

        Returns:
            Event count in the last ``window`` seconds (default 60).
        """
        now = time.monotonic()
        with self._lock:
            cutoff = now - self._window
            return sum(1 for t in self._events if t >= cutoff)


class BaselineTracker:
    """IOPS baseline tracker with a 7-day learning period.

    During the learning phase, records per-hour-of-day I/O rates.
    After learning, detects anomalies when the current rate exceeds
    ``median + multiplier * stddev`` for the current hour and is above
    ``min_rate``.

    Args:
        multiplier: Standard deviation multiplier for anomaly threshold.
        min_rate: Minimum absolute rate to trigger an anomaly.
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
        """Return the current learning day number (1-based)."""
        return int((time.time() - self._start) / 86400) + 1

    @property
    def is_learning(self) -> bool:
        """Return True if the tracker is still in the learning phase."""
        return self.learning_day <= self.LEARNING_DAYS

    def record_rate(self, rate: int):
        """Record a rate sample for the current hour of day.

        Args:
            rate: Current I/O operations per minute.
        """
        hour = datetime.datetime.now().hour
        with self._lock:
            self._hourly[hour].append(rate)

    def is_anomaly(self, rate: int) -> bool:
        """Check if the given rate is anomalous for the current hour.

        Args:
            rate: Current I/O operations per minute.

        Returns:
            True if rate exceeds the learned threshold and minimum rate.
            Always returns False during the learning phase.
        """
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
        """Return a human-readable status string for the UI.

        Returns:
            Localized string like "Обучение (день 3 из 7)" or "Активен".
        """
        if self.is_learning:
            return f"Обучение (день {self.learning_day} из {self.LEARNING_DAYS})"
        return "Активен"


class Detector:
    """Filesystem event detector using inotify with multiple detection methods.

    Watches configured Btrfs volumes recursively and applies honeypot,
    extension, entropy, and IOPS anomaly checks to each filesystem event.
    Runs in a dedicated daemon thread.

    Args:
        config: Full guard config dict with detection settings and paths.
        state: Shared mutable state dict (written to state.json by the daemon).
        on_detection: Callback invoked with an event dict when a threat is detected.
    """

    def __init__(self, config: dict, state: dict, on_detection):
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
        """Start the detector thread."""
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="detector")
        self._thread.start()

    def stop(self):
        """Signal the detector thread to stop and wait for it to finish."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)

    def reload_config(self, config: dict):
        """Hot-reload configuration without restarting the detector thread.

        Args:
            config: Updated full guard config dict.
        """
        self._config = config
        self._ransom_exts = _load_extensions()

    # ── Internal ──────────────────────────────────────────────────────────────

    def _monitored(self):
        """Return the list of enabled monitored path config entries."""
        return [p for p in self._config.get("monitored_paths", []) if p.get("enabled", True)]

    def _run(self):
        """Thread entry point with exception safety."""
        try:
            self._run_inner()
        except Exception as e:
            logger.exception("Detector thread crashed: %s", e)
        finally:
            self._state["daemon_running"] = False

    def _run_inner(self):
        """Core detection loop: set up InotifyTrees and process events."""
        paths = [p["path"] for p in self._monitored()]
        if not paths:
            logger.warning("No monitored paths configured — detector idle")
            return

        # Filter out paths that don't exist — InotifyTrees raises FileNotFoundError otherwise
        missing = [p for p in paths if not os.path.isdir(p)]
        if missing:
            logger.warning("Skipping non-existent monitored paths: %s", missing)
        paths = [p for p in paths if os.path.isdir(p)]
        if not paths:
            logger.warning("No accessible monitored paths — detector idle")
            return

        # Deduplicate: if /mnt/data and /mnt/data/documents are both monitored,
        # InotifyTrees watches recursively — events in /mnt/data/documents would
        # fire twice. Keep only the topmost (shortest) paths.
        paths = _dedup_watch_paths(paths)
        logger.info("InotifyTrees watching: %s", paths)

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
            # Only fire on write/delete/rename — not on reads (IN_OPEN, IN_ACCESS).
            # Samba's streams_xattr reads files on directory listing → false positives.
            if (type_set & HONEYPOT_EVENTS and
                    pconf.get("honeypot", True) and
                    self._config.get("detection", {}).get("honeypot", True)):
                bait_registry = self._config.get("bait_registry", {})
                if is_bait(full_path, bait_registry):
                    if is_guard_creating(full_path):
                        # Guard itself is writing this bait — suppress self-detection
                        logger.debug("Suppressed self-write for bait: %s", full_path)
                        continue
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
                root = self._root_path(watch_path)
                rate = self._iops_windows[root].rate_per_min()
                bl   = self._baseline.get(root)
                if bl:
                    bl.record_rate(rate)
                    if bl.is_anomaly(rate):
                        logger.warning("IOPS ANOMALY %d ops/min: %s", rate, watch_path)
                        self._fire("iops", watch_path, [filename], full_path, iops_rate=rate)

        # Update baseline status in state
        for p, bl in self._baseline.items():
            self._state["baseline_status"] = bl.status_label()

    def _path_config(self, watch_path: str):
        """Find the monitored path config entry that contains watch_path.

        Args:
            watch_path: Directory path from an inotify event.

        Returns:
            Matching path config dict, or None if no match.
        """
        for p in self._monitored():
            if watch_path.startswith(p["path"]):
                return p
        return None

    def _root_path(self, watch_path: str) -> str:
        """Resolve a subdirectory back to its monitored root path.

        Args:
            watch_path: Directory path from an inotify event.

        Returns:
            The root monitored path, or watch_path itself if not found.
        """
        for p in self._monitored():
            if watch_path.startswith(p["path"]):
                return p["path"]
        return watch_path

    def get_iops(self) -> int:
        """Return the aggregate I/O rate across all monitored volumes.

        Returns:
            Total events per minute summed across all IOPS windows.
        """
        return sum(w.rate_per_min() for w in self._iops_windows.values())

    def _record_iops(self, watch_path: str):
        """Record an I/O event for the volume containing watch_path.

        Updates the IOPS window, shared state, and entropy rate bucket.

        Args:
            watch_path: Directory where the event occurred.
        """
        root   = self._root_path(watch_path)
        window = self._iops_windows.get(root)
        if window:
            window.record()
        self._state["current_iops"] = self.get_iops()

        # Update entropy rate bucket (events per second)
        bucket = self._entropy_rate.setdefault(watch_path, collections.deque())
        now    = time.monotonic()
        bucket.append(now)
        cutoff = now - 1.0
        while bucket and bucket[0] < cutoff:
            bucket.popleft()

    def _entropy_rate_exceeded(self, watch_path: str) -> bool:
        """Check if entropy analysis should be skipped due to high event rate.

        Args:
            watch_path: Directory to check rate for.

        Returns:
            True if events per second exceed ENTROPY_RATE_LIMIT.
        """
        bucket = self._entropy_rate.get(watch_path, collections.deque())
        return len(bucket) > ENTROPY_RATE_LIMIT

    def _fire(self, method: str, path: str, files: list, full_path: str, **kwargs):
        """Build a detection event dict and forward to the callback.

        Args:
            method: Detection method name (honeypot, extension, entropy, iops).
            path: Monitored root path where the event occurred.
            files: List of filenames involved.
            full_path: Absolute path of the triggering file.
            **kwargs: Additional fields like ``entropy`` or ``iops_rate``.
        """
        event = {
            "method":    method,
            "path":      path,
            "files":     files,
            "source_ip": "unknown",  # inotify doesn't expose IP — future: parse samba logs
        }
        event.update(kwargs)
        self._on_detection(event)
