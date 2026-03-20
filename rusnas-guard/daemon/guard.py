#!/usr/bin/env python3
"""
guard.py — Main daemon entry point for rusnas-guard.

Usage: /usr/bin/python3 /usr/lib/rusnas-guard/guard.py
"""

import json
import logging
import os
import signal
import sys
import time

# Add daemon directory to path
sys.path.insert(0, os.path.dirname(__file__))

from detector      import Detector
from honeypot      import ensure_baits
from response      import handle_detection, write_state
from socket_server import SocketServer

# ── Paths ─────────────────────────────────────────────────────────────────────
CONFIG_PATH     = "/etc/rusnas-guard/config.json"
STATE_PATH      = "/run/rusnas-guard/state.json"
LOG_PATH        = "/var/log/rusnas-guard/guard.log"
POST_ATTACK_FLAG = "/etc/rusnas-guard/post_attack"

# ── Logging ───────────────────────────────────────────────────────────────────
os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stdout),
    ]
)
logger = logging.getLogger("rusnas-guard")

# ── Default config ────────────────────────────────────────────────────────────
DEFAULT_CONFIG = {
    "mode": "monitor",
    "detection": {
        "honeypot":          True,
        "entropy":           True,
        "entropy_threshold": 7.2,
        "iops":              True,
        "iops_multiplier":   4,
        "extensions":        True,
    },
    "monitored_paths": [],
    "bait_registry":   {},
    "snapshot": {
        "enabled": True,
        "local":   True,
        "remote": {
            "enabled": False,
            "host": "",
            "user": "rusnas",
            "path": "/mnt/backup_pool",
            "ssh_key": "/etc/rusnas-guard/replication_key"
        }
    }
}


class GuardDaemon:
    def __init__(self):
        self._config     = self._load_config()
        self._state      = self._init_state()
        self._detector   = None
        self._socket_srv = SocketServer(self)
        self._running    = False
        self._prev_mode  = None  # saved mode before post-attack downgrade

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def run(self):
        logger.info("rusnas-guard starting")
        self._socket_srv.start()

        # Check post-attack flag
        if os.path.exists(POST_ATTACK_FLAG):
            self._prev_mode     = self._config.get("mode", "monitor")
            self._config["mode"] = "monitor"
            self._state["post_attack_warning"] = True
            logger.warning("Post-attack flag found — starting in Monitor mode only")

        # Apply smb hide state on start
        if self._config.get("detection", {}).get("hide_smb_baits", False):
            self._apply_smb_hide(True)

        # Auto-discover Btrfs paths if none configured
        if not self._config.get("monitored_paths"):
            self._discover_paths()

        self._state["daemon_running"] = False
        write_state(self._state)

        # Main loop — daemon stays alive; detector starts/stops on demand
        _bait_refresh_counter = 0
        try:
            while True:
                time.sleep(1)
                self._update_state()
                # Refresh baits every 30 seconds to catch newly created subdirectories
                _bait_refresh_counter += 1
                if _bait_refresh_counter >= 30 and self._running:
                    _bait_refresh_counter = 0
                    self._refresh_baits()
        except KeyboardInterrupt:
            pass
        finally:
            self.stop_guard()
            self._socket_srv.stop()
            logger.info("rusnas-guard stopped")

    def start_guard(self):
        if self._running:
            return
        self._running = True
        logger.info("Guard activated, mode=%s", self._config.get("mode"))

        # Ensure bait files exist
        self._refresh_baits()

        self._detector = Detector(
            config=self._config,
            state=self._state,
            on_detection=self._on_detection,
        )
        self._detector.start()
        self._state["daemon_running"] = True
        write_state(self._state)

    def stop_guard(self):
        self._running = False
        if self._detector:
            self._detector.stop()
            self._detector = None
        self._state["daemon_running"] = False
        write_state(self._state)
        logger.info("Guard deactivated")

    def set_mode(self, mode: str):
        self._config["mode"] = mode
        self._save_config()
        self._state["mode"] = mode
        write_state(self._state)
        logger.info("Mode changed to %s", mode)

    def restore_mode_after_attack(self):
        if self._prev_mode:
            self._config["mode"] = self._prev_mode
            self._prev_mode      = None
        self._state.pop("post_attack_warning", None)
        self._save_config()
        write_state(self._state)

    def update_config(self, partial: dict):
        old_hide = self._config.get("detection", {}).get("hide_smb_baits", False)
        self._config.update(partial)
        self._save_config()
        new_hide = self._config.get("detection", {}).get("hide_smb_baits", False)
        if old_hide != new_hide:
            self._apply_smb_hide(new_hide)
        if self._detector:
            self._detector.reload_config(self._config)
        self._refresh_baits()

    def _apply_smb_hide(self, enabled: bool):
        """Add or remove 'hide files = /!~rng_*/' from [global] in smb.conf."""
        import subprocess
        smb_conf = "/etc/samba/smb.conf"
        hide_line = "    hide files = /!~rng_*/\n"
        marker = "hide files = /!~rng_"
        try:
            with open(smb_conf) as f:
                lines = f.readlines()
            # Remove existing entry if present
            lines = [l for l in lines if marker not in l]
            if enabled:
                # Insert after [global] line
                result = []
                for line in lines:
                    result.append(line)
                    if line.strip() == "[global]":
                        result.append(hide_line)
                lines = result
            tmp = smb_conf + ".guard.tmp"
            with open(tmp, "w") as f:
                f.writelines(lines)
            os.replace(tmp, smb_conf)
            subprocess.run(["systemctl", "reload", "smbd"], check=False)
            logger.info("SMB hide files %s", "enabled" if enabled else "disabled")
        except Exception as e:
            logger.error("Failed to modify smb.conf: %s", e)

    def get_status(self) -> dict:
        return {
            "daemon_running":       self._running,
            "mode":                 self._config.get("mode", "monitor"),
            "current_iops":         self._state.get("current_iops", 0),
            "events_today":         self._state.get("events_today", 0),
            "last_snapshot":        self._state.get("last_snapshot", ""),
            "last_event":           self._state.get("last_event", ""),
            "baseline_status":      self._state.get("baseline_status", "Обучение"),
            "monitored_count":      len(self._config.get("monitored_paths", [])),
            "blocked_ips":          self._get_blocked_ips(),
            "post_attack_warning":  self._state.get("post_attack_warning", False),
        }

    def get_config_public(self) -> dict:
        """Config without sensitive fields."""
        cfg = dict(self._config)
        return cfg

    # ── Internal ──────────────────────────────────────────────────────────────

    def _on_detection(self, event: dict):
        mode = self._config.get("mode", "monitor")
        handle_detection(event, mode, self._config, self._state)

    def _refresh_baits(self):
        registry = self._config.setdefault("bait_registry", {})
        changed  = False
        for pconf in self._config.get("monitored_paths", []):
            if not pconf.get("enabled", True) or not pconf.get("honeypot", True):
                continue
            root = pconf["path"]
            if not os.path.isdir(root):
                continue
            # Collect root + all subdirectories up to depth 3
            dirs_to_bait = []
            try:
                for dirpath, dirnames, _ in os.walk(root):
                    # Calculate depth relative to root
                    depth = dirpath[len(root):].count(os.sep)
                    if depth > 3:
                        dirnames[:] = []
                        continue
                    # Skip hidden directories
                    dirnames[:] = [d for d in dirnames if not d.startswith('.')]
                    dirs_to_bait.append(dirpath)
            except OSError as e:
                logger.warning("os.walk error on %s: %s", root, e)
                dirs_to_bait = [root]
            for path in dirs_to_bait:
                new_list = ensure_baits(path, registry)
                if new_list != registry.get(path):
                    registry[path] = new_list
                    changed         = True
        if changed:
            self._save_config()

    def _discover_paths(self):
        try:
            import subprocess
            out = subprocess.check_output(
                ["findmnt", "--real", "-t", "btrfs", "-o", "TARGET", "--noheadings"],
                text=True
            )
            paths = [p.strip() for p in out.splitlines() if p.strip()]
            self._config["monitored_paths"] = [
                {"path": p, "enabled": True,
                 "honeypot": True, "entropy": True, "iops": True, "extensions": True}
                for p in paths
            ]
            logger.info("Auto-discovered Btrfs paths: %s", paths)
            self._save_config()
        except Exception as e:
            logger.warning("Path discovery failed: %s", e)

    def _update_state(self):
        self._state["mode"] = self._config.get("mode", "monitor")
        self._state["monitored_count"] = len(self._config.get("monitored_paths", []))
        self._state["daemon_running"] = self._running
        # current_iops is written directly by Detector._record_iops() into shared state
        write_state(self._state)

    def _get_blocked_ips(self) -> list:
        try:
            from response import get_blocked_ips
            return get_blocked_ips()
        except Exception:
            return []

    def _load_config(self) -> dict:
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH) as fh:
                    cfg = json.load(fh)
                # Merge any missing keys from defaults
                for k, v in DEFAULT_CONFIG.items():
                    cfg.setdefault(k, v)
                return cfg
            except Exception as e:
                logger.error("Config load error: %s — using defaults", e)
        return dict(DEFAULT_CONFIG)

    def _save_config(self):
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(self._config, fh, indent=2)
        os.replace(tmp, CONFIG_PATH)

    def _init_state(self) -> dict:
        return {
            "daemon_running":  False,
            "mode":            self._config.get("mode", "monitor"),
            "current_iops":    0,
            "events_today":    0,
            "last_snapshot":   "",
            "last_event":      "",
            "baseline_status": "Обучение",
            "monitored_count": 0,
            "post_attack_warning": False,
        }


# ── Entry point ───────────────────────────────────────────────────────────────

PIN_PATH = "/etc/rusnas-guard/guard.pin"


def cmd_reset_pin():
    if os.geteuid() != 0:
        print("Ошибка: требуются права root. Запустите: sudo rusnas-guard --reset-pin", file=sys.stderr)
        sys.exit(1)
    if os.path.exists(PIN_PATH):
        os.remove(PIN_PATH)
        print("Guard PIN сброшен. Откройте страницу Guard в Cockpit для установки нового PIN.")
    else:
        print("Guard PIN не установлен (файл не существует).")


if __name__ == "__main__":
    if "--reset-pin" in sys.argv:
        cmd_reset_pin()
        sys.exit(0)

    daemon = GuardDaemon()

    def _sigterm(sig, frame):
        logger.info("SIGTERM received")
        sys.exit(0)

    signal.signal(signal.SIGTERM, _sigterm)
    daemon.run()
