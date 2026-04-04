# API rusnas-notify

**rusnas-notify** -- централизованная система уведомлений RusNAS.

- **CLI:** `/usr/local/bin/rusnas-notify`
- **Демон:** `rusnas-notifyd.service`
- **Socket:** `/run/rusnas-notify/notify.sock` (JSON, newline-delimited)
- **БД:** `/var/lib/rusnas/notify.db` (SQLite)
- **Конфиг:** `/etc/rusnas/notify.json`
- **Спецификация:** [Модуль уведомлений](../../modules/notifications.md)

---

## CLI интерфейс

### rusnas-notify send

Отправка уведомления через socket (fallback: spool).

```
rusnas-notify send --source SOURCE --severity SEVERITY --title TITLE --body BODY [--extra JSON]
```

| Параметр | Обязателен | Описание |
|----------|------------|----------|
| `--source` | да | Имя модуля-источника (`guard`, `ups`, `raid`, ...) |
| `--severity` | да | Уровень: `info`, `warning`, `critical` |
| `--title` | да | Заголовок уведомления |
| `--body` | да | Текст уведомления |
| `--extra` | нет | JSON-строка с дополнительными данными |

Ответ (stdout, JSON):

```json
{"ok": true, "event_id": "evt_1711234567890_1234"}
```

### rusnas-notify test

Отправка тестового сообщения в указанный канал.

```
rusnas-notify test --channel CHANNEL
```

Каналы: `email`, `telegram`, `max`, `snmp`, `webhook`.

### rusnas-notify history

Получение истории уведомлений.

```
rusnas-notify history [--limit N] [--source SOURCE]
```

### rusnas-notify status

Статус демона и каналов.

```
rusnas-notify status
```

---

## Socket протокол

**Путь:** `/run/rusnas-notify/notify.sock` (Unix socket, SOCK_STREAM)

**Формат:** newline-delimited JSON. Каждый запрос и ответ -- одна JSON-строка завершенная `\n`.

### Команды

| Команда | Описание |
|---------|----------|
| `send` | Отправить уведомление |
| `test` | Тест канала |
| `get_config` | Получить конфигурацию |
| `save_config` | Сохранить конфигурацию |
| `get_history` | История событий |
| `status` | Статус демона |

### Пример (Python)

```python
import json, socket

def notify_send(source, severity, title, body):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect("/run/rusnas-notify/notify.sock")
    req = {"cmd": "send", "source": source, "severity": severity,
           "title": title, "body": body}
    s.sendall(json.dumps(req).encode("utf-8") + b"\n")
    buf = b""
    while b"\n" not in buf:
        data = s.recv(4096)
        if not data:
            break
        buf += data
    s.close()
    return json.loads(buf.split(b"\n")[0])
```

---

## Схема БД

**Файл:** `/var/lib/rusnas/notify.db` (SQLite)

### Таблица `events`

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | Уникальный ID события (`evt_<timestamp>_<pid>`) |
| `source` | TEXT NOT NULL | Модуль-источник |
| `severity` | TEXT NOT NULL | `info`, `warning`, `critical` |
| `title` | TEXT NOT NULL | Заголовок |
| `body` | TEXT | Текст |
| `extra_json` | TEXT | JSON с доп. данными |
| `created_at` | TEXT NOT NULL | ISO 8601 timestamp |
| `throttled` | INTEGER | 0 = доставлено, 1 = подавлено throttle |

### Таблица `deliveries`

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | INTEGER PK | Auto-increment |
| `event_id` | TEXT FK | Ссылка на events.id |
| `channel` | TEXT NOT NULL | Имя канала |
| `status` | TEXT | `pending`, `sent`, `failed` |
| `attempts` | INTEGER | Количество попыток |
| `last_attempt` | TEXT | Timestamp последней попытки |
| `error` | TEXT | Текст ошибки (если failed) |

### Таблица `throttle_state`

| Столбец | Тип | Описание |
|---------|-----|----------|
| `source` | TEXT PK | Имя источника |
| `window_start` | TEXT | Начало текущего окна |
| `event_count` | INTEGER | Счетчик событий в окне |

---

## Channel Sender API

Каждый канал в `daemon/channels/` реализует две функции:

### send(event, channel_config) -> bool

Отправляет уведомление. Возвращает `True` при успехе.

```python
def send(event: dict, channel_config: dict) -> bool:
    """
    Args:
        event: {"id", "source", "severity", "title", "body", "extra_json", "created_at"}
        channel_config: секция конфига канала из notify.json
    Returns:
        True при успешной отправке
    """
```

### test(channel_config) -> bool

Отправляет тестовое сообщение. Возвращает `True` при успехе.

```python
def test(channel_config: dict) -> bool:
    """
    Args:
        channel_config: секция конфига канала из notify.json
    Returns:
        True при успешной отправке тестового сообщения
    """
```

### Реестр каналов

```python
# daemon/channels/__init__.py
CHANNELS = {
    "email":    email_ch.send,
    "telegram": telegram_ch.send,
    "max":      max_ch.send,
    "snmp":     snmp_ch.send,
    "webhook":  webhook_ch.send,
}
TEST_CHANNELS = {
    "email":    email_ch.test,
    "telegram": telegram_ch.test,
    "max":      max_ch.test,
    "snmp":     snmp_ch.test,
    "webhook":  webhook_ch.test,
}
```
