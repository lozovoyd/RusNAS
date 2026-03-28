#!/usr/bin/env python3
"""rusNAS Container Manager CGI backend"""
import sys, os, json, subprocess, string, random
from datetime import datetime

CONTAINER_USER = "rusnas-containers"
BASE_DIR = "/var/lib/rusnas-containers"
CATALOG_DIR = "/usr/share/cockpit/rusnas/catalog"
COMPOSE_DIR = os.path.join(BASE_DIR, "compose")
NGINX_APPS_DIR = os.path.join(BASE_DIR, "nginx-apps")
INSTALLED_FILE = "/etc/rusnas/containers/installed.json"

def err(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(0)

def out(data):
    print(json.dumps(data))
    sys.exit(0)

def now_iso():
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

def generate_password(length=16):
    chars = string.ascii_letters + string.digits
    return ''.join(random.SystemRandom().choice(chars) for _ in range(length))

def run_podman(args):
    cmd = ["sudo", "-u", CONTAINER_USER, "podman"] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=300)

def run_compose(compose_dir, args):
    cmd = ["sudo", "-u", CONTAINER_USER, "podman-compose", "-f",
           os.path.join(compose_dir, "docker-compose.yml")] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=600)

def load_installed():
    if not os.path.exists(INSTALLED_FILE):
        return {}
    try:
        with open(INSTALLED_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}

def save_installed(data):
    os.makedirs(os.path.dirname(INSTALLED_FILE), exist_ok=True)
    with open(INSTALLED_FILE, 'w') as f:
        json.dump(data, f, indent=2)

def cmd_list_installed():
    installed = load_installed()
    apps = []
    for app_id, meta in installed.items():
        status = "stopped"
        compose_dir = meta.get("compose_dir", "")
        if compose_dir and os.path.isdir(compose_dir):
            r = run_compose(compose_dir, ["ps", "--format", "json"])
            if r.returncode == 0:
                try:
                    containers = json.loads(r.stdout) if r.stdout.strip() else []
                    if isinstance(containers, list) and containers:
                        statuses = [c.get("State", c.get("status", "")) for c in containers]
                        if all("running" in s.lower() for s in statuses):
                            status = "running"
                        elif any("running" in s.lower() for s in statuses):
                            status = "partial"
                except Exception:
                    pass
        meta["live_status"] = status
        apps.append(meta)
    out({"ok": True, "apps": apps})

def cmd_get_catalog():
    idx = os.path.join(CATALOG_DIR, "index.json")
    if not os.path.exists(idx):
        out({"ok": True, "apps": []})
    with open(idx) as f:
        data = json.load(f)
    out({"ok": True, "apps": data.get("apps", [])})

def cmd_get_btrfs_volumes():
    r = subprocess.run(
        ["findmnt", "--real", "-t", "btrfs", "-o", "TARGET,SIZE,AVAIL", "--json"],
        capture_output=True, text=True
    )
    volumes = []
    if r.returncode == 0:
        try:
            data = json.loads(r.stdout)
            for fs in data.get("filesystems", []):
                volumes.append({
                    "path": fs.get("target", ""),
                    "size": fs.get("size", ""),
                    "avail": fs.get("avail", ""),
                })
        except Exception:
            pass
    out({"ok": True, "volumes": volumes})

def cmd_get_stats():
    r = run_podman(["stats", "--no-stream", "--format", "json"])
    if r.returncode != 0:
        out({"ok": True, "stats": []})
    try:
        stats = json.loads(r.stdout) if r.stdout.strip() else []
        rusnas_stats = [s for s in stats if s.get("Name", "").startswith("rusnas-")]
        out({"ok": True, "stats": rusnas_stats})
    except Exception:
        out({"ok": True, "stats": []})

def cmd_status():
    if len(sys.argv) < 3:
        err("status requires app_id")
    app_id = sys.argv[2]
    installed = load_installed()
    app = installed.get(app_id)
    if not app:
        err(f"App not found: {app_id}")
    compose_dir = app.get("compose_dir", "")
    status = "stopped"
    containers = []
    if compose_dir and os.path.isdir(compose_dir):
        r = run_compose(compose_dir, ["ps", "--format", "json"])
        if r.returncode == 0:
            try:
                containers = json.loads(r.stdout) if r.stdout.strip() else []
                if isinstance(containers, list) and containers:
                    statuses = [c.get("State", c.get("status", "")) for c in containers]
                    if all("running" in s.lower() for s in statuses):
                        status = "running"
                    elif any("running" in s.lower() for s in statuses):
                        status = "partial"
            except Exception:
                pass
    out({"ok": True, "app_id": app_id, "status": status,
         "containers": containers, "meta": app})

def cmd_get_logs():
    if len(sys.argv) < 3:
        err("get_logs requires app_id")
    app_id = sys.argv[2]
    try:
        lines = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    except ValueError:
        err("get_logs: lines argument must be an integer")
    installed = load_installed()
    app = installed.get(app_id)
    if not app:
        err(f"App not found: {app_id}")
    compose_dir = app.get("compose_dir", "")
    if not compose_dir or not os.path.isdir(compose_dir):
        err(f"Compose directory not found for {app_id}")
    result = run_compose(compose_dir, ["logs", "--tail", str(lines), "--no-color"])
    out({"ok": True, "logs": result.stdout + result.stderr})

if __name__ == "__main__":
    if len(sys.argv) < 2:
        err("Usage: container_api.py <command> [args...]")
    cmd = sys.argv[1]
    dispatch = {
        "list_installed": cmd_list_installed,
        "get_catalog": cmd_get_catalog,
        "get_btrfs_volumes": cmd_get_btrfs_volumes,
        "get_stats": cmd_get_stats,
        "status": cmd_status,
        "get_logs": cmd_get_logs,
    }
    if cmd not in dispatch:
        err(f"Unknown command: {cmd}")
    dispatch[cmd]()
