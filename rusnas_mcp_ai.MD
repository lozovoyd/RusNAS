# rusNAS MCP Server + AI Agent — ТЗ

> Статус: **планируется** (не реализовано)

## Концепция

Предоставить LLM-агентам (Claude, GPT, локальные модели) структурированный доступ к управлению NAS через протокол **Model Context Protocol (MCP)**. Пользователь сможет управлять NAS через AI-чат в Cockpit или через внешние AI-инструменты.

---

## Компоненты

### 1. rusnas-mcp-server
Python-сервер, реализующий MCP protocol (JSON-RPC over stdio/HTTP).

**Инструменты (tools):**
- `get_status` — общий статус NAS (диски, RAID, CPU, RAM, сеть)
- `list_shares` — список SMB/NFS/FTP шар
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
- `rusnas://status` — live-статус системы
- `rusnas://shares` — конфигурация шар
- `rusnas://disks` — состояние дисков
- `rusnas://snapshots/{subvol}` — список снапшотов субволюма

### 2. AI-чат в Cockpit
Новая страница `ai.html` — встроенный чат с LLM.

- Подключение к локальной модели (Ollama) или облачной (Anthropic Claude API)
- Системный промпт с контекстом NAS (статус, шары, диски)
- Инструменты передаются как function calling
- История чата сохраняется в браузере (localStorage)
- Примеры запросов: "Создай снапшот папки documents", "Покажи состояние дисков", "Почему RAID деградировал?"

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
       │ HTTP MCP transport
       ▼
rusnas-mcp-server (HTTP mode, порт 8765, auth token)
```

---

## Безопасность

- Аутентификация: Bearer token в HTTP-режиме (генерируется при установке)
- Опасные операции (удаление, форматирование) требуют подтверждения через отдельный `confirm_action(token)` tool
- Cockpit-режим: права идентичны текущему пользователю Cockpit (sudo через rusnas sudoers)
- Логирование всех AI-действий в `/var/log/rusnas/ai-actions.jsonl`

---

## Стек

| Компонент | Технология |
|-----------|-----------|
| MCP server | Python 3, `mcp` SDK (Anthropic) |
| AI backend | Anthropic Claude API / Ollama (llama3, mistral) |
| Чат UI | HTML/JS в Cockpit (без фреймворков) |
| Transport | stdio (Cockpit) / HTTP SSE (внешний) |

---

## Приоритет и зависимости

- **Зависимости:** все существующие CLI-команды (`rusnas-snap`, disks.js API)
- **Приоритет:** после реализации репликации снапшотов
- **Оценка:** ~3-4 сессии разработки

---

## Ссылки

- [MCP SDK Python](https://github.com/modelcontextprotocol/python-sdk)
- [Cockpit WebSocket bridge](https://cockpit-project.org/guide/latest/api-cockpit.html)
- [Ollama API](https://ollama.com/library)
