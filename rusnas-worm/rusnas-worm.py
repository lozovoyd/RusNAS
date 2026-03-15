#!/usr/bin/env python3
"""
rusnas-worm — WORM (Write Once Read Many) enforcement for rusNAS.

Periodically sets chattr +i on files that have passed their grace period.
Works for all protocols: SMB, NFS, WebDAV (filesystem-level).

Usage:
    rusnas-worm              # enforce (called by systemd timer)
    rusnas-worm --status     # JSON status for all configured paths
    rusnas-worm --unlock <path>   # remove immutable flag (Normal mode only)

Config: /etc/rusnas/worm.json
Log:    /var/log/rusnas/worm.log
"""

import json
import logging
import os
import subprocess
import sys
import time

CONFIG_PATH = "/etc/rusnas/worm.json"
LOG_PATH    = "/var/log/rusnas/worm.log"

os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stderr),
    ]
)
logger = logging.getLogger("rusnas-worm")

SKIP_DIRS = {".snapshots", "@snapshots", ".worm_excluded"}


def load_config() -> dict:
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    if not os.path.exists(CONFIG_PATH):
        return {"paths": []}
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except Exception as e:
        logger.error("Config load error: %s", e)
        return {"paths": []}


def save_config(cfg: dict):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)


def is_immutable(path: str) -> bool:
    try:
        result = subprocess.run(
            ["lsattr", "-d", path],
            capture_output=True, text=True, timeout=5
        )
        parts = result.stdout.split()
        return bool(parts) and "i" in parts[0]
    except Exception:
        return False


def set_immutable(path: str) -> bool:
    try:
        subprocess.run(["chattr", "+i", path], check=True,
                       capture_output=True, timeout=10)
        return True
    except subprocess.CalledProcessError as e:
        logger.error("chattr +i failed for %s: %s", path,
                     e.stderr.decode(errors="replace") if e.stderr else "")
        return False


def remove_immutable(path: str) -> bool:
    try:
        subprocess.run(["chattr", "-i", path], check=True,
                       capture_output=True, timeout=10)
        return True
    except subprocess.CalledProcessError as e:
        logger.error("chattr -i failed for %s: %s", path,
                     e.stderr.decode(errors="replace") if e.stderr else "")
        return False


def enforce_path(path_config: dict) -> int:
    """Lock all files past their grace period. Returns count of newly locked files."""
    path         = path_config.get("path", "")
    grace_period = int(path_config.get("grace_period", 3600))

    if not os.path.isdir(path):
        logger.warning("WORM path not accessible: %s", path)
        return 0

    now    = time.time()
    locked = 0

    for root, dirs, files in os.walk(path, followlinks=False):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fname in files:
            fpath = os.path.join(root, fname)
            try:
                stat = os.lstat(fpath)
                age  = now - stat.st_mtime
                if age >= grace_period and not is_immutable(fpath):
                    if set_immutable(fpath):
                        logger.info("Locked: %s (age %.0fs)", fpath, age)
                        locked += 1
            except OSError as e:
                logger.debug("Skip %s: %s", fpath, e)

    return locked


def get_status(path_config: dict) -> dict:
    """Walk path and return {total, locked, pending} counts."""
    path         = path_config.get("path", "")
    grace_period = int(path_config.get("grace_period", 3600))
    now          = time.time()
    total = locked = pending = 0

    if not os.path.isdir(path):
        return {
            "path": path, "total": 0, "locked": 0, "pending": 0,
            "grace_period": grace_period,
            "mode":    path_config.get("mode", "normal"),
            "enabled": path_config.get("enabled", True),
            "error":   "path_not_found",
        }

    for root, dirs, files in os.walk(path, followlinks=False):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fname in files:
            fpath = os.path.join(root, fname)
            try:
                stat = os.lstat(fpath)
                total += 1
                if is_immutable(fpath):
                    locked += 1
                elif (now - stat.st_mtime) >= grace_period:
                    pending += 1
            except OSError:
                pass

    return {
        "path":         path,
        "total":        total,
        "locked":       locked,
        "pending":      pending,
        "grace_period": grace_period,
        "mode":         path_config.get("mode", "normal"),
        "enabled":      path_config.get("enabled", True),
    }


if __name__ == "__main__":
    if "--status" in sys.argv:
        cfg    = load_config()
        result = [get_status(pc) for pc in cfg.get("paths", [])]
        print(json.dumps(result))
        sys.exit(0)

    if "--unlock" in sys.argv:
        idx = sys.argv.index("--unlock")
        if idx + 1 >= len(sys.argv):
            print(json.dumps({"ok": False, "error": "No path specified"}))
            sys.exit(1)
        target = sys.argv[idx + 1]

        # Block unlock in compliance mode
        cfg = load_config()
        for pc in cfg.get("paths", []):
            if target.startswith(pc.get("path", "")) and pc.get("mode") == "compliance":
                print(json.dumps({
                    "ok": False, "error": "compliance_mode",
                    "message": "Разблокировка запрещена в режиме Compliance"
                }))
                sys.exit(1)

        ok = remove_immutable(target)
        print(json.dumps({"ok": ok, "path": target}))
        sys.exit(0 if ok else 1)

    # ── Default: enforcement run ───────────────────────────────────────────────
    cfg   = load_config()
    total = 0
    for pc in cfg.get("paths", []):
        if not pc.get("enabled", True):
            continue
        n = enforce_path(pc)
        total += n
    logger.info("WORM run complete: %d files newly locked", total)
