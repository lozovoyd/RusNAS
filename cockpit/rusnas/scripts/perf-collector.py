#!/usr/bin/env python3
"""rusNAS Performance Collector Daemon.
Runs as a systemd service, collects CPU/RAM/Net/Disk metrics every 10s,
writes to /var/lib/rusnas/perf-history.json every 2 min.
Keeps 24h of data with automatic downsampling.

Resources: ~3 MB RAM, <0.5% CPU, 1 file write per 2 min.
"""

import json, time, os, sys, signal

PERF_FILE = "/var/lib/rusnas/perf-history.json"
COLLECT_SEC = 10     # collect every 10s
SAVE_SEC = 120       # write to disk every 2 min
MAX_AGE_S = 86400    # keep 24h
KEYS = ["cpu", "ram", "netR", "netT", "iopsR", "iopsW", "thrR", "thrW"]

# ── State ──
prev_cpu = {}
prev_net = {}
prev_disk = {}
prev_proc = {}
data = {"ts": [], "procs": []}
for k in KEYS:
    data[k] = []
last_save = 0
running = True

def sigterm(sig, frame):
    global running
    running = False

signal.signal(signal.SIGTERM, sigterm)
signal.signal(signal.SIGINT, sigterm)

# ── Collectors ──

def collect_cpu():
    """Returns (cpu_pct, total_jiffies_delta)."""
    global prev_cpu
    with open("/proc/stat") as f:
        fields = list(map(int, f.readline().split()[1:]))
    idle = fields[3] + fields[4]
    total = sum(fields)
    pct = 0
    dt = 0
    if prev_cpu:
        dt = total - prev_cpu["t"]
        di = idle - prev_cpu["i"]
        pct = round((1 - di / dt) * 100) if dt > 0 else 0
    prev_cpu = {"t": total, "i": idle}
    return max(0, min(100, pct)), dt

def collect_ram():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            p = line.split()
            if len(p) >= 2:
                info[p[0].rstrip(":")] = int(p[1])
    total = info.get("MemTotal", 1)
    avail = info.get("MemAvailable", total)
    return round((total - avail) * 100 / total) if total > 0 else 0

def collect_net():
    global prev_net
    now = time.time()
    best = None
    with open("/proc/net/dev") as f:
        for line in f:
            if ":" not in line:
                continue
            p = line.split()
            iface = p[0].rstrip(":")
            if iface == "lo":
                continue
            rx, tx = int(p[1]), int(p[9])
            if best is None or rx + tx > best[1] + best[2]:
                best = (iface, rx, tx)
    if not best:
        return 0.0, 0.0
    rx_s = tx_s = 0.0
    if prev_net:
        dt = now - prev_net.get("t", now)
        if dt > 0:
            rx_s = max(0, (best[1] - prev_net["r"]) / dt)
            tx_s = max(0, (best[2] - prev_net["x"]) / dt)
    prev_net = {"r": best[1], "x": best[2], "t": now}
    return round(rx_s, 1), round(tx_s, 1)

def collect_disk():
    global prev_disk
    now = time.time()
    ir = iw = tr = tw = 0
    with open("/proc/diskstats") as f:
        for line in f:
            fields = line.split()
            if len(fields) < 14:
                continue
            dev = fields[2]
            if not (dev.startswith("sd") and len(dev) == 3):
                continue
            ri, rs, wi, ws = int(fields[3]), int(fields[5]), int(fields[7]), int(fields[9])
            if dev in prev_disk:
                dt = now - prev_disk[dev]["t"]
                if dt > 0:
                    ir += max(0, (ri - prev_disk[dev]["ri"]) / dt)
                    iw += max(0, (wi - prev_disk[dev]["wi"]) / dt)
                    tr += max(0, (rs - prev_disk[dev]["rs"]) * 512 / dt)
                    tw += max(0, (ws - prev_disk[dev]["ws"]) * 512 / dt)
            prev_disk[dev] = {"ri": ri, "wi": wi, "rs": rs, "ws": ws, "t": now}
    return round(ir, 1), round(iw, 1), round(tr, 1), round(tw, 1)

def collect_top_procs(cpu_dt):
    """Return top-5 CPU-consuming processes as [{"n": name, "c": cpu%}, ...]."""
    global prev_proc
    if cpu_dt <= 0:
        # First iteration or no CPU activity — just prime state
        cur = {}
        try:
            for entry in os.listdir("/proc"):
                if not entry.isdigit():
                    continue
                try:
                    with open("/proc/" + entry + "/stat") as f:
                        raw = f.read()
                    # comm is in parens and may contain spaces/parens
                    ci = raw.index("(")
                    ce = raw.rindex(")")
                    rest = raw[ce + 2:].split()
                    utime = int(rest[11])  # field 14 (0-indexed from after comm)
                    stime = int(rest[12])  # field 15
                    cur[int(entry)] = utime + stime
                except Exception:
                    pass
        except Exception:
            pass
        prev_proc = cur
        return []

    cur = {}
    names = {}
    try:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open("/proc/" + entry + "/stat") as f:
                    raw = f.read()
                ci = raw.index("(")
                ce = raw.rindex(")")
                comm = raw[ci + 1:ce]
                rest = raw[ce + 2:].split()
                utime = int(rest[11])
                stime = int(rest[12])
                pid = int(entry)
                cur[pid] = utime + stime
                names[pid] = comm[:15]
            except Exception:
                pass
    except Exception:
        prev_proc = {}
        return []

    # Compute per-process CPU% delta
    top = []
    for pid, ticks in cur.items():
        if pid in prev_proc:
            delta = ticks - prev_proc[pid]
            if delta > 0:
                pct = round(delta / cpu_dt * 100, 1)
                if pct >= 0.1:
                    top.append({"n": names[pid], "c": pct})

    prev_proc = cur
    top.sort(key=lambda x: x["c"], reverse=True)
    return top[:5]

# ── Downsampling ──

def downsample():
    global data
    ts = data["ts"]
    if len(ts) < 100:
        return
    now_ms = int(time.time() * 1000)
    # Remove > 24h
    cutoff = now_ms - MAX_AGE_S * 1000
    start = 0
    for i, t in enumerate(ts):
        if t >= cutoff:
            start = i
            break
    if start > 0:
        data["ts"] = ts[start:]
        for k in KEYS:
            data[k] = data[k][start:]
        data["procs"] = data["procs"][start:]
    # Downsample: >2h → 120s buckets, 15m-2h → 30s buckets
    _ds_range(now_ms - 7200000, now_ms - 900000, 30000)   # 15m..2h: 30s
    _ds_range(now_ms - MAX_AGE_S * 1000, now_ms - 7200000, 120000)  # 2h..24h: 120s

def _ds_range(from_ms, to_ms, bucket_ms):
    global data
    ts = data["ts"]
    if not ts:
        return
    # Find boundaries
    hi = 0
    while hi < len(ts) and ts[hi] < from_ms:
        hi += 1
    mi = hi
    while mi < len(ts) and ts[mi] < to_ms:
        mi += 1
    if mi - hi <= 1:
        return
    # Bucket
    new_ts = []
    new_v = {k: [] for k in KEYS}
    new_procs = []
    procs = data.get("procs", [])
    i = hi
    while i < mi:
        be = ts[i] + bucket_ms
        cnt, st = 0, 0
        sums = {k: 0 for k in KEYS}
        max_cpu_val = -1
        max_cpu_procs = []
        while i < mi and ts[i] < be:
            st += ts[i]
            for k in KEYS:
                sums[k] += data[k][i] if i < len(data[k]) else 0
            # Keep procs from peak CPU sample in this bucket
            cpu_val = data["cpu"][i] if i < len(data["cpu"]) else 0
            if cpu_val > max_cpu_val:
                max_cpu_val = cpu_val
                max_cpu_procs = procs[i] if i < len(procs) else []
            cnt += 1
            i += 1
        if cnt:
            new_ts.append(int(st / cnt))
            for k in KEYS:
                new_v[k].append(round(sums[k] / cnt, 2))
            new_procs.append(max_cpu_procs)
    # Reassemble
    data["ts"] = ts[:hi] + new_ts + ts[mi:]
    for k in KEYS:
        v = data[k]
        data[k] = v[:hi] + new_v[k] + v[mi:]
    data["procs"] = procs[:hi] + new_procs + procs[mi:]

# ── Persistence ──

def load_data():
    global data
    try:
        with open(PERF_FILE) as f:
            d = json.load(f)
        if isinstance(d.get("ts"), list) and len(d["ts"]) > 0:
            data["ts"] = d["ts"]
            for k in KEYS:
                data[k] = d.get(k, [])
            data["procs"] = d.get("procs", [])
            # Validate lengths
            ml = min(len(data["ts"]), *(len(data[k]) for k in KEYS))
            if ml < len(data["ts"]):
                data["ts"] = data["ts"][-ml:]
                for k in KEYS:
                    data[k] = data[k][-ml:]
            # Pad procs to match ts length (backward compat)
            while len(data["procs"]) < len(data["ts"]):
                data["procs"].insert(0, [])
            data["procs"] = data["procs"][-len(data["ts"]):]
    except:
        pass

def save_data():
    global last_save
    last_save = time.time()
    tmp = PERF_FILE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(data, f, separators=(",", ":"))
        os.replace(tmp, PERF_FILE)  # atomic rename
    except Exception as e:
        print(f"Save error: {e}", file=sys.stderr)

# ── Main loop ──

def main():
    global last_save
    print("rusNAS perf-collector starting", file=sys.stderr)
    load_data()
    last_save = time.time()
    tick = 0

    # First collect to prime deltas (skip recording)
    collect_cpu()
    collect_ram()
    collect_net()
    collect_disk()
    collect_top_procs(0)
    time.sleep(COLLECT_SEC)

    while running:
        try:
            cpu, cpu_dt = collect_cpu()
            ram = collect_ram()
            nr, nt = collect_net()
            ir, iw, tr, tw = collect_disk()
            procs = collect_top_procs(cpu_dt)

            now_ms = int(time.time() * 1000)
            data["ts"].append(now_ms)
            data["cpu"].append(cpu)
            data["ram"].append(ram)
            data["netR"].append(nr)
            data["netT"].append(nt)
            data["iopsR"].append(ir)
            data["iopsW"].append(iw)
            data["thrR"].append(tr)
            data["thrW"].append(tw)
            data["procs"].append(procs)

            tick += 1
            # Save every SAVE_SEC
            if time.time() - last_save >= SAVE_SEC:
                if tick % 60 == 0:
                    downsample()
                save_data()

        except Exception as e:
            print(f"Collect error: {e}", file=sys.stderr)

        time.sleep(COLLECT_SEC)

    # Save on exit
    save_data()
    print("rusNAS perf-collector stopped", file=sys.stderr)

if __name__ == "__main__":
    main()
