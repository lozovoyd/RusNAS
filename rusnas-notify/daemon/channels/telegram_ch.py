#!/usr/bin/env python3
"""Telegram Bot API delivery channel.

If chat_ids is empty, auto-discovers subscribers by polling getUpdates
for users who sent /start to the bot. Discovered chat_ids are cached
in /var/lib/rusnas/telegram_subscribers.json.
"""

import json
import logging
import os
import re
import urllib.request
import urllib.error

logger = logging.getLogger("rusnas-notify.ch.telegram")

SEVERITY_EMOJI = {"critical": "\U0001f534", "warning": "\U0001f7e1", "info": "\U0001f535"}
API_URL = "https://api.telegram.org/bot%s/%s"
SUBSCRIBERS_FILE = "/var/lib/rusnas/telegram_subscribers.json"


def _escape_md(text):
    """Escape MarkdownV2 special characters."""
    return re.sub(r'([_*\[\]()~`>#+\-=|{}.!\\])', r'\\\1', str(text))


def _get_subscribers(token):
    """Fetch subscribers from getUpdates — users who sent /start."""
    cached = set()
    if os.path.exists(SUBSCRIBERS_FILE):
        try:
            with open(SUBSCRIBERS_FILE) as f:
                cached = set(json.load(f))
        except Exception:
            pass

    # Poll getUpdates for new /start messages
    try:
        url = API_URL % (token, "getUpdates")
        req = urllib.request.Request(url, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        for update in data.get("result", []):
            msg = update.get("message", {})
            text = msg.get("text", "")
            chat_id = msg.get("chat", {}).get("id")
            if chat_id and text.strip().startswith("/start"):
                cached.add(str(chat_id))
    except Exception as e:
        logger.debug("getUpdates poll: %s", e)

    # Save updated subscribers
    if cached:
        try:
            os.makedirs(os.path.dirname(SUBSCRIBERS_FILE), exist_ok=True)
            with open(SUBSCRIBERS_FILE, "w") as f:
                json.dump(list(cached), f)
        except Exception:
            pass

    return list(cached)


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send to chat_ids. If empty, auto-discover /start subscribers."""
    token = channel_cfg.get("bot_token", "")
    chat_ids = channel_cfg.get("chat_ids", [])

    if not token:
        return False, "Bot token not configured"

    # Auto-discover subscribers if no explicit chat_ids
    if not chat_ids:
        chat_ids = _get_subscribers(token)
        if not chat_ids:
            return False, "No chat_ids configured and no /start subscribers found"
        logger.info("Using %d auto-discovered subscriber(s)", len(chat_ids))

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
