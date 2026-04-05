# Container Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Container Manager page to the rusNAS Cockpit plugin, enabling SMB users to install and manage containerized apps (Nextcloud, Immich, Jellyfin, etc.) via a catalog-driven UI backed by rootless Podman.

**Architecture:** CGI pattern — `cgi/container_api.py` is a Python CLI called via `cockpit.spawn(["sudo", "-n", "python3", CGI_PATH, cmd, ...])`. All containers run rootless as `rusnas-containers` user. Apps get nginx location blocks auto-generated. Catalog lives at `/var/lib/rusnas-containers/catalog/` and is bundled in the plugin.

**Tech Stack:** Podman + podman-compose (rootless), Python 3 CGI backend, vanilla JS Cockpit frontend, nginx reverse proxy, systemd user units.

---

## File Map

### Create
- `cockpit/rusnas/containers.html` — 3-tab page (Catalog / Installed / Custom)
- `cockpit/rusnas/js/containers.js` — all page logic
- `cockpit/rusnas/css/containers.css` — app-card grid, install modal, progress UI
- `cockpit/rusnas/cgi/container_api.py` — Python CGI backend (15 actions)
- `cockpit/rusnas/catalog/index.json` — catalog index (10 apps)
- `cockpit/rusnas/catalog/nextcloud/rusnas-app.json` + `docker-compose.yml`
- `cockpit/rusnas/catalog/immich/rusnas-app.json` + `docker-compose.yml`
- `cockpit/rusnas/catalog/jellyfin/rusnas-app.json` + `docker-compose.yml`
- `cockpit/rusnas/catalog/vaultwarden/rusnas-app.json` + `docker-compose.yml`
- `cockpit/rusnas/catalog/home-assistant/rusnas-app.json` + `docker-compose.yml`
- `cockpit/rusnas/catalog/pihole/rusnas-app.json` + `docker-compose.yml`
- `cockpit/rusnas/catalog/wireguard/rusnas-app.json` + `docker-compose.yml`
- `cockpit/rusnas/catalog/mailcow/rusnas-app.json` + `docker-compose.yml`
- `cockpit/rusnas/catalog/onlyoffice/rusnas-app.json` + `docker-compose.yml`
- `cockpit/rusnas/catalog/rocketchat/rusnas-app.json` + `docker-compose.yml`
- `install-containers.sh` — deploy script to VM

### Modify
- `cockpit/rusnas/manifest.json` — add "containers" menu entry (order: 55)
- `cockpit/rusnas/js/dashboard.js` — add container widget card
- `rusnas-metrics/metrics_server.py` — add `collect_containers()` function

---

## Task 1: CGI Backend — Core Structure

**Files:**
- Create: `cockpit/rusnas/cgi/container_api.py`

- [ ] **Step 1: Write failing test**

```python
# tests/test_container_api.py
import subprocess, json, os, sys
CGI = os.path.join(os.path.dirname(__file__), '../cockpit/rusnas/cgi/container_api.py')

def call_cgi(*args):
    r = subprocess.run(['python3', CGI] + list(args), capture_output=True, text=True)
    return json.loads(r.stdout)

def test_list_installed_empty():
    r = call_cgi('list_installed')
    assert r.get('ok') is True
    assert 'apps' in r

def test_get_catalog_index():
    r = call_cgi('get_catalog')
    assert r.get('ok') is True
    assert 'apps' in r
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd /Users/dvl92/projects/RusNAS/.worktrees/feat/container-manager
python3 -m pytest tests/test_container_api.py -v 2>&1 | head -30
```
Expected: `FAILED` — no such file.

- [ ] **Step 3: Implement `container_api.py` core**

```python
#!/usr/bin/env python3
"""rusNAS Container Manager CGI backend"""
import sys, os, json, subprocess, shlex, string, random
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
    with open(INSTALLED_FILE) as f:
        return json.load(f)

def save_installed(data):
    os.makedirs(os.path.dirname(INSTALLED_FILE), exist_ok=True)
    with open(INSTALLED_FILE, 'w') as f:
        json.dump(data, f, indent=2)

def cmd_list_installed():
    installed = load_installed()
    apps = []
    for app_id, meta in installed.items():
        # Enrich with live status
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
                        else:
                            status = "stopped"
                except:
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
        except:
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
    except:
        out({"ok": True, "stats": []})

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
    }
    if cmd not in dispatch:
        err(f"Unknown command: {cmd}")
    dispatch[cmd]()
```

- [ ] **Step 4: Run test**

```bash
python3 -m pytest tests/test_container_api.py::test_list_installed_empty tests/test_container_api.py::test_get_catalog_index -v
```
Expected: PASS (both tests run without VM needed — filesystem ops only).

- [ ] **Step 5: Commit**

```bash
cd /Users/dvl92/projects/RusNAS/.worktrees/feat/container-manager
git add cockpit/rusnas/cgi/container_api.py tests/test_container_api.py
git commit -m "feat: add container_api.py CGI backend core structure"
```

---

## Task 2: CGI Backend — Install / Uninstall / Control

**Files:**
- Modify: `cockpit/rusnas/cgi/container_api.py`

- [ ] **Step 1: Write failing tests**

```python
# Add to tests/test_container_api.py

def test_unknown_command_returns_error():
    r = call_cgi('nonexistent_cmd')
    assert r.get('ok') is False
    assert 'error' in r

def test_get_logs_missing_app():
    r = call_cgi('get_logs', 'nonexistent-app')
    assert r.get('ok') is False
```

- [ ] **Step 2: Run test to confirm failure**

```bash
python3 -m pytest tests/test_container_api.py::test_get_logs_missing_app -v
```
Expected: FAIL

- [ ] **Step 3: Implement install, uninstall, start, stop, restart, get_logs, update_images**

Add these functions to `container_api.py` and expand the dispatch dict:

```python
def render_compose(template_path, substitutions):
    """Replace {{VAR:-default}} and {{VAR}} in template."""
    with open(template_path) as f:
        content = f.read()
    import re
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
    with open(unit_path, 'w') as f:
        f.write(unit)
    subprocess.run(["systemctl", "daemon-reload"], capture_output=True)
    subprocess.run(["systemctl", "enable", f"rusnas-container-{app_id}.service"],
                   capture_output=True)

def cmd_install():
    if len(sys.argv) < 3:
        err("install requires app_id")
    app_id = sys.argv[2]
    # Parse key=value args
    params = {}
    for arg in sys.argv[3:]:
        if '=' in arg:
            k, v = arg.split('=', 1)
            params[k] = v

    # Load app manifest
    manifest_path = os.path.join(CATALOG_DIR, app_id, "rusnas-app.json")
    if not os.path.exists(manifest_path):
        err(f"App not found: {app_id}")
    with open(manifest_path) as f:
        manifest = json.load(f)

    volume_path = params.get("volume_path", "/mnt/data")
    web_port = params.get("web_port", str(manifest.get("default_port", 8080)))
    admin_user = params.get("admin_user", "admin")
    admin_password = params.get("admin_password") or generate_password()

    # Build substitutions
    data_dir = os.path.join(volume_path, "containers", app_id)
    subs = {
        "DATA_DIR": data_dir,
        "WEB_PORT": web_port,
        "ADMIN_USER": admin_user,
        "ADMIN_PASSWORD": admin_password,
        **{k: v for k, v in params.items()},
    }

    # Compose dir
    compose_dir = os.path.join(COMPOSE_DIR, app_id)
    os.makedirs(compose_dir, exist_ok=True)
    os.makedirs(data_dir, exist_ok=True)

    # Render template
    template = os.path.join(CATALOG_DIR, app_id, "docker-compose.yml")
    rendered = render_compose(template, subs)
    compose_file = os.path.join(compose_dir, "docker-compose.yml")
    with open(compose_file, 'w') as f:
        f.write(rendered)

    subprocess.run(["chown", "-R", f"{CONTAINER_USER}:{CONTAINER_USER}",
                    compose_dir, data_dir])

    # Pull images first (streaming output tracked by UI via separate mechanism)
    result = run_compose(compose_dir, ["up", "-d"])
    if result.returncode != 0:
        err(result.stderr)

    # Nginx proxy
    path_prefix = manifest.get("nginx_path", f"/{app_id}/")
    generate_nginx_proxy(app_id, path_prefix, web_port)

    # Systemd unit
    generate_systemd_unit(app_id, compose_dir)

    # Save state
    installed = load_installed()
    installed[app_id] = {
        "app_id": app_id,
        "name": manifest.get("name", {}),
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
        subprocess.run(["rm", "-rf", compose_dir])

    if not keep_data and data_dir and os.path.isdir(data_dir):
        subprocess.run(["rm", "-rf", data_dir])

    # Remove nginx conf
    conf_path = os.path.join(NGINX_APPS_DIR, f"{app_id}.conf")
    if os.path.exists(conf_path):
        os.remove(conf_path)
    subprocess.run(["systemctl", "reload", "nginx"], capture_output=True)

    # Disable systemd unit
    unit = f"rusnas-container-{app_id}.service"
    subprocess.run(["systemctl", "disable", unit], capture_output=True)
    unit_path = f"/etc/systemd/system/{unit}"
    if os.path.exists(unit_path):
        os.remove(unit_path)
    subprocess.run(["systemctl", "daemon-reload"], capture_output=True)

    del installed[app_id]
    save_installed(installed)
    out({"ok": True})

def cmd_app_control():
    # argv: container_api.py start|stop|restart <app_id>
    action = sys.argv[1]
    if len(sys.argv) < 3:
        err(f"{action} requires app_id")
    app_id = sys.argv[2]

    installed = load_installed()
    app = installed.get(app_id)
    if not app:
        err(f"Not installed: {app_id}")

    compose_dir = app.get("compose_dir", "")
    compose_args = {
        "start": ["up", "-d"],
        "stop": ["down"],
        "restart": ["restart"],
    }.get(action, ["up", "-d"])

    result = run_compose(compose_dir, compose_args)
    if result.returncode != 0:
        err(result.stderr)
    out({"ok": True})

def cmd_get_logs():
    if len(sys.argv) < 3:
        err("get_logs requires app_id")
    app_id = sys.argv[2]
    lines = int(sys.argv[3]) if len(sys.argv) > 3 else 100

    installed = load_installed()
    app = installed.get(app_id)
    if not app:
        err(f"App not found: {app_id}")

    compose_dir = app.get("compose_dir", "")
    result = run_compose(compose_dir, ["logs", "--tail", str(lines), "--no-color"])
    out({"ok": True, "logs": result.stdout + result.stderr})

def cmd_update_images():
    if len(sys.argv) < 3:
        err("update_images requires app_id")
    app_id = sys.argv[2]

    installed = load_installed()
    app = installed.get(app_id)
    if not app:
        err(f"Not installed: {app_id}")

    compose_dir = app.get("compose_dir", "")
    result = run_compose(compose_dir, ["pull"])
    if result.returncode != 0:
        err(result.stderr)
    run_compose(compose_dir, ["up", "-d"])
    out({"ok": True, "output": result.stdout})

def cmd_install_custom():
    if len(sys.argv) < 3:
        err("install_custom requires name")
    name = sys.argv[2]
    image = sys.argv[3] if len(sys.argv) > 3 else ""
    if not image:
        err("image required")

    params = {}
    for arg in sys.argv[4:]:
        if '=' in arg:
            k, v = arg.split('=', 1)
            params[k] = v

    app_id = f"custom-{name}"
    compose_dir = os.path.join(COMPOSE_DIR, app_id)
    os.makedirs(compose_dir, exist_ok=True)

    ports = {}
    for k, v in params.items():
        if k.startswith("port_"):
            host_p = k[5:]
            ports[host_p] = v

    volumes = {}
    for k, v in params.items():
        if k.startswith("vol_"):
            host_path = k[4:]
            volumes[host_path] = v

    envs = {}
    for k, v in params.items():
        if k.startswith("env_"):
            envs[k[4:]] = v

    restart = params.get("restart", "always")

    port_lines = "\n".join(f'      - "{h}:{c}"' for h, c in ports.items())
    vol_lines = "\n".join(f'      - "{h}:{c}"' for h, c in volumes.items())
    env_lines = "\n".join(f'      - {k}={v}' for k, v in envs.items())

    compose_content = f"""version: "3.8"
services:
  {name}:
    image: {image}
    container_name: rusnas-{name}
    restart: {restart}
    ports:
{port_lines if port_lines else '      []'}
    volumes:
{vol_lines if vol_lines else '      []'}
    environment:
{env_lines if env_lines else '      []'}
"""
    with open(os.path.join(compose_dir, "docker-compose.yml"), 'w') as f:
        f.write(compose_content)

    subprocess.run(["chown", "-R", f"{CONTAINER_USER}:{CONTAINER_USER}", compose_dir])
    result = run_compose(compose_dir, ["up", "-d"])
    if result.returncode != 0:
        err(result.stderr)

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
    compose_path = sys.argv[3]
    if not os.path.exists(compose_path):
        err(f"File not found: {compose_path}")

    app_id = f"imported-{name}"
    compose_dir = os.path.join(COMPOSE_DIR, app_id)
    os.makedirs(compose_dir, exist_ok=True)

    import shutil
    shutil.copy(compose_path, os.path.join(compose_dir, "docker-compose.yml"))
    subprocess.run(["chown", "-R", f"{CONTAINER_USER}:{CONTAINER_USER}", compose_dir])

    result = run_compose(compose_dir, ["up", "-d"])
    if result.returncode != 0:
        err(result.stderr)

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
```

Also add `cmd_status()` function (single-app status query):

```python
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
            except:
                pass

    out({"ok": True, "app_id": app_id, "status": status,
         "containers": containers, "meta": app})
```

Update dispatch dict at bottom:
```python
    dispatch = {
        "list_installed": cmd_list_installed,
        "get_catalog": cmd_get_catalog,
        "get_btrfs_volumes": cmd_get_btrfs_volumes,
        "get_stats": cmd_get_stats,
        "status": cmd_status,
        "install": cmd_install,
        "uninstall": cmd_uninstall,
        "start": cmd_app_control,
        "stop": cmd_app_control,
        "restart": cmd_app_control,
        "get_logs": cmd_get_logs,
        "update_images": cmd_update_images,
        "install_custom": cmd_install_custom,
        "import_compose": cmd_import_compose,
    }
```

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest tests/test_container_api.py -v
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add cockpit/rusnas/cgi/container_api.py tests/test_container_api.py
git commit -m "feat: add install/uninstall/control/logs/custom CGI commands"
```

---

## Task 3: App Catalog — index.json + App Manifests

**Files:**
- Create: `cockpit/rusnas/catalog/index.json`
- Create: `cockpit/rusnas/catalog/*/rusnas-app.json` (10 apps)

- [ ] **Step 1: Write failing test**

```python
def test_catalog_index_has_10_apps():
    import os, json
    idx = os.path.join(os.path.dirname(__file__),
                       '../cockpit/rusnas/catalog/index.json')
    with open(idx) as f:
        data = json.load(f)
    assert len(data['apps']) == 10

def test_catalog_nextcloud_manifest():
    import os, json
    p = os.path.join(os.path.dirname(__file__),
                     '../cockpit/rusnas/catalog/nextcloud/rusnas-app.json')
    with open(p) as f:
        data = json.load(f)
    # Required keys per spec section 3.2
    required = ['id','name','description','category','icon','default_port',
                'nginx_path','min_ram_mb','version']
    for key in required:
        assert key in data, f"Missing key: {key}"
    # docker-compose.yml must exist alongside the manifest
    compose = os.path.join(os.path.dirname(p), 'docker-compose.yml')
    assert os.path.exists(compose), "docker-compose.yml missing for nextcloud"
```

- [ ] **Step 2: Run test to confirm failure**

```bash
python3 -m pytest tests/test_container_api.py::test_catalog_index_has_10_apps -v
```

- [ ] **Step 3: Create `catalog/index.json`**

```json
{
  "version": "1.0",
  "apps": [
    {"id": "nextcloud", "category": "cloud", "featured": true},
    {"id": "immich",    "category": "photo", "featured": true},
    {"id": "jellyfin",  "category": "media", "featured": true},
    {"id": "vaultwarden", "category": "security", "featured": false},
    {"id": "home-assistant", "category": "iot", "featured": false},
    {"id": "pihole",    "category": "network", "featured": false},
    {"id": "wireguard", "category": "network", "featured": false},
    {"id": "mailcow",   "category": "mail",  "featured": false},
    {"id": "onlyoffice","category": "office","featured": false},
    {"id": "rocketchat","category": "chat",  "featured": false}
  ]
}
```

- [ ] **Step 4: Create `catalog/nextcloud/rusnas-app.json`**

```json
{
  "id": "nextcloud",
  "name": {"ru": "Nextcloud", "en": "Nextcloud"},
  "description": {
    "ru": "Облачное хранилище с синхронизацией файлов, календарём, контактами и офисными приложениями",
    "en": "Cloud storage with file sync, calendar, contacts and office apps"
  },
  "category": "cloud",
  "icon": "cloud",
  "version": "29-apache",
  "default_port": 8080,
  "nginx_path": "/nextcloud/",
  "port_label": "web",
  "min_ram_mb": 512,
  "disk_gb": 5,
  "containers": 2,
  "featured": true,
  "install_params": [
    {"key": "web_port",       "label": "Порт веб-интерфейса", "default": "8080", "type": "port"},
    {"key": "admin_user",     "label": "Имя администратора",  "default": "admin", "type": "text"},
    {"key": "admin_password", "label": "Пароль",              "default": "",      "type": "password", "generate": true}
  ],
  "compose_template": "docker-compose.yml"
}
```

- [ ] **Step 5: Create `catalog/nextcloud/docker-compose.yml`**

```yaml
version: "3.8"
services:
  nextcloud-db:
    image: mariadb:11
    container_name: rusnas-nextcloud-db
    restart: unless-stopped
    environment:
      - MYSQL_ROOT_PASSWORD={{DB_ROOT_PASSWORD:-rootpass}}
      - MYSQL_DATABASE=nextcloud
      - MYSQL_USER=nextcloud
      - MYSQL_PASSWORD={{DB_PASSWORD:-nextcloudpass}}
    volumes:
      - {{DATA_DIR:-/mnt/data/containers/nextcloud}}/db:/var/lib/mysql
    networks:
      - rusnas-nextcloud

  nextcloud-app:
    image: nextcloud:29-apache
    container_name: rusnas-nextcloud-app
    restart: unless-stopped
    depends_on:
      - nextcloud-db
    ports:
      - "{{WEB_PORT:-8080}}:80"
    environment:
      - MYSQL_HOST=nextcloud-db
      - MYSQL_DATABASE=nextcloud
      - MYSQL_USER=nextcloud
      - MYSQL_PASSWORD={{DB_PASSWORD:-nextcloudpass}}
      - NEXTCLOUD_ADMIN_USER={{ADMIN_USER:-admin}}
      - NEXTCLOUD_ADMIN_PASSWORD={{ADMIN_PASSWORD:-changeme}}
      - NEXTCLOUD_TRUSTED_DOMAINS=localhost
    volumes:
      - {{DATA_DIR:-/mnt/data/containers/nextcloud}}/data:/var/www/html
    networks:
      - rusnas-nextcloud

networks:
  rusnas-nextcloud:
    name: rusnas-nextcloud
```

- [ ] **Step 6: Create remaining 9 app manifests + compose files**

For each app, create `catalog/<id>/rusnas-app.json` and `catalog/<id>/docker-compose.yml`:

**immich** (port 2283, nginx `/photos/`):
- `rusnas-app.json`: id=immich, category=photo, min_ram_mb=2048, containers=4
- `docker-compose.yml`: images=`ghcr.io/immich-app/immich-server:release`, immich-machine-learning, postgres:14, redis

**jellyfin** (port 8096, nginx `/jellyfin/`):
- `rusnas-app.json`: id=jellyfin, category=media, min_ram_mb=1024, containers=1
- `docker-compose.yml`: image=`jellyfin/jellyfin:latest`, media/config volumes

**vaultwarden** (port 8880, nginx `/vault/`):
- `rusnas-app.json`: id=vaultwarden, category=security, min_ram_mb=64, containers=1
- `docker-compose.yml`: image=`vaultwarden/server:latest`

**home-assistant** (port 8123, nginx `/hass/`):
- `rusnas-app.json`: id=home-assistant, category=iot, min_ram_mb=256, containers=1
- `docker-compose.yml`: image=`homeassistant/home-assistant:stable`

**pihole** (port 8053, nginx `/pihole/`):
- `rusnas-app.json`: id=pihole, category=network, min_ram_mb=128, containers=1
- `docker-compose.yml`: image=`pihole/pihole:latest`

**wireguard** (port 51821, nginx `/vpn/`):
- `rusnas-app.json`: id=wireguard, category=network, min_ram_mb=64, containers=1
- `docker-compose.yml`: image=`linuxserver/wireguard:latest`

**mailcow** (port 8443, nginx `/mail/`):
- `rusnas-app.json`: id=mailcow, category=mail, min_ram_mb=4096, containers=1
- `docker-compose.yml`: image=`mailcow/mailcow-dockerized` (note: heavy)

**onlyoffice** (port 8044, nginx `/office/`):
- `rusnas-app.json`: id=onlyoffice, category=office, min_ram_mb=2048, containers=1
- `docker-compose.yml`: image=`onlyoffice/documentserver:latest`

**rocketchat** (port 3000, nginx `/chat/`):
- `rusnas-app.json`: id=rocketchat, category=chat, min_ram_mb=1024, containers=2
- `docker-compose.yml`: image=`rocket.chat:latest` + mongodb

Each compose file must follow the same `{{VAR:-default}}` substitution pattern and use `rusnas-<appid>` network names.

- [ ] **Step 7: Run tests**

```bash
python3 -m pytest tests/test_container_api.py::test_catalog_index_has_10_apps tests/test_container_api.py::test_catalog_nextcloud_manifest -v
```
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add cockpit/rusnas/catalog/
git commit -m "feat: add app catalog with 10 apps (nextcloud, immich, jellyfin, etc.)"
```

---

## Task 4: Cockpit UI — containers.html + containers.css

**Files:**
- Create: `cockpit/rusnas/containers.html`
- Create: `cockpit/rusnas/css/containers.css`

- [ ] **Step 1: Create `containers.html`**

Key structure (full file):
```html
<!doctype html>
<html>
<head>
  <title>Приложения — rusNAS</title>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light dark">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="css/style.css">
  <link rel="stylesheet" href="css/containers.css">
  <script src="../base1/cockpit.js"></script>
</head>
<body>

<!-- Header -->
<div class="section-toolbar">
  <h2 class="section-title">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round"
            d="M6 6h.01M6 12h.01M6 18h.01M10.5 6h7.5M10.5 12h7.5M10.5 18h7.5"/>
    </svg>
    Приложения
  </h2>
  <div class="section-toolbar-right">
    <span id="podman-version" class="text-muted" style="font-size:12px"></span>
  </div>
</div>

<!-- Tabs -->
<div class="advisor-tabs" id="containers-tabs">
  <button class="advisor-tab-btn active" data-tab="catalog">Каталог</button>
  <button class="advisor-tab-btn" data-tab="installed">Установленные <span id="installed-count-badge" class="badge badge-secondary" style="display:none"></span></button>
  <button class="advisor-tab-btn" data-tab="custom">Свой контейнер</button>
</div>

<!-- Tab: Catalog -->
<div class="tab-content" id="tab-catalog">
  <!-- Category filter -->
  <div id="cat-filter-bar" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;margin-top:12px">
    <button class="btn btn-sm btn-primary cat-filter-btn" data-cat="all">Все</button>
    <button class="btn btn-sm btn-secondary cat-filter-btn" data-cat="cloud">Облако</button>
    <button class="btn btn-sm btn-secondary cat-filter-btn" data-cat="photo">Фото</button>
    <button class="btn btn-sm btn-secondary cat-filter-btn" data-cat="media">Медиа</button>
    <button class="btn btn-sm btn-secondary cat-filter-btn" data-cat="office">Офис</button>
    <button class="btn btn-sm btn-secondary cat-filter-btn" data-cat="mail">Почта</button>
    <button class="btn btn-sm btn-secondary cat-filter-btn" data-cat="chat">Чат</button>
    <button class="btn btn-sm btn-secondary cat-filter-btn" data-cat="security">Безопасность</button>
    <button class="btn btn-sm btn-secondary cat-filter-btn" data-cat="network">Сеть</button>
    <button class="btn btn-sm btn-secondary cat-filter-btn" data-cat="iot">IoT</button>
  </div>
  <div id="catalog-grid" class="app-catalog-grid"></div>
</div>

<!-- Tab: Installed -->
<div class="tab-content" id="tab-installed" style="display:none">
  <div id="installed-list" style="margin-top:12px"></div>
  <div id="installed-empty" style="display:none;text-align:center;padding:40px;color:var(--color-muted)">
    Нет установленных приложений.<br>Перейдите в Каталог для установки.
  </div>
</div>

<!-- Tab: Custom -->
<div class="tab-content" id="tab-custom" style="display:none">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:720px;margin-top:16px">
    <div class="app-mode-card" id="mode-simple">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round"
              d="M9 12h6m-3-3v6M3 12a9 9 0 1118 0 9 9 0 01-18 0z"/>
      </svg>
      <strong>Простая форма</strong>
      <p>Укажите образ, порты и volumes</p>
    </div>
    <div class="app-mode-card" id="mode-compose">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round"
              d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
      </svg>
      <strong>Импорт Compose</strong>
      <p>Загрузите свой docker-compose.yml</p>
    </div>
  </div>

  <!-- Simple form (hidden by default) -->
  <div id="custom-simple-form" style="display:none;margin-top:16px;max-width:560px">
    <div class="form-group">
      <label>Название *</label>
      <input type="text" id="cs-name" class="form-control" placeholder="my-app">
    </div>
    <div class="form-group">
      <label>Docker-образ *</label>
      <input type="text" id="cs-image" class="form-control" placeholder="nginx:latest">
    </div>
    <div class="form-group">
      <label>Порты (host:container)</label>
      <div id="cs-ports-list"></div>
      <button class="btn btn-sm btn-secondary" id="cs-add-port">+ Добавить порт</button>
    </div>
    <div class="form-group">
      <label>Переменные окружения</label>
      <div id="cs-env-list"></div>
      <button class="btn btn-sm btn-secondary" id="cs-add-env">+ Добавить</button>
    </div>
    <div class="form-group">
      <label>Политика перезапуска</label>
      <select id="cs-restart" class="form-control">
        <option value="always">Всегда перезапускать</option>
        <option value="unless-stopped">Если не остановлен вручную</option>
        <option value="no">Никогда</option>
        <option value="on-failure">При ошибке</option>
      </select>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-secondary" id="cs-cancel">Отмена</button>
      <button class="btn btn-primary" id="cs-submit">Запустить</button>
    </div>
  </div>

  <!-- Compose import form (hidden by default) -->
  <div id="custom-compose-form" style="display:none;margin-top:16px;max-width:560px">
    <div class="form-group">
      <label>Название проекта *</label>
      <input type="text" id="cc-name" class="form-control" placeholder="my-stack">
    </div>
    <div class="form-group">
      <label>docker-compose.yml</label>
      <div class="app-dropzone" id="cc-dropzone">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25M9 16.5v.75m3-3v3m3-6v6m-1.5-10.125h.375a.375.375 0 01.375.375v.375"/>
        </svg>
        <span>Перетащите docker-compose.yml или нажмите для выбора</span>
        <input type="file" id="cc-file-input" accept=".yml,.yaml" style="display:none">
      </div>
      <pre id="cc-preview" class="app-compose-preview" style="display:none"></pre>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-secondary" id="cc-cancel">Отмена</button>
      <button class="btn btn-primary" id="cc-submit">Запустить</button>
    </div>
  </div>
</div>

<!-- Install Modal -->
<div class="modal-overlay hidden" id="install-modal">
  <div class="modal-box modal-box-wide">
    <div class="modal-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h3 id="install-modal-title" style="margin:0">Установка приложения</h3>
      <button class="btn btn-sm btn-secondary" id="install-modal-close">✕</button>
    </div>
    <div id="install-form-area"></div>
    <div id="install-progress-area" style="display:none">
      <div id="install-steps-list" style="margin-bottom:12px"></div>
      <div style="background:var(--color-border);border-radius:4px;height:8px;overflow:hidden">
        <div id="install-progress-bar" style="height:100%;background:var(--primary);width:0%;transition:width 0.3s"></div>
      </div>
      <div id="install-progress-pct" style="text-align:right;font-size:12px;color:var(--color-muted);margin-top:4px">0%</div>
    </div>
    <div id="install-result-area" style="display:none"></div>
    <div class="modal-footer" id="install-modal-footer">
      <button class="btn btn-secondary" id="install-cancel-btn">Отмена</button>
      <button class="btn btn-primary" id="install-confirm-btn">Установить</button>
    </div>
  </div>
</div>

<!-- Logs Modal -->
<div class="modal-overlay hidden" id="logs-modal">
  <div class="modal-box modal-box-wide">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 id="logs-modal-title" style="margin:0">Логи</h3>
      <button class="btn btn-sm btn-secondary" id="logs-modal-close">✕</button>
    </div>
    <pre id="logs-content" style="background:var(--bg);border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:12px;overflow:auto;max-height:480px;font-size:12px;white-space:pre-wrap"></pre>
  </div>
</div>

<script src="js/containers.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `css/containers.css`**

```css
/* App catalog grid */
.app-catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 16px;
    margin-top: 4px;
}

/* App card */
.app-card {
    background: var(--bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    box-shadow: var(--card-shadow);
    padding: 16px;
    transition: all 150ms ease;
    cursor: default;
}
.app-card:hover {
    box-shadow: var(--card-shadow-hover);
    border-color: var(--primary);
    transform: translateY(-1px);
}

/* App card header */
.app-card-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 10px;
}
.app-card-icon {
    width: 52px;
    height: 52px;
    border-radius: var(--radius-sm);
    background: var(--primary-light);
    border: 1px solid var(--primary-border);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--primary);
}
.app-card-icon svg { color: var(--primary); }
.app-card-meta { flex: 1; }
.app-card-name {
    font-weight: 700;
    font-size: 15px;
    line-height: 1.2;
    margin-bottom: 3px;
}
.app-card-desc {
    font-size: 13px;
    color: var(--color-muted);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

/* App card stats row */
.app-card-stats {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: var(--color-muted);
    margin-bottom: 12px;
    padding-top: 8px;
    border-top: 1px solid var(--color-border);
}

/* App card actions */
.app-card-actions {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    align-items: center;
}

/* Installed list rows */
.installed-app-row {
    background: var(--bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 14px;
    transition: border-color 150ms;
}
.installed-app-row:hover {
    border-color: var(--primary);
}
.installed-app-row-icon {
    width: 42px;
    height: 42px;
    border-radius: var(--radius-sm);
    background: var(--primary-light);
    border: 1px solid var(--primary-border);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--primary);
}
.installed-app-info { flex: 1; min-width: 0; }
.installed-app-name {
    font-weight: 600;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
}
.installed-app-url {
    font-size: 12px;
    color: var(--color-link);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.installed-app-stats {
    font-size: 12px;
    color: var(--color-muted);
    display: flex;
    gap: 12px;
    margin-top: 2px;
}
.installed-app-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
}

/* Mode cards (custom container) */
.app-mode-card {
    background: var(--bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 24px 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    cursor: pointer;
    transition: all 150ms ease;
    color: var(--color-muted);
    text-align: center;
    align-items: center;
}
.app-mode-card:hover {
    border-color: var(--primary);
    background: var(--primary-light);
    color: var(--primary);
}
.app-mode-card strong { font-size: 15px; color: var(--color);  }
.app-mode-card p { font-size: 13px; margin: 0; }

/* Dropzone */
.app-dropzone {
    border: 2px dashed var(--color-border);
    border-radius: var(--radius);
    padding: 32px 16px;
    text-align: center;
    cursor: pointer;
    transition: all 150ms;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--color-muted);
}
.app-dropzone:hover, .app-dropzone.drag-over {
    border-color: var(--primary);
    background: var(--primary-light);
    color: var(--primary);
}

/* Compose preview */
.app-compose-preview {
    background: var(--bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 12px;
    font-family: "Red Hat Mono", ui-monospace, monospace;
    font-size: 12px;
    overflow: auto;
    max-height: 200px;
    white-space: pre;
    margin-top: 8px;
}

/* Install steps */
.install-step {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    font-size: 13px;
}
.install-step-icon { width: 20px; flex-shrink: 0; }

/* Port/env row inputs */
.param-row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 6px;
}
.param-row input { flex: 1; }
.param-row .remove-btn {
    cursor: pointer;
    color: var(--danger);
    background: none;
    border: none;
    font-size: 16px;
    padding: 0 4px;
}

/* Featured badge */
.app-featured-badge {
    font-size: 11px;
    background: var(--warning);
    color: #fff;
    border-radius: 3px;
    padding: 1px 5px;
    font-weight: 600;
}

@media (max-width: 768px) {
    .app-catalog-grid { grid-template-columns: 1fr; }
    .installed-app-row { flex-direction: column; align-items: flex-start; }
    .installed-app-actions { flex-wrap: wrap; }
}
```

- [ ] **Step 3: Commit**

```bash
git add cockpit/rusnas/containers.html cockpit/rusnas/css/containers.css
git commit -m "feat: add containers.html page structure and containers.css"
```

---

## Task 5: containers.js — Tab 1 Catalog + Install Modal

**Files:**
- Create: `cockpit/rusnas/js/containers.js`

- [ ] **Step 1: Create `containers.js` with catalog loading and install modal**

```javascript
/* rusNAS Container Manager — containers.js */
"use strict";

const CONTAINER_CGI = "/usr/lib/rusnas/cgi/container_api.py";

/* ── helpers ───────────────────────────────────────────────── */
function _esc(s) {
    return String(s || "")
        .replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function cgiCall(cmd, args) {
    args = args || [];
    return new Promise(function(resolve, reject) {
        var out = "";
        cockpit.spawn(
            ["sudo", "-n", "python3", CONTAINER_CGI, cmd].concat(args),
            { err: "message", superuser: "try" }
        ).stream(function(d){ out += d; })
         .done(function(){
             try { resolve(JSON.parse(out)); }
             catch(e) { reject(new Error("JSON parse error: " + out.substring(0,200))); }
         })
         .fail(function(e){ reject(e); });
    });
}

/* App icon SVG by category */
function _appIconSvg(category) {
    var icons = {
        cloud: '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"/>',
        photo: '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/>',
        media: '<path stroke-linecap="round" stroke-linejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75.125v-16.5C2.25 1.5 2.75 1.5 3.375 1.5h17.25c.621 0 1.125.504 1.125 1.125V18.375c0 .621-.504 1.125-1.125 1.125M3.375 19.5H18.75m-15.375 0V18.375m0 0h16.5"/>',
        security: '<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/>',
        iot: '<path stroke-linecap="round" stroke-linejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"/>',
        network: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"/>',
        mail: '<path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"/>',
        chat: '<path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"/>',
        office: '<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>',
    };
    var path = icons[category] || icons.cloud;
    return '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' + path + '</svg>';
}

/* ── state ─────────────────────────────────────────────────── */
var _catalogApps = [];
var _installedApps = {};
var _currentCat = "all";
var _statsTimer = null;
var _installAppId = null;
var _volumes = [];

/* ── tab switching ─────────────────────────────────────────── */
function switchTab(tabName) {
    document.querySelectorAll(".tab-content").forEach(function(el) {
        el.style.display = "none";
    });
    document.querySelectorAll("#containers-tabs .advisor-tab-btn").forEach(function(btn) {
        btn.classList.remove("active");
    });
    var c = document.getElementById("tab-" + tabName);
    if (c) c.style.display = "";
    var b = document.querySelector('#containers-tabs .advisor-tab-btn[data-tab="' + tabName + '"]');
    if (b) b.classList.add("active");

    if (tabName === "installed") loadInstalled();
}

document.querySelectorAll("#containers-tabs .advisor-tab-btn[data-tab]").forEach(function(btn) {
    btn.addEventListener("click", function() { switchTab(btn.dataset.tab); });
});

/* ── catalog ───────────────────────────────────────────────── */
function loadCatalog() {
    return new Promise(function(resolve, reject) {
        Promise.all([
            cgiCall("get_catalog"),
            cgiCall("list_installed")
        ]).then(function(results) {
            var catResult = results[0];
            var insResult = results[1];

            _installedApps = {};
            (insResult.apps || []).forEach(function(a) {
                _installedApps[a.app_id] = a;
            });

            _catalogApps = catResult.apps || [];
            renderCatalog(_currentCat);
            updateInstalledBadge();
            resolve();
        }).catch(reject);
    });
}

function renderCatalog(cat) {
    _currentCat = cat;
    var grid = document.getElementById("catalog-grid");
    var apps = cat === "all"
        ? _catalogApps
        : _catalogApps.filter(function(a) { return a.category === cat; });

    if (!apps.length) {
        grid.innerHTML = '<p style="color:var(--color-muted);padding:24px">Нет приложений в этой категории.</p>';
        return;
    }

    grid.innerHTML = apps.map(function(app) {
        var isInstalled = !!_installedApps[app.id];
        var name = typeof app.name === "object" ? (app.name.ru || app.name.en) : (app.id);
        var desc = typeof app.description === "object"
            ? (app.description.ru || app.description.en || "")
            : "";
        return '<div class="app-card">' +
            '<div class="app-card-header">' +
                '<div class="app-card-icon">' + _appIconSvg(app.category) + '</div>' +
                '<div class="app-card-meta">' +
                    '<div class="app-card-name">' + _esc(name) +
                        (app.featured ? ' <span class="app-featured-badge">Хит</span>' : '') +
                    '</div>' +
                    '<div class="app-card-desc">' + _esc(desc) + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="app-card-stats">' +
                '<span>' + _esc(app.category) + '</span>' +
                (app.min_ram_mb ? '<span>RAM: ' + _esc(String(app.min_ram_mb)) + ' MB</span>' : '') +
                (app.containers ? '<span>' + _esc(String(app.containers)) + ' контейнер(а)</span>' : '') +
            '</div>' +
            '<div class="app-card-actions">' +
                (isInstalled
                    ? '<span class="badge badge-success">Установлено</span>'
                    : '<button class="btn btn-primary btn-sm" onclick="openInstallModal(\'' + _esc(app.id) + '\')">Установить</button>') +
            '</div>' +
        '</div>';
    }).join("");
}

/* Category filter */
document.querySelectorAll(".cat-filter-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
        document.querySelectorAll(".cat-filter-btn").forEach(function(b) {
            b.classList.remove("btn-primary");
            b.classList.add("btn-secondary");
        });
        btn.classList.add("btn-primary");
        btn.classList.remove("btn-secondary");
        renderCatalog(btn.dataset.cat);
    });
});

/* ── install modal ─────────────────────────────────────────── */
function openInstallModal(appId) {
    _installAppId = appId;
    var app = _catalogApps.find(function(a) { return a.id === appId; });
    if (!app) return;

    var name = typeof app.name === "object" ? (app.name.ru || appId) : appId;
    document.getElementById("install-modal-title").textContent = "Установка: " + name;
    document.getElementById("install-progress-area").style.display = "none";
    document.getElementById("install-result-area").style.display = "none";
    document.getElementById("install-modal-footer").style.display = "";

    var params = app.install_params || [];
    var passwordVal = _generatePassword();

    var html = '<div>';

    // Volume selector
    html += '<div class="form-group"><label>Том для данных *</label>' +
            '<select id="im-volume" class="form-control">';
    (_volumes || []).forEach(function(v) {
        html += '<option value="' + _esc(v.path) + '">' +
                _esc(v.path) + ' (' + _esc(v.avail) + ' свободно)</option>';
    });
    if (!_volumes.length) {
        html += '<option value="/mnt/data">/mnt/data (по умолчанию)</option>';
    }
    html += '</select></div>';

    params.forEach(function(p) {
        if (p.key === "admin_password") {
            html += '<div class="form-group"><label>' + _esc(p.label) + '</label>' +
                    '<div style="display:flex;gap:8px">' +
                    '<input type="text" id="im-' + _esc(p.key) + '" class="form-control" value="' + _esc(passwordVal) + '">' +
                    '<button class="btn btn-secondary btn-sm" onclick="document.getElementById(\'im-' + _esc(p.key) + '\').value=_generatePassword()">Новый</button>' +
                    '</div></div>';
        } else {
            html += '<div class="form-group"><label>' + _esc(p.label) + '</label>' +
                    '<input type="' + (p.type === "port" ? "number" : "text") +
                    '" id="im-' + _esc(p.key) + '" class="form-control" value="' + _esc(p.default) + '">' +
                    '</div>';
        }
    });

    if (app.min_ram_mb || app.disk_gb) {
        html += '<div class="alert alert-info" style="font-size:13px">Потребуется' +
                (app.min_ram_mb ? ' ~' + app.min_ram_mb + ' MB RAM' : '') +
                (app.disk_gb ? ', ~' + app.disk_gb + ' GB диска' : '') +
                '. Первый запуск занимает 1–5 минут (загрузка образов).</div>';
    }

    html += '</div>';
    document.getElementById("install-form-area").innerHTML = html;

    document.getElementById("install-modal").classList.remove("hidden");
}

function _generatePassword() {
    var chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    var result = "";
    for (var i = 0; i < 16; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

document.getElementById("install-modal-close").addEventListener("click", function() {
    document.getElementById("install-modal").classList.add("hidden");
});
document.getElementById("install-cancel-btn").addEventListener("click", function() {
    document.getElementById("install-modal").classList.add("hidden");
});

document.getElementById("install-confirm-btn").addEventListener("click", function() {
    doInstall();
});

function doInstall() {
    var app = _catalogApps.find(function(a) { return a.id === _installAppId; });
    if (!app) return;

    var volEl = document.getElementById("im-volume");
    var volumePath = volEl ? volEl.value : "/mnt/data";

    var args = ["volume_path=" + volumePath];
    (app.install_params || []).forEach(function(p) {
        var el = document.getElementById("im-" + p.key);
        if (el) args.push(p.key + "=" + el.value);
    });

    // Switch to progress view
    document.getElementById("install-form-area").style.display = "none";
    document.getElementById("install-modal-footer").style.display = "none";
    document.getElementById("install-progress-area").style.display = "";

    var steps = [
        "Создание директорий...",
        "Загрузка образов контейнеров...",
        "Запуск контейнеров...",
        "Настройка reverse proxy...",
        "Сохранение конфигурации...",
    ];
    var stepHtml = steps.map(function(s, i) {
        return '<div class="install-step" id="istep-' + i + '">' +
               '<span class="install-step-icon">⬜</span>' +
               '<span>' + _esc(s) + '</span></div>';
    }).join("");
    document.getElementById("install-steps-list").innerHTML = stepHtml;

    // Animate steps while install runs
    var stepIdx = 0;
    var stepTimer = setInterval(function() {
        if (stepIdx < steps.length) {
            if (stepIdx > 0) {
                var prev = document.getElementById("istep-" + (stepIdx - 1));
                if (prev) prev.querySelector(".install-step-icon").textContent = "✅";
            }
            var curr = document.getElementById("istep-" + stepIdx);
            if (curr) curr.querySelector(".install-step-icon").textContent = "⏳";
            var pct = Math.round(((stepIdx + 1) / steps.length) * 100);
            document.getElementById("install-progress-bar").style.width = pct + "%";
            document.getElementById("install-progress-pct").textContent = pct + "%";
            stepIdx++;
        }
    }, 2000);

    cgiCall("install", [_installAppId].concat(args)).then(function(r) {
        clearInterval(stepTimer);
        // Mark all done
        for (var i = 0; i < steps.length; i++) {
            var s = document.getElementById("istep-" + i);
            if (s) s.querySelector(".install-step-icon").textContent = "✅";
        }
        document.getElementById("install-progress-bar").style.width = "100%";
        document.getElementById("install-progress-pct").textContent = "100%";

        if (r.ok) {
            setTimeout(function() {
                showInstallResult(app, r);
            }, 500);
        } else {
            document.getElementById("install-progress-area").style.display = "none";
            document.getElementById("install-result-area").style.display = "";
            document.getElementById("install-result-area").innerHTML =
                '<div class="alert alert-danger">Ошибка установки: ' + _esc(r.error) + '</div>' +
                '<button class="btn btn-secondary" onclick="document.getElementById(\'install-modal\').classList.add(\'hidden\')">Закрыть</button>';
        }

        // Reload catalog to show "Установлено" badge
        loadCatalog();
    }).catch(function(e) {
        clearInterval(stepTimer);
        document.getElementById("install-progress-area").style.display = "none";
        document.getElementById("install-result-area").style.display = "";
        document.getElementById("install-result-area").innerHTML =
            '<div class="alert alert-danger">Ошибка: ' + _esc(String(e)) + '</div>' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'install-modal\').classList.add(\'hidden\')">Закрыть</button>';
    });
}

function showInstallResult(app, result) {
    var name = typeof app.name === "object" ? (app.name.ru || app.id) : app.id;
    document.getElementById("install-progress-area").style.display = "none";
    document.getElementById("install-result-area").style.display = "";
    document.getElementById("install-result-area").innerHTML =
        '<div style="text-align:center;padding:8px 0 16px">' +
            '<div style="font-size:32px;margin-bottom:8px">✅</div>' +
            '<h4 style="margin:0 0 16px">' + _esc(name) + ' установлен</h4>' +
        '</div>' +
        (result.url ? '<div class="form-group"><label>Адрес</label>' +
            '<a href="' + _esc(result.url) + '" target="_blank" style="color:var(--color-link)">' + _esc(result.url) + '</a>' +
            '</div>' : '') +
        (result.admin_password ? '<div class="form-group"><label>Пароль администратора</label>' +
            '<div style="display:flex;gap:8px">' +
            '<input type="text" class="form-control" value="' + _esc(result.admin_password) + '" readonly id="inst-pw-field">' +
            '<button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(document.getElementById(\'inst-pw-field\').value)">Скопировать</button>' +
            '</div>' +
            '<small class="text-muted">Сохраните пароль — он больше не будет показан.</small>' +
            '</div>' : '') +
        '<div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">' +
            (result.url ? '<a href="' + _esc(result.url) + '" target="_blank" class="btn btn-primary btn-sm">Открыть</a>' : '') +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'install-modal\').classList.add(\'hidden\')">Закрыть</button>' +
        '</div>';
}
```

- [ ] **Step 2: Commit**

```bash
git add cockpit/rusnas/js/containers.js
git commit -m "feat: containers.js catalog tab, category filter, install modal"
```

---

## Task 6: containers.js — Tab 2 Installed + Stats

**Files:**
- Modify: `cockpit/rusnas/js/containers.js`

- [ ] **Step 1: Add installed tab functions (append to containers.js)**

```javascript
/* ── installed ─────────────────────────────────────────────── */
function loadInstalled() {
    cgiCall("list_installed").then(function(r) {
        _installedApps = {};
        (r.apps || []).forEach(function(a) {
            _installedApps[a.app_id] = a;
        });
        renderInstalled(r.apps || []);
        updateInstalledBadge();
    }).catch(function(e) {
        console.error("loadInstalled error:", e);
    });
}

function renderInstalled(apps) {
    var list = document.getElementById("installed-list");
    var empty = document.getElementById("installed-empty");

    if (!apps.length) {
        list.innerHTML = "";
        empty.style.display = "";
        return;
    }
    empty.style.display = "none";

    list.innerHTML = apps.map(function(app) {
        var name = typeof app.name === "object" ? (app.name.ru || app.app_id) : app.app_id;
        var status = app.live_status || "stopped";
        var dotClass = status === "running" ? "db-dot-green"
                    : status === "partial" ? "db-dot-orange"
                    : "db-dot-gray";
        var statusLabel = status === "running" ? "Работает"
                       : status === "partial" ? "Частично"
                       : "Остановлен";

        var category = app.category || "cloud";
        var url = app.nginx_path
            ? ("http://" + window.location.hostname + app.nginx_path)
            : (app.host_ports && Object.values(app.host_ports)[0]
               ? ("http://" + window.location.hostname + ":" + Object.values(app.host_ports)[0])
               : "");

        return '<div class="installed-app-row" id="irow-' + _esc(app.app_id) + '">' +
            '<div class="installed-app-row-icon">' + _appIconSvg(category) + '</div>' +
            '<div class="installed-app-info">' +
                '<div class="installed-app-name">' +
                    _esc(name) +
                    '<span class="db-status-dot ' + dotClass + '" style="margin-left:4px"></span>' +
                    '<span style="font-size:12px;font-weight:400;color:var(--color-muted)">' + statusLabel + '</span>' +
                '</div>' +
                (url ? '<div class="installed-app-url"><a href="' + _esc(url) + '" target="_blank">' + _esc(url) + '</a></div>' : '') +
                '<div class="installed-app-stats" id="stats-' + _esc(app.app_id) + '">' +
                    '<span>Uptime: —</span><span>CPU: —</span><span>RAM: —</span>' +
                '</div>' +
            '</div>' +
            '<div class="installed-app-actions">' +
                (url ? '<a href="' + _esc(url) + '" target="_blank" class="btn btn-sm btn-secondary">Открыть</a>' : '') +
                (status === "running"
                    ? '<button class="btn btn-sm btn-secondary" onclick="appAction(\'restart\',\'' + _esc(app.app_id) + '\')">Перезапуск</button>' +
                      '<button class="btn btn-sm btn-secondary" onclick="appAction(\'stop\',\'' + _esc(app.app_id) + '\')">Стоп</button>'
                    : '<button class="btn btn-sm btn-primary" onclick="appAction(\'start\',\'' + _esc(app.app_id) + '\')">Запустить</button>') +
                '<button class="btn btn-sm btn-secondary" onclick="openLogs(\'' + _esc(app.app_id) + '\')" title="Логи">' +
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z"/></svg>' +
                '</button>' +
                '<button class="btn btn-sm btn-danger" onclick="confirmUninstall(\'' + _esc(app.app_id) + '\',\'' + _esc(name) + '\')" title="Удалить">✕</button>' +
            '</div>' +
        '</div>';
    }).join("");
}

function updateInstalledBadge() {
    var count = Object.keys(_installedApps).length;
    var badge = document.getElementById("installed-count-badge");
    if (!badge) return;
    if (count > 0) {
        badge.style.display = "";
        badge.textContent = count;
    } else {
        badge.style.display = "none";
    }
}

function appAction(action, appId) {
    var btn = document.querySelector('#irow-' + appId + ' .installed-app-actions .btn-primary,' +
                                     '#irow-' + appId + ' .installed-app-actions .btn-secondary');
    cgiCall(action, [appId]).then(function(r) {
        if (r.ok) loadInstalled();
        else alert("Ошибка: " + (r.error || "неизвестно"));
    }).catch(function(e) {
        alert("Ошибка: " + e);
    });
}

function confirmUninstall(appId, name) {
    if (!confirm("Удалить " + name + "?\n\nОстановить контейнеры и удалить конфигурацию? (Данные можно сохранить)")) return;
    var keepData = confirm("Сохранить данные приложения на диске?");
    var args = [appId];
    if (keepData) args.push("--keep-data");
    cgiCall("uninstall", args).then(function(r) {
        if (r.ok) {
            loadInstalled();
            loadCatalog(); // refresh "Установлено" badge
        } else {
            alert("Ошибка удаления: " + (r.error || ""));
        }
    }).catch(function(e) { alert("Ошибка: " + e); });
}

/* Stats polling */
function startStatsPolling() {
    if (_statsTimer) clearInterval(_statsTimer);
    _statsTimer = setInterval(function() {
        var tab = document.getElementById("tab-installed");
        if (!tab || tab.style.display === "none") return;
        cgiCall("get_stats").then(function(r) {
            (r.stats || []).forEach(function(s) {
                var name = (s.Name || s.name || "").replace(/^rusnas-/, "");
                // find appId from container name prefix
                Object.keys(_installedApps).forEach(function(appId) {
                    if ((s.Name || "").includes(appId)) {
                        var el = document.getElementById("stats-" + appId);
                        if (el) {
                            el.innerHTML =
                                '<span>CPU: ' + _esc(String(s.CPUPerc || s.cpu_percent || "—")) + '</span>' +
                                '<span>RAM: ' + _esc(String(s.MemUsage || s.mem_usage || "—")) + '</span>';
                        }
                    }
                });
            });
        }).catch(function(){});
    }, 5000);
}

/* Logs modal */
function openLogs(appId) {
    var name = (_installedApps[appId] || {}).name;
    if (typeof name === "object") name = name.ru || appId;
    document.getElementById("logs-modal-title").textContent = "Логи: " + (name || appId);
    document.getElementById("logs-content").textContent = "Загрузка…";
    document.getElementById("logs-modal").classList.remove("hidden");
    cgiCall("get_logs", [appId, "200"]).then(function(r) {
        document.getElementById("logs-content").textContent = r.logs || "(пусто)";
    }).catch(function(e) {
        document.getElementById("logs-content").textContent = "Ошибка: " + e;
    });
}

document.getElementById("logs-modal-close").addEventListener("click", function() {
    document.getElementById("logs-modal").classList.add("hidden");
});
```

- [ ] **Step 2: Commit**

```bash
git add cockpit/rusnas/js/containers.js
git commit -m "feat: containers.js installed tab, stats polling, logs modal"
```

---

## Task 7: containers.js — Tab 3 Custom + Init

**Files:**
- Modify: `cockpit/rusnas/js/containers.js`

- [ ] **Step 1: Add custom container tab + init (append to containers.js)**

```javascript
/* ── custom container tab ──────────────────────────────────── */
document.getElementById("mode-simple").addEventListener("click", function() {
    document.getElementById("custom-simple-form").style.display = "";
    document.getElementById("custom-compose-form").style.display = "none";
});

document.getElementById("mode-compose").addEventListener("click", function() {
    document.getElementById("custom-compose-form").style.display = "";
    document.getElementById("custom-simple-form").style.display = "none";
});

document.getElementById("cs-cancel").addEventListener("click", function() {
    document.getElementById("custom-simple-form").style.display = "none";
});
document.getElementById("cc-cancel").addEventListener("click", function() {
    document.getElementById("custom-compose-form").style.display = "none";
});

/* Port/env dynamic rows */
var _portCount = 0;
var _envCount = 0;

document.getElementById("cs-add-port").addEventListener("click", function() {
    var idx = _portCount++;
    var row = document.createElement("div");
    row.className = "param-row";
    row.id = "port-row-" + idx;
    row.innerHTML = '<input type="number" class="form-control" placeholder="9090" id="port-host-' + idx + '" style="max-width:100px">' +
        '<span>:</span>' +
        '<input type="number" class="form-control" placeholder="80" id="port-cont-' + idx + '" style="max-width:100px">' +
        '<button class="remove-btn" onclick="document.getElementById(\'port-row-' + idx + '\').remove()">✕</button>';
    document.getElementById("cs-ports-list").appendChild(row);
});

document.getElementById("cs-add-env").addEventListener("click", function() {
    var idx = _envCount++;
    var row = document.createElement("div");
    row.className = "param-row";
    row.id = "env-row-" + idx;
    row.innerHTML = '<input type="text" class="form-control" placeholder="KEY" id="env-key-' + idx + '">' +
        '<span>=</span>' +
        '<input type="text" class="form-control" placeholder="value" id="env-val-' + idx + '">' +
        '<button class="remove-btn" onclick="document.getElementById(\'env-row-' + idx + '\').remove()">✕</button>';
    document.getElementById("cs-env-list").appendChild(row);
});

document.getElementById("cs-submit").addEventListener("click", function() {
    var name = (document.getElementById("cs-name").value || "").trim();
    var image = (document.getElementById("cs-image").value || "").trim();
    if (!name || !image) { alert("Укажите название и образ"); return; }

    var args = [name, image];

    // Collect ports
    document.querySelectorAll("#cs-ports-list .param-row").forEach(function(row) {
        var idx = row.id.replace("port-row-", "");
        var h = document.getElementById("port-host-" + idx);
        var c = document.getElementById("port-cont-" + idx);
        if (h && c && h.value && c.value) {
            args.push("port_" + h.value + "=" + c.value);
        }
    });

    // Collect envs
    document.querySelectorAll("#cs-env-list .param-row").forEach(function(row) {
        var idx = row.id.replace("env-row-", "");
        var k = document.getElementById("env-key-" + idx);
        var v = document.getElementById("env-val-" + idx);
        if (k && v && k.value) {
            args.push("env_" + k.value + "=" + v.value);
        }
    });

    args.push("restart=" + document.getElementById("cs-restart").value);

    cgiCall("install_custom", args).then(function(r) {
        if (r.ok) {
            document.getElementById("custom-simple-form").style.display = "none";
            switchTab("installed");
        } else {
            alert("Ошибка: " + (r.error || ""));
        }
    }).catch(function(e) { alert("Ошибка: " + e); });
});

/* Compose file drag-drop */
var dropzone = document.getElementById("cc-dropzone");
var fileInput = document.getElementById("cc-file-input");

dropzone.addEventListener("click", function() { fileInput.click(); });
dropzone.addEventListener("dragover", function(e) { e.preventDefault(); dropzone.classList.add("drag-over"); });
dropzone.addEventListener("dragleave", function() { dropzone.classList.remove("drag-over"); });
dropzone.addEventListener("drop", function(e) {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    var file = e.dataTransfer.files[0];
    if (file) readComposeFile(file);
});
fileInput.addEventListener("change", function() {
    if (fileInput.files[0]) readComposeFile(fileInput.files[0]);
});

function readComposeFile(file) {
    var reader = new FileReader();
    reader.onload = function(e) {
        var content = e.target.result;
        var preview = document.getElementById("cc-preview");
        preview.textContent = content.substring(0, 2000) + (content.length > 2000 ? "\n..." : "");
        preview.style.display = "";
        preview._content = content;
    };
    reader.readAsText(file);
}

document.getElementById("cc-submit").addEventListener("click", function() {
    var name = (document.getElementById("cc-name").value || "").trim();
    var preview = document.getElementById("cc-preview");
    if (!name) { alert("Укажите название проекта"); return; }
    if (!preview._content) { alert("Выберите docker-compose.yml"); return; }

    // Write content to tmp file via cockpit.file, then import
    var tmpPath = "/tmp/rusnas-compose-import.yml";
    cockpit.file(tmpPath, { superuser: "try" }).replace(preview._content).then(function() {
        cgiCall("import_compose", [name, tmpPath]).then(function(r) {
            if (r.ok) {
                document.getElementById("custom-compose-form").style.display = "none";
                switchTab("installed");
            } else {
                alert("Ошибка: " + (r.error || ""));
            }
        }).catch(function(e) { alert("Ошибка: " + e); });
    }).catch(function(e) { alert("Ошибка записи файла: " + e); });
});

/* ── init ──────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", function() {
    // Load volumes for install modal
    cgiCall("get_btrfs_volumes").then(function(r) {
        _volumes = r.volumes || [];
    }).catch(function(){});

    // Load podman version
    cockpit.spawn(["sudo", "-u", "rusnas-containers", "podman", "--version"],
                  { err: "message" })
        .done(function(out) {
            var versionEl = document.getElementById("podman-version");
            if (versionEl) versionEl.textContent = out.trim();
        });

    loadCatalog();
    startStatsPolling();
});
```

- [ ] **Step 2: Commit**

```bash
git add cockpit/rusnas/js/containers.js
git commit -m "feat: containers.js custom container tab, compose import, init"
```

---

## Task 8: manifest.json + Dashboard Widget

**Files:**
- Modify: `cockpit/rusnas/manifest.json`
- Modify: `cockpit/rusnas/js/dashboard.js`

- [ ] **Step 1: Update manifest.json**

Read `cockpit/rusnas/manifest.json`, find the `"menu"` section, add after the snapshots entry (or at order 55):

```json
"containers": {
  "label": "Приложения",
  "order": 55,
  "path": "containers.html"
}
```

- [ ] **Step 2: Add container widget to dashboard.js**

Find where RAID, UPS, and other dashboard cards are rendered. Add a `loadContainersWidget()` function and call it from `initDashboard()`.

```javascript
var DB_CONTAINERS_CGI = "/usr/lib/rusnas/cgi/container_api.py";

function loadContainersWidget() {
    var el = document.getElementById("db-containers-card");
    if (!el) return;

    new Promise(function(resolve, reject) {
        var out = "";
        cockpit.spawn(
            ["sudo", "-n", "python3", DB_CONTAINERS_CGI, "list_installed"],
            { err: "message", superuser: "try" }
        ).stream(function(d){ out += d; })
         .done(function(){
             try { resolve(JSON.parse(out)); }
             catch(e) { reject(e); }
         }).fail(reject);
    }).then(function(r) {
        var apps = r.apps || [];
        var running = apps.filter(function(a){ return a.live_status === "running"; }).length;
        var errors = apps.filter(function(a){ return a.live_status === "error"; }).length;
        var total = apps.length;

        var cardClass = errors > 0 ? "db-card-crit"
                      : (running < total && total > 0) ? "db-card-warn"
                      : "db-card-ok";

        el.className = "db-card " + cardClass;
        el.innerHTML =
            '<div class="db-card-title">ПРИЛОЖЕНИЯ</div>' +
            '<div class="db-card-metric">' + total + '</div>' +
            '<div class="db-card-sub">' +
                running + ' работают' +
                (errors > 0 ? ' &bull; <span style="color:var(--danger)">' + errors + ' ошибок</span>' : '') +
            '</div>';
    }).catch(function() {
        var el2 = document.getElementById("db-containers-card");
        if (el2) {
            el2.className = "db-card";
            el2.innerHTML = '<div class="db-card-title">ПРИЛОЖЕНИЯ</div><div class="db-card-sub text-muted">Не настроено</div>';
        }
    });
}
```

In `dashboard.html`, add container card inside the `.db-grid-4` div that holds the UPS card (`id="db-ups-card"`). Insert the new card immediately after the UPS card's closing `</div>`:

```html
<!-- After: <div class="db-card" id="db-ups-card" ...>...</div> -->
<div class="db-card" id="db-containers-card" style="cursor:pointer"
     onclick="cockpit.jump('/rusnas/containers')">
  <div class="db-card-title">ПРИЛОЖЕНИЯ</div>
  <div class="db-card-sub text-muted">Загрузка…</div>
</div>
```

To find the exact location: `grep -n "db-ups-card" cockpit/rusnas/dashboard.html` — insert after that element's closing `</div>`.

In `dashboard.js` `initDashboard()`:
```javascript
setTimeout(loadContainersWidget, 1200);
```

- [ ] **Step 3: Run tests (load page manually)**

```bash
# Quick syntax check
node --check cockpit/rusnas/js/containers.js 2>&1
node --check cockpit/rusnas/js/dashboard.js 2>&1
```

Expected: no output (no errors).

- [ ] **Step 4: Commit**

```bash
git add cockpit/rusnas/manifest.json cockpit/rusnas/js/dashboard.js cockpit/rusnas/*.html
git commit -m "feat: add Containers page to manifest.json + dashboard widget"
```

---

## Task 9: Prometheus Metrics

**Files:**
- Modify: `rusnas-metrics/metrics_server.py`

- [ ] **Step 1: Write failing test**

```python
# tests/test_container_metrics.py
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../rusnas-metrics'))
from metrics_server import collect_containers  # noqa

def test_collect_containers_returns_string():
    result = collect_containers()
    assert isinstance(result, str)

def test_collect_containers_has_headers():
    result = collect_containers()
    assert "rusnas_container_count" in result
```

- [ ] **Step 2: Run test to confirm failure**

```bash
python3 -m pytest tests/test_container_metrics.py -v
```

- [ ] **Step 3: Add `collect_containers()` to metrics_server.py**

After the existing `collect_spindown()` function, add:

```python
def collect_containers():
    """Container metrics via podman stats + installed.json"""
    lines = []
    lines.append("# HELP rusnas_container_count Total container count by status")
    lines.append("# TYPE rusnas_container_count gauge")

    installed_file = "/etc/rusnas/containers/installed.json"
    try:
        with open(installed_file) as f:
            installed = json.load(f)
    except Exception:
        installed = {}

    running = 0
    stopped = 0
    error = 0
    for app in installed.values():
        status = app.get("live_status", app.get("status", "stopped"))
        if status == "running":
            running += 1
        elif status in ("error", "partial"):
            error += 1
        else:
            stopped += 1

    lines.append(f'rusnas_container_count{{status="running"}} {running}')
    lines.append(f'rusnas_container_count{{status="stopped"}} {stopped}')
    lines.append(f'rusnas_container_count{{status="error"}} {error}')

    # Per-container CPU/RAM via podman stats
    lines.append("# HELP rusnas_container_cpu_percent Container CPU usage percent")
    lines.append("# TYPE rusnas_container_cpu_percent gauge")
    lines.append("# HELP rusnas_container_memory_bytes Container memory usage bytes")
    lines.append("# TYPE rusnas_container_memory_bytes gauge")

    try:
        result = subprocess.run(
            ["sudo", "-u", "rusnas-containers", "podman", "stats",
             "--no-stream", "--format", "json"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout.strip():
            stats = json.loads(result.stdout)
            for s in stats:
                name = s.get("Name", s.get("name", ""))
                if not name.startswith("rusnas-"):
                    continue
                cpu_str = s.get("CPUPerc", s.get("cpu_percent", "0%"))
                cpu = float(str(cpu_str).rstrip("%") or 0)
                lines.append(f'rusnas_container_cpu_percent{{name="{name}"}} {cpu:.2f}')

                mem_str = s.get("MemUsage", s.get("mem_usage", "0B / 0B"))
                # parse "245MiB / 7.73GiB" → bytes
                mem_bytes = _parse_mem_str(mem_str)
                lines.append(f'rusnas_container_memory_bytes{{name="{name}"}} {mem_bytes}')
    except Exception:
        pass

    return "\n".join(lines) + "\n"

def _parse_mem_str(mem_str):
    """Parse podman stats MemUsage like '245MiB / 7.73GiB' → usage bytes"""
    try:
        used = mem_str.split("/")[0].strip()
        multipliers = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3,
                       "KB": 1000, "MB": 1000**2, "GB": 1000**3}
        for suffix, mult in multipliers.items():
            if used.endswith(suffix):
                return int(float(used[:-len(suffix)]) * mult)
    except Exception:
        pass
    return 0
```

Also add `collect_containers()` call in the main HTTP handler where other `collect_*` functions are called:
```python
output += collect_containers()
```

- [ ] **Step 4: Run tests**

```bash
python3 -m pytest tests/test_container_metrics.py -v
```

- [ ] **Step 5: Commit**

```bash
git add rusnas-metrics/metrics_server.py tests/test_container_metrics.py
git commit -m "feat: add container Prometheus metrics (count, CPU, RAM)"
```

---

## Task 10: Install Script

**Files:**
- Create: `install-containers.sh`

- [ ] **Step 1: Create `install-containers.sh`**

```bash
#!/bin/bash
set -euo pipefail

VM="rusnas@10.10.10.72"
PASS="kl4389qd"
SCP="sshpass -p '$PASS' scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SSH="sshpass -p '$PASS' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no $VM"

echo "=== Deploy rusNAS Container Manager ==="

# 1. Install packages on VM
$SSH "sudo apt-get install -y podman podman-compose slirp4netns fuse-overlayfs crun uidmap" || true

# 2. Create container user
$SSH "id rusnas-containers &>/dev/null || sudo useradd -r -m -d /var/lib/rusnas-containers -s /bin/bash rusnas-containers"

# 3. Add subuid/subgid
$SSH "grep -q '^rusnas-containers' /etc/subuid || echo 'rusnas-containers:100000:65536' | sudo tee -a /etc/subuid"
$SSH "grep -q '^rusnas-containers' /etc/subgid || echo 'rusnas-containers:100000:65536' | sudo tee -a /etc/subgid"

# 4. Create directories
$SSH "sudo mkdir -p /var/lib/rusnas-containers/{catalog,compose,nginx-apps}"
$SSH "sudo mkdir -p /etc/rusnas/containers"
$SSH "sudo chown -R rusnas-containers:rusnas-containers /var/lib/rusnas-containers"

# 5. Initialize podman for rusnas-containers user
$SSH "sudo -u rusnas-containers podman system migrate 2>/dev/null || true"

# 6. Copy CGI backend
$SSH "sudo mkdir -p /usr/lib/rusnas/cgi"
eval "$SCP cockpit/rusnas/cgi/container_api.py $VM:/tmp/container_api.py"
$SSH "sudo cp /tmp/container_api.py /usr/lib/rusnas/cgi/container_api.py && sudo chmod 755 /usr/lib/rusnas/cgi/container_api.py"

# 7. Copy catalog
eval "$SCP -r cockpit/rusnas/catalog $VM:/tmp/rusnas-catalog"
$SSH "sudo cp -r /tmp/rusnas-catalog /usr/share/cockpit/rusnas/catalog && sudo chmod -R 755 /usr/share/cockpit/rusnas/catalog"

# 8. Copy Cockpit plugin files
eval "$SCP cockpit/rusnas/containers.html $VM:/tmp/"
eval "$SCP cockpit/rusnas/css/containers.css $VM:/tmp/"
eval "$SCP cockpit/rusnas/js/containers.js $VM:/tmp/"
eval "$SCP cockpit/rusnas/manifest.json $VM:/tmp/"
$SSH "sudo cp /tmp/containers.html /usr/share/cockpit/rusnas/containers.html"
$SSH "sudo cp /tmp/containers.css /usr/share/cockpit/rusnas/css/containers.css"
$SSH "sudo cp /tmp/containers.js /usr/share/cockpit/rusnas/js/containers.js"
$SSH "sudo cp /tmp/manifest.json /usr/share/cockpit/rusnas/manifest.json"

# 9. Deploy updated dashboard.js
eval "$SCP cockpit/rusnas/js/dashboard.js $VM:/tmp/"
$SSH "sudo cp /tmp/dashboard.js /usr/share/cockpit/rusnas/js/dashboard.js"

# 10. Configure nginx include (if nginx installed)
$SSH "test -d /etc/nginx/conf.d && echo 'include /var/lib/rusnas-containers/nginx-apps/*.conf;' | sudo tee /etc/nginx/conf.d/rusnas-apps.conf > /dev/null || true"
$SSH "test -d /etc/nginx && sudo nginx -t && sudo systemctl reload nginx 2>/dev/null || true"

# 11. Sudoers for container_api.py
cat > /tmp/rusnas-containers-sudoers << 'EOF'
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/cgi/container_api.py *
rusnas ALL=(rusnas-containers) NOPASSWD: /usr/bin/podman *
rusnas ALL=(rusnas-containers) NOPASSWD: /usr/bin/podman-compose *
EOF
eval "$SCP /tmp/rusnas-containers-sudoers $VM:/tmp/"
$SSH "sudo cp /tmp/rusnas-containers-sudoers /etc/sudoers.d/rusnas-containers && sudo chmod 440 /etc/sudoers.d/rusnas-containers"

# 12. Fix permissions
$SSH "sudo find /usr/share/cockpit/rusnas -type f -exec chmod 644 {} \;"
$SSH "sudo find /usr/share/cockpit/rusnas -type d -exec chmod 755 {} \;"

echo "=== Container Manager deployed successfully ==="
echo "Navigate to https://10.10.10.72:9090/rusnas/containers to verify"
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x install-containers.sh
git add install-containers.sh
git commit -m "feat: add install-containers.sh deploy script"
```

---

## Task 11: Playwright Tests

**Files:**
- Create: `tests/test_containers_ui.py`

- [ ] **Step 1: Write tests**

```python
"""Test Container Manager UI."""
from playwright.sync_api import sync_playwright
import time, json

URL = "https://10.10.10.72:9090"

def login(page):
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    if page.locator("#login-user-input").count() > 0:
        page.fill("#login-user-input", "rusnas")
        page.fill("#login-password-input", "kl4389qd")
        page.locator("#login-button").click()
        page.wait_for_load_state("networkidle")
        time.sleep(2)

def test_containers_page_loads():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        page.goto(URL + "/rusnas/containers", wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        time.sleep(2)
        page.screenshot(path="/tmp/containers_01_page.png")
        assert page.locator(".advisor-tabs").count() > 0
        browser.close()

def test_catalog_tab_shows_apps():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        page.goto(URL + "/rusnas/containers", wait_until="domcontentloaded")
        time.sleep(3)
        # Catalog should be default tab, apps should load
        cards = page.locator(".app-card")
        page.screenshot(path="/tmp/containers_02_catalog.png")
        assert cards.count() > 0, "No app cards in catalog"
        browser.close()

def test_category_filter_works():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        page.goto(URL + "/rusnas/containers", wait_until="domcontentloaded")
        time.sleep(3)
        cloud_btn = page.locator(".cat-filter-btn[data-cat='cloud']")
        cloud_btn.click()
        time.sleep(0.5)
        page.screenshot(path="/tmp/containers_03_cloud_filter.png")
        assert cloud_btn.get_attribute("class").find("btn-primary") >= 0
        browser.close()

def test_install_modal_opens():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        page.goto(URL + "/rusnas/containers", wait_until="domcontentloaded")
        time.sleep(3)
        # Click install on first app
        install_btn = page.locator(".app-card .btn-primary").first
        if install_btn.count() > 0:
            install_btn.click()
            time.sleep(0.5)
            page.screenshot(path="/tmp/containers_04_install_modal.png")
            assert page.locator("#install-modal").count() > 0
            modal_hidden = "hidden" in (page.locator("#install-modal").get_attribute("class") or "")
            assert not modal_hidden, "Install modal did not open"
        browser.close()

def test_installed_tab_loads():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        page.goto(URL + "/rusnas/containers", wait_until="domcontentloaded")
        time.sleep(2)
        page.locator(".advisor-tab-btn[data-tab='installed']").click()
        time.sleep(2)
        page.screenshot(path="/tmp/containers_05_installed.png")
        # Either empty state or installed list should be present
        assert (page.locator("#installed-empty").count() > 0 or
                page.locator(".installed-app-row").count() > 0)
        browser.close()

def test_custom_tab_shows_mode_cards():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        page.goto(URL + "/rusnas/containers", wait_until="domcontentloaded")
        time.sleep(2)
        page.locator(".advisor-tab-btn[data-tab='custom']").click()
        time.sleep(0.5)
        page.screenshot(path="/tmp/containers_06_custom.png")
        assert page.locator("#mode-simple").count() > 0
        assert page.locator("#mode-compose").count() > 0
        browser.close()

def test_dashboard_has_containers_widget():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        page.goto(URL + "/rusnas/dashboard", wait_until="domcontentloaded")
        time.sleep(4)
        page.screenshot(path="/tmp/containers_07_dashboard_widget.png")
        assert page.locator("#db-containers-card").count() > 0
        browser.close()
```

- [ ] **Step 2: Deploy and run tests**

```bash
# Deploy first
./install-containers.sh

# Run tests
python3 -m pytest tests/test_containers_ui.py -v 2>&1 | tee /tmp/container_test_results.txt
```

Expected: All 7 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/test_containers_ui.py
git commit -m "test: add 7 Playwright tests for Container Manager UI"
```

---

## Final Verification

- [ ] **Check all tests pass**

```bash
python3 -m pytest tests/test_container_api.py tests/test_container_metrics.py -v
```

- [ ] **Check JS syntax**

```bash
node --check cockpit/rusnas/js/containers.js
node --check cockpit/rusnas/js/dashboard.js
```

- [ ] **Verify deploy works end-to-end**

```bash
./install-containers.sh
# Open https://10.10.10.72:9090/rusnas/containers in browser
# Verify: tabs visible, catalog loads 10 apps, category filter works
# Verify: "Приложения" link visible in sidebar
```

- [ ] **Final commit**

```bash
git add -A
git commit -m "feat: container manager v1.0 — complete implementation"
```
