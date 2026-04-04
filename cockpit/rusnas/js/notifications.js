// ─── rusNAS Notifications UI ──────────────────────────────────────────────────
//
// Communicates with rusnas-notifyd daemon via Unix socket
// at /run/rusnas-notify/notify.sock through cockpit.channel.
//
// Socket protocol: newline-delimited JSON (send JSON + "\n", receive JSON + "\n")
//
// ─────────────────────────────────────────────────────────────────────────────

var SOCK_PATH = "/run/rusnas-notify/notify.sock";

// ── Current state ────────────────────────────────────────────────────────────

var currentConfig  = null;   // full config from daemon
var historyPage    = 0;      // current history pagination offset
var historyLimit   = 50;     // items per page
var historyTotal   = 0;      // total items from last query
var watcherRules   = [];     // current log watcher rules

// ── Routing module metadata ──────────────────────────────────────────────────

var MODULES = [
    { key: "guard",      label: "Guard",       icon: "\uD83D\uDEE1\uFE0F" },
    { key: "ups",        label: "UPS",         icon: "\uD83D\uDD0B" },
    { key: "raid",       label: "RAID",        icon: "\uD83D\uDDB4" },
    { key: "snapshots",  label: "Snapshots",   icon: "\uD83D\uDCF8" },
    { key: "storage",    label: "Storage",     icon: "\uD83D\uDCC1" },
    { key: "network",    label: "Network",     icon: "\uD83C\uDF10" },
    { key: "security",   label: "Security",    icon: "\uD83D\uDD12" },
    { key: "containers", label: "Containers",  icon: "\uD83D\uDCE6" },
    { key: "system",     label: "System",      icon: "\u2699\uFE0F" },
    { key: "custom",     label: "Custom",      icon: "\uD83D\uDCDD" }
];

var CHANNELS = ["email", "telegram", "max", "snmp", "webhook"];

var CHANNEL_ICONS = {
    email:    "\u2709\uFE0F",
    telegram: "\u2708\uFE0F",
    max:      "\uD83D\uDCAC",
    snmp:     "\uD83D\uDCCA",
    webhook:  "\uD83D\uDD17"
};

// ── Log Watcher preset templates ─────────────────────────────────────────────

var LW_TEMPLATES = {
    "ssh-root":      { name: "SSH root login",  file: "/var/log/auth.log",  pattern: "Accepted.*root@",              severity: "warning" },
    "oom":           { name: "OOM Kill",         file: "/var/log/kern.log",  pattern: "Out of memory.*Killed",        severity: "critical" },
    "segfault":      { name: "Segfault",         file: "/var/log/kern.log",  pattern: "segfault at",                  severity: "warning" },
    "kernel-panic":  { name: "Kernel panic",     file: "/var/log/kern.log",  pattern: "Kernel panic",                 severity: "critical" },
    "disk-error":    { name: "Disk error",       file: "/var/log/syslog",    pattern: "I/O error|medium error|DRDY",  severity: "critical" }
};

// ── Socket communication (follows guard.js pattern) ──────────────────────────

/**
 * Send a JSON command to the notification daemon via Unix socket.
 * @param {Object} req - Request object to send
 * @param {Function} callback - callback(err, response)
 */
function notifySocket(req, callback) {
    var ch = cockpit.channel({
        payload: "stream",
        unix:    SOCK_PATH
    });

    var buf = "";
    ch.addEventListener("message", function(ev, data) {
        buf += data;
        var nl = buf.indexOf("\n");
        if (nl !== -1) {
            try {
                var resp = JSON.parse(buf.substring(0, nl));
                callback(null, resp);
            } catch (e) {
                callback(e, null);
            }
            ch.close();
        }
    });
    ch.addEventListener("close", function(ev, options) {
        if (options && options.problem) {
            callback(new Error(options.problem), null);
        }
    });

    ch.send(JSON.stringify(req) + "\n");
}

/**
 * Send a command to the notification daemon.
 * @param {string} cmd - Command name
 * @param {Object} data - Extra parameters
 * @param {Function} callback - callback(err, response)
 */
function notifyCmd(cmd, data, callback) {
    var req = Object.assign({ cmd: cmd }, data || {});
    notifySocket(req, callback);
}

// ── Tab switching ────────────────────────────────────────────────────────────

function showTab(tabId) {
    document.querySelectorAll(".tab-btn").forEach(function(btn) {
        btn.classList.toggle("tab-active", btn.getAttribute("data-tab") === tabId);
    });
    document.querySelectorAll(".tab-panel").forEach(function(panel) {
        panel.classList.toggle("hidden", panel.id !== tabId);
    });

    // Lazy-load data for the active tab
    if (tabId === "tab-history")    loadHistory(0);
    if (tabId === "tab-logwatcher") loadLogWatchers();
}

// ── Status bar ───────────────────────────────────────────────────────────────

function loadStatus() {
    notifyCmd("status", {}, function(err, resp) {
        var badge = document.getElementById("notify-daemon-badge");
        var summary = document.getElementById("notify-channels-summary");

        if (err || !resp || !resp.ok) {
            badge.className = "badge badge-danger";
            badge.textContent = "Daemon offline";
            summary.textContent = "";
            return;
        }

        badge.className = "badge badge-success";
        badge.textContent = "Daemon active";

        if (resp.data && resp.data.channels_enabled) {
            var names = resp.data.channels_enabled;
            summary.textContent = "Активных каналов: " + names.length +
                (names.length > 0 ? " (" + names.join(", ") + ")" : "");
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab 1: Channels
// ══════════════════════════════════════════════════════════════════════════════

function loadConfig() {
    notifyCmd("get_config", {}, function(err, resp) {
        if (err || !resp || !resp.ok) {
            console.warn("notify: get_config failed", err);
            return;
        }
        currentConfig = resp.data || resp.config || {};
        populateChannels();
        populateRouting();
        populateThrottle();
        populateLogWatchersFromConfig();
    });
}

function populateChannels() {
    if (!currentConfig || !currentConfig.channels) return;
    var ch = currentConfig.channels;

    // Email
    setChecked("ch-email-enabled", ch.email && ch.email.enabled);
    setVal("ch-email-host",  ch.email && ch.email.smtp_host || "");
    setVal("ch-email-port",  ch.email && ch.email.smtp_port || 587);
    setVal("ch-email-tls",   ch.email && ch.email.smtp_tls || "starttls");
    setVal("ch-email-user",  ch.email && ch.email.smtp_user || "");
    setVal("ch-email-pass",  ch.email && ch.email.smtp_pass || "");
    setVal("ch-email-from",  ch.email && ch.email.from || "");
    setTextarea("ch-email-recipients", ch.email && ch.email.recipients || []);

    // Telegram
    setChecked("ch-telegram-enabled", ch.telegram && ch.telegram.enabled);
    setVal("ch-telegram-token", ch.telegram && ch.telegram.bot_token || "");
    setTextarea("ch-telegram-chats", ch.telegram && ch.telegram.chat_ids || []);

    // MAX
    setChecked("ch-max-enabled", ch.max && ch.max.enabled);
    setVal("ch-max-token", ch.max && ch.max.bot_token || "");
    setTextarea("ch-max-chats", ch.max && ch.max.chat_ids || []);

    // SNMP
    setChecked("ch-snmp-enabled", ch.snmp && ch.snmp.enabled);
    setVal("ch-snmp-version", ch.snmp && ch.snmp.version || "v2c");
    setVal("ch-snmp-community", ch.snmp && ch.snmp.community || "public");
    setVal("ch-snmp-v3-user", ch.snmp && ch.snmp.v3_username || "");
    setVal("ch-snmp-v3-auth-proto", ch.snmp && ch.snmp.v3_auth_protocol || "SHA");
    setVal("ch-snmp-v3-auth-pass", ch.snmp && ch.snmp.v3_auth_password || "");
    setVal("ch-snmp-v3-priv-proto", ch.snmp && ch.snmp.v3_priv_protocol || "AES");
    setVal("ch-snmp-v3-priv-pass", ch.snmp && ch.snmp.v3_priv_password || "");
    setTextarea("ch-snmp-receivers", ch.snmp && ch.snmp.trap_receivers || []);
    toggleSnmpFields();

    // Webhook
    setChecked("ch-webhook-enabled", ch.webhook && ch.webhook.enabled);
    setTextarea("ch-webhook-urls", ch.webhook && ch.webhook.urls || []);
    setVal("ch-webhook-method", ch.webhook && ch.webhook.method || "POST");
    setVal("ch-webhook-timeout", ch.webhook && ch.webhook.timeout_sec || 10);
    var headers = ch.webhook && ch.webhook.headers || {};
    var el = document.getElementById("ch-webhook-headers");
    if (el) el.value = Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : "";
}

function toggleSnmpFields() {
    var ver = document.getElementById("ch-snmp-version").value;
    document.getElementById("snmp-v2c-fields").classList.toggle("hidden", ver !== "v2c");
    document.getElementById("snmp-v3-fields").classList.toggle("hidden", ver !== "v3");
}

function buildChannelConfig(name) {
    switch (name) {
        case "email":
            return {
                enabled:    isChecked("ch-email-enabled"),
                smtp_host:  getVal("ch-email-host"),
                smtp_port:  parseInt(getVal("ch-email-port"), 10) || 587,
                smtp_tls:   getVal("ch-email-tls"),
                smtp_user:  getVal("ch-email-user"),
                smtp_pass:  getVal("ch-email-pass"),
                from:       getVal("ch-email-from"),
                recipients: getLines("ch-email-recipients")
            };
        case "telegram":
            return {
                enabled:   isChecked("ch-telegram-enabled"),
                bot_token: getVal("ch-telegram-token"),
                chat_ids:  getLines("ch-telegram-chats")
            };
        case "max":
            return {
                enabled:   isChecked("ch-max-enabled"),
                bot_token: getVal("ch-max-token"),
                chat_ids:  getLines("ch-max-chats")
            };
        case "snmp":
            return {
                enabled:          isChecked("ch-snmp-enabled"),
                version:          getVal("ch-snmp-version"),
                community:        getVal("ch-snmp-community"),
                trap_receivers:   getLines("ch-snmp-receivers"),
                v3_username:      getVal("ch-snmp-v3-user"),
                v3_auth_protocol: getVal("ch-snmp-v3-auth-proto"),
                v3_auth_password: getVal("ch-snmp-v3-auth-pass"),
                v3_priv_protocol: getVal("ch-snmp-v3-priv-proto"),
                v3_priv_password: getVal("ch-snmp-v3-priv-pass")
            };
        case "webhook":
            var hdrs = {};
            try { hdrs = JSON.parse(document.getElementById("ch-webhook-headers").value || "{}"); } catch(e) { /* ignore */ }
            return {
                enabled:     isChecked("ch-webhook-enabled"),
                urls:        getLines("ch-webhook-urls"),
                method:      getVal("ch-webhook-method"),
                timeout_sec: parseInt(getVal("ch-webhook-timeout"), 10) || 10,
                headers:     hdrs
            };
    }
    return {};
}

function saveChannel(name) {
    if (!currentConfig) currentConfig = { channels: {}, routing: {}, throttle: {} };
    if (!currentConfig.channels) currentConfig.channels = {};
    currentConfig.channels[name] = buildChannelConfig(name);

    notifyCmd("save_config", { config: currentConfig }, function(err, resp) {
        showChannelResult(name, !err && resp && resp.ok, err ? err.message : (resp && resp.error || ""));
    });
}

function testChannel(name) {
    var resultEl = document.getElementById("result-" + name);
    resultEl.classList.remove("hidden", "nf-result-ok", "nf-result-err");
    resultEl.textContent = "Отправка тестового уведомления...";
    resultEl.className = "nf-channel-result";

    notifyCmd("test", { channel: name }, function(err, resp) {
        if (err || !resp || !resp.ok) {
            showChannelResult(name, false, err ? err.message : (resp && resp.error || "Ошибка отправки"));
        } else {
            showChannelResult(name, true, "Тестовое уведомление отправлено успешно");
        }
    });
}

function showChannelResult(name, ok, msg) {
    var el = document.getElementById("result-" + name);
    if (!el) return;
    el.classList.remove("hidden", "nf-result-ok", "nf-result-err");
    el.classList.add(ok ? "nf-result-ok" : "nf-result-err");
    el.textContent = msg || (ok ? "OK" : "Ошибка");

    // Auto-hide after 6 seconds
    setTimeout(function() { el.classList.add("hidden"); }, 6000);
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab 2: Routing matrix
// ══════════════════════════════════════════════════════════════════════════════

function populateRouting() {
    var tbody = document.getElementById("routing-body");
    if (!tbody) return;
    var routing = (currentConfig && currentConfig.routing) || {};
    var html = "";

    MODULES.forEach(function(mod) {
        var r = routing[mod.key] || {};
        html += "<tr>";
        html += "<td><div class='nf-module-label'><span class='nf-module-icon'>" + mod.icon + "</span>" + mod.label + "</div></td>";
        CHANNELS.forEach(function(ch) {
            var checked = r[ch] ? " checked" : "";
            html += "<td><input type='checkbox' data-mod='" + mod.key + "' data-ch='" + ch + "'" + checked + "></td>";
        });
        html += "</tr>";
    });

    tbody.innerHTML = html;
}

function collectRouting() {
    var routing = {};
    MODULES.forEach(function(mod) {
        routing[mod.key] = {};
        CHANNELS.forEach(function(ch) {
            var cb = document.querySelector("#routing-matrix input[data-mod='" + mod.key + "'][data-ch='" + ch + "']");
            routing[mod.key][ch] = cb ? cb.checked : false;
        });
    });
    return routing;
}

function saveRouting() {
    if (!currentConfig) currentConfig = {};
    currentConfig.routing = collectRouting();

    notifyCmd("save_config", { config: currentConfig }, function(err, resp) {
        var btn = document.getElementById("btn-save-routing");
        if (!err && resp && resp.ok) {
            btn.textContent = "Сохранено!";
            setTimeout(function() { btn.textContent = "Сохранить маршруты"; }, 2000);
        } else {
            btn.textContent = "Ошибка!";
            setTimeout(function() { btn.textContent = "Сохранить маршруты"; }, 2000);
        }
    });
}

// ── Throttle settings ────────────────────────────────────────────────────────

function populateThrottle() {
    var t = (currentConfig && currentConfig.throttle) || {};
    setVal("throttle-window", t.window_sec || 300);
    setVal("throttle-max", t.max_per_source || 5);
    setVal("throttle-digest", t.digest_delay_sec || 60);
}

function saveThrottle() {
    if (!currentConfig) currentConfig = {};
    currentConfig.throttle = {
        window_sec:       parseInt(getVal("throttle-window"), 10) || 300,
        max_per_source:   parseInt(getVal("throttle-max"), 10) || 5,
        digest_delay_sec: parseInt(getVal("throttle-digest"), 10) || 60
    };

    notifyCmd("save_config", { config: currentConfig }, function(err, resp) {
        var btn = document.getElementById("btn-save-throttle");
        if (!err && resp && resp.ok) {
            btn.textContent = "Сохранено!";
            setTimeout(function() { btn.textContent = "Сохранить настройки"; }, 2000);
        } else {
            btn.textContent = "Ошибка!";
            setTimeout(function() { btn.textContent = "Сохранить настройки"; }, 2000);
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab 3: History
// ══════════════════════════════════════════════════════════════════════════════

function loadHistory(offset) {
    historyPage = offset || 0;
    var filters = {
        source:   getVal("hist-filter-source"),
        severity: getVal("hist-filter-severity"),
        status:   getVal("hist-filter-status"),
        from:     getVal("hist-filter-from"),
        to:       getVal("hist-filter-to")
    };

    // Remove empty filters
    Object.keys(filters).forEach(function(k) { if (!filters[k]) delete filters[k]; });

    notifyCmd("get_history", {
        limit:  historyLimit,
        offset: historyPage,
        source:   filters.source || "",
        severity: filters.severity || "",
        status:   filters.status || ""
    }, function(err, resp) {
        var tbody = document.getElementById("hist-body");
        var countInfo = document.getElementById("hist-count-info");
        var pageInfo  = document.getElementById("hist-page-info");

        if (err || !resp || !resp.ok) {
            tbody.innerHTML = "<tr><td colspan='6' class='text-muted'>Не удалось загрузить историю" +
                (err ? ": " + escHtml(err.message) : "") + "</td></tr>";
            countInfo.textContent = "";
            return;
        }

        var events = resp.data && resp.data.events || resp.events || [];
        historyTotal = resp.data && resp.data.total || resp.total || events.length;

        countInfo.textContent = "Всего: " + historyTotal;
        var totalPages = Math.ceil(historyTotal / historyLimit) || 1;
        var curPage    = Math.floor(historyPage / historyLimit) + 1;
        pageInfo.textContent = curPage + " / " + totalPages;

        document.getElementById("btn-hist-prev").disabled = historyPage === 0;
        document.getElementById("btn-hist-next").disabled = historyPage + historyLimit >= historyTotal;

        if (events.length === 0) {
            tbody.innerHTML = "<tr><td colspan='6' class='text-muted'>Нет событий по заданным фильтрам</td></tr>";
            return;
        }

        var html = "";
        events.forEach(function(ev) {
            var sev = ev.severity || "info";
            var sevBadge = "<span class='badge nf-sev-" + escHtml(sev) + "'>" + escHtml(sev) + "</span>";

            // Channel delivery icons
            var chIcons = buildChannelIcons(ev.deliveries || []);

            // Aggregate status
            var status = aggregateStatus(ev.deliveries || []);
            var stBadge = "<span class='badge nf-st-" + escHtml(status) + "'>" + escHtml(status) + "</span>";

            var time = ev.created_at ? formatTime(ev.created_at) : "---";

            html += "<tr>";
            html += "<td style='white-space:nowrap;font-size:12px;'>" + time + "</td>";
            html += "<td>" + escHtml(ev.source || "---") + "</td>";
            html += "<td>" + sevBadge + "</td>";
            html += "<td>" + escHtml(ev.title || "---") + "</td>";
            html += "<td>" + chIcons + "</td>";
            html += "<td>" + stBadge + "</td>";
            html += "</tr>";
        });

        tbody.innerHTML = html;
    });
}

function buildChannelIcons(deliveries) {
    var map = CHANNEL_ICONS;
    var used = {};
    deliveries.forEach(function(d) { used[d.channel] = true; });

    var html = "<div class='nf-ch-icons'>";
    CHANNELS.forEach(function(ch) {
        var cls = used[ch] ? "" : " nf-ch-icon-dim";
        html += "<span class='" + cls + "' title='" + ch + "'>" + (map[ch] || "?") + "</span>";
    });
    html += "</div>";
    return html;
}

function aggregateStatus(deliveries) {
    if (deliveries.length === 0) return "pending";
    var hasFailed = false, hasThrottled = false, hasSent = false;
    deliveries.forEach(function(d) {
        if (d.status === "failed")    hasFailed = true;
        if (d.status === "throttled") hasThrottled = true;
        if (d.status === "sent")      hasSent = true;
    });
    if (hasFailed) return "failed";
    if (hasThrottled) return "throttled";
    if (hasSent) return "sent";
    return "pending";
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab 4: Log Watcher
// ══════════════════════════════════════════════════════════════════════════════

function loadLogWatchers() {
    // Populate from currentConfig if available, otherwise request fresh
    if (currentConfig && currentConfig.log_watchers) {
        watcherRules = currentConfig.log_watchers.slice();
        renderWatchers();
    } else {
        notifyCmd("get_config", {}, function(err, resp) {
            if (!err && resp && resp.ok) {
                currentConfig = resp.data || resp.config || {};
                watcherRules = (currentConfig.log_watchers || []).slice();
            } else {
                watcherRules = [];
            }
            renderWatchers();
        });
    }
}

function populateLogWatchersFromConfig() {
    if (currentConfig && currentConfig.log_watchers) {
        watcherRules = currentConfig.log_watchers.slice();
    }
}

function renderWatchers() {
    var tbody = document.getElementById("lw-body");
    if (!tbody) return;

    var rules = filterAndSortWatchers(watcherRules);

    if (rules.length === 0) {
        tbody.innerHTML = "<tr><td colspan='6' class='text-muted'>Нет правил. Нажмите \"+ Добавить правило\" или выберите шаблон.</td></tr>";
        return;
    }

    var html = "";
    rules.forEach(function(rule, idx) {
        var origIdx = watcherRules.indexOf(rule);
        html += "<tr data-idx='" + origIdx + "'>";
        html += "<td><input type='checkbox' class='lw-enable-cb' data-idx='" + origIdx + "'" + (rule.enabled ? " checked" : "") + "></td>";
        html += "<td><input type='text' class='lw-name-input' data-idx='" + origIdx + "' value='" + escAttr(rule.name || "") + "'></td>";
        html += "<td><select class='lw-file-select' data-idx='" + origIdx + "'>" +
                    "<option value='/var/log/auth.log'" + (rule.file === "/var/log/auth.log" ? " selected" : "") + ">auth.log</option>" +
                    "<option value='/var/log/syslog'" + (rule.file === "/var/log/syslog" ? " selected" : "") + ">syslog</option>" +
                    "<option value='/var/log/kern.log'" + (rule.file === "/var/log/kern.log" ? " selected" : "") + ">kern.log</option>" +
                    "<option value='custom'" + (["/var/log/auth.log","/var/log/syslog","/var/log/kern.log"].indexOf(rule.file) === -1 ? " selected" : "") + ">custom...</option>" +
                "</select></td>";
        html += "<td><input type='text' class='lw-regex-input nf-lw-regex' data-idx='" + origIdx + "' value='" + escAttr(rule.pattern || "") + "'></td>";
        html += "<td><select class='lw-severity-select' data-idx='" + origIdx + "'>" +
                    "<option value='critical'" + (rule.severity === "critical" ? " selected" : "") + ">critical</option>" +
                    "<option value='warning'" + (rule.severity === "warning" ? " selected" : "") + ">warning</option>" +
                    "<option value='info'" + (rule.severity === "info" ? " selected" : "") + ">info</option>" +
                "</select></td>";
        html += "<td><div class='nf-lw-actions'>" +
                "<button class='btn btn-secondary btn-sm lw-test-btn' data-idx='" + origIdx + "' title='Тест'>Тест</button>" +
                "<button class='btn btn-danger btn-sm lw-del-btn' data-idx='" + origIdx + "' title='Удалить'>&#10005;</button>" +
                "</div></td>";
        html += "</tr>";
    });

    tbody.innerHTML = html;

    // Bind inline events
    tbody.querySelectorAll(".lw-enable-cb").forEach(function(cb) {
        cb.addEventListener("change", function() {
            var i = parseInt(this.getAttribute("data-idx"), 10);
            if (watcherRules[i]) watcherRules[i].enabled = this.checked;
        });
    });
    tbody.querySelectorAll(".lw-name-input").forEach(function(inp) {
        inp.addEventListener("input", function() {
            var i = parseInt(this.getAttribute("data-idx"), 10);
            if (watcherRules[i]) watcherRules[i].name = this.value;
        });
    });
    tbody.querySelectorAll(".lw-file-select").forEach(function(sel) {
        sel.addEventListener("change", function() {
            var i = parseInt(this.getAttribute("data-idx"), 10);
            if (watcherRules[i]) {
                if (this.value === "custom") {
                    var path = prompt("Введите путь к лог-файлу:", "/var/log/");
                    if (path) watcherRules[i].file = path;
                } else {
                    watcherRules[i].file = this.value;
                }
            }
        });
    });
    tbody.querySelectorAll(".lw-regex-input").forEach(function(inp) {
        inp.addEventListener("input", function() {
            var i = parseInt(this.getAttribute("data-idx"), 10);
            if (watcherRules[i]) watcherRules[i].pattern = this.value;
        });
    });
    tbody.querySelectorAll(".lw-severity-select").forEach(function(sel) {
        sel.addEventListener("change", function() {
            var i = parseInt(this.getAttribute("data-idx"), 10);
            if (watcherRules[i]) watcherRules[i].severity = this.value;
        });
    });
    tbody.querySelectorAll(".lw-test-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var i = parseInt(this.getAttribute("data-idx"), 10);
            testWatcher(i);
        });
    });
    tbody.querySelectorAll(".lw-del-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var i = parseInt(this.getAttribute("data-idx"), 10);
            removeWatcher(i);
        });
    });
}

function filterAndSortWatchers(rules) {
    var nameFilter = (document.getElementById("lw-filter-name").value || "").toLowerCase();
    var fileFilter = document.getElementById("lw-filter-file").value;
    var sevFilter  = document.getElementById("lw-filter-severity").value;
    var sortBy     = document.getElementById("lw-sort").value;

    var filtered = rules.filter(function(r) {
        if (nameFilter && (r.name || "").toLowerCase().indexOf(nameFilter) === -1) return false;
        if (fileFilter && r.file !== fileFilter) return false;
        if (sevFilter && r.severity !== sevFilter) return false;
        return true;
    });

    filtered.sort(function(a, b) {
        switch (sortBy) {
            case "file":     return (a.file || "").localeCompare(b.file || "");
            case "severity":
                var order = { critical: 0, warning: 1, info: 2 };
                return (order[a.severity] || 9) - (order[b.severity] || 9);
            default: // name
                return (a.name || "").localeCompare(b.name || "");
        }
    });

    return filtered;
}

function addWatcher(template) {
    var rule;
    if (template && LW_TEMPLATES[template]) {
        rule = Object.assign({}, LW_TEMPLATES[template], { enabled: true });
    } else {
        rule = { name: "", file: "/var/log/syslog", pattern: "", severity: "warning", enabled: true };
    }
    watcherRules.push(rule);
    renderWatchers();
}

function removeWatcher(idx) {
    if (idx >= 0 && idx < watcherRules.length) {
        watcherRules.splice(idx, 1);
        renderWatchers();
    }
}

function testWatcher(idx) {
    var rule = watcherRules[idx];
    if (!rule) return;

    // Use cockpit.spawn to test the regex against the log file
    var cmd = ["sudo", "-n", "tail", "-n", "200", rule.file];
    var proc = cockpit.spawn(cmd, { err: "message" });
    var out = "";
    proc.stream(function(data) { out += data; });
    proc.then(function() {
        try {
            var re = new RegExp(rule.pattern);
            var lines = out.split("\n");
            var matches = lines.filter(function(l) { return re.test(l); });
            var msg = "Найдено совпадений: " + matches.length;
            if (matches.length > 0) {
                msg += "\n\nПоследние совпадения:\n" + matches.slice(-5).join("\n");
            }
            alert(msg);
        } catch (e) {
            alert("Ошибка в регулярном выражении: " + e.message);
        }
    }).catch(function(ex) {
        alert("Ошибка чтения файла: " + (ex.message || ex));
    });
}

function saveLogWatchers() {
    if (!currentConfig) currentConfig = {};
    currentConfig.log_watchers = watcherRules;

    notifyCmd("save_config", { config: currentConfig }, function(err, resp) {
        var btn = document.getElementById("btn-save-watchers");
        if (!err && resp && resp.ok) {
            btn.textContent = "Сохранено!";
            setTimeout(function() { btn.textContent = "Сохранить правила"; }, 2000);
        } else {
            btn.textContent = "Ошибка!";
            setTimeout(function() { btn.textContent = "Сохранить правила"; }, 2000);
        }
    });
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function getVal(id) {
    var el = document.getElementById(id);
    return el ? el.value : "";
}

function setVal(id, v) {
    var el = document.getElementById(id);
    if (el) el.value = v;
}

function isChecked(id) {
    var el = document.getElementById(id);
    return el ? el.checked : false;
}

function setChecked(id, v) {
    var el = document.getElementById(id);
    if (el) el.checked = !!v;
}

function getLines(id) {
    var el = document.getElementById(id);
    if (!el) return [];
    return el.value.split("\n").map(function(l) { return l.trim(); }).filter(Boolean);
}

function setTextarea(id, arr) {
    var el = document.getElementById(id);
    if (el) el.value = (arr || []).join("\n");
}

function escHtml(s) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(s || ""));
    return div.innerHTML;
}

function escAttr(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTime(iso) {
    if (!iso) return "---";
    try {
        var d = new Date(iso);
        var pad = function(n) { return n < 10 ? "0" + n : n; };
        return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() +
               " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    } catch (e) {
        return iso;
    }
}

// ── Event bindings ───────────────────────────────────────────────────────────

function init() {
    // Tab switching
    document.querySelectorAll(".tab-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            showTab(this.getAttribute("data-tab"));
        });
    });

    // SNMP version toggle
    document.getElementById("ch-snmp-version").addEventListener("change", toggleSnmpFields);

    // Channel save/test buttons (delegated)
    document.querySelectorAll("[data-save]").forEach(function(btn) {
        btn.addEventListener("click", function() {
            saveChannel(this.getAttribute("data-save"));
        });
    });
    document.querySelectorAll("[data-test]").forEach(function(btn) {
        btn.addEventListener("click", function() {
            testChannel(this.getAttribute("data-test"));
        });
    });

    // Routing
    document.getElementById("btn-save-routing").addEventListener("click", saveRouting);

    // Throttle
    document.getElementById("btn-save-throttle").addEventListener("click", saveThrottle);

    // History
    document.getElementById("btn-hist-apply").addEventListener("click", function() { loadHistory(0); });
    document.getElementById("btn-hist-reset").addEventListener("click", function() {
        setVal("hist-filter-source", "");
        setVal("hist-filter-severity", "");
        setVal("hist-filter-status", "");
        setVal("hist-filter-from", "");
        setVal("hist-filter-to", "");
        loadHistory(0);
    });
    document.getElementById("btn-hist-prev").addEventListener("click", function() {
        if (historyPage >= historyLimit) loadHistory(historyPage - historyLimit);
    });
    document.getElementById("btn-hist-next").addEventListener("click", function() {
        if (historyPage + historyLimit < historyTotal) loadHistory(historyPage + historyLimit);
    });

    // Log Watcher
    document.getElementById("btn-add-watcher").addEventListener("click", function() { addWatcher(); });
    document.getElementById("btn-save-watchers").addEventListener("click", saveLogWatchers);

    // Template buttons
    document.querySelectorAll(".nf-tpl-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            addWatcher(this.getAttribute("data-tpl"));
        });
    });

    // Log Watcher filters
    document.getElementById("lw-filter-name").addEventListener("input", function() { renderWatchers(); });
    document.getElementById("lw-filter-file").addEventListener("change", function() { renderWatchers(); });
    document.getElementById("lw-filter-severity").addEventListener("change", function() { renderWatchers(); });
    document.getElementById("lw-sort").addEventListener("change", function() { renderWatchers(); });

    // Initial data load
    loadStatus();
    loadConfig();
}

// Boot
document.addEventListener("DOMContentLoaded", init);
