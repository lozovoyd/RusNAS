#!/usr/bin/env python3
"""Configuration loader for rusnas-notify daemon."""

import json
import logging
import os

logger = logging.getLogger("rusnas-notify.config")

CONFIG_PATH = "/etc/rusnas/notify.json"

DEFAULT_CONFIG = {
    "channels": {
        "email": {
            "enabled": False,
            "smtp_host": "",
            "smtp_port": 587,
            "smtp_tls": "starttls",
            "smtp_user": "",
            "smtp_pass": "",
            "recipients": [],
            "from": "rusNAS <noreply@localhost>"
        },
        "telegram": {
            "enabled": False,
            "bot_token": "",
            "chat_ids": []
        },
        "max": {
            "enabled": False,
            "bot_token": "",
            "chat_ids": []
        },
        "snmp": {
            "enabled": False,
            "version": "v2c",
            "community": "public",
            "trap_receivers": [],
            "v3_username": "",
            "v3_auth_protocol": "SHA",
            "v3_auth_password": "",
            "v3_priv_protocol": "AES",
            "v3_priv_password": ""
        },
        "webhook": {
            "enabled": False,
            "urls": [],
            "method": "POST",
            "headers": {},
            "timeout_sec": 10
        }
    },
    "routing": {
        "guard":      {"email": True, "telegram": True, "max": False, "snmp": True, "webhook": True},
        "ups":        {"email": True, "telegram": True, "max": False, "snmp": True, "webhook": False},
        "raid":       {"email": True, "telegram": True, "max": False, "snmp": True, "webhook": False},
        "snapshots":  {"email": True, "telegram": False, "max": False, "snmp": False, "webhook": False},
        "storage":    {"email": True, "telegram": False, "max": False, "snmp": False, "webhook": False},
        "network":    {"email": True, "telegram": False, "max": False, "snmp": False, "webhook": False},
        "security":   {"email": True, "telegram": True, "max": False, "snmp": True, "webhook": False},
        "containers": {"email": True, "telegram": False, "max": False, "snmp": False, "webhook": False},
        "system":     {"email": True, "telegram": True, "max": False, "snmp": True, "webhook": False},
        "custom":     {"email": True, "telegram": False, "max": False, "snmp": False, "webhook": False}
    },
    "throttle": {
        "window_sec": 300,
        "max_per_source": 5,
        "digest_delay_sec": 60
    },
    "retry": {
        "max_attempts": 3,
        "backoff_sec": [30, 120, 600]
    },
    "log_watchers": []
}


def load_config(path=None):
    """Load config from file, merging with defaults."""
    config_path = path or CONFIG_PATH
    config = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy

    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                user = json.load(f)
            _deep_merge(config, user)
            logger.info("Config loaded from %s", config_path)
        except Exception as e:
            logger.error("Failed to load config %s: %s, using defaults", config_path, e)
    else:
        logger.info("No config file at %s, using defaults", config_path)

    return config


def save_config(config, path=None):
    """Save config to file."""
    config_path = path or CONFIG_PATH
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    logger.info("Config saved to %s", config_path)


def _deep_merge(base, override):
    """Recursively merge override into base dict."""
    for k, v in override.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
