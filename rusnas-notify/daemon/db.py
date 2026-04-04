#!/usr/bin/env python3
"""SQLite database for rusnas-notify: event queue + delivery history."""

import os
import sqlite3
import time
import logging

logger = logging.getLogger("rusnas-notify.db")

DB_PATH = "/var/lib/rusnas/notify.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    severity    TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    extra_json  TEXT,
    created_at  TEXT NOT NULL,
    throttled   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deliveries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT NOT NULL REFERENCES events(id),
    channel     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER DEFAULT 0,
    sent_at     TEXT,
    error_msg   TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS throttle_state (
    source       TEXT PRIMARY KEY,
    window_start TEXT NOT NULL,
    event_count  INTEGER DEFAULT 0,
    digest_pending INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_event ON deliveries(event_id);
"""


def get_db(path=None):
    """Open SQLite connection with WAL mode. Safe for multi-threaded use."""
    db_path = path or DB_PATH
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db(path=None):
    """Create tables if they don't exist."""
    conn = get_db(path)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
    logger.info("Database initialized at %s", path or DB_PATH)


def gen_event_id():
    """Generate unique event ID: evt_{timestamp_ms}_{pid}."""
    return "evt_%d_%d" % (int(time.time() * 1000), os.getpid())


def insert_event(conn, event_id, source, severity, title, body, extra_json):
    """Insert event into DB. Returns event_id."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO events (id, source, severity, title, body, extra_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (event_id, source, severity, title, body, extra_json, now)
    )
    conn.commit()
    return event_id


def insert_delivery(conn, event_id, channel):
    """Create pending delivery row."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO deliveries (event_id, channel, status, created_at) VALUES (?, ?, 'pending', ?)",
        (event_id, channel, now)
    )
    conn.commit()


def update_delivery(conn, delivery_id, status, error_msg=None):
    """Update delivery status."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    if status == "sent":
        conn.execute(
            "UPDATE deliveries SET status=?, sent_at=?, attempts=attempts+1 WHERE id=?",
            (status, now, delivery_id)
        )
    else:
        conn.execute(
            "UPDATE deliveries SET status=?, error_msg=?, attempts=attempts+1 WHERE id=?",
            (status, error_msg, delivery_id)
        )
    conn.commit()


def get_pending_deliveries(conn):
    """Get all pending deliveries."""
    cur = conn.execute(
        "SELECT d.id, d.event_id, d.channel, d.attempts, "
        "e.source, e.severity, e.title, e.body, e.extra_json "
        "FROM deliveries d JOIN events e ON d.event_id = e.id "
        "WHERE d.status = 'pending' ORDER BY d.created_at"
    )
    return [dict(r) for r in cur.fetchall()]


def get_retry_deliveries(conn, backoff_sec):
    """Get failed deliveries eligible for retry."""
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    results = []
    cur = conn.execute(
        "SELECT d.id, d.event_id, d.channel, d.attempts, "
        "e.source, e.severity, e.title, e.body, e.extra_json, d.sent_at "
        "FROM deliveries d JOIN events e ON d.event_id = e.id "
        "WHERE d.status = 'failed' AND d.attempts < ? ORDER BY d.created_at",
        (len(backoff_sec),)
    )
    for r in cur.fetchall():
        row = dict(r)
        attempt_idx = row["attempts"] - 1
        if attempt_idx < 0:
            attempt_idx = 0
        wait = backoff_sec[min(attempt_idx, len(backoff_sec) - 1)]
        # Check if enough time has passed
        if row.get("sent_at"):
            last = datetime.fromisoformat(row["sent_at"])
            if (now - last).total_seconds() < wait:
                continue
        row["status"] = "pending"
        results.append(row)
    return results


def get_history(conn, limit=50, offset=0, source=None, severity=None, status=None):
    """Get notification history with filters."""
    where = []
    params = []
    if source:
        where.append("e.source = ?")
        params.append(source)
    if severity:
        where.append("e.severity = ?")
        params.append(severity)
    if status:
        where.append("d.status = ?")
        params.append(status)

    where_clause = " AND ".join(where) if where else "1=1"

    # Count total
    count_sql = (
        "SELECT COUNT(*) FROM deliveries d JOIN events e ON d.event_id = e.id WHERE " + where_clause
    )
    total = conn.execute(count_sql, params).fetchone()[0]

    # Fetch page
    sql = (
        "SELECT d.id, d.event_id, d.channel, d.status, d.attempts, d.sent_at, d.error_msg, "
        "e.source, e.severity, e.title, e.body, e.extra_json, e.created_at "
        "FROM deliveries d JOIN events e ON d.event_id = e.id "
        "WHERE " + where_clause +
        " ORDER BY e.created_at DESC LIMIT ? OFFSET ?"
    )
    params.extend([limit, offset])
    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    return {"total": total, "rows": rows}
