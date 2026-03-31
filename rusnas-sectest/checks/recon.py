"""
Reconnaissance phase — port scanning and service enumeration.
ID range: SEC-100..199
"""

import subprocess
import socket
import re
import os

PHASE = "reconnaissance"

EXPECTED_PORTS = {21, 22, 80, 111, 139, 445, 873, 2049, 9090, 9100, 20048}


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


def _parse_nmap_output(text):
    """Parse nmap -sV -sC text output. Returns dict port->{ proto, state, service, version }."""
    ports = {}
    for line in text.splitlines():
        m = re.match(
            r"^\s*(\d+)/(tcp|udp)\s+(open|filtered)\s+(\S+)\s*(.*)",
            line,
        )
        if m:
            port_num = int(m.group(1))
            ports[port_num] = {
                "proto": m.group(2),
                "state": m.group(3),
                "service": m.group(4),
                "version": m.group(5).strip(),
            }
    return ports


def _socket_scan(target, port_list, timeout=1.5):
    """Fallback: check ports with plain TCP connect."""
    ports = {}
    for port in port_list:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            s.connect((target, port))
            ports[port] = {
                "proto": "tcp",
                "state": "open",
                "service": "unknown",
                "version": "",
            }
        except (socket.timeout, ConnectionRefusedError, OSError):
            pass
        finally:
            s.close()
    return ports


def run(ctx):
    findings = []
    target = ctx.get("target", "127.0.0.1")
    has_nmap = ctx.get("tools_available", {}).get("nmap", False)
    quick_mode = ctx.get("quick_mode", False)

    ports = {}
    nmap_used = False

    if has_nmap and not quick_mode:
        out_file = "/tmp/sectest_nmap.txt"
        try:
            result = subprocess.run(
                [
                    "nmap", "-sV", "-sC",
                    "--top-ports", "1000",
                    target,
                    "-oN", out_file,
                ],
                capture_output=True,
                text=True,
                timeout=300,
            )
            raw = ""
            if os.path.isfile(out_file):
                with open(out_file, "r") as fh:
                    raw = fh.read()
            if not raw:
                raw = result.stdout or ""
            ports = _parse_nmap_output(raw)
            nmap_used = True
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
            findings.append(
                _finding(
                    "SEC-100", "info",
                    "Nmap scan failed, falling back to socket scan",
                    evidence=str(exc),
                    status="error",
                )
            )
    elif has_nmap and quick_mode:
        # Quick mode: nmap only expected ports
        port_arg = ",".join(str(p) for p in sorted(EXPECTED_PORTS))
        try:
            result = subprocess.run(
                ["nmap", "-sV", "-p", port_arg, target],
                capture_output=True,
                text=True,
                timeout=120,
            )
            ports = _parse_nmap_output(result.stdout or "")
            nmap_used = True
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass

    if not nmap_used:
        # Fallback: socket scan on expected ports + common extras
        scan_ports = sorted(EXPECTED_PORTS | {443, 3000, 3306, 5432, 8080, 8443, 8091})
        ports = _socket_scan(target, scan_ports)

    # Store results in context for downstream modules
    ctx["ports"] = ports
    services = {}
    for p, info in ports.items():
        svc = info.get("service", "unknown")
        if svc not in services:
            services[svc] = []
        services[svc].append(p)
    ctx["services"] = services

    # --- SEC-100: open ports summary (INFO) ---
    if ports:
        open_list = ", ".join(
            "{}/{}({})".format(p, info["proto"], info["service"])
            for p, info in sorted(ports.items())
        )
        findings.append(
            _finding(
                "SEC-100", "info",
                "Open ports summary",
                evidence="Method: {}. Open: {}".format(
                    "nmap" if nmap_used else "socket", open_list
                ),
                status="pass",
            )
        )
    else:
        findings.append(
            _finding(
                "SEC-100", "info",
                "No open ports detected",
                evidence="Method: {}".format("nmap" if nmap_used else "socket"),
                status="pass",
            )
        )

    # --- SEC-101: unexpected open ports ---
    open_port_nums = set(ports.keys())
    unexpected = open_port_nums - EXPECTED_PORTS
    if unexpected:
        detail = ", ".join(
            "{} ({})".format(p, ports[p]["service"]) for p in sorted(unexpected)
        )
        findings.append(
            _finding(
                "SEC-101", "medium",
                "Unexpected ports open",
                evidence="Ports not in expected set: {}".format(detail),
                remediation=(
                    "Review each unexpected port. Close unused services or "
                    "add to expected set if intentional. Use nftables to "
                    "restrict access."
                ),
                status="fail",
            )
        )
    else:
        findings.append(
            _finding(
                "SEC-101", "medium",
                "No unexpected ports detected",
                evidence="All open ports are in the expected set.",
                status="pass",
            )
        )

    return findings
