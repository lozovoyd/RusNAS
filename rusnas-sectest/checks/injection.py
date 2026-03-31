"""
Injection phase -- SQL injection, XSS, SSTI, header injection, command injection.
ID range: SEC-500..599
Skipped entirely if ctx["quick_mode"] is True.
"""

import subprocess
import http.client
import json
import os
import re

PHASE = "injection"


def _finding(fid, severity, title, evidence="", remediation="", status="fail", owasp="A03"):
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


def _http_request(method, host, port, path, body=None, headers=None, timeout=5):
    """Generic HTTP request. Returns (status, response_headers_dict, body_str)."""
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


def _check_sqlmap(target, tools_available):
    """SEC-500: sqlmap scan on FileBrowser login endpoint."""
    if "sqlmap" not in tools_available:
        return _finding(
            "SEC-500",
            "info",
            "sqlmap not available -- SQL injection scan skipped",
            status="skip",
        )

    try:
        output_dir = "/tmp/sectest_sqlmap"
        cmd = [
            "sqlmap",
            "-u", "http://%s/files/api/login" % target,
            "--method", "POST",
            "--data", '{"username":"test","password":"test"}',
            "--headers=Content-Type: application/json",
            "--level=1",
            "--risk=1",
            "--batch",
            "--output-dir=%s" % output_dir,
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )
        output = result.stdout + "\n" + result.stderr

        if "is vulnerable" in output.lower() or "sql injection" in output.lower():
            return _finding(
                "SEC-500",
                "high",
                "SQL injection found in FileBrowser login endpoint",
                evidence=output[-500:],
                remediation="Patch FileBrowser or apply input validation on the login endpoint.",
            )
        else:
            return _finding(
                "SEC-500",
                "info",
                "No SQL injection found in FileBrowser login",
                evidence="sqlmap completed, no vulnerabilities detected",
                status="pass",
            )

    except subprocess.TimeoutExpired:
        return _finding(
            "SEC-500", "info", "sqlmap scan timed out (120s)",
            status="error",
        )
    except Exception as e:
        return _finding(
            "SEC-500", "info", "sqlmap scan error",
            evidence=str(e), status="error",
        )


def _check_xss_reflection(target):
    """SEC-501: XSS reflection test on key endpoints."""
    xss_payload = "<script>alert(1)</script>"
    endpoints = [
        ("/?q=" + xss_payload, 80),
        ("/files/?q=" + xss_payload, 80),
        ("/?search=" + xss_payload, 80),
    ]

    reflected = []
    for path, port in endpoints:
        try:
            status, hdrs, body = _http_request("GET", target, port, path)
            if xss_payload in body:
                reflected.append("%s:%d%s (HTTP %d)" % (target, port, path[:60], status))
        except Exception:
            pass

    if reflected:
        return _finding(
            "SEC-501",
            "high",
            "XSS payload reflected in %d endpoint(s)" % len(reflected),
            evidence="; ".join(reflected[:3]),
            remediation="Sanitize all user input before rendering in HTML responses. Use Content-Type headers and CSP.",
        )
    else:
        return _finding(
            "SEC-501",
            "info",
            "No XSS reflection detected on tested endpoints",
            evidence="Tested %d endpoints, payload not reflected" % len(endpoints),
            status="pass",
        )


def _check_ssti(target):
    """SEC-502: Server-Side Template Injection test."""
    ssti_payload = "{{7*7}}"
    endpoints = [
        ("/?name=" + ssti_payload, 80),
        ("/files/?q=" + ssti_payload, 80),
    ]

    # Also test Cockpit on port 9090 via HTTPS
    vulnerable = []
    for path, port in endpoints:
        try:
            status, hdrs, body = _http_request("GET", target, port, path)
            if "49" in body and ssti_payload not in body:
                vulnerable.append("%s:%d%s" % (target, port, path[:60]))
        except Exception:
            pass

    # Cockpit HTTPS
    try:
        import ssl
        ctx_ssl = ssl._create_unverified_context()
        conn = http.client.HTTPSConnection(target, 9090, timeout=5, context=ctx_ssl)
        conn.request("GET", "/?name=" + ssti_payload)
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="replace")
        conn.close()
        if "49" in body and ssti_payload not in body:
            vulnerable.append("%s:9090/?name=..." % target)
    except Exception:
        pass

    if vulnerable:
        return _finding(
            "SEC-502",
            "critical",
            "SSTI detected -- template expression evaluated on %d endpoint(s)" % len(vulnerable),
            evidence="; ".join(vulnerable),
            remediation="Never pass user input directly into template engines. Use sandboxed rendering.",
        )
    else:
        return _finding(
            "SEC-502",
            "info",
            "No SSTI detected on tested endpoints",
            evidence="Tested endpoints on ports 80 and 9090, {{7*7}} not evaluated",
            status="pass",
        )


def _check_header_injection(target):
    """SEC-503: CRLF / header injection via Host header."""
    try:
        conn = http.client.HTTPConnection(target, 80, timeout=5)
        # Send a Host header with CRLF injection
        injected_host = "%s\r\nX-Injected: true" % target
        conn.putrequest("GET", "/")
        conn.putheader("Host", injected_host)
        conn.putheader("Connection", "close")
        conn.endheaders()
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="replace")
        hdrs = {k.lower(): v for k, v in resp.getheaders()}
        conn.close()

        if "x-injected" in hdrs:
            return _finding(
                "SEC-503",
                "medium",
                "CRLF header injection via Host header",
                evidence="Injected X-Injected header reflected in response",
                remediation="Configure web server to reject headers with CRLF characters.",
            )
        elif "x-injected" in body.lower():
            return _finding(
                "SEC-503",
                "medium",
                "CRLF injection reflected in response body",
                evidence="Injected header value found in body",
                remediation="Sanitize Host header and reject CRLF sequences.",
            )
        else:
            return _finding(
                "SEC-503",
                "info",
                "No CRLF header injection detected",
                evidence="Host header with CRLF not reflected (HTTP %d)" % resp.status,
                status="pass",
            )

    except Exception as e:
        return _finding(
            "SEC-503", "info", "Header injection check error",
            evidence=str(e), status="error",
        )


def _check_command_injection(target):
    """SEC-504: Command injection probes on known API endpoints."""
    # Test payloads that would produce identifiable output if executed
    payloads = [";id", "$(id)", "|id", "`id`"]
    marker_patterns = [r"uid=\d+", r"gid=\d+"]

    endpoints = [
        ("/files/api/resources?path=%s", 80),
        ("/files/api/search?query=%s", 80),
    ]

    injected = []
    for path_tmpl, port in endpoints:
        for payload in payloads:
            try:
                path = path_tmpl % payload
                status, hdrs, body = _http_request("GET", target, port, path)
                for pat in marker_patterns:
                    if re.search(pat, body):
                        injected.append(
                            "port %d: %s with payload '%s' -> uid/gid in response"
                            % (port, path_tmpl.split("?")[0], payload)
                        )
                        break
            except Exception:
                pass

    if injected:
        return _finding(
            "SEC-504",
            "critical",
            "Command injection detected on %d probe(s)" % len(injected),
            evidence="; ".join(injected[:3]),
            remediation="Never pass user input to shell commands. Use parameterized APIs and avoid subprocess with shell=True.",
        )
    else:
        return _finding(
            "SEC-504",
            "info",
            "No command injection detected on tested endpoints",
            evidence="Tested %d endpoint/payload combinations" % (len(endpoints) * len(payloads)),
            status="pass",
        )


def run(ctx):
    """Run all injection checks. Skipped if quick_mode is True."""
    target = ctx.get("target", "127.0.0.1")
    tools_available = ctx.get("tools_available", [])

    if ctx.get("quick_mode", False):
        return [_finding(
            "SEC-500",
            "info",
            "Injection phase skipped (quick_mode)",
            status="skip",
        )]

    findings = []

    # SEC-500: sqlmap
    findings.append(_check_sqlmap(target, tools_available))

    # SEC-501: XSS reflection
    findings.append(_check_xss_reflection(target))

    # SEC-502: SSTI
    findings.append(_check_ssti(target))

    # SEC-503: Header injection
    findings.append(_check_header_injection(target))

    # SEC-504: Command injection
    findings.append(_check_command_injection(target))

    return findings
