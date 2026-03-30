#!/usr/bin/env python3
"""rusNAS Storage Analyzer -- API Script.

Called by the Cockpit UI via ``cockpit.spawn()`` with a command name
as the first argument. Supports 7 commands: overview, shares, files,
users, filetypes, scan-status, scan-now. All output is JSON to stdout.

Path: ``/usr/share/cockpit/rusnas/scripts/storage-analyzer-api.py``
"""

import os, sys, json, sqlite3, time, subprocess, re, stat

VIDEO_EXT   = {"mp4","mkv","avi","mov","wmv","ts","m2ts","flv","webm","mpg","mpeg","3gp"}
PHOTO_EXT   = {"jpg","jpeg","png","raw","cr2","nef","heic","tiff","bmp","gif","arw","orf"}
DOC_EXT     = {"pdf","doc","docx","xls","xlsx","odt","ods","ppt","pptx","txt","rtf","odf"}
ARCHIVE_EXT = {"zip","tar","gz","bz2","xz","7z","rar","iso","tgz","tbz"}
BACKUP_EXT  = {"img","bak","bkp","backup","dump","sql","vhd","vmdk","qcow2"}
CODE_EXT    = {"py","js","ts","go","rs","java","c","cpp","h","hpp","cs","rb","php","sh"}

def classify_ext(filename):
    """Classify a filename into a file type category by its extension.

    Args:
        filename: File name (not full path).

    Returns:
        Category string: "video", "photo", "docs", "archive",
        "backup", "code", or "other".
    """
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in VIDEO_EXT:   return "video"
    if ext in PHOTO_EXT:   return "photo"
    if ext in DOC_EXT:     return "docs"
    if ext in ARCHIVE_EXT: return "archive"
    if ext in BACKUP_EXT:  return "backup"
    if ext in CODE_EXT:    return "code"
    return "other"

DB_PATH    = "/var/lib/rusnas/storage_history.db"
CACHE_PATH = "/var/lib/rusnas/storage_cache.json"
SCAN_FILE  = "/var/lib/rusnas/last_storage_scan"
SCAN_PID   = "/var/run/rusnas-storage-scan.pid"
COLLECTOR  = "/usr/share/cockpit/rusnas/scripts/storage-collector.py"

FILE_TYPES = {
    "video":   {"label":"Видео",     "icon":"🎬","color":"#E53935"},
    "photo":   {"label":"Фото",      "icon":"📷","color":"#FB8C00"},
    "docs":    {"label":"Документы", "icon":"📄","color":"#1E88E5"},
    "archive": {"label":"Архивы",    "icon":"📦","color":"#8E24AA"},
    "backup":  {"label":"Бэкапы",    "icon":"💾","color":"#00897B"},
    "code":    {"label":"Код",       "icon":"💻","color":"#43A047"},
    "other":   {"label":"Прочее",    "icon":"❓","color":"#757575"},
}

def ok(data):
    """Print a JSON success response to stdout.

    Args:
        data: Serializable data to output.
    """
    print(json.dumps(data))


def err(msg):
    """Print a JSON error response to stdout.

    Args:
        msg: Error message string.
    """
    print(json.dumps({"error": msg}))

def run(cmd, shell=False):
    """Execute a command and return its stdout.

    Args:
        cmd: Command as a list of strings, or a shell command string.
        shell: If True, execute via the shell.

    Returns:
        Stripped stdout string, or empty string on error/timeout.
    """
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60, shell=shell)
        return r.stdout.strip()
    except Exception:
        return ""

def get_db():
    """Open the SQLite database with Row factory.

    Returns:
        SQLite connection object, or None if the database file is missing
        or cannot be opened.
    """
    if not os.path.exists(DB_PATH):
        return None
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception:
        return None

def load_cache():
    """Load the JSON cache written by the collector.

    Returns:
        Parsed cache dict, or empty dict if missing or corrupt.
    """
    if not os.path.exists(CACHE_PATH):
        return {}
    try:
        with open(CACHE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

def last_scan_ts():
    """Read the timestamp of the last completed scan.

    Returns:
        Unix timestamp (int), or 0 if no scan has been run.
    """
    try:
        with open(SCAN_FILE) as f:
            return int(f.read().strip())
    except Exception:
        return 0

def forecast_days(history_points, free_bytes):
    """Forecast days until disk is full using linear regression.

    Args:
        history_points: List of (timestamp, used_bytes) tuples.
        free_bytes: Current free space in bytes.

    Returns:
        Estimated days until full (int), or None if insufficient data
        or usage is not growing.
    """
    if len(history_points) < 2:
        return None
    n   = len(history_points)
    t0  = history_points[0][0]
    xs  = [(p[0] - t0) / 86400.0 for p in history_points]
    ys  = [p[1] for p in history_points]
    mx  = sum(xs) / n
    my  = sum(ys) / n
    den = sum((x - mx)**2 for x in xs)
    if den == 0:
        return None
    k = sum((xs[i]-mx)*(ys[i]-my) for i in range(n)) / den
    if k <= 0:
        return None
    return int(round(free_bytes / k))

def cmd_overview():
    """Handle the 'overview' command.

    Returns live volume data from ``df``, cached forecasts, top-consuming
    shares, and historical usage data from the database for charting.
    """
    cache = load_cache()
    conn  = get_db()
    ts_now = int(time.time())
    scan_ts = last_scan_ts()

    result = {
        "volumes": [],
        "forecasts": cache.get("forecasts", {}),
        "top_consumers": [],
        "last_scan": scan_ts,
        "scan_age_hours": round((ts_now - scan_ts) / 3600, 1) if scan_ts else None,
        "scan_duration": cache.get("scan_duration", 0),
    }

    # Volumes (always live from df)
    out = run(["df", "-B1", "--output=source,size,used,avail,fstype,target"])
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 6:
            continue
        dev, total, used, avail, fstype, target = parts
        if not any(x in target for x in ["/mnt", "/volume", "/data"]):
            continue
        if any(x in target for x in [".snapshots", "/.snap", "/proc", "/sys"]):
            continue
        try:
            t, u, f = int(total), int(used), int(avail)
            pct = round(u * 100 / t, 1) if t else 0
            fc = cache.get("forecasts", {}).get(target, {})
            result["volumes"].append({
                "path": target, "device": dev, "fs": fstype,
                "total": t, "used": u, "free": f,
                "pct": pct,
                "forecast": fc
            })
        except ValueError:
            pass

    # Shares top consumers
    shares = cache.get("shares", [])
    top = sorted(shares, key=lambda s: s.get("used_bytes", 0), reverse=True)[:5]
    result["top_consumers"] = top

    # History for chart (last 30 points per volume)
    if conn:
        for v in result["volumes"]:
            rows = conn.execute(
                "SELECT ts, used_bytes, free_bytes FROM volume_snapshots WHERE volume_path=? ORDER BY ts DESC LIMIT 30",
                (v["path"],)
            ).fetchall()
            v["history"] = [{"ts": r["ts"], "used": r["used_bytes"], "free": r["free_bytes"]} for r in reversed(rows)]
        conn.close()

    ok(result)

def cmd_shares(period="30"):
    """Handle the 'shares' command.

    Returns share usage data with history and growth rate.

    Args:
        period: Number of days of history to include (default "30").
    """
    cache = load_cache()
    conn  = get_db()
    ts_now = int(time.time())
    try:
        days = int(period)
    except Exception:
        days = 30
    since = ts_now - days * 86400

    # Live share sizes from df / du
    cache_shares = {s["name"]: s for s in cache.get("shares", [])}
    result = {"shares": []}

    for name, s in cache_shares.items():
        entry = {
            "name": name,
            "path": s.get("path", ""),
            "used_bytes": s.get("used_bytes", 0),
            "file_count": s.get("file_count", 0),
            "history": [],
            "growth_per_day": 0,
            "forecast_days": None
        }
        if conn:
            rows = conn.execute(
                "SELECT ts, used_bytes FROM share_snapshots WHERE share_name=? AND ts>=? ORDER BY ts",
                (name, since)
            ).fetchall()
            entry["history"] = [{"ts": r["ts"], "bytes": r["used_bytes"]} for r in rows]

            # Growth rate & forecast
            if len(rows) >= 2:
                oldest, newest = rows[0], rows[-1]
                dt_days = (newest["ts"] - oldest["ts"]) / 86400.0
                if dt_days > 0:
                    gpd = (newest["used_bytes"] - oldest["used_bytes"]) / dt_days
                    entry["growth_per_day"] = int(gpd)
                    # forecast: find free space on the volume
                    # use current used as proxy
                    pass

        result["shares"].append(entry)

    result["shares"].sort(key=lambda x: x["used_bytes"], reverse=True)
    if conn:
        conn.close()
    ok(result)

def cmd_files(path="/", sort="size", ftype="all", older_than="0"):
    """Handle the 'files' command.

    Lists directory contents or recursively searches for files matching
    a type filter. Results are limited to 200 entries.

    Args:
        path: Directory path to browse.
        sort: Sort order -- "size", "mtime", or "name".
        ftype: File type filter -- "all" for flat listing, or a category
            name (e.g., "video") for recursive search.
        older_than: Only include files older than this many days ("0" = no filter).
    """
    # Validate path
    path = os.path.realpath(path)
    if not path.startswith("/") or ".." in path:
        err("Invalid path")
        return
    if not os.path.isdir(path):
        err("Not a directory")
        return

    try:
        older_days = int(older_than)
    except Exception:
        older_days = 0

    ts_now = int(time.time())
    cutoff_mtime = ts_now - older_days * 86400 if older_days > 0 else 0

    entries = []
    try:
        if ftype != "all":
            # Recursive file search when a type filter is active.
            # Walk the entire subtree and collect matching files only.
            for dirpath, dirnames, filenames in os.walk(path):
                # Skip hidden dirs
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                for name in filenames:
                    if name.startswith("."):
                        continue
                    if classify_ext(name) != ftype:
                        continue
                    full = os.path.join(dirpath, name)
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    if older_days > 0 and st.st_mtime > cutoff_mtime:
                        continue
                    # Show relative path from root for clarity
                    rel = os.path.relpath(full, path)
                    entries.append({
                        "name": rel, "type": "file",
                        "bytes": st.st_size,
                        "mtime": int(st.st_mtime)
                    })
        else:
            # Non-recursive: list current directory only
            for name in os.listdir(path):
                if name.startswith("."):
                    continue
                full = os.path.join(path, name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                is_dir = stat.S_ISDIR(st.st_mode)

                if older_days > 0 and st.st_mtime > cutoff_mtime:
                    continue

                if is_dir:
                    out = run(["du", "-sb", "--apparent-size", full])
                    try:
                        sz = int(out.split()[0])
                    except Exception:
                        sz = st.st_size
                    fc_out = run(f"find {full!r} -type f 2>/dev/null | wc -l", shell=True)
                    fc = int(fc_out.strip()) if fc_out.strip().isdigit() else 0
                    entries.append({
                        "name": name, "type": "dir",
                        "bytes": sz, "files": fc,
                        "mtime": int(st.st_mtime)
                    })
                else:
                    entries.append({
                        "name": name, "type": "file",
                        "bytes": st.st_size,
                        "mtime": int(st.st_mtime)
                    })
    except PermissionError:
        err("Permission denied")
        return

    # Sort
    if sort == "size":
        entries.sort(key=lambda x: x["bytes"], reverse=True)
    elif sort == "mtime":
        entries.sort(key=lambda x: x["mtime"])
    elif sort == "name":
        entries.sort(key=lambda x: x["name"])

    ok({"path": path, "entries": entries[:200]})

def cmd_users():
    """Handle the 'users' command.

    Returns per-user disk usage from cache with 7-day history and
    growth rate from the database.
    """
    conn = get_db()
    cache = load_cache()
    ts_now = int(time.time())
    since_7d = ts_now - 7 * 86400

    cache_users = {u["username"]: u for u in cache.get("users", [])}
    result = {"users": []}

    for uname, u in cache_users.items():
        entry = {
            "username": uname,
            "uid": u.get("uid", 0),
            "home": u.get("home", ""),
            "used_bytes": u.get("used_bytes", 0),
            "quota_bytes": None,
            "history": []
        }
        if conn:
            rows = conn.execute(
                "SELECT ts, used_bytes FROM user_snapshots WHERE username=? AND ts>=? ORDER BY ts",
                (uname, since_7d)
            ).fetchall()
            entry["history"] = [{"ts": r["ts"], "bytes": r["used_bytes"]} for r in rows]

            if len(rows) >= 2:
                dt = (rows[-1]["ts"] - rows[0]["ts"]) / 86400.0
                if dt > 0:
                    entry["growth_per_day"] = int((rows[-1]["used_bytes"] - rows[0]["used_bytes"]) / dt)

        result["users"].append(entry)

    result["users"].sort(key=lambda x: x["used_bytes"], reverse=True)
    if conn:
        conn.close()
    ok(result)

def cmd_filetypes():
    """Handle the 'filetypes' command.

    Returns file type breakdown with byte/count totals and 7-day
    change from the database.
    """
    conn = get_db()
    cache = load_cache()
    ts_now = int(time.time())
    since_7d = ts_now - 7 * 86400

    cache_ft = cache.get("file_types", {})
    result = {"breakdown": []}

    for ftype, meta in FILE_TYPES.items():
        d = cache_ft.get(ftype, {"bytes": 0, "count": 0})
        entry = {
            "type": ftype,
            "label": meta["label"],
            "icon": meta["icon"],
            "color": meta["color"],
            "bytes": d.get("bytes", 0),
            "count": d.get("count", 0),
            "change_7d": 0
        }
        # 7d change from DB
        if conn:
            rows = conn.execute(
                "SELECT ts, used_bytes FROM file_type_snapshots WHERE file_type=? AND ts>=? ORDER BY ts",
                (ftype, since_7d)
            ).fetchall()
            if len(rows) >= 2:
                entry["change_7d"] = rows[-1]["used_bytes"] - rows[0]["used_bytes"]
        result["breakdown"].append(entry)

    result["breakdown"].sort(key=lambda x: x["bytes"], reverse=True)
    if conn:
        conn.close()
    ok(result)

def cmd_scan_status():
    """Handle the 'scan-status' command.

    Returns whether a scan is currently running, the last scan timestamp,
    and whether the database and cache files exist.
    """
    ts = last_scan_ts()
    ts_now = int(time.time())
    age = ts_now - ts if ts else None

    # Check if scan is running
    running = False
    if os.path.exists(SCAN_PID):
        try:
            with open(SCAN_PID) as f:
                pid = int(f.read().strip())
            os.kill(pid, 0)
            running = True
        except (ProcessLookupError, ValueError, FileNotFoundError):
            running = False

    ok({
        "status": "running" if running else "idle",
        "last_scan_ts": ts,
        "last_scan_age_seconds": age,
        "db_exists": os.path.exists(DB_PATH),
        "cache_exists": os.path.exists(CACHE_PATH)
    })

def cmd_scan_now():
    """Handle the 'scan-now' command.

    Launches the storage collector as a subprocess and waits up to
    120 seconds for completion. Writes the PID to a file for status
    tracking and cleans up on completion.
    """
    try:
        proc = subprocess.Popen(
            ["python3", COLLECTOR],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        with open(SCAN_PID, "w") as f:
            f.write(str(proc.pid))
        # Wait max 120s
        try:
            stdout, stderr = proc.communicate(timeout=120)
            result = json.loads(stdout.decode()) if stdout else {}
            result["status"] = "done" if proc.returncode == 0 else "error"
            if proc.returncode != 0:
                result["error"] = stderr.decode()[:500]
            ok(result)
        except subprocess.TimeoutExpired:
            proc.kill()
            ok({"status": "timeout"})
    except Exception as e:
        err(str(e))
    finally:
        if os.path.exists(SCAN_PID):
            os.unlink(SCAN_PID)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        err("No command")
        sys.exit(1)

    cmd = sys.argv[1]
    args = sys.argv[2:]

    dispatch = {
        "overview":    lambda: cmd_overview(),
        "shares":      lambda: cmd_shares(args[0] if args else "30"),
        "files":       lambda: cmd_files(
                           args[0] if len(args)>0 else "/",
                           args[1] if len(args)>1 else "size",
                           args[2] if len(args)>2 else "all",
                           args[3] if len(args)>3 else "0"
                       ),
        "users":       lambda: cmd_users(),
        "filetypes":   lambda: cmd_filetypes(),
        "scan-status": lambda: cmd_scan_status(),
        "scan-now":    lambda: cmd_scan_now(),
    }

    if cmd in dispatch:
        dispatch[cmd]()
    else:
        err(f"Unknown command: {cmd}")
