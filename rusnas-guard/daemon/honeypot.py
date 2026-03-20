"""
honeypot.py — Bait file management for rusnas-guard.

Creates hidden bait files in each monitored directory.
File names start with low ASCII chars to appear first in enumeration.
"""

import os
import random
import string
import logging
import threading
import time

logger = logging.getLogger("rusnas-guard.honeypot")

# ── Bait creation suppression ─────────────────────────────────────────────────
# Paths currently being written by Guard itself — inotify events for these
# must be suppressed to avoid self-triggering the honeypot detector.
_creating_baits: set = set()
_creating_lock = threading.Lock()


def is_guard_creating(path: str) -> bool:
    """Return True if Guard is currently writing this bait file (suppress detection)."""
    with _creating_lock:
        return path in _creating_baits

# Bait extensions that look like real office/data files
BAIT_EXTENSIONS = [".docx", ".xlsx", ".pdf", ".pptx", ".doc", ".xls"]

# Sizes (bytes) — varied to keep ransomware busy
BAIT_SIZES = [4096, 16384, 65536, 262144]

# Prefix — low ASCII, no "honeypot"/"bait"/"guard" words
BAIT_PREFIX = "!~rng_"


def _random_suffix(n=8):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def _make_bait_name():
    ext = random.choice(BAIT_EXTENSIONS)
    return BAIT_PREFIX + _random_suffix() + ext


def _fill_bait(path, size):
    """Write random-looking but low-entropy data (not truly random — avoids
    triggering our own entropy detector on bait files)."""
    # Mark as Guard-created BEFORE writing so inotify events are suppressed
    with _creating_lock:
        _creating_baits.add(path)

    try:
        # Repeating pattern — low entropy, looks non-empty
        chunk = (b"\x00" * 512 + b"\xFF" * 512)
        with open(path, "wb") as fh:
            written = 0
            while written < size:
                block = chunk[:min(len(chunk), size - written)]
                fh.write(block)
                written += len(block)
    finally:
        # Remove from suppression set after 1s — generous window for inotify events
        def _remove():
            time.sleep(1.0)
            with _creating_lock:
                _creating_baits.discard(path)
        threading.Thread(target=_remove, daemon=True).start()


def ensure_baits(monitored_path: str, bait_registry: dict) -> list:
    """
    Ensure at least 2 bait files exist in monitored_path.
    bait_registry: dict mapping path -> list of bait filenames (persisted in config).
    Returns updated list of bait filenames for this path.
    """
    existing = bait_registry.get(monitored_path, [])

    # Remove entries that no longer exist on disk (were triggered & recreated)
    alive = [f for f in existing if os.path.exists(os.path.join(monitored_path, f))]

    # Create until we have 2 bait files
    while len(alive) < 2:
        name = _make_bait_name()
        full = os.path.join(monitored_path, name)
        try:
            size = random.choice(BAIT_SIZES)
            _fill_bait(full, size)
            os.chmod(full, 0o666)  # must be writable by SMB users — otherwise ransomware skips it
            # Hide on Linux via leading dot-like prefix — already using !~
            alive.append(name)
            logger.info("Created bait file: %s", full)
        except OSError as e:
            logger.error("Cannot create bait file in %s: %s", monitored_path, e)
            break

    return alive


def is_bait(path: str, bait_registry: dict) -> bool:
    """Return True if path matches a known bait file."""
    dirname = os.path.dirname(path)
    basename = os.path.basename(path)
    return basename in bait_registry.get(dirname, [])


def recreate_bait(path: str, bait_registry: dict):
    """Recreate a bait file that was deleted/modified (after alert was fired)."""
    dirname = os.path.dirname(path)
    basename = os.path.basename(path)
    full = os.path.join(dirname, basename)
    try:
        size = random.choice(BAIT_SIZES)
        _fill_bait(full, size)
        os.chmod(full, 0o666)
        logger.info("Recreated bait file: %s", full)
        if basename not in bait_registry.get(dirname, []):
            bait_registry.setdefault(dirname, []).append(basename)
    except OSError as e:
        logger.error("Cannot recreate bait %s: %s", full, e)
