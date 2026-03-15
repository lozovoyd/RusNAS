#!/usr/bin/env python3
"""
rusNAS Metrics Server
Port 9100, two endpoints:
  /metrics       — Prometheus text format
  /metrics.json  — JSON format
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import subprocess, json, time, re, os

PORT = 9100

# Delta state for rate calculations
_prev_cpu = None
_prev_cpu_time = None
_prev_net = {}
_prev_net_time = None
_prev_disk = {}
_prev_disk_time = None


def read_file(path):
    try:
        with open(path) as f:
            return f.read()
    except Exception:
        return ""


def run_cmd(args, timeout=5):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return r.stdout
    except Exception:
        return ""


def collect_cpu():
    global _prev_cpu, _prev_cpu_time
    raw = read_file("/proc/stat")
    line = next((l for l in raw.splitlines() if l.startswith("cpu ")), "")
    parts = line.split()
    if len(parts) < 5:
        return {"usage_percent": 0.0, "load_avg": [0, 0, 0], "temp_celsius": None}

    vals = list(map(int, parts[1:]))
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
    total = sum(vals)
    now = time.time()

    pct = 0.0
    if _prev_cpu is not None:
        d_total = total - _prev_cpu[0]
        d_idle = idle - _prev_cpu[1]
        if d_total > 0:
            pct = round(100.0 * (d_total - d_idle) / d_total, 1)

    _prev_cpu = (total, idle)
    _prev_cpu_time = now

    # Load average
    loadraw = read_file("/proc/loadavg").split()
    load = [float(loadraw[i]) if len(loadraw) > i else 0.0 for i in range(3)]

    # CPU temperature
    temp = None
    for tz_dir in sorted(os.listdir("/sys/class/thermal")) if os.path.exists("/sys/class/thermal") else []:
        tz_path = f"/sys/class/thermal/{tz_dir}"
        ttype = read_file(f"{tz_path}/type").strip()
        if "x86_pkg_temp" in ttype or "acpitz" in ttype or tz_dir == "thermal_zone0":
            raw_temp = read_file(f"{tz_path}/temp").strip()
            if raw_temp.isdigit():
                temp = round(int(raw_temp) / 1000.0, 1)
                break

    return {"usage_percent": pct, "load_avg": load, "temp_celsius": temp}


def collect_memory():
    raw = read_file("/proc/meminfo")
    info = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            info[parts[0].rstrip(":")] = int(parts[1]) * 1024
    total = info.get("MemTotal", 0)
    free = info.get("MemFree", 0)
    buffers = info.get("Buffers", 0)
    cached = info.get("Cached", 0)
    sreclaimable = info.get("SReclaimable", 0)
    available = info.get("MemAvailable", free + buffers + cached)
    used = total - available
    return {
        "total_bytes": total,
        "used_bytes": used,
        "available_bytes": available,
        "swap_total_bytes": info.get("SwapTotal", 0),
        "swap_used_bytes": info.get("SwapTotal", 0) - info.get("SwapFree", 0),
    }


def collect_network():
    global _prev_net, _prev_net_time
    raw = read_file("/proc/net/dev")
    now = time.time()
    result = {}
    current = {}

    for line in raw.splitlines()[2:]:
        parts = line.split()
        if len(parts) < 10:
            continue
        iface = parts[0].rstrip(":")
        if iface in ("lo",):
            continue
        rx = int(parts[1])
        tx = int(parts[9])
        current[iface] = (rx, tx)

        rx_rate = 0
        tx_rate = 0
        if iface in _prev_net and _prev_net_time:
            dt = now - _prev_net_time
            if dt > 0:
                rx_rate = max(0, int((rx - _prev_net[iface][0]) / dt))
                tx_rate = max(0, int((tx - _prev_net[iface][1]) / dt))

        # Speed / link
        speed = None
        speed_path = f"/sys/class/net/{iface}/speed"
        if os.path.exists(speed_path):
            sp = read_file(speed_path).strip()
            if sp.lstrip("-").isdigit() and int(sp) > 0:
                speed = int(sp)
        link = os.path.exists(f"/sys/class/net/{iface}/carrier") and \
               read_file(f"/sys/class/net/{iface}/carrier").strip() == "1"

        result[iface] = {
            "rx_bytes_per_sec": rx_rate,
            "tx_bytes_per_sec": tx_rate,
            "speed_mbps": speed,
            "link": link,
        }

    _prev_net = current
    _prev_net_time = now
    return result


def collect_disk_io():
    global _prev_disk, _prev_disk_time
    raw = read_file("/proc/diskstats")
    now = time.time()
    result = {}
    current = {}

    for line in raw.splitlines():
        parts = line.split()
        if len(parts) < 14:
            continue
        name = parts[2]
        # Only physical disks (sda, sdb, nvme0n1, etc.), skip partitions
        if re.match(r'^(sd[a-z]|nvme\d+n\d+|hd[a-z]|vd[a-z])$', name):
            sectors_read = int(parts[5])
            sectors_written = int(parts[9])
            current[name] = (sectors_read, sectors_written)

            r_rate = 0
            w_rate = 0
            if name in _prev_disk and _prev_disk_time:
                dt = now - _prev_disk_time
                if dt > 0:
                    r_rate = max(0, int((sectors_read - _prev_disk[name][0]) * 512 / dt))
                    w_rate = max(0, int((sectors_written - _prev_disk[name][1]) * 512 / dt))

            result[name] = {"read_bytes_per_sec": r_rate, "write_bytes_per_sec": w_rate}

    _prev_disk = current
    _prev_disk_time = now
    return result


def collect_smart():
    result = {}
    # Find physical disks
    raw = run_cmd(["lsblk", "-dno", "NAME,TYPE"])
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "disk":
            dev = parts[0]
            out = run_cmd(["smartctl", "-H", f"/dev/{dev}"], timeout=10)
            health = "UNKNOWN"
            for line2 in out.splitlines():
                if "SMART overall-health" in line2 or "result:" in line2.lower():
                    health = "PASSED" if "PASSED" in line2 else "FAILED"
                    break
            # Model + serial
            info_out = run_cmd(["smartctl", "-i", f"/dev/{dev}"], timeout=10)
            model = ""
            serial = ""
            for line3 in info_out.splitlines():
                if line3.startswith("Device Model") or line3.startswith("Model Number"):
                    model = line3.split(":", 1)[-1].strip()
                elif line3.startswith("Serial Number"):
                    serial = line3.split(":", 1)[-1].strip()
            result[dev] = {"smart_health": health, "model": model, "serial": serial}
    return result


def collect_raid():
    raw = read_file("/proc/mdstat")
    result = {}
    lines = raw.splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r'^(md\d+)\s*:\s*(\w+)\s+(\w+)', lines[i])
        if m:
            name = m.group(1)
            activity = m.group(2)  # active/inactive
            level_raw = m.group(3)

            # Parse active/total devices from line like "[4/4] [UUUU]" or "[3/4] [UUU_]"
            active = 0
            total = 0
            dm = re.search(r'\[(\d+)/(\d+)\]', lines[i])
            if dm:
                total = int(dm.group(1))
                active = int(dm.group(2))
            # Also look in next lines
            if i + 1 < len(lines):
                dm2 = re.search(r'\[(\d+)/(\d+)\]', lines[i + 1])
                if dm2:
                    total = int(dm2.group(1))
                    active = int(dm2.group(2))

            # Determine status
            if activity == "inactive":
                status = "inactive"
            elif active < total:
                status = "degraded"
            else:
                status = "active"

            # Check resync/reshape
            sync_pct = None
            if i + 1 < len(lines):
                sm = re.search(r'=\s*([\d.]+)%', lines[i + 1])
                if sm:
                    sync_pct = float(sm.group(1))
                    status = "resyncing"

            # Normalize level name
            level_map = {"raid0": "raid0", "raid1": "raid1", "raid5": "raid5",
                         "raid6": "raid6", "raid10": "raid10", "linear": "jbod"}
            level = level_map.get(level_raw, level_raw)

            result[name] = {
                "level": level,
                "status": status,
                "devices_active": active,
                "devices_total": total,
                "sync_percent": sync_pct,
            }
        i += 1
    return result


def collect_volumes():
    raw = run_cmd(["df", "-k", "--output=source,target,fstype,size,used,avail"])
    result = {}
    for line in raw.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 6:
            continue
        source, target, fstype = parts[0], parts[1], parts[2]
        if fstype not in ("btrfs", "ext4", "xfs", "zfs"):
            continue
        if not target.startswith("/mnt"):
            continue
        total = int(parts[3]) * 1024
        used = int(parts[4]) * 1024
        free = int(parts[5]) * 1024
        result[target] = {
            "fstype": fstype,
            "total_bytes": total,
            "used_bytes": used,
            "free_bytes": free,
        }
    return result


def collect_services():
    svcs = ["smbd", "nfs-server", "vsftpd", "tgt"]
    result = {}
    for svc in svcs:
        out = run_cmd(["systemctl", "is-active", svc], timeout=3).strip()
        result[svc] = out if out else "unknown"
    return result


def collect_guard():
    state_path = "/run/rusnas-guard/state.json"
    if not os.path.exists(state_path):
        return {"installed": False}
    try:
        with open(state_path) as f:
            data = json.load(f)
        data["installed"] = True
        return data
    except Exception:
        return {"installed": True, "error": "parse_error"}


def collect_metrics():
    hostname = read_file("/proc/sys/kernel/hostname").strip()
    io = collect_disk_io()
    smart = collect_smart()

    # Merge smart into disk io dict
    disks = {}
    all_devs = set(list(io.keys()) + list(smart.keys()))
    for dev in all_devs:
        entry = {}
        entry.update(smart.get(dev, {"smart_health": "UNKNOWN", "model": "", "serial": ""}))
        entry.update(io.get(dev, {"read_bytes_per_sec": 0, "write_bytes_per_sec": 0}))
        disks[dev] = entry

    return {
        "timestamp": int(time.time()),
        "hostname": hostname,
        "cpu": collect_cpu(),
        "memory": collect_memory(),
        "network": collect_network(),
        "disks": disks,
        "raid": collect_raid(),
        "volumes": collect_volumes(),
        "services": collect_services(),
        "guard": collect_guard(),
    }


def format_prometheus(data):
    lines = []

    def g(help_str, name, val, labels=""):
        if val is None:
            return
        label_str = f"{{{labels}}}" if labels else ""
        lines.append(f"# HELP {name} {help_str}")
        lines.append(f"# TYPE {name} gauge")
        lines.append(f"{name}{label_str} {val}")

    cpu = data.get("cpu", {})
    g("CPU usage percent", "rusnas_cpu_usage_percent", cpu.get("usage_percent"))
    load = cpu.get("load_avg", [])
    if load:
        g("CPU load average 1m", "rusnas_cpu_load1", load[0] if len(load) > 0 else None)
        g("CPU load average 5m", "rusnas_cpu_load5", load[1] if len(load) > 1 else None)
        g("CPU load average 15m", "rusnas_cpu_load15", load[2] if len(load) > 2 else None)
    g("CPU temperature celsius", "rusnas_cpu_temp_celsius", cpu.get("temp_celsius"))

    mem = data.get("memory", {})
    g("Memory total bytes", "rusnas_memory_total_bytes", mem.get("total_bytes"))
    g("Memory used bytes", "rusnas_memory_used_bytes", mem.get("used_bytes"))
    g("Memory available bytes", "rusnas_memory_available_bytes", mem.get("available_bytes"))
    g("Swap total bytes", "rusnas_swap_total_bytes", mem.get("swap_total_bytes"))
    g("Swap used bytes", "rusnas_swap_used_bytes", mem.get("swap_used_bytes"))

    for iface, net in data.get("network", {}).items():
        lbl = f'iface="{iface}"'
        lines.append(f'# HELP rusnas_network_rx_bytes_per_sec Network RX bytes/sec')
        lines.append(f'# TYPE rusnas_network_rx_bytes_per_sec gauge')
        lines.append(f'rusnas_network_rx_bytes_per_sec{{{lbl}}} {net.get("rx_bytes_per_sec", 0)}')
        lines.append(f'# HELP rusnas_network_tx_bytes_per_sec Network TX bytes/sec')
        lines.append(f'# TYPE rusnas_network_tx_bytes_per_sec gauge')
        lines.append(f'rusnas_network_tx_bytes_per_sec{{{lbl}}} {net.get("tx_bytes_per_sec", 0)}')

    for dev, disk in data.get("disks", {}).items():
        lbl = f'device="{dev}"'
        lines.append(f'# HELP rusnas_disk_read_bytes_per_sec Disk read bytes/sec')
        lines.append(f'# TYPE rusnas_disk_read_bytes_per_sec gauge')
        lines.append(f'rusnas_disk_read_bytes_per_sec{{{lbl}}} {disk.get("read_bytes_per_sec", 0)}')
        lines.append(f'# HELP rusnas_disk_write_bytes_per_sec Disk write bytes/sec')
        lines.append(f'# TYPE rusnas_disk_write_bytes_per_sec gauge')
        lines.append(f'rusnas_disk_write_bytes_per_sec{{{lbl}}} {disk.get("write_bytes_per_sec", 0)}')
        health = 1 if disk.get("smart_health") == "PASSED" else 0
        lines.append(f'# HELP rusnas_disk_smart_healthy SMART health: 1=PASSED 0=FAILED/UNKNOWN')
        lines.append(f'# TYPE rusnas_disk_smart_healthy gauge')
        lines.append(f'rusnas_disk_smart_healthy{{{lbl}}} {health}')

    for name, raid in data.get("raid", {}).items():
        lbl = f'name="{name}"'
        status_val = {"active": 1, "resyncing": 1, "degraded": 0, "inactive": 0}.get(raid.get("status", ""), 0)
        lines.append(f'# HELP rusnas_raid_healthy RAID array healthy: 1=active 0=degraded/inactive')
        lines.append(f'# TYPE rusnas_raid_healthy gauge')
        lines.append(f'rusnas_raid_healthy{{{lbl}}} {status_val}')
        lines.append(f'# HELP rusnas_raid_devices_active Active RAID devices')
        lines.append(f'# TYPE rusnas_raid_devices_active gauge')
        lines.append(f'rusnas_raid_devices_active{{{lbl}}} {raid.get("devices_active", 0)}')
        lines.append(f'# HELP rusnas_raid_devices_total Total RAID devices')
        lines.append(f'# TYPE rusnas_raid_devices_total gauge')
        lines.append(f'rusnas_raid_devices_total{{{lbl}}} {raid.get("devices_total", 0)}')
        sp = raid.get("sync_percent")
        if sp is not None:
            lines.append(f'# HELP rusnas_raid_sync_percent RAID sync progress percent')
            lines.append(f'# TYPE rusnas_raid_sync_percent gauge')
            lines.append(f'rusnas_raid_sync_percent{{{lbl}}} {sp}')

    for target, vol in data.get("volumes", {}).items():
        lbl = f'mount="{target}"'
        lines.append(f'# HELP rusnas_volume_total_bytes Volume total bytes')
        lines.append(f'# TYPE rusnas_volume_total_bytes gauge')
        lines.append(f'rusnas_volume_total_bytes{{{lbl}}} {vol.get("total_bytes", 0)}')
        lines.append(f'# HELP rusnas_volume_used_bytes Volume used bytes')
        lines.append(f'# TYPE rusnas_volume_used_bytes gauge')
        lines.append(f'rusnas_volume_used_bytes{{{lbl}}} {vol.get("used_bytes", 0)}')
        lines.append(f'# HELP rusnas_volume_free_bytes Volume free bytes')
        lines.append(f'# TYPE rusnas_volume_free_bytes gauge')
        lines.append(f'rusnas_volume_free_bytes{{{lbl}}} {vol.get("free_bytes", 0)}')

    for svc, status in data.get("services", {}).items():
        lbl = f'service="{svc}"'
        val = 1 if status == "active" else 0
        lines.append(f'# HELP rusnas_service_active Service active: 1=active 0=other')
        lines.append(f'# TYPE rusnas_service_active gauge')
        lines.append(f'rusnas_service_active{{{lbl}}} {val}')

    guard = data.get("guard", {})
    g("Guard daemon running status: 1=running, 0=stopped",
      "rusnas_guard_running", 1 if guard.get("running") else 0)
    g("Guard threats detected in last 24h",
      "rusnas_guard_threats_24h", guard.get("threats_24h", 0))
    g("Guard post-attack mode active",
      "rusnas_guard_post_attack", 1 if guard.get("post_attack") else 0)

    return "\n".join(lines) + "\n"


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/metrics", "/metrics/"):
            data = collect_metrics()
            body = format_prometheus(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        elif self.path in ("/metrics.json", "/metrics.json/"):
            data = collect_metrics()
            body = json.dumps(data, indent=2).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/":
            body = b'rusNAS Metrics Server\n/metrics - Prometheus format\n/metrics.json - JSON format\n'
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress default access log


if __name__ == "__main__":
    # Warm up delta state with initial read
    collect_cpu()
    collect_network()
    collect_disk_io()
    time.sleep(1)

    print(f"rusNAS Metrics Server listening on port {PORT}", flush=True)
    server = HTTPServer(("0.0.0.0", PORT), MetricsHandler)
    server.serve_forever()
