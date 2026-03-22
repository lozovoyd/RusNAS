# rusNAS MCP Server + AI Agent — Implementation Plan

> Статус: **планируется** (ветка feature/mcp-ai)
> ТЗ: [rusnas_mcp_ai.MD](./rusnas_mcp_ai.MD)

---

## Контекст

Добавляем AI-ассистента прямо в Cockpit UI. Пользователь управляет NAS на естественном языке: "Создай снапшот", "Покажи состояние дисков", "Почему RAID деградировал?"

Реализация в **два этапа** (две ветки/сессии):

| Session | Что делаем |
|---------|-----------|
| **Session 1 (этот PR)** | Cockpit AI чат + NAS API через cockpit.spawn. Без внешних pip-зависимостей. |
| **Session 2** | HTTP SSE mode (порт 8765, Bearer token) для Claude Desktop / Cursor + `pip install mcp` SDK |

---

## Архитектура Session 1

```
ai.html / ai.js  ──fetch()──▶  Anthropic Claude API (claude-sonnet-4-6)
       │                              │ tool_use callback
       │                              ▼
       └──cockpit.spawn──▶  mcp-api.py (Python, JSON stdio)
                                      │
                                 rusnas-snap / testparm / mdadm / smartctl / ...
```

---

## Файлы для создания

| Файл | Тип | Описание |
|------|-----|----------|
| `cockpit/rusnas/scripts/mcp-api.py` | Новый | NAS command dispatcher (JSON stdio, argv dispatch) |
| `cockpit/rusnas/ai.html` | Новый | Страница AI-чата |
| `cockpit/rusnas/js/ai.js` | Новый | Claude API + tool calling loop + renderMessages |
| `cockpit/rusnas/css/ai.css` | Новый | Стили страницы |
| `cockpit/rusnas/manifest.json` | Изменить | Добавить entry + CSP connect-src |
| `install-mcp.sh` | Новый | Deploy: sudoers + log dir + скрипт |

---

## 1. Backend: mcp-api.py

Паттерн: argv dispatch + `ok(data)` / `err(msg)` helpers — идентично `network-api.py`.

### Команды (11 штук)

| Команда | Реализация |
|---------|-----------|
| `get-status` | /proc/meminfo + /proc/loadavg + uptime + df -h |
| `list-shares` | testparm -s (python3 inline parse) + /etc/exports |
| `list-disks` | lsblk -J + /proc/mdstat |
| `list-raid` | mdadm --detail /dev/md* |
| `list-snapshots SUBVOL` | sudo rusnas-snap list `<subvol>` |
| `create-snapshot SUBVOL LABEL` | sudo rusnas-snap create `<subvol>` -l `<label>` |
| `delete-snapshot SUBVOL NAME` | sudo rusnas-snap delete `<subvol>` `<name>` |
| `list-users` | getent passwd (uid 1000–60000) |
| `get-events LIMIT` | tail -N /var/log/rusnas-guard/events.jsonl |
| `run-smart-test DEVICE` | sudo smartctl -t short /dev/`<device>` |
| `get-smart DEVICE` | sudo smartctl -a /dev/`<device>` |

### Логирование опасных операций

`create-snapshot`, `delete-snapshot`, `run-smart-test` → `/var/log/rusnas/ai-actions.jsonl`:
```json
{"ts": "2026-03-22T10:00:00", "command": "create-snapshot", "args": ["documents", "test"], "source": "cockpit"}
```

### Sudoers: `/etc/sudoers.d/rusnas-mcp`

```
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/mcp-api.py *
```

---

## 2. Frontend: ai.html + ai.js + ai.css

### Структура страницы

```
[Шапка: "🤖 AI Ассистент для NAS"]
[Статус-бар: контекст NAS загружен / API key не задан]

[История чата: user / assistant / tool_result блоки]

[Textarea] [▶ Отправить] [🗑 Очистить]

[▼ Настройки: API Key | Модель | URL Ollama]
```

### manifest.json — добавить в `tools`

```json
{
    "label": "AI Ассистент",
    "order": 11,
    "path": "ai.html"
}
```

CSP — добавить в `content-security-policy`:
```
connect-src 'self' https://api.anthropic.com ws://localhost wss://localhost;
```

### Ключевые функции ai.js

```javascript
// Вызов NAS инструмента
function nasCmd(args) { /* cockpit.spawn → JSON parse */ }

// Вызов Claude API (прямой fetch, API key из localStorage)
async function callClaude(messages) { /* fetch api.anthropic.com/v1/messages */ }

// Агентный цикл
async function sendMessage(userText) {
    while (resp.stop_reason === "tool_use") {
        // Выполнить все tool_use блоки → tool_result → снова callClaude
    }
}

// Инструменты (TOOLS_SCHEMA) — 11 штук, mapped на mcp-api.py команды
```

### localStorage

- `rusnas_claude_key` — API ключ (никогда не уходит на VM)
- `rusnas_ai_model` — claude-sonnet-4-6 / claude-haiku-4-5-20251001
- `rusnas_ai_history` — история чата (последние 50 сообщений)

---

## 3. install-mcp.sh

```bash
#!/bin/bash
# Деплой mcp-api.py + sudoers + log dir на VM
VM="rusnas@10.10.10.72"

scp cockpit/rusnas/scripts/mcp-api.py $VM:/tmp/

ssh $VM "
  sudo cp /tmp/mcp-api.py /usr/share/cockpit/rusnas/scripts/ &&
  sudo chmod 644 /usr/share/cockpit/rusnas/scripts/mcp-api.py &&
  sudo mkdir -p /var/log/rusnas && sudo chmod 755 /var/log/rusnas &&
  echo 'rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/mcp-api.py *' |
    sudo tee /etc/sudoers.d/rusnas-mcp &&
  sudo chmod 440 /etc/sudoers.d/rusnas-mcp
"
echo "✓ MCP API deployed"
```

---

## Порядок реализации

1. `mcp-api.py` — все 11 команд + логирование
2. `ai.html` — layout страницы (viewport meta, структура)
3. `ai.css` — стили чата и бабблов
4. `ai.js` — TOOLS_SCHEMA + callClaude() + executeTool() + tool use loop + renderMessages()
5. `manifest.json` — entry + CSP
6. `install-mcp.sh`
7. `./deploy.sh && ./install-mcp.sh`
8. Тест: ai.html → API key → "Покажи состояние дисков"
9. CLAUDE.md + project_history.MD

---

## Переиспользуемые паттерны

| Паттерн | Источник |
|---------|---------|
| `ok(data)` / `err(msg)` helpers | `cockpit/rusnas/scripts/network-api.py:15–20` |
| cockpit.spawn JSON wrapper | `cockpit/rusnas/js/network.js:netApi()` |
| localStorage save/load settings | `cockpit/rusnas/js/dedup.js:loadSettings()` |
| Collapsible sections | `cockpit/rusnas/css/style.css` |

---

## Что НЕ делаем в Session 1

- Ollama (сложная установка, не критично для MVP)
- HTTP SSE / внешний MCP транспорт → Session 2
- `pip install mcp` SDK → Session 2
- Создание/удаление SMB шар через AI (только read + snapshots)

---

## Верификация

```bash
# Backend тест
ssh rusnas@10.10.10.72 "sudo python3 /usr/share/cockpit/rusnas/scripts/mcp-api.py get-status"
# → JSON: {cpu_percent, ram_total, ram_used, uptime, disks}

ssh rusnas@10.10.10.72 "sudo python3 /usr/share/cockpit/rusnas/scripts/mcp-api.py list-snapshots documents"
# → JSON: [{name, created, size}, ...]

# UI тест
# Открыть http://10.10.10.72:9090/rusnas/ai.html
# Ввести ANTHROPIC_API_KEY в настройках
# Написать: "Покажи состояние дисков"
# → Claude вызывает get_status + list_disks, отвечает на русском

# Логи
ssh rusnas@10.10.10.72 "cat /var/log/rusnas/ai-actions.jsonl"
```
