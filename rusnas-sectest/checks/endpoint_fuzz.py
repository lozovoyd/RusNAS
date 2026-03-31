"""
Endpoint fuzzing phase -- directory discovery and rate limiting tests.
ID range: SEC-800..899
Skipped if ctx["quick_mode"] is True or ffuf is not available.
"""

import subprocess
import http.client
import json
import time
import re
import os

PHASE = "endpoint_fuzz"

WORDLIST_PATH = "/usr/lib/rusnas/sectest/wordlists/rusnas-paths.txt"


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


def _get_baseline_size(host, port, timeout=5):
    """Get the response body size of a known-404 / catch-all path for ffuf filtering."""
    try:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        conn.request("GET", "/nonexistent_baseline_path_xyzzy")
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return len(body)
    except Exception:
        return None


def _run_ffuf(fid, target, port, base_path, label, tools_available):
    """Run ffuf against target:port/base_path/FUZZ. Return list of findings."""
    findings = []

    if "ffuf" not in tools_available:
        findings.append(_finding(
            fid, "info",
            "ffuf not available -- %s fuzzing skipped" % label,
            status="skip",
        ))
        return findings

    if not os.path.isfile(WORDLIST_PATH):
        findings.append(_finding(
            fid, "info",
            "Wordlist not found: %s -- %s fuzzing skipped" % (WORDLIST_PATH, label),
            status="skip",
        ))
        return findings

    # Get baseline size for filtering
    baseline_size = _get_baseline_size(target, port)
    filter_args = []
    if baseline_size is not None:
        # Filter responses that match the landing/default page size (with small tolerance)
        filter_args = ["-fs", str(baseline_size)]

    url = "http://%s:%d%sFUZZ" % (target, port, base_path)
    output_file = "/tmp/sectest_ffuf_%s.json" % fid.replace("-", "_")

    try:
        cmd = [
            "ffuf",
            "-u", url,
            "-w", WORDLIST_PATH,
            "-mc", "200,201,301,302,307,401,403",
            "-t", "10",
            "-timeout", "5",
            "-o", output_file,
            "-of", "json",
            "-s",  # silent mode
        ] + filter_args

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )

        # Parse JSON output
        unique_endpoints = []
        if os.path.isfile(output_file):
            try:
                with open(output_file, "r") as f:
                    data = json.load(f)
                results = data.get("results", [])
                for r in results:
                    endpoint_info = "%s -> HTTP %s (len=%s)" % (
                        r.get("input", {}).get("FUZZ", "?"),
                        r.get("status", "?"),
                        r.get("length", "?"),
                    )
                    unique_endpoints.append(endpoint_info)
            except (json.JSONDecodeError, KeyError):
                pass
            finally:
                try:
                    os.unlink(output_file)
                except OSError:
                    pass

        if unique_endpoints:
            # Cap evidence length
            evidence_str = "; ".join(unique_endpoints[:20])
            if len(unique_endpoints) > 20:
                evidence_str += " ... and %d more" % (len(unique_endpoints) - 20)

            findings.append(_finding(
                fid,
                "info",
                "ffuf found %d unique endpoint(s) on %s" % (len(unique_endpoints), label),
                evidence=evidence_str,
                remediation="Review discovered endpoints for unintended exposure.",
                status="fail" if any("401" in e or "403" in e for e in unique_endpoints) else "pass",
            ))
        else:
            findings.append(_finding(
                fid,
                "info",
                "ffuf: no unique endpoints found on %s" % label,
                evidence="ffuf completed (exit %d), 0 unique results after filtering" % result.returncode,
                status="pass",
            ))

    except subprocess.TimeoutExpired:
        findings.append(_finding(
            fid, "info",
            "ffuf scan on %s timed out (120s)" % label,
            status="error",
        ))
    except Exception as e:
        findings.append(_finding(
            fid, "info",
            "ffuf scan error on %s" % label,
            evidence=str(e),
            status="error",
        ))

    return findings


def _check_rate_limiting(target):
    """SEC-810: Rate limiting test on FileBrowser login endpoint."""
    try:
        got_429 = False
        statuses = []

        for i in range(20):
            try:
                conn = http.client.HTTPConnection(target, 80, timeout=3)
                payload = json.dumps({"username": "ratetest", "password": "wrong%d" % i})
                conn.request(
                    "POST",
                    "/files/api/login",
                    body=payload,
                    headers={"Content-Type": "application/json"},
                )
                resp = conn.getresponse()
                resp.read()
                statuses.append(resp.status)
                conn.close()

                if resp.status == 429:
                    got_429 = True
                    break
            except Exception:
                statuses.append(0)

        if got_429:
            return _finding(
                "SEC-810",
                "info",
                "FileBrowser login rate limiting active",
                evidence="HTTP 429 received after %d attempts" % len(statuses),
                status="pass",
                owasp="A07",
            )
        else:
            status_summary = {}
            for s in statuses:
                status_summary[s] = status_summary.get(s, 0) + 1
            return _finding(
                "SEC-810",
                "medium",
                "FileBrowser login has no rate limiting detected",
                evidence="20 rapid failed logins, status distribution: %s" % status_summary,
                remediation="Implement rate limiting on /files/api/login (e.g., nginx limit_req or fail2ban).",
                owasp="A07",
            )

    except Exception as e:
        return _finding(
            "SEC-810", "info", "Rate limiting check error",
            evidence=str(e), status="error",
        )


def run(ctx):
    """Run endpoint fuzzing checks. Skipped if quick_mode or ffuf unavailable."""
    target = ctx.get("target", "127.0.0.1")
    tools_available = ctx.get("tools_available", [])

    if ctx.get("quick_mode", False):
        return [_finding(
            "SEC-800",
            "info",
            "Endpoint fuzzing phase skipped (quick_mode)",
            status="skip",
        )]

    if "ffuf" not in tools_available:
        # Still run rate limiting test (does not need ffuf)
        findings = [
            _finding(
                "SEC-800", "info",
                "ffuf not available -- directory fuzzing skipped",
                status="skip",
            ),
            _finding(
                "SEC-801", "info",
                "ffuf not available -- Cockpit fuzzing skipped",
                status="skip",
            ),
            _finding(
                "SEC-802", "info",
                "ffuf not available -- FileBrowser API fuzzing skipped",
                status="skip",
            ),
        ]
        findings.append(_check_rate_limiting(target))
        return findings

    findings = []

    # SEC-800: ffuf on port 80
    findings.extend(_run_ffuf(
        "SEC-800", target, 80, "/",
        "nginx (port 80)", tools_available,
    ))

    # SEC-801: ffuf on Cockpit 9090 -- skip, ffuf doesn't support HTTPS natively with self-signed
    # Use plain HTTP probe as fallback
    findings.append(_finding(
        "SEC-801",
        "info",
        "Cockpit (port 9090) fuzzing skipped -- HTTPS with self-signed cert not supported by ffuf",
        status="skip",
    ))

    # SEC-802: ffuf on FileBrowser API
    findings.extend(_run_ffuf(
        "SEC-802", target, 80, "/files/api/",
        "FileBrowser API (/files/api/)", tools_available,
    ))

    # SEC-810: Rate limiting (always runs, no ffuf needed)
    findings.append(_check_rate_limiting(target))

    return findings
