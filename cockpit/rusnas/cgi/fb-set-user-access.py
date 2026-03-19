#!/usr/bin/env python3
# fb-set-user-access.py — Обновление scope/wan пользователя FileBrowser
# Использование: fb-set-user-access.py <username> <scope> <wan:0|1> <download:0|1> <upload:0|1> <delete:0|1>
# Scope обновляется через CLI (стоп/старт сервиса). WAN флаг — локально в access_rules.json.

import json
import sys
import subprocess
import os

ACCESS_RULES_FILE = "/etc/rusnas/filebrowser/access_rules.json"
FB_BIN = "/usr/local/bin/filebrowser"
FB_CFG = "/etc/rusnas/filebrowser/settings.json"
SERVICE = "rusnas-filebrowser"


def run(cmd, check=False):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=15, check=check)


def load_access_rules():
    if not os.path.exists(ACCESS_RULES_FILE):
        return {}
    try:
        with open(ACCESS_RULES_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_access_rules(rules):
    os.makedirs(os.path.dirname(ACCESS_RULES_FILE), exist_ok=True)
    with open(ACCESS_RULES_FILE, "w") as f:
        json.dump(rules, f, indent=2)


def update_user_via_cli(username, scope):
    """Обновляем scope через CLI — требует остановки сервиса."""
    run(["systemctl", "stop", SERVICE])
    import time; time.sleep(0.5)
    try:
        result = run([FB_BIN, "--config", FB_CFG, "users", "update",
                      username, f"--scope={scope}"])
        return result.returncode == 0, result.stderr.strip()
    finally:
        run(["systemctl", "start", SERVICE])


def main():
    if len(sys.argv) < 7:
        print(json.dumps({"ok": False, "error": "Usage: username scope wan download upload delete"}))
        sys.exit(1)

    username = sys.argv[1]
    scope = sys.argv[2]
    wan_enabled = sys.argv[3] == "1"
    # Права (download/upload/delete) пока только сохраняем в access_rules
    # (полная поддержка через CLI update потребует расширения)

    # Обновляем scope через CLI
    ok, err = update_user_via_cli(username, scope)
    if not ok:
        print(json.dumps({"ok": False, "error": f"CLI update failed: {err}"}))
        sys.exit(1)

    # Обновляем access_rules (WAN flag + права)
    rules = load_access_rules()
    rules[username] = {
        "wan_enabled": wan_enabled,
        "can_download": sys.argv[4] == "1",
        "can_upload": sys.argv[5] == "1",
        "can_delete": sys.argv[6] == "1",
    }
    save_access_rules(rules)

    print(json.dumps({"ok": True, "username": username}))


if __name__ == "__main__":
    main()
