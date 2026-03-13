"""
entropy.py — Shannon entropy computation for rusnas-guard.

Samples up to 16 random 4KB blocks from a file and returns bits/byte.
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
    _, ext = os.path.splitext(path)
    return ext.lower() in SKIP_EXTENSIONS


def compute(path: str):
    """
    Return Shannon entropy in bits/byte, or None if file should be skipped
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
