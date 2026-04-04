# Система уведомлений (rusnas-notify)

Централизованная шина уведомлений для всех модулей RusNAS. Поддерживает 5 каналов доставки, маршрутизацию по источнику, throttling и retry.

---

## Архитектура

```
┌──────────────┐     ┌──────────────┐     ┌─────────────────┐
│  guard.py    │     │ rusnas-snap  │     │  Log Watcher    │
│  ups-notify  │     │  raid events │     │  (journald/file)│
└─────┬────────┘     └──────┬───────┘     └────────┬────────┘
      │ socket/spool        │ socket/spool          │ internal
      └────────────┬────────┴───────────────────────┘
                   ▼
         ┌─────────────────────┐
         │   rusnas-notifyd    │
         │  (systemd daemon)   │
         │                     │
         │ ┌─────────────────┐ │
         │ │ Socket Server   │ │  /run/rusnas-notify/notify.sock
         │ │ Spool Watcher   │ │  /var/spool/rusnas-notify/
         │ │ Throttle Engine │ │
         │ │ Dispatcher      │ │
         │ │ Log Watcher     │ │
         │ │ SQLite DB       │ │  /var/lib/rusnas/notify.db
         │ └─────────────────┘ │
         └─────────┬───────────┘
                   │ routing matrix
      ┌────────────┼────────────┬────────────┬────────────┐
      ▼            ▼            ▼            ▼            ▼
   Email      Telegram        MAX         SNMP       Webhook
```

### Компоненты

| Компонент | Файл | Описание |
|-----------|------|----------|
| Демон | `daemon/notifyd.py` | Точка входа, жизненный цикл |
| Socket-сервер | `daemon/socket_server.py` | Unix socket JSON API |
| Spool | `daemon/spool.py` | Fallback: файловая очередь |
| Диспетчер | `daemon/dispatcher.py` | Routing + retry |
| Throttle | `daemon/throttle.py` | Rate limiter по источнику |
| Log Watcher | `daemon/log_watcher.py` | Мониторинг journald/файлов |
| БД | `daemon/db.py` | SQLite: events + deliveries |
| Конфиг | `daemon/config.py` | Загрузка/сохранение JSON |
| Каналы | `daemon/channels/` | Sender-модули (5 шт.) |
| CLI | `cli.py` | Утилита `rusnas-notify` |

---

## Конфиг (`/etc/rusnas/notify.json`)

```json
{
  "channels": {
    "email":    { "enabled": false, "smtp_host": "", "smtp_port": 587, ... },
    "telegram": { "enabled": false, "bot_token": "", "chat_ids": [] },
    "max":      { "enabled": false, "bot_token": "", "chat_ids": [] },
    "snmp":     { "enabled": false, "version": "v2c", "trap_receivers": [], ... },
    "webhook":  { "enabled": false, "urls": [], "method": "POST", ... }
  },
  "routing": {
    "guard":      { "email": true, "telegram": true, ... },
    "ups":        { "email": true, "telegram": true, ... },
    "raid":       { "email": true, ... },
    ...
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
```

### Routing matrix

Маршрутизация задается в секции `routing`. Ключ -- имя источника (`guard`, `ups`, `raid`, `snapshots`, `storage`, `network`, `security`, `containers`, `system`, `custom`). Значение -- словарь `channel: bool`.

---

## Socket API

**Протокол:** JSON через Unix socket `/run/rusnas-notify/notify.sock`. Одна строка -- один запрос, одна строка -- один ответ (newline-delimited JSON).

### send

Отправить уведомление:

```json
{
  "cmd": "send",
  "source": "guard",
  "severity": "critical",
  "title": "Обнаружен шифровальщик",
  "body": "Процесс rsync-enc модифицировал 1200 файлов за 5 секунд",
  "extra": {"pid": 12345, "path": "/mnt/data/share1"}
}
```

Ответ: `{"ok": true, "event_id": "evt_1711234567890_1234"}`

### test

Отправить тестовое уведомление в канал:

```json
{"cmd": "test", "channel": "telegram"}
```

### get_config

Получить текущую конфигурацию:

```json
{"cmd": "get_config"}
```

### save_config

Сохранить конфигурацию:

```json
{"cmd": "save_config", "config": { ... }}
```

### get_history

Получить историю уведомлений:

```json
{"cmd": "get_history", "limit": 50, "source": "guard"}
```

### status

Статус демона:

```json
{"cmd": "status"}
```

Ответ: `{"ok": true, "uptime": 86400, "events_total": 152, "channels": {"email": "ok", ...}}`

---

## CLI (`rusnas-notify`)

```bash
# Отправить уведомление
rusnas-notify send --source guard --severity critical \
    --title "Атака" --body "Подробности..."

# Тест канала
rusnas-notify test --channel email

# История
rusnas-notify history --limit 20 --source ups

# Статус демона
rusnas-notify status
```

CLI сначала пытается отправить через socket. Если демон недоступен -- пишет в spool-директорию `/var/spool/rusnas-notify/`.

---

## Интерфейс канала (Channel Sender)

Каждый канал реализует две функции:

```python
def send(event: dict, channel_config: dict) -> bool:
    """Отправить уведомление. Возвращает True при успехе."""
    ...

def test(channel_config: dict) -> bool:
    """Отправить тестовое сообщение. Возвращает True при успехе."""
    ...
```

Каналы зарегистрированы в `channels/__init__.py`:

```python
CHANNELS = {
    "email":    email_ch.send,
    "telegram": telegram_ch.send,
    "max":      max_ch.send,
    "snmp":     snmp_ch.send,
    "webhook":  webhook_ch.send,
}
```

---

## Throttle

Window-based rate limiter. Настройки в `throttle` секции конфига:

- `window_sec` (по умолчанию 300) -- длина окна в секундах
- `max_per_source` (по умолчанию 5) -- макс. событий от одного источника в окне
- `digest_delay_sec` (по умолчанию 60) -- задержка перед отправкой дайджеста

При превышении лимита события маркируются как throttled (`throttled=1` в БД) и отправляется сводный дайджест после `digest_delay_sec`.

---

## Интеграция с другими модулями

Чтобы отправить уведомление из нового модуля:

### Вариант 1: через CLI

```bash
rusnas-notify send --source mymodule --severity warning \
    --title "Something happened" --body "Details..."
```

### Вариант 2: через socket (Python)

```python
import json, socket

def notify(source, severity, title, body):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect("/run/rusnas-notify/notify.sock")
    req = {"cmd": "send", "source": source, "severity": severity,
           "title": title, "body": body}
    s.sendall(json.dumps(req).encode() + b"\n")
    resp = s.recv(4096)
    s.close()
    return json.loads(resp)
```

### Вариант 3: через spool (файл)

Если демон недоступен, можно записать JSON-файл в `/var/spool/rusnas-notify/`:

```python
import json, os, time
event = {"cmd": "send", "source": "mymodule", "severity": "info",
         "title": "...", "body": "..."}
path = "/var/spool/rusnas-notify/evt_%d.json" % int(time.time() * 1000)
with open(path, "w") as f:
    json.dump(event, f)
```

### Добавление маршрута

Добавьте источник в `routing` секцию `/etc/rusnas/notify.json`:

```json
"mymodule": {"email": true, "telegram": false, "max": false, "snmp": false, "webhook": false}
```

---

## Systemd

```
Сервис: rusnas-notifyd.service
Socket: /run/rusnas-notify/notify.sock (0o666)
Лог: /var/log/rusnas/notify.log
БД: /var/lib/rusnas/notify.db
Конфиг: /etc/rusnas/notify.json
Spool: /var/spool/rusnas-notify/
```
