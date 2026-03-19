#!/usr/bin/env python3
# fb-sync-user.py — Синхронизация одного пользователя Linux → FileBrowser
# Использование: fb-sync-user.py <action> <username> [password]
#   action: create | update | delete
#
# Использует filebrowser CLI (с кратким стопом/стартом сервиса для доступа к БД)

import sys
import subprocess
import os
import pwd

FB_BIN = "/usr/local/bin/filebrowser"
FB_CFG = "/etc/rusnas/filebrowser/settings.json"
SERVICE = "rusnas-filebrowser"
SKIP_USERS = {"root", "admin", "nobody"}


def run(cmd, check=True):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=15, check=check)


def service_stop():
    run(["systemctl", "stop", SERVICE], check=False)


def service_start():
    run(["systemctl", "start", SERVICE], check=False)


def get_home_dir(username):
    try:
        return pwd.getpwnam(username).pw_dir
    except KeyError:
        return f"/home/{username}"


def fb_cli(*args):
    """Run filebrowser CLI command. Service must be stopped."""
    cmd = [FB_BIN, "--config", FB_CFG] + list(args)
    return run(cmd, check=False)


def user_exists(username):
    result = fb_cli("users", "ls")
    return username in result.stdout


def sync_create(username, password):
    home = get_home_dir(username)
    if not password:
        password = f"rusnas_{username}_2026"

    service_stop()
    try:
        if user_exists(username):
            fb_cli("users", "update", username, "--password", password, f"--scope={home}")
            print(f"[fb-sync] Updated user: {username}")
        else:
            fb_cli("users", "add", username, password,
                   f"--scope={home}", "--perm.admin=false")
            print(f"[fb-sync] Created user: {username}")
    finally:
        service_start()


def sync_update(username, password):
    home = get_home_dir(username)
    service_stop()
    try:
        if user_exists(username):
            args = ["users", "update", username, f"--scope={home}"]
            if password:
                args += ["--password", password]
            fb_cli(*args)
            print(f"[fb-sync] Updated user: {username}")
        else:
            # Создаём если нет
            if not password:
                password = f"rusnas_{username}_2026"
            fb_cli("users", "add", username, password,
                   f"--scope={home}", "--perm.admin=false")
            print(f"[fb-sync] Created user: {username}")
    finally:
        service_start()


def sync_delete(username):
    service_stop()
    try:
        if user_exists(username):
            fb_cli("users", "rm", username)
            print(f"[fb-sync] Deleted user: {username}")
    finally:
        service_start()


def main():
    if len(sys.argv) < 3:
        print("Usage: fb-sync-user.py <create|update|delete> <username> [password]",
              file=sys.stderr)
        sys.exit(1)

    action = sys.argv[1]
    username = sys.argv[2]
    password = sys.argv[3] if len(sys.argv) > 3 else ""

    if username in SKIP_USERS:
        sys.exit(0)

    # Только реальные Linux-пользователи (UID >= 1000)
    try:
        pw = pwd.getpwnam(username)
        if pw.pw_uid < 1000 and action != "delete":
            sys.exit(0)
    except KeyError:
        if action != "delete":
            sys.exit(0)

    try:
        if action == "create":
            sync_create(username, password)
        elif action == "update":
            sync_update(username, password)
        elif action == "delete":
            sync_delete(username)
        else:
            print(f"Unknown action: {action}", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"[fb-sync] Error: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
