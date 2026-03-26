// rusNAS openEYE Agent
// Automatically analyzes any page and shows AI findings in a compact floating widget.
// Included in every page. Activates only when localStorage key is set.

(function () {
"use strict";

var EYE_ENABLED_KEY = "rusnas_eye_enabled";
var EYE_TMP_FILE    = "/tmp/rusnas-eye-req.json";
var MCP_SCRIPT      = "/usr/share/cockpit/rusnas/scripts/mcp-api.py";
var ANALYZE_DELAY   = 3500; // ms after DOMContentLoaded — wait for dynamic data

// Page name map (title → human label)
var PAGE_LABELS = {
    "dashboard":        "Dashboard",
    "index":            "Хранилище",
    "disks":            "Диски и RAID",
    "users":            "Пользователи",
    "guard":            "Guard 🛡️",
    "snapshots":        "Снапшоты",
    "dedup":            "Дедупликация",
    "ups":              "ИБП / UPS",
    "storage-analyzer": "Анализ пространства",
    "network":          "Сеть",
    "ai":               "AI Ассистент"
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function isEnabled() {
    return localStorage.getItem(EYE_ENABLED_KEY) === "true";
}

function getPageName() {
    var path = window.location.pathname;
    var match = path.match(/\/([^\/]+)\.html/);
    var key   = match ? match[1] : "unknown";
    return PAGE_LABELS[key] || key;
}

function getProviderCreds() {
    var provider = localStorage.getItem("rusnas_ai_provider") || "yandex";
    if (provider === "yandex") {
        return {
            provider: "yandex",
            key:      localStorage.getItem("rusnas_yandex_key")    || "",
            folder:   localStorage.getItem("rusnas_yandex_folder") || "b1g2ikacmpc41ubdbitv",
            model:    localStorage.getItem("rusnas_yandex_model")  || "yandexgpt-5-pro/latest"
        };
    } else {
        return {
            provider: "anthropic",
            key:      localStorage.getItem("rusnas_claude_key")  || "",
            model:    localStorage.getItem("rusnas_ai_model")    || "claude-sonnet-4-6"
        };
    }
}

// ── Text extraction ───────────────────────────────────────────────────────────

function extractPageText() {
    // Prefer .page-wrap (rusNAS standard content container)
    var root = document.querySelector(".page-wrap") || document.body;
    var raw  = (root.innerText || root.textContent || "")
                   .replace(/[ \t]+/g, " ")
                   .replace(/\n{3,}/g, "\n\n")
                   .trim();
    // Truncate — AI context window
    return raw.substring(0, 5000);
}

// ── AI call via mcp-api.py proxy ──────────────────────────────────────────────

function callAI(pageText, pageName, callback) {
    var creds = getProviderCreds();
    if (!creds.key) {
        callback(null, "API ключ не задан (Настройки AI)");
        return;
    }

    var prompt = "Ты аналитик состояния NAS-сервера rusNAS.\n" +
        "Проанализируй содержимое страницы «" + pageName + "» и выдели важные моменты для администратора.\n\n" +
        "ДАННЫЕ СТРАНИЦЫ:\n" + pageText + "\n\n" +
        "Ответь СТРОГО только JSON без пояснений:\n" +
        "{\"findings\":[{\"level\":\"critical|warning|info|ok\",\"text\":\"описание\"}]}\n\n" +
        "Уровни: critical — требует немедленного действия, warning — стоит проверить, " +
        "info — полезная информация, ok — всё в порядке.\n" +
        "Максимум 6 findings. Если данных мало — верни [{\"level\":\"info\",\"text\":\"Данных для анализа недостаточно\"}].";

    var payload = {
        provider:   creds.provider,
        key:        creds.key,
        folder:     creds.folder || "",
        model:      creds.model,
        system:     "Ты аналитик состояния NAS-сервера. Отвечай ТОЛЬКО JSON без markdown-блоков и пояснений.",
        messages:   [{ role: "user", content: prompt }],
        tools:      [],
        max_tokens: 1024
    };

    // Write payload to temp file, then spawn mcp-api.py
    cockpit.file(EYE_TMP_FILE).replace(JSON.stringify(payload))
        .then(function () {
            var out = "";
            cockpit.spawn(["sudo", "-n", "python3", MCP_SCRIPT, "ai-chat", EYE_TMP_FILE],
                          { err: "message" })
                .stream(function (data) { out += data; })
                .done(function () {
                    cockpit.file(EYE_TMP_FILE).replace(null).catch(function () {});
                    try {
                        var raw = JSON.parse(out);
                        if (raw.ok === false) { callback(null, raw.error || "AI error"); return; }
                        // raw is the provider response
                        var text = "";
                        if (raw.choices && raw.choices[0]) {
                            text = raw.choices[0].message.content || "";
                        } else if (raw.content) {
                            // Anthropic format
                            (raw.content || []).forEach(function (b) {
                                if (b.type === "text") text += b.text;
                            });
                        }
                        callback(parseFindings(text), null);
                    } catch (e) {
                        callback(null, "Parse error: " + out.substring(0, 200));
                    }
                })
                .fail(function (ex) {
                    callback(null, ex.message || String(ex));
                });
        })
        .catch(function (ex) {
            callback(null, "File write error: " + (ex.message || ex));
        });
}

// ── Parse AI findings ─────────────────────────────────────────────────────────

function parseFindings(text) {
    // Strip possible markdown code fences
    var clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    // Try extracting JSON object with "findings" key
    var matchObj = clean.match(/\{[\s\S]*"findings"[\s\S]*\}/);
    if (matchObj) {
        try {
            var data = JSON.parse(matchObj[0]);
            if (Array.isArray(data.findings) && data.findings.length) {
                return data.findings;
            }
        } catch (e) {}
    }

    // Try extracting a bare JSON array (some providers return [...] directly)
    var matchArr = clean.match(/\[[\s\S]*\]/);
    if (matchArr) {
        try {
            var arr = JSON.parse(matchArr[0]);
            if (Array.isArray(arr) && arr.length && arr[0].level) {
                return arr;
            }
        } catch (e) {}
    }

    // Fallback: show raw text
    return [{ level: "info", text: clean.substring(0, 500) }];
}

// ── DOM building ──────────────────────────────────────────────────────────────

var _panelOpen    = false;
var _userDismissed = false; // true after user manually closes — suppresses auto-open

var EYE_OPEN_KEY = "openeye-open"; // localStorage key for panel open state

function buildPanel() {
    if (document.getElementById("eye-panel")) return; // already exists

    // FAB
    var fab = document.createElement("button");
    fab.id = "eye-fab";
    fab.title = "openEYE — AI анализ страницы";
    fab.textContent = "👁";
    fab.addEventListener("click", function () {
        if (_panelOpen) {
            localStorage.setItem(EYE_OPEN_KEY, "false");
            _userDismissed = true;
            closePanel();
        } else {
            localStorage.setItem(EYE_OPEN_KEY, "true");
            _userDismissed = false;
            openPanel();
        }
    });
    document.body.appendChild(fab);

    // Compact floating widget
    var panel = document.createElement("div");
    panel.id = "eye-panel";
    panel.innerHTML =
        '<div id="eye-panel-header">' +
          '<span style="font-size:13px">👁</span>' +
          '<div id="eye-panel-title">openEYE</div>' +
          '<div id="eye-panel-page"></div>' +
          '<button id="eye-close-btn" title="Закрыть">✕</button>' +
        '</div>' +
        '<div id="eye-status-bar">' +
          '<div id="eye-status-dot"></div>' +
          '<span id="eye-status-text">Ожидание...</span>' +
        '</div>' +
        '<div id="eye-panel-body"><div class="eye-loading">' +
          '<div class="eye-loading-dots"><span></span><span></span><span></span></div>' +
          '<div>Загрузка...</div>' +
        '</div></div>' +
        '<div id="eye-panel-footer">' +
          '<button id="eye-rerun-btn">↺ Переанализировать</button>' +
        '</div>';
    document.body.appendChild(panel);

    document.getElementById("eye-close-btn").addEventListener("click", function () {
        localStorage.setItem(EYE_OPEN_KEY, "false");
        _userDismissed = true;
        closePanel();
    });
    document.getElementById("eye-rerun-btn").addEventListener("click", function () {
        _userDismissed = false;
        runAnalysis();
    });
}

function openPanel() {
    var panel = document.getElementById("eye-panel");
    if (!panel) return;
    panel.classList.add("open");
    _panelOpen = true;
}

function closePanel() {
    var panel = document.getElementById("eye-panel");
    if (!panel) return;
    panel.classList.remove("open");
    _panelOpen = false;
}

// ── Render findings ───────────────────────────────────────────────────────────

var LEVEL_ICONS = { critical: "🔴", warning: "🟡", info: "🔵", ok: "🟢" };
var LEVEL_NAMES = { critical: "Критично", warning: "Предупреждения", info: "Информация", ok: "Норма" };

function setStatus(state, text) {
    var dot  = document.getElementById("eye-status-dot");
    var span = document.getElementById("eye-status-text");
    if (dot)  dot.className = state;
    if (span) span.textContent = text;
}

function setLoading() {
    setStatus("analyzing", "Анализирую...");
    var fab = document.getElementById("eye-fab");
    if (fab) fab.classList.add("analyzing");
    var body = document.getElementById("eye-panel-body");
    if (body) body.innerHTML =
        '<div class="eye-loading">' +
        '<div class="eye-loading-dots"><span></span><span></span><span></span></div>' +
        '<div>AI анализирует страницу...</div>' +
        '</div>';
    var btn = document.getElementById("eye-rerun-btn");
    if (btn) btn.disabled = true;
}

function renderFindings(findings) {
    setStatus("done", "Анализ завершён");
    var fab = document.getElementById("eye-fab");
    if (fab) fab.classList.remove("analyzing");
    var btn = document.getElementById("eye-rerun-btn");
    if (btn) btn.disabled = false;

    var body = document.getElementById("eye-panel-body");
    if (!body) return;

    // Group by level
    var groups = { critical: [], warning: [], info: [], ok: [] };
    findings.forEach(function (f) {
        var lvl = (f.level || "info").toLowerCase();
        if (!groups[lvl]) lvl = "info";
        groups[lvl].push(f.text || "");
    });

    var html = "";
    ["critical", "warning", "info", "ok"].forEach(function (lvl) {
        if (!groups[lvl].length) return;
        html += '<div class="eye-section">';
        html += '<div class="eye-section-label">' + LEVEL_NAMES[lvl] + '</div>';
        groups[lvl].forEach(function (text) {
            html +=
                '<div class="eye-finding ' + lvl + '">' +
                  '<span class="eye-finding-icon">' + (LEVEL_ICONS[lvl] || "•") + '</span>' +
                  '<span class="eye-finding-text">' + escHtml(text) + '</span>' +
                '</div>';
        });
        html += '</div>';
    });

    if (!html) {
        html = '<div class="eye-empty">Ничего важного не обнаружено.</div>';
    }
    body.innerHTML = html;
}

function renderError(msg) {
    setStatus("error", "Ошибка");
    var fab = document.getElementById("eye-fab");
    if (fab) fab.classList.remove("analyzing");
    var btn = document.getElementById("eye-rerun-btn");
    if (btn) btn.disabled = false;
    var body = document.getElementById("eye-panel-body");
    if (body) body.innerHTML =
        '<div class="eye-finding warning" style="margin:12px">' +
        '<span class="eye-finding-icon">⚠️</span>' +
        '<span class="eye-finding-text">' + escHtml(msg) + '</span>' +
        '</div>';
}

function escHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Main analysis ─────────────────────────────────────────────────────────────

function runAnalysis() {
    var pageName = getPageName();
    var pageEl   = document.getElementById("eye-panel-page");
    if (pageEl) pageEl.textContent = pageName;

    setLoading();
    // Only auto-open if user explicitly opened the panel (localStorage persists state)
    if (localStorage.getItem(EYE_OPEN_KEY) === "true") openPanel();

    var text = extractPageText();
    callAI(text, pageName, function (findings, error) {
        if (error) {
            renderError(error);
        } else {
            renderFindings(findings);
        }
    });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function () {
    if (!isEnabled()) return;

    // Wait for cockpit to be available
    if (typeof cockpit === "undefined") {
        // cockpit.js not loaded yet — retry after short delay
        setTimeout(function () {
            if (typeof cockpit === "undefined") return;
            buildPanel();
            setTimeout(runAnalysis, ANALYZE_DELAY);
        }, 500);
        return;
    }

    buildPanel();
    // Delay to let page JS finish loading dynamic data
    setTimeout(runAnalysis, ANALYZE_DELAY);
});

}()); // end IIFE
