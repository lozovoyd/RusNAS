#!/usr/bin/env python3
"""MAX (VK Teams) Bot API delivery channel."""

import json
import logging
import urllib.request
import urllib.error

logger = logging.getLogger("rusnas-notify.ch.max")

API_URL = "https://platform-api.max.ru/messages"
SEVERITY_EMOJI = {"critical": "\U0001f534", "warning": "\U0001f7e1", "info": "\U0001f535"}


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send to all chat_ids via MAX API."""
    token = channel_cfg.get("bot_token", "")
    chat_ids = channel_cfg.get("chat_ids", [])

    if not token or not chat_ids:
        return False, "Bot token or chat_ids not configured"

    emoji = SEVERITY_EMOJI.get(severity, "")
    text = "%s **%s** | %s\n\n%s" % (
        emoji, severity.upper(), title, body or ""
    )

    errors = []
    for chat_id in chat_ids:
        payload = json.dumps({
            "chat_id": str(chat_id),
            "text": text,
            "format": "markdown"
        }).encode("utf-8")
        req = urllib.request.Request(API_URL, data=payload, headers={
            "Content-Type": "application/json",
            "Authorization": token
        })
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
            logger.info("MAX sent to chat %s", chat_id)
        except Exception as e:
            errors.append("chat %s: %s" % (chat_id, e))
            logger.error("MAX send to %s failed: %s", chat_id, e)

    if errors:
        return False, "; ".join(errors)
    return True, None


def test(channel_cfg):
    return send(
        channel_cfg, "test", "info",
        "Тестовое уведомление / Test notification",
        "Это тестовое уведомление от rusNAS."
    )
