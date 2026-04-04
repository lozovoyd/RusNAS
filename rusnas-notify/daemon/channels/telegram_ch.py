#!/usr/bin/env python3
"""Telegram Bot API delivery channel."""

import json
import logging
import re
import urllib.request
import urllib.error

logger = logging.getLogger("rusnas-notify.ch.telegram")

SEVERITY_EMOJI = {"critical": "\U0001f534", "warning": "\U0001f7e1", "info": "\U0001f535"}
API_URL = "https://api.telegram.org/bot%s/sendMessage"


def _escape_md(text):
    """Escape MarkdownV2 special characters."""
    return re.sub(r'([_*\[\]()~`>#+\-=|{}.!\\])', r'\\\1', str(text))


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send to all chat_ids. Returns (ok, error_msg)."""
    token = channel_cfg.get("bot_token", "")
    chat_ids = channel_cfg.get("chat_ids", [])

    if not token or not chat_ids:
        return False, "Bot token or chat_ids not configured"

    emoji = SEVERITY_EMOJI.get(severity, "\u2139\ufe0f")
    text = "%s *%s*\n*%s* \\| %s\n\n%s" % (
        emoji,
        _escape_md(severity.upper()),
        _escape_md(source.capitalize()),
        _escape_md(title),
        _escape_md(body or "")
    )

    url = API_URL % token
    errors = []
    for chat_id in chat_ids:
        payload = json.dumps({
            "chat_id": str(chat_id),
            "text": text,
            "parse_mode": "MarkdownV2"
        }).encode("utf-8")
        req = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
            logger.info("Telegram sent to chat %s", chat_id)
        except Exception as e:
            errors.append("chat %s: %s" % (chat_id, e))
            logger.error("Telegram send to %s failed: %s", chat_id, e)

    if errors:
        return False, "; ".join(errors)
    return True, None


def test(channel_cfg):
    return send(
        channel_cfg, "test", "info",
        "Тестовое уведомление / Test notification",
        "Это тестовое уведомление от rusNAS."
    )
