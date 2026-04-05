# rusNAS Notification System — Design Spec

**Date:** 2026-04-04
**Status:** Draft
**Author:** Claude + dvl92

## Context

rusNAS currently has fragmented notification capabilities: Guard daemon calls a stub `notify.sh`, UPS has its own `rusnas-ups-notify.sh` with Telegram/Email, and all other subsystems (RAID, snapshots, storage, network, containers) only show alerts in the Cockpit UI with no push notifications. Administrators need to keep the browser tab open to see issues.

**Problem:** No unified notification system — each module handles alerts independently (or not at all). Adding a new channel requires modifying every module. No delivery history, no throttling, no routing control.

**Goal:** Build a centralized notification bus daemon (`rusnas-notifyd`) that all modules publish events to, with configurable channel routing, delivery history, throttling, and a Cockpit UI for configuration.

## Architecture Overview

```
[Guard]      ──┐
[UPS]        ──┤  CLI / Unix Socket
[RAID check] ──┤──────────────────────► [rusnas-notifyd] ──► [Email]
[Snap check] ──┤                             │            ──► [Telegram]
[Storage]    ──┤                          SQLite DB       ──► [MAX]
[Network]    ──┤                       (queue + history)  ──► [SNMP]
[Security]   ──┤                                          ──► [Webhook]
[Containers] ──┤
[Log Watcher]──┤
[Custom CLI] ──┘
```

## 1. Backend Components

### 1.1 rusnas-notifyd (daemon)

- **Type:** Python daemon, systemd Type=simple
- **Socket:** `/run/rusnas-notify/notify.sock` (mode 0o666)
- **Spool:** `/var/spool/rusnas-notify/` (inotify watch, fallback for CLI when daemon is down)
- **Database:** `/var/lib/rusnas/notify.db` (SQLite, WAL mode)
- **Config:** `/etc/rusnas/notify.json`
- **Log:** `/var/log/rusnas/notify.log`
- **PID:** managed by systemd (no PID file)

**Main loop:**
1. Listen on Unix socket for incoming events (JSON protocol, newline-delimited)
2. Watch spool directory via inotify for CLI-dropped JSON files
3. Insert event into `events` table
4. Check throttle state per source
5. If under limit: create `deliveries` rows for each enabled channel per routing matrix
6. Dispatch deliveries in separate threads (one per channel type)
7. Update delivery status (sent/failed/throttled)
8. Retry failed deliveries per backoff schedule

**Resource constraints:**
- `MemoryMax=32M`
- `Nice=10`
- Restart on failure with 5s delay

### 1.2 rusnas-notify (CLI utility)

```bash
# Send event
rusnas-notify send \
  --source guard \
  --severity critical \
  --title "Ransomware detected" \
  --body "Honeypot triggered on /mnt/data" \
  --extra '{"files":["doc.txt"],"ip":"192.168.1.5"}'

# Test channel
rusnas-notify test --channel telegram

# List recent events
rusnas-notify history --limit 20 --source guard

# Get daemon status
rusnas-notify status
```

**Transport logic:**
1. Try Unix socket first (fast, ~1ms)
2. On socket error: write JSON file to `/var/spool/rusnas-notify/evt_{timestamp}_{pid}.json`
3. Return event_id to caller (stdout JSON: `{"ok":true,"event_id":"evt_..."}`)

**sudoers:** `rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-notify`

### 1.3 SQLite Schema

```sql
CREATE TABLE events (
    id          TEXT PRIMARY KEY,      -- "evt_1712200000123_4567"
    source      TEXT NOT NULL,         -- "guard", "ups", "raid", "snapshots", etc.
    severity    TEXT NOT NULL,         -- "critical", "warning", "info"
    title       TEXT NOT NULL,
    body        TEXT,
    extra_json  TEXT,                  -- arbitrary JSON payload
    created_at  TEXT NOT NULL,         -- ISO 8601 UTC
    throttled   INTEGER DEFAULT 0     -- 1 if part of a digest batch
);

CREATE TABLE deliveries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT NOT NULL REFERENCES events(id),
    channel     TEXT NOT NULL,         -- "email", "telegram", "max", "snmp", "webhook"
    status      TEXT NOT NULL DEFAULT 'pending', -- "pending", "sent", "failed", "throttled"
    attempts    INTEGER DEFAULT 0,
    sent_at     TEXT,                  -- ISO 8601 UTC
    error_msg   TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE throttle_state (
    source      TEXT PRIMARY KEY,
    window_start TEXT NOT NULL,
    event_count INTEGER DEFAULT 0,
    digest_pending INTEGER DEFAULT 0
);

CREATE INDEX idx_events_source ON events(source);
CREATE INDEX idx_events_created ON events(created_at);
CREATE INDEX idx_deliveries_status ON deliveries(status);
CREATE INDEX idx_deliveries_event ON deliveries(event_id);
```

### 1.4 Configuration (`/etc/rusnas/notify.json`)

```json
{
  "channels": {
    "email": {
      "enabled": true,
      "smtp_host": "smtp.yandex.ru",
      "smtp_port": 587,
      "smtp_tls": "starttls",
      "smtp_user": "nas@company.ru",
      "smtp_pass": "app-password",
      "recipients": ["admin@company.ru", "ops@company.ru"],
      "from": "rusNAS <nas@company.ru>"
    },
    "telegram": {
      "enabled": true,
      "bot_token": "7123456789:AAH...",
      "chat_ids": ["-100123456", "789012"]
    },
    "max": {
      "enabled": false,
      "bot_token": "",
      "chat_ids": []
    },
    "snmp": {
      "enabled": false,
      "version": "v2c",
      "community": "public",
      "trap_receivers": ["192.168.1.10:162"],
      "v3_username": "",
      "v3_auth_protocol": "SHA",
      "v3_auth_password": "",
      "v3_priv_protocol": "AES",
      "v3_priv_password": ""
    },
    "webhook": {
      "enabled": false,
      "urls": [],
      "method": "POST",
      "headers": {},
      "timeout_sec": 10
    }
  },
  "routing": {
    "guard":      {"email": true, "telegram": true, "max": false, "snmp": true, "webhook": true},
    "ups":        {"email": true, "telegram": true, "max": false, "snmp": true, "webhook": false},
    "raid":       {"email": true, "telegram": true, "max": false, "snmp": true, "webhook": false},
    "snapshots":  {"email": true, "telegram": false, "max": false, "snmp": false, "webhook": false},
    "storage":    {"email": true, "telegram": false, "max": false, "snmp": false, "webhook": false},
    "network":    {"email": true, "telegram": false, "max": false, "snmp": false, "webhook": false},
    "security":   {"email": true, "telegram": true, "max": false, "snmp": true, "webhook": false},
    "containers": {"email": true, "telegram": false, "max": false, "snmp": false, "webhook": false},
    "system":     {"email": true, "telegram": true, "max": false, "snmp": true, "webhook": false},
    "custom":     {"email": true, "telegram": false, "max": false, "snmp": false, "webhook": false}
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
```

## 2. Delivery Channels

### 2.1 Email (SMTP)

- Python `smtplib` + `email.mime`
- TLS modes: STARTTLS (port 587), SSL/TLS (port 465), None (port 25)
- HTML template with rusNAS logo, severity-colored banner (red=critical, yellow=warning, blue=info)
- Subject format: `[rusNAS] [CRITICAL] Guard: Ransomware detected`
- Multiple recipients via To: header
- Timeout: 15 sec

### 2.2 Telegram

- HTTP POST to `https://api.telegram.org/bot{token}/sendMessage`
- parse_mode: MarkdownV2
- Format: bold title, severity emoji, monospace details block
- Separate request per chat_id
- Timeout: 10 sec

### 2.3 MAX (VK Teams)

- HTTP POST to `https://platform-api.max.ru/messages`
- Header: `Authorization: {token}`
- Body: `{"chat_id": "...", "text": "...", "format": "markdown"}`
- Rate limit: max 30 req/sec (API constraint)
- Markdown formatting similar to Telegram
- Timeout: 10 sec

### 2.4 SNMP Traps

- Python `pysnmp` library
- **SNMPv2c:** community string + trap receivers
- **SNMPv3:** username + auth (MD5/SHA) + privacy (DES/AES) + passwords
- Enterprise OID: `.1.3.6.1.4.1.99999` (rusNAS)
- Trap varbinds: source, severity, title, body, timestamp
- UDP transport to all configured receivers

### 2.5 Webhook

- HTTP POST/PUT to arbitrary URLs
- JSON payload: `{source, severity, title, body, timestamp, extra}`
- Custom headers (for Bearer tokens, API keys)
- Timeout: 10 sec
- Works with Slack, Discord, PagerDuty, Mattermost, custom endpoints

### 2.6 Channel Testing

- CLI: `rusnas-notify test --channel telegram`
- Sends test message: "Тестовое уведомление rusNAS / Test notification from rusNAS"
- Returns JSON: `{"ok": true}` or `{"ok": false, "error": "Connection refused"}`
- UI button calls this command via cockpit.spawn

## 3. Event Sources

### 3.1 Full Event Table

| Module | Event | Severity | Source |
|--------|-------|----------|--------|
| **Guard** | Honeypot triggered | critical | response.py → CLI |
| **Guard** | Entropy anomaly | critical | response.py → CLI |
| **Guard** | IOPS spike | warning | response.py → CLI |
| **Guard** | Extension match | critical | response.py → CLI |
| **UPS** | On battery (ONBATT) | warning | ups-notify.sh → CLI |
| **UPS** | Low battery (LOWBATT) | critical | ups-notify.sh → CLI |
| **UPS** | Power restored (ONLINE) | info | ups-notify.sh → CLI |
| **UPS** | Battery replace (REPLBATT) | warning | ups-notify.sh → CLI |
| **UPS** | Comm lost (COMMLOST) | warning | ups-notify.sh → CLI |
| **RAID** | Array degraded | critical | notify-check timer |
| **RAID** | Array inactive | critical | notify-check timer |
| **RAID** | Disk failed/removed from array | critical | notify-check timer |
| **RAID** | Disk inserted (hot-plug) | info | notify-check timer (udev) |
| **RAID** | Disk removed (hot-unplug) | warning | notify-check timer (udev) |
| **RAID** | Rebuild started | info | notify-check timer |
| **RAID** | Rebuild complete | info | notify-check timer |
| **RAID** | S.M.A.R.T. test failed | critical | notify-check timer |
| **RAID** | S.M.A.R.T. attribute threshold | warning | notify-check timer |
| **RAID** | S.M.A.R.T. temperature >55°C | warning | notify-check timer |
| **Snapshots** | Creation failed | warning | notify-check timer |
| **Snapshots** | Replication failed | critical | notify-check timer |
| **Snapshots** | Scheduled snapshot OK (digest) | info | notify-check timer |
| **Storage** | Quota >95% | critical | notify-check timer |
| **Storage** | Quota >80% | warning | notify-check timer |
| **Storage** | Space forecast <7 days | warning | notify-check timer |
| **Storage** | Large deletion >1GB | warning | notify-check timer |
| **Storage** | WORM violation attempt | critical | notify-check timer |
| **Storage** | Dedup run completed | info | notify-check timer |
| **Network** | Cert expiring <14 days | warning | notify-check timer |
| **Network** | Cert renewal failed | critical | notify-check timer |
| **Network** | Bandwidth threshold exceeded | warning | notify-check timer |
| **Network** | Interface down | critical | notify-check timer |
| **Network** | Interface up | info | notify-check timer |
| **Security** | Brute-force (>5 fails/5min) | warning | notify-check timer |
| **Security** | Account locked | critical | notify-check timer |
| **Containers** | Container crashed/exited | warning | notify-check timer |
| **Containers** | Container OOM killed | critical | notify-check timer |
| **Containers** | Health check failed | warning | notify-check timer |
| **System** | Service crashed | critical | notify-check timer |
| **System** | Reboot detected | info | notify-check timer |
| **System** | Security update available | info | notify-check timer |
| **System** | Kernel update required | warning | notify-check timer |
| **System** | SSD tier health issue | warning | notify-check timer |
| **System** | CPU >90% sustained (>5min) | warning | notify-check timer |
| **System** | RAM >95% | warning | notify-check timer |
| **System** | Swap >50% | warning | notify-check timer |
| **System** | Night report (daily digest) | info | notify-check timer |
| **Custom** | Regex match in log file | configurable | log watcher thread |

### 3.2 Integration Points

**Guard daemon** — replace `notify.sh` call in `response.py`:
```python
subprocess.run(["rusnas-notify", "send",
    "--source", "guard", "--severity", severity,
    "--title", subject, "--body", body,
    "--extra", json.dumps({"method": method, "files": files, "ip": ip})
])
```

**UPS** — replace `rusnas-ups-notify.sh` with `rusnas-notify send --source ups`

**All other modules** — new `rusnas-notify-check` service:
- Systemd oneshot + timer (every 5 min)
- Python script that checks each subsystem's state
- Uses state file `/var/lib/rusnas/notify-check-state.json` for deduplication (only fires on state change)
- Checks: mdadm status, smartctl, rusnas-snap events, df/quota, cert dates, journalctl (brute-force), docker ps, systemctl, metrics

### 3.3 Custom Log Watcher

Built into `rusnas-notifyd` as a separate thread:
- Monitors configured log files via `tail -F` (inotify-based)
- Tests each new line against all active regex patterns
- On match: generates event with `source: "custom"`, configurable severity
- Patterns stored in `notify.json` under `log_watchers[]`:
```json
{
  "name": "SSH root login",
  "file": "/var/log/auth.log",
  "pattern": "Accepted.*root@",
  "severity": "warning",
  "enabled": true
}
```
- Per-pattern throttle (inherits global throttle settings)
- UI provides preset templates: SSH root, OOM, Segfault, Kernel panic, Disk error

## 4. Throttling

**Purpose:** Prevents notification spam when a module generates many events quickly (e.g., Guard during an attack).

**How it works:**
- Window: configurable (default 300 sec / 5 min)
- Limit: max N events per source per window (default 5)
- When limit exceeded: subsequent events marked `throttled=1` in DB
- After `digest_delay_sec` (default 60 sec): daemon sends a single digest notification summarizing throttled events
- Digest format: "Guard: 47 events in 5 minutes (honeypot: 30, entropy: 12, iops: 5)"

## 5. Retry Logic

- Max attempts: 3 (configurable)
- Backoff: [30s, 120s, 600s] between attempts
- After all attempts exhausted: delivery marked `failed`
- Failed deliveries visible in UI history with error message

## 6. Cockpit UI

### 6.1 Page Structure

New page: `notifications.html` + `js/notifications.js` + `css/notifications.css`
Menu item: "Уведомления" with bell icon, positioned after "Guard" in sidebar

4 tabs:
1. **Каналы доставки** — Channel configuration
2. **Маршрутизация** — Routing matrix + throttle settings
3. **История** — Delivery history with filters
4. **Log Watcher** — Custom regex rule builder

### 6.2 Tab 1: Channels

Grid of 5 channel cards (Email, Telegram, MAX, SNMP, Webhook).

Each card has:
- Toggle switch (enabled/disabled)
- Channel-specific configuration fields
- "Тест" button — sends test notification, shows inline success/error
- "Сохранить" button — saves to notify.json
- Expandable instruction box with numbered steps

**SNMP card specifics:**
- Version dropdown (SNMPv2c / SNMPv3) switches visible fields
- v2c: community string, receivers
- v3: username, auth protocol (MD5/SHA), auth password, priv protocol (DES/AES), priv password, receivers

**Each channel instruction must include:**
- Step-by-step setup guide in Russian
- Where to get credentials/tokens
- How to verify correct setup (via Test button)

### 6.3 Tab 2: Routing

**Routing matrix table:**
- Rows: modules (Guard, UPS, RAID, Snapshots, Storage, Network, Security, Containers, System, Custom)
- Columns: channels (Email, Telegram, MAX, SNMP, Webhook)
- Cells: clickable checkboxes (toggle on/off)
- "Сохранить маршруты" button

**Throttling settings:**
- Explanatory text: "Защита от спама уведомлений. Если один модуль генерирует больше N событий за указанный период — вместо отдельных уведомлений отправляется одно сводное (digest)."
- Fields: window (sec), max per source, digest delay (sec)

### 6.4 Tab 3: History

**Filters:**
- Module dropdown (all / Guard / UPS / RAID / ...)
- Severity dropdown (all / Critical / Warning / Info)
- Status dropdown (all / Sent / Failed / Throttled)
- Date range picker

**Table columns:** Time, Module, Severity (colored badge), Title, Channels (icons), Status (badge)

**Pagination:** 50 per page, total count, prev/next

**Data source:** daemon socket API — `{"cmd":"get_history","limit":50,"offset":0,"filters":{...}}`

### 6.5 Tab 4: Log Watcher

**Rule list:** Each rule shown as a row with:
- Name input
- Log file dropdown (auth.log, syslog, kern.log, custom path)
- Regex input (monospace, highlighted)
- Severity dropdown
- Test button (shows last N matches from file)
- Delete button

**Filters/sorting:**
- Filter by: rule name, log file, severity
- Sort by: last match time, name, match count
- Search by match text

**Template buttons:** SSH root, OOM, Segfault, Kernel panic, Disk error — pre-fill new rule

**Add rule button** — appends empty row

## 7. File Layout

```
/usr/lib/rusnas/notify/
    notifyd.py              # Main daemon
    channels/
        email.py            # SMTP sender
        telegram.py         # Telegram Bot API
        max.py              # MAX Bot API
        snmp.py             # SNMP trap sender
        webhook.py          # HTTP webhook sender
    log_watcher.py          # Log file monitor thread
    throttle.py             # Throttle logic
    cli.py                  # CLI entry point (rusnas-notify)

/usr/local/bin/rusnas-notify    # Symlink to cli.py

/usr/share/cockpit/rusnas/scripts/
    notify-check.py         # Periodic state checker (oneshot)

/lib/systemd/system/
    rusnas-notifyd.service  # Daemon service
    rusnas-notify-check.service  # Oneshot checker
    rusnas-notify-check.timer    # Every 5 min

/etc/rusnas/notify.json         # Configuration
/var/lib/rusnas/notify.db       # SQLite database
/var/lib/rusnas/notify-check-state.json  # Dedup state
/var/spool/rusnas-notify/       # CLI fallback spool
/var/log/rusnas/notify.log      # Daemon log
/run/rusnas-notify/notify.sock  # Unix socket

/usr/share/cockpit/rusnas/
    notifications.html
    js/notifications.js
    css/notifications.css

install-notify.sh               # Installation script
```

## 8. Installation Script

`install-notify.sh` will:
1. Install Python dependencies: `pysnmp` (for SNMP traps)
2. Deploy daemon files to `/usr/lib/rusnas/notify/`
3. Create symlink `/usr/local/bin/rusnas-notify`
4. Deploy systemd units
5. Create directories with correct permissions
6. Deploy default config
7. Initialize empty SQLite database
8. Deploy Cockpit UI files
9. Add sudoers entry
10. Enable and start services

## 9. Verification Plan

1. **Unit:** Test each channel sender in isolation with mock credentials
2. **CLI:** `rusnas-notify send --source test --severity info --title "test"` → verify event in DB
3. **Socket:** Python client connects to socket, sends event JSON → verify delivery
4. **Throttle:** Send 10 events from same source in 1 sec → verify only 5 delivered + 1 digest
5. **Retry:** Configure invalid SMTP → verify 3 attempts with backoff → status=failed
6. **UI:** Open notifications page → configure Telegram → test → verify message received
7. **Integration:** Trigger Guard honeypot → verify notification arrives via configured channels
8. **Log Watcher:** Add "Accepted.*root" rule → SSH as root → verify notification
9. **History:** Send 100 events → verify history tab shows all with correct filters/pagination
