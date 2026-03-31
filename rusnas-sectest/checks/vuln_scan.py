"""
Vulnerability scanning phase -- nuclei-based scans.
ID range: SEC-700..799
Skipped if ctx["quick_mode"] is True or nuclei is not available.
"""

import subprocess
import re

PHASE = "vuln_scan"


def _finding(fid, severity, title, evidence="", remediation="", status="fail", owasp="A06"):
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


_SEVERITY_MAP = {
    "critical": "critical",
    "high": "high",
    "medium": "medium",
    "low": "low",
    "info": "info",
}

_OWASP_GUESS = {
    "cve": "A06",
    "default-login": "A07",
    "misconfig": "A05",
    "exposure": "A01",
    "owasp": "A03",
}


def _parse_nuclei_output(text):
    """
    Parse nuclei text output lines.
    Format examples:
      [template-id] [http] [critical] http://127.0.0.1/path [extra-info]
      [cve-2021-12345] [http] [high] https://127.0.0.1:9090/ [matched]
    Returns list of dicts: {template_id, protocol, severity, target, extra}
    """
    results = []
    # Nuclei output: [id] [proto] [sev] url [optional extra]
    pattern = re.compile(
        r"\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(\S+)(?:\s+\[([^\]]*)\])?"
    )
    for line in text.splitlines():
        line = line.strip()
        m = pattern.match(line)
        if m:
            results.append({
                "template_id": m.group(1),
                "protocol": m.group(2),
                "severity": m.group(3).lower(),
                "target": m.group(4),
                "extra": m.group(5) or "",
            })
    return results


def _guess_owasp(template_id):
    """Guess OWASP category from template ID prefix."""
    tid_lower = template_id.lower()
    for key, owasp in _OWASP_GUESS.items():
        if key in tid_lower:
            return owasp
    return "A06"


def _run_nuclei(fid_base, target_url, label, tools_available):
    """Run nuclei against a target URL, return list of findings."""
    findings = []

    if "nuclei" not in tools_available:
        findings.append(_finding(
            fid_base,
            "info",
            "nuclei not available -- %s scan skipped" % label,
            status="skip",
        ))
        return findings

    try:
        cmd = [
            "nuclei",
            "-u", target_url,
            "-tags", "owasp,cve,misconfig,exposure,default-login",
            "-severity", "critical,high,medium",
            "-silent",
            "-no-color",
            "-timeout", "10",
            "-retries", "1",
            "-rate-limit", "50",
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
        )
        output = result.stdout

        matches = _parse_nuclei_output(output)

        if not matches:
            findings.append(_finding(
                fid_base,
                "info",
                "nuclei scan on %s: no findings" % label,
                evidence="nuclei completed (exit %d), 0 matches" % result.returncode,
                status="pass",
            ))
            return findings

        for i, m in enumerate(matches):
            sev = _SEVERITY_MAP.get(m["severity"], "info")
            fid = "%s-%02d" % (fid_base, i) if i > 0 else fid_base
            owasp = _guess_owasp(m["template_id"])
            extra_str = (" [%s]" % m["extra"]) if m["extra"] else ""
            findings.append(_finding(
                fid,
                sev,
                "nuclei: %s on %s%s" % (m["template_id"], m["target"], extra_str),
                evidence="[%s] [%s] [%s] %s" % (
                    m["template_id"], m["protocol"], m["severity"], m["target"]
                ),
                remediation="Investigate and remediate nuclei finding: %s" % m["template_id"],
                owasp=owasp,
            ))

    except subprocess.TimeoutExpired:
        findings.append(_finding(
            fid_base,
            "info",
            "nuclei scan on %s timed out (300s)" % label,
            status="error",
        ))
    except Exception as e:
        findings.append(_finding(
            fid_base,
            "info",
            "nuclei scan error on %s" % label,
            evidence=str(e),
            status="error",
        ))

    return findings


def run(ctx):
    """Run nuclei vulnerability scans. Skipped if quick_mode or nuclei unavailable."""
    target = ctx.get("target", "127.0.0.1")
    tools_available = ctx.get("tools_available", [])

    if ctx.get("quick_mode", False):
        return [_finding(
            "SEC-700",
            "info",
            "Vulnerability scan phase skipped (quick_mode)",
            status="skip",
        )]

    if "nuclei" not in tools_available:
        return [_finding(
            "SEC-700",
            "info",
            "nuclei not available -- entire vuln_scan phase skipped",
            status="skip",
        )]

    findings = []

    # SEC-700: nginx / landing page on port 80
    findings.extend(_run_nuclei(
        "SEC-700",
        "http://%s" % target,
        "http://%s (port 80)" % target,
        tools_available,
    ))

    # SEC-701: Cockpit on port 9090
    findings.extend(_run_nuclei(
        "SEC-701",
        "https://%s:9090" % target,
        "Cockpit (port 9090)",
        tools_available,
    ))

    # SEC-702: FileBrowser on /files/
    findings.extend(_run_nuclei(
        "SEC-702",
        "http://%s/files/" % target,
        "FileBrowser (/files/)",
        tools_available,
    ))

    return findings
