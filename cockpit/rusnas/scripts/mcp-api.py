#!/usr/bin/env python3
# rusNAS MCP API — NAS command dispatcher for AI agent
# /usr/share/cockpit/rusnas/scripts/mcp-api.py
# Called via: cockpit.spawn(['sudo', '-n', 'python3', SCRIPT, cmd, ...args])
# All output as JSON to stdout.

import os, sys, json, subprocess, re, datetime, urllib.request, urllib.error, ssl

LOG_FILE = "/var/log/rusnas/ai-actions.jsonl"
GUARD_LOG = "/var/log/rusnas-guard/events.jsonl"
SNAP_CLI  = "/usr/local/bin/rusnas-snap"

# ── helpers ────────────────────────────────────────────────────────────────────

def ok(data):
    print(json.dumps(data), flush=True)

def err(msg):
    print(json.dumps({"ok": False, "error": msg}), flush=True)

def run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip(), r.returncode
    except subprocess.TimeoutExpired:
        return "", -2
    except Exception as e:
        return str(e), -1

def run_json(cmd, timeout=15):
    out, rc = run(cmd, timeout)
    try:
        return json.loads(out), rc
    except Exception:
        return None, rc

def log_action(command, args):
    """Log dangerous/mutating commands to ai-actions.jsonl."""
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        entry = {
            "ts": datetime.datetime.now().isoformat(timespec="seconds"),
            "command": command,
            "args": args,
            "source": "cockpit"
        }
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass

# ── commands ───────────────────────────────────────────────────────────────────

def cmd_get_status():
    # uptime
    uptime_out, _ = run(["uptime", "-p"])
    # load averages
    with open("/proc/loadavg") as f:
        load_raw = f.read().strip().split()
    load1, load5, load15 = load_raw[0], load_raw[1], load_raw[2]

    # memory
    mem = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                mem[k.strip()] = int(v.strip().split()[0])
    except Exception:
        pass
    mem_total_mb = mem.get("MemTotal", 0) // 1024
    mem_free_mb  = (mem.get("MemAvailable", 0)) // 1024
    mem_used_mb  = mem_total_mb - mem_free_mb

    # disk usage
    df_out, _ = run(["df", "-h", "--output=target,size,used,avail,pcent", "-x", "tmpfs", "-x", "devtmpfs"])
    df_lines = [l for l in df_out.splitlines() if l and not l.startswith("Mounted")]

    # hostname
    hostname, _ = run(["hostname"])

    ok({
        "ok": True,
        "hostname": hostname,
        "uptime": uptime_out,
        "load": {"1m": load1, "5m": load5, "15m": load15},
        "memory": {
            "total_mb": mem_total_mb,
            "used_mb": mem_used_mb,
            "free_mb": mem_free_mb,
            "used_pct": round(mem_used_mb / mem_total_mb * 100, 1) if mem_total_mb else 0
        },
        "filesystems": df_lines
    })

def cmd_list_shares():
    # SMB: testparm -s
    smb_shares = []
    smb_out, rc = run(["testparm", "-s", "--suppress-prompt"], timeout=10)
    if rc == 0 or smb_out:
        current = None
        for line in smb_out.splitlines():
            m = re.match(r'^\[([^\]]+)\]', line)
            if m:
                name = m.group(1)
                if name.lower() not in ("global", "homes", "printers", "print$"):
                    current = {"name": name, "path": "", "comment": "", "type": "smb"}
                    smb_shares.append(current)
                else:
                    current = None
            elif current:
                kv = re.match(r'\s+(\w[\w\s]*?)\s*=\s*(.+)', line)
                if kv:
                    k, v = kv.group(1).strip().lower(), kv.group(2).strip()
                    if k == "path":
                        current["path"] = v
                    elif k == "comment":
                        current["comment"] = v

    # NFS: /etc/exports
    nfs_shares = []
    try:
        with open("/etc/exports") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    parts = line.split()
                    if parts:
                        nfs_shares.append({"path": parts[0], "options": " ".join(parts[1:]), "type": "nfs"})
    except FileNotFoundError:
        pass

    ok({"ok": True, "smb": smb_shares, "nfs": nfs_shares})

def cmd_list_disks():
    # lsblk
    lsblk, _ = run_json(["lsblk", "-J", "-o", "NAME,SIZE,TYPE,MOUNTPOINT,MODEL,VENDOR,ROTA,STATE"])
    # /proc/mdstat
    mdstat, _ = run(["cat", "/proc/mdstat"])

    ok({"ok": True, "lsblk": lsblk, "mdstat": mdstat})

def cmd_list_raid():
    # find all /dev/md* devices
    md_out, _ = run(["ls", "/dev/md*"])
    results = []
    for dev in md_out.split():
        dev = dev.strip()
        if not dev:
            continue
        detail, rc = run(["mdadm", "--detail", dev])
        results.append({"device": dev, "detail": detail, "rc": rc})
    if not results:
        # try to read from /proc/mdstat
        mdstat, _ = run(["cat", "/proc/mdstat"])
        ok({"ok": True, "raids": [], "mdstat": mdstat})
    else:
        ok({"ok": True, "raids": results})

def cmd_list_snapshots(args):
    if not args:
        err("list-snapshots requires subvol argument")
        return
    subvol = args[0]
    out, rc = run([SNAP_CLI, "list", subvol, "--json"])
    if rc != 0:
        err(f"rusnas-snap list failed (rc={rc}): {out}")
        return
    try:
        data = json.loads(out)
        ok({"ok": True, "subvol": subvol, "snapshots": data})
    except Exception:
        err(f"Failed to parse rusnas-snap output: {out}")

def cmd_create_snapshot(args):
    if len(args) < 2:
        err("create-snapshot requires subvol and label arguments")
        return
    subvol, label = args[0], args[1]
    log_action("create-snapshot", args)
    out, rc = run([SNAP_CLI, "create", subvol, "-l", label])
    if rc != 0:
        err(f"rusnas-snap create failed (rc={rc}): {out}")
        return
    try:
        data = json.loads(out)
        ok({"ok": True, "result": data})
    except Exception:
        ok({"ok": True, "result": out})

def cmd_delete_snapshot(args):
    if len(args) < 2:
        err("delete-snapshot requires subvol and snapshot-name arguments")
        return
    subvol, snap_name = args[0], args[1]
    log_action("delete-snapshot", args)
    out, rc = run([SNAP_CLI, "delete", subvol, snap_name])
    if rc != 0:
        err(f"rusnas-snap delete failed (rc={rc}): {out}")
        return
    try:
        data = json.loads(out)
        ok({"ok": True, "result": data})
    except Exception:
        ok({"ok": True, "result": out})

def cmd_list_users():
    users = []
    out, _ = run(["getent", "passwd"])
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) >= 7:
            uid = int(parts[2]) if parts[2].isdigit() else -1
            if 1000 <= uid <= 60000:
                users.append({
                    "name": parts[0],
                    "uid": uid,
                    "gid": parts[3],
                    "home": parts[5],
                    "shell": parts[6]
                })
    ok({"ok": True, "users": users})

def cmd_get_events(args):
    limit = 50
    if args:
        try:
            limit = int(args[0])
        except ValueError:
            pass
    limit = min(limit, 500)

    events = []
    try:
        with open(GUARD_LOG) as f:
            lines = f.readlines()
        for line in lines[-limit:]:
            line = line.strip()
            if line:
                try:
                    events.append(json.loads(line))
                except Exception:
                    pass
    except FileNotFoundError:
        pass

    ok({"ok": True, "events": events, "total": len(events)})

def cmd_run_smart_test(args):
    if not args:
        err("run-smart-test requires device argument")
        return
    device = args[0]
    # sanitize: only allow sda-sdz, nvme0n1-nvme9n9 etc.
    if not re.match(r'^(sd[a-z]+|nvme\d+n\d+|hd[a-z]+)$', device):
        err(f"Invalid device name: {device}")
        return
    log_action("run-smart-test", args)
    dev_path = f"/dev/{device}"
    out, rc = run(["smartctl", "-t", "short", dev_path], timeout=30)
    ok({"ok": True, "device": device, "output": out, "rc": rc})

def cmd_get_smart(args):
    if not args:
        err("get-smart requires device argument")
        return
    device = args[0]
    if not re.match(r'^(sd[a-z]+|nvme\d+n\d+|hd[a-z]+)$', device):
        err(f"Invalid device name: {device}")
        return
    dev_path = f"/dev/{device}"
    out, rc = run(["smartctl", "-a", dev_path], timeout=15)
    ok({"ok": True, "device": device, "output": out, "rc": rc})

def cmd_ai_chat(args):
    """Proxy AI API call from browser → VM (bypasses CORS).
    Reads JSON request from a temp file (argv[0]) or stdin.
    Input JSON: {provider, key, folder, model, system, messages, tools, max_tokens}
    """
    try:
        if args:
            # Primary: read from temp file written by cockpit.file()
            with open(args[0]) as f:
                raw = f.read()
        else:
            # Fallback: stdin
            raw = sys.stdin.read()
        req = json.loads(raw)
    except Exception as e:
        err(f"ai-chat: failed to parse request JSON: {e}")
        return

    provider   = req.get("provider", "yandex")
    messages   = req.get("messages", [])
    tools      = req.get("tools", [])
    max_tokens = req.get("max_tokens", 2048)
    system_txt = req.get("system", "")

    try:
        if provider == "yandex":
            key    = req.get("key", "")
            folder = req.get("folder", "")
            model  = req.get("model", "yandexgpt-5-pro/latest")
            model_uri = f"gpt://{folder}/{model}"

            all_messages = []
            if system_txt:
                all_messages.append({"role": "system", "content": system_txt})
            all_messages.extend(messages)

            payload = {
                "model": model_uri,
                "messages": all_messages,
                "tools": tools,
                "max_tokens": max_tokens
            }
            url     = "https://ai.api.cloud.yandex.net/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json"
            }

        elif provider == "anthropic":
            key      = req.get("key", "")
            model    = req.get("model", "claude-sonnet-4-6")
            an_tools = req.get("anthropic_tools", tools)

            payload = {
                "model": model,
                "max_tokens": max_tokens,
                "system": system_txt,
                "tools": an_tools,
                "messages": messages
            }
            url     = "https://api.anthropic.com/v1/messages"
            headers = {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            }

        else:
            err(f"ai-chat: unknown provider '{provider}'")
            return

        body = json.dumps(payload).encode("utf-8")
        http_req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        ssl_ctx  = ssl.create_default_context()

        with urllib.request.urlopen(http_req, context=ssl_ctx, timeout=60) as resp:
            response_data = resp.read().decode("utf-8")

        ok(json.loads(response_data))

    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        err(f"ai-chat HTTP {e.code}: {body[:400]}")
    except Exception as e:
        err(f"ai-chat error: {e}")

# ── dispatch ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        err("Usage: mcp-api.py <command> [args...]")
        sys.exit(1)

    cmd  = sys.argv[1]
    args = sys.argv[2:]

    dispatch = {
        "get-status":        lambda: cmd_get_status(),
        "list-shares":       lambda: cmd_list_shares(),
        "list-disks":        lambda: cmd_list_disks(),
        "list-raid":         lambda: cmd_list_raid(),
        "list-snapshots":    lambda: cmd_list_snapshots(args),
        "create-snapshot":   lambda: cmd_create_snapshot(args),
        "delete-snapshot":   lambda: cmd_delete_snapshot(args),
        "list-users":        lambda: cmd_list_users(),
        "get-events":        lambda: cmd_get_events(args),
        "run-smart-test":    lambda: cmd_run_smart_test(args),
        "get-smart":         lambda: cmd_get_smart(args),
        "ai-chat":           lambda: cmd_ai_chat(args),
    }

    handler = dispatch.get(cmd)
    if handler is None:
        err(f"Unknown command: {cmd}. Available: {', '.join(dispatch.keys())}")
        sys.exit(1)

    try:
        handler()
    except Exception as e:
        err(f"Internal error in {cmd}: {str(e)}")
        sys.exit(1)
