#!/usr/bin/env python3
# fb-sync-all-users.py — Первичная синхронизация всех Linux-пользователей (UID>=1000) → FileBrowser
# Вызывается из fb-init.sh при первом деплое. Сервис должен быть ОСТАНОВЛЕН.

import subprocess
import os
import pwd

FB_BIN = "/usr/local/bin/filebrowser"
FB_CFG = "/etc/rusnas/filebrowser/settings.json"
SKIP_USERS = {"nobody"}


def run(cmd, check=False):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=15, check=check)


def fb_cli(*args):
    cmd = [FB_BIN, "--config", FB_CFG] + list(args)
    return run(cmd)


def get_existing_fb_users():
    result = fb_cli("users", "ls")
    users = set()
    for line in result.stdout.splitlines():
        parts = line.split()
        # Format: ID Username Scope ...
        if len(parts) >= 2 and parts[0].isdigit():
            users.add(parts[1])
    return users


def get_linux_users():
    users = []
    for entry in pwd.getpwall():
        if entry.pw_uid >= 1000 and entry.pw_name not in SKIP_USERS:
            # Filter out cockpit system accounts
            if entry.pw_name.startswith("cockpit-"):
                continue
            users.append({"name": entry.pw_name, "home": entry.pw_dir})
    return users


def main():
    linux_users = get_linux_users()
    fb_users = get_existing_fb_users()

    print(f"[fb-sync-all] Linux users: {[u['name'] for u in linux_users]}")
    print(f"[fb-sync-all] Existing FB users: {fb_users}")

    for user in linux_users:
        name = user["name"]
        home = user["home"]

        if name in fb_users:
            print(f"[fb-sync-all] Skip existing: {name}")
            continue

        default_pass = f"rusnas_{name}_2026"
        result = fb_cli("users", "add", name, default_pass,
                        f"--scope={home}", "--perm.admin=false")
        if result.returncode == 0:
            print(f"[fb-sync-all] Created: {name} (scope: {home}, pass: {default_pass})")
        else:
            print(f"[fb-sync-all] Failed to create {name}: {result.stderr.strip()}")


if __name__ == "__main__":
    main()
