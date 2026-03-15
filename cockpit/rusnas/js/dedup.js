"use strict";

var DEDUP_LAST    = "/var/lib/rusnas/dedup-last.json";
var DEDUP_HISTORY = "/var/lib/rusnas/dedup-history.json";
var DEDUP_CONFIG  = "/etc/rusnas/dedup-config.json";
var DEDUP_LOG     = "/var/log/rusnas/dedup.log";
var CRON_FILE     = "/etc/cron.d/rusnas-dedup";

var _lastData    = null;
var _historyData = [];
var _config      = {};
var _pollTimer   = null;

// ── Утилиты ──────────────────────────────────────────────────────────────────

function fmtBytes(b) {
    b = parseInt(b) || 0;
    if (b === 0) return "0 Б";
    var units = ["Б","КБ","МБ","ГБ","ТБ"];
    var i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(1) + " " + units[Math.min(i,4)];
}

function fmtNum(n) {
    return (parseInt(n)||0).toLocaleString("ru");
}

function fmtTs(ts) {
    if (!ts) return "—";
    var d = new Date(ts * 1000);
    return d.toLocaleString("ru", {day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit"});
}

function safeJson(str) {
    try { return JSON.parse(str.trim()); } catch(e) { return null; }
}

function showMsg(id, ms) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("hidden");
    setTimeout(function() { el.classList.add("hidden"); }, ms || 3000);
}

// ── Вкладки ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {
    document.querySelectorAll(".tab-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var target = btn.dataset.tab;
            document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("tab-active"); });
            document.querySelectorAll(".tab-panel").forEach(function(p) { p.classList.add("hidden"); });
            btn.classList.add("tab-active");
            document.getElementById(target).classList.remove("hidden");
        });
    });

    document.getElementById("btn-run").addEventListener("click", runDedup);
    document.getElementById("btn-stop").addEventListener("click", stopDedup);
    document.getElementById("btn-log").addEventListener("click", showLog);
    document.getElementById("btn-close-log").addEventListener("click", function() {
        document.getElementById("log-modal").classList.remove("open");
    });
    document.getElementById("stat-error-hint").addEventListener("click", function() {
        document.getElementById("error-detail").classList.toggle("hidden");
    });
    document.getElementById("btn-save-schedule").addEventListener("click", saveSchedule);
    document.getElementById("btn-save-volumes").addEventListener("click", saveVolumeConfig);
    document.getElementById("btn-save-samba").addEventListener("click", saveSambaConfig);
    document.getElementById("btn-save-advanced").addEventListener("click", saveAdvancedConfig);
    document.getElementById("smb-all").addEventListener("change", function() {
        document.querySelectorAll(".smb-vfs-cb").forEach(function(cb) { cb.checked = this.checked; }, this);
    });
    document.getElementById("sched-enabled").addEventListener("change", function() {
        var dis = !this.checked;
        document.getElementById("sched-time").disabled = dis;
        document.querySelectorAll(".day-cb").forEach(function(cb) { cb.disabled = dis; });
    });

    buildSchedTimeSelect();
    buildSchedDays();
    loadAll();
});

// ── Загрузка данных ───────────────────────────────────────────────────────────

function loadAll() {
    loadLastRun();
    loadHistory();
    loadConfig();
    loadVolumes();
    loadSambaShares();
    checkRunning();
}

function loadLastRun() {
    cockpit.spawn(["cat", DEDUP_LAST], {superuser: "try", err: "message"})
    .done(function(out) {
        _lastData = safeJson(out);
        renderStatusCards();
    })
    .fail(function() {
        _lastData = null;
        renderStatusCards();
    });
}

function loadHistory() {
    cockpit.spawn(["cat", DEDUP_HISTORY], {superuser: "try", err: "message"})
    .done(function(out) {
        _historyData = safeJson(out) || [];
        renderHistoryChart();
        renderBigStats();
    })
    .fail(function() {
        _historyData = [];
        renderHistoryChart();
        renderBigStats();
    });
}

function loadConfig() {
    cockpit.spawn(["cat", DEDUP_CONFIG], {err: "message"})
    .done(function(out) {
        _config = safeJson(out) || {};
        populateSettings();
    })
    .fail(function() {
        _config = {};
        populateSettings();
    });
}

function loadVolumes() {
    cockpit.spawn(["findmnt", "-t", "btrfs", "-o", "TARGET,SOURCE", "--real", "-n"], {err: "message"})
    .done(function(out) {
        renderVolumeTable(out);
    })
    .fail(function() {
        document.getElementById("volumes-tbody").innerHTML =
            '<tr><td colspan="3" style="color:var(--color-muted);">Btrfs-тома не найдены</td></tr>';
    });
}

function loadSambaShares() {
    // configparser не работает с smb.conf (нестандартный формат) — пишем скрипт во tmpfile
    var py = [
        "import re",
        "content = open('/etc/samba/smb.conf').read()",
        "sections = re.split(r'\\n(?=\\[)', content)",
        "skip = ('global','homes','printers','print$')",
        "for s in sections:",
        "    m = re.match(r'\\[([^\\]]+)\\]', s)",
        "    if not m: continue",
        "    name = m.group(1).strip()",
        "    if name.lower() in skip: continue",
        "    pm = re.search(r'^\\s*path\\s*=\\s*(.+)', s, re.MULTILINE)",
        "    vm = re.search(r'^\\s*vfs objects\\s*=\\s*(.+)', s, re.MULTILINE)",
        "    path = pm.group(1).strip() if pm else ''",
        "    has_btrfs = 'btrfs' in (vm.group(1).lower() if vm else '')",
        "    print(name + '|' + path + '|' + str(has_btrfs))"
    ].join("\n");  // реальные переносы строк в JS-строке

    cockpit.file("/tmp/rusnas_parse_smb.py").replace(py)
    .done(function() {
        cockpit.spawn(["python3", "/tmp/rusnas_parse_smb.py"], {err: "message"})
        .done(function(out) { renderSambaTable(out); })
        .fail(function() {
            document.getElementById("samba-tbody").innerHTML =
                '<tr><td colspan="3" style="color:var(--color-muted);">SMB-шары не найдены</td></tr>';
        });
    })
    .fail(function() {
        document.getElementById("samba-tbody").innerHTML =
            '<tr><td colspan="3" style="color:var(--color-muted);">Ошибка чтения smb.conf</td></tr>';
    });
}

// ── Рендер статус-карточек ────────────────────────────────────────────────────

function renderStatusCards() {
    var d = _lastData;
    if (!d) {
        document.getElementById("stat-last-run").textContent = "—";
        document.getElementById("stat-saved").textContent    = "—";
        document.getElementById("stat-files").textContent    = "—";
        var el = document.getElementById("stat-status");
        el.textContent = "Не настроен";
        el.className   = "sv status-none";
        return;
    }
    document.getElementById("stat-last-run").textContent = fmtTs(d.last_run_ts);
    document.getElementById("stat-saved").textContent    = fmtBytes(d.saved_bytes);
    document.getElementById("stat-files").textContent    = fmtNum(d.files_scanned);

    var el = document.getElementById("stat-status");
    if (d.status === "success") {
        el.textContent = "Выполнен";
        el.className   = "sv status-ok";
    } else if (d.status === "running") {
        el.textContent = "Выполняется";
        el.className   = "sv status-run pulsing";
    } else if (d.status === "error") {
        el.textContent = "Ошибка";
        el.className   = "sv status-err";
        document.getElementById("stat-error-hint").classList.remove("hidden");
        var errEl = document.getElementById("error-detail");
        errEl.textContent = d.error_msg || "(нет деталей)";
    } else {
        el.textContent = "—";
        el.className   = "sv status-none";
    }

    // Big stats (также обновляем)
    document.getElementById("big-saved").textContent = fmtBytes(d.saved_bytes);
    document.getElementById("big-files").textContent = fmtNum(d.files_scanned);
}

// ── Инфографика временной шкалы ───────────────────────────────────────────────

function renderTimeline() {
    var svg = document.getElementById("timeline-chart");
    if (!svg) return;

    var W = 660, H = 80, PX = 10, PY = 40;
    var lineY = PY;
    var hours = 24;
    var stepPx = (W - PX*2) / hours;

    var out = [];
    // Основная линия
    out.push('<line x1="' + PX + '" y1="' + lineY + '" x2="' + (W-PX) + '" y2="' + lineY + '" stroke="var(--color-border)" stroke-width="2"/>');

    // Деления каждые 3 часа
    for (var h = 0; h <= 24; h += 3) {
        var x = PX + h * stepPx;
        out.push('<line x1="' + x + '" y1="' + (lineY-5) + '" x2="' + x + '" y2="' + (lineY+5) + '" stroke="var(--color-border)" stroke-width="1.5"/>');
        out.push('<text x="' + x + '" y="' + (lineY+18) + '" text-anchor="middle" font-size="10" fill="var(--color-muted)">' + h + ':00</text>');
    }

    var cronH = 3; // default
    var schedCron = (_config.schedule_cron || "0 3 * * 1-5").split(" ");
    if (schedCron.length >= 2) {
        var ch = parseInt(schedCron[1]);
        if (!isNaN(ch)) cronH = ch;
    }

    if (_lastData && _lastData.last_run_ts) {
        var startSec = _lastData.last_run_ts - (_lastData.duration_sec || 0);
        var endSec   = _lastData.last_run_ts;
        var startH   = (new Date(startSec * 1000)).getHours() + (new Date(startSec * 1000)).getMinutes()/60;
        var endH     = (new Date(endSec   * 1000)).getHours() + (new Date(endSec   * 1000)).getMinutes()/60;
        var x1 = PX + startH * stepPx;
        var x2 = PX + endH   * stepPx;
        var minBarW = 4;
        if (x2 - x1 < minBarW) x2 = x1 + minBarW;

        // Прогресс-бар
        out.push('<rect x="' + x1 + '" y="' + (lineY-8) + '" width="' + (x2-x1) + '" height="16" rx="3" fill="#0891b2" opacity=".3"/>');

        // Если метки слишком близко (менее 60px) — показываем одну объединённую метку по центру
        var dur = _lastData.duration_sec || 0;
        var durStr = dur < 60 ? dur + "с" : Math.round(dur/60) + "м";
        if (x2 - x1 < 60) {
            var cx = (x1 + x2) / 2;
            out.push('<line x1="' + cx + '" y1="' + (lineY-18) + '" x2="' + cx + '" y2="' + (lineY-8) + '" stroke="#0891b2" stroke-width="1.5"/>');
            out.push('<text x="' + cx + '" y="' + (lineY-22) + '" text-anchor="middle" font-size="9" fill="#0891b2">Выполнен (' + durStr + ')</text>');
        } else {
            out.push('<line x1="' + x1 + '" y1="' + (lineY-18) + '" x2="' + x1 + '" y2="' + (lineY-8) + '" stroke="#0891b2" stroke-width="1.5"/>');
            out.push('<text x="' + x1 + '" y="' + (lineY-22) + '" text-anchor="middle" font-size="9" fill="#0891b2">Старт</text>');
            out.push('<line x1="' + x2 + '" y1="' + (lineY-18) + '" x2="' + x2 + '" y2="' + (lineY-8) + '" stroke="#0891b2" stroke-width="1.5"/>');
            out.push('<text x="' + x2 + '" y="' + (lineY-22) + '" text-anchor="middle" font-size="9" fill="#0891b2">Завершён (' + durStr + ')</text>');
        }
    } else {
        // Показать плановое время запуска
        var px0 = PX + cronH * stepPx;
        out.push('<circle cx="' + px0 + '" cy="' + lineY + '" r="5" fill="#0891b2" opacity=".4"/>');
        out.push('<text x="' + px0 + '" y="' + (lineY-14) + '" text-anchor="middle" font-size="9" fill="#0891b2">Плановый запуск</text>');
        out.push('<text x="' + (W/2) + '" y="' + (lineY+36) + '" text-anchor="middle" font-size="11" fill="var(--color-muted)">Нет данных о прогонах</text>');
    }

    svg.innerHTML = out.join("");
}

// ── История: bar chart ────────────────────────────────────────────────────────

function renderHistoryChart() {
    var svg = document.getElementById("history-chart");
    if (!svg) return;
    var data = _historyData;
    if (!data || !data.length) {
        svg.innerHTML = '<text x="340" y="60" text-anchor="middle" font-size="13" fill="var(--color-muted)">Нет данных об истории прогонов</text>';
        return;
    }

    var W = 660, H = 90, PAD = 20, BAR_GAP = 6;
    var LABEL_TOP = 16; // зарезервировано сверху для value label
    var LABEL_BOT = 20; // зарезервировано снизу для date label
    var n   = data.length;
    var barW = Math.min(80, (W - PAD*2 - BAR_GAP*(n-1)) / n);
    var totalW = n * barW + (n-1) * BAR_GAP;
    var startX = (W - totalW) / 2;
    var maxB = Math.max.apply(null, data.map(function(e){ return e.saved_bytes||0; }));
    if (maxB === 0) maxB = 1;

    var out = [];
    for (var i = 0; i < n; i++) {
        var e = data[n-1-i]; // oldest left
        var availH = H - LABEL_TOP - LABEL_BOT;
        var bh  = Math.max(4, ((e.saved_bytes||0) / maxB) * availH);
        var x   = startX + i*(barW + BAR_GAP);
        var y   = H - bh - LABEL_BOT;
        out.push('<rect class="history-chart-bar" x="' + x + '" y="' + y + '" width="' + barW + '" height="' + bh + '" rx="3" fill="var(--primary)" opacity=".65"/>');
        out.push('<title>' + (e.date||"") + '\n' + fmtBytes(e.saved_bytes) + '</title>');
        // Date label (bottom)
        var dateLabel = (e.date||"").replace(/^\d{4}-/, "");
        out.push('<text x="' + (x + barW/2) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="10" fill="var(--color-muted)">' + dateLabel + '</text>');
        // Value label (above bar, guaranteed not clipped)
        out.push('<text x="' + (x + barW/2) + '" y="' + (y - 3) + '" text-anchor="middle" font-size="10" fill="var(--color-muted)">' + fmtBytes(e.saved_bytes) + '</text>');
    }
    svg.innerHTML = out.join("");
}

function renderBigStats() {
    if (_lastData) {
        document.getElementById("big-saved").textContent = fmtBytes(_lastData.saved_bytes);
        document.getElementById("big-files").textContent = fmtNum(_lastData.files_scanned);
    }
}

// ── Тома ──────────────────────────────────────────────────────────────────────

function renderVolumeTable(raw) {
    var tbody = document.getElementById("volumes-tbody");
    var rows = (raw||"").trim().split("\n").filter(Boolean);
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:var(--color-muted);">Btrfs-тома не найдены</td></tr>';
        return;
    }
    var enabledVols = (_config.volumes || []);
    tbody.innerHTML = rows.map(function(line) {
        var p = line.trim().split(/\s+/);
        var target = p[0] || "";
        var source = p[1] || "";
        var checked = enabledVols.indexOf(target) >= 0 ? "checked" : "";
        return '<tr>' +
            '<td style="font-family:monospace;font-size:13px;">' + target + '</td>' +
            '<td style="font-family:monospace;font-size:13px;color:var(--color-muted);">' + source + '</td>' +
            '<td><input type="checkbox" class="vol-cb" data-path="' + target + '" ' + checked + '></td>' +
            '</tr>';
    }).join("");
}

// ── SMB шары ──────────────────────────────────────────────────────────────────

function renderSambaTable(raw) {
    var tbody = document.getElementById("samba-tbody");
    var rows = (raw||"").trim().split("\n").filter(Boolean);
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:var(--color-muted);">SMB-шары не найдены</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(function(line) {
        var p = line.split("|");
        var name    = p[0] || "";
        var path    = p[1] || "";
        var hasBtrfs = (p[2]||"").trim().toLowerCase() === "true";
        var checked = hasBtrfs ? "checked" : "";
        return '<tr>' +
            '<td>' + name + '</td>' +
            '<td style="font-family:monospace;font-size:13px;color:var(--color-muted);">' + path + '</td>' +
            '<td><input type="checkbox" class="smb-vfs-cb" data-share="' + name + '" ' + checked + '></td>' +
            '</tr>';
    }).join("");
}

// ── Настройки: populate ───────────────────────────────────────────────────────

function populateSettings() {
    // Расписание
    var schedEnabled = !!_config.schedule_enabled;
    document.getElementById("sched-enabled").checked = schedEnabled;
    document.getElementById("sched-time").disabled = !schedEnabled;

    var cron = (_config.schedule_cron || "0 3 * * 1-5").split(" ");
    // "M H * * days"
    var schedH = parseInt(cron[1]) || 3;
    var schedM = parseInt(cron[0]) || 0;
    var timeVal = (schedH < 10 ? "0" : "") + schedH + ":" + (schedM < 10 ? "0" : "") + schedM;
    var timeEl = document.getElementById("sched-time");
    if (timeEl) timeEl.value = timeVal;

    // Дни
    var daysStr = cron[4] || "1-5";
    var activeDays = parseCronDays(daysStr);
    document.querySelectorAll(".day-cb").forEach(function(cb) {
        cb.checked = activeDays.indexOf(parseInt(cb.dataset.day)) >= 0;
        cb.disabled = !schedEnabled;
    });

    // Advanced
    var args = _config.duperemove_args || "--dedupe-options=block";

    var useDb = args.indexOf("-h ") >= 0 || args.indexOf("-h\t") >= 0;
    document.getElementById("use-hashdb").checked = useDb;

    var dbMatch = args.match(/-h\s+(\S+)/);
    if (dbMatch) document.getElementById("hashdb-path").value = dbMatch[1];

    // extra args: убрать известные флаги
    var extra = args
        .replace(/-h\s+\S+/, "")
        .replace(/--dedupe-options=\w+/, "")
        .trim();
    document.getElementById("extra-args").value = extra;

    renderTimeline();
}

function parseCronDays(s) {
    if (s === "*") return [0,1,2,3,4,5,6];
    var result = [];
    s.split(",").forEach(function(part) {
        if (part.indexOf("-") >= 0) {
            var r = part.split("-");
            for (var i = parseInt(r[0]); i <= parseInt(r[1]); i++) result.push(i);
        } else {
            result.push(parseInt(part));
        }
    });
    return result;
}

// ── Расписание: select времени и дни ─────────────────────────────────────────

function buildSchedTimeSelect() {
    var sel = document.getElementById("sched-time");
    for (var h = 0; h <= 6; h++) {
        for (var m = 0; m < 60; m += 30) {
            var opt = document.createElement("option");
            var hh = (h < 10 ? "0" : "") + h;
            var mm = (m < 10 ? "0" : "") + m;
            opt.value = hh + ":" + mm;
            opt.textContent = hh + ":" + mm;
            sel.appendChild(opt);
        }
    }
}

function buildSchedDays() {
    var days = [
        {n:1, l:"Пн"}, {n:2, l:"Вт"}, {n:3, l:"Ср"},
        {n:4, l:"Чт"}, {n:5, l:"Пт"}, {n:6, l:"Сб"}, {n:0, l:"Вс"}
    ];
    var cont = document.getElementById("sched-days");
    days.forEach(function(d) {
        var lbl = document.createElement("label");
        lbl.style.cssText = "display:flex;align-items:center;gap:4px;font-size:13px;cursor:pointer;";
        lbl.innerHTML = '<input type="checkbox" class="day-cb" data-day="' + d.n + '"> ' + d.l;
        cont.appendChild(lbl);
    });
}

// ── Сохранение расписания ─────────────────────────────────────────────────────

function saveSchedule() {
    var enabled = document.getElementById("sched-enabled").checked;
    var timeVal = document.getElementById("sched-time").value || "03:00";
    var parts   = timeVal.split(":");
    var h = parseInt(parts[0]) || 3;
    var m = parseInt(parts[1]) || 0;

    var activeDays = [];
    document.querySelectorAll(".day-cb:checked").forEach(function(cb) {
        activeDays.push(parseInt(cb.dataset.day));
    });
    if (!activeDays.length) activeDays = [1,2,3,4,5];
    activeDays.sort();

    // Компактный cron days string
    var daysStr = activeDays.join(",");

    var cronExpr = m + " " + h + " * * " + daysStr;
    _config.schedule_enabled = enabled;
    _config.schedule_cron    = cronExpr;

    var cronContent = "";
    if (enabled) {
        cronContent = "# rusNAS deduplication schedule — managed by Cockpit plugin, do not edit manually\n" +
            cronExpr + " root /usr/local/bin/rusnas-dedup-run.sh >> /var/log/rusnas/dedup.log 2>&1\n";
    }

    // Сохранить конфиг, затем cron
    cockpit.file(DEDUP_CONFIG, {superuser: "require"}).replace(JSON.stringify(_config, null, 2))
    .done(function() {
        if (enabled) {
            cockpit.file(CRON_FILE, {superuser: "require"}).replace(cronContent)
            .done(function() { showMsg("sched-saved-msg"); })
            .fail(function(e) { alert("Ошибка записи cron: " + e); });
        } else {
            cockpit.spawn(["rm", "-f", CRON_FILE], {superuser: "require", err: "message"})
            .always(function() { showMsg("sched-saved-msg"); });
        }
    })
    .fail(function(e) { alert("Ошибка сохранения конфига: " + e); });
}

// ── Сохранение томов ──────────────────────────────────────────────────────────

function saveVolumeConfig() {
    var vols = [];
    document.querySelectorAll(".vol-cb:checked").forEach(function(cb) {
        vols.push(cb.dataset.path);
    });
    _config.volumes = vols;
    writeConfig(function() { showMsg("vol-saved-msg"); });
}

// ── Сохранение SMB ────────────────────────────────────────────────────────────

function saveSambaConfig() {
    var toEnable  = [];
    var toDisable = [];
    document.querySelectorAll(".smb-vfs-cb").forEach(function(cb) {
        if (cb.checked) toEnable.push(cb.dataset.share);
        else            toDisable.push(cb.dataset.share);
    });

    var cmds = [];
    toEnable.forEach(function(share) {
        cmds.push("sed -i '/^\\[" + share + "\\]/,/^\\[/{/vfs objects/d}' /etc/samba/smb.conf");
        cmds.push("sed -i '/^\\[" + share + "\\]/a\\   vfs objects = btrfs' /etc/samba/smb.conf");
    });
    toDisable.forEach(function(share) {
        cmds.push("sed -i '/^\\[" + share + "\\]/,/^\\[/{/vfs objects = btrfs/d}' /etc/samba/smb.conf");
    });
    cmds.push("systemctl reload smbd 2>/dev/null; true");

    if (!cmds.length) { showMsg("smb-saved-msg"); return; }

    cockpit.spawn(["bash", "-c", cmds.join(" && ")], {superuser: "require", err: "message"})
    .done(function() { showMsg("smb-saved-msg"); loadSambaShares(); })
    .fail(function(e) { alert("Ошибка изменения smb.conf: " + e); });
}

// ── Расширенные параметры ─────────────────────────────────────────────────────

function saveAdvancedConfig() {
    var useDb  = document.getElementById("use-hashdb").checked;
    var dbPath = document.getElementById("hashdb-path").value.trim() || "/var/lib/rusnas/dedup.db";
    var extra  = document.getElementById("extra-args").value.trim();

    var args = "--dedupe-options=block";
    if (useDb) args += " -h " + dbPath;
    if (extra) args += " " + extra;

    _config.duperemove_args = args;
    writeConfig(function() { showMsg("adv-saved-msg"); });
}

// ── Запись конфига ────────────────────────────────────────────────────────────

function writeConfig(cb) {
    var configStr = JSON.stringify(_config, null, 2);
    cockpit.spawn(["mkdir", "-p", "/etc/rusnas"], {superuser: "require", err: "message"})
    .always(function() {
        cockpit.file(DEDUP_CONFIG, {superuser: "require"}).replace(configStr)
        .done(function() { if (cb) cb(); })
        .fail(function(e) { alert("Ошибка записи конфига: " + e); });
    });
}

// ── Запуск / Остановка ────────────────────────────────────────────────────────

function runDedup() {
    document.getElementById("btn-run").disabled = true;
    document.getElementById("run-spinner").classList.remove("hidden");

    cockpit.spawn(["systemctl", "start", "rusnas-dedup.service"], {superuser: "require", err: "message"})
    .done(function() {
        setRunningState(true);
        startPolling();
    })
    .fail(function(e) {
        document.getElementById("btn-run").disabled = false;
        document.getElementById("run-spinner").classList.add("hidden");
        alert("Не удалось запустить: " + e);
    });
}

function stopDedup() {
    cockpit.spawn(["systemctl", "stop", "rusnas-dedup.service"], {superuser: "require", err: "message"})
    .done(function() {
        setRunningState(false);
        stopPolling();
        loadLastRun();
    });
}

function checkRunning() {
    cockpit.spawn(["systemctl", "is-active", "rusnas-dedup.service"], {err: "message"})
    .done(function(out) {
        var active = out.trim() === "active" || out.trim() === "activating";
        setRunningState(active);
        if (active) startPolling();
    })
    .fail(function() { setRunningState(false); });
}

function setRunningState(running) {
    document.getElementById("btn-run").disabled = running;
    document.getElementById("btn-stop").disabled = !running;
    document.getElementById("run-spinner").classList.toggle("hidden", !running);

    var statEl = document.getElementById("stat-status");
    if (running) {
        statEl.textContent = "Выполняется";
        statEl.className   = "sv status-run pulsing";
    } else if (statEl.textContent === "Выполняется") {
        statEl.textContent = "—";
        statEl.className   = "sv";
    }
}

function startPolling() {
    stopPolling();
    _pollTimer = setInterval(function() {
        cockpit.spawn(["systemctl", "is-active", "rusnas-dedup.service"], {err: "message"})
        .done(function(out) {
            var active = out.trim() === "active" || out.trim() === "activating";
            if (!active) {
                setRunningState(false);
                stopPolling();
                setTimeout(function() { loadLastRun(); loadHistory(); }, 800);
            }
        })
        .fail(function() { stopPolling(); setRunningState(false); });
    }, 5000);
}

function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ── Лог ───────────────────────────────────────────────────────────────────────

function showLog() {
    var modal = document.getElementById("log-modal");
    modal.classList.add("open");
    document.getElementById("log-content").textContent = "Загрузка…";

    cockpit.spawn(["bash", "-c", "tail -200 " + DEDUP_LOG + " 2>/dev/null || echo '(лог пуст)'"], {superuser: "require", err: "message"})
    .done(function(out) {
        document.getElementById("log-content").textContent = out || "(лог пуст)";
    })
    .fail(function() {
        document.getElementById("log-content").textContent = "(лог недоступен)";
    });
}
