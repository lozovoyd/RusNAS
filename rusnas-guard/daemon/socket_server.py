"""Unix domain socket server for rusnas-guard.

Provides the control API consumed by the Cockpit UI (guard.js). The protocol
is newline-delimited JSON: one request object per line, one response object
per line. Commands are either unauthenticated (``status``, ``get_events``,
``get_config``, ``has_pin``) or require PIN/token authentication. Session
tokens are issued on successful PIN verification and expire after 30 minutes.
"""

import hashlib
import json
import logging
import os
import secrets
import socket
import subprocess
import threading
import time

import bcrypt

logger = logging.getLogger("rusnas-guard.socket")

SOCK_PATH  = "/run/rusnas-guard/control.sock"
PIN_PATH   = "/etc/rusnas-guard/guard.pin"
TOKEN_TTL  = 1800  # 30 minutes


class SocketServer:
    """Unix domain socket server for Guard daemon control.

    Listens on ``/run/rusnas-guard/control.sock`` with world-accessible
    permissions (0o666) so Cockpit bridge can connect without superuser.
    Handles authentication via bcrypt-hashed PIN and session tokens.

    Args:
        daemon_ref: Reference to the GuardDaemon instance for command dispatch.
    """

    def __init__(self, daemon_ref):
        self._daemon  = daemon_ref
        self._tokens: dict[str, float] = {}  # token -> expiry timestamp
        self._lock    = threading.Lock()
        self._server  = None
        self._thread  = None

    def start(self):
        """Bind the socket and start the accept loop and watchdog threads."""
        self._bind_socket()
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()
        watchdog = threading.Thread(target=self._socket_watchdog, daemon=True)
        watchdog.start()
        logger.info("Socket server listening on %s", SOCK_PATH)

    def _bind_socket(self):
        """Create and bind the Unix domain socket with 0o666 permissions."""
        os.makedirs(os.path.dirname(SOCK_PATH), exist_ok=True)
        if os.path.exists(SOCK_PATH):
            os.unlink(SOCK_PATH)
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(SOCK_PATH)
        os.chmod(SOCK_PATH, 0o666)
        self._server.listen(5)

    def _socket_watchdog(self):
        """Periodically check socket file exists; recreate if deleted."""
        while True:
            time.sleep(30)
            if not os.path.exists(SOCK_PATH):
                logger.warning("Socket file missing, recreating: %s", SOCK_PATH)
                try:
                    if self._server:
                        try:
                            self._server.close()
                        except Exception:
                            pass
                    self._bind_socket()
                    self._thread = threading.Thread(target=self._accept_loop, daemon=True)
                    self._thread.start()
                    logger.info("Socket server re-created on %s", SOCK_PATH)
                except Exception as e:
                    logger.error("Failed to recreate socket: %s", e)

    def stop(self):
        """Close the socket server and clean up the socket file."""
        if self._server:
            try:
                self._server.close()
            except Exception:
                pass
        if os.path.exists(SOCK_PATH):
            os.unlink(SOCK_PATH)

    # ── Accept loop ───────────────────────────────────────────────────────────

    def _accept_loop(self):
        """Accept incoming connections and spawn handler threads."""
        while True:
            try:
                conn, _ = self._server.accept()
                threading.Thread(
                    target=self._handle_conn,
                    args=(conn,),
                    daemon=True
                ).start()
            except OSError:
                break

    def _handle_conn(self, conn: socket.socket):
        """Handle a single client connection: read JSON request, dispatch, respond.

        Args:
            conn: Connected Unix socket.
        """
        try:
            buf = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
                if b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    try:
                        req  = json.loads(line.decode())
                        resp = self._dispatch(req)
                    except json.JSONDecodeError:
                        resp = {"ok": False, "error": "Invalid JSON"}
                    conn.sendall(json.dumps(resp).encode() + b"\n")
        except Exception as e:
            logger.debug("Connection error: %s", e)
        finally:
            conn.close()

    # ── Dispatch ──────────────────────────────────────────────────────────────

    def _dispatch(self, req: dict) -> dict:
        """Route a request to the appropriate handler.

        Args:
            req: Parsed JSON request with at least a ``cmd`` key.

        Returns:
            Response dict with ``ok`` (bool) and ``data`` or ``error``.
        """
        cmd = req.get("cmd")

        # Unauthenticated commands
        if cmd == "status":
            return {"ok": True, "data": self._daemon.get_status()}

        if cmd == "get_events":
            from response import load_events
            result = load_events(
                limit=req.get("limit", 50),
                offset=req.get("offset", 0),
                method=req.get("method") or None,
                date_from=req.get("date_from") or None,
                date_to=req.get("date_to") or None,
                status=req.get("status") or None,
            )
            return {"ok": True, "data": result}

        if cmd == "get_config":
            return {"ok": True, "data": self._daemon.get_config_public()}

        if cmd == "has_pin":
            return {"ok": True, "data": {"has_pin": os.path.exists(PIN_PATH)}}

        if cmd == "set_pin_initial":
            # Only allowed if no PIN exists yet
            if os.path.exists(PIN_PATH):
                return {"ok": False, "error": "PIN already set"}
            pin = req.get("pin", "")
            if len(pin) < 6:
                return {"ok": False, "error": "PIN must be at least 6 characters"}
            return self._set_pin(pin)

        # PIN-required commands
        pin   = req.get("pin", "")
        token = req.get("token", "")

        if not self._auth(pin, token):
            if not os.path.exists(PIN_PATH):
                return {"ok": False, "error": "no_pin_set"}
            return {"ok": False, "error": "Invalid PIN or session expired"}

        # Issue new token on successful auth
        new_token = self._issue_token()

        if cmd == "auth":
            return {"ok": True, "data": {"token": new_token}}

        if cmd == "start":
            self._daemon.start_guard()
            return {"ok": True, "data": {"token": new_token}}

        if cmd == "stop":
            self._daemon.stop_guard()
            return {"ok": True, "data": {"token": new_token}}

        if cmd == "set_mode":
            mode = req.get("mode", "")
            if mode not in ("monitor", "active", "super_safe"):
                return {"ok": False, "error": "Unknown mode"}
            self._daemon.set_mode(mode)
            return {"ok": True, "data": {"token": new_token}}

        if cmd == "acknowledge":
            from response import acknowledge_event, get_blocked_ips, clear_all_blocks
            eid = req.get("event_id", "")
            ok  = acknowledge_event(eid)
            return {"ok": ok, "data": {"token": new_token}}

        if cmd == "clear_blocks":
            from response import clear_all_blocks
            clear_all_blocks()
            return {"ok": True, "data": {"token": new_token}}

        if cmd == "set_config":
            cfg = req.get("config", {})
            self._daemon.update_config(cfg)
            return {"ok": True, "data": {"token": new_token}}

        if cmd == "generate_ssh_key":
            pub = self._gen_ssh_key()
            return {"ok": True, "data": {"public_key": pub, "token": new_token}}

        if cmd == "clear_events":
            from response import clear_events
            clear_events()
            return {"ok": True, "data": {"token": new_token}}

        if cmd == "acknowledge_post_attack":
            flag = "/etc/rusnas-guard/post_attack"
            if os.path.exists(flag):
                os.unlink(flag)
            self._daemon.restore_mode_after_attack()
            return {"ok": True, "data": {"token": new_token}}

        if cmd == "change_pin":
            new_pin = req.get("new_pin", "")
            if len(new_pin) < 6:
                return {"ok": False, "error": "PIN must be at least 6 characters"}
            result = self._set_pin(new_pin)
            result.get("data", {})["token"] = new_token
            return result

        return {"ok": False, "error": f"Unknown command: {cmd}"}

    # ── Auth ──────────────────────────────────────────────────────────────────

    def _auth(self, pin: str, token: str) -> bool:
        """Authenticate a request via session token or PIN.

        Args:
            pin: Raw PIN string from the request (may be empty).
            token: Session token from a previous authentication (may be empty).

        Returns:
            True if authentication succeeds via either method.
        """
        # Token auth (session) — only valid if PIN file still exists
        if token and os.path.exists(PIN_PATH):
            with self._lock:
                expiry = self._tokens.get(token)
                if expiry and time.time() < expiry:
                    return True

        # PIN auth
        if pin and os.path.exists(PIN_PATH):
            try:
                with open(PIN_PATH, "rb") as fh:
                    hashed = fh.read().strip()
                return bcrypt.checkpw(pin.encode(), hashed)
            except Exception as e:
                logger.error("PIN check error: %s", e)

        return False

    def _issue_token(self) -> str:
        """Generate a new session token with TOKEN_TTL expiry.

        Cleans up expired tokens before issuing a new one.

        Returns:
            Hex-encoded 32-byte session token string.
        """
        token = secrets.token_hex(32)
        with self._lock:
            # Clean expired
            now = time.time()
            self._tokens = {t: e for t, e in self._tokens.items() if e > now}
            self._tokens[token] = now + TOKEN_TTL
        return token

    def _set_pin(self, pin: str) -> dict:
        """Hash and save a new Guard PIN.

        Args:
            pin: Raw PIN string (minimum 6 characters).

        Returns:
            Success response dict.
        """
        os.makedirs(os.path.dirname(PIN_PATH), exist_ok=True)
        hashed = bcrypt.hashpw(pin.encode(), bcrypt.gensalt())
        with open(PIN_PATH, "wb") as fh:
            fh.write(hashed)
        os.chmod(PIN_PATH, 0o600)
        logger.info("Guard PIN updated")
        return {"ok": True, "data": {}}

    def _gen_ssh_key(self) -> str:
        """Generate an Ed25519 SSH key pair for snapshot replication.

        Creates the key at ``/etc/rusnas-guard/replication_key`` if it
        does not already exist.

        Returns:
            Public key string, or empty string on failure.
        """
        key_path = "/etc/rusnas-guard/replication_key"
        if not os.path.exists(key_path):
            subprocess.run(
                ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key_path],
                check=True, capture_output=True
            )
        try:
            with open(key_path + ".pub") as fh:
                return fh.read().strip()
        except OSError:
            return ""
