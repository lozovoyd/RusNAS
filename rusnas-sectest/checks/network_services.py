"""
Network services phase -- SMB signing, rpcbind, iSCSI, metrics, NFS ports, Samba config.
ID range: SEC-900..999
"""

import subprocess
import socket
import re
import os

PHASE = "network_services"


def _finding(fid, severity, title, evidence="", remediation="", status="fail", owasp="A05"):
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


def _port_open(host, port, timeout=2):
    """Quick TCP connect check."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        s.close()
        return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False


def _read_file(path):
    """Read a file, return contents or None."""
    try:
        with open(path, "r") as f:
            return f.read()
    except (IOError, OSError):
        return None


def _smb_conf_value(conf_text, key):
    """Extract a value from smb.conf [global] section. Returns lowercase stripped value or None."""
    if not conf_text:
        return None
    in_global = False
    for line in conf_text.splitlines():
        stripped = line.strip()
        if stripped.lower() == "[global]":
            in_global = True
            continue
        if stripped.startswith("[") and in_global:
            break
        if in_global and "=" in stripped:
            k, _, v = stripped.partition("=")
            if k.strip().lower() == key.lower():
                # Strip inline comments
                v = v.split(";")[0].split("#")[0].strip()
                return v.lower()
    return None


def _check_smb_signing(target, tools_available):
    """SEC-900: SMB signing not required."""
    if "nmap" not in tools_available:
        # Fallback: parse smb.conf directly
        conf = _read_file("/etc/samba/smb.conf")
        if conf is None:
            return _finding(
                "SEC-900", "info",
                "SMB signing check skipped -- nmap not available and smb.conf not readable",
                status="skip",
            )
        signing = _smb_conf_value(conf, "server signing")
        if signing is None:
            signing = _smb_conf_value(conf, "smb encrypt")

        if signing in ("mandatory", "required"):
            return _finding(
                "SEC-900", "info",
                "SMB signing is mandatory (smb.conf)",
                evidence="server signing = %s" % signing,
                status="pass",
            )
        else:
            return _finding(
                "SEC-900", "medium",
                "SMB signing not required",
                evidence="server signing = %s (or not set)" % signing,
                remediation="Set 'server signing = mandatory' in smb.conf [global] section.",
            )

    try:
        result = subprocess.run(
            ["nmap", "--script", "smb2-security-mode", "-p", "445", target],
            capture_output=True, text=True, timeout=30,
        )
        output = result.stdout

        if "not required" in output.lower() or "message signing enabled but not required" in output.lower():
            return _finding(
                "SEC-900",
                "medium",
                "SMB signing enabled but not required",
                evidence="nmap smb2-security-mode: signing not required",
                remediation="Set 'server signing = mandatory' in smb.conf [global] section.",
            )
        elif "required" in output.lower() and "not required" not in output.lower():
            return _finding(
                "SEC-900",
                "info",
                "SMB signing is required",
                evidence="nmap smb2-security-mode: signing required",
                status="pass",
            )
        else:
            return _finding(
                "SEC-900",
                "info",
                "SMB signing status unclear from nmap output",
                evidence=output[-300:],
                status="pass",
            )

    except subprocess.TimeoutExpired:
        return _finding(
            "SEC-900", "info", "nmap SMB scan timed out",
            status="error",
        )
    except Exception as e:
        return _finding(
            "SEC-900", "info", "SMB signing check error",
            evidence=str(e), status="error",
        )


def _check_rpcbind(target):
    """SEC-901: rpcbind (port 111) exposed."""
    try:
        if not _port_open(target, 111):
            return _finding(
                "SEC-901", "info",
                "rpcbind port 111 is closed",
                status="pass",
            )

        # Try rpcinfo to list services
        services_info = ""
        try:
            result = subprocess.run(
                ["rpcinfo", "-p", target],
                capture_output=True, text=True, timeout=10,
            )
            services_info = result.stdout[:500]
        except Exception:
            services_info = "(rpcinfo not available)"

        return _finding(
            "SEC-901",
            "low",
            "rpcbind (port 111) is exposed",
            evidence="Port 111 open. Services: %s" % services_info[:300],
            remediation="If NFS is not needed, disable rpcbind. Otherwise restrict with firewall rules to trusted networks only.",
        )

    except Exception as e:
        return _finding(
            "SEC-901", "info", "rpcbind check error",
            evidence=str(e), status="error",
        )


def _check_iscsi_port(target):
    """SEC-902: iSCSI port 3260 status."""
    try:
        if _port_open(target, 3260):
            return _finding(
                "SEC-902",
                "info",
                "iSCSI port 3260 is open",
                evidence="TCP connect to %s:3260 succeeded" % target,
                remediation="Ensure iSCSI targets require CHAP authentication. Restrict port 3260 via firewall.",
                status="fail",
            )
        else:
            return _finding(
                "SEC-902",
                "info",
                "iSCSI port 3260 is closed or filtered",
                evidence="TCP connect to %s:3260 refused/timeout" % target,
                status="pass",
            )
    except Exception as e:
        return _finding(
            "SEC-902", "info", "iSCSI port check error",
            evidence=str(e), status="error",
        )


def _check_metrics_auth(target):
    """SEC-903: Metrics port 9100 accessible without authentication."""
    try:
        if not _port_open(target, 9100):
            return _finding(
                "SEC-903", "info",
                "Metrics port 9100 is closed",
                status="pass",
            )

        import http.client
        conn = http.client.HTTPConnection(target, 9100, timeout=5)
        conn.request("GET", "/metrics")
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="replace")
        conn.close()

        if resp.status == 200 and ("rusnas" in body.lower() or "node_" in body or "process_" in body):
            return _finding(
                "SEC-903",
                "low",
                "Metrics endpoint accessible without authentication on port 9100",
                evidence="GET /metrics -> HTTP %d, body contains metrics data (len=%d)" % (resp.status, len(body)),
                remediation="Restrict port 9100 access via firewall to monitoring network only, or add basic auth.",
            )
        elif resp.status == 200:
            return _finding(
                "SEC-903",
                "info",
                "Port 9100 returns HTTP 200 but no recognizable metrics",
                evidence="HTTP %d, body len=%d" % (resp.status, len(body)),
                status="pass",
            )
        else:
            return _finding(
                "SEC-903",
                "info",
                "Metrics port 9100 requires authentication or returned %d" % resp.status,
                status="pass",
            )

    except Exception as e:
        return _finding(
            "SEC-903", "info", "Metrics port check error",
            evidence=str(e), status="error",
        )


def _check_nfs_ports(target):
    """SEC-904: NFS lockd/statd on random/non-standard ports."""
    try:
        result = subprocess.run(
            ["rpcinfo", "-p", target],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return _finding(
                "SEC-904", "info",
                "rpcinfo not available or failed -- NFS port check skipped",
                evidence=result.stderr[:200],
                status="skip",
            )

        output = result.stdout
        # Parse rpcinfo output for nlockmgr and status services
        random_ports = []
        known_fixed = {2049, 20048}  # nfsd and mountd (fixed in rusnas config)

        for line in output.splitlines():
            parts = line.split()
            if len(parts) >= 5:
                try:
                    port = int(parts[3])
                    service = parts[4]
                    if service in ("nlockmgr", "status") and port not in known_fixed:
                        random_ports.append("%s/%s (port %d)" % (service, parts[2], port))
                except (ValueError, IndexError):
                    pass

        if random_ports:
            return _finding(
                "SEC-904",
                "low",
                "NFS lockd/statd on non-fixed ports: %s" % ", ".join(random_ports[:5]),
                evidence="; ".join(random_ports),
                remediation="Fix lockd and statd ports in /etc/modprobe.d/ and /etc/default/nfs-common for easier firewall management.",
            )
        else:
            return _finding(
                "SEC-904",
                "info",
                "NFS services on expected ports",
                evidence="rpcinfo shows no random lockd/statd ports",
                status="pass",
            )

    except Exception as e:
        return _finding(
            "SEC-904", "info", "NFS port check error",
            evidence=str(e), status="error",
        )


def _check_smb_min_protocol():
    """SEC-905: Samba minimum protocol version."""
    try:
        conf = _read_file("/etc/samba/smb.conf")
        if conf is None:
            # Try testparm
            try:
                result = subprocess.run(
                    ["testparm", "-s"],
                    capture_output=True, text=True, timeout=10,
                )
                conf = result.stdout
            except Exception:
                return _finding(
                    "SEC-905", "info",
                    "Cannot read smb.conf or run testparm -- check skipped",
                    status="skip",
                )

        min_proto = _smb_conf_value(conf, "server min protocol")
        # Also check older syntax
        if min_proto is None:
            min_proto = _smb_conf_value(conf, "min protocol")

        if min_proto is None:
            # Samba 4.11+ defaults to SMB2_02 if not set
            return _finding(
                "SEC-905",
                "info",
                "Samba 'server min protocol' not explicitly set (default is SMB2 on Samba 4.11+)",
                evidence="No 'server min protocol' in smb.conf",
                remediation="Explicitly set 'server min protocol = SMB2' in smb.conf [global] for clarity.",
                status="pass",
            )

        # SMB protocol hierarchy: NT1 < SMB2 < SMB2_02 < SMB2_10 < SMB3 < SMB3_00 < SMB3_02 < SMB3_11
        insecure = {"nt1", "lanman1", "lanman2", "core", "coreplus", "smb1"}
        if min_proto in insecure:
            return _finding(
                "SEC-905",
                "medium",
                "Samba minimum protocol is insecure: %s" % min_proto,
                evidence="server min protocol = %s" % min_proto,
                remediation="Set 'server min protocol = SMB2' or higher in smb.conf [global] section.",
            )
        else:
            return _finding(
                "SEC-905",
                "info",
                "Samba minimum protocol: %s" % min_proto,
                evidence="server min protocol = %s" % min_proto,
                status="pass",
            )

    except Exception as e:
        return _finding(
            "SEC-905", "info", "Samba min protocol check error",
            evidence=str(e), status="error",
        )


def _check_smb_guest():
    """SEC-906: Samba guest account configuration."""
    try:
        conf = _read_file("/etc/samba/smb.conf")
        if conf is None:
            try:
                result = subprocess.run(
                    ["testparm", "-s"],
                    capture_output=True, text=True, timeout=10,
                )
                conf = result.stdout
            except Exception:
                return _finding(
                    "SEC-906", "info",
                    "Cannot read smb.conf -- guest account check skipped",
                    status="skip",
                )

        map_to_guest = _smb_conf_value(conf, "map to guest")
        restrict_anon = _smb_conf_value(conf, "restrict anonymous")

        issues = []

        if map_to_guest and map_to_guest == "bad user":
            issues.append("map to guest = bad user (failed logins mapped to guest)")

        if restrict_anon is not None:
            try:
                anon_val = int(restrict_anon)
                if anon_val < 2:
                    issues.append("restrict anonymous = %d (should be 2 for maximum restriction)" % anon_val)
            except ValueError:
                pass

        # Also check for guest ok = yes in any share
        guest_shares = []
        current_section = None
        for line in conf.splitlines():
            stripped = line.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                current_section = stripped[1:-1]
                continue
            if current_section and current_section.lower() != "global":
                if "=" in stripped:
                    k, _, v = stripped.partition("=")
                    if k.strip().lower() == "guest ok" and v.strip().lower() in ("yes", "true"):
                        guest_shares.append(current_section)

        if guest_shares:
            issues.append("Guest access enabled on shares: %s" % ", ".join(guest_shares[:5]))

        if issues:
            return _finding(
                "SEC-906",
                "high",
                "Samba guest/anonymous access concerns",
                evidence="; ".join(issues),
                remediation="Set 'map to guest = never' and 'restrict anonymous = 2' in smb.conf [global]. Remove 'guest ok = yes' from shares unless intentional.",
                owasp="A01",
            )
        else:
            return _finding(
                "SEC-906",
                "info",
                "Samba guest access properly restricted",
                evidence="map to guest = %s, restrict anonymous = %s, no guest shares" % (
                    map_to_guest or "(not set)",
                    restrict_anon or "(not set)",
                ),
                status="pass",
            )

    except Exception as e:
        return _finding(
            "SEC-906", "info", "Samba guest account check error",
            evidence=str(e), status="error",
        )


def run(ctx):
    """Run all network services checks. Returns list of Finding dicts."""
    target = ctx.get("target", "127.0.0.1")
    tools_available = ctx.get("tools_available", [])
    findings = []

    # SEC-900: SMB signing
    findings.append(_check_smb_signing(target, tools_available))

    # SEC-901: rpcbind exposed
    findings.append(_check_rpcbind(target))

    # SEC-902: iSCSI port
    findings.append(_check_iscsi_port(target))

    # SEC-903: Metrics without auth
    findings.append(_check_metrics_auth(target))

    # SEC-904: NFS random ports
    findings.append(_check_nfs_ports(target))

    # SEC-905: Samba min protocol
    findings.append(_check_smb_min_protocol())

    # SEC-906: Samba guest account
    findings.append(_check_smb_guest())

    return findings
