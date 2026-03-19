#!/usr/bin/env python3
# fb-users-list.py — Список пользователей FileBrowser + WAN-настройки → JSON
# Использует API (GET только) + access_rules.json для WAN флага

import json
import sys
import urllib.request
import urllib.error
import os
import subprocess

FB_URL = "http://127.0.0.1:8088/files/api"
TOKEN_FILE = "/etc/rusnas/filebrowser/admin_token"
ACCESS_RULES_FILE = "/etc/rusnas/filebrowser/access_rules.json"
FB_BIN = "/usr/local/bin/filebrowser"
FB_CFG = "/etc/rusnas/filebrowser/settings.json"


def get_token():
    if not os.path.exists(TOKEN_FILE):
        return None
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except Exception:
        return None


def check_service_active():
    try:
        r = subprocess.run(
            ["systemctl", "is-active", "rusnas-filebrowser"],
            capture_output=True, text=True, timeout=3
        )
        return r.stdout.strip() == "active"
    except Exception:
        return False


def get_access_rules():
    if not os.path.exists(ACCESS_RULES_FILE):
        return {}
    try:
        with open(ACCESS_RULES_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def get_users_via_api(token):
    """GET /api/users — чтение работает без проблем с API"""
    req = urllib.request.Request(FB_URL + "/users")
    req.add_header("X-Auth", token)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def get_users_via_cli():
    """Fallback: читаем из CLI вывода (сервис должен быть остановлен)"""
    # CLI не работает пока сервис запущен — вернём пустой список
    return []


def main():
    active = check_service_active()
    if not active:
        print(json.dumps({"ok": False, "error": "Service not running", "users": [], "active": False}))
        return

    token = get_token()
    if not token:
        print(json.dumps({"ok": False, "error": "No admin token", "users": [], "active": True}))
        return

    users = get_users_via_api(token)
    if users is None:
        print(json.dumps({"ok": False, "error": "API unavailable", "users": [], "active": True}))
        return

    access_rules = get_access_rules()

    result = []
    for u in users:
        name = u.get("username", "")
        if name == "admin":
            continue  # Не показываем admin в Cockpit UI
        rule = access_rules.get(name, {})
        result.append({
            "id": u.get("id"),
            "username": name,
            "scope": u.get("scope", "."),
            "is_admin": u.get("perm", {}).get("admin", False),
            "wan_enabled": rule.get("wan_enabled", False),
            "can_download": u.get("perm", {}).get("download", True),
            "can_upload": u.get("perm", {}).get("create", True),
            "can_delete": u.get("perm", {}).get("delete", True),
        })

    print(json.dumps({"ok": True, "users": result, "active": True}))


if __name__ == "__main__":
    main()
