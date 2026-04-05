# Notification System (rusnas-notify)

> Статус: ✅ Реализован
> Ветка: main
> Deploy: `./install-notify.sh`

## Описание
Централизованная система уведомлений для rusNAS. Поддерживает 5 каналов доставки: Email, Telegram, MAX, SNMP traps, Webhook.

## Архитектура
- Daemon: `/usr/lib/rusnas/notify/notifyd.py` (systemd Type=simple)
- CLI: `/usr/local/bin/rusnas-notify` (send, test, history, status)
- Socket: `/run/rusnas-notify/notify.sock` (0o666, no auth)
- Config: `/etc/rusnas/notify.json`
- DB: `/var/lib/rusnas/notify.db` (SQLite WAL)
- Spool: `/var/spool/rusnas-notify/` (CLI fallback)

## Implementation Notes

<!-- ОБНОВЛЯЕТСЯ Claude Code при каждом изменении модуля -->

- Channels: Email, Telegram, MAX, SNMP traps, Webhook
- Checker: `notify-check.py` via timer every 5 min
- Log Watcher: built-in thread, regex patterns from config
- RULE: any dashboard widget MUST have notification integration (rusnas-notify)
- Docs: dev — `docs/src/modules/notifications.md`, API — `docs/src/api/python/notify.md`, user — `user-docs/docs/notifications.md`
- Design spec: `docs/designs/2026-04-04-notification-system-design.md`
