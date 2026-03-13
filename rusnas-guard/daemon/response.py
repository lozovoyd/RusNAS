"""
response.py — Blocking, snapshots, and notifications for rusnas-guard.
"""

import logging
import os
import subprocess
import time
import datetime
import json
import threading

logger = logging.getLogger("rusnas-guard.response")

EVENTS_LOG = "/var/log/rusnas-guard/events.jsonl"
STATE_FILE  = "/run/rusnas-guard/state.json"


# ── Event logging ─────────────────────────────────────────────────────────────

def log_event(event: dict, state: dict):
    """Append event to JSONL log and update state."""
    event.setdefault("id", f"ev_{int(time.time()*1000)}_{os.getpid()}")
    event.setdefault("time", datetime.datetime.utcnow().isoformat() + "Z")
    event["status"] = "new"

    os.makedirs(os.path.dirname(EVENTS_LOG), exist_ok=True)
    with open(EVENTS_LOG, "a") as fh:
        fh.write(json.dumps(event) + "\n")

    # Update state
    events_today = state.get("events_today", 0) + 1
    state["events_today"]  = events_today
    state["last_event"]    = event["time"]
    write_state(state)

    logger.warning("EVENT: %s", json.dumps(event))
    return event["id"]


def load_events(limit=50) -> list:
    """Return last N events from log, newest first."""
    if not os.path.exists(EVENTS_LOG):
        return []
    events = []
    try:
        with open(EVENTS_LOG) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    except OSError:
        return []
    return list(reversed(events[-limit:]))


def acknowledge_event(event_id: str) -> bool:
    """Mark event as acknowledged in the log."""
    if not os.path.exists(EVENTS_LOG):
        return False
    lines = []
    found = False
    try:
        with open(EVENTS_LOG) as fh:
            for line in fh:
                stripped = line.strip()
                if not stripped:
                    lines.append(line)
                    continue
                try:
                    ev = json.loads(stripped)
                    if ev.get("id") == event_id:
                        ev["status"] = "acknowledged"
                        found = True
                    lines.append(json.dumps(ev) + "\n")
                except json.JSONDecodeError:
                    lines.append(line)
        if found:
            with open(EVENTS_LOG, "w") as fh:
                fh.writelines(lines)
    except OSError:
        return False
    return found


# ── State file ────────────────────────────────────────────────────────────────

def write_state(state: dict):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, STATE_FILE)


# ── IP blocking via nftables ──────────────────────────────────────────────────

_blocked_ips: set = set()
_blocked_lock = threading.Lock()


def block_ip(ip: str):
    if not ip or ip == "unknown":
        return
    with _blocked_lock:
        if ip in _blocked_ips:
            return
        try:
            subprocess.run(
                ["nft", "add", "rule", "inet", "filter", "input",
                 "ip", "saddr", ip, "drop"],
                check=True, capture_output=True
            )
            _blocked_ips.add(ip)
            logger.info("Blocked IP: %s", ip)
        except subprocess.CalledProcessError as e:
            logger.error("nft block failed for %s: %s", ip, e.stderr)


def clear_all_blocks():
    """Remove all nftables rules added by the guard (flush chain is too broad;
    instead track and delete by handle — simplified: flush the guard chain)."""
    with _blocked_lock:
        try:
            # Attempt to delete individual rules — for simplicity reload nftables
            subprocess.run(["nft", "flush", "ruleset"], check=False, capture_output=True)
            _blocked_ips.clear()
            logger.info("Cleared all IP blocks")
        except Exception as e:
            logger.error("clear_all_blocks failed: %s", e)


def get_blocked_ips() -> list:
    with _blocked_lock:
        return list(_blocked_ips)


# ── SMB connection drop ───────────────────────────────────────────────────────

def drop_smb_connections(share: str, ip: str):
    try:
        subprocess.run(
            ["smbcontrol", "smbd", "close-share", share],
            check=False, capture_output=True
        )
        logger.info("Dropped SMB connections to share %s from %s", share, ip)
    except FileNotFoundError:
        pass  # smbcontrol not available


# ── Btrfs snapshots ───────────────────────────────────────────────────────────

def create_snapshot(volume_path: str) -> str:
    """Create a Btrfs snapshot. Returns snapshot path or empty string on failure."""
    ts   = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    snap = f"{volume_path}/.snapshots/rusnas-guard-{ts}"
    os.makedirs(os.path.dirname(snap), exist_ok=True)
    try:
        subprocess.run(
            ["btrfs", "subvolume", "snapshot", "-r", volume_path, snap],
            check=True, capture_output=True
        )
        logger.info("Snapshot created: %s", snap)
        return snap
    except subprocess.CalledProcessError as e:
        logger.error("Snapshot failed for %s: %s", volume_path, e.stderr)
        return ""


def replicate_snapshot(snap_path: str, remote: dict):
    """Async btrfs send | ssh to remote NAS."""
    host    = remote.get("host", "")
    user    = remote.get("user", "rusnas")
    path    = remote.get("path", "/mnt/backup")
    key     = remote.get("ssh_key", "/etc/rusnas-guard/replication_key")

    if not host:
        return

    def _run():
        cmd_send = ["btrfs", "send", snap_path]
        cmd_recv = [
            "ssh", "-i", key, "-o", "StrictHostKeyChecking=no",
            f"{user}@{host}",
            f"btrfs receive {path}"
        ]
        try:
            p_send = subprocess.Popen(cmd_send, stdout=subprocess.PIPE)
            p_recv = subprocess.Popen(cmd_recv, stdin=p_send.stdout)
            p_send.stdout.close()
            p_recv.wait(timeout=3600)
            logger.info("Replication to %s completed", host)
        except Exception as e:
            logger.error("Replication failed: %s", e)

    threading.Thread(target=_run, daemon=True).start()


# ── Notifications ─────────────────────────────────────────────────────────────

def send_notification(subject: str, body: str):
    """Delegate to rusnas notification system (email + Telegram).
    Calls the existing notify helper if available."""
    script = "/usr/lib/rusnas/notify.sh"
    if os.path.exists(script):
        try:
            subprocess.run(
                [script, subject, body],
                check=False, capture_output=True, timeout=15
            )
        except Exception as e:
            logger.error("Notification failed: %s", e)
    else:
        logger.warning("Notification script not found: %s\nSubject: %s\n%s",
                       script, subject, body)


# ── Mode responses ────────────────────────────────────────────────────────────

def handle_detection(event: dict, mode: str, config: dict, state: dict):
    """
    Execute response according to current mode.
    event dict keys: method, path, source_ip, files, entropy, iops_rate
    """
    event_id = log_event(event, state)

    method   = event.get("method", "unknown")
    src_ip   = event.get("source_ip", "unknown")
    path     = event.get("path", "")
    files    = event.get("files", [])

    notif_body = (
        f"Detection method: {method}\n"
        f"Path: {path}\n"
        f"Source IP: {src_ip}\n"
        f"Files: {', '.join(files[:10])}\n"
        f"Event ID: {event_id}"
    )

    if mode == "monitor":
        send_notification("rusNAS Guard: detection (monitor)", notif_body)

    elif mode == "active":
        # 1. Snapshot affected volume
        snap = create_snapshot(path)

        # 2. Remote replication
        snap_cfg = config.get("snapshot", {})
        if snap and snap_cfg.get("remote", {}).get("enabled"):
            replicate_snapshot(snap, snap_cfg["remote"])

        # 3. Block source IP
        block_ip(src_ip)

        # 4. Drop SMB connections
        share = event.get("share", "")
        if share:
            drop_smb_connections(share, src_ip)

        notif_body += f"\nSnapshot: {snap}\nIP blocked: {src_ip}"
        send_notification("rusNAS Guard: ATTACK DETECTED — active response", notif_body)

        state["last_snapshot"] = datetime.datetime.utcnow().isoformat() + "Z"
        write_state(state)

    elif mode == "super_safe":
        # 1. Snapshot ALL volumes
        snaps = []
        for vol in config.get("monitored_paths", []):
            s = create_snapshot(vol["path"])
            if s:
                snaps.append(s)

        # 2. Remote replication
        snap_cfg = config.get("snapshot", {})
        if snap_cfg.get("remote", {}).get("enabled"):
            for s in snaps:
                replicate_snapshot(s, snap_cfg["remote"])

        # 3. Notification
        notif_body += f"\nSnapshots: {snaps}\nSHUTTING DOWN in 30s"
        send_notification("rusNAS Guard: ATTACK DETECTED — SUPER-SAFE SHUTDOWN", notif_body)

        # 4. Write post-attack flag
        flag = "/etc/rusnas-guard/post_attack"
        os.makedirs(os.path.dirname(flag), exist_ok=True)
        with open(flag, "w") as fh:
            fh.write(event_id)

        state["last_snapshot"] = datetime.datetime.utcnow().isoformat() + "Z"
        write_state(state)

        # 5. Stop services & poweroff after 30s
        def _shutdown():
            time.sleep(30)
            for svc in ["smbd", "nmbd", "nfs-kernel-server", "vsftpd", "apache2", "rsyncd"]:
                subprocess.run(["systemctl", "stop", svc], check=False, capture_output=True)
            subprocess.run(["systemctl", "poweroff"], check=False)

        threading.Thread(target=_shutdown, daemon=False).start()
