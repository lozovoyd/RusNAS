# Notification System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a centralized notification bus daemon (`rusnas-notifyd`) with 5 delivery channels (Email, Telegram, MAX, SNMP, Webhook), configurable routing matrix, throttling, delivery history, log watcher, and a Cockpit UI page.

**Architecture:** Python daemon (`rusnas-notifyd`) listens on Unix socket + spool directory. Modules send events via CLI (`rusnas-notify send`) or socket. Daemon routes to channels per routing matrix, stores history in SQLite, applies throttling. Cockpit UI page with 4 tabs (Channels, Routing, History, Log Watcher). Periodic checker (`notify-check.py`) monitors RAID/SMART/UPS/snapshots/containers/network state changes.

**Tech Stack:** Python 3 (smtplib, urllib, sqlite3, inotify), systemd services, Cockpit plugin (vanilla JS/HTML/CSS).

**Spec:** `docs/superpowers/specs/2026-04-04-notification-system-design.md`

---

## File Map

### Create
- `rusnas-notify/daemon/notifyd.py` — Main daemon entry point
- `rusnas-notify/daemon/db.py` — SQLite DB init + helpers
- `rusnas-notify/daemon/config.py` — Config loader + defaults
- `rusnas-notify/daemon/throttle.py` — Per-source throttle logic
- `rusnas-notify/daemon/dispatcher.py` — Channel dispatch + retry
- `rusnas-notify/daemon/socket_server.py` — Unix socket server (events + API)
- `rusnas-notify/daemon/spool.py` — Spool directory watcher
- `rusnas-notify/daemon/log_watcher.py` — Custom log file monitor thread
- `rusnas-notify/daemon/channels/__init__.py` — Channel registry
- `rusnas-notify/daemon/channels/email_ch.py` — SMTP sender
- `rusnas-notify/daemon/channels/telegram_ch.py` — Telegram Bot API
- `rusnas-notify/daemon/channels/max_ch.py` — MAX Bot API
- `rusnas-notify/daemon/channels/snmp_ch.py` — SNMP trap sender
- `rusnas-notify/daemon/channels/webhook_ch.py` — HTTP webhook
- `rusnas-notify/cli.py` — CLI entry point (`rusnas-notify`)
- `rusnas-notify/config/notify.json` — Default configuration
- `rusnas-notify/service/rusnas-notifyd.service` — Daemon systemd unit
- `rusnas-notify/service/rusnas-notify-check.service` — Checker oneshot unit
- `rusnas-notify/service/rusnas-notify-check.timer` — Checker timer (5 min)
- `cockpit/rusnas/notifications.html` — UI page (4 tabs)
- `cockpit/rusnas/js/notifications.js` — UI logic
- `cockpit/rusnas/css/notifications.css` — UI styles
- `cockpit/rusnas/scripts/notify-check.py` — Periodic state checker
- `install-notify.sh` — Deploy to VM

### Modify
- `cockpit/rusnas/manifest.json` — Add "notifications" menu entry
- `rusnas-guard/daemon/response.py` — Replace notify.sh → rusnas-notify CLI
- `claude.MD` — Add notification system docs + dashboard rule

---

## Task 1: SQLite Database Module

**Files:**
- Create: `rusnas-notify/daemon/db.py`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p rusnas-notify/daemon/channels
mkdir -p rusnas-notify/config
mkdir -p rusnas-notify/service
touch rusnas-notify/daemon/__init__.py
touch rusnas-notify/daemon/channels/__init__.py
```

- [ ] **Step 2: Write db.py**

```python
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
    """Open SQLite connection with WAL mode."""
    db_path = path or DB_PATH
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
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
```

- [ ] **Step 3: Commit**

```bash
git add rusnas-notify/
git commit -m "feat(notify): SQLite database module with event queue and delivery history"
```

---

## Task 2: Config Module + Default Config

**Files:**
- Create: `rusnas-notify/daemon/config.py`
- Create: `rusnas-notify/config/notify.json`

- [ ] **Step 1: Write config.py**

```python
#!/usr/bin/env python3
"""Configuration loader for rusnas-notify daemon."""

import json
import logging
import os

logger = logging.getLogger("rusnas-notify.config")

CONFIG_PATH = "/etc/rusnas/notify.json"

DEFAULT_CONFIG = {
    "channels": {
        "email": {
            "enabled": False,
            "smtp_host": "",
            "smtp_port": 587,
            "smtp_tls": "starttls",
            "smtp_user": "",
            "smtp_pass": "",
            "recipients": [],
            "from": "rusNAS <noreply@localhost>"
        },
        "telegram": {
            "enabled": False,
            "bot_token": "",
            "chat_ids": []
        },
        "max": {
            "enabled": False,
            "bot_token": "",
            "chat_ids": []
        },
        "snmp": {
            "enabled": False,
            "version": "v2c",
            "community": "public",
            "trap_receivers": [],
            "v3_username": "",
            "v3_auth_protocol": "SHA",
            "v3_auth_password": "",
            "v3_priv_protocol": "AES",
            "v3_priv_password": ""
        },
        "webhook": {
            "enabled": False,
            "urls": [],
            "method": "POST",
            "headers": {},
            "timeout_sec": 10
        }
    },
    "routing": {
        "guard":      {"email": True, "telegram": True, "max": False, "snmp": True, "webhook": True},
        "ups":        {"email": True, "telegram": True, "max": False, "snmp": True, "webhook": False},
        "raid":       {"email": True, "telegram": True, "max": False, "snmp": True, "webhook": False},
        "snapshots":  {"email": True, "telegram": False, "max": False, "snmp": False, "webhook": False},
        "storage":    {"email": True, "telegram": False, "max": False, "snmp": False, "webhook": False},
        "network":    {"email": True, "telegram": False, "max": False, "snmp": False, "webhook": False},
        "security":   {"email": True, "telegram": True, "max": False, "snmp": True, "webhook": False},
        "containers": {"email": True, "telegram": False, "max": False, "snmp": False, "webhook": False},
        "system":     {"email": True, "telegram": True, "max": False, "snmp": True, "webhook": False},
        "custom":     {"email": True, "telegram": False, "max": False, "snmp": False, "webhook": False}
    },
    "throttle": {
        "window_sec": 300,
        "max_per_source": 5,
        "digest_delay_sec": 60
    },
    "retry": {
        "max_attempts": 3,
        "backoff_sec": [30, 120, 600]
    },
    "log_watchers": []
}


def load_config(path=None):
    """Load config from file, merging with defaults."""
    config_path = path or CONFIG_PATH
    config = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy

    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                user = json.load(f)
            _deep_merge(config, user)
            logger.info("Config loaded from %s", config_path)
        except Exception as e:
            logger.error("Failed to load config %s: %s, using defaults", config_path, e)
    else:
        logger.info("No config file at %s, using defaults", config_path)

    return config


def save_config(config, path=None):
    """Save config to file."""
    config_path = path or CONFIG_PATH
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    logger.info("Config saved to %s", config_path)


def _deep_merge(base, override):
    """Recursively merge override into base dict."""
    for k, v in override.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
```

- [ ] **Step 2: Write default notify.json**

Write `rusnas-notify/config/notify.json` with the full default config from the spec (channels all disabled, default routing matrix, throttle defaults).

- [ ] **Step 3: Commit**

```bash
git add rusnas-notify/daemon/config.py rusnas-notify/config/notify.json
git commit -m "feat(notify): config loader with defaults and deep merge"
```

---

## Task 3: Channel Senders (all 5)

**Files:**
- Create: `rusnas-notify/daemon/channels/email_ch.py`
- Create: `rusnas-notify/daemon/channels/telegram_ch.py`
- Create: `rusnas-notify/daemon/channels/max_ch.py`
- Create: `rusnas-notify/daemon/channels/snmp_ch.py`
- Create: `rusnas-notify/daemon/channels/webhook_ch.py`
- Create: `rusnas-notify/daemon/channels/__init__.py`

- [ ] **Step 1: Write channel base and registry**

`rusnas-notify/daemon/channels/__init__.py`:
```python
"""Channel registry — maps channel name to send function."""

from . import email_ch, telegram_ch, max_ch, snmp_ch, webhook_ch

CHANNELS = {
    "email":    email_ch.send,
    "telegram": telegram_ch.send,
    "max":      max_ch.send,
    "snmp":     snmp_ch.send,
    "webhook":  webhook_ch.send,
}

TEST_CHANNELS = {
    "email":    email_ch.test,
    "telegram": telegram_ch.test,
    "max":      max_ch.test,
    "snmp":     snmp_ch.test,
    "webhook":  webhook_ch.test,
}
```

- [ ] **Step 2: Write email_ch.py**

```python
#!/usr/bin/env python3
"""Email (SMTP) delivery channel."""

import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

logger = logging.getLogger("rusnas-notify.ch.email")

SEVERITY_COLORS = {
    "critical": "#dc2626",
    "warning":  "#d97706",
    "info":     "#2563eb",
}


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send notification email. Returns (ok, error_msg)."""
    host = channel_cfg.get("smtp_host", "")
    port = channel_cfg.get("smtp_port", 587)
    tls_mode = channel_cfg.get("smtp_tls", "starttls")
    user = channel_cfg.get("smtp_user", "")
    password = channel_cfg.get("smtp_pass", "")
    recipients = channel_cfg.get("recipients", [])
    from_addr = channel_cfg.get("from", "rusNAS <noreply@localhost>")

    if not host or not recipients:
        return False, "SMTP host or recipients not configured"

    subject = "[rusNAS] [%s] %s: %s" % (severity.upper(), source.capitalize(), title)
    color = SEVERITY_COLORS.get(severity, "#2563eb")

    html = (
        '<div style="font-family:sans-serif;max-width:600px">'
        '<div style="background:%s;color:white;padding:12px 16px;border-radius:8px 8px 0 0">'
        '<strong>%s</strong></div>'
        '<div style="background:#f8fafc;padding:16px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px">'
        '<p><strong>%s</strong></p>'
        '<p style="color:#475569">%s</p>'
        '<hr style="border:none;border-top:1px solid #e2e8f0">'
        '<small style="color:#94a3b8">rusNAS Notification System</small>'
        '</div></div>'
    ) % (color, subject, title, body or "")

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = ", ".join(recipients)
    msg.attach(MIMEText(body or title, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))

    try:
        if tls_mode == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=15)
        else:
            server = smtplib.SMTP(host, port, timeout=15)
            if tls_mode == "starttls":
                server.starttls()
        if user:
            server.login(user, password)
        server.sendmail(from_addr, recipients, msg.as_string())
        server.quit()
        logger.info("Email sent to %s", recipients)
        return True, None
    except Exception as e:
        logger.error("Email send failed: %s", e)
        return False, str(e)


def test(channel_cfg):
    """Send test email. Returns (ok, error_msg)."""
    return send(
        channel_cfg, "test", "info",
        "Тестовое уведомление / Test notification",
        "Это тестовое уведомление от rusNAS.\nThis is a test notification from rusNAS."
    )
```

- [ ] **Step 3: Write telegram_ch.py**

```python
#!/usr/bin/env python3
"""Telegram Bot API delivery channel."""

import json
import logging
import re
import urllib.request
import urllib.error

logger = logging.getLogger("rusnas-notify.ch.telegram")

SEVERITY_EMOJI = {"critical": "\U0001f534", "warning": "\U0001f7e1", "info": "\U0001f535"}
API_URL = "https://api.telegram.org/bot%s/sendMessage"


def _escape_md(text):
    """Escape MarkdownV2 special characters."""
    return re.sub(r'([_*\[\]()~`>#+\-=|{}.!\\])', r'\\\1', str(text))


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send to all chat_ids. Returns (ok, error_msg)."""
    token = channel_cfg.get("bot_token", "")
    chat_ids = channel_cfg.get("chat_ids", [])

    if not token or not chat_ids:
        return False, "Bot token or chat_ids not configured"

    emoji = SEVERITY_EMOJI.get(severity, "\u2139\ufe0f")
    text = "%s *%s*\n*%s* \\| %s\n\n%s" % (
        emoji,
        _escape_md(severity.upper()),
        _escape_md(source.capitalize()),
        _escape_md(title),
        _escape_md(body or "")
    )

    url = API_URL % token
    errors = []
    for chat_id in chat_ids:
        payload = json.dumps({
            "chat_id": str(chat_id),
            "text": text,
            "parse_mode": "MarkdownV2"
        }).encode("utf-8")
        req = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
            logger.info("Telegram sent to chat %s", chat_id)
        except Exception as e:
            errors.append("chat %s: %s" % (chat_id, e))
            logger.error("Telegram send to %s failed: %s", chat_id, e)

    if errors:
        return False, "; ".join(errors)
    return True, None


def test(channel_cfg):
    return send(
        channel_cfg, "test", "info",
        "Тестовое уведомление / Test notification",
        "Это тестовое уведомление от rusNAS."
    )
```

- [ ] **Step 4: Write max_ch.py**

```python
#!/usr/bin/env python3
"""MAX (VK Teams) Bot API delivery channel."""

import json
import logging
import urllib.request
import urllib.error

logger = logging.getLogger("rusnas-notify.ch.max")

API_URL = "https://platform-api.max.ru/messages"
SEVERITY_EMOJI = {"critical": "\U0001f534", "warning": "\U0001f7e1", "info": "\U0001f535"}


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send to all chat_ids via MAX API."""
    token = channel_cfg.get("bot_token", "")
    chat_ids = channel_cfg.get("chat_ids", [])

    if not token or not chat_ids:
        return False, "Bot token or chat_ids not configured"

    emoji = SEVERITY_EMOJI.get(severity, "")
    text = "%s **%s** | %s\n\n%s" % (
        emoji, severity.upper(), title, body or ""
    )

    errors = []
    for chat_id in chat_ids:
        payload = json.dumps({
            "chat_id": str(chat_id),
            "text": text,
            "format": "markdown"
        }).encode("utf-8")
        req = urllib.request.Request(API_URL, data=payload, headers={
            "Content-Type": "application/json",
            "Authorization": token
        })
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
            logger.info("MAX sent to chat %s", chat_id)
        except Exception as e:
            errors.append("chat %s: %s" % (chat_id, e))
            logger.error("MAX send to %s failed: %s", chat_id, e)

    if errors:
        return False, "; ".join(errors)
    return True, None


def test(channel_cfg):
    return send(
        channel_cfg, "test", "info",
        "Тестовое уведомление / Test notification",
        "Это тестовое уведомление от rusNAS."
    )
```

- [ ] **Step 5: Write snmp_ch.py**

```python
#!/usr/bin/env python3
"""SNMP trap delivery channel."""

import logging
import subprocess

logger = logging.getLogger("rusnas-notify.ch.snmp")

# rusNAS enterprise OID
ENTERPRISE_OID = ".1.3.6.1.4.1.99999"
SEVERITY_MAP = {"critical": "2", "warning": "1", "info": "0"}


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send SNMPv2c/v3 trap to all receivers."""
    receivers = channel_cfg.get("trap_receivers", [])
    version = channel_cfg.get("version", "v2c")

    if not receivers:
        return False, "No trap receivers configured"

    errors = []
    for receiver in receivers:
        host_port = receiver if ":" in receiver else receiver + ":162"
        try:
            if version == "v2c":
                community = channel_cfg.get("community", "public")
                cmd = [
                    "snmptrap", "-v", "2c", "-c", community,
                    host_port, "", ENTERPRISE_OID,
                    ENTERPRISE_OID + ".1", "s", source,
                    ENTERPRISE_OID + ".2", "s", severity,
                    ENTERPRISE_OID + ".3", "s", title,
                    ENTERPRISE_OID + ".4", "s", body or "",
                ]
            else:
                cmd = [
                    "snmptrap", "-v", "3",
                    "-u", channel_cfg.get("v3_username", ""),
                    "-l", "authPriv",
                    "-a", channel_cfg.get("v3_auth_protocol", "SHA"),
                    "-A", channel_cfg.get("v3_auth_password", ""),
                    "-x", channel_cfg.get("v3_priv_protocol", "AES"),
                    "-X", channel_cfg.get("v3_priv_password", ""),
                    host_port, "", ENTERPRISE_OID,
                    ENTERPRISE_OID + ".1", "s", source,
                    ENTERPRISE_OID + ".2", "s", severity,
                    ENTERPRISE_OID + ".3", "s", title,
                    ENTERPRISE_OID + ".4", "s", body or "",
                ]
            subprocess.run(cmd, check=True, capture_output=True, timeout=10)
            logger.info("SNMP trap sent to %s", host_port)
        except FileNotFoundError:
            errors.append("%s: snmptrap not installed (apt install snmp)" % host_port)
        except Exception as e:
            errors.append("%s: %s" % (host_port, e))
            logger.error("SNMP trap to %s failed: %s", host_port, e)

    if errors:
        return False, "; ".join(errors)
    return True, None


def test(channel_cfg):
    return send(
        channel_cfg, "test", "info",
        "rusNAS test trap",
        "This is a test SNMP trap from rusNAS."
    )
```

- [ ] **Step 6: Write webhook_ch.py**

```python
#!/usr/bin/env python3
"""HTTP Webhook delivery channel."""

import json
import logging
import urllib.request
import urllib.error
from datetime import datetime, timezone

logger = logging.getLogger("rusnas-notify.ch.webhook")


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send JSON payload to all webhook URLs."""
    urls = channel_cfg.get("urls", [])
    method = channel_cfg.get("method", "POST")
    headers = channel_cfg.get("headers", {})
    timeout = channel_cfg.get("timeout_sec", 10)

    if not urls:
        return False, "No webhook URLs configured"

    payload = json.dumps({
        "source": source,
        "severity": severity,
        "title": title,
        "body": body or "",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "extra": json.loads(extra_json) if extra_json else None
    }).encode("utf-8")

    req_headers = {"Content-Type": "application/json"}
    req_headers.update(headers)

    errors = []
    for url in urls:
        req = urllib.request.Request(url, data=payload, headers=req_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp.read()
            logger.info("Webhook sent to %s", url)
        except Exception as e:
            errors.append("%s: %s" % (url, e))
            logger.error("Webhook to %s failed: %s", url, e)

    if errors:
        return False, "; ".join(errors)
    return True, None


def test(channel_cfg):
    return send(
        channel_cfg, "test", "info",
        "rusNAS test webhook",
        "This is a test webhook from rusNAS."
    )
```

- [ ] **Step 7: Commit**

```bash
git add rusnas-notify/daemon/channels/
git commit -m "feat(notify): 5 delivery channels — Email, Telegram, MAX, SNMP, Webhook"
```

---

## Task 4: Throttle Module

**Files:**
- Create: `rusnas-notify/daemon/throttle.py`

- [ ] **Step 1: Write throttle.py**

```python
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
```

- [ ] **Step 2: Commit**

```bash
git add rusnas-notify/daemon/throttle.py
git commit -m "feat(notify): per-source throttle with digest support"
```

---

## Task 5: Dispatcher Module

**Files:**
- Create: `rusnas-notify/daemon/dispatcher.py`

- [ ] **Step 1: Write dispatcher.py**

```python
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
```

- [ ] **Step 2: Commit**

```bash
git add rusnas-notify/daemon/dispatcher.py
git commit -m "feat(notify): delivery dispatcher with routing and retry"
```

---

## Task 6: Socket Server + Spool Watcher

**Files:**
- Create: `rusnas-notify/daemon/socket_server.py`
- Create: `rusnas-notify/daemon/spool.py`

- [ ] **Step 1: Write socket_server.py**

Newline-delimited JSON protocol over Unix domain socket. Commands:
- `send` — submit event
- `test` — test channel
- `get_config` — read config
- `save_config` — update config
- `get_history` — query history
- `status` — daemon status

```python
#!/usr/bin/env python3
"""Unix socket server for rusnas-notifyd.

Protocol: newline-delimited JSON. One request per line, one response per line.
No authentication required (socket permissions control access).
"""

import json
import logging
import os
import socket
import threading

logger = logging.getLogger("rusnas-notify.socket")

SOCK_PATH = "/run/rusnas-notify/notify.sock"


class NotifySocketServer:
    def __init__(self, daemon):
        self._daemon = daemon
        self._server = None
        self._thread = None
        self._running = False

    def start(self):
        os.makedirs(os.path.dirname(SOCK_PATH), exist_ok=True)
        if os.path.exists(SOCK_PATH):
            os.unlink(SOCK_PATH)
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(SOCK_PATH)
        os.chmod(SOCK_PATH, 0o666)
        self._server.listen(8)
        self._server.settimeout(1.0)
        self._running = True
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()
        logger.info("Socket server listening on %s", SOCK_PATH)

    def stop(self):
        self._running = False
        if self._server:
            self._server.close()
        if os.path.exists(SOCK_PATH):
            os.unlink(SOCK_PATH)

    def _accept_loop(self):
        while self._running:
            try:
                conn, _ = self._server.accept()
                t = threading.Thread(target=self._handle_client, args=(conn,), daemon=True)
                t.start()
            except socket.timeout:
                continue
            except OSError:
                break

    def _handle_client(self, conn):
        try:
            buf = b""
            while True:
                data = conn.recv(4096)
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    try:
                        req = json.loads(line.decode("utf-8"))
                        resp = self._dispatch(req)
                    except Exception as e:
                        resp = {"ok": False, "error": str(e)}
                    conn.sendall(json.dumps(resp, ensure_ascii=False).encode("utf-8") + b"\n")
        except Exception as e:
            logger.error("Socket client error: %s", e)
        finally:
            conn.close()

    def _dispatch(self, req):
        cmd = req.get("cmd", "")
        try:
            if cmd == "send":
                return self._daemon.handle_event(req)
            elif cmd == "test":
                return self._daemon.handle_test(req)
            elif cmd == "get_config":
                return {"ok": True, "config": self._daemon.get_config()}
            elif cmd == "save_config":
                return self._daemon.save_config(req.get("config", {}))
            elif cmd == "get_history":
                return self._daemon.get_history(req)
            elif cmd == "status":
                return self._daemon.get_status()
            else:
                return {"ok": False, "error": "Unknown command: %s" % cmd}
        except Exception as e:
            logger.error("Command %s failed: %s", cmd, e)
            return {"ok": False, "error": str(e)}
```

- [ ] **Step 2: Write spool.py**

```python
#!/usr/bin/env python3
"""Spool directory watcher — picks up JSON files dropped by CLI fallback."""

import json
import logging
import os
import threading
import time

logger = logging.getLogger("rusnas-notify.spool")

SPOOL_DIR = "/var/spool/rusnas-notify"


class SpoolWatcher:
    def __init__(self, daemon):
        self._daemon = daemon
        self._running = False
        self._thread = None

    def start(self):
        os.makedirs(SPOOL_DIR, exist_ok=True)
        self._running = True
        self._thread = threading.Thread(target=self._watch_loop, daemon=True)
        self._thread.start()
        logger.info("Spool watcher started on %s", SPOOL_DIR)

    def stop(self):
        self._running = False

    def _watch_loop(self):
        while self._running:
            try:
                files = sorted(f for f in os.listdir(SPOOL_DIR) if f.endswith(".json"))
                for fname in files:
                    path = os.path.join(SPOOL_DIR, fname)
                    try:
                        with open(path, "r") as f:
                            req = json.load(f)
                        os.unlink(path)
                        req["cmd"] = "send"
                        self._daemon.handle_event(req)
                        logger.info("Processed spool file: %s", fname)
                    except Exception as e:
                        logger.error("Failed to process spool file %s: %s", fname, e)
                        # Move bad file so we don't retry forever
                        try:
                            os.rename(path, path + ".bad")
                        except OSError:
                            pass
            except Exception as e:
                logger.error("Spool watcher error: %s", e)
            time.sleep(2)
```

- [ ] **Step 3: Commit**

```bash
git add rusnas-notify/daemon/socket_server.py rusnas-notify/daemon/spool.py
git commit -m "feat(notify): Unix socket server and spool directory watcher"
```

---

## Task 7: Main Daemon (notifyd.py)

**Files:**
- Create: `rusnas-notify/daemon/notifyd.py`

- [ ] **Step 1: Write notifyd.py**

```python
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
```

- [ ] **Step 2: Commit**

```bash
git add rusnas-notify/daemon/notifyd.py
git commit -m "feat(notify): main daemon — event routing, throttle, socket, spool"
```

---

## Task 8: CLI Utility

**Files:**
- Create: `rusnas-notify/cli.py`

- [ ] **Step 1: Write cli.py**

```python
#!/usr/bin/env python3
"""rusnas-notify — CLI for the rusNAS notification system.

Usage:
  rusnas-notify send --source guard --severity critical --title "..." --body "..."
  rusnas-notify test --channel telegram
  rusnas-notify history [--limit N] [--source X]
  rusnas-notify status
"""

import argparse
import json
import os
import socket
import sys
import time

SOCK_PATH = "/run/rusnas-notify/notify.sock"
SPOOL_DIR = "/var/spool/rusnas-notify"


def socket_send(req):
    """Send request via Unix socket. Returns response dict or None."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(SOCK_PATH)
        s.sendall(json.dumps(req).encode("utf-8") + b"\n")
        buf = b""
        while b"\n" not in buf:
            data = s.recv(4096)
            if not data:
                break
            buf += data
        s.close()
        if buf:
            return json.loads(buf.split(b"\n")[0].decode("utf-8"))
        return None
    except Exception:
        return None


def spool_write(req):
    """Fallback: write event to spool directory."""
    os.makedirs(SPOOL_DIR, exist_ok=True)
    event_id = "evt_%d_%d" % (int(time.time() * 1000), os.getpid())
    path = os.path.join(SPOOL_DIR, "%s.json" % event_id)
    req["_event_id"] = event_id
    with open(path, "w") as f:
        json.dump(req, f)
    return event_id


def cmd_send(args):
    extra = args.extra
    if extra:
        try:
            json.loads(extra)
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": "Invalid --extra JSON"}))
            sys.exit(1)

    req = {
        "cmd": "send",
        "source": args.source,
        "severity": args.severity,
        "title": args.title,
        "body": args.body or "",
        "extra": extra
    }

    resp = socket_send(req)
    if resp:
        print(json.dumps(resp))
    else:
        event_id = spool_write(req)
        print(json.dumps({"ok": True, "event_id": event_id, "spooled": True}))


def cmd_test(args):
    req = {"cmd": "test", "channel": args.channel}
    resp = socket_send(req)
    if resp:
        print(json.dumps(resp))
    else:
        print(json.dumps({"ok": False, "error": "Daemon not running"}))
        sys.exit(1)


def cmd_history(args):
    req = {"cmd": "get_history", "limit": args.limit, "offset": args.offset}
    if args.source:
        req["source"] = args.source
    resp = socket_send(req)
    if resp:
        print(json.dumps(resp, indent=2, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": "Daemon not running"}))
        sys.exit(1)


def cmd_status(args):
    resp = socket_send({"cmd": "status"})
    if resp:
        print(json.dumps(resp, indent=2))
    else:
        print(json.dumps({"ok": False, "running": False}))


def main():
    parser = argparse.ArgumentParser(description="rusNAS Notification CLI")
    sub = parser.add_subparsers(dest="command")

    p_send = sub.add_parser("send", help="Send notification event")
    p_send.add_argument("--source", required=True)
    p_send.add_argument("--severity", required=True, choices=["critical", "warning", "info"])
    p_send.add_argument("--title", required=True)
    p_send.add_argument("--body", default="")
    p_send.add_argument("--extra", default=None, help="Extra JSON payload")

    p_test = sub.add_parser("test", help="Test a delivery channel")
    p_test.add_argument("--channel", required=True,
                        choices=["email", "telegram", "max", "snmp", "webhook"])

    p_hist = sub.add_parser("history", help="View notification history")
    p_hist.add_argument("--limit", type=int, default=20)
    p_hist.add_argument("--offset", type=int, default=0)
    p_hist.add_argument("--source", default=None)

    sub.add_parser("status", help="Daemon status")

    args = parser.parse_args()
    if args.command == "send":
        cmd_send(args)
    elif args.command == "test":
        cmd_test(args)
    elif args.command == "history":
        cmd_history(args)
    elif args.command == "status":
        cmd_status(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Commit**

```bash
git add rusnas-notify/cli.py
git commit -m "feat(notify): CLI utility — send, test, history, status commands"
```

---

## Task 9: Log Watcher Thread

**Files:**
- Create: `rusnas-notify/daemon/log_watcher.py`

- [ ] **Step 1: Write log_watcher.py**

```python
#!/usr/bin/env python3
"""Custom log file monitor — watches log files and matches regex patterns."""

import logging
import os
import re
import subprocess
import threading

logger = logging.getLogger("rusnas-notify.logwatcher")


class LogWatcher:
    def __init__(self, daemon, watchers_config):
        self._daemon = daemon
        self._watchers = [w for w in watchers_config if w.get("enabled", True)]
        self._threads = []
        self._running = False

    def start(self):
        if not self._watchers:
            return
        self._running = True
        # Group watchers by file
        by_file = {}
        for w in self._watchers:
            f = w.get("file", "")
            if f:
                by_file.setdefault(f, []).append(w)

        for filepath, rules in by_file.items():
            t = threading.Thread(target=self._tail_file, args=(filepath, rules), daemon=True)
            t.start()
            self._threads.append(t)
            logger.info("Watching %s with %d rules", filepath, len(rules))

    def stop(self):
        self._running = False

    def _tail_file(self, filepath, rules):
        """Tail a log file and match lines against rules."""
        compiled = []
        for r in rules:
            try:
                compiled.append({
                    "name": r.get("name", "unnamed"),
                    "pattern": re.compile(r["pattern"]),
                    "severity": r.get("severity", "warning"),
                })
            except re.error as e:
                logger.error("Invalid regex in rule '%s': %s", r.get("name", "?"), e)

        if not compiled:
            return

        try:
            proc = subprocess.Popen(
                ["tail", "-F", "-n", "0", filepath],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True
            )
        except Exception as e:
            logger.error("Cannot tail %s: %s", filepath, e)
            return

        while self._running:
            line = proc.stdout.readline()
            if not line:
                break
            line = line.strip()
            for rule in compiled:
                if rule["pattern"].search(line):
                    self._daemon.handle_event({
                        "source": "custom",
                        "severity": rule["severity"],
                        "title": rule["name"],
                        "body": line[:500],
                        "extra": '{"rule":"%s","file":"%s"}' % (rule["name"], filepath)
                    })

        proc.terminate()
```

- [ ] **Step 2: Commit**

```bash
git add rusnas-notify/daemon/log_watcher.py
git commit -m "feat(notify): log watcher thread — regex monitoring of log files"
```

---

## Task 10: Systemd Units

**Files:**
- Create: `rusnas-notify/service/rusnas-notifyd.service`
- Create: `rusnas-notify/service/rusnas-notify-check.service`
- Create: `rusnas-notify/service/rusnas-notify-check.timer`

- [ ] **Step 1: Write systemd units**

`rusnas-notifyd.service`:
```ini
[Unit]
Description=rusNAS Notification Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/usr/lib/rusnas/notify
ExecStart=/usr/lib/rusnas/notify/notifyd.py
Restart=on-failure
RestartSec=5
RuntimeDirectory=rusnas-notify
RuntimeDirectoryMode=0755
MemoryMax=32M
Nice=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rusnas-notifyd

[Install]
WantedBy=multi-user.target
```

`rusnas-notify-check.service`:
```ini
[Unit]
Description=rusNAS Notification State Checker
After=rusnas-notifyd.service

[Service]
Type=oneshot
User=root
ExecStart=/usr/share/cockpit/rusnas/scripts/notify-check.py
Nice=19
IOSchedulingClass=idle
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rusnas-notify-check
```

`rusnas-notify-check.timer`:
```ini
[Unit]
Description=rusNAS Notification Check Timer (every 5 min)

[Timer]
OnCalendar=*:0/5
Persistent=true
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
```

- [ ] **Step 2: Commit**

```bash
git add rusnas-notify/service/
git commit -m "feat(notify): systemd service units for daemon and checker"
```

---

## Task 11: Periodic State Checker (notify-check.py)

**Files:**
- Create: `cockpit/rusnas/scripts/notify-check.py`

- [ ] **Step 1: Write notify-check.py**

This oneshot script checks RAID, SMART, snapshots, containers, network, security state and fires events on state changes using `rusnas-notify send`. Uses a state file for deduplication.

```python
#!/usr/bin/env python3
"""rusnas-notify-check — periodic state checker.

Runs every 5 min via systemd timer. Checks subsystem states and
fires notification events via rusnas-notify CLI on state changes.
Uses /var/lib/rusnas/notify-check-state.json for deduplication.
"""

import json
import logging
import os
import subprocess
import sys

STATE_FILE = "/var/lib/rusnas/notify-check-state.json"
NOTIFY_CMD = "/usr/local/bin/rusnas-notify"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger("notify-check")


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def notify(source, severity, title, body="", extra=None):
    cmd = [NOTIFY_CMD, "send",
           "--source", source,
           "--severity", severity,
           "--title", title,
           "--body", body]
    if extra:
        cmd.extend(["--extra", json.dumps(extra)])
    try:
        subprocess.run(cmd, check=False, capture_output=True, timeout=10)
        logger.info("Notified: [%s] %s — %s", severity, source, title)
    except Exception as e:
        logger.error("Notify failed: %s", e)


def fire_on_change(state, key, current_value, source, severity, title, body="", extra=None):
    """Fire notification only if state changed."""
    prev = state.get(key)
    state[key] = current_value
    if prev != current_value and prev is not None:
        notify(source, severity, title, body, extra)
        return True
    return False


def check_raid(state):
    """Check mdadm RAID arrays."""
    try:
        out = subprocess.run(["cat", "/proc/mdstat"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return

    for line in out.split("\n"):
        if line.startswith("md"):
            parts = line.split()
            array = parts[0]  # e.g. md127
            status = "active" if "active" in line else "inactive"
            fire_on_change(state, "raid_%s_status" % array, status,
                          "raid", "critical" if status == "inactive" else "info",
                          "RAID %s: %s" % (array, status))

            # Check for degraded
            if "_" in out:
                # Find the [UU_U] pattern
                import re
                m = re.search(r'\[([U_]+)\]', out)
                if m and "_" in m.group(1):
                    fire_on_change(state, "raid_%s_degraded" % array, True,
                                  "raid", "critical",
                                  "RAID %s degraded" % array,
                                  "Array has missing/failed disk(s)")


def check_smart(state):
    """Check S.M.A.R.T. status for all disks."""
    try:
        out = subprocess.run(["lsblk", "-ndo", "NAME,TYPE"],
                            capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return

    for line in out.strip().split("\n"):
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "disk":
            disk = parts[0]
            try:
                smart = subprocess.run(
                    ["smartctl", "--json=c", "-H", "/dev/%s" % disk],
                    capture_output=True, text=True, timeout=10
                )
                data = json.loads(smart.stdout)
                passed = data.get("smart_status", {}).get("passed", True)
                fire_on_change(state, "smart_%s" % disk, passed,
                              "raid", "critical" if not passed else "info",
                              "S.M.A.R.T. %s: %s" % (disk, "PASSED" if passed else "FAILED"))

                # Temperature check
                temp = data.get("temperature", {}).get("current", 0)
                if temp > 55:
                    fire_on_change(state, "smart_%s_temp_warn" % disk, True,
                                  "raid", "warning",
                                  "Disk %s temperature: %d°C" % (disk, temp))
                else:
                    state["smart_%s_temp_warn" % disk] = False
            except Exception:
                pass


def check_snapshots(state):
    """Check for recent snapshot failures."""
    try:
        out = subprocess.run(
            ["/usr/local/bin/rusnas-snap", "events"],
            capture_output=True, text=True, timeout=10
        ).stdout
        events = json.loads(out)
        for ev in events.get("events", [])[-10:]:
            if ev.get("type") == "error":
                key = "snap_err_%s" % ev.get("id", "")
                fire_on_change(state, key, True,
                              "snapshots", "warning",
                              "Snapshot error: %s" % ev.get("message", "unknown"))
    except Exception:
        pass


def check_containers(state):
    """Check Docker/Podman container health."""
    try:
        out = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}"],
            capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return

    for line in out.strip().split("\n"):
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            name, status = parts[0], parts[1]
            is_running = "Up" in status
            fire_on_change(state, "container_%s" % name, is_running,
                          "containers", "warning" if not is_running else "info",
                          "Container %s: %s" % (name, "running" if is_running else "stopped"),
                          status)


def check_services(state):
    """Check critical service status."""
    services = ["smbd", "nmbd", "nfs-server", "apache2", "rusnas-guard", "rusnas-notifyd"]
    for svc in services:
        try:
            r = subprocess.run(["systemctl", "is-active", svc],
                              capture_output=True, text=True, timeout=5)
            active = r.stdout.strip() == "active"
            fire_on_change(state, "svc_%s" % svc, active,
                          "system", "critical" if not active else "info",
                          "Service %s: %s" % (svc, "active" if active else "STOPPED"))
        except Exception:
            pass


def check_certs(state):
    """Check SSL certificate expiration."""
    cert_dirs = ["/etc/letsencrypt/live/"]
    for cert_dir in cert_dirs:
        if not os.path.isdir(cert_dir):
            continue
        for domain in os.listdir(cert_dir):
            cert = os.path.join(cert_dir, domain, "fullchain.pem")
            if not os.path.exists(cert):
                continue
            try:
                out = subprocess.run(
                    ["openssl", "x509", "-enddate", "-noout", "-in", cert],
                    capture_output=True, text=True, timeout=5
                ).stdout
                # Parse date and check if <14 days
                import datetime
                date_str = out.strip().split("=")[1]
                exp = datetime.datetime.strptime(date_str, "%b %d %H:%M:%S %Y %Z")
                days_left = (exp - datetime.datetime.utcnow()).days
                if days_left < 14:
                    fire_on_change(state, "cert_%s" % domain, days_left,
                                  "network", "warning",
                                  "Certificate %s expires in %d days" % (domain, days_left))
            except Exception:
                pass


def check_brute_force(state):
    """Check for brute-force login attempts."""
    try:
        out = subprocess.run(
            ["journalctl", "-u", "ssh", "--since", "5 min ago", "--no-pager", "-q"],
            capture_output=True, text=True, timeout=10
        ).stdout
        failed = out.count("Failed password")
        if failed > 5:
            fire_on_change(state, "bruteforce_count", failed,
                          "security", "warning",
                          "Brute-force detected: %d failed SSH logins in 5 min" % failed)
        else:
            state["bruteforce_count"] = 0
    except Exception:
        pass


def main():
    state = load_state()
    check_raid(state)
    check_smart(state)
    check_snapshots(state)
    check_containers(state)
    check_services(state)
    check_certs(state)
    check_brute_force(state)
    save_state(state)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Commit**

```bash
git add cockpit/rusnas/scripts/notify-check.py
git commit -m "feat(notify): periodic state checker — RAID, SMART, containers, certs, brute-force"
```

---

## Task 12: Installation Script

**Files:**
- Create: `install-notify.sh`

- [ ] **Step 1: Write install-notify.sh**

Follow existing `install-guard.sh` pattern: upload files via SCP, install via SSH+sudo.

```bash
#!/bin/bash
# install-notify.sh — Deploy rusNAS notification system to VM
set -e

VM_HOST="10.10.10.72"
VM_USER="rusnas"
VM_PASS="kl4389qd"

SSH="sshpass -p ${VM_PASS} ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SCP="sshpass -p ${VM_PASS} scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Uploading notification daemon files..."
$SSH ${VM_USER}@${VM_HOST} "mkdir -p /tmp/rusnas-notify-install/daemon/channels /tmp/rusnas-notify-install/service /tmp/rusnas-notify-install/config"

$SCP ${DIR}/rusnas-notify/daemon/*.py ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/daemon/
$SCP ${DIR}/rusnas-notify/daemon/channels/*.py ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/daemon/channels/
$SCP ${DIR}/rusnas-notify/cli.py ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/
$SCP ${DIR}/rusnas-notify/config/notify.json ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/config/
$SCP ${DIR}/rusnas-notify/service/*.service ${DIR}/rusnas-notify/service/*.timer ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/service/
$SCP ${DIR}/cockpit/rusnas/scripts/notify-check.py ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/

echo "==> Uploading Cockpit UI files..."
$SCP ${DIR}/cockpit/rusnas/notifications.html ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/
$SCP ${DIR}/cockpit/rusnas/js/notifications.js ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/
$SCP ${DIR}/cockpit/rusnas/css/notifications.css ${VM_USER}@${VM_HOST}:/tmp/rusnas-notify-install/

echo "==> Installing on VM..."
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -s" << 'REMOTE'
set -e

# Install dependencies
apt-get install -y snmp 2>/dev/null || true

# ── Daemon files
mkdir -p /usr/lib/rusnas/notify/channels
cp /tmp/rusnas-notify-install/daemon/*.py /usr/lib/rusnas/notify/
cp /tmp/rusnas-notify-install/daemon/channels/*.py /usr/lib/rusnas/notify/channels/
chmod 644 /usr/lib/rusnas/notify/*.py /usr/lib/rusnas/notify/channels/*.py
chmod 755 /usr/lib/rusnas/notify/notifyd.py

# ── CLI
cp /tmp/rusnas-notify-install/cli.py /usr/lib/rusnas/notify/cli.py
chmod 755 /usr/lib/rusnas/notify/cli.py
ln -sf /usr/lib/rusnas/notify/cli.py /usr/local/bin/rusnas-notify

# ── Config (preserve existing)
mkdir -p /etc/rusnas
[ -f /etc/rusnas/notify.json ] || cp /tmp/rusnas-notify-install/config/notify.json /etc/rusnas/notify.json
chmod 640 /etc/rusnas/notify.json

# ── Directories
mkdir -p /var/lib/rusnas
mkdir -p /var/spool/rusnas-notify
mkdir -p /var/log/rusnas
mkdir -p /run/rusnas-notify
chmod 755 /run/rusnas-notify

# ── Systemd
cp /tmp/rusnas-notify-install/service/*.service /lib/systemd/system/
cp /tmp/rusnas-notify-install/service/*.timer /lib/systemd/system/
chmod 644 /lib/systemd/system/rusnas-notifyd.service
chmod 644 /lib/systemd/system/rusnas-notify-check.service
chmod 644 /lib/systemd/system/rusnas-notify-check.timer

# ── Sudoers
cat > /etc/sudoers.d/rusnas-notify << 'SUDOERS'
rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-notify
SUDOERS
chmod 440 /etc/sudoers.d/rusnas-notify

# ── Checker script
cp /tmp/rusnas-notify-install/notify-check.py /usr/share/cockpit/rusnas/scripts/notify-check.py
chmod 755 /usr/share/cockpit/rusnas/scripts/notify-check.py

# ── Cockpit UI
cp /tmp/rusnas-notify-install/notifications.html /usr/share/cockpit/rusnas/
cp /tmp/rusnas-notify-install/notifications.js /usr/share/cockpit/rusnas/js/
cp /tmp/rusnas-notify-install/notifications.css /usr/share/cockpit/rusnas/css/

# ── Init DB
python3 /usr/lib/rusnas/notify/notifyd.py --init-db

# ── Enable and start
systemctl daemon-reload
systemctl enable --now rusnas-notifyd.service
systemctl enable --now rusnas-notify-check.timer

# ── Cleanup
rm -rf /tmp/rusnas-notify-install

echo "==> rusnas-notify installed successfully"
REMOTE

echo "==> Done! Notification system deployed."
```

- [ ] **Step 2: Commit**

```bash
git add install-notify.sh
git commit -m "feat(notify): installation script for VM deployment"
```

---

## Task 13: Cockpit UI — Page Structure + CSS

**Files:**
- Create: `cockpit/rusnas/notifications.html`
- Create: `cockpit/rusnas/css/notifications.css`
- Modify: `cockpit/rusnas/manifest.json`

- [ ] **Step 1: Add manifest entry**

Add to `cockpit/rusnas/manifest.json` under `"menu"`:
```json
"notifications": {
    "label": "Уведомления",
    "order": 6
}
```

- [ ] **Step 2: Write notifications.html**

Full page with 4-tab structure matching existing rusNAS patterns (see spec section 6).

- [ ] **Step 3: Write notifications.css**

Channel cards, routing matrix, history table, log watcher builder — using existing design tokens from `style.css`.

- [ ] **Step 4: Commit**

```bash
git add cockpit/rusnas/notifications.html cockpit/rusnas/css/notifications.css cockpit/rusnas/manifest.json
git commit -m "feat(notify): Cockpit UI page scaffold — 4 tabs, channel cards, matrix"
```

---

## Task 14: Cockpit UI — JavaScript Logic

**Files:**
- Create: `cockpit/rusnas/js/notifications.js`

- [ ] **Step 1: Write notifications.js**

Socket communication via `cockpit.channel({payload:"stream", unix:SOCK_PATH})`. Tab switching, channel config CRUD, routing matrix toggles, history pagination with filters, log watcher rule CRUD. Test button per channel. Follows patterns from `guard.js`.

Key functions:
- `notifyCmd(cmd, data, callback)` — socket RPC
- `loadChannels()` / `saveChannel(name)` / `testChannel(name)`
- `loadRouting()` / `saveRouting()`
- `loadHistory(page)` with filters
- `loadLogWatchers()` / `addWatcher()` / `removeWatcher()` / `testWatcher()`
- Tab switching via `showTab(name)`

- [ ] **Step 2: Commit**

```bash
git add cockpit/rusnas/js/notifications.js
git commit -m "feat(notify): Cockpit UI JavaScript — socket API, channels, routing, history"
```

---

## Task 15: Guard Integration

**Files:**
- Modify: `rusnas-guard/daemon/response.py`

- [ ] **Step 1: Replace notify.sh with rusnas-notify CLI**

In `send_notification()` function, replace:
```python
# Old:
script = "/usr/lib/rusnas/notify.sh"
subprocess.run([script, subject, body], ...)

# New:
subprocess.run([
    "/usr/local/bin/rusnas-notify", "send",
    "--source", "guard", "--severity", severity,
    "--title", subject, "--body", body
], check=False, capture_output=True, timeout=15)
```

Detect severity from subject line or pass it as parameter.

- [ ] **Step 2: Commit**

```bash
git add rusnas-guard/daemon/response.py
git commit -m "feat(notify): integrate Guard daemon with notification bus"
```

---

## Task 16: Documentation

**Files:**
- Modify: `claude.MD`

- [ ] **Step 1: Add notification system section to claude.MD**

Add after "SSD-кеширование" section:
```markdown
## Notification System (rusnas-notify)
- Daemon: `/usr/lib/rusnas/notify/notifyd.py` (systemd Type=simple)
- CLI: `/usr/local/bin/rusnas-notify` (send, test, history, status)
- Socket: `/run/rusnas-notify/notify.sock` (0o666, no auth)
- Config: `/etc/rusnas/notify.json`
- DB: `/var/lib/rusnas/notify.db` (SQLite WAL)
- Spool: `/var/spool/rusnas-notify/` (CLI fallback)
- Channels: Email, Telegram, MAX, SNMP traps, Webhook
- Checker: `notify-check.py` via timer every 5 min
- Log Watcher: built-in thread, regex patterns from config
- RULE: any dashboard widget MUST have notification integration
```

- [ ] **Step 2: Commit**

```bash
git add claude.MD
git commit -m "docs: add notification system to claude.MD + dashboard notification rule"
```

---

## Task 17: Final Verification

- [ ] **Step 1: Run install-notify.sh on VM**

```bash
bash install-notify.sh
```

- [ ] **Step 2: Verify daemon running**

```bash
SSH="sshpass -p kl4389qd ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no rusnas@10.10.10.72"
$SSH "systemctl status rusnas-notifyd"
$SSH "sudo rusnas-notify status"
```

- [ ] **Step 3: Test CLI send**

```bash
$SSH "sudo rusnas-notify send --source test --severity info --title 'Test notification' --body 'Hello from rusNAS'"
$SSH "sudo rusnas-notify history --limit 5"
```

- [ ] **Step 4: Verify Cockpit UI loads**

Open `http://10.10.10.72:9090/cockpit/@localhost/rusnas/notifications.html` in browser.

- [ ] **Step 5: Test channel (if configured)**

```bash
$SSH "sudo rusnas-notify test --channel telegram"
```

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix(notify): post-deployment fixes"
```
