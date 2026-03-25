// rusNAS AI Assistant
// ai.js — Multi-provider (Yandex GPT / Anthropic Claude) + NAS tool calling

"use strict";

var MCP_SCRIPT = "/usr/share/cockpit/rusnas/scripts/mcp-api.py";

// Yandex AI Studio
// AI calls go through mcp-api.py proxy on VM — no CORS restrictions
var YANDEX_DEFAULT_KEY   = "";
var YANDEX_DEFAULT_FOLDER= "b1g2ikacmpc41ubdbitv";
var YANDEX_DEFAULT_MODEL = "yandexgpt-5-pro/latest";

// Anthropic
var ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";

// localStorage keys
var KEY_PROVIDER   = "rusnas_ai_provider";   // "yandex" | "anthropic"
var KEY_YA_KEY     = "rusnas_yandex_key";
var KEY_YA_FOLDER  = "rusnas_yandex_folder";
var KEY_YA_MODEL   = "rusnas_yandex_model";
var KEY_AN_KEY     = "rusnas_claude_key";
var KEY_AN_MODEL   = "rusnas_ai_model";
var KEY_MAXTOKENS  = "rusnas_ai_maxtokens";
var KEY_HISTORY    = "rusnas_ai_history";

var MAX_HISTORY = 100; // max messages to keep

// ── Tool schema (OpenAI / Yandex format) ──────────────────────────────────────

var TOOLS_OPENAI = [
    {
        type: "function",
        function: {
            name: "get_status",
            description: "Получить системную информацию NAS: uptime, загрузка CPU, память, использование дисков (df).",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    {
        type: "function",
        function: {
            name: "list_shares",
            description: "Список SMB (Samba) и NFS шар на NAS.",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    {
        type: "function",
        function: {
            name: "list_disks",
            description: "Список физических дисков (lsblk) и состояние RAID (/proc/mdstat).",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    {
        type: "function",
        function: {
            name: "list_raid",
            description: "Детальная информация о RAID-массивах (mdadm --detail).",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    {
        type: "function",
        function: {
            name: "list_snapshots",
            description: "Список Btrfs снапшотов для указанного субволюма.",
            parameters: {
                type: "object",
                properties: {
                    subvol: { type: "string", description: "Имя субволюма, например: documents, homes" }
                },
                required: ["subvol"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "create_snapshot",
            description: "Создать Btrfs снапшот субволюма с заданной меткой.",
            parameters: {
                type: "object",
                properties: {
                    subvol: { type: "string", description: "Имя субволюма" },
                    label: { type: "string", description: "Метка снапшота (краткое описание)" }
                },
                required: ["subvol", "label"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "delete_snapshot",
            description: "Удалить конкретный Btrfs снапшот.",
            parameters: {
                type: "object",
                properties: {
                    subvol: { type: "string", description: "Имя субволюма" },
                    snap_name: { type: "string", description: "Полное имя снапшота, например @2026-03-22_10-00-00_manual" }
                },
                required: ["subvol", "snap_name"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_users",
            description: "Список системных пользователей NAS (uid 1000–60000).",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    {
        type: "function",
        function: {
            name: "get_events",
            description: "Последние события Guard (антишифровальщик): обнаруженные угрозы, заблокированные процессы.",
            parameters: {
                type: "object",
                properties: {
                    limit: { type: "integer", description: "Количество событий (по умолчанию 20, макс 500)" }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "run_smart_test",
            description: "Запустить короткий S.M.A.R.T. тест диска (занимает ~2 мин).",
            parameters: {
                type: "object",
                properties: {
                    device: { type: "string", description: "Имя устройства без /dev/, например: sda, nvme0n1" }
                },
                required: ["device"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_smart",
            description: "Получить полный отчёт S.M.A.R.T. для диска (модель, здоровье, атрибуты).",
            parameters: {
                type: "object",
                properties: {
                    device: { type: "string", description: "Имя устройства без /dev/, например: sda" }
                },
                required: ["device"]
            }
        }
    }
];

// Convert OpenAI tools → Anthropic tools
function toAnthropicTools(tools) {
    return tools.map(function(t) {
        return {
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters
        };
    });
}

// ── Tool name → mcp-api.py command ────────────────────────────────────────────

function toolToCmd(name, input) {
    switch (name) {
        case "get_status":      return ["get-status"];
        case "list_shares":     return ["list-shares"];
        case "list_disks":      return ["list-disks"];
        case "list_raid":       return ["list-raid"];
        case "list_snapshots":  return ["list-snapshots", input.subvol || ""];
        case "create_snapshot": return ["create-snapshot", input.subvol || "", input.label || ""];
        case "delete_snapshot": return ["delete-snapshot", input.subvol || "", input.snap_name || ""];
        case "list_users":      return ["list-users"];
        case "get_events":      return ["get-events", String(input.limit || 20)];
        case "run_smart_test":  return ["run-smart-test", input.device || ""];
        case "get_smart":       return ["get-smart", input.device || ""];
        default: return null;
    }
}

// ── NAS command via cockpit.spawn ──────────────────────────────────────────────

function nasCmd(args) {
    return new Promise(function(resolve, reject) {
        var out = "";
        cockpit.spawn(["sudo", "-n", "python3", MCP_SCRIPT].concat(args), { err: "message" })
            .stream(function(data) { out += data; })
            .done(function() {
                try { resolve(JSON.parse(out)); }
                catch (e) { resolve({ ok: false, error: "JSON parse failed: " + out.substring(0, 200) }); }
            })
            .fail(function(ex) {
                reject({ ok: false, error: ex.message || String(ex) });
            });
    });
}

// ── State ──────────────────────────────────────────────────────────────────────

// Messages stored in OpenAI format (native for Yandex, converted for Anthropic)
var _messages  = [];
var _thinking  = false;
var _nasContext = "";

// ── Settings accessors ─────────────────────────────────────────────────────────

function getProvider()  { return localStorage.getItem(KEY_PROVIDER) || "yandex"; }
function getMaxTokens() { return parseInt(localStorage.getItem(KEY_MAXTOKENS) || "2048", 10); }

function getYandexCreds() {
    return {
        key:    localStorage.getItem(KEY_YA_KEY)    || YANDEX_DEFAULT_KEY,
        folder: localStorage.getItem(KEY_YA_FOLDER) || YANDEX_DEFAULT_FOLDER,
        model:  localStorage.getItem(KEY_YA_MODEL)  || YANDEX_DEFAULT_MODEL
    };
}

function getAnthropicCreds() {
    return {
        key:   localStorage.getItem(KEY_AN_KEY)   || "",
        model: localStorage.getItem(KEY_AN_MODEL) || ANTHROPIC_DEFAULT_MODEL
    };
}

// ── AI call via mcp-api.py proxy (bypasses CORS) ─────────────────────────────
// Flow: write JSON payload → /tmp/rusnas-ai-req.json via cockpit.file()
//       → spawn mcp-api.py ai-chat /tmp/rusnas-ai-req.json
// This avoids cockpit.spawn stdin issues and bypasses browser CORS restrictions.

var AI_TMP_FILE = "/tmp/rusnas-ai-req.json";

function callViaProxy(messages) {
    return new Promise(function(resolve, reject) {
        var provider = getProvider();
        var payload;

        if (provider === "yandex") {
            var creds = getYandexCreds();
            if (!creds.key) { reject(new Error("Yandex API ключ не задан — откройте Настройки.")); return; }
            payload = {
                provider:   "yandex",
                key:        creds.key,
                folder:     creds.folder,
                model:      creds.model,
                system:     buildSystemPrompt(),
                messages:   messages,
                tools:      TOOLS_OPENAI,
                max_tokens: getMaxTokens()
            };
        } else {
            var creds = getAnthropicCreds();
            if (!creds.key) { reject(new Error("Anthropic API ключ не задан — откройте Настройки.")); return; }
            payload = {
                provider:        "anthropic",
                key:             creds.key,
                model:           creds.model,
                system:          buildSystemPrompt(),
                messages:        convertToAnthropicMessages(messages),
                anthropic_tools: toAnthropicTools(TOOLS_OPENAI),
                max_tokens:      getMaxTokens()
            };
        }

        // Step 1: write payload to temp file (cockpit.file runs as rusnas user, /tmp is world-writable)
        cockpit.file(AI_TMP_FILE).replace(JSON.stringify(payload))
            .then(function() {
                // Step 2: spawn mcp-api.py with file path
                var out = "";
                cockpit.spawn(["sudo", "-n", "python3", MCP_SCRIPT, "ai-chat", AI_TMP_FILE],
                              { err: "message" })
                    .stream(function(data) { out += data; })
                    .done(function() {
                        // Clean up temp file (best-effort)
                        cockpit.file(AI_TMP_FILE).replace(null).catch(function(){});
                        try {
                            var raw = JSON.parse(out);
                            if (raw.ok === false) { reject(new Error(raw.error || "AI proxy error")); return; }
                            resolve(normalizeResponse(raw, provider));
                        } catch(e) {
                            reject(new Error("AI proxy JSON parse error: " + out.substring(0, 300)));
                        }
                    })
                    .fail(function(ex) {
                        reject(new Error("cockpit.spawn error: " + (ex.message || String(ex))));
                    });
            })
            .catch(function(ex) {
                reject(new Error("Failed to write AI request: " + (ex.message || ex)));
            });
    });
}

// Normalize provider response → internal format {stopReason, text, toolCalls, rawMessage}
function normalizeResponse(data, provider) {
    if (provider === "yandex") {
        var choice = data.choices && data.choices[0];
        if (!choice) throw new Error("Yandex: пустой ответ");
        var msg = choice.message;
        return {
            stopReason: choice.finish_reason,
            text:       msg.content || "",
            toolCalls:  msg.tool_calls || [],
            rawMessage: msg
        };
    } else {
        // Anthropic → convert to OpenAI-format internally
        var text = "", toolCalls = [];
        (data.content || []).forEach(function(block) {
            if (block.type === "text") {
                text += block.text;
            } else if (block.type === "tool_use") {
                toolCalls.push({
                    id: block.id, type: "function",
                    function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
                });
            }
        });
        var rawMessage = { role: "assistant", content: text };
        if (toolCalls.length) rawMessage.tool_calls = toolCalls;
        return {
            stopReason: data.stop_reason === "tool_use" ? "tool_calls" : "stop",
            text: text, toolCalls: toolCalls, rawMessage: rawMessage
        };
    }
}

// Convert OpenAI-format messages → Anthropic format
function convertToAnthropicMessages(messages) {
    var result = [];
    var i = 0;
    while (i < messages.length) {
        var msg = messages[i];
        if (msg.role === "user") {
            result.push({ role: "user", content: msg.content });
            i++;
        } else if (msg.role === "assistant") {
            if (msg.tool_calls && msg.tool_calls.length) {
                // Assistant tool_calls → Anthropic content blocks
                var blocks = [];
                if (msg.content) blocks.push({ type: "text", text: msg.content });
                msg.tool_calls.forEach(function(tc) {
                    var input = {};
                    try { input = JSON.parse(tc.function.arguments || "{}"); } catch(e) {}
                    blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: input });
                });
                result.push({ role: "assistant", content: blocks });
                // Collect following tool messages
                i++;
                var toolResults = [];
                while (i < messages.length && messages[i].role === "tool") {
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: messages[i].tool_call_id,
                        content: messages[i].content
                    });
                    i++;
                }
                if (toolResults.length) {
                    result.push({ role: "user", content: toolResults });
                }
            } else {
                result.push({ role: "assistant", content: msg.content || "" });
                i++;
            }
        } else {
            i++; // skip stray tool messages
        }
    }
    return result;
}

// ── Unified call ───────────────────────────────────────────────────────────────

async function callAI(messages) {
    return callViaProxy(messages);
}

// ── System prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt() {
    return "Ты AI-ассистент для управления NAS-сервером rusNAS на базе Debian Linux.\n" +
        "Отвечай ТОЛЬКО на русском языке. Будь кратким и конкретным.\n" +
        "Используй инструменты для получения актуальных данных о системе.\n" +
        "Форматируй ответы с переносами строк. Размеры отображай в МБ/ГБ.\n" +
        "При получении данных через инструменты — суммаризируй ключевые факты.\n" +
        (_nasContext ? "\nТекущий контекст системы (загружен при старте):\n" + _nasContext : "");
}

// ── Execute a tool call ────────────────────────────────────────────────────────

async function executeTool(toolCall) {
    var id   = toolCall.id;
    var name = toolCall.function.name;
    var input = {};
    try { input = JSON.parse(toolCall.function.arguments || "{}"); } catch(e) {}

    var elId = "tool-" + id;
    updateToolStatus(elId, "running");

    var resultStr;
    try {
        var args = toolToCmd(name, input);
        if (!args) throw new Error("Unknown tool: " + name);
        var result = await nasCmd(args);
        resultStr = JSON.stringify(result, null, 2);
        updateToolStatus(elId, "done", resultStr);
    } catch(ex) {
        resultStr = JSON.stringify({ ok: false, error: ex.message || String(ex) });
        updateToolStatus(elId, "error", resultStr);
    }

    // OpenAI tool result format
    return { role: "tool", tool_call_id: id, content: resultStr };
}

// ── Main send loop ─────────────────────────────────────────────────────────────

async function sendMessage(userText) {
    if (_thinking || !userText.trim()) return;

    _thinking = true;
    setSendDisabled(true);
    hideEmpty();

    _messages.push({ role: "user", content: userText });
    appendUserMsg(userText);

    var thinkingEl = appendThinking();

    try {
        while (true) {
            var resp = await callAI(_messages);

            if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
            thinkingEl = null;

            // Append assistant message to history (OpenAI format)
            _messages.push(resp.rawMessage);

            // Render assistant content
            if (resp.text) appendAssistantText(resp.text);
            if (resp.toolCalls.length) appendToolCallBlocks(resp.toolCalls);

            if (resp.stopReason !== "tool_calls" || !resp.toolCalls.length) break;

            // Execute tools in parallel
            var results = await Promise.all(resp.toolCalls.map(executeTool));
            results.forEach(function(r) { _messages.push(r); });

            thinkingEl = appendThinking();
        }
    } catch(ex) {
        if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
        showError(ex.message || String(ex));
    }

    _thinking = false;
    setSendDisabled(false);

    if (_messages.length > MAX_HISTORY) {
        _messages = _messages.slice(-MAX_HISTORY);
    }
    saveHistory();
}

// ── DOM helpers ────────────────────────────────────────────────────────────────

function hideEmpty() {
    var el = document.getElementById("ai-empty");
    if (el) el.style.display = "none";
}

function appendUserMsg(text) {
    var wrap = document.getElementById("ai-messages");
    var div = document.createElement("div");
    div.className = "ai-msg ai-msg-user";
    div.innerHTML = '<div class="ai-msg-label">Вы</div><div class="ai-bubble">' + esc(text) + '</div>';
    wrap.appendChild(div);
    scrollMessages();
}

function appendAssistantText(text) {
    if (!text) return;
    var wrap = document.getElementById("ai-messages");
    var div = document.createElement("div");
    div.className = "ai-msg ai-msg-assistant";
    div.innerHTML = '<div class="ai-msg-label">AI Ассистент</div><div class="ai-bubble">' + formatMarkdown(text) + '</div>';
    wrap.appendChild(div);
    scrollMessages();
}

function appendToolCallBlocks(toolCalls) {
    var wrap = document.getElementById("ai-messages");
    toolCalls.forEach(function(tc) {
        var input = {};
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch(e) {}
        var div = document.createElement("div");
        div.className = "ai-msg ai-msg-tool";
        div.innerHTML =
            '<div class="ai-msg-label">Инструмент</div>' +
            '<div class="ai-tool-block">' +
              '<div class="ai-tool-header" id="tool-' + esc(tc.id) + '-hdr">' +
                '<span class="ai-tool-icon">🔧</span>' +
                '<span class="ai-tool-name">' + esc(tc.function.name) + '</span>' +
                '<span class="ai-tool-status running" id="tool-' + esc(tc.id) + '-status">Выполняется</span>' +
              '</div>' +
              '<div class="ai-tool-body" id="tool-' + esc(tc.id) + '">' +
                'Аргументы: ' + esc(JSON.stringify(input)) +
              '</div>' +
            '</div>';
        wrap.appendChild(div);
        (function(id) {
            var hdr = document.getElementById("tool-" + id + "-hdr");
            if (hdr) hdr.addEventListener("click", function() {
                var body = document.getElementById("tool-" + id);
                if (body) {
                    body.classList.toggle("open");
                    hdr.classList.toggle("open");
                }
            });
        })(tc.id);
    });
    scrollMessages();
}

function updateToolStatus(elId, status, resultText) {
    var statusEl = document.getElementById(elId + "-status");
    var bodyEl   = document.getElementById(elId);
    if (statusEl) {
        statusEl.className = "ai-tool-status " + status;
        statusEl.textContent = status === "running" ? "Выполняется" : (status === "done" ? "Готово" : "Ошибка");
    }
    if (bodyEl && resultText) bodyEl.textContent = resultText;
    scrollMessages();
}

function appendThinking() {
    var wrap = document.getElementById("ai-messages");
    var div = document.createElement("div");
    div.className = "ai-thinking";
    div.innerHTML = '<span class="ai-dots"><span></span><span></span><span></span></span><span>Думаю...</span>';
    wrap.appendChild(div);
    scrollMessages();
    return div;
}

function scrollMessages() {
    var wrap = document.getElementById("ai-messages");
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function setSendDisabled(d) {
    var btn = document.getElementById("ai-send");
    if (btn) btn.disabled = d;
}

function showError(msg) {
    var banner = document.getElementById("ai-error-banner");
    var text   = document.getElementById("ai-error-text");
    if (banner && text) {
        text.textContent = msg;
        banner.classList.add("show");
    }
}

function formatMarkdown(text) {
    return esc(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
}

function esc(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ── Status bar ─────────────────────────────────────────────────────────────────

function setStatus(state, text) {
    var dot  = document.getElementById("ai-status-dot");
    var span = document.getElementById("ai-status-text");
    if (dot)  dot.className = "ai-status-dot " + state;
    if (span) span.textContent = text;
}

function updateModelBadge() {
    var badge = document.getElementById("ai-model-badge");
    if (!badge) return;
    var provider = getProvider();
    if (provider === "yandex") {
        var model = localStorage.getItem(KEY_YA_MODEL) || YANDEX_DEFAULT_MODEL;
        badge.textContent = "YandexGPT · " + model.replace("/latest", "");
    } else {
        var model = localStorage.getItem(KEY_AN_MODEL) || ANTHROPIC_DEFAULT_MODEL;
        badge.textContent = "Claude · " + model.replace("claude-", "").replace("-4-6", " 4.6");
    }
}

function updateStatusFromSettings() {
    var provider = getProvider();
    if (provider === "yandex") {
        var key = localStorage.getItem(KEY_YA_KEY) || YANDEX_DEFAULT_KEY;
        setStatus(key ? "ok" : "warn", key ? "Готов · Yandex GPT" : "Yandex API ключ не задан");
    } else {
        var key = localStorage.getItem(KEY_AN_KEY) || "";
        setStatus(key ? "ok" : "warn", key ? "Готов · Anthropic Claude" : "Anthropic API ключ не задан — Настройки");
    }
}

// ── Settings UI ────────────────────────────────────────────────────────────────

function loadSettingsToUI() {
    var provider = getProvider();
    var ya = getYandexCreds();
    var an = getAnthropicCreds();
    var maxTok = localStorage.getItem(KEY_MAXTOKENS) || "2048";

    var provSel = document.getElementById("ai-provider-select");
    if (provSel) provSel.value = provider;

    var yaKey    = document.getElementById("ai-ya-key");
    var yaFolder = document.getElementById("ai-ya-folder");
    var yaModel  = document.getElementById("ai-ya-model");
    if (yaKey)    yaKey.value    = ya.key;
    if (yaFolder) yaFolder.value = ya.folder;
    if (yaModel)  yaModel.value  = ya.model;

    var anKey   = document.getElementById("ai-an-key");
    var anModel = document.getElementById("ai-an-model");
    if (anKey)   anKey.value   = an.key;
    if (anModel) anModel.value = an.model;

    var maxTokSel = document.getElementById("ai-maxtokens-select");
    if (maxTokSel) maxTokSel.value = maxTok;

    var eyeToggle = document.getElementById("ai-eye-toggle");
    if (eyeToggle) eyeToggle.checked = localStorage.getItem("rusnas_eye_enabled") === "true";

    switchProviderFields(provider);
}

function switchProviderFields(provider) {
    var yandexFields    = document.getElementById("ai-yandex-fields");
    var anthropicFields = document.getElementById("ai-anthropic-fields");
    if (yandexFields)    yandexFields.style.display = provider === "yandex"    ? "" : "none";
    if (anthropicFields) anthropicFields.style.display = provider === "anthropic" ? "" : "none";
}

function saveSettings() {
    var provider = (document.getElementById("ai-provider-select") || {}).value || "yandex";
    localStorage.setItem(KEY_PROVIDER, provider);

    var yaKey    = (document.getElementById("ai-ya-key")    || {}).value || "";
    var yaFolder = (document.getElementById("ai-ya-folder") || {}).value || "";
    var yaModel  = (document.getElementById("ai-ya-model")  || {}).value || YANDEX_DEFAULT_MODEL;
    if (yaKey)    localStorage.setItem(KEY_YA_KEY, yaKey);
    if (yaFolder) localStorage.setItem(KEY_YA_FOLDER, yaFolder);
    if (yaModel)  localStorage.setItem(KEY_YA_MODEL, yaModel);

    var anKey   = (document.getElementById("ai-an-key")   || {}).value || "";
    var anModel = (document.getElementById("ai-an-model") || {}).value || ANTHROPIC_DEFAULT_MODEL;
    if (anKey)   localStorage.setItem(KEY_AN_KEY, anKey);
    if (anModel) localStorage.setItem(KEY_AN_MODEL, anModel);

    var maxTok = (document.getElementById("ai-maxtokens-select") || {}).value || "2048";
    localStorage.setItem(KEY_MAXTOKENS, maxTok);

    var eyeToggle = document.getElementById("ai-eye-toggle");
    if (eyeToggle) localStorage.setItem("rusnas_eye_enabled", eyeToggle.checked ? "true" : "false");

    updateModelBadge();
    updateStatusFromSettings();
}

async function testConnection() {
    saveSettings();
    var btn = document.getElementById("ai-settings-test");
    if (btn) { btn.disabled = true; btn.textContent = "Проверка..."; }
    setStatus("", "Проверка соединения...");
    try {
        await callViaProxy([{ role: "user", content: "Ответь одним словом: ОК" }]);
        setStatus("ok", "Соединение работает ✓");
    } catch(ex) {
        setStatus("err", "Ошибка: " + ex.message);
        showError(ex.message);
    }
    if (btn) { btn.disabled = false; btn.textContent = "Проверить соединение"; }
}

// ── History ────────────────────────────────────────────────────────────────────

function saveHistory() {
    try { localStorage.setItem(KEY_HISTORY, JSON.stringify(_messages)); } catch(e) {}
}

function loadHistory() {
    try {
        var raw = localStorage.getItem(KEY_HISTORY);
        if (raw) return JSON.parse(raw);
    } catch(e) {}
    return [];
}

function restoreHistoryToDOM() {
    if (!_messages.length) return;
    hideEmpty();
    _messages.forEach(function(msg) {
        if (msg.role === "user" && typeof msg.content === "string") {
            appendUserMsg(msg.content);
        } else if (msg.role === "assistant") {
            if (msg.content) appendAssistantText(msg.content);
            if (msg.tool_calls && msg.tool_calls.length) {
                appendToolCallBlocks(msg.tool_calls);
                // Mark as done (results already in history, just show status)
                msg.tool_calls.forEach(function(tc) {
                    updateToolStatus("tool-" + tc.id, "done");
                });
            }
        }
        // "tool" role messages are not rendered (they're shown inline in tool blocks)
    });
}

// ── Load initial NAS context ───────────────────────────────────────────────────

async function loadNasContext() {
    try {
        var status = await nasCmd(["get-status"]);
        var disks  = await nasCmd(["list-disks"]);
        _nasContext = "Хост: " + (status.hostname || "?") +
            ", Uptime: " + (status.uptime || "?") +
            ", RAM: " + ((status.memory || {}).used_mb || "?") + "/" + ((status.memory || {}).total_mb || "?") + " MB" +
            "\nНагрузка: " + JSON.stringify(status.load || {}) +
            "\nmdstat: " + String(disks.mdstat || "N/A").substring(0, 500);
    } catch(ex) {
        _nasContext = "";
    }
    updateStatusFromSettings();
}

// ── Init ───────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {
    // Pre-fill Yandex defaults if not yet stored
    if (!localStorage.getItem(KEY_YA_KEY))    localStorage.setItem(KEY_YA_KEY,    YANDEX_DEFAULT_KEY);
    if (!localStorage.getItem(KEY_YA_FOLDER)) localStorage.setItem(KEY_YA_FOLDER, YANDEX_DEFAULT_FOLDER);
    if (!localStorage.getItem(KEY_YA_MODEL))  localStorage.setItem(KEY_YA_MODEL,  YANDEX_DEFAULT_MODEL);
    if (!localStorage.getItem(KEY_PROVIDER))  localStorage.setItem(KEY_PROVIDER,  "yandex");

    _messages = loadHistory();
    restoreHistoryToDOM();

    loadSettingsToUI();
    updateModelBadge();
    updateStatusFromSettings();

    loadNasContext();

    // Send
    document.getElementById("ai-send").addEventListener("click", function() {
        var inp = document.getElementById("ai-input");
        var text = inp.value.trim();
        if (!text) return;
        inp.value = "";
        inp.style.height = "auto";
        sendMessage(text);
    });

    // Enter = send, Shift+Enter = newline
    document.getElementById("ai-input").addEventListener("keydown", function(e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            document.getElementById("ai-send").click();
        }
    });

    // Auto-resize textarea
    document.getElementById("ai-input").addEventListener("input", function() {
        this.style.height = "auto";
        this.style.height = Math.min(this.scrollHeight, 140) + "px";
    });

    // Clear history
    document.getElementById("ai-clear").addEventListener("click", function() {
        if (!confirm("Очистить историю чата?")) return;
        _messages = [];
        localStorage.removeItem(KEY_HISTORY);
        var wrap = document.getElementById("ai-messages");
        wrap.innerHTML = "";
        var empty = document.createElement("div");
        empty.id = "ai-empty"; empty.className = "ai-empty";
        empty.innerHTML = buildEmptyHTML();
        wrap.appendChild(empty);
        bindChips();
    });

    // Settings toggle
    document.getElementById("ai-settings-toggle").addEventListener("click", function() {
        this.classList.toggle("open");
        document.getElementById("ai-settings-panel").classList.toggle("open");
    });

    // Provider switch
    document.getElementById("ai-provider-select").addEventListener("change", function() {
        switchProviderFields(this.value);
    });

    // Settings save
    document.getElementById("ai-settings-save").addEventListener("click", function() {
        saveSettings();
        document.getElementById("ai-settings-panel").classList.remove("open");
        document.getElementById("ai-settings-toggle").classList.remove("open");
    });

    // Settings test
    document.getElementById("ai-settings-test").addEventListener("click", testConnection);

    bindChips();
});

function buildEmptyHTML() {
    return '<div class="ai-empty-icon">🤖</div>' +
        '<div class="ai-empty-title">Привет! Я AI-ассистент rusNAS</div>' +
        '<div class="ai-empty-hint">Задайте вопрос или выберите команду ниже.</div>' +
        '<div class="ai-suggestion-chips">' +
        '<div class="ai-chip" id="chip-status">📊 Состояние системы</div>' +
        '<div class="ai-chip" id="chip-disks">💿 Диски и RAID</div>' +
        '<div class="ai-chip" id="chip-shares">📂 Список шар</div>' +
        '<div class="ai-chip" id="chip-snap">📸 Снапшоты documents</div>' +
        '<div class="ai-chip" id="chip-users">👥 Пользователи</div>' +
        '<div class="ai-chip" id="chip-events">🛡️ События Guard</div>' +
        '</div>';
}

function bindChips() {
    var chips = {
        "chip-status": "Покажи текущее состояние системы: uptime, нагрузку, использование памяти и дисков",
        "chip-disks":  "Покажи список дисков и состояние RAID-массивов",
        "chip-shares": "Покажи список SMB и NFS шар",
        "chip-snap":   "Покажи список снапшотов субволюма documents",
        "chip-users":  "Покажи список пользователей NAS",
        "chip-events": "Покажи последние 20 событий Guard (антишифровальщик)"
    };
    Object.keys(chips).forEach(function(id) {
        var el = document.getElementById(id);
        if (el) {
            // Clone to remove old listeners
            var newEl = el.cloneNode(true);
            el.parentNode.replaceChild(newEl, el);
            newEl.addEventListener("click", function() {
                var inp = document.getElementById("ai-input");
                if (inp) { inp.value = chips[id]; document.getElementById("ai-send").click(); }
            });
        }
    });
}
