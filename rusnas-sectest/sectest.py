#!/usr/bin/env python3
"""
rusNAS Security Self-Test — main orchestrator.

Runs a suite of automated security checks against a local rusNAS instance
and produces JSON, Markdown, and log outputs.

Usage:
    sudo python3 sectest.py                        # full scan, human output
    sudo python3 sectest.py --json                 # JSON to stdout
    sudo python3 sectest.py --quick                # skip heavy tools (nuclei/sqlmap/ffuf)
    sudo python3 sectest.py --category web         # only web-related checks
    sudo python3 sectest.py --target 10.10.10.72   # remote target
"""

from __future__ import annotations

import argparse
import datetime
import importlib
import json
import logging
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import traceback

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VERSION = "1.0.0"

RESULTS_DIR = pathlib.Path("/var/lib/rusnas")
LOG_DIR = pathlib.Path("/var/log/rusnas")
RESULTS_JSON = RESULTS_DIR / "sectest-last.json"
RESULTS_MD = RESULTS_DIR / "sectest-report.md"
LOG_FILE = LOG_DIR / "sectest.log"

SEVERITY_WEIGHTS = {
    "critical": 20,
    "high": 10,
    "medium": 5,
    "low": 2,
    "info": 0,
}

SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"]

# Tools we probe for at startup
TOOLS_TO_CHECK = [
    "nmap", "nuclei", "ffuf", "sqlmap",
    "curl", "openssl", "smbclient", "showmount", "rsync",
]

# Check modules in execution order.  The tuple is (module_name, category, skip_on_quick).
CHECK_MODULES = [
    ("checks.recon",            "network", False),
    ("checks.web_headers",      "web",     False),
    ("checks.access_control",   "auth",    False),
    ("checks.auth",             "auth",    False),
    ("checks.injection",        "web",     False),
    ("checks.misconfig",        "network", False),
    ("checks.vuln_scan",        "web",     True),   # heavy — skipped with --quick
    ("checks.endpoint_fuzz",    "web",     True),   # heavy — skipped with --quick
    ("checks.network_services", "network", False),
]

# Category grouping: "all" runs everything; named categories filter.
CATEGORY_MAP = {
    "web":     {"web"},
    "network": {"network"},
    "auth":    {"auth"},
    "all":     {"web", "network", "auth"},
}

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------

def setup_logging(verbose: bool = False) -> logging.Logger:
    """Configure root logger → file + stderr."""
    logger = logging.getLogger("sectest")
    logger.setLevel(logging.DEBUG)

    fmt = logging.Formatter(
        "%(asctime)s  %(levelname)-7s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # File handler (append)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(str(LOG_FILE), mode="a", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    # Stderr handler
    sh = logging.StreamHandler(sys.stderr)
    sh.setLevel(logging.DEBUG if verbose else logging.INFO)
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    return logger


# ---------------------------------------------------------------------------
# Tool availability
# ---------------------------------------------------------------------------

def check_tools(tools: list[str], logger: logging.Logger) -> dict[str, bool]:
    """Return {tool_name: True/False} for each tool."""
    available: dict[str, bool] = {}
    for tool in tools:
        path = shutil.which(tool)
        available[tool] = path is not None
        if path:
            logger.debug("Tool found: %s → %s", tool, path)
        else:
            logger.warning("Tool NOT found: %s", tool)
    return available


# ---------------------------------------------------------------------------
# Context builder
# ---------------------------------------------------------------------------

def build_context(
    target: str,
    quick_mode: bool,
    tools_available: dict[str, bool],
) -> dict:
    """Build the context dict passed to every check module."""
    return {
        "target": target,
        "ports": {},          # populated by checks.recon
        "services": {},       # populated by checks.recon
        "quick_mode": quick_mode,
        "tools_available": tools_available,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Score calculation
# ---------------------------------------------------------------------------

def calculate_score(findings: list[dict]) -> int:
    """Start at 100, subtract per finding severity.  Min 0."""
    score = 100
    for f in findings:
        if f.get("status") != "fail":
            continue
        weight = SEVERITY_WEIGHTS.get(f.get("severity", "info"), 0)
        score -= weight
    return max(0, score)


def score_grade(score: int) -> str:
    if score >= 90:
        return "A"
    if score >= 75:
        return "B"
    if score >= 60:
        return "C"
    if score >= 40:
        return "D"
    return "F"


# ---------------------------------------------------------------------------
# Module runner
# ---------------------------------------------------------------------------

def run_check_module(
    module_path: str,
    context: dict,
    logger: logging.Logger,
) -> list[dict]:
    """Import and run a single check module, returning its findings."""
    logger.info("Running %s ...", module_path)
    try:
        mod = importlib.import_module(module_path)
        findings = mod.run(context)
        if not isinstance(findings, list):
            logger.error("%s.run() did not return a list, got %s", module_path, type(findings))
            return [{
                "id": "ERR-IMPORT",
                "phase": module_path,
                "owasp": "",
                "severity": "info",
                "title": f"Module {module_path} returned invalid data",
                "evidence": f"Expected list, got {type(findings).__name__}",
                "remediation": "Fix module run() return type",
                "status": "error",
            }]
        passed = sum(1 for f in findings if f.get("status") == "pass")
        failed = sum(1 for f in findings if f.get("status") == "fail")
        skipped = sum(1 for f in findings if f.get("status") == "skip")
        errored = sum(1 for f in findings if f.get("status") == "error")
        logger.info(
            "  %s done: %d findings (pass=%d fail=%d skip=%d error=%d)",
            module_path, len(findings), passed, failed, skipped, errored,
        )
        return findings
    except Exception:
        tb = traceback.format_exc()
        logger.error("Module %s crashed:\n%s", module_path, tb)
        return [{
            "id": "ERR-CRASH",
            "phase": module_path,
            "owasp": "",
            "severity": "info",
            "title": f"Module {module_path} crashed",
            "evidence": tb[:500],
            "remediation": "Check module code and dependencies",
            "status": "error",
        }]


# ---------------------------------------------------------------------------
# Output: JSON (atomic write)
# ---------------------------------------------------------------------------

def write_json_results(report: dict, logger: logging.Logger) -> None:
    """Atomically write JSON results to RESULTS_JSON."""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = str(RESULTS_JSON) + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False, default=str)
        os.chmod(tmp_path, 0o644)
        os.rename(tmp_path, str(RESULTS_JSON))
        logger.info("JSON results written to %s", RESULTS_JSON)
    except OSError as exc:
        logger.error("Failed to write JSON results: %s", exc)


# ---------------------------------------------------------------------------
# Output: Markdown report
# ---------------------------------------------------------------------------

def _sev_emoji(severity: str) -> str:
    return {
        "critical": "[!]",
        "high":     "[H]",
        "medium":   "[M]",
        "low":      "[L]",
        "info":     "[i]",
    }.get(severity, "[ ]")


def generate_markdown(report: dict) -> str:
    """Generate full pentest-style Markdown report."""
    ts = report.get("timestamp", "")
    score = report.get("score", 0)
    grade = report.get("grade", "?")
    duration = report.get("duration_seconds", 0)
    target = report.get("target", "127.0.0.1")
    findings = report.get("findings", [])
    summary = report.get("summary", {})
    tools = report.get("tools_available", {})

    lines: list[str] = []
    a = lines.append

    a("# rusNAS Security Self-Test Report")
    a("")
    a(f"**Date:** {ts}  ")
    a(f"**Target:** {target}  ")
    a(f"**Duration:** {duration:.1f}s  ")
    a(f"**Score:** {score}/100 (Grade: {grade})  ")
    a(f"**Version:** sectest {VERSION}")
    a("")

    # --- Executive Summary ---
    a("## Executive Summary")
    a("")
    a(f"| Severity | Count |")
    a(f"|----------|-------|")
    for sev in SEVERITY_ORDER:
        count = summary.get(sev, 0)
        a(f"| {sev.capitalize():10s} | {count:5d} |")
    a(f"| **Total failures** | **{summary.get('total_fail', 0)}** |")
    a(f"| Passed   | {summary.get('total_pass', 0):5d} |")
    a(f"| Skipped  | {summary.get('total_skip', 0):5d} |")
    a(f"| Errors   | {summary.get('total_error', 0):5d} |")
    a("")

    # --- Tools Used ---
    a("## Tools Availability")
    a("")
    a("| Tool | Available |")
    a("|------|-----------|")
    for tool, avail in sorted(tools.items()):
        mark = "Yes" if avail else "No"
        a(f"| {tool} | {mark} |")
    a("")

    # --- Findings by severity ---
    fail_findings = [f for f in findings if f.get("status") == "fail"]
    if fail_findings:
        a("## Findings")
        a("")
        for sev in SEVERITY_ORDER:
            sev_findings = [f for f in fail_findings if f.get("severity") == sev]
            if not sev_findings:
                continue
            a(f"### {sev.upper()} ({len(sev_findings)})")
            a("")
            for f in sev_findings:
                a(f"#### {_sev_emoji(sev)} {f.get('id', '?')} — {f.get('title', 'Untitled')}")
                a("")
                if f.get("owasp"):
                    a(f"**OWASP:** {f['owasp']}  ")
                a(f"**Phase:** {f.get('phase', '?')}  ")
                a(f"**Status:** {f.get('status', '?')}  ")
                a("")
                if f.get("evidence"):
                    a("**Evidence:**")
                    a("```")
                    a(str(f["evidence"])[:2000])
                    a("```")
                    a("")
                if f.get("remediation"):
                    a("**Remediation:**")
                    a(f"> {f['remediation']}")
                    a("")
    else:
        a("## Findings")
        a("")
        a("No failures detected. All checks passed or were skipped.")
        a("")

    # --- Passed checks ---
    pass_findings = [f for f in findings if f.get("status") == "pass"]
    if pass_findings:
        a("## Passed Checks")
        a("")
        a("| ID | Title |")
        a("|----|-------|")
        for f in pass_findings:
            a(f"| {f.get('id', '?')} | {f.get('title', '')} |")
        a("")

    # --- Skipped ---
    skip_findings = [f for f in findings if f.get("status") == "skip"]
    if skip_findings:
        a("## Skipped Checks")
        a("")
        a("| ID | Title | Reason |")
        a("|----|-------|--------|")
        for f in skip_findings:
            a(f"| {f.get('id', '?')} | {f.get('title', '')} | {f.get('evidence', '')} |")
        a("")

    # --- Errors ---
    err_findings = [f for f in findings if f.get("status") == "error"]
    if err_findings:
        a("## Errors")
        a("")
        for f in err_findings:
            a(f"- **{f.get('id', '?')}** {f.get('title', '')}: {f.get('evidence', '')[:200]}")
        a("")

    a("---")
    a(f"*Generated by rusNAS sectest v{VERSION}*")
    a("")

    return "\n".join(lines)


def write_markdown_report(report: dict, logger: logging.Logger) -> None:
    """Write Markdown report to RESULTS_MD."""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    md = generate_markdown(report)
    try:
        with open(str(RESULTS_MD), "w", encoding="utf-8") as f:
            f.write(md)
        os.chmod(str(RESULTS_MD), 0o644)
        logger.info("Markdown report written to %s", RESULTS_MD)
    except OSError as exc:
        logger.error("Failed to write Markdown report: %s", exc)


# ---------------------------------------------------------------------------
# Human-readable stdout output
# ---------------------------------------------------------------------------

def print_human_report(report: dict) -> None:
    """Print coloured (if tty) summary to stdout."""
    findings = report.get("findings", [])
    score = report.get("score", 0)
    grade = report.get("grade", "?")
    duration = report.get("duration_seconds", 0)
    summary = report.get("summary", {})

    is_tty = sys.stdout.isatty()

    def _c(code: str, text: str) -> str:
        if not is_tty:
            return text
        return f"\033[{code}m{text}\033[0m"

    SEV_COLORS = {
        "critical": "1;31",   # bold red
        "high":     "0;31",   # red
        "medium":   "0;33",   # yellow
        "low":      "0;36",   # cyan
        "info":     "0;37",   # white
    }

    print()
    print(_c("1;37", "=" * 60))
    print(_c("1;37", "  rusNAS Security Self-Test"))
    print(_c("1;37", "=" * 60))
    print()

    # Score
    if score >= 75:
        sc_color = "1;32"  # green
    elif score >= 50:
        sc_color = "1;33"  # yellow
    else:
        sc_color = "1;31"  # red
    print(f"  Score: {_c(sc_color, f'{score}/100')}  Grade: {_c(sc_color, grade)}")
    print(f"  Duration: {duration:.1f}s")
    print()

    # Summary table
    print(f"  {'Severity':<12} {'Count':>5}")
    print(f"  {'-'*12} {'-'*5}")
    for sev in SEVERITY_ORDER:
        count = summary.get(sev, 0)
        if count > 0:
            color = SEV_COLORS.get(sev, "0")
            label = sev.capitalize().ljust(12)
            print(f"  {_c(color, label)} {count:>5}")
    print()

    # Failed findings
    fail_findings = [f for f in findings if f.get("status") == "fail"]
    if fail_findings:
        print(_c("1;37", "  FINDINGS:"))
        print()
        for f in fail_findings:
            sev = f.get("severity", "info")
            color = SEV_COLORS.get(sev, "0")
            fid = f.get("id", "?")
            title = f.get("title", "")
            print(f"  {_c(color, f'[{sev.upper():<8}]')} {fid}: {title}")
            if f.get("evidence"):
                ev = str(f["evidence"])[:120]
                print(f"             {_c('0;90', ev)}")
            if f.get("remediation"):
                print(f"             -> {f['remediation'][:120]}")
            print()
    else:
        print(_c("1;32", "  All checks passed!"))
        print()

    print(f"  Results: {RESULTS_JSON}")
    print(f"  Report:  {RESULTS_MD}")
    print(f"  Log:     {LOG_FILE}")
    print()


# ---------------------------------------------------------------------------
# Build summary stats
# ---------------------------------------------------------------------------

def build_summary(findings: list[dict]) -> dict:
    summary: dict = {}
    for sev in SEVERITY_ORDER:
        summary[sev] = sum(
            1 for f in findings
            if f.get("status") == "fail" and f.get("severity") == sev
        )
    summary["total_fail"] = sum(1 for f in findings if f.get("status") == "fail")
    summary["total_pass"] = sum(1 for f in findings if f.get("status") == "pass")
    summary["total_skip"] = sum(1 for f in findings if f.get("status") == "skip")
    summary["total_error"] = sum(1 for f in findings if f.get("status") == "error")
    summary["total"] = len(findings)
    return summary


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="rusNAS Security Self-Test",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--json", action="store_true", dest="json_output",
        help="Output JSON to stdout instead of human-readable text",
    )
    p.add_argument(
        "--quick", action="store_true",
        help="Skip heavy tools (nuclei, sqlmap, ffuf)",
    )
    p.add_argument(
        "--category", choices=["web", "network", "auth", "all"], default="all",
        help="Run only checks in this category (default: all)",
    )
    p.add_argument(
        "--target", default="127.0.0.1",
        help="Target IP or hostname (default: 127.0.0.1)",
    )
    p.add_argument(
        "--verbose", "-v", action="store_true",
        help="Verbose logging to stderr",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    logger = setup_logging(verbose=args.verbose)

    start_time = datetime.datetime.now(datetime.timezone.utc)
    logger.info("=" * 60)
    logger.info("rusNAS Security Self-Test v%s started", VERSION)
    logger.info("Target: %s  Category: %s  Quick: %s", args.target, args.category, args.quick)

    # --- Ensure we can write output directories ---
    for d in (RESULTS_DIR, LOG_DIR):
        try:
            d.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.error("Cannot create directory %s: %s", d, exc)
            # Don't abort — we'll still try to produce stdout output

    # --- Check tool availability ---
    tools_available = check_tools(TOOLS_TO_CHECK, logger)

    # --- Build context ---
    context = build_context(
        target=args.target,
        quick_mode=args.quick,
        tools_available=tools_available,
    )

    # --- Determine which categories to run ---
    allowed_categories = CATEGORY_MAP.get(args.category, CATEGORY_MAP["all"])

    # --- Add parent dir of sectest.py to sys.path so checks/ is importable ---
    script_dir = pathlib.Path(__file__).resolve().parent
    if str(script_dir) not in sys.path:
        sys.path.insert(0, str(script_dir))

    # --- Run check modules ---
    all_findings: list[dict] = []

    for module_path, category, skip_on_quick in CHECK_MODULES:
        # Category filter
        if category not in allowed_categories:
            logger.info("Skipping %s (category %s not in %s)", module_path, category, args.category)
            continue

        # Quick-mode filter
        if skip_on_quick and args.quick:
            logger.info("Skipping %s (--quick mode)", module_path)
            all_findings.append({
                "id": "SKIP-QUICK",
                "phase": module_path.split(".")[-1],
                "owasp": "",
                "severity": "info",
                "title": f"Skipped {module_path} (quick mode)",
                "evidence": "Module requires heavy tools, skipped with --quick",
                "remediation": "Run without --quick for full scan",
                "status": "skip",
            })
            continue

        findings = run_check_module(module_path, context, logger)
        all_findings.extend(findings)

    # --- Calculate score ---
    end_time = datetime.datetime.now(datetime.timezone.utc)
    duration = (end_time - start_time).total_seconds()
    score = calculate_score(all_findings)
    grade = score_grade(score)
    summary = build_summary(all_findings)

    logger.info(
        "Scan complete: score=%d grade=%s duration=%.1fs findings=%d (fail=%d pass=%d skip=%d error=%d)",
        score, grade, duration, summary["total"],
        summary["total_fail"], summary["total_pass"],
        summary["total_skip"], summary["total_error"],
    )

    # --- Assemble report ---
    report = {
        "version": VERSION,
        "timestamp": start_time.isoformat(),
        "target": args.target,
        "category": args.category,
        "quick_mode": args.quick,
        "duration_seconds": round(duration, 2),
        "score": score,
        "grade": grade,
        "summary": summary,
        "tools_available": tools_available,
        "findings": all_findings,
    }

    # --- Write outputs ---
    write_json_results(report, logger)
    write_markdown_report(report, logger)

    # --- Stdout ---
    if args.json_output:
        json.dump(report, sys.stdout, indent=2, ensure_ascii=False, default=str)
        sys.stdout.write("\n")
    else:
        print_human_report(report)

    logger.info("rusNAS Security Self-Test finished.")
    return 0 if score >= 60 else 1


if __name__ == "__main__":
    sys.exit(main())
