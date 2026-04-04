#!/usr/bin/env python3
"""Per-source throttle logic for rusnas-notify.

Window-based rate limiter: max N events per source within window_sec.
When exceeded, events are marked throttled and a digest is sent later.
"""

import logging
from datetime import datetime, timezone, timedelta

logger = logging.getLogger("rusnas-notify.throttle")


class Throttle:
    def __init__(self, conn, config):
        self._conn = conn
        self._window_sec = config.get("window_sec", 300)
        self._max_per_source = config.get("max_per_source", 5)
        self._digest_delay_sec = config.get("digest_delay_sec", 60)

    def check(self, source):
        """Check if source is under throttle limit.
        Returns True if event should be delivered, False if throttled.
        """
        now = datetime.now(timezone.utc)
        row = self._conn.execute(
            "SELECT window_start, event_count FROM throttle_state WHERE source=?",
            (source,)
        ).fetchone()

        if row is None:
            self._conn.execute(
                "INSERT INTO throttle_state (source, window_start, event_count, digest_pending) "
                "VALUES (?, ?, 1, 0)",
                (source, now.isoformat())
            )
            self._conn.commit()
            return True

        window_start = datetime.fromisoformat(row["window_start"])
        count = row["event_count"]

        # Window expired — reset
        if (now - window_start).total_seconds() >= self._window_sec:
            self._conn.execute(
                "UPDATE throttle_state SET window_start=?, event_count=1, digest_pending=0 "
                "WHERE source=?",
                (now.isoformat(), source)
            )
            self._conn.commit()
            return True

        # Within window
        new_count = count + 1
        self._conn.execute(
            "UPDATE throttle_state SET event_count=? WHERE source=?",
            (new_count, source)
        )
        self._conn.commit()

        if new_count <= self._max_per_source:
            return True

        # Over limit — mark digest pending
        if new_count == self._max_per_source + 1:
            self._conn.execute(
                "UPDATE throttle_state SET digest_pending=1 WHERE source=?",
                (source,)
            )
            self._conn.commit()
            logger.info("Throttle activated for source=%s (count=%d)", source, new_count)

        return False

    def get_pending_digests(self):
        """Get sources that have pending digests ready to send."""
        now = datetime.now(timezone.utc)
        rows = self._conn.execute(
            "SELECT source, window_start, event_count FROM throttle_state "
            "WHERE digest_pending = 1"
        ).fetchall()

        ready = []
        for row in rows:
            window_start = datetime.fromisoformat(row["window_start"])
            elapsed = (now - window_start).total_seconds()
            if elapsed >= self._digest_delay_sec:
                ready.append({
                    "source": row["source"],
                    "event_count": row["event_count"],
                    "throttled_count": row["event_count"] - self._max_per_source
                })
        return ready

    def mark_digest_sent(self, source):
        """Mark digest as sent for source."""
        self._conn.execute(
            "UPDATE throttle_state SET digest_pending=0 WHERE source=?",
            (source,)
        )
        self._conn.commit()

    def build_digest_message(self, source, conn):
        """Build digest notification content from throttled events."""
        rows = conn.execute(
            "SELECT severity, title FROM events "
            "WHERE source=? AND throttled=1 ORDER BY created_at DESC LIMIT 100",
            (source,)
        ).fetchall()

        severity_counts = {}
        for r in rows:
            sev = r["severity"]
            severity_counts[sev] = severity_counts.get(sev, 0) + 1

        count_str = ", ".join("%s: %d" % (k, v) for k, v in severity_counts.items())
        total = sum(severity_counts.values())

        title = "Digest: %d events from %s" % (total, source)
        body = "%s: %d events in %d minutes (%s)" % (
            source.capitalize(), total,
            self._window_sec // 60, count_str
        )
        return title, body
