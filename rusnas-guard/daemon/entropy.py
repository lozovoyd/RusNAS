"""Shannon entropy computation for rusnas-guard.

Provides file-level entropy analysis to detect potential ransomware encryption.
Samples up to 16 random 4KB blocks from a file and computes Shannon entropy
in bits per byte. Files with entropy above a configurable threshold (default 7.2)
are flagged as potentially encrypted. Already-compressed or media files are
skipped to avoid false positives.
"""

import math
import os
import random

BLOCK_SIZE    = 4096
NUM_BLOCKS    = 16
MIN_FILE_SIZE = 16 * 1024  # 16 KB — below this entropy is unreliable

# Extensions skipped (already compressed/encrypted — high entropy by nature)
SKIP_EXTENSIONS = {
    ".mp4", ".mkv", ".avi", ".mov", ".mp3", ".flac",
    ".zip", ".gz", ".bz2", ".xz", ".7z", ".rar",
    ".jpg", ".jpeg", ".png", ".gif", ".webp",
}


def should_skip(path: str) -> bool:
    """Check if a file should be skipped for entropy analysis.

    Args:
        path: Absolute or relative file path.

    Returns:
        True if the file extension indicates a compressed or media format
        that naturally has high entropy.
    """
    _, ext = os.path.splitext(path)
    return ext.lower() in SKIP_EXTENSIONS


def compute(path: str):
    """Compute Shannon entropy of a file by sampling random blocks.

    Reads up to NUM_BLOCKS random 4KB blocks from the file (or the
    entire file if it is small enough) and computes Shannon entropy
    in bits per byte.

    Args:
        path: Absolute path to the file to analyze.

    Returns:
        Entropy value rounded to 4 decimal places (0.0 to 8.0),
        or None if the file should be skipped, is too small,
        or cannot be read.
    """
    if should_skip(path):
        return None

    try:
        size = os.path.getsize(path)
    except OSError:
        return None

    if size < MIN_FILE_SIZE:
        return None

    data = bytearray()
    try:
        with open(path, "rb") as fh:
            if size <= BLOCK_SIZE * NUM_BLOCKS:
                data = bytearray(fh.read())
            else:
                offsets = random.sample(range(0, size - BLOCK_SIZE), NUM_BLOCKS)
                for offset in sorted(offsets):
                    fh.seek(offset)
                    data += fh.read(BLOCK_SIZE)
    except OSError:
        return None

    if not data:
        return None

    freq = [0] * 256
    for b in data:
        freq[b] += 1

    n = len(data)
    entropy = 0.0
    for count in freq:
        if count:
            p = count / n
            entropy -= p * math.log2(p)

    return round(entropy, 4)
