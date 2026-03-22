// rusNAS AI Assistant
// ai.js — Claude API + tool calling + NAS dispatch via mcp-api.py

"use strict";

var MCP_SCRIPT = "/usr/share/cockpit/rusnas/scripts/mcp-api.py";
var ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
var HISTORY_KEY   = "rusnas_ai_history";
var KEY_KEY       = "rusnas_claude_key";
var MODEL_KEY     = "rusnas_ai_model";
var MAXTOK_KEY    = "rusnas_ai_maxtokens";
var MAX_HISTORY   = 50; // messages to keep

// ── Tool schema sent to Claude ─────────────────────────────────────────────────

var TOOLS_SCHEMA = [
    {
        name: "get_status",
        description: "Получить системную информацию NAS: uptime, загрузка CPU, память, использование дисков (df).",
        input_schema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "list_shares",
        description: "Список SMB (Samba) и NFS шар на NAS.",
        input_schema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "list_disks",
        description: "Список физических дисков (lsblk) и состояние RAID (/proc/mdstat).",
        input_schema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "list_raid",
        description: "Детальная информация о RAID-массивах (mdadm --detail).",
        input_schema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "list_snapshots",
        description: "Список Btrfs снапшотов для указанного субволюма.",
        input_schema: {
            type: "object",
            properties: {
                subvol: { type: "string", description: "Имя субволюма, например: documents, homes" }
            },
            required: ["subvol"]
        }
    },
    {
        name: "create_snapshot",
        description: "Создать Btrfs снапшот субволюма с заданной меткой.",
        input_schema: {
            type: "object",
            properties: {
                subvol: { type: "string", description: "Имя субволюма" },
                label: { type: "string", description: "Метка снапшота (краткое описание)" }
            },
            required: ["subvol", "label"]
        }
    },
    {
        name: "delete_snapshot",
        description: "Удалить конкретный Btrfs снапшот.",
        input_schema: {
            type: "object",
            properties: {
                subvol: { type: "string", description: "Имя субволюма" },
                snap_name: { type: "string", description: "Полное имя снапшота (например @2026-03-22_10-00-00_manual)" }
            },
            required: ["subvol", "snap_name"]
        }
    },
    {
        name: "list_users",
        description: "Список системных пользователей NAS (uid 1000–60000).",
        input_schema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "get_events",
        description: "Последние события Guard (антишифровальщик): обнаруженные угрозы, заблокированные процессы.",
        input_schema: {
            type: "object",
            properties: {
                limit: { type: "integer", description: "Количество событий (по умолчанию 20, макс 500)" }
            },
            required: []
        }
    },
    {
        name: "run_smart_test",
        description: "Запустить короткий S.M.A.R.T. тест диска (занимает ~2 мин).",
        input_schema: {
            type: "object",
            properties: {
                device: { type: "string", description: "Имя устройства без /dev/, например: sda, sdb, nvme0n1" }
            },
            required: ["device"]
        }
    },
    {
        name: "get_smart",
        description: "Получить полный отчёт S.M.A.R.T. для диска (модель, здоровье, атрибуты).",
        input_schema: {
            type: "object",
            properties: {
                device: { type: "string", description: "Имя устройства без /dev/, например: sda" }
            },
            required: ["device"]
        }
    }
];

// ── Tool name → mcp-api.py command mapping ─────────────────────────────────────

function toolToCmd(toolName, input) {
    switch (toolName) {
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

var _messages  = [];   // conversation history (Claude format)
var _thinking  = false;
var _nasContext = "";

// ── Claude API call ────────────────────────────────────────────────────────────

async function callClaude(messages) {
    var key   = localStorage.getItem(KEY_KEY) || "";
    var model = localStorage.getItem(MODEL_KEY) || "claude-sonnet-4-6";
    var maxTok = parseInt(localStorage.getItem(MAXTOK_KEY) || "2048", 10);

    if (!key) throw new Error("API ключ не задан. Откройте Настройки и введите Anthropic API Key.");

    var systemPrompt = "Ты AI-ассистент для управления NAS-сервером rusNAS на базе Debian Linux.\n" +
        "Отвечай ТОЛЬКО на русском языке. Будь кратким и по делу.\n" +
        "Используй инструменты для получения актуальных данных о системе.\n" +
        "Форматируй ответы с переносами строк для читаемости. Размеры отображай в МБ/ГБ.\n" +
        (_nasContext ? "\nТекущий контекст системы (загружен при старте):\n" + _nasContext : "");

    var resp = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        },
        body: JSON.stringify({
            model: model,
            max_tokens: maxTok,
            system: systemPrompt,
            tools: TOOLS_SCHEMA,
            messages: messages
        })
    });

    if (!resp.ok) {
        var errBody = await resp.text();
        var errMsg = "API ошибка " + resp.status;
        try {
            var errJson = JSON.parse(errBody);
            errMsg += ": " + (errJson.error && errJson.error.message || errBody.substring(0, 200));
        } catch (e) {
            errMsg += ": " + errBody.substring(0, 200);
        }
        throw new Error(errMsg);
    }

    return resp.json();
}

// ── Execute a single tool call ─────────────────────────────────────────────────

async function executeTool(toolBlock) {
    var toolId   = toolBlock.id;
    var toolName = toolBlock.name;
    var input    = toolBlock.input || {};

    var elId = "tool-" + toolId;
    // update status to running
    updateToolStatus(elId, "running");

    var resultContent;
    try {
        var args = toolToCmd(toolName, input);
        if (!args) throw new Error("Unknown tool: " + toolName);
        var result = await nasCmd(args);
        var resultStr = JSON.stringify(result, null, 2);
        updateToolStatus(elId, "done", resultStr);
        resultContent = resultStr;
    } catch (ex) {
        var errStr = JSON.stringify({ ok: false, error: ex.message || String(ex) });
        updateToolStatus(elId, "error", errStr);
        resultContent = errStr;
    }

    return {
        type: "tool_result",
        tool_use_id: toolId,
        content: resultContent
    };
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
            var resp = await callClaude(_messages);

            // Remove thinking indicator before rendering response
            if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
            thinkingEl = null;

            // Build assistant message from content blocks
            _messages.push({ role: "assistant", content: resp.content });
            appendAssistantContent(resp.content);

            if (resp.stop_reason !== "tool_use") break;

            // Execute all tool calls in parallel
            var toolBlocks = resp.content.filter(function(b) { return b.type === "tool_use"; });
            var results = await Promise.all(toolBlocks.map(executeTool));

            // Add tool results as user turn
            _messages.push({ role: "user", content: results });
            thinkingEl = appendThinking();
        }
    } catch (ex) {
        if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
        showError(ex.message || String(ex));
    }

    _thinking = false;
    setSendDisabled(false);

    // Trim and save history
    if (_messages.length > MAX_HISTORY * 2) {
        _messages = _messages.slice(-MAX_HISTORY * 2);
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

function appendAssistantContent(contentBlocks) {
    var wrap = document.getElementById("ai-messages");
    contentBlocks.forEach(function(block) {
        if (block.type === "text" && block.text) {
            var div = document.createElement("div");
            div.className = "ai-msg ai-msg-assistant";
            div.innerHTML = '<div class="ai-msg-label">AI Ассистент</div><div class="ai-bubble">' + formatMarkdown(block.text) + '</div>';
            wrap.appendChild(div);
        } else if (block.type === "tool_use") {
            var tDiv = document.createElement("div");
            tDiv.className = "ai-msg ai-msg-tool";
            tDiv.innerHTML =
                '<div class="ai-msg-label">Инструмент</div>' +
                '<div class="ai-tool-block">' +
                  '<div class="ai-tool-header" id="tool-' + esc(block.id) + '-hdr">' +
                    '<span class="ai-tool-icon">🔧</span>' +
                    '<span class="ai-tool-name">' + esc(block.name) + '</span>' +
                    '<span class="ai-tool-status running" id="tool-' + esc(block.id) + '-status">Выполняется</span>' +
                  '</div>' +
                  '<div class="ai-tool-body" id="tool-' + esc(block.id) + '">' +
                    'Аргументы: ' + esc(JSON.stringify(block.input)) +
                  '</div>' +
                '</div>';
            wrap.appendChild(tDiv);
            // toggle collapse on header click
            (function(id) {
                var hdr = document.getElementById("tool-" + id + "-hdr");
                if (hdr) hdr.addEventListener("click", function() {
                    var body = document.getElementById("tool-" + id);
                    if (body) {
                        body.classList.toggle("open");
                        hdr.classList.toggle("open");
                    }
                });
            })(block.id);
        }
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
    if (bodyEl && resultText) {
        bodyEl.textContent = resultText;
    }
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

function setSendDisabled(disabled) {
    var btn = document.getElementById("ai-send");
    if (btn) btn.disabled = disabled;
}

function showError(msg) {
    var banner = document.getElementById("ai-error-banner");
    var text   = document.getElementById("ai-error-text");
    if (banner && text) {
        text.textContent = msg;
        banner.classList.add("show");
    }
}

// Basic markdown-to-HTML: bold, code, newlines
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

// ── Status bar ────────────────────────────────────────────────────────────────

function setStatus(state, text) {
    var dot  = document.getElementById("ai-status-dot");
    var span = document.getElementById("ai-status-text");
    if (dot)  { dot.className = "ai-status-dot " + state; }
    if (span) { span.textContent = text; }
}

function updateModelBadge() {
    var badge = document.getElementById("ai-model-badge");
    var model = localStorage.getItem(MODEL_KEY) || "claude-sonnet-4-6";
    // Shorten for display
    var short = model.replace("claude-", "").replace("-20251001", "").replace("-4-6", " 4.6").replace("-4-5", " 4.5");
    if (badge) badge.textContent = short;
}

// ── History persist ────────────────────────────────────────────────────────────

function saveHistory() {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(_messages));
    } catch (e) {}
}

function loadHistory() {
    try {
        var raw = localStorage.getItem(HISTORY_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [];
}

function restoreHistoryToDOM() {
    if (!_messages.length) return;
    hideEmpty();
    _messages.forEach(function(msg) {
        if (msg.role === "user") {
            if (Array.isArray(msg.content)) {
                // tool_result blocks — skip visual restore (already shown via tool blocks)
            } else {
                appendUserMsg(msg.content);
            }
        } else if (msg.role === "assistant") {
            var blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
            appendAssistantContent(blocks);
            // Mark tool statuses as done (we don't have results anymore for restored session)
            blocks.forEach(function(b) {
                if (b.type === "tool_use") {
                    updateToolStatus("tool-" + b.id, "done");
                }
            });
        }
    });
}

// ── Settings ───────────────────────────────────────────────────────────────────

function loadSettings() {
    var keyInput   = document.getElementById("ai-key-input");
    var modelSel   = document.getElementById("ai-model-select");
    var maxTokSel  = document.getElementById("ai-maxtokens-select");

    if (keyInput && localStorage.getItem(KEY_KEY))
        keyInput.value = localStorage.getItem(KEY_KEY);
    if (modelSel && localStorage.getItem(MODEL_KEY))
        modelSel.value = localStorage.getItem(MODEL_KEY);
    if (maxTokSel && localStorage.getItem(MAXTOK_KEY))
        maxTokSel.value = localStorage.getItem(MAXTOK_KEY);
}

function saveSettings() {
    var key    = (document.getElementById("ai-key-input")      || {}).value || "";
    var model  = (document.getElementById("ai-model-select")   || {}).value || "claude-sonnet-4-6";
    var maxTok = (document.getElementById("ai-maxtokens-select") || {}).value || "2048";

    if (key)    localStorage.setItem(KEY_KEY, key);
    if (model)  localStorage.setItem(MODEL_KEY, model);
    if (maxTok) localStorage.setItem(MAXTOK_KEY, maxTok);
    updateModelBadge();
    updateStatusFromKey();
}

function updateStatusFromKey() {
    var key = localStorage.getItem(KEY_KEY) || "";
    if (!key) {
        setStatus("warn", "API ключ не задан — откройте Настройки");
    } else {
        setStatus("ok", "Готов к работе");
    }
}

async function testConnection() {
    var btn = document.getElementById("ai-settings-test");
    if (btn) { btn.disabled = true; btn.textContent = "Проверка..."; }
    setStatus("", "Проверка соединения...");
    try {
        var resp = await callClaude([{ role: "user", content: "Reply with just: OK" }]);
        setStatus("ok", "Соединение работает ✓");
    } catch (ex) {
        setStatus("err", "Ошибка: " + ex.message);
        showError(ex.message);
    }
    if (btn) { btn.disabled = false; btn.textContent = "Проверить соединение"; }
}

// ── Load initial NAS context ───────────────────────────────────────────────────

async function loadNasContext() {
    try {
        var status = await nasCmd(["get-status"]);
        var disks  = await nasCmd(["list-disks"]);
        _nasContext = "Хост: " + (status.hostname || "?") +
            ", Uptime: " + (status.uptime || "?") +
            ", RAM: " + ((status.memory || {}).used_mb || "?") + "/" + ((status.memory || {}).total_mb || "?") + " MB" +
            "\nNagрузка: " + JSON.stringify((status.load || {})) +
            "\nmdstat: " + (disks.mdstat || "N/A").substring(0, 500);
        setStatus("ok", "Контекст загружен · " + (status.hostname || "NAS"));
    } catch (ex) {
        _nasContext = "";
        setStatus("warn", "Контекст не загружен (NAS недоступен)");
    }
    updateStatusFromKey();
}

// ── Init ───────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {
    // Restore history
    _messages = loadHistory();
    restoreHistoryToDOM();

    // Load settings
    loadSettings();
    updateModelBadge();
    updateStatusFromKey();

    // Load NAS context
    loadNasContext();

    // Send button
    document.getElementById("ai-send").addEventListener("click", function() {
        var inp = document.getElementById("ai-input");
        var text = inp.value.trim();
        if (!text) return;
        inp.value = "";
        inp.style.height = "auto";
        sendMessage(text);
    });

    // Enter to send (Shift+Enter = newline)
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

    // Clear button
    document.getElementById("ai-clear").addEventListener("click", function() {
        if (!confirm("Очистить историю чата?")) return;
        _messages = [];
        localStorage.removeItem(HISTORY_KEY);
        var wrap = document.getElementById("ai-messages");
        wrap.innerHTML = "";
        // Re-add empty state
        var empty = document.createElement("div");
        empty.id = "ai-empty";
        empty.className = "ai-empty";
        empty.innerHTML =
            '<div class="ai-empty-icon">🤖</div>' +
            '<div class="ai-empty-title">Привет! Я AI-ассистент rusNAS</div>' +
            '<div class="ai-empty-hint">Задайте вопрос на русском языке или выберите команду ниже.</div>' +
            '<div class="ai-suggestion-chips">' +
            '<div class="ai-chip" id="chip-status">📊 Состояние системы</div>' +
            '<div class="ai-chip" id="chip-disks">💿 Покажи диски и RAID</div>' +
            '<div class="ai-chip" id="chip-shares">📂 Список шар</div>' +
            '<div class="ai-chip" id="chip-snap">📸 Снапшоты documents</div>' +
            '<div class="ai-chip" id="chip-users">👥 Список пользователей</div>' +
            '<div class="ai-chip" id="chip-events">🛡️ Последние события Guard</div>' +
            '</div>';
        wrap.appendChild(empty);
        bindChips();
    });

    // Settings toggle
    document.getElementById("ai-settings-toggle").addEventListener("click", function() {
        this.classList.toggle("open");
        document.getElementById("ai-settings-panel").classList.toggle("open");
    });

    // Settings save
    document.getElementById("ai-settings-save").addEventListener("click", function() {
        saveSettings();
        document.getElementById("ai-settings-panel").classList.remove("open");
        document.getElementById("ai-settings-toggle").classList.remove("open");
    });

    // Settings test
    document.getElementById("ai-settings-test").addEventListener("click", function() {
        saveSettings();
        testConnection();
    });

    // Suggestion chips
    bindChips();
});

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
            el.addEventListener("click", function() {
                var inp = document.getElementById("ai-input");
                if (inp) {
                    inp.value = chips[id];
                    document.getElementById("ai-send").click();
                }
            });
        }
    });
}
