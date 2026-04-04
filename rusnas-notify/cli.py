#!/usr/bin/env python3
"""rusnas-notify — CLI for the rusNAS notification system.

Usage:
  rusnas-notify send --source guard --severity critical --title "..." --body "..."
  rusnas-notify test --channel telegram
  rusnas-notify history [--limit N] [--source X]
  rusnas-notify status
"""

import argparse
import json
import os
import socket
import sys
import time

SOCK_PATH = "/run/rusnas-notify/notify.sock"
SPOOL_DIR = "/var/spool/rusnas-notify"


def socket_send(req):
    """Send request via Unix socket. Returns response dict or None."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(30)
        s.connect(SOCK_PATH)
        s.sendall(json.dumps(req).encode("utf-8") + b"\n")
        buf = b""
        while b"\n" not in buf:
            data = s.recv(4096)
            if not data:
                break
            buf += data
        s.close()
        if buf:
            return json.loads(buf.split(b"\n")[0].decode("utf-8"))
        return None
    except Exception:
        return None


def spool_write(req):
    """Fallback: write event to spool directory."""
    os.makedirs(SPOOL_DIR, exist_ok=True)
    event_id = "evt_%d_%d" % (int(time.time() * 1000), os.getpid())
    path = os.path.join(SPOOL_DIR, "%s.json" % event_id)
    req["_event_id"] = event_id
    with open(path, "w") as f:
        json.dump(req, f)
    return event_id


def cmd_send(args):
    extra = args.extra
    if extra:
        try:
            json.loads(extra)
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": "Invalid --extra JSON"}))
            sys.exit(1)

    req = {
        "cmd": "send",
        "source": args.source,
        "severity": args.severity,
        "title": args.title,
        "body": args.body or "",
        "extra": extra
    }

    resp = socket_send(req)
    if resp:
        print(json.dumps(resp))
    else:
        event_id = spool_write(req)
        print(json.dumps({"ok": True, "event_id": event_id, "spooled": True}))


def cmd_test(args):
    req = {"cmd": "test", "channel": args.channel}
    resp = socket_send(req)
    if resp:
        print(json.dumps(resp))
    else:
        print(json.dumps({"ok": False, "error": "Daemon not running"}))
        sys.exit(1)


def cmd_history(args):
    req = {"cmd": "get_history", "limit": args.limit, "offset": args.offset}
    if args.source:
        req["source"] = args.source
    resp = socket_send(req)
    if resp:
        print(json.dumps(resp, indent=2, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": "Daemon not running"}))
        sys.exit(1)


def cmd_status(args):
    resp = socket_send({"cmd": "status"})
    if resp:
        print(json.dumps(resp, indent=2))
    else:
        print(json.dumps({"ok": False, "running": False}))


def main():
    parser = argparse.ArgumentParser(description="rusNAS Notification CLI")
    sub = parser.add_subparsers(dest="command")

    p_send = sub.add_parser("send", help="Send notification event")
    p_send.add_argument("--source", required=True)
    p_send.add_argument("--severity", required=True, choices=["critical", "warning", "info"])
    p_send.add_argument("--title", required=True)
    p_send.add_argument("--body", default="")
    p_send.add_argument("--extra", default=None, help="Extra JSON payload")

    p_test = sub.add_parser("test", help="Test a delivery channel")
    p_test.add_argument("--channel", required=True,
                        choices=["email", "telegram", "max", "snmp", "webhook"])

    p_hist = sub.add_parser("history", help="View notification history")
    p_hist.add_argument("--limit", type=int, default=20)
    p_hist.add_argument("--offset", type=int, default=0)
    p_hist.add_argument("--source", default=None)

    sub.add_parser("status", help="Daemon status")

    args = parser.parse_args()
    if args.command == "send":
        cmd_send(args)
    elif args.command == "test":
        cmd_test(args)
    elif args.command == "history":
        cmd_history(args)
    elif args.command == "status":
        cmd_status(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
