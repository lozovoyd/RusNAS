#!/usr/bin/env python3
"""
spindown_ctl.py — CGI for RAID Backup Mode control.
Usage: python3 spindown_ctl.py <command> [--array mdX] [--enabled true] [--timeout 30]
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import time

CONFIG_FILE = "/etc/rusnas/spindown.json"
STATE_FILE  = "/run/rusnas/spindown_state.json"
PID_FILE    = "/run/rusnas/spind.pid"


def out(data):
    print(json.dumps(data, ensure_ascii=False))


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        return {"ok": False, "error": str(e)}


def atomic_write(path, data):
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def cmd_get_state(args):
    if not os.path.exists(STATE_FILE):
        out({"ok": False, "error": "Демон rusnas-spind не запущен"})
        return
    data = read_json(STATE_FILE)
    print(json.dumps(data, ensure_ascii=False))


def cmd_get_config(args):
    data = read_json(CONFIG_FILE, default={"version": 1, "arrays": {}})
    print(json.dumps(data, ensure_ascii=False))


def cmd_set_backup_mode(args):
    array = args.array
    enabled = args.enabled.lower() == "true"
    timeout = int(args.timeout)

    if timeout < 5 or timeout > 480:
        out({"ok": False, "error": f"timeout должен быть от 5 до 480, получено {timeout}"})
        return

    # Check disk types
    member_disks = _get_member_disks(array)
    disk_types = {}
    for d in member_disks:
        rot_path = f"/sys/block/{d}/queue/rotational"
        try:
            rot = open(rot_path).read().strip()
            disk_types[d] = "hdd" if rot == "1" else "ssd"
        except Exception:
            disk_types[d] = "unknown"

    all_hdd = all(t == "hdd" for t in disk_types.values()) if disk_types else True
    warning = None if all_hdd else (
        f"Массив {array} содержит SSD диски. "
        "Backup Mode предназначен для HDD — spindown не будет иметь эффекта на SSD."
    )

    # Update config
    config = read_json(CONFIG_FILE, default={"version": 1, "arrays": {}})
    if not isinstance(config, dict):
        config = {"version": 1, "arrays": {}}
    config.setdefault("arrays", {})[array] = {
        "backup_mode": enabled,
        "idle_timeout_minutes": timeout,
        "pre_sleep_flush": True,
        "extend_btrfs_commit": True,
        "enabled": True,
    }
    atomic_write(CONFIG_FILE, config)

    # SIGHUP daemon if running
    _sighup_daemon()

    out({"ok": True, "disk_types": disk_types, "all_hdd": all_hdd, "warning": warning})


def cmd_wakeup_now(args):
    array = args.array
    # Try state file first, fallback to mdadm
    state = read_json(STATE_FILE, default={})
    member_disks = []
    if isinstance(state, dict):
        arr_state = state.get("arrays", {}).get(array, {})
        member_disks = arr_state.get("member_disks", [])
    if not member_disks:
        member_disks = _get_member_disks(array)
    if not member_disks:
        out({"ok": False, "error": f"Не удалось определить диски массива {array}"})
        return
    for disk in member_disks:
        try:
            subprocess.run(["dd", f"if=/dev/{disk}", "of=/dev/null",
                            "bs=512", "count=1"],
                           capture_output=True, timeout=30)
        except Exception:
            pass
    out({"ok": True, "disks": member_disks})


def cmd_spindown_now(args):
    array = args.array
    # Guard: degraded?
    deg_path = f"/sys/block/{array}/md/degraded"
    try:
        if int(open(deg_path).read().strip()) > 0:
            out({"ok": False, "error": f"Нельзя усыпить деградированный массив {array}"})
            return
    except Exception:
        pass
    # Guard: syncing?
    sync_path = f"/sys/block/{array}/md/sync_action"
    try:
        action = open(sync_path).read().strip()
        if action not in ("idle", ""):
            out({"ok": False, "error": f"Массив {array} выполняет {action}, spindown невозможен"})
            return
    except Exception:
        pass
    member_disks = _get_member_disks(array)
    # Step 1: flush btrfs (includes 3s post-sync settle from spec)
    mp = _get_mountpoint(array)
    _flush_array(array, mp)
    time.sleep(3)  # post-sync settle (mirrors btrfs_helper.flush)
    # Step 2: extend Btrfs commit interval
    if mp:
        try:
            subprocess.run(["mount", "-o", "remount,commit=3600", mp],
                           capture_output=True, timeout=30)
        except Exception:
            pass
    # Step 3: suppress mdadm check + freeze sync_min
    _write_sysfs(f"/sys/block/{array}/md/sync_action", "idle")
    _write_sysfs(f"/sys/block/{array}/md/sync_min", "0")
    # Step 4: spindown all disks
    for disk in member_disks:
        try:
            subprocess.run(["hdparm", "-y", f"/dev/{disk}"],
                           capture_output=True, timeout=15)
        except Exception:
            pass
    time.sleep(5)  # post-hdparm settle (mirrors do_spindown in daemon)
    out({"ok": True, "disks": member_disks})


def _get_member_disks(array):
    try:
        r = subprocess.run(["mdadm", "--detail", f"/dev/{array}"],
                           capture_output=True, text=True, timeout=15)
        import re
        return re.findall(r"/dev/(sd[a-z]+)\s*$", r.stdout, re.MULTILINE)
    except Exception:
        return []


def _get_mountpoint(array):
    try:
        r = subprocess.run(
            ["findmnt", "-rno", "TARGET", "--source", f"/dev/{array}"],
            capture_output=True, text=True, timeout=10
        )
        return r.stdout.strip() or None
    except Exception:
        return None


def _flush_array(array, mountpoint=None):
    """Try btrfs sync on array mountpoint."""
    mp = mountpoint or _get_mountpoint(array)
    if not mp:
        return
    try:
        subprocess.run(["btrfs", "filesystem", "sync", mp],
                       capture_output=True, timeout=60)
        subprocess.run(["sync"], capture_output=True, timeout=30)
    except Exception:
        pass


def _write_sysfs(path, value):
    try:
        with open(path, "w") as f:
            f.write(value)
    except Exception:
        pass


def _sighup_daemon():
    try:
        pid = int(open(PID_FILE).read().strip())
        os.kill(pid, signal.SIGHUP)
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("get_state")
    sub.add_parser("get_config")

    p_set = sub.add_parser("set_backup_mode")
    p_set.add_argument("--array", required=True)
    p_set.add_argument("--enabled", required=True)
    p_set.add_argument("--timeout", default="30")

    p_wake = sub.add_parser("wakeup_now")
    p_wake.add_argument("--array", required=True)

    p_sleep = sub.add_parser("spindown_now")
    p_sleep.add_argument("--array", required=True)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        "get_state":       cmd_get_state,
        "get_config":      cmd_get_config,
        "set_backup_mode": cmd_set_backup_mode,
        "wakeup_now":      cmd_wakeup_now,
        "spindown_now":    cmd_spindown_now,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
