# rusNAS MCP Server + AI Agent — ТЗ

> Статус: **Сессия 1 реализована** (2026-03-22/23) — Cockpit AI-чат + NAS tools + мульти-провайдер (Yandex/Anthropic) + openEYE Agent
> Сессия 2 (HTTP SSE / Claude Desktop) — планируется

## Концепция

Предоставить LLM-агентам (Claude, GPT, локальные модели) структурированный доступ к управлению NAS через протокол **Model Context Protocol (MCP)**. Пользователь сможет управлять NAS через AI-чат в Cockpit или через внешние AI-инструменты.

---

## Компоненты

### 1. rusnas-mcp-server
Python-сервер, реализующий протокол MCP (JSON-RPC через stdio/HTTP).

**Инструменты (tools):**
- `get_status` — общий статус NAS (диски, RAID, CPU, RAM, сеть)
- `list_shares` — список SMB/NFS/FTP-шар
- `create_share / delete_share` — управление шарами
- `list_snapshots(subvol)` — список снапшотов
- `create_snapshot(subvol, label)` — создать снапшот
- `delete_snapshot(name)` — удалить снапшот
- `list_disks` — диски и RAID-массивы
- `get_raid_health` — состояние RAID
- `list_users` — пользователи
- `create_user / delete_user` — управление пользователями
- `get_events(limit)` — журнал событий Guard и снапшотов
- `run_smart_test(device)` — запустить S.M.A.R.T. тест

**Ресурсы (resources):**
- `rusnas://status` — статус системы в реальном времени
- `rusnas://shares` — конфигурация шар
- `rusnas://disks` — состояние дисков
- `rusnas://snapshots/{subvol}` — список снапшотов субволюма

### 2. AI-чат в Cockpit
Новая страница `ai.html` — встроенный чат с LLM.

- Подключение к локальной модели (Ollama) или облачной (Anthropic Claude API)
- Системный промпт с контекстом NAS (статус, шары, диски)
- Инструменты передаются как вызов функций (function calling)
- История чата сохраняется в браузере (localStorage)
- Примеры запросов: «Создай снапшот папки documents», «Покажи состояние дисков», «Почему RAID деградировал?»

---

## Архитектура

```
Cockpit AI-чат (ai.html/ai.js)
       │ cockpit.spawn / WebSocket
       ▼
rusnas-mcp-server (Python, /usr/lib/rusnas/mcp-server.py)
       │ subprocess / socket
       ▼
rusnas-snap CLI / systemd / samba / mdadm / smartctl
```

Или через HTTP (для внешних инструментов):
```
Claude Desktop / Cursor / любой MCP-клиент
       │ HTTP MCP-транспорт
       ▼
rusnas-mcp-server (HTTP-режим, порт 8765, auth token)
```

---

## Безопасность

- Аутентификация: Bearer token в HTTP-режиме (генерируется при установке)
- Опасные операции (удаление, форматирование) требуют подтверждения через отдельный инструмент `confirm_action(token)`
- Cockpit-режим: права идентичны текущему пользователю Cockpit (sudo через rusnas sudoers)
- Логирование всех AI-действий в `/var/log/rusnas/ai-actions.jsonl`

---

## Стек технологий

| Компонент | Технология |
|-----------|-----------|
| MCP-сервер | Python 3, `mcp` SDK (Anthropic) |
| AI-бэкенд | Anthropic Claude API / Ollama (llama3, mistral) |
| UI чата | HTML/JS в Cockpit (без фреймворков) |
| Транспорт | stdio (Cockpit) / HTTP SSE (внешний) |

---

## Приоритет и зависимости

- **Зависимости:** все существующие CLI-команды (`rusnas-snap`, API disks.js)
- **Приоритет:** после реализации репликации снапшотов
- **Оценка:** ~3-4 сессии разработки

---

## Реализовано (Сессия 1, 2026-03-22/23)

### Файлы

| Файл | Статус |
|------|--------|
| `cockpit/rusnas/scripts/mcp-api.py` | ✅ Реализован (11 команд + ai-chat proxy) |
| `cockpit/rusnas/ai.html` | ✅ Реализован (мульти-провайдерный UI, переключатель openEYE) |
| `cockpit/rusnas/js/ai.js` | ✅ Реализован (Yandex + Anthropic, цикл инструментов, proxy) |
| `cockpit/rusnas/css/ai.css` | ✅ Реализован |
| `cockpit/rusnas/js/eye.js` | ✅ Реализован (openEYE Agent) |
| `cockpit/rusnas/css/eye.css` | ✅ Реализован |
| `cockpit/rusnas/manifest.json` | ✅ Обновлён (запись + CSP) |
| `install-mcp.sh` | ✅ Реализован |

### Провайдеры AI

| Провайдер | API | Формат | По умолчанию |
|-----------|-----|--------|-------------|
| YandexGPT | `ai.api.cloud.yandex.net/v1/chat/completions` | OpenAI-совместимый | ✅ Да |
| Anthropic Claude | `api.anthropic.com/v1/messages` | Нативный Anthropic | нет |

### Ключевые архитектурные решения

- **Обход CORS через прокси на VM:** все AI-вызовы идут через `mcp-api.py` на VM — Python не ограничен CORS
- **Временный файл:** payload пишется в `/tmp/rusnas-ai-req.json` через `cockpit.file().replace()`, путь передаётся как argv (не stdin — баг Cockpit 337 с stdin)
- **Единый формат сообщений:** формат OpenAI внутри, `convertToAnthropicMessages()` конвертирует для Anthropic
- **openEYE:** автоматический анализ страниц, активируется через localStorage, левая панель с результатами

### Sudoers на VM

- `/etc/sudoers.d/rusnas-mcp` — NOPASSWD: python3 mcp-api.py
- `/etc/sudoers.d/rusnas-smart` — NOPASSWD: /usr/sbin/smartctl

### Не реализовано (Сессия 2)

- HTTP SSE-транспорт (порт 8765) для Claude Desktop / Cursor
- `pip install mcp` SDK (официальный протокол MCP)
- Поддержка Ollama

---

## Ссылки

- [MCP SDK Python](https://github.com/modelcontextprotocol/python-sdk)
- [Cockpit WebSocket bridge](https://cockpit-project.org/guide/latest/api-cockpit.html)
- [Ollama API](https://ollama.com/library)
