// ─── Disks & RAID ─────────────────────────────────────────────────────────────

function _escHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

var diskRefreshTimer  = null;
var physicalDiskCount = 0;   // non-system disks, set in renderDisks
var currentArrays     = [];  // last parsed mdstat, used by RAID advisor
var currentDisks      = [];  // free disks cache, populated in renderDisks
var currentMountMap   = {};  // md device name → {target, fstype}
var currentSsdTiers   = [];  // SSD-tier entries from ssd-tiers.json
var ssdTierTimer      = null;

// ─── Backup Mode (spindown) ────────────────────────────────────────────────
var spindownState     = {};   // cache: array_name → state object
var spindownPollTimer = null;
var SPINDOWN_CGI      = "/usr/lib/rusnas/cgi/spindown_ctl.py";
var _SPINDOWN_POLL_NORMAL = 15000;  // 15s normal polling
var _SPINDOWN_POLL_FAST   = 3000;   // 3s polling during flushing/waking

function showModal(id)  { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

// ─── Alert banner ─────────────────────────────────────────────────────────────

function updateAlertBanner(arrays) {
    var banner = document.getElementById("raid-alert-banner");
    var alerts = [];

    arrays.forEach(function(arr) {
        if (arr.inactive) {
            alerts.push({
                level: "danger",
                msg: "Массив <b>" + arr.name + "</b> не запущен — данные недоступны. " +
                     "<a href='#' onclick='runArray(\"" + arr.name + "\"); return false;'>Запустить массив</a>"
            });
        } else if (arr.degraded) {
            var missing = arr.total - arr.active;
            alerts.push({
                level: "warning",
                msg: "Массив <b>" + arr.name + "</b> работает в аварийном режиме — " +
                     "отсутствует " + missing + " диск(ов). " +
                     "Данные доступны, но защита от сбоев отключена. " +
                     "Вставьте новый диск и нажмите «Добавить диск»."
            });
        } else if (arr.resyncing) {
            alerts.push({
                level: "info",
                msg: "Массив <b>" + arr.name + "</b> восстанавливается: " +
                     arr.resyncPct + "% — расчётное время: " + arr.resyncEta
            });
        }
    });

    if (alerts.length === 0) {
        banner.classList.add("hidden");
        return;
    }
    banner.classList.remove("hidden");
    banner.innerHTML = alerts.map(function(a) {
        var icon = a.level === "danger" ? "🔴" : a.level === "warning" ? "🟡" : "🔵";
        return "<div class='alert alert-" + a.level + "'>" + icon + " " + a.msg + "</div>";
    }).join("");
}

// ─── Parse /proc/mdstat ───────────────────────────────────────────────────────

function parseMdstat(text) {
    var arrays = [];
    var lines  = text.split("\n");
    var i = 0;
    while (i < lines.length) {
        var line = lines[i];
        var m = line.match(/^(md\w+)\s*:\s*(\S+(?:\s*\(auto-read-only\))?)\s+(\w+)\s+(.*)/);
        if (m) {
            var name   = m[1];
            var state  = m[2].replace("(auto-read-only)", "").trim();
            var level  = m[3];
            var devStr = m[4];

            var devices = [];
            var devMatches = devStr.match(/(\w+)\[(\d+)\](\([A-Z]\))?/g) || [];
            devMatches.forEach(function(d) {
                var dm = d.match(/(\w+)\[(\d+)\](\([A-Z]\))?/);
                if (dm) devices.push({ name: dm[1], index: dm[2], flag: dm[3] ? dm[3].replace(/[()]/g,"") : "" });
            });

            var statusLine = lines[i+1] || "";
            var blocksM = statusLine.match(/(\d+) blocks/);
            var sizeGB  = blocksM ? (parseInt(blocksM[1]) * 1024 / 1e9).toFixed(1) : "?";
            var slotM   = statusLine.match(/\[(\d+)\/(\d+)\]/);
            var total   = slotM ? parseInt(slotM[1]) : 0;
            var active  = slotM ? parseInt(slotM[2]) : 0;
            var maskM   = statusLine.match(/\[([U_]+)\]/);
            var mask    = maskM ? maskM[1] : "";

            var resyncLine = lines[i+2] || "";
            var resyncing  = false, resyncPct = "0", resyncEta = "", resyncType = "";
            var resyncM = resyncLine.match(/=+>\s+([\d.]+)%.*finish=([\d.]+\w+)/);
            if (resyncM) {
                resyncing  = true;
                resyncPct  = resyncM[1];
                resyncEta  = resyncM[2];
                resyncType = resyncLine.indexOf("reshape") !== -1 ? "reshape" : "resync";
            }

            arrays.push({
                name: name, level: level, state: state, sizeGB: sizeGB,
                devices: devices, total: total, active: active, mask: mask,
                degraded: (state === "active" || state === "clean") && active < total,
                inactive: state === "inactive",
                resyncing: resyncing, resyncPct: resyncPct, resyncEta: resyncEta,
                resyncType: resyncType
            });
        }
        i++;
    }
    return arrays;
}

// ─── Render RAID arrays ───────────────────────────────────────────────────────

function renderArrays(arrays, mountMap) {
    mountMap = mountMap || {};
    var container = document.getElementById("arrays-container");
    if (arrays.length === 0) {
        container.innerHTML = "<p class='text-muted'>RAID массивов не обнаружено</p>";
        return;
    }

    container.innerHTML = arrays.map(function(arr) {
        var badge, statusDesc, actionBtn = "";
        if (arr.inactive) {
            badge      = "<span class='badge badge-danger'>🔴 Неактивен</span>";
            statusDesc = "Массив не запущен. Данные недоступны.";
            actionBtn  = "<button class='btn btn-warning btn-sm' data-action='run' data-array='" + arr.name + "'>▶ Запустить</button>";
        } else if (arr.resyncing) {
            var opLabel = arr.resyncType === "reshape" ? "Расширение" : "Восстановление";
            var opDesc  = arr.resyncType === "reshape"
                ? "Идёт reshape (перераспределение данных). ETA: " + arr.resyncEta + ". ⚠ Не выключайте сервер!"
                : "Идёт ресинхронизация. ETA: " + arr.resyncEta + ". Не выключайте сервер.";
            badge      = "<span class='badge badge-info'>🔵 " + opLabel + " " + arr.resyncPct + "%</span>";
            statusDesc = opDesc;
        } else if (arr.degraded) {
            badge      = "<span class='badge badge-warning'>🟡 Деградирован</span>";
            statusDesc = "Работает, но " + (arr.total - arr.active) + " диск(ов) отсутствует. Защита отключена!";
        } else {
            badge      = "<span class='badge badge-success'>🟢 Активен</span>";
            statusDesc = "Массив работает нормально.";
        }

        var slots = arr.mask ? arr.mask.split("").map(function(c) {
            return c === "U"
                ? "<span class='slot-ok' title='Диск активен'>▪</span>"
                : "<span class='slot-missing' title='Диск отсутствует'>✕</span>";
        }).join("") : "";

        var devList = arr.devices.map(function(d) {
            var isFaulty = d.flag === "F";
            var isSpare  = d.flag === "S";
            var icon  = isFaulty ? "🔴" : isSpare ? "⚪" : "🟢";
            var label = isFaulty ? "сбой" : isSpare ? "запасной" : "активен";
            return "<div class='device-row'>" + icon + " <b>/dev/" + d.name + "</b> <small class='text-muted'>(" + label + ")</small></div>";
        }).join("");

        var resyncBar = arr.resyncing
            ? "<div class='progress-wrap'><div class='progress-bar' style='width:" + arr.resyncPct + "%'></div><span>" + arr.resyncPct + "%</span></div>"
            : "";

        // Replace disk: show when degraded/inactive
        var addDiskBtn = (arr.degraded || arr.inactive)
            ? "<button class='btn btn-primary btn-sm' data-action='replace' data-array='" + arr.name + "'>🔄 Заменить диск</button>"
            : "";

        // Expand array: show only when fully healthy and not resyncing/reshaping
        var expandBtn = (!arr.inactive && !arr.degraded && !arr.resyncing &&
                         ["raid5","raid6","raid10","raid1"].indexOf(arr.level) !== -1)
            ? "<button class='btn btn-secondary btn-sm' data-action='expand' data-array='" + arr.name + "'>⤢ Расширить массив</button>"
            : "";

        // RAID level upgrade button (dynamic: raid1→5, raid5→6)
        var _upgradeInfo = !arr.inactive && !arr.degraded && !arr.resyncing && RAID_UPGRADES[arr.level];
        var upgradeBtn = _upgradeInfo
            ? "<button class='btn btn-secondary btn-sm' data-action='upgrade' data-array='" + arr.name + "'" +
              " data-level='" + arr.level + "' data-devices='" + arr.total + "'" +
              " title='Сменить уровень RAID'>⬆ Апгрейд → " + _upgradeInfo.targetLabel + "</button>"
            : "";

        // Mount status + mount/umount/subvolume buttons
        var mountInfo = mountMap[arr.name];
        var mountStatusHtml = "";
        var mountBtn = "", umountBtn = "", subvolBtn = "", deleteBtn = "";

        if (mountInfo) {
            mountStatusHtml = "<div class='text-muted' style='font-size:13px;margin-top:4px'>📂 " +
                mountInfo.target + " <small>(" + mountInfo.fstype + ")</small></div>";
            umountBtn = "<button class='btn btn-secondary btn-sm' data-action='umount' data-array='" + arr.name + "' data-target='" + mountInfo.target + "'>⏏ Размонтировать</button>";
            if (mountInfo.fstype === "btrfs") {
                subvolBtn = "<button class='btn btn-secondary btn-sm' data-action='subvol' data-array='" + arr.name + "' data-target='" + mountInfo.target + "'>🗂 Субтома</button>";
            }
        } else if (!arr.inactive) {
            mountStatusHtml = "<div class='text-muted' style='font-size:13px;margin-top:4px'>— не смонтирован</div>";
            mountBtn = "<button class='btn btn-secondary btn-sm' data-action='mount' data-array='" + arr.name + "'>📂 Смонтировать</button>";
        }

        deleteBtn = "<button class='btn btn-danger btn-sm' data-action='delete' data-array='" + arr.name + "' data-disks='" +
            arr.devices.map(function(d) { return d.name; }).join(",") + "'>🗑 Удалить</button>";

        var spindownS = spindownState[arr.name];
        var spindownBadge = spindownS && spindownS.backup_mode ? _spindownBadgeHtml(spindownS) : "";
        var bmBtn = "<button class='btn btn-secondary btn-sm' onclick='openBackupModePanel(\"" + arr.name + "\")'>⚙ Backup Mode</button>";
        var daemonNote = (!spindownS) ? "<div class='text-muted' style='font-size:12px;margin-top:4px'>Демон rusnas-spind не запущен — конфиг будет сохранён при старте.</div>" : "";
        var bmPanel = "<div id='bm-panel-" + arr.name + "' style='display:none;margin-top:8px;padding:12px;border:1px solid var(--color-border);border-radius:var(--radius);background:var(--bg-card)'>" +
            "<b>RAID Backup Mode</b>" +
            "<div style='margin-top:8px'>" +
            "<label class='checkbox-label'><input type='checkbox' id='bm-toggle-" + arr.name + "'> Включить RAID Backup Mode</label>" +
            "</div>" +
            "<div class='text-muted' style='font-size:12px;margin:6px 0'>Диски останавливают шпиндели при бездействии. Первое обращение после сна: 5–15 сек.<br>⚠ Только для HDD-массивов с нерегулярным доступом.</div>" +
            "<div style='margin-top:6px'><label>Таймаут бездействия: <input type='number' id='bm-timeout-" + arr.name + "' value='30' min='5' max='480' style='width:70px;display:inline-block'> мин (5–480)</label></div>" +
            daemonNote +
            "<div id='bm-status-" + arr.name + "'></div>" +
            "<div style='margin-top:10px'>" +
            "<button class='btn btn-primary btn-sm' onclick='applyBackupMode(\"" + arr.name + "\")'>Применить</button> " +
            "<button class='btn btn-secondary btn-sm' onclick='openBackupModePanel(\"" + arr.name + "\")'>Отмена</button>" +
            "</div></div>";

        return "<div class='array-card'>" +
            "<div class='array-header'>" +
                "<div>" +
                    "<span class='array-name'>" + arr.name + "</span>" +
                    "<span class='array-level'>" + arr.level.toUpperCase() + "</span>" +
                    "<span class='array-size'>" + arr.sizeGB + " GB</span>" +
                "</div>" +
                "<div class='array-actions'>" +
                    actionBtn + " " + addDiskBtn + " " + expandBtn + " " + upgradeBtn + " " +
                    mountBtn + " " + umountBtn + " " + subvolBtn + " " + bmBtn + " " + deleteBtn +
                "</div>" +
            "</div>" +
            "<div class='array-status'>" + badge + "<span id='spindown-badge-" + arr.name + "'>" + spindownBadge + "</span>" + " <span class='status-desc'>" + statusDesc + "</span></div>" +
            mountStatusHtml +
            "<div class='array-slots'>" + slots + "</div>" +
            resyncBar +
            "<div class='array-devices'>" + devList + "</div>" +
            "<div class='array-hint'>" + getRaidHint(arr) + "</div>" +
            bmPanel +
        "</div>";
    }).join("");

}

function getRaidHint(arr) {
    var n       = arr.total;
    var missing = n - arr.active;

    switch (arr.level) {
        case "raid0":
            return "RAID 0: чётность отсутствует, ёмкость = " + n + " × диск. " +
                   "⚠ Любой отказ диска = полная потеря всех данных.";

        case "raid1": {
            var canLose1 = n - 1;
            var statusMsg1 = arr.degraded
                ? "⚠ Нет " + missing + " диска(ов) — ещё выдержит " + Math.max(0, canLose1 - missing) + " сбой(ев)."
                : "Защита активна.";
            return "RAID 1: зеркало всех " + n + " дисков, ёмкость = 1 × диск. " +
                   "Выдержит отказ " + canLose1 + " из " + n + " дисков. " + statusMsg1;
        }

        case "raid5": {
            var statusMsg5 = arr.degraded
                ? "⚠ Массив деградирован — защита полностью снята! Немедленно замените диск."
                : "Защита активна.";
            return "RAID 5: 1 диск-чётность на весь массив (не зависит от числа дисков!), " +
                   "ёмкость = " + (n - 1) + " из " + n + " дисков. " +
                   "Выдержит отказ строго 1 диска. Нужна защита от 2 сбоев → используйте RAID 6. " +
                   statusMsg5;
        }

        case "raid6": {
            var remaining6 = Math.max(0, 2 - missing);
            var statusMsg6 = arr.degraded
                ? "⚠ Нет " + missing + " диска(ов) — ещё выдержит " + remaining6 + " сбой(ев)."
                : "Защита активна.";
            return "RAID 6: 2 диска-чётности, ёмкость = " + (n - 2) + " из " + n + " дисков. " +
                   "Выдержит отказ любых 2 дисков одновременно. " + statusMsg6;
        }

        case "raid10": {
            var pairs     = Math.floor(n / 2);
            var statusMsg10 = arr.degraded ? "⚠ Есть сбойные диски!" : "Защита активна.";
            return "RAID 10: " + pairs + " зеркальных пары + страйп, ёмкость = " + pairs + " из " + n + " дисков. " +
                   "Выдержит отказ 1 диска в каждой паре (до " + pairs + " дисков, если из разных пар). " +
                   statusMsg10;
        }

        default:
            return arr.level.toUpperCase() + ": " + n + " дисков.";
    }
}

// ─── Render physical disks ────────────────────────────────────────────────────

function renderDisks(lsblkOut, arrays) {
    var tbody = document.getElementById("disks-body");
    var lines = lsblkOut.trim().split("\n").filter(Boolean);

    var diskArrayMap = {};
    arrays.forEach(function(arr) {
        arr.devices.forEach(function(d) { diskArrayMap[d.name] = arr.name; });
    });

    var disks = lines.filter(function(l) { return l.trim().split(/\s+/)[2] === "disk"; });

    // Track non-system disk count for RAID advisor (exclude sda = system disk)
    physicalDiskCount = disks.filter(function(l) { return l.trim().split(/\s+/)[0] !== "sda"; }).length;

    // Populate currentDisks for create-array modal
    currentDisks = disks.map(function(line) {
        var parts = line.trim().split(/\s+/);
        return { name: parts[0], size: parts[1], array: diskArrayMap[parts[0]] || null };
    });

    if (disks.length === 0) {
        tbody.innerHTML = "<tr><td colspan='6'>Диски не найдены</td></tr>";
        return;
    }

    tbody.innerHTML = disks.map(function(line) {
        var parts = line.trim().split(/\s+/);
        var name  = parts[0];
        var size  = parts[1];

        var inArray = diskArrayMap[name];
        var arrayLabel = inArray
            ? "<span class='badge badge-info'>" + inArray + "</span>"
            : name === "sda"
                ? "<span class='badge badge-secondary'>система</span>"
                : "<span class='badge badge-secondary'>свободен</span>";

        // Eject button only for disks in array (not system)
        var ejectBtn = (inArray)
            ? "<button class='btn btn-warning btn-sm' onclick='openEjectDisk(\"" + name + "\",\"" + inArray + "\")'>⏏ Извлечь</button>"
            : "";

        return "<tr style='cursor:pointer' title='Нажмите для просмотра S.M.A.R.T.'>" +
            "<td><b>/dev/" + name + "</b></td>" +
            "<td>" + size + "</td>" +
            "<td><span class='disk-model' id='model-" + name + "'>...</span></td>" +
            "<td><span class='disk-serial' id='serial-" + name + "'>...</span></td>" +
            "<td>" + arrayLabel + "</td>" +
            "<td><span class='smart-status' id='smart-" + name + "'>...</span></td>" +
            "<td>" + ejectBtn + "</td>" +
            "</tr>";
    }).join("");

    // Load SMART info for each disk
    disks.forEach(function(line) {
        var name = line.trim().split(/\s+/)[0];
        loadDiskInfo(name);
    });
}

function loadDiskInfo(disk) {
    cockpit.spawn(["sudo", "-n", "smartctl", "-i", "-H", "/dev/" + disk],
        {err: "message"})
    .done(function(out) {
        // Model
        var modelM = out.match(/Device Model:\s*(.+)|Model Number:\s*(.+)/);
        var model  = modelM ? (modelM[1] || modelM[2]).trim() : "—";
        var modelEl = document.getElementById("model-" + disk);
        if (modelEl) modelEl.textContent = model;

        // Serial
        var serialM = out.match(/Serial Number:\s*(.+)/);
        var serial  = serialM ? serialM[1].trim() : "—";
        var serialEl = document.getElementById("serial-" + disk);
        if (serialEl) serialEl.innerHTML = "<code>" + serial + "</code>";

        // SMART health
        var ok = out.toLowerCase().indexOf("passed") !== -1 || out.toLowerCase().indexOf("ok") !== -1;
        var smartEl = document.getElementById("smart-" + disk);
        if (smartEl) smartEl.innerHTML = ok
            ? "<span class='text-success'>✓ OK</span>"
            : "<span class='text-warning'>⚠ Проверьте</span>";
    })
    .fail(function() {
        var modelEl = document.getElementById("model-" + disk);
        if (modelEl) modelEl.textContent = "нет данных";
        var smartEl = document.getElementById("smart-" + disk);
        if (smartEl) smartEl.innerHTML = "<span class='text-muted'>—</span>";
        var serialEl = document.getElementById("serial-" + disk);
        if (serialEl) serialEl.textContent = "—";
    });
}


// ─── Rescan SCSI bus for new disks ───────────────────────────────────────────

function rescanDisks() {
    var btn = document.getElementById("btn-rescan-disks");
    btn.disabled = true;
    btn.textContent = "🔍 Поиск...";

    var cmd = "for host in /sys/class/scsi_host/host*/scan; do echo '- - -' | sudo tee $host > /dev/null; done";
    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() {
            setTimeout(function() {
                loadDisksAndArrays();
                btn.disabled = false;
                btn.textContent = "🔍 Найти новые диски";
            }, 2000); // wait 2s for kernel to register devices
        })
        .fail(function(err) {
            btn.disabled = false;
            btn.textContent = "🔍 Найти новые диски";
            alert("Ошибка: " + err);
        });
}

// ─── Backup Mode functions ─────────────────────────────────────────────────────

function loadSpindownState(callback) {
    new Promise(function(res, rej) {
        cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "get_state"],
                      {err: "message"}).done(res).fail(rej);
    }).then(function(out) {
        try {
            var data = JSON.parse(out);
            if (data && data.arrays) {
                spindownState = data.arrays;
            } else {
                spindownState = {};
            }
        } catch(e) { spindownState = {}; }
        if (callback) callback();
    }).catch(function() { spindownState = {}; if (callback) callback(); });
}

function timeAgo(isoString) {
    if (!isoString) return "—";
    var diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 60) return diff + " сек назад";
    if (diff < 3600) return Math.floor(diff/60) + " мин назад";
    return Math.floor(diff/3600) + " ч назад";
}

function startSpindownPoll() {
    if (spindownPollTimer) return;
    _doSpindownPoll(_SPINDOWN_POLL_NORMAL);
}

function _doSpindownPoll(interval) {
    if (spindownPollTimer) clearInterval(spindownPollTimer);
    spindownPollTimer = setInterval(function() {
        loadSpindownState(function() {
            updateSpindownBadges();
            // Switch to fast poll during transitions, back to normal otherwise
            var hasFastState = Object.values(spindownState).some(function(s) {
                return s.state === "flushing" || s.state === "waking";
            });
            var nextInterval = hasFastState ? _SPINDOWN_POLL_FAST : _SPINDOWN_POLL_NORMAL;
            if (nextInterval !== interval) {
                clearInterval(spindownPollTimer);
                spindownPollTimer = null;
                _doSpindownPoll(nextInterval);
            }
        });
    }, interval);
}

function stopSpindownPoll() {
    if (spindownPollTimer) { clearInterval(spindownPollTimer); spindownPollTimer = null; }
}

function updateSpindownBadges() {
    Object.keys(spindownState).forEach(function(name) {
        var s = spindownState[name];
        var badgeEl = document.getElementById("spindown-badge-" + name);
        if (!badgeEl) return;
        badgeEl.innerHTML = _spindownBadgeHtml(s);
    });
}

function _spindownBadgeHtml(s) {
    if (!s || !s.backup_mode) return "";
    var state = s.state || "active";
    if (state === "standby")  return "<span class='badge badge-secondary' style='margin-left:6px'>💤 STANDBY</span>";
    if (state === "flushing") return "<span class='badge badge-info' style='margin-left:6px'>⏳ ЗАСЫПАЕТ…</span>";
    if (state === "waking")   return "<span class='badge badge-info' style='margin-left:6px'>🔆 ПРОСЫПАЕТСЯ…</span>";
    return "<span class='badge badge-success' style='margin-left:6px'>💾 BACKUP АКТИВЕН</span>";
}

function _warnIfSleeping(arrayName, actionLabel) {
    var s = spindownState[arrayName];
    if (s && s.backup_mode && s.state === "standby") {
        return confirm(
            "⚠ Массив " + arrayName + " спит (Backup Mode).\n" +
            "Действие «" + actionLabel + "» разбудит его (5–15 сек задержки).\n\nПродолжить?"
        );
    }
    return true;
}

function openBackupModePanel(arrayName) {
    var panelId = "bm-panel-" + arrayName;
    var panel = document.getElementById(panelId);
    if (!panel) return;
    var visible = panel.style.display !== "none";
    panel.style.display = visible ? "none" : "block";
    if (!visible) {
        // Load current config and fill panel
        new Promise(function(res, rej) {
            cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "get_config"],
                          {err: "message"}).done(res).fail(rej);
        }).then(function(out) {
            try {
                var cfg = JSON.parse(out);
                var arrCfg = (cfg.arrays || {})[arrayName] || {};
                var toggle = document.getElementById("bm-toggle-" + arrayName);
                var timeout = document.getElementById("bm-timeout-" + arrayName);
                if (toggle) toggle.checked = arrCfg.backup_mode === true;
                if (timeout) timeout.value = arrCfg.idle_timeout_minutes || 30;
                _refreshBackupModeStatus(arrayName);
            } catch(e) {}
        }).catch(function() {});
    }
}

function _refreshBackupModeStatus(arrayName) {
    var statusEl = document.getElementById("bm-status-" + arrayName);
    if (!statusEl) return;
    var s = spindownState[arrayName];
    if (!s || !s.backup_mode) {
        statusEl.style.display = "none";
        return;
    }
    statusEl.style.display = "block";
    var state = s.state || "active";
    var stateLabel = state === "standby" ? "💤 STANDBY (диски спят)"
        : state === "flushing" ? "⏳ Засыпает…"
        : state === "waking"   ? "🔆 Просыпается…"
        : "💾 Активен";
    var sinceLabel = state === "standby" ? " · с " + (s.spindown_at ? new Date(s.spindown_at).toLocaleTimeString("ru") : "—") : "";
    var disksHtml = Object.entries(s.disk_states || {}).map(function(e) {
        return "<span style='margin-right:8px'>" + e[0] + " " + (e[1] === "standby" ? "💤" : "🟢") + "</span>";
    }).join("");
    statusEl.innerHTML =
        "<div style='margin-top:8px;padding:10px;background:var(--bg-th);border-radius:var(--radius-sm)'>" +
        "<div><b>Статус:</b> " + stateLabel + sinceLabel + "</div>" +
        "<div><b>Последняя активность:</b> " + timeAgo(s.last_io_at) + "</div>" +
        "<div><b>Пробуждений за сессию:</b> " + (s.wakeup_count_session || 0) + "</div>" +
        "<div style='margin-top:6px'>" + disksHtml + "</div>" +
        "<div style='margin-top:8px'>" +
        "<button class='btn btn-primary btn-sm' onclick='wakeupArray(\"" + arrayName + "\")'>⚡ Разбудить сейчас</button> " +
        "<button class='btn btn-secondary btn-sm' onclick='spindownArray(\"" + arrayName + "\")'>💤 Усыпить сейчас</button>" +
        "</div></div>";
}

function applyBackupMode(arrayName) {
    var toggle = document.getElementById("bm-toggle-" + arrayName);
    var timeoutEl = document.getElementById("bm-timeout-" + arrayName);
    if (!toggle || !timeoutEl) return;
    var enabled = toggle.checked;
    var timeout = parseInt(timeoutEl.value) || 30;
    if (timeout < 5 || timeout > 480) {
        alert("Таймаут должен быть от 5 до 480 минут");
        return;
    }
    new Promise(function(res, rej) {
        cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "set_backup_mode",
                       "--array", arrayName, "--enabled", String(enabled), "--timeout", String(timeout)],
                      {err: "message"}).done(res).fail(rej);
    }).then(function(out) {
        try {
            var r = JSON.parse(out);
            if (!r.ok) { alert("Ошибка: " + r.error); return; }
            if (r.warning) {
                if (!confirm("⚠ " + r.warning + "\n\nВсё равно включить?")) {
                    // Rollback: config already written by server — disable it
                    new Promise(function(res2, rej2) {
                        cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "set_backup_mode",
                                       "--array", arrayName, "--enabled", "false", "--timeout", String(timeout)],
                                      {err: "message"}).done(res2).fail(rej2);
                    }).catch(function(e) { console.error("rollback failed:", e); });
                    return;
                }
            }
            // Reload state and restart poll
            loadSpindownState(function() {
                updateSpindownBadges();
                _refreshBackupModeStatus(arrayName);
                var hasBackup = Object.values(spindownState).some(function(s) { return s.backup_mode; });
                if (hasBackup) startSpindownPoll(); else stopSpindownPoll();
            });
        } catch(e) {}
    }).catch(function(e) { alert("Ошибка: " + e); });
}

function wakeupArray(arrayName) {
    new Promise(function(res, rej) {
        cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "wakeup_now", "--array", arrayName],
                      {err: "message"}).done(res).fail(rej);
    }).then(function(out) {
        setTimeout(function() {
            loadSpindownState(function() { updateSpindownBadges(); _refreshBackupModeStatus(arrayName); });
        }, 3000);
    }).catch(function(e) { alert("Ошибка: " + e); });
}

function spindownArray(arrayName) {
    if (!confirm("Усыпить массив " + arrayName + " прямо сейчас?")) return;
    new Promise(function(res, rej) {
        cockpit.spawn(["sudo", "-n", "python3", SPINDOWN_CGI, "spindown_now", "--array", arrayName],
                      {err: "message"}).done(res).fail(rej);
    }).then(function(out) {
        try {
            var r = JSON.parse(out);
            if (!r.ok) { alert("Ошибка: " + r.error); return; }
        } catch(e) {}
        setTimeout(function() {
            loadSpindownState(function() { updateSpindownBadges(); _refreshBackupModeStatus(arrayName); });
        }, 8000);
    }).catch(function(e) { alert("Ошибка: " + e); });
}

// ─── Load all ─────────────────────────────────────────────────────────────────

function parseMountInfo(out) {
    var map = {};
    out.trim().split("\n").forEach(function(line) {
        var parts = line.trim().split(/\s+/);
        if (parts.length < 3) return;
        var src    = parts[0];
        var target = parts[1];
        var fstype = parts[2];
        // match /dev/mdX or /dev/md/X
        var m = src.match(/\/dev\/(md\w+)/);
        if (m) map[m[1]] = { target: target, fstype: fstype };
    });
    return map;
}

function loadDisksAndArrays() {
    cockpit.spawn(["bash", "-c", "cat /proc/mdstat"])
        .done(function(mdstat) {
            var arrays = parseMdstat(mdstat);
            currentArrays = arrays;
            updateAlertBanner(arrays);

            // Fetch mount info in parallel
            cockpit.spawn(["bash", "-c", "findmnt -rno SOURCE,TARGET,FSTYPE 2>/dev/null || true"])
                .done(function(mountOut) {
                    currentMountMap = parseMountInfo(mountOut);
                    loadSpindownState(function() {
                        renderArrays(arrays, currentMountMap);
                        updateSpindownBadges();
                        var hasBackup = Object.values(spindownState).some(function(s) { return s.backup_mode; });
                        if (hasBackup) startSpindownPoll();
                    });
                })
                .fail(function() {
                    currentMountMap = {};
                    loadSpindownState(function() {
                        renderArrays(arrays, {});
                        updateSpindownBadges();
                        var hasBackup = Object.values(spindownState).some(function(s) { return s.backup_mode; });
                        if (hasBackup) startSpindownPoll();
                    });
                });

            var resyncing = arrays.some(function(a) { return a.resyncing; });
            var degraded  = arrays.some(function(a) { return a.degraded; });
            // Auto-refresh if resyncing OR degraded (waiting for recovery to complete)
            if ((resyncing || degraded) && !diskRefreshTimer) {
                diskRefreshTimer = setInterval(loadDisksAndArrays, 4000);
            } else if (!resyncing && !degraded && diskRefreshTimer) {
                clearInterval(diskRefreshTimer);
                diskRefreshTimer = null;
            }

            cockpit.spawn(["bash", "-c", "lsblk -rno NAME,SIZE,TYPE | grep -v '^loop'"])
                .done(function(out) { renderDisks(out, arrays); });
        })
        .fail(function() {
            document.getElementById("arrays-container").innerHTML =
                "<p class='text-danger'>Ошибка чтения /proc/mdstat</p>";
        });
}

// ─── Actions: run array ───────────────────────────────────────────────────────

function runArray(name) {
    if (!confirm("Запустить массив " + name + "?")) return;
    cockpit.spawn(["sudo", "-n", "mdadm", "--run", "/dev/" + name], {err: "message"})
        .done(function() { setTimeout(loadDisksAndArrays, 1500); })
        .fail(function(err) { alert("Ошибка: " + err); });
}

// ─── Actions: add disk ────────────────────────────────────────────────────────

function openAddDisk(arrayName, mode) {
    mode = mode || "replace";
    document.getElementById("add-disk-array").value       = arrayName;
    document.getElementById("add-disk-array-label").value = arrayName;
    document.getElementById("add-disk-mode").value        = mode;

    // Update modal title and description based on mode
    var title = document.getElementById("add-disk-title");
    var desc  = document.getElementById("add-disk-desc");
    if (mode === "expand") {
        title.textContent = "Расширить массив";
        desc.innerHTML = "<div class='mode-info mode-expand'>" +
            "<b>⤢ Расширение массива</b><br>" +
            "Добавляет новый диск и увеличивает количество активных дисков в массиве. " +
            "После добавления автоматически запустится <b>reshape</b> — перераспределение данных. " +
            "<br><br>⏱ Время: от нескольких часов до суток в зависимости от размера.<br>" +
            "⚠ Не выключайте сервер во время reshape!</div>";
    } else {
        title.textContent = "Заменить сбойный диск";
        desc.innerHTML = "<div class='mode-info mode-replace'>" +
            "<b>🔄 Замена диска</b><br>" +
            "Добавляет новый диск на место вышедшего из строя. " +
            "Массив автоматически начнёт восстановление (resync).<br><br>" +
            "⏱ Время: 30–120 минут в зависимости от размера.</div>";
    }

    cockpit.spawn(["bash", "-c",
        "lsblk -rno NAME,TYPE | grep ' disk$' | awk '{print $1}' | while read d; do " +
        "grep -q $d /proc/mdstat || echo $d; done | grep -v sda"
    ])
    .done(function(out) {
        var disks = out.trim().split("\n").filter(Boolean);
        var sel = document.getElementById("add-disk-select");
        if (disks.length === 0) {
            sel.innerHTML = "<option value=''>— нет свободных дисков —</option>";
        } else {
            sel.innerHTML = disks.map(function(d) {
                return "<option value='/dev/" + d + "'>/dev/" + d + "</option>";
            }).join("");
        }
        loadAddDiskInfo(disks);
        showModal("add-disk-modal");
    });
}

function loadAddDiskInfo(disks) {
    var info = document.getElementById("add-disk-info");
    if (!info || disks.length === 0) return;
    info.innerHTML = "Загрузка информации о дисках...";

    var results = [];
    var pending = disks.length;

    disks.forEach(function(disk, idx) {
        cockpit.spawn(["sudo", "-n", "smartctl", "-i", "/dev/" + disk],
            {err: "message"})
            .done(function(out) {
                var modelM  = out.match(/Device Model:\s*(.+)|Model Number:\s*(.+)/);
                var serialM = out.match(/Serial Number:\s*(.+)/);
                var sizeM   = out.match(/User Capacity:\s*(.+)/);
                results[idx] = {
                    disk:   disk,
                    model:  modelM  ? (modelM[1]  || modelM[2]).trim()  : "неизвестно",
                    serial: serialM ? serialM[1].trim() : "—",
                    size:   sizeM   ? sizeM[1].trim()   : "—"
                };
                if (--pending === 0) renderAddDiskInfo(results);
            })
            .fail(function() {
                results[idx] = { disk: disk, model: "—", serial: "—", size: "—" };
                if (--pending === 0) renderAddDiskInfo(results);
            });
    });
}

function renderAddDiskInfo(results) {
    var info = document.getElementById("add-disk-info");
    if (!info) return;
    info.innerHTML = results.filter(Boolean).map(function(r) {
        return "<div class='disk-info-row'>" +
            "<b>/dev/" + r.disk + "</b> — " + r.model +
            " | S/N: <code>" + r.serial + "</code>" +
            " | " + r.size +
            "</div>";
    }).join("");
}

// ─── Actions: safe eject ─────────────────────────────────────────────────────

function openEjectDisk(disk, arrayName) {
    document.getElementById("eject-disk-name").textContent   = "/dev/" + disk;
    document.getElementById("eject-array-name").textContent  = arrayName;
    document.getElementById("eject-disk-value").value        = disk;
    document.getElementById("eject-array-value").value       = arrayName;

    // Load disk info for confirmation
    cockpit.spawn(["sudo", "-n", "smartctl", "-i", "/dev/" + disk],
        {err: "message"})
        .done(function(out) {
            var modelM  = out.match(/Device Model:\s*(.+)|Model Number:\s*(.+)/);
            var serialM = out.match(/Serial Number:\s*(.+)/);
            var model   = modelM  ? (modelM[1]  || modelM[2]).trim() : "—";
            var serial  = serialM ? serialM[1].trim() : "—";
            document.getElementById("eject-disk-details").innerHTML =
                "<b>Модель:</b> " + model + "<br>" +
                "<b>Серийный номер:</b> <code>" + serial + "</code><br>" +
                "<small class='text-muted'>Сверьте серийный номер с наклейкой на диске перед извлечением</small>";
        });

    showModal("eject-disk-modal");
}

function confirmEjectDisk() {
    var disk      = document.getElementById("eject-disk-value").value;
    var arrayName = document.getElementById("eject-array-value").value;

    var cmd = "sudo mdadm /dev/" + arrayName + " --fail /dev/" + disk +
        " ; sudo mdadm /dev/" + arrayName + " --remove /dev/" + disk +
        " && echo 1 | sudo tee /sys/block/" + disk + "/device/delete";

    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() {
            closeModal("eject-disk-modal");
            document.getElementById("eject-status").innerHTML =
                "<div class='alert alert-info'>✅ Диск <b>/dev/" + disk + "</b> безопасно извлечён. " +
                "Теперь можно физически вытащить диск из корпуса.</div>";
            setTimeout(loadDisksAndArrays, 1500);
        })
        .fail(function(err) { alert("Ошибка: " + err); });
}

// ─── RAID Advisor ─────────────────────────────────────────────────────────────

var RAID_TYPES = [
    {
        level: "RAID 0",  minDisks: 2, evenOnly: false,
        fault:  function()  { return 0; },
        usable: function(n) { return n; },
        read: 5, write: 5,
        useCase: "Временные данные, кэш, рендеринг. Максимальная скорость.",
        danger: true
    },
    {
        level: "RAID 1",  minDisks: 2, evenOnly: false,
        fault:  function(n) { return n - 1; },
        usable: function()  { return 1; },
        read: 4, write: 3,
        useCase: "ОС, базы данных. Максимальная надёжность при малом числе дисков."
    },
    {
        level: "RAID 5",  minDisks: 3, evenOnly: false,
        fault:  function()  { return 1; },
        usable: function(n) { return n - 1; },
        read: 4, write: 3,
        useCase: "Файловый сервер, NAS. Хороший баланс надёжности и ёмкости."
    },
    {
        level: "RAID 6",  minDisks: 4, evenOnly: false,
        fault:  function()  { return 2; },
        usable: function(n) { return n - 2; },
        read: 4, write: 2,
        useCase: "Архивы, критичные данные. Выдержит одновременный отказ 2 дисков."
    },
    {
        level: "RAID 10", minDisks: 4, evenOnly: true,
        fault:  function(n) { return Math.floor(n / 2) + " (по 1 в паре)"; },
        usable: function(n) { return Math.floor(n / 2); },
        read: 5, write: 4,
        useCase: "Базы данных, высоконагруженные сервисы. Быстро и надёжно."
    },
    {
        level: "RAID F1", minDisks: 3, evenOnly: false,
        fault:  function()  { return 1; },
        usable: function(n) { return n - 1; },
        read: 4, write: 4,
        useCase: "SSD-массивы. Как RAID 5, но равномерно распределяет износ флеш-памяти."
    }
];

function stars(n, max) {
    var s = "";
    for (var i = 0; i < max; i++) s += i < n ? "★" : "☆";
    return "<span style='color:var(--warning);letter-spacing:1px;'>" + s + "</span>";
}

function openRaidAdvisor() {
    var content = document.getElementById("raid-advisor-content");
    content.innerHTML = "<p class='text-muted' style='padding:16px 0;'>Загрузка данных о дисках...</p>";
    showModal("raid-advisor-modal");

    cockpit.spawn(["bash", "-c", "lsblk -rno NAME,SIZE,TYPE -b 2>/dev/null | grep ' disk$'"])
        .done(function(out) {
            var allDisks = out.trim().split("\n").filter(Boolean).map(function(line) {
                var p = line.trim().split(/\s+/);
                return { name: p[0], sizeBytes: parseInt(p[1]) || 0 };
            });
            var dataDisks = allDisks.filter(function(d) { return d.name !== "sda"; });
            renderAdvisor(dataDisks);
        })
        .fail(function() { renderAdvisor([]); });
}

function renderAdvisor(dataDisks) {
    var n       = dataDisks.length;
    var content = document.getElementById("raid-advisor-content");

    content.innerHTML =
        "<div class='advisor-tabs'>" +
            "<button class='advisor-tab-btn active' id='tab-btn-compare'>Сравнение типов RAID</button>" +
            "<button class='advisor-tab-btn' id='tab-btn-builder'>Из ваших " + n + " дисков</button>" +
        "</div>" +
        "<div id='advisor-tab-compare'>"  + buildCompareTab(n)          + "</div>" +
        "<div id='advisor-tab-builder' class='hidden'>" + buildBuilderTab(dataDisks) + "</div>";

    document.getElementById("tab-btn-compare").addEventListener("click", function() { switchAdvisorTab("compare"); });
    document.getElementById("tab-btn-builder").addEventListener("click", function() { switchAdvisorTab("builder"); });
}

function switchAdvisorTab(name) {
    ["compare", "builder"].forEach(function(t) {
        document.getElementById("advisor-tab-" + t).classList.toggle("hidden", t !== name);
        document.getElementById("tab-btn-" + t).classList.toggle("active", t === name);
    });
}

// ── Tab 1: comparison table ───────────────────────────────────────────────────

function buildCompareTab(n) {
    var rows = RAID_TYPES.map(function(r) {
        var ok     = n >= r.minDisks && (!r.evenOnly || n % 2 === 0);
        var fault  = ok ? r.fault(n)  : "—";
        var usable = ok ? r.usable(n) : null;
        var cap    = ok ? usable + " × диск (" + Math.round(usable / n * 100) + "%)" : "—";

        var rowCls = !ok ? " class='raid-advisor-disabled'" : r.danger ? " class='raid-advisor-danger'" : "";
        var tag    = !ok
            ? "<span class='badge badge-secondary'>нужно ≥" + r.minDisks + (r.evenOnly ? " (чётное)" : "") + "</span>"
            : r.danger
                ? "<span class='badge badge-danger'>нет защиты</span>"
                : "<span class='badge badge-success'>доступен</span>";

        return "<tr" + rowCls + ">" +
            "<td><b>" + r.level + "</b> " + tag + "</td>" +
            "<td>" + fault + "</td>" +
            "<td>" + cap + "</td>" +
            "<td>" + (ok ? stars(r.read,  5) : "—") + "</td>" +
            "<td>" + (ok ? stars(r.write, 5) : "—") + "</td>" +
            "<td><small>" + r.useCase + "</small></td>" +
            "</tr>";
    }).join("");

    return "<div style='overflow-x:auto'>" +
        "<table><thead><tr>" +
        "<th>Тип RAID</th><th>Выдержит сбоев</th>" +
        "<th>Ёмкость (" + n + " дисков)</th>" +
        "<th>Чтение</th><th>Запись</th><th>Применение</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
        "<div class='alert alert-info' style='margin-top:12px;margin-bottom:8px;'>" +
        "📌 Ёмкость для одинаковых дисков. При разных размерах — по наименьшему." +
        "</div>" +
        "<div class='alert alert-warning' style='margin-bottom:0;'>" +
        "💡 <b>Нужна защита от 3 отказов?</b> Добавьте <b>горячий spare</b> к RAID 6: при первом сбое " +
        "spare автоматически подключается и начинает восстановление, пока вы ещё не заменили диск. " +
        "В итоге: 2 одновременных отказа + 1 автовосстанавливаемый. " +
        "В mdadm spare добавляется так же как обычный диск в полный массив: <code>mdadm /dev/mdX --add /dev/sdY</code>." +
        "</div>";
}

// ── Tab 2: builder — actual disk configurations ───────────────────────────────

function buildBuilderTab(dataDisks) {
    var n = dataDisks.length;
    if (n === 0) return "<p class='text-muted' style='padding:16px 0;'>Нет данных о физических дисках.</p>";

    var minBytes    = Math.min.apply(null, dataDisks.map(function(d) { return d.sizeBytes; }));
    var maxBytes    = Math.max.apply(null, dataDisks.map(function(d) { return d.sizeBytes; }));
    var mixedSizes  = (maxBytes - minBytes) > 1e9;

    // ── Disk inventory ────────────────────────────────────────────────────────
    var diskRows = dataDisks.map(function(d) {
        var inArray = null;
        currentArrays.forEach(function(arr) {
            arr.devices.forEach(function(dev) { if (dev.name === d.name) inArray = arr.name; });
        });
        var gb = (d.sizeBytes / 1e9).toFixed(1);
        return "<tr>" +
            "<td><b>/dev/" + d.name + "</b></td>" +
            "<td>" + gb + " GB</td>" +
            "<td>" + (inArray
                ? "<span class='badge badge-info'>" + inArray + "</span>"
                : "<span class='badge badge-secondary'>свободен</span>") + "</td>" +
            "</tr>";
    }).join("");

    var inventoryHtml =
        "<table style='width:auto;margin-bottom:6px;'>" +
        "<thead><tr><th>Диск</th><th>Размер</th><th>Использование</th></tr></thead>" +
        "<tbody>" + diskRows + "</tbody></table>" +
        (mixedSizes
            ? "<p style='font-size:12px;color:var(--color-muted);margin:4px 0 0;'>" +
              "⚠ Диски разного размера — ёмкость рассчитана по наименьшему (" + (minBytes/1e9).toFixed(1) + " GB).</p>"
            : "");

    // ── Config cards ──────────────────────────────────────────────────────────
    var cards = RAID_TYPES.map(function(r) {
        var ok = n >= r.minDisks && (!r.evenOnly || n % 2 === 0);
        if (!ok) return null;

        var usableDrives = r.usable(n);
        var usableGB     = (usableDrives * minBytes / 1e9).toFixed(1);
        var efficiency   = Math.round(usableDrives / n * 100);
        var fault        = r.fault(n);

        var normalized = r.level.toLowerCase().replace(/[^a-z0-9]/g, "");
        var isCurrent  = currentArrays.some(function(arr) { return arr.level === normalized; });

        var headerStyle = isCurrent ? "background:var(--info-light);border-color:var(--info-border);"
                        : r.danger  ? "background:var(--danger-light);border-color:var(--danger-border);"
                        : "";

        var statusBadge = isCurrent
            ? "<span class='badge badge-info'>● текущий массив</span>"
            : r.danger
                ? "<span class='badge badge-danger'>нет защиты</span>"
                : "<span class='badge badge-success'>можно создать</span>";

        return "<div class='array-card' style='" + headerStyle + "margin-bottom:8px;'>" +
            "<div style='display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:8px;'>" +
                "<div><span class='array-name'>" + r.level + "</span> " + statusBadge + "</div>" +
                "<div style='font-size:22px;font-weight:700;color:var(--primary);'>" + usableGB + " GB</div>" +
            "</div>" +
            "<div style='display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:13px;margin-bottom:8px;'>" +
                "<div><span class='text-muted'>Сбоев:</span> <b>" + fault + "</b></div>" +
                "<div><span class='text-muted'>КПД:</span> <b>" + efficiency + "%</b></div>" +
                "<div><span class='text-muted'>Чт/Зп:</span> " + stars(r.read,5) + "/" + stars(r.write,5) + "</div>" +
            "</div>" +
            "<div style='font-size:12px;color:var(--color-muted);'>" + r.useCase + "</div>" +
            "</div>";
    }).filter(Boolean).join("");

    // ── RAID 6 + spare card (needs n >= 5: 4 for RAID6 + 1 spare) ────────────
    var spareCard = "";
    if (n >= 5) {
        // N-1 disks in RAID 6, 1 as hot spare
        var r6drives  = n - 1;
        var r6usable  = r6drives - 2;
        var r6GB      = (r6usable * minBytes / 1e9).toFixed(1);
        var r6eff     = Math.round(r6usable / n * 100);
        spareCard = "<div class='array-card' style='background:var(--success-light);border-color:var(--success-border);margin-bottom:8px;'>" +
            "<div style='display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:8px;'>" +
                "<div><span class='array-name'>RAID 6 + spare</span> <span class='badge badge-success'>максимальная защита</span></div>" +
                "<div style='font-size:22px;font-weight:700;color:var(--primary);'>" + r6GB + " GB</div>" +
            "</div>" +
            "<div style='display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:13px;margin-bottom:8px;'>" +
                "<div><span class='text-muted'>Сбоев:</span> <b>2 + 1 авто</b></div>" +
                "<div><span class='text-muted'>КПД:</span> <b>" + r6eff + "%</b></div>" +
                "<div><span class='text-muted'>Чт/Зп:</span> " + stars(4,5) + "/" + stars(2,5) + "</div>" +
            "</div>" +
            "<div style='font-size:12px;color:var(--color-muted);'>" +
                r6drives + " дисков в RAID 6 + 1 горячий spare. " +
                "Spare автоматически запускает восстановление при первом сбое, пока вы ищете замену." +
            "</div>" +
            "</div>";
    }

    return "<div style='display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;'>" +
        "<div>" + inventoryHtml + "</div>" +
        "</div>" +
        "<h4 style='margin:16px 0 10px;font-size:14px;border-bottom:1px solid var(--color-border);padding-bottom:8px;'>" +
            "Возможные конфигурации из " + n + " дисков:" +
        "</h4>" +
        cards + spareCard;
}

// ─── Create array ─────────────────────────────────────────────────────────────

var RAID_MIN_DISKS = { "0": 2, "1": 2, "5": 3, "6": 4, "10": 4 };

function openCreateArrayModal() {
    // Reset to step 1
    document.getElementById("create-step1").classList.remove("hidden");
    document.getElementById("create-step2").classList.add("hidden");
    document.getElementById("create-done-btn").classList.add("hidden");
    document.getElementById("create-log").textContent = "";

    // Populate checkboxes with free disks (not sda, not in array)
    var freeDisksList = currentDisks.filter(function(d) { return d.name !== "sda" && !d.array; });
    var container = document.getElementById("create-disks-checkboxes");
    if (freeDisksList.length === 0) {
        container.innerHTML = "<span class='text-muted'>Нет свободных дисков</span>";
    } else {
        container.innerHTML = freeDisksList.map(function(d) {
            return "<label style='display:flex;align-items:center;gap:4px;padding:4px 8px;border:1px solid var(--color-border);border-radius:4px;cursor:pointer'>" +
                "<input type='checkbox' class='create-disk-cb' value='" + d.name + "'> " +
                "<b>/dev/" + d.name + "</b> <small class='text-muted'>(" + d.size + ")</small>" +
                "</label>";
        }).join("");
        // Listen for checkbox changes to validate
        container.querySelectorAll(".create-disk-cb").forEach(function(cb) {
            cb.addEventListener("change", validateCreateForm);
        });
    }
    validateCreateForm();
    showModal("modal-create-array");
}

function validateCreateForm() {
    var level = document.getElementById("create-raid-level").value;
    var minDisks = RAID_MIN_DISKS[level] || 2;
    var checked = document.querySelectorAll(".create-disk-cb:checked").length;
    var needEven = level === "10";
    var hint = document.getElementById("create-disks-hint");
    var warning = document.getElementById("create-disks-warning");
    var nextBtn = document.getElementById("create-step1-next");

    hint.textContent = "(мин. " + minDisks + (needEven ? ", чётное число)" : ")");

    var valid = checked >= minDisks && (!needEven || checked % 2 === 0);
    if (!valid && checked > 0) {
        warning.textContent = needEven && checked % 2 !== 0
            ? "RAID 10 требует чётного числа дисков"
            : "Выберите минимум " + minDisks + " дисков";
    } else {
        warning.textContent = "";
    }
    nextBtn.disabled = !valid || checked === 0;
}

function appendCreateLog(msg) {
    var log = document.getElementById("create-log");
    log.textContent += msg + "\n";
    log.scrollTop = log.scrollHeight;
}

function startCreateArray() {
    var level = document.getElementById("create-raid-level").value;
    var mountPoint = document.getElementById("create-mountpoint").value.trim() || "/mnt/data";
    var label = document.getElementById("create-fslabel").value.trim() || "rusnas-data";
    var selectedDisks = [];
    document.querySelectorAll(".create-disk-cb:checked").forEach(function(cb) {
        selectedDisks.push("/dev/" + cb.value);
    });

    // Switch to step 2
    document.getElementById("create-step1").classList.add("hidden");
    document.getElementById("create-step2").classList.remove("hidden");

    var logEl = document.getElementById("create-log");
    logEl.textContent = "";

    function log(msg) { appendCreateLog(msg); }

    // Find free md device name
    log("▶ Поиск свободного имени md...");
    cockpit.spawn(["bash", "-c",
        "for i in 0 1 2 3 4 5 6 7 8 9; do [ ! -e /dev/md$i ] && echo md$i && break; done"
    ], {superuser: "require"})
    .done(function(out) {
        var mdName = out.trim();
        if (!mdName) { log("✗ Не удалось найти свободное имя md-устройства"); return; }
        log("✓ Устройство: /dev/" + mdName);

        var numDisks = selectedDisks.length;
        var createCmd = "mdadm --create /dev/" + mdName +
            " --level=" + level +
            " --raid-devices=" + numDisks +
            " " + selectedDisks.join(" ") +
            " --force --run";

        log("▶ Создание массива: " + createCmd);
        cockpit.spawn(["bash", "-c", "sudo " + createCmd + " 2>&1"], {superuser: "require"})
        .done(function(out2) {
            log("✓ Массив создан\n" + out2.trim());

            log("▶ Сохранение конфигурации mdadm...");
            cockpit.spawn(["bash", "-c",
                "sudo mdadm --detail --scan | grep " + mdName + " >> /etc/mdadm/mdadm.conf 2>&1 || true"
            ], {superuser: "require"})
            .always(function() {
                log("✓ Конфигурация сохранена");

                log("▶ Создание точки монтирования: " + mountPoint);
                cockpit.spawn(["bash", "-c", "sudo mkdir -p " + mountPoint], {superuser: "require"})
                .done(function() {
                    log("✓ Каталог создан");

                    log("▶ Форматирование Btrfs (" + label + ")...");
                    cockpit.spawn(["bash", "-c",
                        "sudo mkfs.btrfs -L " + label + " -f /dev/" + mdName + " 2>&1"
                    ], {superuser: "require"})
                    .done(function(out3) {
                        log("✓ Файловая система создана\n" + out3.split("\n").slice(-3).join("\n").trim());

                        log("▶ Монтирование /dev/" + mdName + " → " + mountPoint + "...");
                        cockpit.spawn(["bash", "-c",
                            "sudo mount /dev/" + mdName + " " + mountPoint + " 2>&1"
                        ], {superuser: "require"})
                        .done(function() {
                            log("✓ Смонтирован");

                            log("▶ Добавление в /etc/fstab...");
                            cockpit.spawn(["bash", "-c",
                                "UUID=$(sudo blkid -s UUID -o value /dev/" + mdName + ") && " +
                                "grep -q \"$UUID\" /etc/fstab || " +
                                "echo \"UUID=$UUID " + mountPoint + " btrfs defaults,nofail 0 0\" | sudo tee -a /etc/fstab"
                            ], {superuser: "require"})
                            .done(function() {
                                log("✓ fstab обновлён");
                                log("\n✅ Массив /dev/" + mdName + " успешно создан и смонтирован в " + mountPoint);
                                document.getElementById("create-done-btn").classList.remove("hidden");
                                loadDisksAndArrays();
                            })
                            .fail(function(err) { log("✗ Ошибка fstab: " + err); document.getElementById("create-done-btn").classList.remove("hidden"); });
                        })
                        .fail(function(err) { log("✗ Ошибка монтирования: " + err); document.getElementById("create-done-btn").classList.remove("hidden"); });
                    })
                    .fail(function(err) { log("✗ Ошибка mkfs.btrfs: " + err); document.getElementById("create-done-btn").classList.remove("hidden"); });
                })
                .fail(function(err) { log("✗ Ошибка mkdir: " + err); document.getElementById("create-done-btn").classList.remove("hidden"); });
            });
        })
        .fail(function(err) { log("✗ Ошибка создания массива: " + err); document.getElementById("create-done-btn").classList.remove("hidden"); });
    })
    .fail(function(err) { log("✗ " + err); document.getElementById("create-done-btn").classList.remove("hidden"); });
}

// ─── Delete array ─────────────────────────────────────────────────────────────

var _deleteArrayDeps = null; // { mp, smb:[{name,path}], nfs:[path], schedules:[subvolPath] }

function scanArrayDeps(mp, callback) {
    var deps = { mp: mp, smb: [], nfs: [], schedules: [] };
    var pending = 3;
    function done() { if (--pending === 0) callback(deps); }

    // SMB: find shares whose path is under the mount point
    var smbScript = [
        "import re, sys",
        "mp = sys.argv[1]",
        "try:",
        "    txt = open('/etc/samba/smb.conf').read()",
        "    for s in re.split(r'(?=^\\[)', txt, flags=re.M):",
        "        nm = re.match(r'^\\[(.+?)\\]', s)",
        "        pm = re.search(r'^\\s*path\\s*=\\s*([^;\\n]+)', s, re.M)",
        "        if nm and pm:",
        "            n = nm.group(1).strip()",
        "            p = pm.group(1).strip()",
        "            if n not in ('global','homes','printers') and (p == mp or p.startswith(mp + '/')):",
        "                print(n + '|' + p)",
        "except Exception:",
        "    pass"
    ].join("\n");

    cockpit.file("/tmp/rusnas_dep_scan.py").replace(smbScript)
        .then(function() {
            cockpit.spawn(["sudo", "-n", "python3", "/tmp/rusnas_dep_scan.py", mp], {err: "message"})
                .done(function(out) {
                    out.trim().split("\n").filter(Boolean).forEach(function(l) {
                        var p = l.split("|");
                        deps.smb.push({ name: p[0], path: p[1] || "" });
                    });
                    done();
                })
                .fail(function() { done(); });
        })
        .catch(function() { done(); });

    // NFS: find exports matching the mount point
    cockpit.spawn(["bash", "-c",
        "grep -E '^" + mp + "(/|[[:space:]]|$)' /etc/exports 2>/dev/null | awk '{print $1}' || true"
    ], {err: "message"})
        .done(function(out) {
            out.trim().split("\n").filter(Boolean).forEach(function(p) { deps.nfs.push(p); });
            done();
        })
        .fail(function() { done(); });

    // Snapshot schedules: filter by subvol path
    cockpit.spawn(["sudo", "-n", "rusnas-snap", "schedule", "list"], {err: "message"})
        .done(function(out) {
            try {
                var parsed = JSON.parse(out);
                var list = Array.isArray(parsed) ? parsed : (parsed.schedules || []);
                list.forEach(function(s) {
                    if (s.subvol_path && (s.subvol_path === mp || s.subvol_path.startsWith(mp + "/"))) {
                        deps.schedules.push(s.subvol_path);
                    }
                });
            } catch (e) {}
            done();
        })
        .fail(function() { done(); });
}

function openDeleteArrayModal(arrayName, disksStr) {
    document.getElementById("delete-array-name").value = arrayName;
    document.getElementById("delete-array-label").textContent = arrayName;
    document.getElementById("delete-array-disks").textContent =
        (disksStr || "").split(",").map(function(d) { return "/dev/" + d; }).join(", ");
    document.getElementById("delete-array-log").classList.add("hidden");
    document.getElementById("delete-array-log").textContent = "";
    document.getElementById("delete-array-footer").classList.remove("hidden");

    // Reset deps
    _deleteArrayDeps = null;
    var depsEl   = document.getElementById("delete-array-deps");
    var depsList = document.getElementById("delete-array-deps-list");
    depsEl.classList.add("hidden");
    depsList.innerHTML = "<i>Сканирование...</i>";

    showModal("modal-delete-array");

    // Find mount point, then scan deps
    cockpit.spawn(["bash", "-c",
        "findmnt -n -o TARGET /dev/" + arrayName + " 2>/dev/null || true"
    ], {err: "message"})
        .done(function(mpOut) {
            var mp = mpOut.trim();
            if (!mp) { depsList.innerHTML = ""; return; }

            scanArrayDeps(mp, function(deps) {
                _deleteArrayDeps = deps;
                var items = [];
                deps.smb.forEach(function(s) {
                    items.push("📂 SMB-шара <b>" + _escHtml(s.name) + "</b> (" + _escHtml(s.path) + ")");
                });
                deps.nfs.forEach(function(p) {
                    items.push("🔗 NFS-экспорт <b>" + _escHtml(p) + "</b>");
                });
                deps.schedules.forEach(function(p) {
                    items.push("🕐 Расписание снапшотов: <b>" + _escHtml(p) + "</b>");
                });

                if (items.length > 0) {
                    depsList.innerHTML = items.map(function(i) {
                        return "<div style='padding:2px 0'>" + i + "</div>";
                    }).join("");
                    depsEl.classList.remove("hidden");
                } else {
                    depsList.innerHTML = "";
                }
            });
        })
        .fail(function() { depsList.innerHTML = ""; });
}

function doDeleteArray() {
    var arrayName = document.getElementById("delete-array-name").value;
    var log = document.getElementById("delete-array-log");
    log.classList.remove("hidden");
    document.getElementById("delete-array-footer").classList.add("hidden");

    function append(msg) { log.textContent += msg + "\n"; log.scrollTop = log.scrollHeight; }

    var deps = _deleteArrayDeps; // may be null if not mounted

    // Find members first, then proceed
    cockpit.spawn(["bash", "-c",
        "sudo mdadm --detail /dev/" + arrayName + " 2>/dev/null | grep '/dev/sd' | awk '{print $NF}' | tr '\\n' ' '"
    ], {superuser: "require"})
    .done(function(memberOut) {
        var members = memberOut.trim().split(/\s+/).filter(Boolean);

        var chain = Promise.resolve();

        // ── Clean up associated resources (SMB, NFS, snapshots) ──────────────
        if (deps && deps.smb.length > 0) {
            chain = chain.then(function() {
                append("▶ Удаление SMB-шар...");
                var smbNames = deps.smb.map(function(s) { return s.name; });
                // Build sed commands: delete each [name] section
                var sedCmds = smbNames.map(function(n) {
                    var esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    return "sudo sed -i '/^\\[" + esc + "\\]/,/^\\[/{/^\\[" + esc + "\\]/d;/^\\[/!d}' /etc/samba/smb.conf";
                }).join(" && ");
                sedCmds += " && sudo systemctl reload smbd 2>/dev/null || true";
                return new Promise(function(resolve) {
                    cockpit.spawn(["bash", "-c", sedCmds], {superuser: "require"})
                        .done(function() { append("✓ SMB-шары удалены: " + smbNames.join(", ")); resolve(); })
                        .fail(function(e) { append("⚠ SMB: " + e); resolve(); });
                });
            });
        }

        if (deps && deps.nfs.length > 0) {
            chain = chain.then(function() {
                append("▶ Удаление NFS-экспортов...");
                var sedCmds = deps.nfs.map(function(p) {
                    return "sudo sed -i '\\|^" + p + "\\s|d' /etc/exports";
                }).join(" && ");
                sedCmds += " && sudo exportfs -ra 2>/dev/null || true";
                return new Promise(function(resolve) {
                    cockpit.spawn(["bash", "-c", sedCmds], {superuser: "require"})
                        .done(function() { append("✓ NFS-экспорты удалены"); resolve(); })
                        .fail(function(e) { append("⚠ NFS: " + e); resolve(); });
                });
            });
        }

        if (deps && deps.schedules.length > 0) {
            chain = chain.then(function() {
                append("▶ Удаление расписаний снапшотов...");
                var deleteChain = Promise.resolve();
                deps.schedules.forEach(function(subvolPath) {
                    deleteChain = deleteChain.then(function() {
                        return new Promise(function(resolve) {
                            cockpit.spawn(["sudo", "-n", "rusnas-snap", "schedule", "delete", subvolPath], {err: "message"})
                                .done(function() { resolve(); })
                                .fail(function() { resolve(); });
                        });
                    });
                });
                return deleteChain.then(function() {
                    append("✓ Расписания удалены: " + deps.schedules.join(", "));
                });
            });
        }

        // ── Standard array teardown ───────────────────────────────────────────
        chain = chain.then(function() {
            append("▶ Определение точки монтирования...");
            return new Promise(function(resolve) {
                cockpit.spawn(["bash", "-c",
                    "findmnt -n -o TARGET /dev/" + arrayName + " 2>/dev/null || true"
                ], {superuser: "require"})
                .done(function(mpOut) { resolve(mpOut.trim()); })
                .fail(function() { resolve(""); });
            });
        });

        chain = chain.then(function(mp) {
            var inner = Promise.resolve();

            if (mp) {
                inner = inner.then(function() {
                    append("▶ Размонтирование " + mp + "...");
                    return new Promise(function(resolve) {
                        cockpit.spawn(["bash", "-c", "sudo umount " + mp + " 2>&1 || true"],
                            {superuser: "require"})
                            .done(function() { append("✓ Размонтирован"); resolve(); })
                            .fail(function() { resolve(); });
                    });
                });
            }

            inner = inner.then(function() {
                append("▶ Удаление записи из /etc/fstab...");
                return new Promise(function(resolve) {
                    cockpit.spawn(["bash", "-c",
                        "UUID=$(sudo blkid -s UUID -o value /dev/" + arrayName + " 2>/dev/null || true) && " +
                        "[ -n \"$UUID\" ] && sudo sed -i \"/UUID=$UUID/d\" /etc/fstab 2>/dev/null || true"
                    ], {superuser: "require"})
                        .done(function() { append("✓ fstab очищен"); resolve(); })
                        .fail(function() { resolve(); });
                });
            });

            inner = inner.then(function() {
                append("▶ Остановка массива /dev/" + arrayName + "...");
                return new Promise(function(resolve) {
                    cockpit.spawn(["bash", "-c", "sudo mdadm --stop /dev/" + arrayName + " 2>&1"],
                        {superuser: "require"})
                        .done(function(o) { append("✓ " + (o.trim() || "Остановлен")); resolve(); })
                        .fail(function(e) { append("⚠ " + e); resolve(); });
                });
            });

            inner = inner.then(function() {
                append("▶ Очистка суперблоков...");
                var zeroCmds = members.map(function(dev) {
                    return "sudo mdadm --zero-superblock " + dev + " 2>/dev/null || true";
                }).join(" && ");
                return new Promise(function(resolve) {
                    cockpit.spawn(["bash", "-c", zeroCmds || "true"], {superuser: "require"})
                        .done(function() { append("✓ Суперблоки очищены: " + members.join(", ")); resolve(); })
                        .fail(function() { resolve(); });
                });
            });

            inner = inner.then(function() {
                append("\n✅ Массив удалён. Диски свободны.");
                loadDisksAndArrays();
                setTimeout(function() { closeModal("modal-delete-array"); }, 2000);
            });

            return inner;
        });

        chain.catch(function(err) { append("✗ Ошибка: " + err); });
    })
    .fail(function(err) { log.textContent = "✗ " + err; });
}

// ─── Mount / Umount array ─────────────────────────────────────────────────────

function openMountModal(arrayName) {
    document.getElementById("mount-array-name").value = arrayName;
    document.getElementById("mount-array-label").value = "/dev/" + arrayName;
    document.getElementById("mount-array-fsinfo").textContent = "Определение файловой системы...";

    cockpit.spawn(["bash", "-c",
        "sudo blkid -o value -s TYPE /dev/" + arrayName + " 2>/dev/null || true"
    ], {superuser: "require"})
    .done(function(out) {
        var fstype = out.trim();
        var info = document.getElementById("mount-array-fsinfo");
        var confirmBtn = document.getElementById("mount-array-confirm");
        if (!fstype) {
            info.innerHTML = "<span style='color:var(--danger)'>⚠ Файловая система не найдена. Сначала отформатируйте массив.</span>";
            confirmBtn.disabled = true;
        } else {
            info.textContent = "Файловая система: " + fstype;
            confirmBtn.disabled = false;
        }
    })
    .fail(function() {
        document.getElementById("mount-array-fsinfo").textContent = "";
    });

    showModal("modal-mount-array");
}

function doMountArray() {
    var arrayName  = document.getElementById("mount-array-name").value;
    var mountPoint = document.getElementById("mount-array-point").value.trim();
    if (!mountPoint) return;

    var btn = document.getElementById("mount-array-confirm");
    btn.disabled = true;
    btn.textContent = "Монтирование...";

    cockpit.spawn(["bash", "-c",
        "sudo mkdir -p " + mountPoint + " && sudo mount /dev/" + arrayName + " " + mountPoint + " 2>&1"
    ], {superuser: "require"})
    .done(function() {
        // Add to fstab if not already there
        cockpit.spawn(["bash", "-c",
            "UUID=$(sudo blkid -s UUID -o value /dev/" + arrayName + ") && " +
            "grep -q \"$UUID\" /etc/fstab || " +
            "echo \"UUID=$UUID " + mountPoint + " btrfs defaults,nofail 0 0\" | sudo tee -a /etc/fstab"
        ], {superuser: "require"});
        closeModal("modal-mount-array");
        btn.disabled = false;
        btn.textContent = "Смонтировать";
        loadDisksAndArrays();
    })
    .fail(function(err) {
        alert("Ошибка монтирования: " + err);
        btn.disabled = false;
        btn.textContent = "Смонтировать";
    });
}

function doUmountArray(arrayName, mountPoint) {
    if (!confirm("Размонтировать /dev/" + arrayName + " (" + mountPoint + ")?")) return;
    cockpit.spawn(["bash", "-c",
        "sudo umount " + mountPoint + " 2>&1"
    ], {superuser: "require"})
    .done(function() { loadDisksAndArrays(); })
    .fail(function(err) { alert("Ошибка размонтирования: " + err); });
}

// ─── Btrfs subvolumes ─────────────────────────────────────────────────────────

function openSubvolumesModal(mountPoint) {
    document.getElementById("subvol-mount-point").value = mountPoint;
    document.getElementById("subvol-new-name").value = "";
    showModal("modal-subvolumes");
    refreshSubvolumeList(mountPoint);
}

function refreshSubvolumeList(mountPoint) {
    var container = document.getElementById("subvol-list-container");
    container.innerHTML = "<p class='text-muted'>Загрузка...</p>";

    cockpit.spawn(
        ["btrfs", "subvolume", "list", mountPoint],
        {superuser: "require", err: "message"}
    )
    .done(function(out) {
        var lines = out.trim().split("\n").filter(Boolean);
        // Parse "ID 256 gen 7 top level 5 path homes", exclude .snapshots
        var subvols = lines.map(function(line) {
            var m = line.match(/path\s+(.+)$/);
            return m ? m[1].trim() : null;
        }).filter(function(path) {
            return path && path.indexOf(".snapshots") === -1;
        });

        if (subvols.length === 0) {
            container.innerHTML = "<p class='text-muted'>Субтома не найдены</p>";
            return;
        }

        var rows = subvols.map(function(path, i) {
            return "<tr>" +
                "<td><code>" + mountPoint + "/" + path + "</code></td>" +
                "<td><button class='btn btn-danger btn-sm' data-idx='" + i + "'>🗑</button></td>" +
                "</tr>";
        }).join("");

        container.innerHTML = "<table><thead><tr><th>Путь</th><th>Действие</th></tr></thead>" +
            "<tbody>" + rows + "</tbody></table>";

        container.querySelectorAll("[data-idx]").forEach(function(btn) {
            var path = subvols[parseInt(btn.dataset.idx, 10)];
            btn.addEventListener("click", function() {
                var mp = document.getElementById("subvol-mount-point").value;
                deleteSubvolume(mp, path);
            });
        });
    })
    .fail(function(err) {
        container.innerHTML = "<p class='text-muted'>Ошибка: " + err + "</p>";
    });
}

function createSubvolume() {
    var mountPoint = document.getElementById("subvol-mount-point").value;
    var name = document.getElementById("subvol-new-name").value.trim();
    if (!name) return;
    if (!/^[\w-]+$/.test(name)) { alert("Имя субтома может содержать только буквы, цифры и дефисы"); return; }

    var btn = document.getElementById("subvol-create-btn");
    btn.disabled = true;

    cockpit.spawn(["bash", "-c",
        "sudo btrfs subvolume create " + mountPoint + "/" + name + " 2>&1"
    ], {superuser: "require"})
    .done(function() {
        document.getElementById("subvol-new-name").value = "";
        btn.disabled = false;
        refreshSubvolumeList(mountPoint);
    })
    .fail(function(err) {
        alert("Ошибка создания субтома: " + err);
        btn.disabled = false;
    });
}

function deleteSubvolume(mountPoint, name) {
    if (!confirm("Удалить субтом " + name + "? Все данные в нём будут уничтожены.")) return;
    cockpit.spawn(
        ["btrfs", "subvolume", "delete", mountPoint + "/" + name],
        {superuser: "require", err: "message"}
    )
    .done(function() { refreshSubvolumeList(mountPoint); })
    .fail(function(err) { alert("Ошибка удаления: " + err); });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// ─── SSD-кеширование (dm-cache / LVM) ─────────────────────────────────────────

var SSD_TIERS_JSON = "/etc/rusnas/ssd-tiers.json";

// Returns Promise<string[]> of SSD candidate device paths
function getSsdCandidates() {
    return new Promise(function(resolve) {
        cockpit.spawn(["bash", "-c",
            "lsblk -d -o NAME,SIZE,ROTA,TYPE --json 2>/dev/null"
        ], { err: "message" })
        .done(function(out) {
            var allSsds = [];
            try {
                var data = JSON.parse(out);
                (data.blockdevices || []).forEach(function(d) {
                    if (d.type === "disk" && (d.rota === false || d.rota === "0" || d.rota === 0)) {
                        allSsds.push({ dev: "/dev/" + d.name, size: d.size });
                    }
                });
            } catch(e) { /* ignore */ }

            // Filter out disks already in any mdadm array
            cockpit.spawn(["bash", "-c", "cat /proc/mdstat 2>/dev/null || true"], { err: "message" })
            .done(function(mdstat) {
                var usedDisks = [];
                var lines = mdstat.split("\n");
                lines.forEach(function(line) {
                    var m = line.match(/sd[a-z]+\[\d+\]/g);
                    if (m) m.forEach(function(x) {
                        usedDisks.push("/dev/" + x.replace(/\[\d+\]/, ""));
                    });
                });
                var candidates = allSsds.filter(function(d) {
                    return usedDisks.indexOf(d.dev) === -1;
                });
                resolve(candidates);
            })
            .fail(function() { resolve(allSsds); });
        })
        .fail(function() { resolve([]); });
    });
}

// Returns Promise<{hit_rate, cache_pct, mode}> for a given VG/LV
function getSsdTierStatus(vgName, lvName) {
    return new Promise(function(resolve) {
        cockpit.spawn(["bash", "-c",
            "sudo -n lvs --noheadings --units g " +
            "-o lv_name,cache_read_hits,cache_read_misses,cache_write_hits,cache_write_misses,cache_used_blocks,cache_total_blocks,cache_mode " +
            vgName + " 2>/dev/null || true"
        ], { err: "message" })
        .done(function(out) {
            var result = { hit_rate: 0, cache_pct: 0, mode: "writethrough" };
            out.split("\n").forEach(function(line) {
                var parts = line.trim().split(/\s+/);
                // lv_name r_hits r_misses w_hits w_misses used_blocks total_blocks mode
                if (parts.length >= 8 && parts[0] === lvName) {
                    var rHits   = parseFloat(parts[1]) || 0;
                    var rMisses = parseFloat(parts[2]) || 0;
                    var total   = rHits + rMisses;
                    result.hit_rate   = total > 0 ? Math.round(rHits / total * 100) : 0;
                    var used  = parseFloat(parts[5]) || 0;
                    var tot   = parseFloat(parts[6]) || 1;
                    result.cache_pct  = tot > 0 ? Math.round(used / tot * 100) : 0;
                    result.mode       = (parts[7] || "writethrough").replace(/\s/g, "");
                }
            });
            resolve(result);
        })
        .fail(function() { resolve({ hit_rate: 0, cache_pct: 0, mode: "writethrough" }); });
    });
}

function renderSsdTiers(tiers) {
    var tbody = document.getElementById("ssd-tiers-body");
    if (!tiers || tiers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--color-muted)">' +
            'SSD-кеш не настроен. Нажмите <b>+ Добавить SSD-кеш</b> для ускорения HDD-массива.</td></tr>';
        return;
    }
    tbody.innerHTML = tiers.map(function(t) {
        var modeHtml = t.mode === "writeback"
            ? '<span class="ssd-mode-wb">Быстрый (writeback) ⚠</span>'
            : '<span class="ssd-mode-wt">Безопасный (writethrough) ✓</span>';

        var hitRate  = t._status ? t._status.hit_rate  : 0;
        var cachePct = t._status ? t._status.cache_pct : 0;

        var hitClass  = hitRate  < 50 ? "warn" : "";
        var cacheClass = cachePct > 90 ? "crit" : cachePct > 70 ? "warn" : "";

        var hitBar = '<span class="ssd-bar-wrap"><span class="ssd-bar-fill ' + hitClass + '" style="width:' + hitRate + '%"></span></span> ' + hitRate + '%';
        var cacheBar = '<span class="ssd-bar-wrap"><span class="ssd-bar-fill ' + cacheClass + '" style="width:' + cachePct + '%"></span></span> ' + cachePct + '%';

        return '<tr style="border-bottom:1px solid var(--color-border)">' +
            '<td style="padding:8px 12px">' + (t.backing_device || '—') + '</td>' +
            '<td style="padding:8px 12px">' + (t.cache_device || '—') + '</td>' +
            '<td style="padding:8px 12px">' + modeHtml + '</td>' +
            '<td style="padding:8px 12px">' + hitBar + '</td>' +
            '<td style="padding:8px 12px">' + cacheBar + '</td>' +
            '<td style="padding:8px 12px;text-align:right">' +
                '<button class="btn btn-secondary" style="font-size:12px;padding:3px 8px;margin-right:4px" ' +
                    'data-action="change-mode" data-vg="' + t.vg_name + '" data-lv="' + t.lv_name + '" data-mode="' + (t.mode || "writethrough") + '">' +
                    'Режим</button>' +
                '<button class="btn btn-danger" style="font-size:12px;padding:3px 8px" ' +
                    'data-action="remove-tier" data-vg="' + t.vg_name + '" data-lv="' + t.lv_name + '" data-backing="' + (t.backing_device || '') + '">' +
                    'Отключить</button>' +
            '</td></tr>';
    }).join("");
}

function loadSsdTiers() {
    cockpit.file(SSD_TIERS_JSON).read()
    .done(function(content) {
        var data;
        try { data = JSON.parse(content || '{"tiers":[]}'); }
        catch(e) { data = { tiers: [] }; }

        currentSsdTiers = data.tiers || [];

        if (currentSsdTiers.length === 0) {
            renderSsdTiers([]);
            return;
        }

        var statusPromises = currentSsdTiers.map(function(t) {
            return getSsdTierStatus(t.vg_name, t.lv_name);
        });

        Promise.all(statusPromises).then(function(statuses) {
            var merged = currentSsdTiers.map(function(t, i) {
                return Object.assign({}, t, { _status: statuses[i] });
            });
            renderSsdTiers(merged);
        });
    })
    .fail(function() {
        currentSsdTiers = [];
        renderSsdTiers([]);
    });
}

function openAddSsdTierModal() {
    // Check lvm2 is installed
    cockpit.spawn(["bash", "-c", "which lvconvert && which pvs 2>/dev/null; echo $?"], { err: "message" })
    .done(function(out) {
        var exitCode = parseInt((out.trim().split("\n").pop()) || "1");
        if (exitCode !== 0) {
            document.getElementById("ssd-tier-alert").textContent =
                "Требуется пакет lvm2. Установите: sudo apt-get install lvm2 thin-provisioning-tools";
            document.getElementById("ssd-tier-alert").classList.remove("hidden");
            return;
        }
        document.getElementById("ssd-tier-alert").classList.add("hidden");

        // Populate backing device list from currentArrays
        var backingSelect = document.getElementById("ssd-backing-dev");
        backingSelect.innerHTML = "";
        if (currentArrays.length === 0) {
            backingSelect.innerHTML = '<option value="">— нет RAID массивов —</option>';
        } else {
            currentArrays.forEach(function(arr) {
                var opt = document.createElement("option");
                opt.value = "/dev/" + arr.name;
                opt.textContent = "/dev/" + arr.name +
                    " — RAID" + arr.level + ", " + arr.total + " дисков";
                backingSelect.appendChild(opt);
            });
        }

        // Populate SSD list
        var cacheSelect = document.getElementById("ssd-cache-dev");
        cacheSelect.innerHTML = '<option value="">Сканирование…</option>';

        getSsdCandidates().then(function(ssds) {
            cacheSelect.innerHTML = "";
            if (ssds.length === 0) {
                cacheSelect.innerHTML = '<option value="">— нет доступных SSD —</option>';
            } else {
                ssds.forEach(function(s) {
                    var opt = document.createElement("option");
                    opt.value = s.dev;
                    opt.textContent = s.dev + " (" + s.size + ")";
                    cacheSelect.appendChild(opt);
                });
            }
        });

        // Reset form state
        document.getElementById("ssd-mode-wt").checked = true;
        document.getElementById("ssd-writeback-warn").classList.add("hidden");
        document.getElementById("ssd-writeback-confirm").checked = false;
        document.getElementById("ssd-backup-confirm").checked = false;
        document.getElementById("ssd-add-log").classList.add("hidden");
        document.getElementById("ssd-add-log").textContent = "";
        document.getElementById("btn-confirm-add-tier").disabled = false;
        document.getElementById("btn-confirm-add-tier").textContent = "Добавить";
        showModal("modal-add-ssd-tier");
    })
    .fail(function() {
        document.getElementById("ssd-tier-alert").textContent =
            "Не удалось проверить наличие lvm2. Установите: sudo apt-get install lvm2";
        document.getElementById("ssd-tier-alert").classList.remove("hidden");
    });
}

function appendSsdLog(logId, msg) {
    var el = document.getElementById(logId);
    el.classList.remove("hidden");
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
}

function doCreateSsdTier() {
    var backingDev = document.getElementById("ssd-backing-dev").value;
    var cacheDev   = document.getElementById("ssd-cache-dev").value;
    var mode       = document.querySelector('input[name="ssd-mode"]:checked').value;
    var backupOk   = document.getElementById("ssd-backup-confirm").checked;

    if (!backingDev || !cacheDev) { alert("Выберите массив и SSD-диск"); return; }
    if (!backupOk) { alert("Подтвердите наличие резервной копии"); return; }
    if (mode === "writeback" && !document.getElementById("ssd-writeback-confirm").checked) {
        alert("Подтвердите использование ИБП для режима writeback"); return;
    }

    var btn = document.getElementById("btn-confirm-add-tier");
    btn.disabled = true;
    btn.textContent = "Выполняется…";
    document.getElementById("btn-cancel-add-tier").disabled = true;

    var logId = "ssd-add-log";
    document.getElementById(logId).textContent = "";

    // Determine VG name: rusnas_vg<N>
    cockpit.spawn(["bash", "-c",
        "sudo -n vgs --noheadings -o vg_name 2>/dev/null | grep -c rusnas_vg || echo 0"
    ], { err: "message" })
    .done(function(countOut) {
        var n = parseInt(countOut.trim()) || 0;
        var vgName = "rusnas_vg" + n;

        appendSsdLog(logId, "[1/8] Создание PV на " + backingDev + "...");
        cockpit.spawn(["sudo", "-n", "pvcreate", "-f", backingDev], { err: "message" })
        .done(function() {
            appendSsdLog(logId, "[2/8] Создание PV на " + cacheDev + "...");
            cockpit.spawn(["sudo", "-n", "pvcreate", "-f", cacheDev], { err: "message" })
            .done(function() {
                appendSsdLog(logId, "[3/8] Создание VG " + vgName + "...");
                cockpit.spawn(["sudo", "-n", "vgcreate", vgName, backingDev, cacheDev], { err: "message" })
                .done(function() {
                    appendSsdLog(logId, "[4/8] Создание основного LV (data_lv) на " + backingDev + "...");
                    cockpit.spawn(["sudo", "-n", "lvcreate", "-l", "100%PVS", "-n", "data_lv", vgName, backingDev], { err: "message" })
                    .done(function() {
                        appendSsdLog(logId, "[5/8] Создание cache_meta LV (512M) на " + cacheDev + "...");
                        cockpit.spawn(["sudo", "-n", "lvcreate", "-L", "512M", "-n", "cache_meta", vgName, cacheDev], { err: "message" })
                        .done(function() {
                            appendSsdLog(logId, "[6/8] Создание cache_data LV на " + cacheDev + "...");
                            cockpit.spawn(["sudo", "-n", "lvcreate", "-l", "100%FREE", "-n", "cache_data", vgName, cacheDev], { err: "message" })
                            .done(function() {
                                appendSsdLog(logId, "[7/8] Создание cache-pool...");
                                cockpit.spawn(["sudo", "-n", "lvconvert", "--yes", "--type", "cache-pool",
                                    "--poolmetadata", vgName + "/cache_meta",
                                    vgName + "/cache_data"
                                ], { err: "message" })
                                .done(function() {
                                    appendSsdLog(logId, "[8/8] Применение кеша к data_lv (режим " + mode + ")...");
                                    cockpit.spawn(["sudo", "-n", "lvconvert", "--yes", "--type", "cache",
                                        "--cachepool", vgName + "/cache_data",
                                        "--cachemode", mode,
                                        vgName + "/data_lv"
                                    ], { err: "message" })
                                    .done(function() {
                                        appendSsdLog(logId, "✓ SSD-кеш настроен успешно!");
                                        // Save to ssd-tiers.json
                                        var tier = {
                                            vg_name:        vgName,
                                            lv_name:        "data_lv",
                                            cache_device:   cacheDev,
                                            backing_device: backingDev,
                                            mode:           mode,
                                            created_at:     new Date().toISOString()
                                        };
                                        saveSsdTier(tier, function() {
                                            btn.textContent = "Готово ✓";
                                            document.getElementById("btn-cancel-add-tier").disabled = false;
                                            document.getElementById("btn-cancel-add-tier").textContent = "Закрыть";
                                            loadSsdTiers();
                                        });
                                    })
                                    .fail(function(err) { ssdCreateFail(logId, btn, vgName, "[8/8] Ошибка lvconvert cache: " + err); });
                                })
                                .fail(function(err) { ssdCreateFail(logId, btn, vgName, "[7/8] Ошибка lvconvert cache-pool: " + err); });
                            })
                            .fail(function(err) { ssdCreateFail(logId, btn, vgName, "[6/8] Ошибка lvcreate cache_data: " + err); });
                        })
                        .fail(function(err) { ssdCreateFail(logId, btn, vgName, "[5/8] Ошибка lvcreate cache_meta: " + err); });
                    })
                    .fail(function(err) { ssdCreateFail(logId, btn, vgName, "[4/8] Ошибка lvcreate data_lv: " + err); });
                })
                .fail(function(err) { ssdCreateFail(logId, btn, vgName, "[3/8] Ошибка vgcreate: " + err); });
            })
            .fail(function(err) { ssdCreateFail(logId, btn, null, "[2/8] Ошибка pvcreate SSD: " + err); });
        })
        .fail(function(err) { ssdCreateFail(logId, btn, null, "[1/8] Ошибка pvcreate HDD: " + err); });
    })
    .fail(function(err) {
        btn.disabled = false;
        btn.textContent = "Добавить";
        document.getElementById("btn-cancel-add-tier").disabled = false;
        appendSsdLog(logId, "Ошибка: " + err);
    });
}

function ssdCreateFail(logId, btn, vgName, errMsg) {
    appendSsdLog(logId, "✗ " + errMsg);
    appendSsdLog(logId, "Выполняется откат...");
    btn.disabled = false;
    btn.textContent = "Добавить";
    document.getElementById("btn-cancel-add-tier").disabled = false;
    if (vgName) {
        cockpit.spawn(["sudo", "-n", "vgremove", "-f", vgName], { err: "message" })
        .done(function()  { appendSsdLog(logId, "Откат выполнен: VG удалена."); })
        .fail(function()  { appendSsdLog(logId, "Откат не выполнен — удалите VG вручную: sudo vgremove -f " + vgName); });
    }
}

function saveSsdTier(newTier, cb) {
    cockpit.file(SSD_TIERS_JSON).read()
    .done(function(content) {
        var data;
        try { data = JSON.parse(content || '{"tiers":[]}'); }
        catch(e) { data = { tiers: [] }; }
        data.tiers.push(newTier);
        cockpit.file(SSD_TIERS_JSON, { superuser: "require" })
            .replace(JSON.stringify(data, null, 2))
            .done(cb)
            .fail(function(err) { alert("Ошибка сохранения конфигурации: " + err); });
    })
    .fail(function() {
        var data = { tiers: [newTier] };
        cockpit.file(SSD_TIERS_JSON, { superuser: "require" })
            .replace(JSON.stringify(data, null, 2))
            .done(cb)
            .fail(function(err) { alert("Ошибка сохранения конфигурации: " + err); });
    });
}

function removeSsdTierFromJson(vgName, cb) {
    cockpit.file(SSD_TIERS_JSON).read()
    .done(function(content) {
        var data;
        try { data = JSON.parse(content || '{"tiers":[]}'); }
        catch(e) { data = { tiers: [] }; }
        data.tiers = data.tiers.filter(function(t) { return t.vg_name !== vgName; });
        cockpit.file(SSD_TIERS_JSON, { superuser: "require" })
            .replace(JSON.stringify(data, null, 2))
            .done(cb)
            .fail(function(err) { alert("Ошибка сохранения конфигурации: " + err); });
    })
    .fail(function() { cb(); });
}

function openChangeModeModal(vgName, lvName, currentMode) {
    document.getElementById("change-mode-vg").value = vgName;
    document.getElementById("change-mode-lv").value = lvName;
    document.getElementById("change-mode-array-label").value = vgName + "/" + lvName;

    if (currentMode === "writeback") {
        document.getElementById("change-mode-wb").checked = true;
        document.getElementById("change-mode-wb-warn").classList.remove("hidden");
    } else {
        document.getElementById("change-mode-wt").checked = true;
        document.getElementById("change-mode-wb-warn").classList.add("hidden");
    }
    document.getElementById("btn-confirm-change-mode").disabled = false;
    document.getElementById("btn-confirm-change-mode").textContent = "Применить";
    showModal("modal-change-mode");
}

function doChangeCacheMode() {
    var vgName  = document.getElementById("change-mode-vg").value;
    var lvName  = document.getElementById("change-mode-lv").value;
    var newMode = document.querySelector('input[name="change-mode-radio"]:checked').value;

    var btn = document.getElementById("btn-confirm-change-mode");
    btn.disabled = true;
    btn.textContent = "Применяется…";

    cockpit.spawn(["sudo", "-n", "lvchange", "--cachemode", newMode, vgName + "/" + lvName], { err: "message" })
    .done(function() {
        // Update mode in JSON
        cockpit.file(SSD_TIERS_JSON).read()
        .done(function(content) {
            var data;
            try { data = JSON.parse(content || '{"tiers":[]}'); }
            catch(e) { data = { tiers: [] }; }
            data.tiers.forEach(function(t) {
                if (t.vg_name === vgName && t.lv_name === lvName) t.mode = newMode;
            });
            cockpit.file(SSD_TIERS_JSON, { superuser: "require" })
                .replace(JSON.stringify(data, null, 2))
                .done(function() {
                    closeModal("modal-change-mode");
                    loadSsdTiers();
                })
                .fail(function() {
                    closeModal("modal-change-mode");
                    loadSsdTiers();
                });
        })
        .fail(function() {
            closeModal("modal-change-mode");
            loadSsdTiers();
        });
    })
    .fail(function(err) {
        btn.disabled = false;
        btn.textContent = "Применить";
        alert("Ошибка смены режима: " + err);
    });
}

function openRemoveTierModal(vgName, lvName, backingDev) {
    document.getElementById("remove-tier-vg").value = vgName;
    document.getElementById("remove-tier-lv").value = lvName;
    document.getElementById("remove-tier-array-label").value = (backingDev || vgName) + " (" + vgName + "/" + lvName + ")";
    document.getElementById("remove-tier-log").classList.add("hidden");
    document.getElementById("remove-tier-log").textContent = "";
    document.getElementById("btn-confirm-remove-tier").disabled = false;
    document.getElementById("btn-confirm-remove-tier").textContent = "Отключить";
    document.getElementById("btn-cancel-remove-tier").disabled = false;
    showModal("modal-remove-ssd-tier");
}

function doRemoveSsdTier() {
    var vgName = document.getElementById("remove-tier-vg").value;
    var lvName = document.getElementById("remove-tier-lv").value;
    var logId  = "remove-tier-log";
    var btn    = document.getElementById("btn-confirm-remove-tier");

    btn.disabled = true;
    btn.textContent = "Отключается…";
    document.getElementById("btn-cancel-remove-tier").disabled = true;

    appendSsdLog(logId, "[1/3] Сброс dirty-блоков на HDD...");
    cockpit.spawn(["sudo", "-n", "lvchange", "--syncaction", "check", vgName + "/" + lvName], { err: "message" })
    .done(function() {
        appendSsdLog(logId, "[2/3] Отключение кеша (lvconvert --uncache)...");
        cockpit.spawn(["sudo", "-n", "lvconvert", "--yes", "--uncache", vgName + "/" + lvName], { err: "message" })
        .done(function() {
            appendSsdLog(logId, "[3/3] Удаление VG " + vgName + "...");
            cockpit.spawn(["sudo", "-n", "vgremove", "-f", vgName], { err: "message" })
            .done(function() {
                appendSsdLog(logId, "✓ SSD-кеш отключён.");
                removeSsdTierFromJson(vgName, function() {
                    btn.textContent = "Готово ✓";
                    document.getElementById("btn-cancel-remove-tier").disabled = false;
                    document.getElementById("btn-cancel-remove-tier").textContent = "Закрыть";
                    loadSsdTiers();
                });
            })
            .fail(function(err) {
                appendSsdLog(logId, "⚠ vgremove не удалось: " + err + ". Запустите вручную: sudo vgremove -f " + vgName);
                removeSsdTierFromJson(vgName, function() {
                    btn.disabled = false;
                    btn.textContent = "Отключить";
                    document.getElementById("btn-cancel-remove-tier").disabled = false;
                    loadSsdTiers();
                });
            });
        })
        .fail(function(err) {
            appendSsdLog(logId, "✗ Ошибка lvconvert --uncache: " + err);
            btn.disabled = false;
            btn.textContent = "Отключить";
            document.getElementById("btn-cancel-remove-tier").disabled = false;
        });
    })
    .fail(function(err) {
        // syncaction may not be supported in some LVM versions — try uncache anyway
        appendSsdLog(logId, "⚠ syncaction: " + err + " — продолжаем...");
        appendSsdLog(logId, "[2/3] Отключение кеша...");
        cockpit.spawn(["sudo", "-n", "lvconvert", "--yes", "--uncache", vgName + "/" + lvName], { err: "message" })
        .done(function() {
            appendSsdLog(logId, "[3/3] Удаление VG " + vgName + "...");
            cockpit.spawn(["sudo", "-n", "vgremove", "-f", vgName], { err: "message" })
            .done(function() {
                appendSsdLog(logId, "✓ SSD-кеш отключён.");
                removeSsdTierFromJson(vgName, function() {
                    btn.textContent = "Готово ✓";
                    document.getElementById("btn-cancel-remove-tier").disabled = false;
                    document.getElementById("btn-cancel-remove-tier").textContent = "Закрыть";
                    loadSsdTiers();
                });
            })
            .fail(function(err2) {
                appendSsdLog(logId, "✗ vgremove: " + err2);
                btn.disabled = false;
                btn.textContent = "Отключить";
                document.getElementById("btn-cancel-remove-tier").disabled = false;
            });
        })
        .fail(function(err2) {
            appendSsdLog(logId, "✗ lvconvert --uncache: " + err2);
            btn.disabled = false;
            btn.textContent = "Отключить";
            document.getElementById("btn-cancel-remove-tier").disabled = false;
        });
    });
}

// ─── END SSD-кеширование ──────────────────────────────────────────────────────

// ─── SMART Detail Modal ───────────────────────────────────────────────────────

var _smartModalDisk    = "";
var _smartTestPollTimer = null;

function openSmartModal(disk) {
    stopSmartTestPoll();
    _smartModalDisk = disk;
    document.getElementById("smart-modal-disk").textContent = "/dev/" + disk;
    document.getElementById("smart-modal-health").innerHTML = "<span style='color:var(--color-muted);font-size:13px'>Загрузка данных S.M.A.R.T.…</span>";
    document.getElementById("smart-modal-info").innerHTML = "";
    document.getElementById("smart-modal-attrs-body").innerHTML = "<tr><td colspan='8' style='padding:8px;color:var(--color-muted)'>Загрузка…</td></tr>";
    document.getElementById("smart-modal-errors").textContent = "Загрузка…";
    document.getElementById("smart-modal-tests").innerHTML = "<span style='color:var(--color-muted)'>Загрузка…</span>";
    document.getElementById("smart-sched-status").textContent = "";
    showModal("smart-detail-modal");

    cockpit.spawn(["sudo", "-n", "smartctl", "-a", "/dev/" + disk], {err: "message"})
    .done(function(out) {
        renderSmartModal(out);
        loadSmartSchedule(disk);
    })
    .fail(function(err, out) {
        var txt = out || err || "Ошибка получения данных";
        document.getElementById("smart-modal-health").innerHTML =
            "<span class='text-warning'>⚠ Не удалось получить данные: " + _escHtml(txt.split("\n")[0]) + "</span>";
        document.getElementById("smart-modal-attrs-body").innerHTML = "";
        document.getElementById("smart-modal-errors").textContent = "";
        document.getElementById("smart-modal-tests").innerHTML = "";
        loadSmartSchedule(disk);
    });
}

function renderSmartModal(out) {
    // ── Health ──────────────────────────────────────────────────────────────
    var healthM = out.match(/SMART overall-health self-assessment test result:\s*(\S+)/i);
    var health  = healthM ? healthM[1].toUpperCase() : null;
    var healthHtml = health === "PASSED"
        ? "<div style='display:inline-block;padding:6px 16px;border-radius:6px;background:#1a4a1a;color:#4caf50;font-weight:700;font-size:14px'>✓ PASSED — диск исправен</div>"
        : health
            ? "<div style='display:inline-block;padding:6px 16px;border-radius:6px;background:#4a1a1a;color:#f44336;font-weight:700;font-size:14px'>✗ " + _escHtml(health) + " — требуется внимание!</div>"
            : "<div style='color:var(--color-muted);font-size:13px'>Статус здоровья недоступен</div>";
    document.getElementById("smart-modal-health").innerHTML = healthHtml;

    // ── Device info ─────────────────────────────────────────────────────────
    var infoFields = [
        ["Модель",           out.match(/Device Model:\s*(.+)|Model Number:\s*(.+)/)],
        ["Серийный №",       out.match(/Serial Number:\s*(.+)/)],
        ["Прошивка",         out.match(/Firmware Version:\s*(.+)/)],
        ["Ёмкость",          out.match(/User Capacity:\s*(.+)/)],
        ["Размер сектора",   out.match(/Sector Size:\s*(.+)/)],
        ["Форм-фактор",      out.match(/Form Factor:\s*(.+)/)],
        ["Интерфейс",        out.match(/Transport protocol:\s*(.+)|ATA Version is:\s*(.+)/)],
        ["Ротация",          out.match(/Rotation Rate:\s*(.+)/)],
        ["TRIM",             out.match(/TRIM Command:\s*(.+)/)],
        ["Часов работы",     out.match(/Power_On_Hours.*?\s+(\d+)\s*$|Power_On_Hours.*?RAW_VALUE\s+(\d+)/)],
        ["Включений",        out.match(/Power_Cycle_Count.*?\s+(\d+)\s*$|Power_Cycle_Count.*?RAW_VALUE\s+(\d+)/)],
        ["Переназначено",    out.match(/Reallocated_Sector_Ct.*?\s+(\d+)\s*$|Reallocated_Sector_Ct.*?RAW_VALUE\s+(\d+)/)],
    ];
    var infoHtml = "";
    infoFields.forEach(function(f) {
        if (!f[1]) return;
        var val = (f[1][1] || f[1][2] || "").trim();
        if (!val || val === "—") return;
        infoHtml += "<div style='color:var(--color-muted);font-size:11px'>" + _escHtml(f[0]) + "</div>" +
                    "<div style='font-weight:500'>" + _escHtml(val) + "</div>";
    });
    document.getElementById("smart-modal-info").innerHTML = infoHtml || "<div style='color:var(--color-muted)'>Нет данных</div>";

    // ── Attributes table ────────────────────────────────────────────────────
    var attrRows = "";
    var attrRe = /^\s*(\d+)\s+(\S+)\s+\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\S+\s+(\S+)\s+(.*)/gm;
    var am;
    while ((am = attrRe.exec(out)) !== null) {
        var id        = am[1];
        var name      = am[2].replace(/_/g, " ");
        var value     = parseInt(am[3]);
        var worst     = parseInt(am[4]);
        var thresh    = parseInt(am[5]);
        var type      = am[6];
        var raw       = am[8];
        var failed    = value <= thresh && thresh > 0;
        var warn      = !failed && worst <= thresh && thresh > 0;
        var rowColor  = failed ? "color:#f44336" : warn ? "color:#ff9800" : "";
        var statusIco = failed ? "❌" : warn ? "⚠️" : "✓";
        var statusColor = failed ? "color:#f44336" : warn ? "color:#ff9800" : "color:#4caf50";
        attrRows += "<tr style='border-bottom:1px solid var(--color-border);" + rowColor + "'>" +
            "<td style='padding:4px 8px;font-family:monospace'>" + _escHtml(id) + "</td>" +
            "<td style='padding:4px 8px'>" + _escHtml(name) + "</td>" +
            "<td style='padding:4px 8px;text-align:center;font-family:monospace'>" + value + "</td>" +
            "<td style='padding:4px 8px;text-align:center;font-family:monospace'>" + worst + "</td>" +
            "<td style='padding:4px 8px;text-align:center;font-family:monospace'>" + thresh + "</td>" +
            "<td style='padding:4px 8px;font-size:11px;color:var(--color-muted)'>" + _escHtml(type) + "</td>" +
            "<td style='padding:4px 8px;text-align:right;font-family:monospace'>" + _escHtml(raw) + "</td>" +
            "<td style='padding:4px 8px;text-align:center;" + statusColor + "'>" + statusIco + "</td>" +
            "</tr>";
    }
    document.getElementById("smart-modal-attrs-body").innerHTML =
        attrRows || "<tr><td colspan='8' style='padding:8px;color:var(--color-muted)'>Атрибуты недоступны</td></tr>";

    // ── Error log ────────────────────────────────────────────────────────────
    var errM = out.match(/SMART Error Log[\s\S]*?(?=\n===|\n\nSMART|\nSMART Self-test|$)/i);
    var errText = errM ? errM[0].trim() : "";
    if (!errText || errText.indexOf("No Errors Logged") !== -1) {
        errText = "✓ Ошибок не обнаружено";
    }
    document.getElementById("smart-modal-errors").textContent = errText;

    // ── Self-test log → таблица ──────────────────────────────────────────────
    document.getElementById("smart-modal-tests").innerHTML = renderTestHistory(out);

    // ── Если тест сейчас выполняется — запустить поллинг ────────────────────
    if (out.indexOf("Self test in progress") !== -1 || out.indexOf("self-test in progress") !== -1) {
        startSmartTestPoll();
    }
}

function renderTestHistory(out) {
    var rows = "";
    // Формат строки: # 1  Short offline       Completed without error       00%       100         -
    var re = /#\s*(\d+)\s+([\w ]+?)\s{2,}([\w ()]+?)\s{2,}(\d+%)\s+(\d+)\s+(\S+)/g;
    var m;
    while ((m = re.exec(out)) !== null) {
        var num    = m[1];
        var type   = m[2].trim();
        var status = m[3].trim();
        var rem    = m[4];
        var hours  = m[5];
        var lba    = m[6] === "-" ? "—" : m[6];
        var ok     = status.toLowerCase().indexOf("completed without error") !== -1;
        var ico    = ok ? "✓" : "✗";
        var color  = ok ? "#4caf50" : "#f44336";
        rows += "<tr style='border-bottom:1px solid var(--color-border)'>" +
            "<td style='padding:4px 8px;font-family:monospace'>" + _escHtml(num) + "</td>" +
            "<td style='padding:4px 8px'>" + _escHtml(type) + "</td>" +
            "<td style='padding:4px 8px;color:" + color + "'>" + ico + " " + _escHtml(status) + "</td>" +
            "<td style='padding:4px 8px;text-align:center'>" + rem + "</td>" +
            "<td style='padding:4px 8px;text-align:right;font-family:monospace'>" + _escHtml(hours) + "</td>" +
            "<td style='padding:4px 8px;font-family:monospace'>" + _escHtml(lba) + "</td>" +
            "</tr>";
    }
    if (!rows) return "<span style='color:var(--color-muted);font-size:12px'>Тесты не запускались</span>";
    return "<table style='width:100%;border-collapse:collapse;font-size:12px'>" +
        "<thead><tr style='background:var(--bg-th);color:var(--color-muted);font-size:10px;text-transform:uppercase'>" +
        "<th style='padding:4px 8px'>#</th><th style='padding:4px 8px'>Тип</th>" +
        "<th style='padding:4px 8px'>Результат</th><th style='padding:4px 8px;text-align:center'>Остаток</th>" +
        "<th style='padding:4px 8px;text-align:right'>Часы работы</th><th style='padding:4px 8px'>LBA ошибки</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table>";
}

function startSmartTestPoll() {
    if (_smartTestPollTimer) return;
    _smartTestPollTimer = setInterval(function() {
        cockpit.spawn(["sudo", "-n", "smartctl", "-a", "/dev/" + _smartModalDisk], {err: "message"})
        .done(function(out) {
            var running = out.indexOf("Self test in progress") !== -1 ||
                          out.indexOf("self-test in progress") !== -1;
            if (running) {
                var pctM = out.match(/(\d+)% of test remaining/);
                var pct  = pctM ? pctM[1] : "?";
                var shortBtn = document.getElementById("btn-smart-run-short");
                var longBtn  = document.getElementById("btn-smart-run-long");
                if (shortBtn) shortBtn.textContent = "⏳ Осталось " + pct + "%";
                if (longBtn)  longBtn.textContent  = "⏳ Осталось " + pct + "%";
            } else {
                stopSmartTestPoll();
                renderSmartModal(out);
            }
        })
        .fail(function() { stopSmartTestPoll(); });
    }, 5000);
}

function stopSmartTestPoll() {
    if (_smartTestPollTimer) {
        clearInterval(_smartTestPollTimer);
        _smartTestPollTimer = null;
    }
    var shortBtn = document.getElementById("btn-smart-run-short");
    var longBtn  = document.getElementById("btn-smart-run-long");
    if (shortBtn) { shortBtn.disabled = false; shortBtn.textContent = "▶ Краткий (~2 мин)"; }
    if (longBtn)  { longBtn.disabled  = false; longBtn.textContent  = "▶ Расширенный (~60 мин)"; }
}

// ─── SMART Schedule (smartd) ──────────────────────────────────────────────────

function loadSmartSchedule(disk) {
    cockpit.file("/etc/smartd.conf", {superuser: "require"}).read()
    .then(function(content) {
        content = content || "";
        var line = "";
        content.split("\n").forEach(function(l) {
            if (l.match(new RegExp("^/dev/" + disk + "\\b"))) line = l;
        });
        // Parse short: -s S/../../{dow}/{hh}
        var shortM = line.match(/-s S\/\.\.\/\.\.\/(\d+)\/(\d+)/);
        var longM  = line.match(/-s L\/\.\.\/(\d+)\/\.\.\/(\d+)/);
        document.getElementById("smart-sched-short-en").checked = !!shortM;
        document.getElementById("smart-sched-long-en").checked  = !!longM;
        if (shortM) {
            var dow = shortM[1]; var hh = shortM[2];
            var dowEl  = document.getElementById("smart-sched-short-dow");
            var hourEl = document.getElementById("smart-sched-short-hour");
            for (var i = 0; i < dowEl.options.length; i++)
                if (dowEl.options[i].value === dow) { dowEl.selectedIndex = i; break; }
            for (var j = 0; j < hourEl.options.length; j++)
                if (hourEl.options[j].value === hh) { hourEl.selectedIndex = j; break; }
        }
        if (longM) {
            var dd = longM[1]; var hh2 = longM[2];
            var dayEl  = document.getElementById("smart-sched-long-day");
            var hourEl2 = document.getElementById("smart-sched-long-hour");
            for (var k = 0; k < dayEl.options.length; k++)
                if (dayEl.options[k].value === dd) { dayEl.selectedIndex = k; break; }
            for (var l = 0; l < hourEl2.options.length; l++)
                if (hourEl2.options[l].value === hh2) { hourEl2.selectedIndex = l; break; }
        }
    })
    .catch(function() {
        // smartd.conf not found or no access — silently ignore
    });
}

function saveSmartSchedule() {
    var disk       = _smartModalDisk;
    var shortEn    = document.getElementById("smart-sched-short-en").checked;
    var shortDow   = document.getElementById("smart-sched-short-dow").value;
    var shortHour  = document.getElementById("smart-sched-short-hour").value;
    var longEn     = document.getElementById("smart-sched-long-en").checked;
    var longDay    = document.getElementById("smart-sched-long-day").value;
    var longHour   = document.getElementById("smart-sched-long-hour").value;

    var statusEl = document.getElementById("smart-sched-status");
    statusEl.textContent = "Сохранение…";

    cockpit.file("/etc/smartd.conf", {superuser: "require"}).read()
    .then(function(content) {
        content = content || "";
        // Remove existing line for this disk
        var lines = content.split("\n").filter(function(l) {
            return !l.match(new RegExp("^/dev/" + disk + "\\b"));
        });

        // Build new line
        if (shortEn || longEn) {
            var newLine = "/dev/" + disk + " -a";
            if (shortEn) newLine += " -s S/../../" + shortDow + "/" + shortHour;
            if (longEn)  newLine += " -s L/../" + longDay + "/../" + longHour;
            lines.push(newLine);
        }

        var newContent = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
        return cockpit.file("/etc/smartd.conf", {superuser: "require"}).replace(newContent);
    })
    .then(function() {
        // Ensure smartd is running and reload
        return new Promise(function(res) {
            cockpit.spawn(["sudo", "-n", "systemctl", "enable", "--now", "smartd"],
                {err: "message"})
            .always(function() {
                cockpit.spawn(["sudo", "-n", "systemctl", "restart", "smartd"],
                    {err: "message"})
                .always(res);
            });
        });
    })
    .then(function() {
        statusEl.style.color = "var(--success, #4caf50)";
        statusEl.textContent = "✓ Сохранено";
        setTimeout(function() { statusEl.textContent = ""; }, 3000);
    })
    .catch(function(e) {
        statusEl.style.color = "#f44336";
        statusEl.textContent = "✗ Ошибка: " + (e.message || String(e));
    });
}

// ─── END SMART Detail Modal ───────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {
    document.getElementById("btn-refresh-disks").addEventListener("click", loadDisksAndArrays);
    document.getElementById("btn-rescan-disks").addEventListener("click", rescanDisks);
    document.getElementById("btn-raid-advisor").addEventListener("click", openRaidAdvisor);
    document.getElementById("btn-raid-advisor-close").addEventListener("click", function() { closeModal("raid-advisor-modal"); });
    document.getElementById("btn-add-disk-confirm").addEventListener("click", confirmAddDisk);
    document.getElementById("btn-add-disk-cancel").addEventListener("click", function() { closeModal("add-disk-modal"); });
    document.getElementById("btn-eject-confirm").addEventListener("click", confirmEjectDisk);
    document.getElementById("btn-eject-cancel").addEventListener("click", function() { closeModal("eject-disk-modal"); });

    // Array card actions (event delegation — set up once, handles dynamically rendered buttons)
    document.getElementById("arrays-container").addEventListener("click", function(e) {
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        var action    = btn.dataset.action;
        var arrayName = btn.dataset.array;
        if (action === "run")     runArray(arrayName);
        if (action === "replace") openAddDisk(arrayName, "replace");
        if (action === "expand")  openAddDisk(arrayName, "expand");
        if (action === "mount")   openMountModal(arrayName);
        if (action === "umount")  doUmountArray(arrayName, btn.dataset.target);
        if (action === "subvol")  openSubvolumesModal(btn.dataset.target);
        if (action === "delete")  openDeleteArrayModal(arrayName, btn.dataset.disks);
        if (action === "upgrade") openUpgradeRaidModal(arrayName, btn.dataset.level, parseInt(btn.dataset.devices));
    });

    // Create array
    document.getElementById("btn-create-array").addEventListener("click", openCreateArrayModal);
    document.getElementById("create-cancel-btn").addEventListener("click", function() { closeModal("modal-create-array"); });
    document.getElementById("create-done-btn").addEventListener("click", function() { closeModal("modal-create-array"); });
    document.getElementById("create-step1-next").addEventListener("click", startCreateArray);
    document.getElementById("create-raid-level").addEventListener("change", validateCreateForm);

    // Delete array
    document.getElementById("delete-array-confirm").addEventListener("click", doDeleteArray);
    document.getElementById("delete-array-cancel").addEventListener("click", function() { closeModal("modal-delete-array"); });

    // Mount array
    document.getElementById("mount-array-confirm").addEventListener("click", doMountArray);
    document.getElementById("mount-array-cancel").addEventListener("click", function() { closeModal("modal-mount-array"); });

    // Subvolumes
    document.getElementById("subvol-create-btn").addEventListener("click", createSubvolume);
    document.getElementById("subvol-close-btn").addEventListener("click", function() { closeModal("modal-subvolumes"); });

    // SSD-tier
    document.getElementById("btn-add-ssd-tier").addEventListener("click", openAddSsdTierModal);
    document.getElementById("btn-refresh-ssd").addEventListener("click", loadSsdTiers);
    // RAID level upgrade modal
    document.getElementById("btn-upgrade-raid-confirm").addEventListener("click", confirmUpgradeRaid);
    document.getElementById("btn-upgrade-raid-cancel").addEventListener("click", function() { closeModal("modal-upgrade-raid"); });

    document.getElementById("btn-confirm-add-tier").addEventListener("click", doCreateSsdTier);
    document.getElementById("btn-cancel-add-tier").addEventListener("click", function() { closeModal("modal-add-ssd-tier"); });
    document.getElementById("btn-confirm-change-mode").addEventListener("click", doChangeCacheMode);
    document.getElementById("btn-cancel-change-mode").addEventListener("click", function() { closeModal("modal-change-mode"); });
    document.getElementById("btn-confirm-remove-tier").addEventListener("click", doRemoveSsdTier);
    document.getElementById("btn-cancel-remove-tier").addEventListener("click", function() { closeModal("modal-remove-ssd-tier"); });

    document.getElementById("ssd-mode-wb").addEventListener("change", function() {
        document.getElementById("ssd-writeback-warn").classList.toggle("hidden", !this.checked);
    });
    document.getElementById("ssd-mode-wt").addEventListener("change", function() {
        document.getElementById("ssd-writeback-warn").classList.toggle("hidden", !document.getElementById("ssd-mode-wb").checked);
    });
    document.getElementById("change-mode-wb").addEventListener("change", function() {
        document.getElementById("change-mode-wb-warn").classList.toggle("hidden", !this.checked);
    });
    document.getElementById("change-mode-wt").addEventListener("change", function() {
        document.getElementById("change-mode-wb-warn").classList.add("hidden");
    });

    document.getElementById("ssd-tiers-body").addEventListener("click", function(e) {
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        if (btn.dataset.action === "change-mode")
            openChangeModeModal(btn.dataset.vg, btn.dataset.lv, btn.dataset.mode);
        if (btn.dataset.action === "remove-tier")
            openRemoveTierModal(btn.dataset.vg, btn.dataset.lv, btn.dataset.backing);
    });

    // SMART modal
    document.getElementById("btn-smart-close").addEventListener("click", function() {
        stopSmartTestPoll();
        closeModal("smart-detail-modal");
    });
    document.getElementById("btn-smart-run-short").addEventListener("click", function() {
        if (!_smartModalDisk) return;
        var shortBtn = document.getElementById("btn-smart-run-short");
        var longBtn  = document.getElementById("btn-smart-run-long");
        shortBtn.disabled = true;
        longBtn.disabled  = true;
        shortBtn.textContent = "Запускается…";
        cockpit.spawn(["sudo", "-n", "smartctl", "-t", "short", "/dev/" + _smartModalDisk], {err: "message"})
        .always(function() { startSmartTestPoll(); });
    });
    document.getElementById("btn-smart-run-long").addEventListener("click", function() {
        if (!_smartModalDisk) return;
        var shortBtn = document.getElementById("btn-smart-run-short");
        var longBtn  = document.getElementById("btn-smart-run-long");
        shortBtn.disabled = true;
        longBtn.disabled  = true;
        longBtn.textContent = "Запускается…";
        cockpit.spawn(["sudo", "-n", "smartctl", "-t", "long", "/dev/" + _smartModalDisk], {err: "message"})
        .always(function() { startSmartTestPoll(); });
    });
    document.getElementById("btn-smart-save-schedule").addEventListener("click", saveSmartSchedule);

    // Click on disk row → SMART modal
    document.getElementById("disks-body").addEventListener("click", function(e) {
        var btn = e.target.closest("button");
        if (btn) return;  // don't open modal when clicking action buttons
        var tr = e.target.closest("tr");
        if (!tr) return;
        var nameEl = tr.querySelector("td b");
        if (!nameEl) return;
        var disk = nameEl.textContent.replace("/dev/", "").trim();
        openSmartModal(disk);
    });

    loadDisksAndArrays();
    loadSsdTiers();
    ssdTierTimer = setInterval(loadSsdTiers, 60000);  // was 10s — SSD tier config only changes on user action
});

function confirmAddDisk() {
    var arrayName = document.getElementById("add-disk-array").value;
    var disk      = document.getElementById("add-disk-select").value;
    var mode      = document.getElementById("add-disk-mode").value;
    if (!disk) { alert("Нет свободных дисков"); return; }

    var btn = document.getElementById("btn-add-disk-confirm");
    btn.disabled = true;
    btn.textContent = "Выполняется...";

    if (mode === "expand") {
        // Step 1: add disk, Step 2: grow array, Step 3: resize filesystem
        cockpit.spawn(["bash", "-c", "sudo mdadm /dev/" + arrayName + " --add " + disk], {superuser: "require"})
            .done(function() {
                // Get current device count then grow by 1
                cockpit.spawn(["bash", "-c",
                    "sudo mdadm --detail /dev/" + arrayName + " | grep 'Raid Devices' | awk '{print $NF}'"
                ], {superuser: "require"})
                .done(function(countOut) {
                    var currentCount = parseInt(countOut.trim()) || 0;
                    var newCount     = currentCount + 1;

                    cockpit.spawn(["bash", "-c",
                        "sudo mdadm --grow /dev/" + arrayName + " --raid-devices=" + newCount
                    ], {superuser: "require"})
                    .done(function() {
                        closeModal("add-disk-modal");
                        btn.disabled = false;
                        btn.textContent = "Подтвердить";
                        // Show expand progress info
                        document.getElementById("eject-status").innerHTML =
                            "<div class='alert alert-info'>🔵 Расширение массива <b>" + arrayName + "</b> запущено. " +
                            "Идёт reshape — следите за прогрессом. После завершения файловая система будет расширена автоматически.</div>";
                        // Start polling + auto resize FS when done
                        diskRefreshTimer = setInterval(function() {
                            loadDisksAndArrays();
                            checkReshapeComplete(arrayName);
                        }, 5000);
                        loadDisksAndArrays();
                    })
                    .fail(function(err) {
                        btn.disabled = false;
                        btn.textContent = "Подтвердить";
                        alert("Ошибка grow: " + err);
                    });
                });
            })
            .fail(function(err) {
                btn.disabled = false;
                btn.textContent = "Подтвердить";
                alert("Ошибка добавления диска: " + err);
            });
    } else {
        // Replace mode — just add
        cockpit.spawn(["bash", "-c", "sudo mdadm /dev/" + arrayName + " --add " + disk], {superuser: "require"})
            .done(function() {
                closeModal("add-disk-modal");
                btn.disabled = false;
                btn.textContent = "Подтвердить";
                diskRefreshTimer = setInterval(loadDisksAndArrays, 5000);
                loadDisksAndArrays();
            })
            .fail(function(err) {
                btn.disabled = false;
                btn.textContent = "Подтвердить";
                alert("Ошибка: " + err);
            });
    }
}

// ─── RAID Level Upgrade (e.g. RAID 5 → RAID 6) ───────────────────────────────

var RAID_UPGRADES = {
    "raid1": {
        target: "5",
        targetLabel: "RAID 5",
        addDisks: 1,
        description: "Добавляет 1 диск и конвертирует массив из RAID 1 в RAID 5. " +
            "Полезная ёмкость увеличится: 3 диска RAID 5 дают 2× ёмкость одного диска вместо 1× при RAID 1."
    },
    "raid5": {
        target: "6",
        targetLabel: "RAID 6",
        addDisks: 1,
        description: "Добавляет 1 диск и конвертирует массив из RAID 5 в RAID 6. " +
            "Полезная ёмкость <b>не уменьшится</b> — вы получаете вторую зону отказоустойчивости при той же ёмкости."
    }
};

function openUpgradeRaidModal(arrayName, currentLevel, currentDevices) {
    var upgrade = RAID_UPGRADES[currentLevel];
    if (!upgrade) { alert("Апгрейд с уровня " + currentLevel + " не поддерживается"); return; }

    var newDevices = currentDevices + upgrade.addDisks;
    document.getElementById("upgrade-raid-array").value          = arrayName;
    document.getElementById("upgrade-raid-target-level").value   = upgrade.target;
    document.getElementById("upgrade-raid-target-devices").value = newDevices;

    document.getElementById("upgrade-raid-title").textContent =
        "Апгрейд " + currentLevel.toUpperCase() + " → RAID " + upgrade.target;

    document.getElementById("upgrade-raid-info").innerHTML =
        "<b>" + arrayName + "</b>: " + currentLevel.toUpperCase() + " (" + currentDevices + " дисков) " +
        "→ <b>RAID " + upgrade.target + "</b> (" + newDevices + " дисков)<br>" +
        upgrade.description;

    // Load free disks
    var sel  = document.getElementById("upgrade-raid-disk-select");
    var info = document.getElementById("upgrade-raid-disk-info");
    sel.innerHTML = "<option value=''>Загрузка...</option>";
    info.textContent = "";

    cockpit.spawn(["bash", "-c",
        "lsblk -rno NAME,TYPE | grep ' disk$' | awk '{print $1}' | while read d; do " +
        "grep -q $d /proc/mdstat || echo $d; done | grep -v sda"
    ], {err: "message"})
    .done(function(out) {
        var disks = out.trim().split("\n").filter(Boolean);
        if (disks.length === 0) {
            sel.innerHTML = "<option value=''>— нет свободных дисков —</option>";
            document.getElementById("btn-upgrade-raid-confirm").disabled = true;
        } else {
            sel.innerHTML = disks.map(function(d) {
                return "<option value='/dev/" + d + "'>/dev/" + d + "</option>";
            }).join("");
            document.getElementById("btn-upgrade-raid-confirm").disabled = false;
            // Load SMART info for available disks
            loadUpgradeDiskInfo(disks);
        }
    })
    .fail(function() {
        sel.innerHTML = "<option value=''>— ошибка получения дисков —</option>";
    });

    showModal("modal-upgrade-raid");
}

function loadUpgradeDiskInfo(disks) {
    var info = document.getElementById("upgrade-raid-disk-info");
    info.textContent = "Загрузка информации...";
    var results = [];
    var pending = disks.length;

    disks.forEach(function(disk, idx) {
        cockpit.spawn(["sudo", "-n", "smartctl", "-i", "/dev/" + disk], {err: "message"})
            .done(function(out) {
                var modelM  = out.match(/Device Model:\s*(.+)|Model Number:\s*(.+)/);
                var serialM = out.match(/Serial Number:\s*(.+)/);
                var sizeM   = out.match(/User Capacity:\s*(.+)/);
                results[idx] = {
                    disk:   disk,
                    model:  modelM  ? (modelM[1] || modelM[2]).trim() : "—",
                    serial: serialM ? serialM[1].trim() : "—",
                    size:   sizeM   ? sizeM[1].trim()   : "—"
                };
                if (--pending === 0) renderUpgradeDiskInfo(results);
            })
            .fail(function() {
                results[idx] = { disk: disk, model: "—", serial: "—", size: "—" };
                if (--pending === 0) renderUpgradeDiskInfo(results);
            });
    });
}

function renderUpgradeDiskInfo(results) {
    var info = document.getElementById("upgrade-raid-disk-info");
    if (!info) return;
    info.innerHTML = results.filter(Boolean).map(function(r) {
        return "<div class='disk-info-row'>" +
            "<b>/dev/" + r.disk + "</b> — " + r.model +
            " | S/N: <code>" + r.serial + "</code>" +
            " | " + r.size + "</div>";
    }).join("");
}

function confirmUpgradeRaid() {
    var arrayName   = document.getElementById("upgrade-raid-array").value;
    var targetLevel = document.getElementById("upgrade-raid-target-level").value;
    var newDevices  = parseInt(document.getElementById("upgrade-raid-target-devices").value);
    var disk        = document.getElementById("upgrade-raid-disk-select").value;

    if (!disk) { alert("Выберите диск"); return; }

    var btn = document.getElementById("btn-upgrade-raid-confirm");
    btn.disabled = true;
    btn.textContent = "Выполняется...";

    // Step 1: Add disk as spare
    cockpit.spawn(["bash", "-c", "sudo mdadm /dev/" + arrayName + " --add " + disk],
        {superuser: "require"})
    .done(function() {
        // Step 2: Grow with new level and device count
        cockpit.spawn(["bash", "-c",
            "sudo mdadm --grow /dev/" + arrayName +
            " --level=" + targetLevel +
            " --raid-devices=" + newDevices
        ], {superuser: "require"})
        .done(function() {
            closeModal("modal-upgrade-raid");
            btn.disabled = false;
            btn.textContent = "▶ Запустить апгрейд";
            document.getElementById("eject-status").innerHTML =
                "<div class='alert alert-info'>🔵 Апгрейд массива <b>" + arrayName + "</b> до RAID " + targetLevel + " запущен. " +
                "Идёт reshape — следите за прогрессом в карточке массива.</div>";
            diskRefreshTimer = setInterval(function() {
                loadDisksAndArrays();
                checkReshapeComplete(arrayName);
            }, 5000);
            loadDisksAndArrays();
        })
        .fail(function(err) {
            btn.disabled = false;
            btn.textContent = "▶ Запустить апгрейд";
            alert("Ошибка --grow: " + err);
        });
    })
    .fail(function(err) {
        btn.disabled = false;
        btn.textContent = "▶ Запустить апгрейд";
        alert("Ошибка добавления диска: " + err);
    });
}

function checkReshapeComplete(arrayName) {
    cockpit.spawn(["bash", "-c", "cat /proc/mdstat | grep -A2 " + arrayName])
        .done(function(out) {
            // If no reshape/resync progress line — it's done
            var hasProgress = out.indexOf("reshape") !== -1 || out.indexOf("resync") !== -1 || out.indexOf("recovery") !== -1;
            if (!hasProgress) {
                clearInterval(diskRefreshTimer);
                diskRefreshTimer = null;
                // Auto resize filesystem
                cockpit.spawn(["bash", "-c",
                    "mount | grep '/dev/" + arrayName + "' | awk '{print $3}'"
                ])
                .done(function(mountOut) {
                    var mountPoint = mountOut.trim();
                    if (!mountPoint) return;
                    // Detect fstype and resize
                    cockpit.spawn(["bash", "-c",
                        "blkid /dev/" + arrayName + " -o value -s TYPE"
                    ])
                    .done(function(fstype) {
                        fstype = fstype.trim();
                        var resizeCmd = fstype === "btrfs"
                            ? "sudo btrfs filesystem resize max " + mountPoint
                            : "sudo resize2fs /dev/" + arrayName;
                        cockpit.spawn(["bash", "-c", resizeCmd], {superuser: "require"})
                            .done(function() {
                                document.getElementById("eject-status").innerHTML =
                                    "<div class='alert alert-info' style='border-left-color:#38a169; background:#f0fff4; color:#276749;'>" +
                                    "✅ Расширение массива <b>" + arrayName + "</b> завершено. " +
                                    "Файловая система расширена автоматически.</div>";
                                loadDisksAndArrays();
                            });
                    });
                });
            }
        });
}
