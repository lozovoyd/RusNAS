#!/usr/bin/env python3
# rusNAS Storage Analyzer — Background Collector
# /usr/share/cockpit/rusnas/scripts/storage-collector.py
# Runs via systemd timer (hourly). Writes SQLite history + JSON cache.

import os, sys, json, time, sqlite3, subprocess, re
from datetime import datetime

DB_PATH    = "/var/lib/rusnas/storage_history.db"
CACHE_PATH = "/var/lib/rusnas/storage_cache.json"
SCAN_FILE  = "/var/lib/rusnas/last_storage_scan"
SMB_CONF   = "/etc/samba/smb.conf"

VIDEO_EXT  = {"mp4","mkv","avi","mov","wmv","ts","m2ts","flv","webm","mpg","mpeg","3gp"}
PHOTO_EXT  = {"jpg","jpeg","png","raw","cr2","nef","heic","tiff","bmp","gif","arw","orf"}
DOC_EXT    = {"pdf","doc","docx","xls","xlsx","odt","ods","ppt","pptx","txt","rtf","odf"}
ARCHIVE_EXT= {"zip","tar","gz","bz2","xz","7z","rar","iso","tgz","tbz"}
BACKUP_EXT = {"img","bak","bkp","backup","dump","sql","vhd","vmdk","qcow2"}
CODE_EXT   = {"py","js","ts","go","rs","java","c","cpp","h","hpp","cs","rb","php","sh"}

def classify_ext(filename):
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in VIDEO_EXT:   return "video"
    if ext in PHOTO_EXT:   return "photo"
    if ext in DOC_EXT:     return "docs"
    if ext in ARCHIVE_EXT: return "archive"
    if ext in BACKUP_EXT:  return "backup"
    if ext in CODE_EXT:    return "code"
    return "other"

def init_db(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS volume_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        volume_path TEXT NOT NULL,
        total_bytes INTEGER NOT NULL,
        used_bytes INTEGER NOT NULL,
        free_bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS share_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        share_name TEXT NOT NULL,
        path TEXT NOT NULL,
        used_bytes INTEGER NOT NULL,
        file_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        username TEXT NOT NULL,
        uid INTEGER NOT NULL,
        used_bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_type_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        volume_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        used_bytes INTEGER NOT NULL,
        file_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_volume_ts ON volume_snapshots(volume_path, ts);
    CREATE INDEX IF NOT EXISTS idx_share_ts  ON share_snapshots(share_name, ts);
    CREATE INDEX IF NOT EXISTS idx_user_ts   ON user_snapshots(username, ts);
    """)
    conn.commit()

def run(cmd, shell=False):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, shell=shell)
        return r.stdout.strip()
    except Exception:
        return ""

def get_volumes():
    """Return list of {path, total, used, free, fs, device}"""
    out = run(["df", "-B1", "--output=source,size,used,avail,fstype,target"])
    volumes = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 6:
            continue
        dev, total, used, avail, fstype, target = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
        if not any(x in target for x in ["/mnt", "/volume", "/data"]):
            continue
        if any(x in target for x in [".snapshots", "/.snap"]):
            continue
        try:
            volumes.append({
                "path": target, "device": dev,
                "total": int(total), "used": int(used), "free": int(avail),
                "fs": fstype
            })
        except ValueError:
            pass
    return volumes

def get_shares():
    """Parse smb.conf and return list of {name, path}"""
    if not os.path.exists(SMB_CONF):
        return []
    shares = []
    current = None
    try:
        with open(SMB_CONF) as f:
            for line in f:
                line = line.split(";")[0].split("#")[0].strip()
                m = re.match(r'^\[(.+)\]$', line)
                if m:
                    if current and current.get("path"):
                        shares.append(current)
                    name = m.group(1)
                    if name.lower() in ("global", "homes", "printers", "print$"):
                        current = None
                    else:
                        current = {"name": name, "path": None}
                elif current and re.match(r'^path\s*=', line, re.I):
                    current["path"] = re.split(r'\s*=\s*', line, maxsplit=1)[1].strip()
        if current and current.get("path"):
            shares.append(current)
    except Exception:
        pass
    return shares

def du_bytes(path):
    """Return total bytes of a directory (apparent size)"""
    if not os.path.exists(path):
        return 0
    out = run(["du", "-sb", "--apparent-size", path])
    try:
        return int(out.split()[0])
    except Exception:
        return 0

def count_files(path):
    """Count files in directory"""
    if not os.path.exists(path):
        return 0
    out = run(f"find {path!r} -type f 2>/dev/null | wc -l", shell=True)
    try:
        return int(out.strip())
    except Exception:
        return 0

def get_users():
    """Return list of {username, uid, home} from /etc/passwd for real users"""
    users = []
    try:
        with open("/etc/passwd") as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) < 7:
                    continue
                username, uid, home, shell = parts[0], int(parts[2]), parts[5], parts[6]
                if uid < 1000 or uid > 60000:
                    continue
                if not os.path.isdir(home):
                    continue
                users.append({"username": username, "uid": uid, "home": home})
    except Exception:
        pass
    return users

def collect_file_types(volume_path):
    """Count bytes per file type in a volume. Fast via find + stat."""
    if not os.path.exists(volume_path):
        return {}
    counts = {}
    cmd = f"find {volume_path!r} -not -path '*/.snapshots/*' -type f -printf '%s %f\n' 2>/dev/null | head -100000"
    out = run(cmd, shell=True)
    for line in out.splitlines():
        parts = line.split(" ", 1)
        if len(parts) < 2:
            continue
        try:
            size = int(parts[0])
            ftype = classify_ext(parts[1])
            if ftype not in counts:
                counts[ftype] = {"bytes": 0, "count": 0}
            counts[ftype]["bytes"] += size
            counts[ftype]["count"] += 1
        except ValueError:
            pass
    return counts

def forecast_days(history_points, free_bytes):
    """Linear regression forecast: days until disk full"""
    if len(history_points) < 2:
        return None
    n = len(history_points)
    t0 = history_points[0][0]
    xs = [(p[0] - t0) / 86400.0 for p in history_points]
    ys = [p[1] for p in history_points]
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    denom = sum((xs[i] - mean_x) ** 2 for i in range(n))
    if denom == 0:
        return None
    k = sum((xs[i] - mean_x) * (ys[i] - mean_y) for i in range(n)) / denom
    if k <= 0:
        return None
    days = free_bytes / k
    return int(round(days))

def main():
    init_db_only = "--init-db" in sys.argv
    os.makedirs("/var/lib/rusnas", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)
    if init_db_only:
        conn.close()
        print("DB initialized")
        return

    ts = int(time.time())
    cache = {"ts": ts, "volumes": [], "shares": [], "users": [], "file_types": {}}

    # 1. Volumes
    volumes = get_volumes()
    cache["volumes"] = volumes
    for v in volumes:
        conn.execute(
            "INSERT INTO volume_snapshots(ts,volume_path,total_bytes,used_bytes,free_bytes) VALUES(?,?,?,?,?)",
            (ts, v["path"], v["total"], v["used"], v["free"])
        )

    # 2. Shares
    shares = get_shares()
    for s in shares:
        used = du_bytes(s["path"])
        fc   = count_files(s["path"])
        s["used_bytes"]  = used
        s["file_count"]  = fc
        cache["shares"].append(s)
        conn.execute(
            "INSERT INTO share_snapshots(ts,share_name,path,used_bytes,file_count) VALUES(?,?,?,?,?)",
            (ts, s["name"], s["path"], used, fc)
        )

    # 3. Users
    users = get_users()
    for u in users:
        used = du_bytes(u["home"])
        u["used_bytes"] = used
        cache["users"].append(u)
        conn.execute(
            "INSERT INTO user_snapshots(ts,username,uid,used_bytes) VALUES(?,?,?,?)",
            (ts, u["username"], u["uid"], used)
        )

    # 4. File types (per volume, first volume only for speed)
    if volumes:
        ftypes = collect_file_types(volumes[0]["path"])
        cache["file_types"] = ftypes
        for ftype, d in ftypes.items():
            conn.execute(
                "INSERT INTO file_type_snapshots(ts,volume_path,file_type,used_bytes,file_count) VALUES(?,?,?,?,?)",
                (ts, volumes[0]["path"], ftype, d["bytes"], d["count"])
            )

    conn.commit()

    # 5. Forecast
    forecasts = {}
    for v in volumes:
        rows = conn.execute(
            "SELECT ts, used_bytes FROM volume_snapshots WHERE volume_path=? ORDER BY ts",
            (v["path"],)
        ).fetchall()
        if rows:
            h24  = [(r[0], r[1]) for r in rows if r[0] >= ts - 86400]
            h7d  = [(r[0], r[1]) for r in rows if r[0] >= ts - 7*86400]
            h30d = [(r[0], r[1]) for r in rows if r[0] >= ts - 30*86400]
            forecasts[v["path"]] = {
                "days_24h": forecast_days(h24,  v["free"]),
                "days_7d":  forecast_days(h7d,  v["free"]),
                "days_30d": forecast_days(h30d, v["free"])
            }
    cache["forecasts"] = forecasts
    cache["scan_duration"] = int(time.time()) - ts

    conn.close()

    # Save cache & timestamp
    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f)
    with open(SCAN_FILE, "w") as f:
        f.write(str(ts))

    print(json.dumps({"status": "ok", "ts": ts, "volumes": len(volumes), "shares": len(shares)}))

if __name__ == "__main__":
    main()
