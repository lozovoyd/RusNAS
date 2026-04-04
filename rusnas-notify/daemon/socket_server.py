#!/usr/bin/env python3
"""Unix socket server for rusnas-notifyd.

Protocol: newline-delimited JSON. One request per line, one response per line.
No authentication required (socket permissions control access).
"""

import json
import logging
import os
import socket
import threading

logger = logging.getLogger("rusnas-notify.socket")

SOCK_PATH = "/run/rusnas-notify/notify.sock"


class NotifySocketServer:
    def __init__(self, daemon):
        self._daemon = daemon
        self._server = None
        self._thread = None
        self._running = False

    def start(self):
        os.makedirs(os.path.dirname(SOCK_PATH), exist_ok=True)
        if os.path.exists(SOCK_PATH):
            os.unlink(SOCK_PATH)
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(SOCK_PATH)
        os.chmod(SOCK_PATH, 0o666)
        self._server.listen(8)
        self._server.settimeout(1.0)
        self._running = True
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()
        logger.info("Socket server listening on %s", SOCK_PATH)

    def stop(self):
        self._running = False
        if self._server:
            self._server.close()
        if os.path.exists(SOCK_PATH):
            os.unlink(SOCK_PATH)

    def _accept_loop(self):
        while self._running:
            try:
                conn, _ = self._server.accept()
                t = threading.Thread(target=self._handle_client, args=(conn,), daemon=True)
                t.start()
            except socket.timeout:
                continue
            except OSError:
                break

    def _handle_client(self, conn):
        try:
            buf = b""
            while True:
                data = conn.recv(4096)
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    try:
                        req = json.loads(line.decode("utf-8"))
                        resp = self._dispatch(req)
                    except Exception as e:
                        resp = {"ok": False, "error": str(e)}
                    conn.sendall(json.dumps(resp, ensure_ascii=False).encode("utf-8") + b"\n")
        except Exception as e:
            logger.error("Socket client error: %s", e)
        finally:
            conn.close()

    def _dispatch(self, req):
        cmd = req.get("cmd", "")
        try:
            if cmd == "send":
                return self._daemon.handle_event(req)
            elif cmd == "test":
                return self._daemon.handle_test(req)
            elif cmd == "get_config":
                return {"ok": True, "config": self._daemon.get_config()}
            elif cmd == "save_config":
                return self._daemon.save_config(req.get("config", {}))
            elif cmd == "get_history":
                return self._daemon.get_history(req)
            elif cmd == "status":
                return self._daemon.get_status()
            else:
                return {"ok": False, "error": "Unknown command: %s" % cmd}
        except Exception as e:
            logger.error("Command %s failed: %s", cmd, e)
            return {"ok": False, "error": str(e)}
