"""
Misconfiguration phase -- HTTP method checks, CORS, banners, directory listing.
ID range: SEC-600..699
"""

import http.client
import socket
import ssl
import re

PHASE = "misconfiguration"


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


def _http_request(method, host, port, path, headers=None, body=None, timeout=5):
    """Plain HTTP request. Returns (status, headers_dict, body_str)."""
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        hdrs = headers or {}
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        resp_body = resp.read().decode("utf-8", errors="replace")
        resp_hdrs = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, resp_hdrs, resp_body
    finally:
        conn.close()


def _check_directory_listing(target):
    """SEC-600: Check for directory listing on common paths."""
    paths = ["/", "/images/", "/uploads/", "/static/", "/icons/", "/assets/"]
    listed = []

    for path in paths:
        try:
            status, hdrs, body = _http_request("GET", target, 80, path)
            if status == 200 and ("Index of" in body or "<title>Index of" in body):
                listed.append("port 80 %s" % path)
        except Exception:
            pass

    if listed:
        return _finding(
            "SEC-600",
            "medium",
            "Directory listing enabled on %d path(s)" % len(listed),
            evidence=", ".join(listed),
            remediation="Disable autoindex in nginx: remove 'autoindex on;' or set 'autoindex off;'.",
        )
    else:
        return _finding(
            "SEC-600",
            "info",
            "No directory listing detected",
            evidence="Checked %d paths on port 80" % len(paths),
            status="pass",
        )


def _check_trace_method(target):
    """SEC-601: TRACE method enabled check."""
    try:
        status, hdrs, body = _http_request("TRACE", target, 80, "/")
        if status == 200 and ("TRACE / HTTP" in body or "trace" in body.lower()[:200]):
            return _finding(
                "SEC-601",
                "medium",
                "HTTP TRACE method enabled on port 80",
                evidence="TRACE / -> HTTP %d, body echoed" % status,
                remediation="Disable TRACE method in nginx with 'if ($request_method = TRACE) { return 405; }'.",
            )
        else:
            return _finding(
                "SEC-601",
                "info",
                "TRACE method not enabled (HTTP %d)" % status,
                status="pass",
            )
    except Exception as e:
        return _finding(
            "SEC-601", "info", "TRACE method check error",
            evidence=str(e), status="error",
        )


def _check_unnecessary_methods(target):
    """SEC-602: Check OPTIONS response for unnecessary HTTP methods."""
    try:
        status, hdrs, body = _http_request("OPTIONS", target, 80, "/")
        allow = hdrs.get("allow", "")
        if not allow:
            return _finding(
                "SEC-602",
                "info",
                "OPTIONS request returned no Allow header",
                evidence="OPTIONS / -> HTTP %d, no Allow header" % status,
                status="pass",
            )

        dangerous = {"PUT", "DELETE", "PATCH", "TRACE", "CONNECT"}
        methods = set(m.strip().upper() for m in allow.split(","))
        exposed = methods & dangerous

        if exposed:
            return _finding(
                "SEC-602",
                "low",
                "Unnecessary HTTP methods advertised: %s" % ", ".join(sorted(exposed)),
                evidence="Allow: %s" % allow,
                remediation="Restrict allowed HTTP methods in nginx to GET, POST, HEAD only where applicable.",
            )
        else:
            return _finding(
                "SEC-602",
                "info",
                "Only standard methods advertised: %s" % allow,
                status="pass",
            )

    except Exception as e:
        return _finding(
            "SEC-602", "info", "OPTIONS method check error",
            evidence=str(e), status="error",
        )


def _check_cors(target):
    """SEC-603: CORS misconfiguration -- reflect arbitrary Origin."""
    try:
        evil_origin = "https://evil.com"
        status, hdrs, body = _http_request(
            "GET", target, 80, "/",
            headers={"Origin": evil_origin},
        )
        acao = hdrs.get("access-control-allow-origin", "")

        if acao == evil_origin or acao == "*":
            sev = "high" if acao == evil_origin else "medium"
            return _finding(
                "SEC-603",
                sev,
                "CORS allows arbitrary origin" if acao == evil_origin else "CORS allows wildcard origin",
                evidence="Origin: %s -> Access-Control-Allow-Origin: %s" % (evil_origin, acao),
                remediation="Configure CORS to only allow trusted origins. Remove 'Access-Control-Allow-Origin: *' or reflected origin.",
                owasp="A01",
            )
        else:
            return _finding(
                "SEC-603",
                "info",
                "CORS not misconfigured (no reflection of evil origin)",
                evidence="ACAO: '%s'" % acao if acao else "No ACAO header",
                status="pass",
            )

    except Exception as e:
        return _finding(
            "SEC-603", "info", "CORS check error",
            evidence=str(e), status="error",
        )


def _check_ftp_banner(target):
    """SEC-604: FTP banner version disclosure."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect((target, 21))
        banner = s.recv(1024).decode("utf-8", errors="replace").strip()
        s.close()

        # Look for version info like "vsFTPd 3.0.5" etc.
        version_match = re.search(r"(\d+\.\d+[\.\d]*)", banner)
        if version_match:
            return _finding(
                "SEC-604",
                "low",
                "FTP banner discloses version: %s" % banner[:120],
                evidence=banner[:200],
                remediation="Set 'ftpd_banner=Welcome' in vsftpd.conf to hide version information.",
            )
        elif banner:
            return _finding(
                "SEC-604",
                "info",
                "FTP banner present but no version disclosed",
                evidence=banner[:200],
                status="pass",
            )
        else:
            return _finding(
                "SEC-604", "info", "FTP: empty banner",
                status="pass",
            )

    except socket.timeout:
        return _finding(
            "SEC-604", "info", "FTP port 21 timeout (may be closed)",
            status="skip",
        )
    except ConnectionRefusedError:
        return _finding(
            "SEC-604", "info", "FTP port 21 refused (service not running)",
            status="skip",
        )
    except Exception as e:
        return _finding(
            "SEC-604", "info", "FTP banner check error",
            evidence=str(e), status="error",
        )


def _check_ssh_banner(target):
    """SEC-605: SSH version banner disclosure."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect((target, 22))
        banner = s.recv(1024).decode("utf-8", errors="replace").strip()
        s.close()

        # SSH banners look like "SSH-2.0-OpenSSH_9.2p1 Debian-2"
        if re.search(r"SSH-\d+\.\d+-\S+", banner):
            # Check if OS info is disclosed
            os_info = re.search(r"(Debian|Ubuntu|CentOS|RHEL|Fedora)", banner, re.IGNORECASE)
            if os_info:
                return _finding(
                    "SEC-605",
                    "low",
                    "SSH banner discloses version and OS: %s" % banner[:120],
                    evidence=banner[:200],
                    remediation="Consider changing SSH banner via 'DebianBanner no' in sshd_config.",
                )
            else:
                return _finding(
                    "SEC-605",
                    "low",
                    "SSH banner discloses version: %s" % banner[:120],
                    evidence=banner[:200],
                    remediation="The SSH version disclosure is standard. Suppress OS details with 'DebianBanner no'.",
                )
        else:
            return _finding(
                "SEC-605", "info", "SSH banner: %s" % banner[:120],
                status="pass",
            )

    except ConnectionRefusedError:
        return _finding(
            "SEC-605", "info", "SSH port 22 refused",
            status="skip",
        )
    except Exception as e:
        return _finding(
            "SEC-605", "info", "SSH banner check error",
            evidence=str(e), status="error",
        )


def _check_nginx_catchall(target):
    """SEC-606: nginx serves content for unknown/random paths instead of 404."""
    try:
        import random
        import string
        rand_path = "/" + "".join(random.choices(string.ascii_lowercase, k=12))
        status, hdrs, body = _http_request("GET", target, 80, rand_path)

        if status == 200:
            # Check if it is the landing page being served
            is_landing = "rusnas" in body.lower() or "<!doctype html>" in body.lower()[:100]
            return _finding(
                "SEC-606",
                "low",
                "nginx catch-all returns HTTP 200 for unknown path %s" % rand_path,
                evidence="GET %s -> HTTP %d (body len=%d, landing=%s)" % (
                    rand_path, status, len(body), is_landing),
                remediation="Consider configuring nginx to return 404 for unrecognized paths.",
            )
        elif status == 404:
            return _finding(
                "SEC-606",
                "info",
                "nginx returns 404 for unknown paths",
                evidence="GET %s -> HTTP %d" % (rand_path, status),
                status="pass",
            )
        else:
            return _finding(
                "SEC-606",
                "info",
                "nginx returns HTTP %d for unknown path" % status,
                evidence="GET %s -> HTTP %d" % (rand_path, status),
                status="pass",
            )

    except Exception as e:
        return _finding(
            "SEC-606", "info", "nginx catch-all check error",
            evidence=str(e), status="error",
        )


def _check_cockpit_robots(target):
    """SEC-607: Cockpit robots.txt should have Disallow: /."""
    try:
        ctx_ssl = ssl._create_unverified_context()
        conn = http.client.HTTPSConnection(target, 9090, timeout=5, context=ctx_ssl)
        conn.request("GET", "/robots.txt")
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="replace")
        conn.close()

        if resp.status == 200 and "disallow: /" in body.lower():
            return _finding(
                "SEC-607",
                "info",
                "Cockpit robots.txt has Disallow: /",
                evidence="robots.txt present, disallowing crawlers",
                status="pass",
            )
        elif resp.status == 200:
            return _finding(
                "SEC-607",
                "info",
                "Cockpit robots.txt exists but may not fully disallow crawling",
                evidence="HTTP 200, body: %s" % body[:200],
                remediation="Ensure robots.txt contains 'Disallow: /' to prevent search engine indexing.",
                status="fail",
            )
        else:
            return _finding(
                "SEC-607",
                "info",
                "Cockpit has no robots.txt (HTTP %d)" % resp.status,
                evidence="GET /robots.txt -> HTTP %d" % resp.status,
                remediation="Add robots.txt with 'Disallow: /' to Cockpit.",
                status="fail",
            )

    except Exception as e:
        return _finding(
            "SEC-607", "info", "Cockpit robots.txt check error",
            evidence=str(e), status="error",
        )


def run(ctx):
    """Run all misconfiguration checks. Returns list of Finding dicts."""
    target = ctx.get("target", "127.0.0.1")
    findings = []

    # SEC-600: Directory listing
    findings.append(_check_directory_listing(target))

    # SEC-601: TRACE method
    findings.append(_check_trace_method(target))

    # SEC-602: Unnecessary HTTP methods
    findings.append(_check_unnecessary_methods(target))

    # SEC-603: CORS misconfiguration
    findings.append(_check_cors(target))

    # SEC-604: FTP banner
    findings.append(_check_ftp_banner(target))

    # SEC-605: SSH banner
    findings.append(_check_ssh_banner(target))

    # SEC-606: nginx catch-all
    findings.append(_check_nginx_catchall(target))

    # SEC-607: Cockpit robots.txt
    findings.append(_check_cockpit_robots(target))

    return findings
