#!/usr/bin/env python3
"""rusNAS Container Manager CGI backend"""
import sys, os, json, subprocess, string, random, re, shutil
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

def render_compose(template_path, substitutions):
    """Replace {{VAR:-default}} and {{VAR}} in template."""
    with open(template_path) as f:
        content = f.read()
    def replace(m):
        var = m.group(1)
        default = m.group(2) if m.group(2) is not None else ""
        return substitutions.get(var, default)
    content = re.sub(r'\{\{(\w+)(?::-(.*?))?\}\}', replace, content)
    return content

def generate_nginx_proxy(app_id, path_prefix, port):
    conf = f"""# rusNAS auto-generated — {app_id}
location {path_prefix} {{
    proxy_pass http://127.0.0.1:{port}/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    client_max_body_size 4G;
}}
"""
    os.makedirs(NGINX_APPS_DIR, exist_ok=True)
    conf_path = os.path.join(NGINX_APPS_DIR, f"{app_id}.conf")
    with open(conf_path, 'w') as f:
        f.write(conf)
    subprocess.run(["systemctl", "reload", "nginx"], capture_output=True)

def generate_systemd_unit(app_id, compose_dir):
    unit = f"""[Unit]
Description=rusNAS Container App: {app_id}
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
User={CONTAINER_USER}
WorkingDirectory={compose_dir}
ExecStart=/usr/bin/podman-compose up -d
ExecStop=/usr/bin/podman-compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
"""
    unit_path = f"/etc/systemd/system/rusnas-container-{app_id}.service"
    try:
        with open(unit_path, 'w') as f:
            f.write(unit)
        subprocess.run(["systemctl", "daemon-reload"], capture_output=True)
        subprocess.run(["systemctl", "enable", f"rusnas-container-{app_id}.service"],
                       capture_output=True)
    except OSError:
        pass  # Non-fatal — systemd unit creation may fail in test environments

def cmd_install():
    if len(sys.argv) < 3:
        err("install requires app_id")
    app_id = sys.argv[2]
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', app_id):
        err("Invalid app_id: only letters, digits, hyphens and underscores allowed")
    params = {}
    for arg in sys.argv[3:]:
        if '=' in arg:
            k, v = arg.split('=', 1)
            params[k] = v

    manifest_path = os.path.join(CATALOG_DIR, app_id, "rusnas-app.json")
    if not os.path.exists(manifest_path):
        err(f"App not found: {app_id}")
    with open(manifest_path) as f:
        manifest = json.load(f)

    volume_path = params.get("volume_path", "/mnt/data")
    web_port = params.get("web_port", str(manifest.get("default_port", 8080)))
    admin_user = params.get("admin_user", "admin")
    admin_password = params.get("admin_password") or generate_password()

    data_dir = os.path.join(volume_path, "containers", app_id)
    subs = {
        "DATA_DIR": data_dir,
        "WEB_PORT": web_port,
        "ADMIN_USER": admin_user,
        "ADMIN_PASSWORD": admin_password,
        "DB_PASSWORD": generate_password(12),
        "DB_ROOT_PASSWORD": generate_password(12),
        **params,
    }

    compose_dir = os.path.join(COMPOSE_DIR, app_id)
    os.makedirs(compose_dir, exist_ok=True)
    os.makedirs(data_dir, exist_ok=True)

    template = os.path.join(CATALOG_DIR, app_id, "docker-compose.yml")
    rendered = render_compose(template, subs)
    compose_file = os.path.join(compose_dir, "docker-compose.yml")
    with open(compose_file, 'w') as f:
        f.write(rendered)

    subprocess.run(["chown", "-R", f"{CONTAINER_USER}:{CONTAINER_USER}",
                    compose_dir, data_dir], capture_output=True)

    result = run_compose(compose_dir, ["up", "-d"])
    if result.returncode != 0:
        err(result.stderr or "podman-compose up failed")

    path_prefix = manifest.get("nginx_path", f"/{app_id}/")
    generate_nginx_proxy(app_id, path_prefix, web_port)
    generate_systemd_unit(app_id, compose_dir)

    installed = load_installed()
    installed[app_id] = {
        "app_id": app_id,
        "name": manifest.get("name", {}),
        "category": manifest.get("category", ""),
        "compose_dir": compose_dir,
        "data_dir": data_dir,
        "host_ports": {manifest.get("port_label", "web"): int(web_port)},
        "nginx_path": path_prefix,
        "admin_user": admin_user,
        "admin_password": admin_password,
        "installed_at": now_iso(),
        "status": "running",
        "version": manifest.get("version", "latest"),
    }
    save_installed(installed)
    out({"ok": True, "app_id": app_id, "admin_password": admin_password,
         "url": f"http://nas.local{path_prefix}"})

def cmd_uninstall():
    if len(sys.argv) < 3:
        err("uninstall requires app_id")
    app_id = sys.argv[2]
    keep_data = "--keep-data" in sys.argv

    installed = load_installed()
    app = installed.get(app_id)
    if not app:
        err(f"Not installed: {app_id}")

    compose_dir = app.get("compose_dir", "")
    data_dir = app.get("data_dir", "")

    if compose_dir and os.path.isdir(compose_dir):
        run_compose(compose_dir, ["down", "--volumes"])
        shutil.rmtree(compose_dir, ignore_errors=True)

    if not keep_data and data_dir and os.path.isdir(data_dir):
        shutil.rmtree(data_dir, ignore_errors=True)

    conf_path = os.path.join(NGINX_APPS_DIR, f"{app_id}.conf")
    if os.path.exists(conf_path):
        os.remove(conf_path)
    subprocess.run(["systemctl", "reload", "nginx"], capture_output=True)

    unit = f"rusnas-container-{app_id}.service"
    subprocess.run(["systemctl", "disable", unit], capture_output=True)
    unit_path = f"/etc/systemd/system/{unit}"
    if os.path.exists(unit_path):
        try:
            os.remove(unit_path)
        except OSError:
            pass
    subprocess.run(["systemctl", "daemon-reload"], capture_output=True)

    del installed[app_id]
    save_installed(installed)
    out({"ok": True})

def cmd_app_control():
    action = sys.argv[1]
    if len(sys.argv) < 3:
        err(f"{action} requires app_id")
    app_id = sys.argv[2]

    installed = load_installed()
    app = installed.get(app_id)
    if not app:
        err(f"Not installed: {app_id}")

    compose_dir = app.get("compose_dir", "")
    if not compose_dir or not os.path.isdir(compose_dir):
        err(f"Compose directory not found for {app_id}")

    compose_args = {
        "start": ["up", "-d"],
        "stop": ["down"],
        "restart": ["restart"],
    }.get(action, ["up", "-d"])

    result = run_compose(compose_dir, compose_args)
    if result.returncode != 0:
        err(result.stderr or f"{action} failed")
    out({"ok": True})

def cmd_update_images():
    if len(sys.argv) < 3:
        err("update_images requires app_id")
    app_id = sys.argv[2]

    installed = load_installed()
    app = installed.get(app_id)
    if not app:
        err(f"Not installed: {app_id}")

    compose_dir = app.get("compose_dir", "")
    if not compose_dir or not os.path.isdir(compose_dir):
        err(f"Compose directory not found for {app_id}")

    result = run_compose(compose_dir, ["pull"])
    if result.returncode != 0:
        err(result.stderr or "pull failed")
    run_compose(compose_dir, ["up", "-d"])
    out({"ok": True, "output": result.stdout})

def cmd_install_custom():
    if len(sys.argv) < 4:
        err("install_custom requires name and image")
    name = sys.argv[2]
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', name):
        err("Invalid name: only letters, digits, hyphens and underscores allowed")
    image = sys.argv[3]

    params = {}
    for arg in sys.argv[4:]:
        if '=' in arg:
            k, v = arg.split('=', 1)
            params[k] = v

    app_id = f"custom-{name}"
    compose_dir = os.path.join(COMPOSE_DIR, app_id)
    os.makedirs(compose_dir, exist_ok=True)

    ports = {k[5:]: v for k, v in params.items() if k.startswith("port_")}
    envs = {k[4:]: v for k, v in params.items() if k.startswith("env_")}
    restart = params.get("restart", "always")

    port_lines = "\n".join(f'      - "{h}:{c}"' for h, c in ports.items()) or "      []"
    env_lines = "\n".join(f'      - {k}={v}' for k, v in envs.items()) or "      []"

    compose_content = f"""version: "3.8"
services:
  {name}:
    image: {image}
    container_name: rusnas-{name}
    restart: {restart}
    ports:
{port_lines}
    environment:
{env_lines}
"""
    with open(os.path.join(compose_dir, "docker-compose.yml"), 'w') as f:
        f.write(compose_content)

    subprocess.run(["chown", "-R", f"{CONTAINER_USER}:{CONTAINER_USER}", compose_dir],
                   capture_output=True)
    result = run_compose(compose_dir, ["up", "-d"])
    if result.returncode != 0:
        err(result.stderr or "podman-compose up failed")

    generate_systemd_unit(app_id, compose_dir)

    installed = load_installed()
    installed[app_id] = {
        "app_id": app_id,
        "name": {"ru": name, "en": name},
        "custom": True,
        "image": image,
        "compose_dir": compose_dir,
        "host_ports": ports,
        "installed_at": now_iso(),
        "status": "running",
    }
    save_installed(installed)
    out({"ok": True, "app_id": app_id})

def cmd_import_compose():
    if len(sys.argv) < 4:
        err("import_compose requires name and compose_path")
    name = sys.argv[2]
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', name):
        err("Invalid name: only letters, digits, hyphens and underscores allowed")
    compose_path = sys.argv[3]
    if not os.path.exists(compose_path):
        err(f"File not found: {compose_path}")

    app_id = f"imported-{name}"
    compose_dir = os.path.join(COMPOSE_DIR, app_id)
    os.makedirs(compose_dir, exist_ok=True)

    shutil.copy(compose_path, os.path.join(compose_dir, "docker-compose.yml"))
    subprocess.run(["chown", "-R", f"{CONTAINER_USER}:{CONTAINER_USER}", compose_dir],
                   capture_output=True)

    result = run_compose(compose_dir, ["up", "-d"])
    if result.returncode != 0:
        err(result.stderr or "podman-compose up failed")

    generate_systemd_unit(app_id, compose_dir)

    installed = load_installed()
    installed[app_id] = {
        "app_id": app_id,
        "name": {"ru": name, "en": name},
        "imported": True,
        "compose_dir": compose_dir,
        "installed_at": now_iso(),
        "status": "running",
    }
    save_installed(installed)
    out({"ok": True, "app_id": app_id})

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
        "install": cmd_install,
        "uninstall": cmd_uninstall,
        "start": cmd_app_control,
        "stop": cmd_app_control,
        "restart": cmd_app_control,
        "update_images": cmd_update_images,
        "install_custom": cmd_install_custom,
        "import_compose": cmd_import_compose,
    }
    if cmd not in dispatch:
        err(f"Unknown command: {cmd}")
    dispatch[cmd]()
