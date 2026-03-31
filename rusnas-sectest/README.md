# rusNAS Security Self-Test (sectest)

Automated OWASP Top 10 penetration testing for rusNAS. Runs on the NAS itself, checking all services for vulnerabilities.

## Quick Start

```bash
# Install (from dev machine)
./install-sectest.sh

# Run full pentest on VM
ssh rusnas@10.10.10.72 "sudo python3 /usr/lib/rusnas/sectest/sectest.py"

# Run quick scan (no nuclei/sqlmap/ffuf — ~30 sec)
ssh rusnas@10.10.10.72 "sudo python3 /usr/lib/rusnas/sectest/sectest.py --quick"

# JSON output for programmatic use
ssh rusnas@10.10.10.72 "sudo python3 /usr/lib/rusnas/sectest/sectest.py --json"

# Scan specific category only
ssh rusnas@10.10.10.72 "sudo python3 /usr/lib/rusnas/sectest/sectest.py --category web"
ssh rusnas@10.10.10.72 "sudo python3 /usr/lib/rusnas/sectest/sectest.py --category network"
ssh rusnas@10.10.10.72 "sudo python3 /usr/lib/rusnas/sectest/sectest.py --category auth"
```

## What It Checks

9 phases covering OWASP Top 10:

| Phase | Module | OWASP | What |
|-------|--------|-------|------|
| Recon | recon.py | — | Port scan, service detection (nmap) |
| Web Security | web_headers.py | A02/A05 | TLS, security headers, HSTS, CSP |
| Access Control | access_control.py | A01 | NFS, SMB, rsync, FTP, forced browsing |
| Authentication | auth.py | A07 | Default creds, JWT, rate limiting |
| Injection | injection.py | A03 | SQLi, XSS, SSTI, command injection |
| Misconfiguration | misconfig.py | A05 | Directory listing, TRACE, CORS, versions |
| Vuln Scan | vuln_scan.py | A06 | nuclei CVE + misconfig templates |
| Endpoint Fuzz | endpoint_fuzz.py | A04 | ffuf discovery, rate limiting |
| Network | network_services.py | A01/A02 | SMB signing, rpcbind, Samba config |

## Tools Required

| Tool | Required | Install |
|------|----------|---------|
| python3 | Yes | pre-installed |
| curl | Yes | pre-installed |
| openssl | Yes | pre-installed |
| nmap | Recommended | `apt install nmap` |
| nuclei | Optional (full scan) | install-sectest.sh installs it |
| ffuf | Optional (full scan) | install-sectest.sh installs it |
| sqlmap | Optional (full scan) | `apt install sqlmap` |
| smbclient | Optional | `apt install smbclient` |

Missing tools are detected automatically. Checks that require unavailable tools are skipped.

## Output Files

| File | Description |
|------|-------------|
| `/var/lib/rusnas/sectest-last.json` | Last scan results (JSON, read by dashboard) |
| `/var/lib/rusnas/sectest-report.md` | Last scan as Markdown report |
| `/var/log/rusnas/sectest.log` | Append-only log of all scans |

## Scoring

Score starts at 100 and decreases per finding:

| Severity | Penalty |
|----------|---------|
| Critical | -20 |
| High | -10 |
| Medium | -5 |
| Low | -2 |

Score >= 80: green, 60-79: yellow, < 60: red

## Automatic Scheduling

systemd timer runs monthly (1st of each month, 4:00 AM):

```bash
# Check timer status
systemctl list-timers | grep sectest

# Manual trigger
systemctl start rusnas-sectest.service

# View last run log
journalctl -u rusnas-sectest.service --no-pager -n 50
```

## Dashboard Integration

The Security card on rusNAS dashboard shows:
- Score badge (green/yellow/red)
- Last check date
- Number of findings by severity
- "Check Now" button for quick scan

Alert banner appears if score < 70 or critical/high findings exist.

## Quick vs Full Mode

| Mode | Time | Tools | Checks |
|------|------|-------|--------|
| `--quick` | ~30 sec | curl, openssl, python3 | 30+ basic checks |
| Full | ~5-10 min | all tools | 45+ checks including nuclei, sqlmap, ffuf |

Deploy script (`deploy.sh`) runs `--quick` mode automatically after each deploy.

## Finding Format

Each finding has:
- **ID**: SEC-NNN (unique identifier)
- **Phase**: which scan phase found it
- **OWASP**: OWASP Top 10 category (A01-A10)
- **Severity**: critical / high / medium / low / info
- **Title**: short description
- **Evidence**: proof of the finding
- **Remediation**: specific fix instructions
- **Status**: fail / pass / skip / error
