#!/usr/bin/env python3
"""HTTP Webhook delivery channel."""

import json
import logging
import urllib.request
import urllib.error
from datetime import datetime, timezone

logger = logging.getLogger("rusnas-notify.ch.webhook")


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send JSON payload to all webhook URLs."""
    urls = channel_cfg.get("urls", [])
    method = channel_cfg.get("method", "POST")
    headers = channel_cfg.get("headers", {})
    timeout = channel_cfg.get("timeout_sec", 10)

    if not urls:
        return False, "No webhook URLs configured"

    payload = json.dumps({
        "source": source,
        "severity": severity,
        "title": title,
        "body": body or "",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "extra": json.loads(extra_json) if extra_json else None
    }).encode("utf-8")

    req_headers = {"Content-Type": "application/json"}
    req_headers.update(headers)

    errors = []
    for url in urls:
        req = urllib.request.Request(url, data=payload, headers=req_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp.read()
            logger.info("Webhook sent to %s", url)
        except Exception as e:
            errors.append("%s: %s" % (url, e))
            logger.error("Webhook to %s failed: %s", url, e)

    if errors:
        return False, "; ".join(errors)
    return True, None


def test(channel_cfg):
    return send(
        channel_cfg, "test", "info",
        "rusNAS test webhook",
        "This is a test webhook from rusNAS."
    )
