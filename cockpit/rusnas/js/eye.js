// rusNAS openEYE Agent
// Automatically analyzes any page and shows AI findings in a compact floating widget.
// Included in every page. Activates only when localStorage key is set.

/* ── Global: ESC closes any visible modal ─────────────────────────────────── */
document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var modals = document.querySelectorAll(".modal-overlay");
    for (var i = modals.length - 1; i >= 0; i--) {
        var m = modals[i];
        /* skip already hidden modals */
        if (m.classList.contains("hidden") || m.style.display === "none" ||
            window.getComputedStyle(m).display === "none") continue;
        /* close: use the same mechanism that opened it */
        if (m.style.display !== "") {
            m.style.display = "none";
        } else {
            m.classList.add("hidden");
        }
        e.preventDefault();
        return; /* close only the topmost modal */
    }
});

/* ── Nav Groups: Tatlin-style collapsible sidebar sections ────────────────── */
/* Runs from plugin iframe, operates on parent shell document (same-origin)  */
(function () {
    "use strict";
    var STORAGE_KEY = "rusnas_nav_collapsed";
    var GROUPS = [
        { id: "storage",  label: "\u0425\u0440\u0430\u043d\u0438\u043b\u0438\u0449\u0435",      hrefs: ["/rusnas","/rusnas/disks","/rusnas/containers"] },
        { id: "protect",  label: "\u0417\u0430\u0449\u0438\u0442\u0430 \u0434\u0430\u043d\u043d\u044b\u0445",   hrefs: ["/rusnas/guard","/rusnas/snapshots","/rusnas/dedup"] },
        { id: "infra",    label: "\u0418\u043d\u0444\u0440\u0430\u0441\u0442\u0440\u0443\u043a\u0442\u0443\u0440\u0430",  hrefs: ["/rusnas/network","/rusnas/ups","/rusnas/users"] },
        { id: "monitor",  label: "\u041c\u043e\u043d\u0438\u0442\u043e\u0440\u0438\u043d\u0433",      hrefs: ["/rusnas/storage-analyzer","/rusnas/performance","/rusnas/ai"] }
    ];
    var CHEVRON = '<svg class="rn-grp-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

    function getCollapsed() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) { return {}; } }
    function setCollapsed(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
    function findGroup(href) {
        for (var i = 0; i < GROUPS.length; i++)
            for (var j = 0; j < GROUPS[i].hrefs.length; j++)
                if (href === GROUPS[i].hrefs[j]) return GROUPS[i];
        return null;
    }

    function applyStyles(el, styles) {
        for (var k in styles) if (styles.hasOwnProperty(k)) el.style[k] = styles[k];
    }
    var HDR_STYLES = {display:"flex",alignItems:"center",padding:"6px 12px",margin:"10px 8px 2px",border:"none",background:"none",cursor:"pointer",fontSize:"10px",fontWeight:"700",letterSpacing:".07em",textTransform:"uppercase",color:"#4a5878",borderRadius:"4px",listStyle:"none",transition:"color .15s,background .15s"};
    var CHEV_STYLES = {marginRight:"6px",flexShrink:"0",transition:"transform .2s ease",opacity:".5"};
    var LABEL_STYLES = {flex:"1"};

    function buildNavGroups() {
        var doc;
        try { doc = window.parent.document; } catch(e) { return; }
        var sections = doc.querySelectorAll(".pf-v6-c-nav__section");
        var ul = null;
        for (var i = 0; i < sections.length; i++) {
            var t = sections[i].querySelector(".pf-v6-c-nav__section-title");
            if (t && t.textContent.indexOf("\u0421\u0438\u0441\u0442\u0435\u043c") > -1) {
                ul = sections[i].querySelector(".pf-v6-c-nav__list");
                break;
            }
        }
        if (!ul || ul.dataset.rnGrouped) return;
        ul.dataset.rnGrouped = "1";

        var collapsed = getCollapsed();

        /* ── Build href→li map ─────────────────────────────────────── */
        var hrefMap = {};
        var allLi = Array.prototype.slice.call(ul.children);
        allLi.forEach(function (li) {
            var a = li.querySelector("a");
            if (a) hrefMap[a.getAttribute("href") || ""] = li;
        });

        /* ── Detach all items from ul ──────────────────────────────── */
        while (ul.firstChild) ul.removeChild(ul.firstChild);

        /* ── Append Dashboard (standalone, always first) ───────────── */
        if (hrefMap["/rusnas/dashboard"]) {
            ul.appendChild(hrefMap["/rusnas/dashboard"]);
            delete hrefMap["/rusnas/dashboard"];
        }

        /* ── Append each group: header + children in defined order ── */
        GROUPS.forEach(function (group) {
            /* Check if any child is active */
            var isActive = false;
            var childLis = [];
            group.hrefs.forEach(function (h) {
                var li = hrefMap[h];
                if (!li) return;
                childLis.push(li);
                var a = li.querySelector("a");
                if (a && (a.classList.contains("pf-m-current") || a.getAttribute("aria-current") === "page")) isActive = true;
                delete hrefMap[h];
            });
            if (!childLis.length) return;

            var isColl = collapsed[group.id] === true && !isActive;

            /* Create group header with JS style properties */
            var hdr = doc.createElement("li");
            hdr.className = "rn-nav-group-hdr";
            hdr.dataset.groupId = group.id;
            hdr.dataset.expanded = isColl ? "0" : "1";
            applyStyles(hdr, HDR_STYLES);

            var chev = doc.createElementNS("http://www.w3.org/2000/svg","svg");
            chev.setAttribute("width","12"); chev.setAttribute("height","12");
            chev.setAttribute("viewBox","0 0 24 24"); chev.setAttribute("fill","none");
            chev.setAttribute("stroke","currentColor"); chev.setAttribute("stroke-width","2");
            chev.setAttribute("stroke-linecap","round"); chev.setAttribute("stroke-linejoin","round");
            var chevPath = doc.createElementNS("http://www.w3.org/2000/svg","path");
            chevPath.setAttribute("d","m9 18 6-6-6-6");
            chev.appendChild(chevPath);
            applyStyles(chev, CHEV_STYLES);
            if (!isColl) chev.style.transform = "rotate(90deg)";
            hdr.appendChild(chev);

            var labelSpan = doc.createElement("span");
            applyStyles(labelSpan, LABEL_STYLES);
            labelSpan.textContent = group.label;
            hdr.appendChild(labelSpan);

            ul.appendChild(hdr);

            /* Append children in defined order */
            childLis.forEach(function (li) {
                li.dataset.rnGroup = group.id;
                if (isColl) {
                    li.style.maxHeight = "0";
                    li.style.overflow = "hidden";
                    li.style.opacity = "0";
                    li.style.padding = "0";
                    li.style.margin = "0";
                    li.style.pointerEvents = "none";
                } else {
                    li.style.transition = "max-height .22s ease,opacity .18s ease";
                }
                ul.appendChild(li);
            });

            /* Click handler */
            (function(hdr, group, chev) {
                hdr.addEventListener("click", function () {
                    var isExp = hdr.dataset.expanded === "1";
                    hdr.dataset.expanded = isExp ? "0" : "1";
                    chev.style.transform = isExp ? "" : "rotate(90deg)";
                    ul.querySelectorAll('[data-rn-group="' + group.id + '"]').forEach(function (c) {
                        if (isExp) {
                            c.style.maxHeight = "0";
                            c.style.overflow = "hidden";
                            c.style.opacity = "0";
                            c.style.padding = "0";
                            c.style.margin = "0";
                            c.style.pointerEvents = "none";
                        } else {
                            c.style.maxHeight = "";
                            c.style.overflow = "";
                            c.style.opacity = "";
                            c.style.padding = "";
                            c.style.margin = "";
                            c.style.pointerEvents = "";
                            c.style.transition = "max-height .22s ease,opacity .18s ease";
                        }
                    });
                    var st = getCollapsed(); st[group.id] = isExp; setCollapsed(st);
                });
            })(hdr, group, chev);
        });

        /* ── Append Лицензия (standalone, after groups) ────────────── */
        if (hrefMap["/rusnas/license"]) {
            ul.appendChild(hrefMap["/rusnas/license"]);
            delete hrefMap["/rusnas/license"];
        }

        /* ── Append remaining ungrouped items ──────────────────────── */
        Object.keys(hrefMap).forEach(function (href) {
            ul.appendChild(hrefMap[href]);
        });
    }

    /* ── Alert badges: real system status per group ──────────────── */
    var BADGE_STYLES = {fontSize:"10px",fontWeight:"700",color:"#fff",background:"#e67e22",
        minWidth:"18px",height:"18px",lineHeight:"18px",textAlign:"center",
        borderRadius:"9px",padding:"0 5px",marginLeft:"auto",flexShrink:"0"};
    var BADGE_DANGER_BG = "#e74c3c";

    function setBadge(groupId, count, danger) {
        var doc; try { doc = window.parent.document; } catch(e) { return; }
        var hdr = doc.querySelector('.rn-nav-group-hdr[data-group-id="' + groupId + '"]');
        if (!hdr) return;
        var badge = hdr.querySelector(".rn-grp-badge");
        if (count <= 0) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = doc.createElement("span");
            badge.className = "rn-grp-badge";
            applyStyles(badge, BADGE_STYLES);
            hdr.appendChild(badge);
        }
        badge.textContent = count;
        badge.style.background = danger ? BADGE_DANGER_BG : "#e67e22";
    }

    function pollAlerts() {
        if (typeof cockpit === "undefined") return;
        var alerts = { storage: 0, protect: 0, infra: 0, monitor: 0 };
        var danger = { storage: false, protect: false, infra: false, monitor: false };
        var pending = 0;
        var total = 3;

        function done() {
            pending++;
            if (pending < total) return;
            setBadge("storage", alerts.storage, danger.storage);
            setBadge("protect", alerts.protect, danger.protect);
            setBadge("infra", alerts.infra, danger.infra);
            setBadge("monitor", alerts.monitor, danger.monitor);
        }

        /* 1. RAID: /proc/mdstat — no sudo needed (world-readable) */
        cockpit.file("/proc/mdstat").read().done(function(content) {
            if (!content) { done(); return; }
            var lines = content.split("\n");
            for (var i = 0; i < lines.length; i++) {
                if (/inactive/.test(lines[i])) { alerts.storage++; danger.storage = true; }
                if (/\[.*_.*\]/.test(lines[i])) { alerts.storage++; danger.storage = true; } /* [UU_U] = degraded */
                if (/\(F\)/.test(lines[i])) alerts.storage++;
            }
            done();
        }).fail(function() { done(); });

        /* 2. Guard events: count lines (file is 644, world-readable) */
        cockpit.file("/var/log/rusnas-guard/events.jsonl").read().done(function(content) {
            if (!content) { done(); return; }
            var lines = content.trim().split("\n").filter(function(l) { return l.trim(); });
            if (lines.length > 0) alerts.protect = lines.length;
            done();
        }).fail(function() { done(); });

        /* 3. UPS: upsc via sudoers NOPASSWD */
        cockpit.spawn(["sudo", "-n", "upsc", "ups@localhost", "ups.status"], {err:"message"})
            .done(function(out) {
                var s = out.trim();
                if (/OB/.test(s)) { alerts.infra++; if (/LB/.test(s)) danger.infra = true; }
                if (/COMMLOST/.test(s)) alerts.infra++;
                done();
            })
            .fail(function() { done(); }); /* UPS might not be configured — just skip */
    }

    var att = 0;
    function tryBuild() {
        att++;
        try {
            var nav = window.parent.document.querySelector(".pf-v6-c-nav__list");
            if (nav && nav.children.length > 5 && !nav.dataset.rnGrouped) {
                buildNavGroups();
                /* Start alert polling after groups are built */
                setTimeout(pollAlerts, 1500);
                setInterval(pollAlerts, 30000);
                return;
            }
        } catch(e) {}
        if (att < 25) setTimeout(tryBuild, 250);
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function() { setTimeout(tryBuild, 400); });
    } else {
        setTimeout(tryBuild, 400);
    }
}());

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

/**
 * Check if openEYE agent is enabled via localStorage.
 * @returns {boolean}
 */
function isEnabled() {
    return localStorage.getItem(EYE_ENABLED_KEY) === "true";
}

/**
 * Get human-readable page name from current URL path.
 * @returns {string}
 */
function getPageName() {
    var path = window.location.pathname;
    var match = path.match(/\/([^\/]+)\.html/);
    var key   = match ? match[1] : "unknown";
    return PAGE_LABELS[key] || key;
}

/**
 * Get AI provider credentials from localStorage.
 * @returns {Object}
 */
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

/**
 * Extract visible text content from the current page (max 5000 chars).
 * @returns {string}
 */
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

/**
 * Send page text to AI provider via mcp-api.py proxy for analysis.
 * @param {string} pageText - Extracted page text content
 * @param {string} pageName - Human-readable page name
 * @param {Function} callback - Callback(findings, error) with results
 * @returns {void}
 */
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

/**
 * Parse AI response text into structured findings array.
 * @param {string} text - Raw AI response text (may contain JSON or markdown)
 * @returns {Array<Object>}
 */
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

/**
 * Build and inject the openEYE floating panel and FAB button into the DOM.
 * @returns {void}
 */
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

/**
 * Show the openEYE analysis panel.
 * @returns {void}
 */
function openPanel() {
    var panel = document.getElementById("eye-panel");
    if (!panel) return;
    panel.classList.add("open");
    _panelOpen = true;
}

/**
 * Hide the openEYE analysis panel.
 * @returns {void}
 */
function closePanel() {
    var panel = document.getElementById("eye-panel");
    if (!panel) return;
    panel.classList.remove("open");
    _panelOpen = false;
}

// ── Render findings ───────────────────────────────────────────────────────────

var LEVEL_ICONS = { critical: "🔴", warning: "🟡", info: "🔵", ok: "🟢" };
var LEVEL_NAMES = { critical: "Критично", warning: "Предупреждения", info: "Информация", ok: "Норма" };

/**
 * Update the status indicator dot and text in the panel header.
 * @param {string} state - CSS class for the status dot (analyzing|done|error)
 * @param {string} text - Status text to display
 * @returns {void}
 */
function setStatus(state, text) {
    var dot  = document.getElementById("eye-status-dot");
    var span = document.getElementById("eye-status-text");
    if (dot)  dot.className = state;
    if (span) span.textContent = text;
}

/**
 * Set the panel to loading/analyzing state with spinner.
 * @returns {void}
 */
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

/**
 * Render AI analysis findings grouped by severity level.
 * @param {Array<Object>} findings - Array of {level, text} finding objects
 * @returns {void}
 */
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

/**
 * Render an error message in the panel body.
 * @param {string} msg - Error message to display
 * @returns {void}
 */
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

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} s - Raw string to escape
 * @returns {string}
 */
function escHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Main analysis ─────────────────────────────────────────────────────────────

/**
 * Run the full AI analysis cycle: extract text, call AI, render results.
 * @returns {void}
 */
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
