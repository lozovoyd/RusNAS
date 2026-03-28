#!/usr/bin/env python3
"""rusnas-spind — RAID spindown daemon."""
import argparse
import json
import logging
import os
import signal
import sys
import time

from monitor import SpindownMonitor, STATE_ACTIVE, STATE_STANDBY, STATE_FLUSHING, STATE_WAKING
from controller import SpinController
from btrfs_helper import BtrfsFlusher
import mdadm_helper as mdadm
import state_writer as sw

CONFIG_FILE   = "/etc/rusnas/spindown.json"
LOG_FILE      = "/var/log/rusnas/spindown.log"
PID_FILE      = "/run/rusnas/spind.pid"
TICK_INTERVAL = 10  # seconds

log = logging.getLogger("rusnas-spind")
_monitors = {}   # array_name -> SpindownMonitor
_ctrl = None
_btrfs = None
_running = True


def load_config():
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except Exception as e:
        log.error("Cannot read config %s: %s", CONFIG_FILE, e)
        return {"version": 1, "arrays": {}}


def init_monitors(config, dry_run):
    global _monitors
    totals = sw.load_totals()
    new_monitors = {}
    arrays_cfg = config.get("arrays", {})
    for name, cfg in arrays_cfg.items():
        if not cfg.get("backup_mode") or not cfg.get("enabled", True):
            continue
        m = SpindownMonitor(name, cfg.get("idle_timeout_minutes", 30), cfg)
        m.wakeup_count_total = totals.get(name, 0)
        m.member_disks = mdadm.get_member_disks(name)
        m.mountpoint = mdadm.get_mountpoint(name)
        # init disk states
        m.disk_states = {d: _ctrl.check_state(d) for d in m.member_disks}
        new_monitors[name] = m
        log.info("monitoring %s: timeout=%dm disks=%s mount=%s",
                 name, cfg.get("idle_timeout_minutes", 30),
                 m.member_disks, m.mountpoint)
    _monitors = new_monitors


def do_spindown(monitor):
    name = monitor.array_name
    cfg = monitor.config
    log.info("%s: spindown initiated (idle %ds, %d disks)",
             name, monitor._idle_seconds, len(monitor.member_disks))
    monitor.state = STATE_FLUSHING
    sw.write_state(_monitors.values())

    if cfg.get("pre_sleep_flush", True) and monitor.mountpoint:
        _btrfs.flush(monitor.mountpoint)

    if cfg.get("extend_btrfs_commit", True) and monitor.mountpoint:
        _btrfs.extend_commit(monitor.mountpoint)

    # Stop mdadm check + always freeze sync_min to 0 before spindown
    if mdadm.get_sync_action(name) != "idle":
        log.info("%s: mdadm check suppressed", name)
    mdadm.suppress_check(name)  # always: writes idle to sync_action + 0 to sync_min

    for disk in monitor.member_disks:
        _ctrl.spindown(disk)

    time.sleep(5)  # post-hdparm settle

    monitor.disk_states = {d: _ctrl.check_state(d) for d in monitor.member_disks}
    monitor.state = STATE_STANDBY
    monitor.spindown_at = time.time()
    sw.write_state(_monitors.values())
    log.info("%s: spindown complete. disk_states=%s", name, monitor.disk_states)


def do_wakeup(monitor):
    name = monitor.array_name
    cfg = monitor.config
    log.info("%s: wakeup detected", name)
    monitor.state = STATE_WAKING
    sw.write_state(_monitors.values())

    if cfg.get("extend_btrfs_commit", True) and monitor.mountpoint:
        _btrfs.restore_commit(monitor.mountpoint)

    mdadm.restore_check(name)

    monitor.wakeup_count_session += 1
    monitor.wakeup_count_total += 1
    monitor.spindown_at = None
    monitor.reset_idle()  # clear stale idle_seconds so state.json shows 0 after wakeup

    totals = {m.array_name: m.wakeup_count_total for m in _monitors.values()}
    sw.save_totals(totals)
    sw.write_state(_monitors.values())


def tick():
    for name, monitor in list(_monitors.items()):
        triggered = monitor.tick()
        if not triggered:
            continue

        if monitor.state == STATE_STANDBY:
            do_wakeup(monitor)
        elif monitor.state == STATE_ACTIVE:
            # Check guards before spindown
            if mdadm.is_degraded(name):
                log.warning("%s: skipping spindown — array degraded", name)
                monitor.reset_idle()
                continue
            if mdadm.get_sync_action(name) != "idle":
                log.warning("%s: skipping spindown — sync_action=%s",
                            name, mdadm.get_sync_action(name))
                monitor.reset_idle()
                continue
            do_spindown(monitor)
        elif monitor.state == STATE_WAKING:
            # First tick with delta > 0 after waking
            monitor.state = STATE_ACTIVE
            log.info("%s: wakeup complete", name)
            sw.write_state(_monitors.values())


def cleanup():
    log.info("SIGTERM: cleaning up standby arrays")
    for monitor in _monitors.values():
        if monitor.state == STATE_STANDBY:
            # Always restore Btrfs commit and mdadm check, regardless of config flags
            if _btrfs is not None and monitor.mountpoint:
                _btrfs.restore_commit(monitor.mountpoint)
            mdadm.restore_check(monitor.array_name)
    totals = {m.array_name: m.wakeup_count_total for m in _monitors.values()}
    sw.save_totals(totals)
    try:
        os.unlink(PID_FILE)
    except Exception:
        pass


def main():
    global _ctrl, _btrfs, _running

    parser = argparse.ArgumentParser(description="rusNAS spindown daemon")
    parser.add_argument("--dry-run", action="store_true",
                        help="Simulate hdparm/remount — no actual spindown")
    args = parser.parse_args()

    # Logging setup
    os.makedirs("/var/log/rusnas", exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[
            logging.FileHandler(LOG_FILE),
            logging.StreamHandler(sys.stdout),
        ]
    )

    log.info("rusnas-spind starting%s", " [DRY-RUN]" if args.dry_run else "")

    _ctrl = SpinController(dry_run=args.dry_run)
    _btrfs = BtrfsFlusher(dry_run=args.dry_run)

    # Write PID
    os.makedirs(os.path.dirname(PID_FILE), exist_ok=True)
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    config = load_config()
    init_monitors(config, args.dry_run)
    sw.write_state(_monitors.values())

    def sighup_handler(sig, frame):
        log.info("SIGHUP: reloading config")
        new_config = load_config()
        init_monitors(new_config, args.dry_run)
        sw.write_state(_monitors.values())
        log.info("config reloaded")

    def sigterm_handler(sig, frame):
        global _running
        _running = False

    signal.signal(signal.SIGHUP,  sighup_handler)
    signal.signal(signal.SIGTERM, sigterm_handler)
    signal.signal(signal.SIGINT,  sigterm_handler)

    log.info("daemon ready, %d arrays monitored", len(_monitors))

    while _running:
        tick()
        sw.write_state(_monitors.values())
        time.sleep(TICK_INTERVAL)

    cleanup()
    log.info("rusnas-spind stopped")


if __name__ == "__main__":
    main()
