"""
Access control checks — NFS, SMB, rsync, FTP, forced browsing, FileBrowser, WebDAV.
ID range: SEC-300..399
"""

import subprocess
import socket
import re
import os
import http.client
import json

PHASE = "access_control"


def _finding(fid, severity, title, evidence="", remediation="", status="fail"):
    return {
        "id": fid,
        "phase": PHASE,
        "owasp": "A01",
        "severity": severity,
        "title": title,
        "evidence": evidence,
        "remediation": remediation,
        "status": status,
    }


def _run_cmd(args, timeout=10):
    """Run a command, return (stdout, stderr, returncode). Returns (None, err, -1) on failure."""
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout,
        )
        return result.stdout, result.stderr, result.returncode
    except FileNotFoundError:
        return None, "command not found: {}".format(args[0]), -1
    except subprocess.TimeoutExpired:
        return None, "timeout", -1
    except OSError as exc:
        return None, str(exc), -1


def _http_get(host, port, path, use_https=False, timeout=5):
    """Return (status_code, headers_dict, body_snippet) or (None, None, None)."""
    try:
        if use_https:
            import ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=ctx)
        else:
            conn = http.client.HTTPConnection(host, port, timeout=timeout)
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read(4096).decode("utf-8", errors="replace")
        headers = {k.lower(): v for k, v in resp.getheaders()}
        status = resp.status
        conn.close()
        return status, headers, body
    except Exception:
        return None, None, None


# -------------------------------------------------------
# NFS checks
# -------------------------------------------------------

def _check_nfs_exports(ctx):
    """SEC-300, SEC-301: NFS wildcard and unrestricted exports."""
    findings = []
    target = ctx.get("target", "127.0.0.1")

    exports_text = None
    # Try showmount first
    out, err, rc = _run_cmd(["showmount", "-e", target])
    if rc == 0 and out:
        exports_text = out
    else:
        # Fallback: read /etc/exports directly
        try:
            with open("/etc/exports", "r") as fh:
                exports_text = fh.read()
        except (IOError, OSError):
            findings.append(
                _finding(
                    "SEC-300", "high",
                    "NFS exports check skipped",
                    evidence="showmount failed and /etc/exports not readable.",
                    status="skip",
                )
            )
            findings.append(
                _finding("SEC-301", "high", "NFS unrestricted export check skipped",
                         status="skip")
            )
            return findings

    # SEC-300: wildcard (*)
    wildcard_lines = []
    unrestricted_lines = []
    for line in exports_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # showmount format: /path host1,host2
        # /etc/exports format: /path host(opts) ...
        if re.search(r'\*', line):
            wildcard_lines.append(line)
        if re.search(r'0\.0\.0\.0/0|::/0', line):
            unrestricted_lines.append(line)

    if wildcard_lines:
        findings.append(
            _finding(
                "SEC-300", "high",
                "NFS exports with wildcard (*)",
                evidence="Exports: {}".format("; ".join(wildcard_lines[:5])),
                remediation="Restrict NFS exports to specific hosts/subnets instead of *.",
                status="fail",
            )
        )
    else:
        findings.append(
            _finding("SEC-300", "high", "No NFS wildcard exports found", status="pass")
        )

    # SEC-301: unrestricted 0.0.0.0/0 or ::/0
    if unrestricted_lines:
        findings.append(
            _finding(
                "SEC-301", "high",
                "NFS exports to 0.0.0.0/0 or ::/0",
                evidence="Exports: {}".format("; ".join(unrestricted_lines[:5])),
                remediation="Replace 0.0.0.0/0 with specific subnet restrictions.",
                status="fail",
            )
        )
    else:
        findings.append(
            _finding("SEC-301", "high", "No unrestricted NFS exports found", status="pass")
        )

    return findings


# -------------------------------------------------------
# SMB check
# -------------------------------------------------------

def _check_smb_anon(ctx):
    """SEC-302: SMB anonymous access."""
    target = ctx.get("target", "127.0.0.1")
    out, err, rc = _run_cmd(
        ["smbclient", "-L", "//{}".format(target), "-N", "--no-pass"],
        timeout=10,
    )
    if out is None:
        return _finding(
            "SEC-302", "high",
            "SMB anonymous access check skipped",
            evidence="smbclient not available: {}".format(err),
            status="skip",
        )

    # Look for share listings (Sharename lines)
    shares = re.findall(r"^\s+(\S+)\s+Disk", out, re.MULTILINE)
    if shares:
        return _finding(
            "SEC-302", "high",
            "SMB anonymous access exposes shares",
            evidence="Anonymous listing returned shares: {}".format(
                ", ".join(shares[:10])
            ),
            remediation=(
                "Set 'restrict anonymous = 2' in smb.conf [global] and ensure "
                "no shares have 'guest ok = yes'."
            ),
            status="fail",
        )

    # Also treat NT_STATUS_ACCESS_DENIED or connection refused as pass
    return _finding(
        "SEC-302", "high",
        "SMB anonymous access denied",
        evidence="smbclient -N returned no share listing.",
        status="pass",
    )


# -------------------------------------------------------
# rsync checks
# -------------------------------------------------------

def _check_rsync(ctx):
    """SEC-303, SEC-304: rsync anonymous module listing and list=true."""
    findings = []
    target = ctx.get("target", "127.0.0.1")
    ports = ctx.get("ports", {})

    # SEC-303: anonymous module listing via network
    if 873 in ports:
        out, err, rc = _run_cmd(
            ["rsync", "--list-only", "rsync://{}/".format(target)],
            timeout=10,
        )
        if out is not None and rc == 0 and out.strip():
            modules = [l.strip() for l in out.strip().splitlines() if l.strip()]
            findings.append(
                _finding(
                    "SEC-303", "low",
                    "rsync anonymous module listing available",
                    evidence="Modules: {}".format(
                        "; ".join(modules[:10])
                    ),
                    remediation="Set 'list = false' in each rsyncd.conf module.",
                    status="fail",
                )
            )
        else:
            findings.append(
                _finding("SEC-303", "low", "rsync anonymous listing not available",
                         status="pass")
            )
    else:
        findings.append(
            _finding("SEC-303", "low", "rsync check skipped (port 873 not open)",
                     status="skip")
        )

    # SEC-304: parse /etc/rsyncd.conf for list=true
    conf_path = "/etc/rsyncd.conf"
    if os.path.isfile(conf_path):
        try:
            with open(conf_path, "r") as fh:
                conf = fh.read()
            # Find modules with list = true (or without list = false, default is true)
            modules_with_list = []
            current_module = None
            has_list_false = False
            for line in conf.splitlines():
                line = line.strip()
                m = re.match(r"^\[([^\]]+)\]", line)
                if m:
                    if current_module and not has_list_false:
                        modules_with_list.append(current_module)
                    current_module = m.group(1)
                    has_list_false = False
                elif current_module and re.match(r"list\s*=\s*(false|no)", line, re.I):
                    has_list_false = True
            if current_module and not has_list_false:
                modules_with_list.append(current_module)

            if modules_with_list:
                findings.append(
                    _finding(
                        "SEC-304", "low",
                        "rsync modules with listing enabled",
                        evidence="Modules without 'list = false': {}".format(
                            ", ".join(modules_with_list)
                        ),
                        remediation="Add 'list = false' to each module in rsyncd.conf.",
                        status="fail",
                    )
                )
            else:
                findings.append(
                    _finding("SEC-304", "low", "All rsync modules have listing disabled",
                             status="pass")
                )
        except (IOError, OSError):
            findings.append(
                _finding("SEC-304", "low", "rsync config not readable", status="skip")
            )
    else:
        findings.append(
            _finding("SEC-304", "low", "rsyncd.conf not found", status="skip")
        )

    return findings


# -------------------------------------------------------
# FTP anonymous check
# -------------------------------------------------------

def _check_ftp_anon(ctx):
    """SEC-305: FTP anonymous access."""
    target = ctx.get("target", "127.0.0.1")
    ports = ctx.get("ports", {})

    if 21 not in ports:
        return _finding("SEC-305", "medium", "FTP check skipped (port 21 not open)",
                        status="skip")

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect((target, 21))
        banner = s.recv(1024).decode("utf-8", errors="replace")

        # Send USER anonymous
        s.sendall(b"USER anonymous\r\n")
        resp_user = s.recv(1024).decode("utf-8", errors="replace")

        if resp_user.startswith("331") or resp_user.startswith("230"):
            # Try PASS
            s.sendall(b"PASS anonymous@\r\n")
            resp_pass = s.recv(1024).decode("utf-8", errors="replace")
            s.sendall(b"QUIT\r\n")
            s.close()

            if resp_pass.startswith("230"):
                return _finding(
                    "SEC-305", "medium",
                    "FTP anonymous login accepted",
                    evidence="Server accepted anonymous login. Banner: {}".format(
                        banner.strip()[:100]
                    ),
                    remediation="Set 'anonymous_enable=NO' in /etc/vsftpd.conf.",
                    status="fail",
                )
        else:
            s.sendall(b"QUIT\r\n")
            s.close()

        return _finding(
            "SEC-305", "medium",
            "FTP anonymous login rejected",
            evidence="Server rejected anonymous user.",
            status="pass",
        )
    except (socket.timeout, ConnectionRefusedError, OSError) as exc:
        return _finding(
            "SEC-305", "medium",
            "FTP anonymous check error",
            evidence=str(exc),
            status="error",
        )


# -------------------------------------------------------
# Forced browsing
# -------------------------------------------------------

def _check_forced_browsing(ctx):
    """SEC-306: Check sensitive paths for distinct responses vs catch-all."""
    target = ctx.get("target", "127.0.0.1")
    findings_detail = []

    # First get the catch-all response
    base_status, _, base_body = _http_get(target, 80, "/nonexistent-sectest-path-12345")
    if base_status is None:
        return _finding(
            "SEC-306", "medium",
            "Forced browsing check skipped (port 80 not reachable)",
            status="skip",
        )

    sensitive_paths = ["/admin", "/.env", "/.git", "/server-status", "/.htaccess"]
    exposed = []
    for path in sensitive_paths:
        status, _, body = _http_get(target, 80, path)
        if status is None:
            continue
        # A distinct response is one that is 200 and different body length from catch-all
        if status == 200 and base_status != 200:
            exposed.append("{} (HTTP {})".format(path, status))
        elif status == 200 and base_body and body:
            # If both 200 but body differs significantly
            if abs(len(body) - len(base_body)) > 100:
                exposed.append("{} (HTTP {}, distinct content)".format(path, status))

    if exposed:
        return _finding(
            "SEC-306", "medium",
            "Sensitive paths accessible via forced browsing",
            evidence="Exposed: {}".format(", ".join(exposed)),
            remediation="Block sensitive paths in nginx: return 404 for /.env, /.git, etc.",
            status="fail",
        )

    return _finding(
        "SEC-306", "medium",
        "No sensitive paths exposed via forced browsing",
        status="pass",
    )


# -------------------------------------------------------
# FileBrowser admin scope
# -------------------------------------------------------

def _check_filebrowser_scope(ctx):
    """SEC-307: FileBrowser admin with scope='.' gives filesystem root access."""
    target = ctx.get("target", "127.0.0.1")

    # Try to reach FileBrowser and log in as admin with default creds
    status, headers, body = _http_get(target, 80, "/files/")
    if status is None:
        return _finding(
            "SEC-307", "critical",
            "FileBrowser scope check skipped (not reachable)",
            status="skip",
        )

    # Try login API
    try:
        conn = http.client.HTTPConnection(target, 80, timeout=5)
        login_body = json.dumps({"username": "admin", "password": "admin"})
        conn.request(
            "POST", "/files/api/login",
            body=login_body,
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        token_raw = resp.read(4096).decode("utf-8", errors="replace")
        conn.close()

        if resp.status != 200:
            return _finding(
                "SEC-307", "critical",
                "FileBrowser default admin login rejected",
                evidence="Login returned HTTP {}".format(resp.status),
                status="pass",
            )

        # Token is returned as plain string or JSON
        token = token_raw.strip().strip('"')

        # Get user info to check scope
        conn2 = http.client.HTTPConnection(target, 80, timeout=5)
        conn2.request(
            "GET", "/files/api/users/1",
            headers={
                "X-Auth": token,
                "Cookie": "auth={}".format(token),
            },
        )
        resp2 = conn2.getresponse()
        user_body = resp2.read(4096).decode("utf-8", errors="replace")
        conn2.close()

        if resp2.status == 200:
            try:
                user_data = json.loads(user_body)
                scope = user_data.get("scope", "")
                if scope in (".", "/", ""):
                    return _finding(
                        "SEC-307", "critical",
                        "FileBrowser admin has unrestricted scope",
                        evidence="Admin scope='{}' — full filesystem access.".format(scope),
                        remediation=(
                            "Change FileBrowser admin scope to a specific directory "
                            "(e.g., /mnt/data) via 'filebrowser users update admin --scope /mnt/data'."
                        ),
                        status="fail",
                    )
                return _finding(
                    "SEC-307", "critical",
                    "FileBrowser admin scope is restricted",
                    evidence="scope='{}'".format(scope),
                    status="pass",
                )
            except (ValueError, KeyError):
                pass

        return _finding(
            "SEC-307", "critical",
            "FileBrowser scope check inconclusive",
            evidence="Could not parse user info (HTTP {}).".format(resp2.status),
            status="error",
        )
    except Exception as exc:
        return _finding(
            "SEC-307", "critical",
            "FileBrowser scope check error",
            evidence=str(exc),
            status="error",
        )


# -------------------------------------------------------
# WebDAV unauthenticated access
# -------------------------------------------------------

def _check_webdav_noauth(ctx):
    """SEC-308: WebDAV accessible without authentication on port 8091."""
    target = ctx.get("target", "127.0.0.1")

    try:
        conn = http.client.HTTPConnection(target, 8091, timeout=5)
        conn.request("PROPFIND", "/webdav/", headers={"Depth": "0"})
        resp = conn.getresponse()
        body = resp.read(2048).decode("utf-8", errors="replace")
        conn.close()

        if resp.status == 207:
            return _finding(
                "SEC-308", "medium",
                "WebDAV accessible without authentication",
                evidence="PROPFIND on {}:8091/webdav/ returned HTTP 207 (Multi-Status).".format(target),
                remediation="Ensure Apache WebDAV config requires Digest authentication.",
                status="fail",
            )
        elif resp.status == 401:
            return _finding(
                "SEC-308", "medium",
                "WebDAV requires authentication",
                evidence="PROPFIND returned HTTP 401.",
                status="pass",
            )
        else:
            return _finding(
                "SEC-308", "medium",
                "WebDAV check inconclusive",
                evidence="PROPFIND returned HTTP {}.".format(resp.status),
                status="error",
            )
    except (ConnectionRefusedError, socket.timeout):
        return _finding(
            "SEC-308", "medium",
            "WebDAV check skipped (port 8091 not reachable)",
            status="skip",
        )
    except OSError as exc:
        return _finding(
            "SEC-308", "medium",
            "WebDAV check error",
            evidence=str(exc),
            status="error",
        )


# -------------------------------------------------------
# Main entry
# -------------------------------------------------------

def run(ctx):
    findings = []

    findings.extend(_check_nfs_exports(ctx))
    findings.append(_check_smb_anon(ctx))
    findings.extend(_check_rsync(ctx))
    findings.append(_check_ftp_anon(ctx))
    findings.append(_check_forced_browsing(ctx))
    findings.append(_check_filebrowser_scope(ctx))
    findings.append(_check_webdav_noauth(ctx))

    return findings
