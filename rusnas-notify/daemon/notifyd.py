#!/usr/bin/env python3
"""rusnas-notifyd — centralized notification bus daemon.

Listens on Unix socket and spool directory for events from any module.
Routes notifications to configured channels (Email, Telegram, MAX, SNMP, Webhook).
Applies per-source throttling and retry logic.
"""

import json
import logging
import os
import signal
import sys
import time
import threading

sys.path.insert(0, os.path.dirname(__file__))

from db import get_db, init_db, gen_event_id, insert_event, get_history as db_get_history
from config import load_config, save_config as cfg_save
from throttle import Throttle
from dispatcher import Dispatcher
from socket_server import NotifySocketServer
from spool import SpoolWatcher
from channels import CHANNELS, TEST_CHANNELS

# ── Paths
LOG_PATH = "/var/log/rusnas/notify.log"

# ── Logging
os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.FileHandler(LOG_PATH), logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("rusnas-notifyd")


class NotifyDaemon:
    def __init__(self):
        self._config = load_config()
        self._conn = get_db()
        init_db()
        self._throttle = Throttle(self._conn, self._config.get("throttle", {}))
        self._dispatcher = Dispatcher(self._conn, self._config)
        self._socket = NotifySocketServer(self)
        self._spool = SpoolWatcher(self)
        self._running = False
        self._lock = threading.Lock()

    def run(self):
        """Start daemon main loop."""
        logger.info("rusnas-notifyd starting")
        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)

        self._socket.start()
        self._spool.start()
        self._start_log_watcher()
        self._running = True

        logger.info("rusnas-notifyd ready")

        while self._running:
            try:
                # Dispatch pending deliveries
                with self._lock:
                    self._dispatcher.dispatch_pending()
                    self._dispatcher.dispatch_retries()

                # Check for digest notifications
                with self._lock:
                    digests = self._throttle.get_pending_digests()
                    for d in digests:
                        self._send_digest(d)

                time.sleep(2)
            except Exception as e:
                logger.error("Main loop error: %s", e)
                time.sleep(5)

        self._shutdown()

    def handle_event(self, req):
        """Process incoming event (from socket or spool)."""
        source = req.get("source", "unknown")
        severity = req.get("severity", "info")
        title = req.get("title", "")
        body = req.get("body", "")
        extra_json = req.get("extra")
        if isinstance(extra_json, dict):
            extra_json = json.dumps(extra_json)

        event_id = gen_event_id()

        with self._lock:
            # Check throttle
            allowed = self._throttle.check(source)

            if allowed:
                insert_event(self._conn, event_id, source, severity, title, body, extra_json)
                self._dispatcher.create_deliveries(event_id, source)
            else:
                # Still store event but mark as throttled
                self._conn.execute(
                    "INSERT INTO events (id, source, severity, title, body, extra_json, created_at, throttled) "
                    "VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 1)",
                    (event_id, source, severity, title, body, extra_json)
                )
                self._conn.commit()

        logger.info("Event %s from %s [%s]: %s (throttled=%s)",
                     event_id, source, severity, title, not allowed)
        return {"ok": True, "event_id": event_id, "throttled": not allowed}

    def handle_test(self, req):
        """Test a delivery channel."""
        channel = req.get("channel", "")
        test_fn = TEST_CHANNELS.get(channel)
        if not test_fn:
            return {"ok": False, "error": "Unknown channel: %s" % channel}

        ch_cfg = self._config.get("channels", {}).get(channel, {})
        ok, error = test_fn(ch_cfg)
        return {"ok": ok, "error": error}

    def get_config(self):
        """Return current config (with passwords masked)."""
        import copy
        cfg = copy.deepcopy(self._config)
        # Mask passwords
        for ch_name, ch_cfg in cfg.get("channels", {}).items():
            for key in ("smtp_pass", "v3_auth_password", "v3_priv_password"):
                if ch_cfg.get(key):
                    ch_cfg[key] = "***"
        return cfg

    def save_config(self, new_config):
        """Update and save config."""
        # Preserve masked passwords
        for ch_name, ch_cfg in new_config.get("channels", {}).items():
            for key in ("smtp_pass", "v3_auth_password", "v3_priv_password"):
                if ch_cfg.get(key) == "***":
                    ch_cfg[key] = self._config.get("channels", {}).get(ch_name, {}).get(key, "")

        self._config = new_config
        self._throttle = Throttle(self._conn, self._config.get("throttle", {}))
        self._dispatcher = Dispatcher(self._conn, self._config)
        cfg_save(self._config)
        self._restart_log_watcher()
        return {"ok": True}

    def get_history(self, req):
        """Query notification history."""
        with self._lock:
            result = db_get_history(
                self._conn,
                limit=req.get("limit", 50),
                offset=req.get("offset", 0),
                source=req.get("source"),
                severity=req.get("severity"),
                status=req.get("status")
            )
        return {"ok": True, "data": result}

    def get_status(self):
        """Return daemon status."""
        with self._lock:
            total = self._conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            pending = self._conn.execute(
                "SELECT COUNT(*) FROM deliveries WHERE status='pending'"
            ).fetchone()[0]
            failed = self._conn.execute(
                "SELECT COUNT(*) FROM deliveries WHERE status='failed'"
            ).fetchone()[0]
        return {
            "ok": True,
            "running": True,
            "total_events": total,
            "pending_deliveries": pending,
            "failed_deliveries": failed,
            "channels": {
                name: self._config.get("channels", {}).get(name, {}).get("enabled", False)
                for name in CHANNELS
            }
        }

    def _send_digest(self, digest_info):
        """Send a throttle digest notification."""
        source = digest_info["source"]
        title, body = self._throttle.build_digest_message(source, self._conn)
        event_id = gen_event_id()
        insert_event(self._conn, event_id, source, "warning", title, body, None)
        self._dispatcher.create_deliveries(event_id, source)
        self._throttle.mark_digest_sent(source)
        logger.info("Digest sent for source=%s", source)

    def _start_log_watcher(self):
        """Start log watcher thread if rules configured."""
        watchers = self._config.get("log_watchers", [])
        if watchers:
            try:
                from log_watcher import LogWatcher
                self._log_watcher = LogWatcher(self, watchers)
                self._log_watcher.start()
            except Exception as e:
                logger.error("Failed to start log watcher: %s", e)
        else:
            self._log_watcher = None

    def _restart_log_watcher(self):
        if hasattr(self, "_log_watcher") and self._log_watcher:
            self._log_watcher.stop()
        self._start_log_watcher()

    def _signal_handler(self, signum, frame):
        logger.info("Signal %d received, shutting down", signum)
        self._running = False

    def _shutdown(self):
        self._socket.stop()
        self._spool.stop()
        if hasattr(self, "_log_watcher") and self._log_watcher:
            self._log_watcher.stop()
        self._conn.close()
        logger.info("rusnas-notifyd stopped")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--init-db":
        init_db()
        print("Database initialized")
        sys.exit(0)

    daemon = NotifyDaemon()
    daemon.run()
