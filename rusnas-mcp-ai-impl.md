# rusNAS MCP Server + AI Agent — План реализации

> Статус: **планируется** (ветка feature/mcp-ai)
> ТЗ: [rusnas_mcp_ai.MD](./rusnas_mcp_ai.MD)

К реализации в ближайшей итерации:
openEYEagent — если функция включена в настройках AI, при открытии любой страницы (например, дашборд) её текстовый вариант отправляется в AI-обработку с просьбой выделить значимые моменты для пользователя, и в открывшейся слева панели выводится всё, что нашла AI-модель с MCP.



---

## Контекст

Добавляем AI-ассистента прямо в Cockpit UI. Пользователь управляет NAS на естественном языке: «Создай снапшот», «Покажи состояние дисков», «Почему RAID деградировал?»

Реализация в **два этапа** (две ветки/сессии):

| Сессия | Что делаем |
|--------|-----------|
| **Сессия 1 (этот PR)** | Cockpit AI-чат + NAS API через cockpit.spawn. Без внешних pip-зависимостей. |
| **Сессия 2** | HTTP SSE режим (порт 8765, Bearer token) для Claude Desktop / Cursor + `pip install mcp` SDK |

---

## Архитектура Сессии 1

```
ai.html / ai.js  ──fetch()──▶  [Выбранный провайдер]
       │                           ├── Anthropic API  (api.anthropic.com)
       │                           ├── OpenAI-совмест. (openrouter.ai / api.openai.com / custom)
       │                           └── Yandex GPT     (llm.api.cloud.yandex.net)
       │                              │ tool callback
       │                              ▼
       └──cockpit.spawn──▶  mcp-api.py (Python, JSON stdio)
                                      │
                                 rusnas-snap / testparm / mdadm / smartctl / ...
```

Провайдер выбирается в настройках UI. API-ключ хранится в `localStorage` браузера — на VM не передаётся.

---

## Файлы для создания

| Файл | Тип | Описание |
|------|-----|----------|
| `cockpit/rusnas/scripts/mcp-api.py` | Новый | Диспетчер NAS-команд (JSON stdio, диспетчеризация через argv) |
| `cockpit/rusnas/ai.html` | Новый | Страница AI-чата |
| `cockpit/rusnas/js/ai.js` | Новый | Claude API + цикл вызова инструментов + renderMessages |
| `cockpit/rusnas/css/ai.css` | Новый | Стили страницы |
| `cockpit/rusnas/manifest.json` | Изменить | Добавить запись + CSP connect-src |
| `install-mcp.sh` | Новый | Деплой: sudoers + каталог логов + скрипт |

---

## 1. Бэкенд: mcp-api.py

Паттерн: диспетчеризация через argv + хелперы `ok(data)` / `err(msg)` — идентично `network-api.py`.

### Команды (11 штук)

| Команда | Реализация |
|---------|-----------|
| `get-status` | /proc/meminfo + /proc/loadavg + uptime + df -h |
| `list-shares` | testparm -s (python3 inline-парсинг) + /etc/exports |
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

## 2. Фронтенд: ai.html + ai.js + ai.css

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

CSP — добавить в `content-security-policy` широкий connect-src (покрывает любые провайдеры):
```
connect-src 'self' https: ws://localhost wss://localhost;
```

---

## Провайдеры (уровень абстракции)

Три типа провайдеров с разными форматами API:

| Провайдер | Формат | Вызов инструментов | Заголовок авторизации |
|-----------|--------|-------------------|----------------------|
| **Anthropic** | Собственный (`/v1/messages`) | Нативный (`tool_use`) | `x-api-key` |
| **OpenAI-совместимый** | OpenAI (`/v1/chat/completions`) | Нативный (`tool_calls`) | `Authorization: Bearer` |
| **Yandex GPT** | Собственный (`/foundationModels/v1/completion`) | Нет → режим ReAct | `Authorization: Api-Key` |

OpenRouter, Groq, локальный LM Studio, self-hosted vLLM — всё это **OpenAI-совместимый** тип, отличается только базовым URL.

### Настройки провайдера (localStorage)

```javascript
rusnas_ai_provider    // "anthropic" | "openai" | "yandex"
rusnas_ai_api_key     // API-ключ выбранного провайдера
rusnas_ai_base_url    // Только для openai-совместимого (https://openrouter.ai/api/v1 и т.п.)
rusnas_ai_model       // Имя модели (зависит от провайдера)
rusnas_ai_folder_id   // Только для Yandex (folder_id для modelUri)
rusnas_ai_history     // История чата (последние 50 сообщений)
```

### Структура UI настроек

```
Провайдер:   [▼ Anthropic Claude | OpenAI-совместимый | Yandex GPT]

-- Anthropic --
API Key:  [sk-ant-...]
Модель:   [▼ claude-sonnet-4-6 | claude-haiku-4-5-20251001 | claude-opus-4-6]

-- OpenAI-совместимый --
Base URL: [https://openrouter.ai/api/v1]
          [пресеты: OpenRouter | OpenAI | custom]
API Key:  [sk-...]
Модель:   [anthropic/claude-3.5-sonnet]  ← текстовый input

-- Yandex GPT --
API Key:   [AQVN...]
Folder ID: [b1g...]
Модель:    [▼ yandexgpt/latest | yandexgpt-lite/latest]
```

### Ключевые функции ai.js

```javascript
// Единая точка входа — выбирает адаптер по rusnas_ai_provider
async function callLLM(messages) {
    var p = localStorage.getItem("rusnas_ai_provider") || "anthropic";
    if (p === "anthropic") return callAnthropic(messages);
    if (p === "openai")    return callOpenAI(messages);
    if (p === "yandex")    return callYandex(messages);
}

// Anthropic — нативный tool_use
async function callAnthropic(messages) {
    // POST api.anthropic.com/v1/messages
    // headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }
    // body: { model, max_tokens, system, tools: TOOLS_SCHEMA_ANTHROPIC, messages }
    // stop_reason === "tool_use" → блоки tool_use
}

// OpenAI-совместимый — tool_calls
async function callOpenAI(messages) {
    // POST baseUrl + "/chat/completions"
    // headers: { "Authorization": "Bearer " + key }
    // body: { model, messages, tools: TOOLS_SCHEMA_OPENAI }
    // finish_reason === "tool_calls" → choices[0].message.tool_calls
}

// Yandex GPT — без нативных инструментов, ReAct через промпт
async function callYandex(messages) {
    // POST llm.api.cloud.yandex.net/foundationModels/v1/completion
    // headers: { "Authorization": "Api-Key " + key }
    // body: { modelUri: "gpt://<folder>/<model>", completionOptions: {...}, messages }
    // Ответ: result.alternatives[0].message.text
    // Парсить ACTION: tool_name(args) из текста → выполнить → передать результат
}

// Нормализация ответа в единый формат { text, toolCalls: [{id, name, args}] }
function normalizeResponse(raw, provider) { ... }

// Агентный цикл (универсальный)
async function sendMessage(userText) {
    while (true) {
        var resp = await callLLM(_messages);
        var norm = normalizeResponse(resp, getProvider());
        if (!norm.toolCalls.length) { appendAssistant(norm.text); break; }
        var results = await Promise.all(norm.toolCalls.map(executeTool));
        appendToolResults(results);
    }
}
```

### Промпт ReAct для Yandex GPT

Когда `toolSupport === false` — добавляем в системный промпт:

```
Если тебе нужна информация о NAS, используй инструменты в формате:
ACTION: tool_name(arg1, arg2)

Доступные инструменты:
- get_status() — статус системы (CPU, RAM, диски)
- list_disks() — список дисков и RAID
- list_shares() — список сетевых папок
- list_snapshots(subvol) — снапшоты подтома
- ...

После получения результата продолжи отвечать.
```

Парсинг: ищем `ACTION: (\w+)\(([^)]*)\)` в тексте ответа → выполняем → передаём результат.

### TOOLS_SCHEMA — два формата

```javascript
// Формат Anthropic
var TOOLS_SCHEMA_ANTHROPIC = [
    { name: "get_status", description: "...", input_schema: { type: "object", properties: {} } },
    ...
];

// Формат OpenAI
var TOOLS_SCHEMA_OPENAI = [
    { type: "function", function: { name: "get_status", description: "...", parameters: {...} } },
    ...
];

function getToolsSchema() {
    return getProvider() === "anthropic" ? TOOLS_SCHEMA_ANTHROPIC : TOOLS_SCHEMA_OPENAI;
}
```

---

## 3. install-mcp.sh

```bash
#!/bin/bash
# Деплой mcp-api.py + sudoers + каталог логов на VM
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
2. `ai.html` — разметка + UI настроек с переключением провайдеров
3. `ai.css` — стили чата, пузырьков, селектора провайдеров
4. `ai.js`:
   - TOOLS_SCHEMA (два формата: Anthropic + OpenAI)
   - `callAnthropic()` / `callOpenAI()` / `callYandex()` + `normalizeResponse()`
   - `callLLM()` — единая точка входа
   - `executeTool()` + агентный цикл `sendMessage()`
   - `renderMessages()` + сохранение/загрузка настроек
5. `manifest.json` — запись + CSP (`connect-src 'self' https:`)
6. `install-mcp.sh`
7. `./deploy.sh && ./install-mcp.sh`
8. Тестирование с Anthropic → затем OpenRouter → затем Yandex GPT
9. CLAUDE.md + project_history.MD

---

## Переиспользуемые паттерны

| Паттерн | Источник |
|---------|---------|
| Хелперы `ok(data)` / `err(msg)` | `cockpit/rusnas/scripts/network-api.py:15–20` |
| Обёртка cockpit.spawn для JSON | `cockpit/rusnas/js/network.js:netApi()` |
| Сохранение/загрузка настроек через localStorage | `cockpit/rusnas/js/dedup.js:loadSettings()` |
| Сворачиваемые секции | `cockpit/rusnas/css/style.css` |

---

## Что НЕ делаем в Сессии 1

- Ollama (сложная установка, не критично — через OpenAI-совместимый режим если нужно)
- HTTP SSE / внешний MCP-транспорт → Сессия 2
- `pip install mcp` SDK → Сессия 2
- Создание/удаление SMB-шар через AI (только чтение + снапшоты)
- Нативный вызов инструментов Yandex (async API) — режима ReAct достаточно для MVP

---

## Верификация

```bash
# Тест бэкенда
ssh rusnas@10.10.10.72 "sudo python3 /usr/share/cockpit/rusnas/scripts/mcp-api.py get-status"
# → JSON: {cpu_percent, ram_total, ram_used, uptime, disks}

ssh rusnas@10.10.10.72 "sudo python3 /usr/share/cockpit/rusnas/scripts/mcp-api.py list-snapshots documents"
# → JSON: [{name, created, size}, ...]

# Тест UI
# Открыть http://10.10.10.72:9090/rusnas/ai.html
# Ввести ANTHROPIC_API_KEY в настройках
# Написать: "Покажи состояние дисков"
# → Claude вызывает get_status + list_disks, отвечает на русском

# Логи
ssh rusnas@10.10.10.72 "cat /var/log/rusnas/ai-actions.jsonl"
```
