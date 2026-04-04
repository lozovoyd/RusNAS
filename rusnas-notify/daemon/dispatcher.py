#!/usr/bin/env python3
"""Delivery dispatcher — routes events to channels with retry."""

import logging
import threading
from .channels import CHANNELS
from . import db

logger = logging.getLogger("rusnas-notify.dispatcher")


class Dispatcher:
    def __init__(self, conn, config):
        self._conn = conn
        self._config = config
        self._lock = threading.Lock()

    def create_deliveries(self, event_id, source):
        """Create delivery rows based on routing matrix."""
        routing = self._config.get("routing", {})
        channels_cfg = self._config.get("channels", {})
        source_routes = routing.get(source, {})

        for channel_name, enabled in source_routes.items():
            if not enabled:
                continue
            ch_cfg = channels_cfg.get(channel_name, {})
            if not ch_cfg.get("enabled", False):
                continue
            db.insert_delivery(self._conn, event_id, channel_name)
            logger.debug("Delivery created: event=%s channel=%s", event_id, channel_name)

    def dispatch_pending(self):
        """Process all pending deliveries."""
        pending = db.get_pending_deliveries(self._conn)
        for row in pending:
            self._send_one(row)

    def dispatch_retries(self):
        """Retry failed deliveries per backoff schedule."""
        backoff = self._config.get("retry", {}).get("backoff_sec", [30, 120, 600])
        retries = db.get_retry_deliveries(self._conn, backoff)
        for row in retries:
            db.update_delivery(self._conn, row["id"], "pending")
            self._send_one(row)

    def _send_one(self, delivery):
        """Send a single delivery via its channel."""
        channel_name = delivery["channel"]
        send_fn = CHANNELS.get(channel_name)
        if not send_fn:
            db.update_delivery(self._conn, delivery["id"], "failed",
                               "Unknown channel: %s" % channel_name)
            return

        ch_cfg = self._config.get("channels", {}).get(channel_name, {})

        try:
            ok, error = send_fn(
                ch_cfg,
                delivery["source"],
                delivery["severity"],
                delivery["title"],
                delivery["body"],
                delivery.get("extra_json")
            )
            if ok:
                db.update_delivery(self._conn, delivery["id"], "sent")
            else:
                db.update_delivery(self._conn, delivery["id"], "failed", error)
        except Exception as e:
            logger.error("Dispatch error for delivery %s: %s", delivery["id"], e)
            db.update_delivery(self._conn, delivery["id"], "failed", str(e))
