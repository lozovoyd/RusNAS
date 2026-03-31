"""
Authentication phase -- credential and session security checks.
ID range: SEC-400..499
"""

import http.client
import json
import base64
import os
import subprocess
import time

PHASE = "authentication"


def _finding(fid, severity, title, evidence="", remediation="", status="fail", owasp="A07"):
    return {
        "id": fid,
        "phase": PHASE,
        "owasp": owasp,
        "severity": severity,
        "title": title,
        "evidence": evidence,
        "remediation": remediation,
        "status": status,
    }


def _http_post_json(host, port, path, body_dict, timeout=5):
    """POST JSON to host:port/path, return (status_code, headers_dict, body_str)."""
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        payload = json.dumps(body_dict)
        conn.request(
            "POST",
            path,
            body=payload,
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="replace")
        hdrs = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, hdrs, body
    finally:
        conn.close()


def _decode_jwt_part(part):
    """Base64url-decode a JWT segment and return parsed JSON dict."""
    padded = part + "=" * (4 - len(part) % 4)
    raw = base64.urlsafe_b64decode(padded)
    return json.loads(raw)


def _check_default_creds(target, username, password, fid, label):
    """Try FileBrowser login with given creds. Return a Finding."""
    try:
        status, hdrs, body = _http_post_json(
            target, 80, "/files/api/login",
            {"username": username, "password": password},
            timeout=5,
        )
        if status == 200 and body and len(body) > 20 and "." in body:
            return _finding(
                fid,
                "critical",
                "FileBrowser default credentials: %s/%s" % (username, password),
                evidence="POST /files/api/login -> HTTP %d, JWT token returned (len=%d)" % (status, len(body)),
                remediation="Change default password immediately or disable the account.",
            )
        else:
            return _finding(
                fid,
                "info",
                "FileBrowser default credentials: %s/%s not accepted" % (username, password),
                evidence="POST /files/api/login -> HTTP %d" % status,
                status="pass",
            )
    except Exception as e:
        return _finding(
            fid,
            "info",
            "FileBrowser default creds check (%s/%s) failed" % (username, password),
            evidence=str(e),
            status="error",
        )


def _check_jwt_algorithm(target):
    """SEC-402: Inspect JWT header algorithm, test alg:none bypass."""
    findings = []
    try:
        status, hdrs, body = _http_post_json(
            target, 80, "/files/api/login",
            {"username": "admin", "password": "admin"},
            timeout=5,
        )
        token = None
        if status == 200 and body and "." in body:
            token = body.strip().strip('"')

        if not token:
            status2, hdrs2, body2 = _http_post_json(
                target, 80, "/files/api/login",
                {"username": "rusnas", "password": "rusnas"},
                timeout=5,
            )
            if status2 == 200 and body2 and "." in body2:
                token = body2.strip().strip('"')

        if not token:
            findings.append(_finding(
                "SEC-402",
                "info",
                "JWT algorithm check skipped -- no valid token obtained",
                status="skip",
            ))
            return findings

        parts = token.split(".")
        if len(parts) < 2:
            findings.append(_finding(
                "SEC-402",
                "info",
                "JWT algorithm check -- token format unexpected",
                evidence="Token parts: %d" % len(parts),
                status="error",
            ))
            return findings

        header = _decode_jwt_part(parts[0])
        alg = header.get("alg", "unknown")

        findings.append(_finding(
            "SEC-402",
            "info",
            "FileBrowser JWT uses algorithm: %s" % alg,
            evidence="JWT header: %s" % json.dumps(header),
            status="pass" if alg.upper() in ("HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "ES256", "ES384", "ES512") else "fail",
        ))

        # Test alg:none bypass
        try:
            fake_header = base64.urlsafe_b64encode(json.dumps({"alg": "none", "typ": "JWT"}).encode()).rstrip(b"=").decode()
            fake_payload = parts[1] if len(parts) > 1 else ""
            fake_token = "%s.%s." % (fake_header, fake_payload)

            conn = http.client.HTTPConnection(target, 80, timeout=5)
            try:
                conn.request(
                    "GET",
                    "/files/api/resources",
                    headers={
                        "X-Auth": fake_token,
                        "Cookie": "auth=" + fake_token,
                    },
                )
                resp = conn.getresponse()
                resp_body = resp.read().decode("utf-8", errors="replace")
                if resp.status == 200 and "items" in resp_body.lower():
                    findings.append(_finding(
                        "SEC-402",
                        "high",
                        "FileBrowser accepts JWT with alg:none -- authentication bypass",
                        evidence="GET /files/api/resources with alg:none token -> HTTP %d" % resp.status,
                        remediation="Update FileBrowser to a version that rejects alg:none tokens.",
                        owasp="A02",
                    ))
                else:
                    findings.append(_finding(
                        "SEC-402",
                        "info",
                        "FileBrowser correctly rejects alg:none JWT",
                        evidence="GET /files/api/resources with alg:none -> HTTP %d" % resp.status,
                        status="pass",
                    ))
            finally:
                conn.close()
        except Exception as e:
            findings.append(_finding(
                "SEC-402",
                "info",
                "JWT alg:none bypass test error",
                evidence=str(e),
                status="error",
            ))

    except Exception as e:
        findings.append(_finding(
            "SEC-402",
            "info",
            "JWT algorithm check error",
            evidence=str(e),
            status="error",
        ))

    return findings


def _check_jwt_expiry(target):
    """SEC-403: Check JWT expiry lifetime."""
    try:
        token = None
        for creds in [("admin", "admin"), ("rusnas", "rusnas")]:
            status, hdrs, body = _http_post_json(
                target, 80, "/files/api/login",
                {"username": creds[0], "password": creds[1]},
                timeout=5,
            )
            if status == 200 and body and "." in body:
                token = body.strip().strip('"')
                break

        if not token:
            return _finding(
                "SEC-403",
                "info",
                "JWT expiry check skipped -- no valid token obtained",
                status="skip",
            )

        parts = token.split(".")
        if len(parts) < 2:
            return _finding(
                "SEC-403", "info", "JWT expiry check -- invalid token format",
                status="error",
            )

        payload = _decode_jwt_part(parts[1])
        exp = payload.get("exp")
        iat = payload.get("iat")

        if exp is None:
            return _finding(
                "SEC-403",
                "medium",
                "FileBrowser JWT has no expiry (exp claim missing)",
                evidence="JWT payload keys: %s" % list(payload.keys()),
                remediation="Configure JWT tokens to expire within 24 hours.",
                owasp="A02",
            )

        now = int(time.time())
        issued = iat if iat else now
        lifetime_hours = (exp - issued) / 3600.0

        if lifetime_hours > 24:
            return _finding(
                "SEC-403",
                "medium",
                "FileBrowser JWT lifetime too long: %.1f hours" % lifetime_hours,
                evidence="iat=%s, exp=%s, lifetime=%.1fh" % (iat, exp, lifetime_hours),
                remediation="Reduce JWT token lifetime to 24 hours or less.",
                owasp="A02",
            )
        else:
            return _finding(
                "SEC-403",
                "info",
                "FileBrowser JWT lifetime acceptable: %.1f hours" % lifetime_hours,
                evidence="iat=%s, exp=%s" % (iat, exp),
                status="pass",
            )

    except Exception as e:
        return _finding(
            "SEC-403", "info", "JWT expiry check error",
            evidence=str(e), status="error",
        )


def _check_cockpit_rate_limit(target):
    """SEC-404: Check if Cockpit has rate limiting on failed logins."""
    try:
        got_429 = False
        last_status = 0
        for i in range(10):
            try:
                conn = http.client.HTTPSConnection(target, 9090, timeout=3)
                # Cockpit login is via /cockpit/login POST
                payload = "user=nonexistent&password=wrongpass%d" % i
                conn.request(
                    "POST",
                    "/cockpit/login",
                    body=payload,
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Authorization": "Basic " + base64.b64encode(
                            ("nonexistent:wrongpass%d" % i).encode()
                        ).decode(),
                    },
                )
                resp = conn.getresponse()
                last_status = resp.status
                resp.read()
                conn.close()
                if resp.status == 429:
                    got_429 = True
                    break
            except Exception:
                pass

        if got_429:
            return _finding(
                "SEC-404",
                "info",
                "Cockpit login rate limiting active",
                evidence="Received HTTP 429 after rapid failed logins",
                status="pass",
                owasp="A07",
            )
        else:
            return _finding(
                "SEC-404",
                "medium",
                "Cockpit has no login rate limiting detected",
                evidence="10 rapid failed login attempts, last status: %d, no 429 received" % last_status,
                remediation="Configure PAM or fail2ban to rate-limit authentication attempts on Cockpit (port 9090).",
                owasp="A07",
            )

    except Exception as e:
        return _finding(
            "SEC-404", "info", "Cockpit rate limiting check error",
            evidence=str(e), status="error",
        )


def _check_guard_running():
    """SEC-405: Check if rusnas-guard daemon is running."""
    try:
        result = subprocess.run(
            ["systemctl", "is-active", "rusnas-guard"],
            capture_output=True, text=True, timeout=5,
        )
        active = result.stdout.strip()
        if active == "active":
            return _finding(
                "SEC-405",
                "info",
                "rusnas-guard daemon is active",
                evidence="systemctl is-active rusnas-guard -> %s" % active,
                status="pass",
            )
        else:
            return _finding(
                "SEC-405",
                "info",
                "rusnas-guard daemon is not running (%s)" % active,
                evidence="systemctl is-active rusnas-guard -> %s" % active,
                remediation="Start Guard daemon: sudo systemctl start rusnas-guard",
                status="fail",
            )
    except Exception as e:
        return _finding(
            "SEC-405", "info", "Guard daemon check error",
            evidence=str(e), status="error",
        )


def _check_guard_pin():
    """SEC-406: Check if Guard PIN is configured."""
    try:
        pin_path = "/etc/rusnas-guard/guard.pin"
        if os.path.isfile(pin_path):
            size = os.path.getsize(pin_path)
            if size > 0:
                return _finding(
                    "SEC-406",
                    "info",
                    "Guard PIN is configured",
                    evidence="%s exists (%d bytes)" % (pin_path, size),
                    status="pass",
                )
            else:
                return _finding(
                    "SEC-406",
                    "info",
                    "Guard PIN file exists but is empty",
                    evidence="%s is 0 bytes" % pin_path,
                    remediation="Set a Guard PIN via the web UI or CLI.",
                    status="fail",
                )
        else:
            return _finding(
                "SEC-406",
                "info",
                "Guard PIN not configured",
                evidence="%s does not exist" % pin_path,
                remediation="Set a Guard PIN via the web UI or CLI.",
                status="fail",
            )
    except Exception as e:
        return _finding(
            "SEC-406", "info", "Guard PIN check error",
            evidence=str(e), status="error",
        )


def run(ctx):
    """Run all authentication checks. Returns list of Finding dicts."""
    target = ctx.get("target", "127.0.0.1")
    findings = []

    # SEC-400: FileBrowser default creds admin/admin
    findings.append(_check_default_creds(target, "admin", "admin", "SEC-400", "admin/admin"))

    # SEC-401: FileBrowser default creds rusnas/rusnas
    findings.append(_check_default_creds(target, "rusnas", "rusnas", "SEC-401", "rusnas/rusnas"))

    # SEC-402: JWT algorithm check
    findings.extend(_check_jwt_algorithm(target))

    # SEC-403: JWT expiry
    findings.append(_check_jwt_expiry(target))

    # SEC-404: Cockpit rate limiting
    findings.append(_check_cockpit_rate_limit(target))

    # SEC-405: Guard daemon running
    findings.append(_check_guard_running())

    # SEC-406: Guard PIN set
    findings.append(_check_guard_pin())

    return findings
