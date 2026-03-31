"""
Web security checks — HTTP headers, TLS configuration, certificate expiry.
ID range: SEC-200..299
"""

import http.client
import subprocess
import ssl
import socket
import re
from datetime import datetime, timezone

PHASE = "web_security"


def _finding(fid, severity, title, evidence="", remediation="", status="fail"):
    return {
        "id": fid,
        "phase": PHASE,
        "owasp": "A05",
        "severity": severity,
        "title": title,
        "evidence": evidence,
        "remediation": remediation,
        "status": status,
    }


def _get_headers(host, port, use_https=False, path="/", timeout=5):
    """Return (dict of lowercase-header->value, status_code) or (None, None) on error."""
    try:
        if use_https:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=ctx)
        else:
            conn = http.client.HTTPConnection(host, port, timeout=timeout)
        conn.request("GET", path)
        resp = conn.getresponse()
        headers = {k.lower(): v for k, v in resp.getheaders()}
        status = resp.status
        conn.close()
        return headers, status
    except Exception:
        return None, None


def _check_header(headers, header_name, fid, severity, title, remediation):
    """Return a Finding for a missing header."""
    val = headers.get(header_name.lower())
    if val:
        return _finding(
            fid, severity, title,
            evidence="{}: {}".format(header_name, val),
            status="pass",
        )
    return _finding(
        fid, severity, title,
        evidence="Header '{}' is not set.".format(header_name),
        remediation=remediation,
        status="fail",
    )


def _test_tls_version(host, port, tls_ver_flag, tls_label, timeout=5):
    """Use openssl s_client to test if a specific TLS version is accepted.
    Returns True if accepted, False if rejected, None on error."""
    try:
        result = subprocess.run(
            [
                "openssl", "s_client",
                "-connect", "{}:{}".format(host, port),
                tls_ver_flag,
            ],
            input=b"",
            capture_output=True,
            timeout=timeout,
        )
        stdout = result.stdout.decode("utf-8", errors="replace")
        stderr = result.stderr.decode("utf-8", errors="replace")
        combined = stdout + stderr
        # If we see "CONNECTED" and a protocol line, it was accepted
        if "CONNECTED" in combined:
            if re.search(r"Protocol\s*:\s*" + re.escape(tls_label), combined):
                return True
            # Some openssl versions report error after CONNECTED
            if "error" in combined.lower() or "alert" in combined.lower():
                return False
            # If no protocol line but no error, treat as possibly accepted
            return True
        return False
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def _get_cert_expiry(host, port, timeout=5):
    """Return (datetime_expiry, subject_cn) or (None, None)."""
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                cert = ssock.getpeercert(binary_form=False)
                if not cert:
                    # getpeercert returns {} when verify_mode=CERT_NONE
                    # Use openssl as fallback
                    raise ValueError("empty cert dict")
                not_after = cert.get("notAfter", "")
                # Format: 'Mar 25 12:00:00 2027 GMT'
                expiry = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z")
                expiry = expiry.replace(tzinfo=timezone.utc)
                subj = dict(x[0] for x in cert.get("subject", ()))
                cn = subj.get("commonName", "")
                return expiry, cn
    except Exception:
        pass
    # Fallback: use openssl s_client + x509
    try:
        proc = subprocess.run(
            ["openssl", "s_client", "-connect", "{}:{}".format(host, port),
             "-servername", host],
            input=b"",
            capture_output=True,
            timeout=timeout,
        )
        pem = proc.stdout.decode("utf-8", errors="replace")
        # Extract the certificate
        m = re.search(
            r"(-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----)",
            pem, re.DOTALL,
        )
        if not m:
            return None, None
        cert_pem = m.group(1)
        proc2 = subprocess.run(
            ["openssl", "x509", "-noout", "-enddate", "-subject"],
            input=cert_pem.encode(),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        out = proc2.stdout
        expiry = None
        cn = ""
        em = re.search(r"notAfter=(.+)", out)
        if em:
            raw_date = em.group(1).strip()
            for fmt in ("%b %d %H:%M:%S %Y %Z", "%b  %d %H:%M:%S %Y %Z"):
                try:
                    expiry = datetime.strptime(raw_date, fmt)
                    expiry = expiry.replace(tzinfo=timezone.utc)
                    break
                except ValueError:
                    continue
        cm = re.search(r"CN\s*=\s*([^\n/,]+)", out)
        if cm:
            cn = cm.group(1).strip()
        return expiry, cn
    except Exception:
        return None, None


def run(ctx):
    findings = []
    target = ctx.get("target", "127.0.0.1")
    ports = ctx.get("ports", {})

    # -------------------------------------------------------
    # nginx on port 80
    # -------------------------------------------------------
    nginx_headers, nginx_status = _get_headers(target, 80)
    if nginx_headers is None:
        findings.append(
            _finding(
                "SEC-200", "info",
                "nginx (port 80) not reachable",
                evidence="Could not connect to {}:80".format(target),
                status="skip",
            )
        )
    else:
        # SEC-200: X-Frame-Options
        findings.append(
            _check_header(
                nginx_headers, "X-Frame-Options",
                "SEC-200", "medium",
                "nginx missing X-Frame-Options",
                "Add 'add_header X-Frame-Options SAMEORIGIN;' to nginx config.",
            )
        )

        # SEC-201: X-Content-Type-Options
        findings.append(
            _check_header(
                nginx_headers, "X-Content-Type-Options",
                "SEC-201", "medium",
                "nginx missing X-Content-Type-Options",
                "Add 'add_header X-Content-Type-Options nosniff;' to nginx config.",
            )
        )

        # SEC-202: Content-Security-Policy
        findings.append(
            _check_header(
                nginx_headers, "Content-Security-Policy",
                "SEC-202", "medium",
                "nginx missing Content-Security-Policy",
                "Add a Content-Security-Policy header to nginx config.",
            )
        )

        # SEC-203: Strict-Transport-Security (only if 443 is open)
        has_443 = 443 in ports
        if has_443:
            findings.append(
                _check_header(
                    nginx_headers, "Strict-Transport-Security",
                    "SEC-203", "low",
                    "nginx missing Strict-Transport-Security",
                    "Add 'add_header Strict-Transport-Security \"max-age=63072000; includeSubDomains\";'.",
                )
            )
        else:
            findings.append(
                _finding(
                    "SEC-203", "low",
                    "HSTS check skipped (port 443 not open)",
                    status="skip",
                )
            )

        # SEC-204: Referrer-Policy
        findings.append(
            _check_header(
                nginx_headers, "Referrer-Policy",
                "SEC-204", "low",
                "nginx missing Referrer-Policy",
                "Add 'add_header Referrer-Policy strict-origin-when-cross-origin;'.",
            )
        )

        # SEC-213: Server version disclosure
        server_hdr = nginx_headers.get("server", "")
        if re.search(r"nginx/[\d.]+", server_hdr):
            findings.append(
                _finding(
                    "SEC-213", "low",
                    "Server version disclosed in headers",
                    evidence="Server: {}".format(server_hdr),
                    remediation="Set 'server_tokens off;' in nginx.conf.",
                    status="fail",
                )
            )
        else:
            findings.append(
                _finding(
                    "SEC-213", "low",
                    "Server version not disclosed",
                    evidence="Server: {}".format(server_hdr or "(not set)"),
                    status="pass",
                )
            )

    # -------------------------------------------------------
    # Cockpit on port 9090 (HTTPS)
    # -------------------------------------------------------
    cockpit_headers, cockpit_status = _get_headers(target, 9090, use_https=True)
    if cockpit_headers is None:
        findings.append(
            _finding(
                "SEC-205", "info",
                "Cockpit (port 9090) not reachable",
                evidence="Could not connect to {}:9090 (HTTPS)".format(target),
                status="skip",
            )
        )
    else:
        # SEC-205: Cockpit security headers
        missing = []
        for hdr in ("content-security-policy", "x-frame-options", "x-content-type-options"):
            if hdr not in cockpit_headers:
                missing.append(hdr)
        if missing:
            findings.append(
                _finding(
                    "SEC-205", "info",
                    "Cockpit missing security headers",
                    evidence="Missing: {}".format(", ".join(missing)),
                    remediation="Cockpit manages its own headers; check /etc/cockpit/cockpit.conf.",
                    status="fail",
                )
            )
        else:
            findings.append(
                _finding(
                    "SEC-205", "info",
                    "Cockpit security headers present",
                    evidence="CSP, X-Frame-Options, X-Content-Type-Options all set.",
                    status="pass",
                )
            )

    # -------------------------------------------------------
    # TLS checks
    # -------------------------------------------------------
    has_openssl = ctx.get("tools_available", {}).get("openssl", True)

    # SEC-210: TLS on port 9090
    if has_openssl and 9090 in ports:
        weak_accepted = []
        for flag, label in [("-tls1", "TLSv1"), ("-tls1_1", "TLSv1.1")]:
            accepted = _test_tls_version(target, 9090, flag, label)
            if accepted is True:
                weak_accepted.append(label)
        if weak_accepted:
            findings.append(
                _finding(
                    "SEC-210", "medium",
                    "Cockpit accepts weak TLS versions",
                    evidence="Accepted: {}".format(", ".join(weak_accepted)),
                    remediation="Disable TLS 1.0/1.1 in Cockpit TLS config.",
                    status="fail",
                )
            )
        else:
            findings.append(
                _finding(
                    "SEC-210", "medium",
                    "Cockpit rejects TLS 1.0/1.1",
                    status="pass",
                )
            )
    else:
        findings.append(
            _finding("SEC-210", "medium", "TLS check on port 9090 skipped",
                     status="skip")
        )

    # SEC-211: TLS on port 443
    if has_openssl and 443 in ports:
        weak_accepted = []
        for flag, label in [("-tls1", "TLSv1"), ("-tls1_1", "TLSv1.1")]:
            accepted = _test_tls_version(target, 443, flag, label)
            if accepted is True:
                weak_accepted.append(label)
        if weak_accepted:
            findings.append(
                _finding(
                    "SEC-211", "medium",
                    "HTTPS (443) accepts weak TLS versions",
                    evidence="Accepted: {}".format(", ".join(weak_accepted)),
                    remediation="Set ssl_protocols TLSv1.2 TLSv1.3; in nginx.",
                    status="fail",
                )
            )
        else:
            findings.append(
                _finding(
                    "SEC-211", "medium",
                    "HTTPS (443) rejects TLS 1.0/1.1",
                    status="pass",
                )
            )
    else:
        findings.append(
            _finding("SEC-211", "medium", "TLS check on port 443 skipped",
                     status="skip")
        )

    # SEC-212: Certificate expiry on port 9090
    if 9090 in ports:
        expiry, cn = _get_cert_expiry(target, 9090)
        if expiry is None:
            findings.append(
                _finding(
                    "SEC-212", "low",
                    "Could not retrieve certificate from port 9090",
                    status="error",
                )
            )
        else:
            now = datetime.now(timezone.utc)
            days_left = (expiry - now).days
            if days_left < 0:
                findings.append(
                    _finding(
                        "SEC-212", "medium",
                        "SSL certificate on port 9090 is EXPIRED",
                        evidence="CN={}, expired {} days ago (notAfter={})".format(
                            cn, abs(days_left), expiry.isoformat()
                        ),
                        remediation="Renew the certificate immediately.",
                        status="fail",
                    )
                )
            elif days_left < 30:
                findings.append(
                    _finding(
                        "SEC-212", "low",
                        "SSL certificate on port 9090 expires soon",
                        evidence="CN={}, {} days remaining (notAfter={})".format(
                            cn, days_left, expiry.isoformat()
                        ),
                        remediation="Renew the certificate before expiry.",
                        status="fail",
                    )
                )
            else:
                findings.append(
                    _finding(
                        "SEC-212", "low",
                        "SSL certificate on port 9090 valid",
                        evidence="CN={}, {} days remaining".format(cn, days_left),
                        status="pass",
                    )
                )
    else:
        findings.append(
            _finding("SEC-212", "low", "Certificate expiry check skipped (port 9090 not open)",
                     status="skip")
        )

    return findings
