#!/usr/bin/env python3
"""MAX (VK Teams) Bot API delivery channel.

If chat_ids is empty, auto-discovers subscribers via GET /chats
(returns chats where the bot is a member).
"""

import json
import logging
import os
import urllib.request
import urllib.error

logger = logging.getLogger("rusnas-notify.ch.max")

API_BASE = "https://platform-api.max.ru"
SEVERITY_EMOJI = {"critical": "\U0001f534", "warning": "\U0001f7e1", "info": "\U0001f535"}
SUBSCRIBERS_FILE = "/var/lib/rusnas/max_subscribers.json"


def _get_subscribers(token):
    """Auto-discover chats where the bot is a member via GET /chats."""
    cached = []
    if os.path.exists(SUBSCRIBERS_FILE):
        try:
            with open(SUBSCRIBERS_FILE) as f:
                cached = json.load(f)
        except Exception:
            pass

    try:
        req = urllib.request.Request(
            API_BASE + "/chats",
            headers={"Authorization": token}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        chats = data.get("chats", [])
        discovered = [str(c.get("chat_id", "")) for c in chats if c.get("chat_id")]
        if discovered:
            cached = discovered
            os.makedirs(os.path.dirname(SUBSCRIBERS_FILE), exist_ok=True)
            with open(SUBSCRIBERS_FILE, "w") as f:
                json.dump(cached, f)
    except Exception as e:
        logger.debug("MAX /chats poll: %s", e)

    return cached


def send(channel_cfg, source, severity, title, body, extra_json=None):
    """Send to chat_ids. If empty, auto-discover via /chats."""
    token = channel_cfg.get("bot_token", "")
    chat_ids = channel_cfg.get("chat_ids", [])

    if not token:
        return False, "Bot token not configured"

    if not chat_ids:
        chat_ids = _get_subscribers(token)
        if not chat_ids:
            return False, "No chat_ids configured and no chats discovered"
        logger.info("Using %d auto-discovered chat(s)", len(chat_ids))

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
