// ─── Disks & RAID ─────────────────────────────────────────────────────────────

var diskRefreshTimer  = null;
var physicalDiskCount = 0;   // non-system disks, set in renderDisks
var currentArrays     = [];  // last parsed mdstat, used by RAID advisor

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

function renderArrays(arrays) {
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
            actionBtn  = "<button class='btn btn-warning btn-sm' onclick='runArray(\"" + arr.name + "\")'>▶ Запустить</button>";
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
            ? "<button class='btn btn-primary btn-sm' onclick='openAddDisk(\"" + arr.name + "\", \"replace\")'>🔄 Заменить диск</button>"
            : "";

        // Expand array: show only when fully healthy and not resyncing/reshaping
        var expandBtn = (!arr.inactive && !arr.degraded && !arr.resyncing &&
                         ["raid5","raid6","raid10","raid1"].indexOf(arr.level) !== -1)
            ? "<button class='btn btn-secondary btn-sm' onclick='openAddDisk(\"" + arr.name + "\", \"expand\")'>⤢ Расширить массив</button>"
            : "";

        return "<div class='array-card'>" +
            "<div class='array-header'>" +
                "<div>" +
                    "<span class='array-name'>" + arr.name + "</span>" +
                    "<span class='array-level'>" + arr.level.toUpperCase() + "</span>" +
                    "<span class='array-size'>" + arr.sizeGB + " GB</span>" +
                "</div>" +
                "<div class='array-actions'>" + actionBtn + " " + addDiskBtn + " " + expandBtn + "</div>" +
            "</div>" +
            "<div class='array-status'>" + badge + " <span class='status-desc'>" + statusDesc + "</span></div>" +
            "<div class='array-slots'>" + slots + "</div>" +
            resyncBar +
            "<div class='array-devices'>" + devList + "</div>" +
            "<div class='array-hint'>" + getRaidHint(arr) + "</div>" +
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

        return "<tr>" +
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
    cockpit.spawn(["bash", "-c",
        "sudo smartctl -i -H /dev/" + disk + " 2>/dev/null"
    ])
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

// ─── Load all ─────────────────────────────────────────────────────────────────

function loadDisksAndArrays() {
    cockpit.spawn(["bash", "-c", "cat /proc/mdstat"])
        .done(function(mdstat) {
            var arrays = parseMdstat(mdstat);
            currentArrays = arrays;
            updateAlertBanner(arrays);
            renderArrays(arrays);

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
    cockpit.spawn(["bash", "-c", "sudo mdadm --run /dev/" + name], {superuser: "require"})
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
        cockpit.spawn(["bash", "-c", "sudo smartctl -i /dev/" + disk + " 2>/dev/null | grep -E 'Device Model|Model Number|Serial Number|User Capacity'"])
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
    cockpit.spawn(["bash", "-c", "sudo smartctl -i /dev/" + disk + " 2>/dev/null | grep -E 'Device Model|Model Number|Serial Number'"])
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

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {
    document.getElementById("btn-refresh-disks").addEventListener("click", loadDisksAndArrays);
    document.getElementById("btn-rescan-disks").addEventListener("click", rescanDisks);
    document.getElementById("btn-raid-advisor").addEventListener("click", openRaidAdvisor);
    document.getElementById("btn-raid-advisor-close").addEventListener("click", function() { closeModal("raid-advisor-modal"); });
    document.getElementById("btn-add-disk-confirm").addEventListener("click", confirmAddDisk);
    document.getElementById("btn-add-disk-cancel").addEventListener("click", function() { closeModal("add-disk-modal"); });
    document.getElementById("btn-eject-confirm").addEventListener("click", confirmEjectDisk);
    document.getElementById("btn-eject-cancel").addEventListener("click", function() { closeModal("eject-disk-modal"); });
    loadDisksAndArrays();
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
