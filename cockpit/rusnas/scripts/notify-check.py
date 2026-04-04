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
