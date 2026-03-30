"use strict";

var UPS_NAME_DEFAULT = "myups";
var NUT_CONF       = "/etc/nut/nut.conf";
var UPS_CONF       = "/etc/nut/ups.conf";
var UPSD_CONF      = "/etc/nut/upsd.conf";
var UPSD_USERS     = "/etc/nut/upsd.users";
var UPSMON_CONF    = "/etc/nut/upsmon.conf";
var NUT_PASS       = "rusnas_nut_2026";

var _statusTimer = null;
var _upsName = UPS_NAME_DEFAULT;
var _nutInstalled = false;

// ── Утилиты ──────────────────────────────────────────────────────────────────

/**
 * Safely parse JSON string, returning null on failure.
 * @param {string} str - JSON string to parse
 * @returns {Object|null}
 */
function safeJson(str) {
    try { return JSON.parse(str.trim()); } catch(e) { return null; }
}

/**
 * Show a global alert banner with auto-hide after 4 seconds.
 * @param {string} type - Alert type (success|warning|danger)
 * @param {string} msg - Alert message text
 * @returns {void}
 */
function showAlert(type, msg) {
    var el = document.getElementById("global-alert");
    el.className = "alert alert-" + type;
    el.textContent = msg;
    el.classList.remove("hidden");
    setTimeout(function() { el.classList.add("hidden"); }, 4000);
}

/**
 * Briefly show a message element, then auto-hide after timeout.
 * @param {string} id - DOM element ID to show
 * @param {number} ms - Milliseconds before hiding (default 3000)
 * @returns {void}
 */
function showMsg(id, ms) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("hidden");
    setTimeout(function() { el.classList.add("hidden"); }, ms || 3000);
}

/**
 * Format seconds into human-readable runtime string.
 * @param {number} secs - Runtime in seconds
 * @returns {string}
 */
function fmtRuntime(secs) {
    secs = parseInt(secs) || 0;
    if (!secs) return "—";
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    if (h > 0) return h + " ч " + m + " мин";
    return m + " мин";
}

// ── Проверка установки NUT ────────────────────────────────────────────────────

/**
 * Check if NUT (upsc) is installed and show/hide appropriate UI.
 * @returns {void}
 */
function checkNutInstalled() {
    cockpit.spawn(["which", "upsc"], { err: "message" })
    .done(function() {
        _nutInstalled = true;
        document.getElementById("no-nut-banner").classList.add("hidden");
        document.getElementById("ups-content").classList.remove("hidden");
        loadAll();
        startPolling();
    })
    .fail(function() {
        _nutInstalled = false;
        document.getElementById("no-nut-banner").classList.remove("hidden");
        document.getElementById("ups-content").classList.add("hidden");
    });
}

// ── Установка NUT ─────────────────────────────────────────────────────────────

/**
 * Install the NUT package via apt-get with streaming log output.
 * @returns {void}
 */
function installNut() {
    var log = document.getElementById("install-log");
    log.classList.remove("hidden");
    log.textContent = "Установка nut...\n";
    document.getElementById("btn-install-nut").disabled = true;

    cockpit.spawn(["sudo", "-n", "apt-get", "install", "-y", "nut"],
        { err: "out" })
    .stream(function(data) { log.textContent += data; log.scrollTop = log.scrollHeight; })
    .done(function() {
        log.textContent += "\n✓ NUT установлен\n";
        setTimeout(checkNutInstalled, 500);
    })
    .fail(function(err) {
        log.textContent += "\n✗ Ошибка: " + err.message;
        document.getElementById("btn-install-nut").disabled = false;
    });
}

// ── Загрузка статуса UPS ──────────────────────────────────────────────────────

/**
 * Load UPS name from config then fetch current UPS status.
 * @returns {void}
 */
function loadUpsStatus() {
    // Сначала читаем имя UPS из конфига
    cockpit.file(UPS_CONF).read()
    .done(function(content) {
        if (content) {
            var m = content.match(/^\[(\w+)\]/m);
            if (m) _upsName = m[1];
        }
        fetchUpsStatus();
    })
    .fail(function() { fetchUpsStatus(); });
}

/**
 * Fetch UPS status via upsc (JSON mode with text fallback).
 * @returns {void}
 */
function fetchUpsStatus() {
    // Пробуем upsc -j (JSON, NUT 2.8+)
    cockpit.spawn(["sudo", "-n", "upsc", "-j", _upsName + "@localhost"],
        { err: "message" })
    .done(function(out) {
        var data = safeJson(out);
        if (data) renderUpsStatus(data);
    })
    .fail(function(err) {
        // Fallback: upsc без флагов (построчный вывод)
        cockpit.spawn(["sudo", "-n", "upsc", _upsName + "@localhost"],
            { err: "message" })
        .done(function(out) {
            renderUpsStatus(parseUpscText(out));
        })
        .fail(function(err2) {
            renderUpsNoData(err2.message || "Нет данных");
        });
    });
}

/**
 * Parse upsc text output into key-value object.
 * @param {string} text - Raw upsc output (key: value per line)
 * @returns {Object}
 */
function parseUpscText(text) {
    var obj = {};
    (text || "").split("\n").forEach(function(line) {
        var idx = line.indexOf(": ");
        if (idx > 0) {
            obj[line.substring(0, idx).trim()] = line.substring(idx + 2).trim();
        }
    });
    return obj;
}

/**
 * Parse ups.status flags into display properties.
 * @param {string} statusStr - UPS status string (e.g. 'OL', 'OB LB')
 * @returns {Object}
 */
function parseUpsFlags(statusStr) {
    var flags = (statusStr || "").split(" ");
    if (flags.indexOf("LB") >= 0 || flags.indexOf("OB LB") >= 0) {
        return { cls: "ups-banner-lb", icon: "🔴", label: "Критический заряд", sub: "Требуется немедленное выключение" };
    }
    if (flags.indexOf("RB") >= 0) {
        return { cls: "ups-banner-rb", icon: "🟠", label: "Замените батарею", sub: "Батарея выработала ресурс" };
    }
    if (flags.indexOf("OB") >= 0) {
        return { cls: "ups-banner-ob", icon: "🟡", label: "Работает от батареи", sub: "Питание от сети отсутствует" };
    }
    if (flags.indexOf("CHRG") >= 0) {
        return { cls: "ups-banner-ol", icon: "🔵", label: "Зарядка батареи", sub: "Питание от сети, батарея заряжается" };
    }
    if (flags.indexOf("OL") >= 0) {
        return { cls: "ups-banner-ol", icon: "🟢", label: "Питание от сети", sub: "ИБП работает в штатном режиме" };
    }
    if (statusStr === "COMMLOST") {
        return { cls: "ups-banner-off", icon: "⚫", label: "Нет связи с ИБП", sub: "Проверьте подключение кабеля USB" };
    }
    return { cls: "ups-banner-off", icon: "🔋", label: statusStr || "Нет данных", sub: "Статус неизвестен" };
}

/**
 * Render full UPS status: banner, stat cards, and variables table.
 * @param {Object} data - UPS variable key-value map from upsc
 * @returns {void}
 */
function renderUpsStatus(data) {
    // Баннер
    var status = data["ups.status"] || "";
    var s = parseUpsFlags(status);
    var banner = document.getElementById("ups-banner");
    banner.className = "ups-status-banner " + s.cls;
    document.getElementById("banner-icon").textContent = s.icon;
    document.getElementById("banner-label").textContent = s.label;
    document.getElementById("banner-sub").textContent = s.sub;

    // Карточки
    var charge = parseInt(data["battery.charge"]) || 0;
    document.getElementById("stat-charge").textContent = charge ? charge + "%" : "—";
    var chargeBar = document.getElementById("stat-charge-bar");
    chargeBar.style.width = charge + "%";
    chargeBar.className = "battery-bar " + (charge > 50 ? "bar-ok" : charge > 20 ? "bar-warn" : "bar-crit");

    document.getElementById("stat-runtime").textContent = fmtRuntime(data["battery.runtime"]);

    var load = parseInt(data["ups.load"]) || 0;
    document.getElementById("stat-load").textContent = load ? load + "%" : "—";
    document.getElementById("stat-load-bar").style.width = Math.min(load, 100) + "%";

    var volt = data["input.voltage"] || data["input.voltage.nominal"] || "";
    document.getElementById("stat-voltage").textContent = volt ? volt + " В" : "—";

    var model = [data["device.mfr"], data["device.model"]].filter(Boolean).join(" ") || data["ups.model"] || "—";
    document.getElementById("stat-model").textContent = model;

    // Таблица переменных
    renderVarsTable(data);
}

/**
 * Render empty/error state when UPS data is unavailable.
 * @param {string} msg - Error or status message to display
 * @returns {void}
 */
function renderUpsNoData(msg) {
    var banner = document.getElementById("ups-banner");
    banner.className = "ups-status-banner ups-banner-off";
    document.getElementById("banner-icon").textContent = "⚫";
    document.getElementById("banner-label").textContent = "ИБП не настроен";
    document.getElementById("banner-sub").textContent = msg;

    ["stat-charge","stat-runtime","stat-load","stat-voltage","stat-model"].forEach(function(id) {
        document.getElementById(id).textContent = "—";
    });
    document.getElementById("stat-charge-bar").style.width = "0%";
    document.getElementById("stat-load-bar").style.width = "0%";

    document.getElementById("vars-tbody").innerHTML =
        "<tr><td colspan='3' style='color:var(--color-muted);'>ИБП не подключён или NUT не настроен. Перейдите на вкладку «Конфигурация».</td></tr>";
}

// Таблица всех переменных UPS
var VAR_LABELS = {
    "ups.status":              ["Статус", ""],
    "battery.charge":          ["Заряд батареи", "%"],
    "battery.runtime":         ["Запас хода", "сек"],
    "battery.voltage":         ["Напряжение батареи", "В"],
    "battery.charge.low":      ["Порог низкого заряда", "%"],
    "ups.load":                ["Нагрузка", "%"],
    "ups.realpower.nominal":   ["Номинальная мощность", "Вт"],
    "input.voltage":           ["Входное напряжение", "В"],
    "input.voltage.nominal":   ["Номинальное напряжение", "В"],
    "input.frequency":         ["Частота", "Гц"],
    "output.voltage":          ["Выходное напряжение", "В"],
    "device.model":            ["Модель", ""],
    "device.mfr":              ["Производитель", ""],
    "device.serial":           ["Серийный номер", ""],
    "ups.firmware":            ["Прошивка", ""],
    "ups.temperature":         ["Температура", "°C"],
};

/**
 * Render the detailed UPS variables table.
 * @param {Object} data - UPS variable key-value map
 * @returns {void}
 */
function renderVarsTable(data) {
    var rows = "";
    var keys = Object.keys(data).sort();
    keys.forEach(function(k) {
        var info = VAR_LABELS[k] || [k, ""];
        var val = data[k];
        if (k === "battery.runtime") val = fmtRuntime(val) + " (" + val + " сек)";
        rows += "<tr><td style='font-family:monospace;font-size:12px;color:var(--color-muted);'>" + k +
                "</td><td><strong>" + val + "</strong>" + (info[1] ? " " + info[1] : "") + "</td>" +
                "<td style='color:var(--color-muted);font-size:12px;'>" + (VAR_LABELS[k] ? info[0] : "") + "</td></tr>";
    });
    document.getElementById("vars-tbody").innerHTML = rows || "<tr><td colspan='3'>Нет данных</td></tr>";
}

// ── Сканирование USB ──────────────────────────────────────────────────────────

/**
 * Scan for USB UPS devices using nut-scanner.
 * @param {string|null} targetInput - Input element ID to populate with detected driver
 * @returns {void}
 */
function scanUsbUps(targetInput) {
    var result = document.getElementById("scan-result");
    if (result) result.textContent = "Сканирование…";
    cockpit.spawn(["sudo", "-n", "nut-scanner", "-U"], { err: "message" })
    .done(function(out) {
        var drvM = out.match(/driver\s*=\s*(\S+)/);
        var portM = out.match(/port\s*=\s*(\S+)/);
        if (drvM) {
            if (targetInput) {
                document.getElementById(targetInput).value = drvM[1];
                document.getElementById(targetInput).removeAttribute("readonly");
            }
            var msg = "Обнаружен: " + drvM[1] + (portM ? " (" + portM[1] + ")" : "");
            if (result) result.textContent = msg;
            showAlert("success", "USB ИБП обнаружен: " + drvM[1]);
        } else {
            if (result) result.textContent = "USB ИБП не найден";
            showAlert("warning", "USB ИБП не обнаружен. Проверьте кабель.");
        }
    })
    .fail(function(err) {
        if (result) result.textContent = "Ошибка сканирования";
        showAlert("danger", "nut-scanner: " + (err.message || "ошибка"));
    });
}

// ── Загрузка и сохранение конфигурации ───────────────────────────────────────

/**
 * Load NUT configuration files and populate the config form.
 * @returns {void}
 */
function loadConfig() {
    cockpit.file(NUT_CONF).read()
    .done(function(content) {
        if (!content) return;
        var modeM = content.match(/^MODE=(\S+)/m);
        var mode = modeM ? modeM[1] : "none";
        document.getElementById("ups-enabled").checked = (mode !== "none");
        var netServer = (mode === "netserver");
        document.getElementById("net-server-enabled").checked = netServer;
        if (netServer) document.getElementById("net-server-info").classList.remove("hidden");
    });

    cockpit.file(UPS_CONF).read()
    .done(function(content) {
        if (!content) return;
        var nameM = content.match(/^\[(\w+)\]/m);
        if (nameM) { _upsName = nameM[1]; document.getElementById("ups-name").value = nameM[1]; }
        var descM = content.match(/desc\s*=\s*"?([^"\n]+)"?/);
        if (descM) document.getElementById("ups-desc").value = descM[1].trim();
        var drvM = content.match(/driver\s*=\s*(\S+)/);
        if (drvM) document.getElementById("ups-driver").value = drvM[1];

        // SNMP?
        if (drvM && drvM[1] === "snmp-ups") {
            document.getElementById("ups-conn-type").value = "snmp";
            updateConnType();
            var hostM = content.match(/host\s*=\s*(\S+)/);
            if (hostM) document.getElementById("snmp-host").value = hostM[1];
        }
        // Port = host:port — netclient?
        var portM = content.match(/port\s*=\s*(\S+)/);
        if (portM && portM[1] !== "auto") {
            // может быть netclient
        }
    });

    cockpit.file(UPSMON_CONF).read()
    .done(function(content) {
        if (!content) return;
        // Читаем пороги из upsmon.conf — POWERDOWNFLAG, DEADTIME etc
        // Пороги shutdown берём из ups.conf override
    });

    cockpit.file(UPS_CONF).read()
    .done(function(content) {
        if (!content) return;
        var chargeM = content.match(/override\.battery\.charge\.low\s*=\s*(\d+)/);
        if (chargeM) document.getElementById("shutdown-charge").value = chargeM[1];
        var runtimeM = content.match(/override\.battery\.runtime\.low\s*=\s*(\d+)/);
        if (runtimeM) {
            document.getElementById("shutdown-runtime").value = runtimeM[1];
            document.getElementById("runtime-min").textContent = Math.round(parseInt(runtimeM[1]) / 60);
        }
    });
}

/**
 * Save all NUT configuration files and restart NUT service.
 * @returns {void}
 */
function saveConfig() {
    var enabled = document.getElementById("ups-enabled").checked;
    var netServer = document.getElementById("net-server-enabled").checked;
    var mode = !enabled ? "none" : (netServer ? "netserver" : "standalone");

    var name = document.getElementById("ups-name").value.trim() || "myups";
    var desc = document.getElementById("ups-desc").value.trim();
    var connType = document.getElementById("ups-conn-type").value;
    var driver = "usbhid-ups";
    var extraConf = "";

    if (connType === "usb") {
        driver = document.getElementById("ups-driver").value.trim() || "usbhid-ups";
    } else if (connType === "snmp") {
        driver = "snmp-ups";
        var snmpHost = document.getElementById("snmp-host").value.trim();
        var snmpComm = document.getElementById("snmp-community").value.trim();
        extraConf = "  host = " + snmpHost + "\n  community = " + snmpComm + "\n";
    } else if (connType === "netclient") {
        mode = "netclient";
    }

    // Пороги shutdown
    var shutdownEnabled = document.getElementById("shutdown-enabled").checked;
    var chargeThresh = document.getElementById("shutdown-charge").value;
    var runtimeThresh = document.getElementById("shutdown-runtime").value;

    var nutConf = "MODE=" + mode + "\n";
    var upsConf = "[" + name + "]\n" +
        "  driver = " + driver + "\n" +
        "  port = auto\n";
    if (desc) upsConf += "  desc = \"" + desc + "\"\n";
    if (shutdownEnabled && connType !== "netclient") {
        upsConf += "  override.battery.charge.low = " + chargeThresh + "\n";
        upsConf += "  override.battery.runtime.low = " + runtimeThresh + "\n";
    }
    upsConf += extraConf;

    var upsdConf = "LISTEN 127.0.0.1 3493\n";
    if (netServer) upsdConf += "LISTEN 0.0.0.0 3493\n";
    upsdConf += "MAXAGE 15\nSTATEPATH /run/nut\n";

    var upsdUsers = "[upsmon]\n  password = " + NUT_PASS + "\n  upsmon primary\n";

    var monitLine = connType === "netclient"
        ? "MONITOR " + name + "@" + (document.getElementById("net-host").value || "localhost") + " 1 " +
          (document.getElementById("net-user").value || "upsmon") + " " +
          (document.getElementById("net-pass").value || NUT_PASS) + " secondary\n"
        : "MONITOR " + name + "@localhost 1 upsmon " + NUT_PASS + " primary\n";

    var upsmonConf = monitLine +
        "SHUTDOWNCMD \"/sbin/shutdown -h +0 'UPS critical'\"\n" +
        "POWERDOWNFLAG /etc/killpower\n" +
        "MINSUPPLIES 1\n" +
        "RBWARNTIME 43200\n" +
        "NOTIFYCMD /usr/local/bin/rusnas-ups-notify\n" +
        "NOTIFYFLAG ONLINE  SYSLOG+EXEC\n" +
        "NOTIFYFLAG ONBATT  SYSLOG+EXEC\n" +
        "NOTIFYFLAG LOWBATT SYSLOG+EXEC+WALL\n" +
        "NOTIFYFLAG COMMLOST SYSLOG\n" +
        "NOTIFYFLAG SHUTDOWN SYSLOG+EXEC+WALL\n" +
        "NOTIFYFLAG REPLBATT SYSLOG+EXEC\n";

    var errEl = document.getElementById("config-error");
    errEl.classList.add("hidden");

    Promise.all([
        new Promise(function(res, rej) {
            cockpit.file(NUT_CONF, {superuser:"require"}).replace(nutConf).done(res).fail(rej);
        }),
        new Promise(function(res, rej) {
            cockpit.file(UPS_CONF, {superuser:"require"}).replace(upsConf).done(res).fail(rej);
        }),
        new Promise(function(res, rej) {
            cockpit.file(UPSD_CONF, {superuser:"require"}).replace(upsdConf).done(res).fail(rej);
        }),
        new Promise(function(res, rej) {
            cockpit.file(UPSD_USERS, {superuser:"require"}).replace(upsdUsers).done(res).fail(rej);
        }),
        new Promise(function(res, rej) {
            cockpit.file(UPSMON_CONF, {superuser:"require"}).replace(upsmonConf).done(res).fail(rej);
        })
    ]).then(function() {
        showMsg("config-saved-msg");
        _upsName = name;
        restartNut();
    }).catch(function(err) {
        errEl.textContent = "Ошибка сохранения: " + (err.message || String(err));
        errEl.classList.remove("hidden");
    });
}

/**
 * Save battery protection thresholds to ups.conf override directives.
 * @returns {void}
 */
function saveProtection() {
    cockpit.file(UPS_CONF).read()
    .done(function(content) {
        content = content || "";
        var chargeThresh = document.getElementById("shutdown-charge").value;
        var runtimeThresh = document.getElementById("shutdown-runtime").value;

        // Удаляем старые override строки
        content = content.replace(/\s*override\.battery\.charge\.low\s*=.*\n?/g, "");
        content = content.replace(/\s*override\.battery\.runtime\.low\s*=.*\n?/g, "");

        if (document.getElementById("shutdown-enabled").checked) {
            // Добавляем перед концом секции (перед следующей секцией или в конец)
            content = content.trimEnd() + "\n  override.battery.charge.low = " + chargeThresh + "\n" +
                      "  override.battery.runtime.low = " + runtimeThresh + "\n";
        }

        cockpit.file(UPS_CONF, {superuser:"require"}).replace(content)
        .done(function() {
            showMsg("prot-saved-msg");
            restartNut();
        })
        .fail(function(err) {
            showAlert("danger", "Ошибка: " + (err.message || String(err)));
        });
    });
}

/**
 * Restart NUT service (tries nut.target, falls back to nut-server).
 * @returns {void}
 */
function restartNut() {
    cockpit.spawn(["sudo", "-n", "systemctl", "restart", "nut.target"],
        { err: "message" })
    .done(function() {
        showAlert("success", "NUT перезапущен");
        setTimeout(loadUpsStatus, 2000);
    })
    .fail(function(err) {
        // Пробуем nut-server отдельно (если nut.target не существует)
        cockpit.spawn(["sudo", "-n", "systemctl", "restart", "nut-server"],
            { err: "message" })
        .done(function() {
            showAlert("success", "nut-server перезапущен");
            setTimeout(loadUpsStatus, 2000);
        })
        .fail(function(err2) {
            showAlert("warning", "Restart: " + (err2.message || err.message || "ошибка"));
        });
    });
}

// ── Журнал событий ────────────────────────────────────────────────────────────

/**
 * Load UPS event history from journalctl/syslog.
 * @returns {void}
 */
function loadEvents() {
    // Читаем из journalctl — логи upsmon
    cockpit.spawn(
        ["sudo", "-n", "journalctl", "-u", "nut-monitor", "--no-pager", "-n", "50",
         "--output=short-iso", "--no-hostname"],
        { err: "message" }
    )
    .done(function(out) {
        renderEvents(out);
    })
    .fail(function() {
        // Fallback — syslog
        cockpit.spawn(["sudo", "-n", "grep", "-i", "upsd\\|upsmon\\|ups", "/var/log/syslog"],
            { err: "message" })
        .done(function(out) { renderEvents(out); })
        .fail(function() {
            document.getElementById("events-tbody").innerHTML =
                "<tr><td colspan='3' style='color:var(--color-muted);'>Нет данных о событиях. Настройте NUT и подключите ИБП.</td></tr>";
        });
    });
}

var EVENT_KEYWORDS = {
    "ONLINE":   { cls: "ev-online",   label: "ONLINE",   desc: "Питание восстановлено" },
    "ONBATT":   { cls: "ev-onbatt",   label: "ONBATT",   desc: "Переход на батарею" },
    "LOWBATT":  { cls: "ev-lowbatt",  label: "LOWBATT",  desc: "Критически низкий заряд" },
    "REPLBATT": { cls: "ev-replbatt", label: "REPLBATT", desc: "Требуется замена батареи" },
    "SHUTDOWN": { cls: "ev-shutdown", label: "SHUTDOWN", desc: "Инициировано выключение" },
    "COMMLOST": { cls: "ev-commlost", label: "COMMLOST", desc: "Потеряна связь с ИБП" },
    "COMMOK":   { cls: "ev-online",   label: "COMMOK",   desc: "Связь с ИБП восстановлена" },
};

/**
 * Render UPS events table from raw log output.
 * @param {string} rawLog - Raw log lines from journalctl/syslog
 * @returns {void}
 */
function renderEvents(rawLog) {
    var lines = rawLog.split("\n").filter(Boolean).reverse();
    var rows = "";
    lines.forEach(function(line) {
        var evType = null;
        Object.keys(EVENT_KEYWORDS).forEach(function(k) {
            if (line.indexOf(k) >= 0) evType = k;
        });
        var ev = evType ? EVENT_KEYWORDS[evType] : null;
        // Извлекаем время
        var timeM = line.match(/^(\S+\s+\S+)/);
        var time = timeM ? timeM[1] : "";
        var evClass = ev ? ev.cls : "";
        var evLabel = ev ? ev.label : "INFO";
        var desc = ev ? ev.desc : line.substring(Math.min(line.length, 40));
        if (desc.length > 80) desc = desc.substring(0, 80) + "…";
        rows += "<tr><td style='font-size:12px;color:var(--color-muted);white-space:nowrap;'>" + time + "</td>" +
                "<td class='" + evClass + "'>" + evLabel + "</td>" +
                "<td style='font-size:13px;'>" + desc + "</td></tr>";
    });
    document.getElementById("events-tbody").innerHTML = rows ||
        "<tr><td colspan='3' style='color:var(--color-muted);'>Событий UPS не найдено</td></tr>";
}

// ── Тип подключения ───────────────────────────────────────────────────────────

/**
 * Toggle connection type fields visibility (USB/SNMP/NetClient).
 * @returns {void}
 */
function updateConnType() {
    var t = document.getElementById("ups-conn-type").value;
    document.getElementById("conn-usb").classList.toggle("hidden", t !== "usb");
    document.getElementById("conn-snmp").classList.toggle("hidden", t !== "snmp");
    document.getElementById("conn-netclient").classList.toggle("hidden", t !== "netclient");
}

// ── Сетевой сервер ────────────────────────────────────────────────────────────

/**
 * Toggle network server info panel and display server address.
 * @returns {void}
 */
function updateNetServer() {
    var en = document.getElementById("net-server-enabled").checked;
    document.getElementById("net-server-info").classList.toggle("hidden", !en);
    if (en) {
        // Показываем IP
        cockpit.spawn(["hostname", "-I"], { err: "message" })
        .done(function(out) {
            var ip = out.trim().split(" ")[0];
            document.getElementById("net-server-addr").textContent =
                "upsc " + _upsName + "@" + ip + ":3493";
        });
    }
}

// ── Полинг ────────────────────────────────────────────────────────────────────

/**
 * Start periodic UPS status polling every 15 seconds.
 * @returns {void}
 */
function startPolling() {
    loadUpsStatus();
    if (_statusTimer) clearInterval(_statusTimer);
    _statusTimer = setInterval(loadUpsStatus, 15000);  // was 5s — UPS status changes slowly, 15s is sufficient
}

/**
 * Load all UPS data: config, status, and events.
 * @returns {void}
 */
function loadAll() {
    loadConfig();
    loadUpsStatus();
    loadEvents();
}

// ── Runtime display ───────────────────────────────────────────────────────────

/**
 * Update the runtime threshold display (convert seconds to minutes).
 * @returns {void}
 */
function updateRuntimeDisplay() {
    var secs = parseInt(document.getElementById("shutdown-runtime").value) || 0;
    document.getElementById("runtime-min").textContent = Math.round(secs / 60);
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {
    // Вкладки
    document.querySelectorAll(".tab-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("tab-active"); });
            document.querySelectorAll(".tab-panel").forEach(function(p) { p.classList.add("hidden"); });
            btn.classList.add("tab-active");
            document.getElementById(btn.dataset.tab).classList.remove("hidden");
            if (btn.dataset.tab === "tab-events") loadEvents();
        });
    });

    document.getElementById("btn-install-nut").addEventListener("click", installNut);
    document.getElementById("btn-refresh-status").addEventListener("click", loadUpsStatus);
    document.getElementById("btn-scan-usb").addEventListener("click", function() { scanUsbUps(null); });
    document.getElementById("btn-scan-usb2").addEventListener("click", function() { scanUsbUps("ups-driver"); });
    document.getElementById("btn-save-config").addEventListener("click", saveConfig);
    document.getElementById("btn-restart-nut").addEventListener("click", restartNut);
    document.getElementById("btn-save-protection").addEventListener("click", saveProtection);
    document.getElementById("btn-refresh-events").addEventListener("click", loadEvents);
    document.getElementById("btn-save-notif").addEventListener("click", function() { showMsg("notif-saved-msg"); });

    document.getElementById("ups-conn-type").addEventListener("change", updateConnType);
    document.getElementById("net-server-enabled").addEventListener("change", updateNetServer);
    document.getElementById("shutdown-runtime").addEventListener("input", updateRuntimeDisplay);
    document.getElementById("shutdown-enabled").addEventListener("change", function() {
        document.getElementById("shutdown-settings").style.opacity = this.checked ? "1" : ".5";
    });

    checkNutInstalled();
});
