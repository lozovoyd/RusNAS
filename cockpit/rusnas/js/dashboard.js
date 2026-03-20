"use strict";
// rusNAS Dashboard — js/dashboard.js

// ── Refresh intervals (ms) ────────────────────────────────────────────────
var TICK_FAST    = 1000;   // identity, CPU, RAM, net, I/O
var TICK_STORAGE = 10000;  // df, mdstat, services
var TICK_SMART   = 300000; // smartctl cache TTL
var TICK_EVENTS  = 15000;  // journalctl
var TICK_SNAPS   = 60000;  // rusnas-snap
var TICK_GUARD   = 5000;   // guard status
var TICK_UPS     = 10000;  // ups status

// ── Sparkline history ─────────────────────────────────────────────────────
var HISTORY = 60;
var sparkCpu  = new Array(HISTORY).fill(0);
var sparkRam  = new Array(HISTORY).fill(0);
var sparkNetR = new Array(HISTORY).fill(0);
var sparkNetT = new Array(HISTORY).fill(0);
var sparkIoR  = new Array(HISTORY).fill(0);
var sparkIoW  = new Array(HISTORY).fill(0);

// ── Delta state ───────────────────────────────────────────────────────────
var prevCpu     = null;
var prevNet     = {};
var prevDisk    = {};
var smartCache  = {};

// ── Utilities ─────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function fmtBytes(bytes) {
    if (bytes === null || bytes === undefined) return "—";
    if (bytes < 1024) return bytes + " Б";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " КБ";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " МБ";
    if (bytes < 1099511627776) return (bytes / 1073741824).toFixed(1) + " ГБ";
    return (bytes / 1099511627776).toFixed(2) + " ТБ";
}

function fmtSpeed(bps) {
    if (bps < 1024) return bps.toFixed(0) + " Б/с";
    if (bps < 1048576) return (bps / 1024).toFixed(1) + " КБ/с";
    return (bps / 1048576).toFixed(1) + " МБ/с";
}

function fmtUptime(sec) {
    sec = Math.floor(sec);
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + "д " + h + "ч " + m + "м";
    if (h > 0) return h + "ч " + m + "м";
    return m + "м";
}

function fmtDuration(sec) {
    if (sec < 3600) return Math.floor(sec / 60) + " мин назад";
    if (sec < 86400) return Math.floor(sec / 3600) + "ч назад";
    return Math.floor(sec / 86400) + "д назад";
}

function pctClass(pct) {
    if (pct >= 95) return "db-crit";
    if (pct >= 80) return "db-warn";
    return "db-ok";
}

function pctBarClass(pct) {
    if (pct >= 95) return "crit";
    if (pct >= 80) return "warn";
    return "";
}

function statusDot(active) {
    return active ? "✅" : "🔴";
}

function pushHistory(arr, val) {
    arr.push(val);
    if (arr.length > HISTORY) arr.shift();
}

// ── Sparkline renderer ────────────────────────────────────────────────────
// ── Sparkline helpers ──────────────────────────────────────────────────────

function _sparkPoints(values, w, h, padT, padB) {
    var maxVal = Math.max.apply(null, values.concat([1]));
    var n = values.length;
    return values.map(function(v, i) {
        return {
            x: parseFloat(((i / Math.max(n - 1, 1)) * w).toFixed(2)),
            y: parseFloat((h - padB - (v / maxVal) * (h - padT - padB)).toFixed(2))
        };
    });
}

function _sparkPath(pts) {
    if (!pts.length) return '';
    var d = 'M' + pts[0].x + ',' + pts[0].y;
    for (var i = 1; i < pts.length; i++) {
        var tension = 0.35;
        var dx = pts[i].x - pts[i - 1].x;
        var cp1x = (pts[i - 1].x + dx * tension).toFixed(2);
        var cp2x = (pts[i].x - dx * tension).toFixed(2);
        d += ' C' + cp1x + ',' + pts[i - 1].y.toFixed(2) +
             ' ' + cp2x + ',' + pts[i].y.toFixed(2) +
             ' ' + pts[i].x + ',' + pts[i].y;
    }
    return d;
}

function _sparkGridLines(w, h, padT, padB) {
    var out = '';
    [0.33, 0.66].forEach(function(f) {
        var y = (padT + (h - padT - padB) * f).toFixed(1);
        out += '<line x1="0" y1="' + y + '" x2="' + w + '" y2="' + y +
               '" stroke="currentColor" stroke-opacity="0.07" stroke-width="1"/>';
    });
    return out;
}

function renderSparkline(svgId, values, color) {
    var svg = el(svgId);
    if (!svg) return;
    var w = svg.clientWidth || 280;
    var h = svg.clientHeight || 56;
    var padT = 4, padB = 3;
    var pts = _sparkPoints(values, w, h, padT, padB);
    var line = _sparkPath(pts);
    var area = line + ' L' + pts[pts.length-1].x + ',' + (h - padB) +
               ' L' + pts[0].x + ',' + (h - padB) + 'Z';
    var last = pts[pts.length - 1];
    var gId = svgId + 'G';
    svg.innerHTML =
        '<defs>' +
        '<linearGradient id="' + gId + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.22"/>' +
        '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
        '</linearGradient>' +
        '</defs>' +
        _sparkGridLines(w, h, padT, padB) +
        '<path d="' + area + '" fill="url(#' + gId + ')" stroke="none"/>' +
        '<path d="' + line + '" fill="none" stroke="' + color +
        '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<circle cx="' + last.x + '" cy="' + last.y + '" r="2.5" fill="' + color + '"/>';
}

function renderDualSparkline(svgId, v1, c1, v2, c2) {
    var svg = el(svgId);
    if (!svg) return;
    var w = svg.clientWidth || 280;
    var h = svg.clientHeight || 56;
    var padT = 4, padB = 3;
    var maxVal = Math.max.apply(null, v1.concat(v2).concat([1]));
    function pts(vals) {
        var n = vals.length;
        return vals.map(function(v, i) {
            return {
                x: parseFloat(((i / Math.max(n - 1, 1)) * w).toFixed(2)),
                y: parseFloat((h - padB - (v / maxVal) * (h - padT - padB)).toFixed(2))
            };
        });
    }
    var p1 = pts(v1), p2 = pts(v2);
    var l1 = _sparkPath(p1), l2 = _sparkPath(p2);
    var a1 = l1 + ' L' + p1[p1.length-1].x + ',' + (h-padB) + ' L' + p1[0].x + ',' + (h-padB) + 'Z';
    var a2 = l2 + ' L' + p2[p2.length-1].x + ',' + (h-padB) + ' L' + p2[0].x + ',' + (h-padB) + 'Z';
    var e1 = p1[p1.length - 1], e2 = p2[p2.length - 1];
    var g1 = svgId + 'G1', g2 = svgId + 'G2';
    svg.innerHTML =
        '<defs>' +
        '<linearGradient id="' + g1 + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + c1 + '" stop-opacity="0.18"/><stop offset="100%" stop-color="' + c1 + '" stop-opacity="0"/></linearGradient>' +
        '<linearGradient id="' + g2 + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + c2 + '" stop-opacity="0.14"/><stop offset="100%" stop-color="' + c2 + '" stop-opacity="0"/></linearGradient>' +
        '</defs>' +
        _sparkGridLines(w, h, padT, padB) +
        '<path d="' + a1 + '" fill="url(#' + g1 + ')" stroke="none"/>' +
        '<path d="' + a2 + '" fill="url(#' + g2 + ')" stroke="none"/>' +
        '<path d="' + l1 + '" fill="none" stroke="' + c1 + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="' + l2 + '" fill="none" stroke="' + c2 + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<circle cx="' + e1.x + '" cy="' + e1.y + '" r="2.5" fill="' + c1 + '"/>' +
        '<circle cx="' + e2.x + '" cy="' + e2.y + '" r="2.5" fill="' + c2 + '"/>';
}

// ── Section: Identity Bar ─────────────────────────────────────────────────
function updateDateTime() {
    var now = new Date();
    var pad = function(n){ return n < 10 ? "0" + n : n; };
    el("db-datetime").textContent =
        pad(now.getDate()) + "." + pad(now.getMonth()+1) + "." + now.getFullYear() +
        "  " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
}

function loadIdentity() {
    cockpit.spawn(["bash", "-c",
        "cat /proc/sys/kernel/hostname; echo '---'; " +
        "ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i==\"src\") print $(i+1)}'; echo '---'; " +
        "cat /proc/uptime"
    ], {err: "message"})
    .done(function(out) {
        var parts = out.split("---\n");
        if (parts[0]) el("db-hostname").textContent = parts[0].trim();
        if (parts[1]) el("db-ip").textContent = parts[1].trim() || "—";
        if (parts[2]) {
            var upSec = parseFloat(parts[2].trim().split(" ")[0]);
            el("db-uptime").textContent = fmtUptime(upSec);
        }
    });
}

// ── Section A1: Storage ───────────────────────────────────────────────────
function loadStorage() {
    cockpit.spawn(["bash", "-c",
        "df -k --output=source,fstype,size,used,avail,target -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | tail -n +2"
    ], {err: "message"})
    .done(function(out) {
        var lines = out.trim().split("\n").filter(Boolean);
        var totalUsed = 0, totalSize = 0, worstPct = 0;
        var relevant = lines.filter(function(l) {
            return l.match(/\/dev\/md|\/dev\/sd|\/dev\/nvme|btrfs|ext4/i) && !l.match(/\s\/boot/);
        });
        relevant.forEach(function(l) {
            var p = l.trim().split(/\s+/);
            if (p.length >= 5) {
                var size = parseInt(p[2]) * 1024;
                var used = parseInt(p[3]) * 1024;
                totalSize += size;
                totalUsed += used;
                if (size > 0) worstPct = Math.max(worstPct, Math.floor(used/size*100));
            }
        });
        var pct = totalSize > 0 ? Math.floor(totalUsed / totalSize * 100) : 0;
        el("storage-used-pct").textContent = pct + "%";
        el("storage-used-pct").className = "db-card-metric " + pctClass(pct);
        el("storage-detail").textContent = fmtBytes(totalUsed) + " / " + fmtBytes(totalSize);
        var bar = el("storage-bar");
        bar.style.width = pct + "%";
        bar.className = "db-progress-fill " + pctBarClass(pct);
        var card = el("card-storage");
        card.className = "db-card " + (pct >= 95 ? "db-card-crit" : pct >= 80 ? "db-card-warn" : "db-card-ok");
        card.style.cursor = "pointer";
    });
}

// ── Section A2: RAID ──────────────────────────────────────────────────────
function loadRaid() {
    cockpit.spawn(["bash", "-c", "cat /proc/mdstat"], {err: "message"})
    .done(function(out) {
        var arrays = parseMdstat(out);
        var listEl = el("raid-list");
        var raidsEl = el("storage-raids");

        if (arrays.length === 0) {
            listEl.innerHTML = '<span class="text-muted" style="font-size:12px">RAID не настроен</span>';
            raidsEl.innerHTML = "";
            el("card-raid").className = "db-card";
            return;
        }

        var worstStatus = "active";
        var html = "";
        var tagHtml = "";
        arrays.forEach(function(a) {
            if (a.status === "degraded" || a.status === "inactive") worstStatus = a.status;
            var ico = a.status === "active" ? "✅" : (a.status === "degraded" ? "⚠" : "🔴");
            var color = a.status === "active" ? "db-ok" : (a.status === "degraded" ? "db-warn" : "db-crit");
            html += '<div class="db-raid-row">' +
                '<span class="db-raid-name">' + a.name + '</span>' +
                '<span style="font-size:11px;color:var(--color-muted)">' + (a.level || "?") + '</span>' +
                '<span class="' + color + '">' + ico + ' ' + a.status + '</span>' +
                '<span style="font-size:11px">' + a.activeDevices + '/' + a.totalDevices + ' дисков</span>' +
                '</div>';
            if (a.syncPct !== null) {
                html += '<div class="db-raid-progress" style="margin-bottom:4px">' +
                    '<div class="db-raid-progress-fill" style="width:' + a.syncPct + '%"></div></div>' +
                    '<div style="font-size:10px;color:var(--color-muted);margin-bottom:4px">Sync: ' + a.syncPct.toFixed(1) + '% ' + (a.syncSpeed || '') + '</div>';
            }
            tagHtml += '<span style="font-size:11px;padding:2px 5px;border-radius:3px;background:var(--bg-th)">' +
                a.name + ' ' + ico + '</span>';
        });
        listEl.innerHTML = html;
        raidsEl.innerHTML = tagHtml;

        var card = el("card-raid");
        card.className = "db-card " + (worstStatus === "active" ? "db-card-ok" : worstStatus === "degraded" ? "db-card-warn" : "db-card-crit");
        card.style.cursor = "pointer";
    });
}

function parseMdstat(text) {
    var result = [];
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(/^(md\w+)\s*:\s*(active|inactive)\s+(?:(\w+)\s+)?(.+)/);
        if (!m) continue;
        var name = m[1];
        var active = m[2];
        var level = m[3] || "";
        var statusLine = lines[i + 1] || "";
        var statusM = statusLine.match(/(\d+) blocks.*\[(\d+)\/(\d+)\]/);
        var total = statusM ? parseInt(statusM[2]) : 0;
        var avail = statusM ? parseInt(statusM[3]) : 0;
        var syncPct = null, syncSpeed = "";
        for (var j = i; j < Math.min(i + 5, lines.length); j++) {
            var sm = lines[j].match(/=\s+([\d.]+)%.*?(\d+K\/sec)?/);
            if (sm) { syncPct = parseFloat(sm[1]); syncSpeed = sm[2] || ""; break; }
        }
        var status = active === "inactive" ? "inactive"
            : (avail < total) ? "degraded" : "active";
        if (lines[i].match(/resync|reshape|recover/)) status = "resyncing";
        result.push({ name: name, level: level, status: status,
            activeDevices: avail, totalDevices: total, syncPct: syncPct, syncSpeed: syncSpeed });
    }
    return result;
}

// ── Section A3: Disk Health ───────────────────────────────────────────────
function loadDiskHealth() {
    cockpit.spawn(["bash", "-c",
        "ls /dev/sd? /dev/nvme?n? /dev/vd? 2>/dev/null; true"
    ], {err: "message"})
    .done(function(out) {
        var devs = out.trim().split("\n").filter(Boolean);
        if (devs.length === 0) {
            el("disk-summary").textContent = "Нет дисков";
            return;
        }
        var results = [];
        var done = 0;
        devs.forEach(function(dev) {
            var devName = dev.replace("/dev/", "");
            var now = Date.now();
            if (smartCache[devName] && (now - smartCache[devName].time) < TICK_SMART) {
                results.push({ dev: devName, ok: smartCache[devName].ok });
                done++;
                if (done === devs.length) renderDiskHealth(results);
                return;
            }
            cockpit.spawn(["bash", "-c", "sudo smartctl -H " + dev + " 2>/dev/null | grep -i 'health\\|result\\|test result'"],
                {err: "message"})
            .done(function(sout) {
                var ok = sout.toLowerCase().indexOf("passed") !== -1 || sout.toLowerCase().indexOf("ok") !== -1;
                smartCache[devName] = { time: Date.now(), ok: ok };
                results.push({ dev: devName, ok: ok });
            })
            .fail(function() {
                results.push({ dev: devName, ok: null });
            })
            .always(function() {
                done++;
                if (done === devs.length) renderDiskHealth(results);
            });
        });
    });
}

function renderDiskHealth(results) {
    var ok = results.filter(function(r){ return r.ok === true; }).length;
    var fail = results.filter(function(r){ return r.ok === false; }).length;
    var unk = results.filter(function(r){ return r.ok === null; }).length;
    var total = results.length;
    var sumEl = el("disk-summary");
    sumEl.textContent = total + " дисков";
    sumEl.className = "db-card-metric " + (fail > 0 ? "db-warn" : "db-ok");
    var tagsHtml = results.map(function(r) {
        var ico = r.ok === true ? "✅" : r.ok === false ? "⚠" : "❓";
        return '<span style="font-size:11px">' + r.dev + " " + ico + "</span>";
    }).join(" ");
    el("disk-tags").innerHTML = tagsHtml;
    var card = el("card-disks");
    card.className = "db-card " + (fail > 0 ? "db-card-warn" : "db-card-ok");
    card.style.cursor = "pointer";
}

// ── SSD-кеш статус в карточке ДИСКИ ──────────────────────────────────────
function loadSsdCacheStatus() {
    var statusEl = el("ssd-cache-status");
    if (!statusEl) return;
    cockpit.file("/etc/rusnas/ssd-tiers.json").read()
    .done(function(content) {
        var data;
        try { data = JSON.parse(content || '{"tiers":[]}'); } catch(e) { data = {tiers:[]}; }
        var tiers = data.tiers || [];
        if (tiers.length === 0) { statusEl.textContent = ""; return; }
        // For each tier get hit_rate from lvs
        var done = 0;
        var parts = [];
        tiers.forEach(function(t, i) {
            cockpit.spawn(["bash", "-c",
                "sudo -n lvs --noheadings --units g " +
                "-o lv_name,cache_read_hits,cache_read_misses,cache_used_blocks,cache_total_blocks,cache_mode " +
                t.vg_name + " 2>/dev/null || true"
            ], {err:"message"})
            .done(function(out) {
                var hitRate = 0, cachePct = 0, mode = t.mode || "writethrough";
                out.split("\n").forEach(function(line) {
                    var p = line.trim().split(/\s+/);
                    if (p.length >= 6 && p[0] === t.lv_name) {
                        var rh = parseFloat(p[1])||0, rm = parseFloat(p[2])||0;
                        hitRate = rh+rm > 0 ? Math.round(rh/(rh+rm)*100) : 0;
                        var used = parseFloat(p[3])||0, tot = parseFloat(p[4])||1;
                        cachePct = tot > 0 ? Math.round(used/tot*100) : 0;
                        mode = (p[5]||mode).trim();
                    }
                });
                var modeIcon = mode === "writeback" ? "⚡WB" : "✓WT";
                parts[i] = "⚡ SSD-кеш " + t.backing_device + ": эф. " + hitRate + "% | занято " + cachePct + "% | " + modeIcon;
            })
            .fail(function() {
                parts[i] = "⚡ SSD-кеш " + t.backing_device + ": нет данных";
            })
            .always(function() {
                done++;
                if (done === tiers.length) {
                    statusEl.innerHTML = parts.filter(Boolean).join("<br>");
                }
            });
        });
    })
    .fail(function() { if (statusEl) statusEl.textContent = ""; });
}

// ── Section A4: Services ──────────────────────────────────────────────────
var SERVICES = [
    { id: "smbd",       label: "SMB" },
    { id: "nfs-server", label: "NFS" },
    { id: "vsftpd",     label: "FTP" },
    { id: "apache2",    label: "WebDAV" },
    { id: "tgt",        label: "iSCSI" },
];

function loadServices() {
    var statuses = {};
    var done = 0;
    SERVICES.forEach(function(svc) {
        cockpit.spawn(["bash", "-c", "systemctl is-active " + svc.id + " 2>/dev/null || true"], {err: "message"})
        .done(function(out) { statuses[svc.id] = out.trim() === "active"; })
        .fail(function() { statuses[svc.id] = false; })
        .always(function() {
            done++;
            if (done === SERVICES.length) renderServices(statuses);
        });
    });
}

function renderServices(statuses) {
    var html = SERVICES.map(function(svc) {
        var active = statuses[svc.id];
        var ico = active ? "✅" : "🔴";
        var cls = active ? "db-ok" : "db-crit";
        return '<div class="db-svc-row">' +
            '<span class="db-svc-name">' + svc.label + '</span>' +
            '<span class="' + cls + '">' + ico + ' ' + (active ? "Активен" : "Остановлен") + '</span>' +
            '</div>';
    }).join("");
    el("services-list").innerHTML = html;
    var anyDown = SERVICES.some(function(s){ return statuses[s.id] === false; });
    el("card-shares").className = "db-card " + (anyDown ? "db-card-warn" : "db-card-ok");
    el("card-shares").style.cursor = "pointer";
}

// ── Section B1: CPU ───────────────────────────────────────────────────────
function loadCpu() {
    cockpit.spawn(["bash", "-c",
        "cat /proc/stat | head -1; cat /proc/loadavg; nproc; " +
        "cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo ''"
    ], {err: "message"})
    .done(function(out) {
        var lines = out.trim().split("\n");
        var cpuLine = lines[0]; // cpu  user nice system idle ...
        var loadLine = lines[1];
        var ncores = parseInt(lines[2]) || 1;
        var tempRaw = lines[3] ? lines[3].trim() : "";

        var fields = cpuLine.trim().split(/\s+/).slice(1).map(Number);
        var idle = fields[3] + (fields[4] || 0); // idle + iowait
        var total = fields.reduce(function(a,b){ return a+b; }, 0);

        var pct = 0;
        if (prevCpu) {
            var dTotal = total - prevCpu.total;
            var dIdle  = idle - prevCpu.idle;
            pct = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
        }
        prevCpu = { total: total, idle: idle };

        pushHistory(sparkCpu, pct);
        var cls = pct >= 95 ? "db-crit" : pct >= 80 ? "db-warn" : "db-ok";
        el("cpu-pct").textContent = pct + "%";
        el("cpu-pct").className = "db-metric-big " + cls;
        renderSparkline("spark-cpu", sparkCpu, pct >= 95 ? "#cc2200" : pct >= 80 ? "#e68a00" : "#22aa44");

        var la = loadLine ? loadLine.split(" ").slice(0, 3).join(" ") : "—";
        el("cpu-detail").textContent = ncores + " ядер | Load: " + la;

        if (tempRaw) {
            var tempC = parseInt(tempRaw) / 1000;
            var tempCls = tempC > 80 ? "db-crit" : tempC > 65 ? "db-warn" : "";
            el("cpu-temp").innerHTML = '<span class="' + tempCls + '">Temp: ' + tempC.toFixed(0) + '°C</span>';
        }
    });
}

// ── Section B2: RAM ───────────────────────────────────────────────────────
function loadRam() {
    cockpit.spawn(["bash", "-c", "cat /proc/meminfo"], {err: "message"})
    .done(function(out) {
        var get = function(key) {
            var m = out.match(new RegExp(key + ":\\s+(\\d+)"));
            return m ? parseInt(m[1]) * 1024 : 0;
        };
        var total = get("MemTotal");
        var avail = get("MemAvailable");
        var used  = total - avail;
        var pct   = total > 0 ? Math.round(used / total * 100) : 0;
        var swapTotal = get("SwapTotal");
        var swapFree  = get("SwapFree");
        var swapUsed  = swapTotal - swapFree;

        pushHistory(sparkRam, pct);
        var cls = pctClass(pct);
        el("ram-pct").textContent = pct + "%";
        el("ram-pct").className = "db-metric-big " + cls;
        renderSparkline("spark-ram", sparkRam, pct >= 95 ? "#cc2200" : pct >= 80 ? "#e68a00" : "#0066cc");
        el("ram-detail").textContent = fmtBytes(used) + " / " + fmtBytes(total);
        el("swap-detail").textContent = "Swap: " + fmtBytes(swapUsed) + " / " + fmtBytes(swapTotal);
    });
}

// ── Section B3: Network ───────────────────────────────────────────────────
function loadNet() {
    cockpit.spawn(["bash", "-c", "cat /proc/net/dev"], {err: "message"})
    .done(function(out) {
        var lines = out.trim().split("\n").slice(2);
        var best = null, bestBytes = 0;
        var now = Date.now();
        lines.forEach(function(l) {
            var m = l.trim().match(/^(\w+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
            if (!m || m[1] === "lo") return;
            var iface = m[1];
            var rx = parseInt(m[2]);
            var tx = parseInt(m[3]);
            var total = rx + tx;
            if (total > bestBytes) { bestBytes = total; best = { iface: iface, rx: rx, tx: tx }; }
        });
        if (!best) return;

        var rxSpeed = 0, txSpeed = 0;
        if (prevNet[best.iface]) {
            var dt = (now - prevNet[best.iface].time) / 1000;
            if (dt > 0) {
                rxSpeed = (best.rx - prevNet[best.iface].rx) / dt;
                txSpeed = (best.tx - prevNet[best.iface].tx) / dt;
            }
        }
        prevNet[best.iface] = { rx: best.rx, tx: best.tx, time: now };

        pushHistory(sparkNetR, rxSpeed);
        pushHistory(sparkNetT, txSpeed);
        renderDualSparkline("spark-net", sparkNetR, "#22c55e", sparkNetT, "#f97316");
        el("net-iface").textContent = best.iface;
        el("net-rx-val").textContent = fmtSpeed(Math.max(0, rxSpeed));
        el("net-tx-val").textContent = fmtSpeed(Math.max(0, txSpeed));
    });
}

// ── Section C: Disk I/O ───────────────────────────────────────────────────
function loadDiskIO() {
    cockpit.spawn(["bash", "-c", "cat /proc/diskstats"], {err: "message"})
    .done(function(out) {
        var lines = out.trim().split("\n");
        var now = Date.now();
        var totalR = 0, totalW = 0;
        var perDisk = [];

        lines.forEach(function(l) {
            var f = l.trim().split(/\s+/);
            if (f.length < 14) return;
            var dev = f[2];
            if (!dev.match(/^(sd[a-z]|nvme\d+n\d+|md\d+)$/)) return;
            var rSect = parseInt(f[5]);
            var wSect = parseInt(f[9]);

            var rSpeed = 0, wSpeed = 0;
            if (prevDisk[dev]) {
                var dt = (now - prevDisk[dev].time) / 1000;
                if (dt > 0) {
                    rSpeed = (rSect - prevDisk[dev].r) * 512 / dt;
                    wSpeed = (wSect - prevDisk[dev].w) * 512 / dt;
                }
            }
            prevDisk[dev] = { r: rSect, w: wSect, time: now };

            if (dev.match(/^sd/)) { totalR += rSpeed; totalW += wSpeed; }
            if (rSpeed > 0 || wSpeed > 0) perDisk.push({ dev: dev, r: rSpeed, w: wSpeed });
        });

        pushHistory(sparkIoR, totalR);
        pushHistory(sparkIoW, totalW);
        renderDualSparkline("spark-io", sparkIoR, "#3b82f6", sparkIoW, "#f97316");
        el("io-read").textContent  = fmtSpeed(Math.max(0, totalR));
        el("io-write").textContent = fmtSpeed(Math.max(0, totalW));

        if (perDisk.length > 0) {
            el("io-per-disk").textContent = perDisk.map(function(d) {
                return d.dev + ": R " + fmtSpeed(d.r) + " W " + fmtSpeed(d.w);
            }).join("  |  ");
        }
    });
}

// ── Section D1: Events ────────────────────────────────────────────────────
function loadEvents() {
    cockpit.spawn(["bash", "-c",
        "journalctl -n 12 --no-pager -o short-iso -q 2>/dev/null | tail -n 12"
    ], {superuser: "try", err: "message"})
    .done(function(out) {
        var lines = out.trim().split("\n").filter(Boolean);
        if (!lines.length) {
            el("events-list").innerHTML = '<span class="text-muted">Нет событий</span>';
            return;
        }
        var html = lines.slice(-10).map(function(l) {
            var timeMatch = l.match(/^(\S+)\s+\S+\s+(\S+)\[?/);
            var timeStr = timeMatch ? timeMatch[1].slice(11, 16) : "";
            var unit = timeMatch ? timeMatch[2] : "";
            var msg = l.replace(/^\S+\s+\S+\s+/, "");
            var ico = l.match(/error|fail|crit/i) ? "🔴" : l.match(/warn/i) ? "⚠" : "ℹ";
            return '<div class="db-event-row">' +
                '<span class="db-event-time">' + timeStr + '</span>' +
                '<span class="db-event-msg">' + ico + ' ' + escHtml(msg.slice(0, 80)) + '</span>' +
                '</div>';
        }).join("");
        el("events-list").innerHTML = html;
    })
    .fail(function() {
        el("events-list").innerHTML = '<span class="text-muted">Нет доступа к журналу</span>';
    });
}

function escHtml(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Section D2: Snapshots ─────────────────────────────────────────────────
function loadSnapshots() {
    cockpit.spawn(["sudo", "-n", "rusnas-snap", "storage-info"], {err: "message"})
    .done(function(out) {
        try {
            var info = JSON.parse(out.trim());
            el("snap-total").textContent = "Всего: " + info.total_count + " снапшотов · " + info.total_size_human;
            if (!info.subvols || !info.subvols.length) {
                el("snap-list").innerHTML = '<span class="text-muted">Нет данных</span>';
                return;
            }
            // Load last snapshot time per subvol
            var html = info.subvols.slice(0, 6).map(function(sv) {
                var vol = sv.subvol_path.split("/").pop();
                var ico = sv.count > 0 ? "✅" : "🔴";
                var cls = sv.count > 0 ? "" : "db-crit";
                return '<div class="db-snap-row">' +
                    '<span class="db-snap-vol">' + vol + '</span>' +
                    '<span class="db-snap-age ' + cls + '">' + ico + ' ' + sv.count + ' снапш.</span>' +
                    '</div>';
            }).join("");
            el("snap-list").innerHTML = html;
        } catch(e) {
            el("snap-list").innerHTML = '<span class="text-muted">Ошибка загрузки</span>';
        }
    })
    .fail(function() {
        el("snap-list").innerHTML = '<span class="text-muted">rusnas-snap не найден</span>';
        el("snap-total").textContent = "";
    });
}

// ── Section E: Guard ──────────────────────────────────────────────────────
var guardPollFast = false;

function loadGuard() {
    cockpit.spawn(["bash", "-c", "cat /run/rusnas-guard/state.json 2>/dev/null || echo null"],
        {err: "message"})
    .done(function(out) {
        var state = null;
        try { state = JSON.parse(out.trim()); } catch(e) {}

        if (!state) {
            // Try socket ping to detect if daemon running
            cockpit.spawn(["bash", "-c",
                "test -S /run/rusnas-guard/control.sock && echo running || echo stopped"],
                {err: "message"})
            .done(function(o) {
                if (o.trim() === "stopped") renderGuardNotInstalled();
                else renderGuardStopped();
            })
            .fail(function() { renderGuardNotInstalled(); });
            return;
        }

        var running     = state.daemon_running;
        var mode        = state.mode || "monitor";
        var postAttack  = state.post_attack_warning || false;
        var events      = state.events_today || 0;
        var iops        = state.current_iops || 0;
        var lastSnap    = state.last_snapshot || "";
        var lastEvent   = state.last_event || "";

        // Detect active threat
        var threatActive = events > 0 && lastEvent && isRecentEvent(lastEvent, 300);

        if (!running) { renderGuardStopped(); return; }

        var dotClass, modeText, modeColor, cardClass;
        if (threatActive) {
            dotClass = "db-dot-red"; modeText = "⚠ УГРОЗА ОБНАРУЖЕНА"; modeColor = "db-crit"; cardClass = "db-card-crit";
        } else if (postAttack) {
            dotClass = "db-dot-orange"; modeText = "После инцидента (мониторинг)"; modeColor = "db-warn"; cardClass = "db-card-warn";
        } else if (mode === "super-safe") {
            dotClass = "db-dot-purple"; modeText = "Максимальная защита"; modeColor = "db-info"; cardClass = "db-card-blue";
        } else if (mode === "protect") {
            dotClass = "db-dot-green"; modeText = "Активная защита"; modeColor = "db-ok"; cardClass = "db-card-ok";
        } else {
            dotClass = "db-dot-blue"; modeText = "Мониторинг (без блокировки)"; modeColor = "db-info"; cardClass = "db-card-blue";
        }

        el("card-guard").className = "db-card " + cardClass;
        el("guard-status-dot").className = "db-status-dot " + dotClass;
        el("guard-status-text").textContent = modeText;
        el("guard-status-text").className = "db-guard-mode " + modeColor;
        el("guard-uptime").textContent = "IOPS: " + iops + " | События сегодня: " + events;

        el("guard-stats").className = "db-guard-stats";
        el("gs-ops").textContent  = iops;
        el("gs-threats").textContent = events;
        el("gs-snaps").textContent = lastSnap ? "✅" : "—";
        el("gs-blocked").textContent = (state.blocked_ips || []).length;

        if (postAttack) {
            el("guard-post-attack-banner").className = "db-post-attack";
        } else {
            el("guard-post-attack-banner").className = "db-post-attack hidden";
        }

        if (threatActive) {
            showAlertBanner("🔴 ⚠ Guard: обнаружена подозрительная активность! " +
                "Событий сегодня: " + events + ". Проверьте Guard.", "alert-attack");
            guardPollFast = true;
        } else {
            guardPollFast = false;
            hideAlertBanner();
        }
    })
    .fail(function() { renderGuardNotInstalled(); });
}

function renderGuardNotInstalled() {
    el("card-guard").className = "db-card";
    el("guard-status-dot").className = "db-status-dot db-dot-gray";
    el("guard-status-text").textContent = "Guard не установлен";
    el("guard-status-text").className = "db-guard-mode text-muted";
    el("guard-uptime").textContent = "";
    el("guard-stats").className = "db-guard-stats hidden";
    el("guard-entropy").className = "db-entropy-list hidden";
    el("guard-post-attack-banner").className = "db-post-attack hidden";
}

function renderGuardStopped() {
    el("card-guard").className = "db-card";
    el("guard-status-dot").className = "db-status-dot db-dot-gray";
    el("guard-status-text").textContent = "Guard отключён";
    el("guard-status-text").className = "db-guard-mode text-muted";
    el("guard-uptime").textContent = "";
    el("guard-stats").className = "db-guard-stats hidden";
}

function isRecentEvent(ts, maxAgeSec) {
    try {
        var d = new Date(ts);
        return (Date.now() - d.getTime()) < maxAgeSec * 1000;
    } catch(e) { return false; }
}

// ── UPS Status ────────────────────────────────────────────────────────────

function loadUpsStatus() {
    // Read UPS name from config first
    cockpit.file("/etc/nut/ups.conf").read()
    .done(function(content) {
        var upsName = "myups";
        if (content) {
            var m = content.match(/^\[(\w+)\]/m);
            if (m) upsName = m[1];
        }
        fetchDashUpsStatus(upsName);
    })
    .fail(function() {
        renderUpsNoDevice();
    });
}

function fetchDashUpsStatus(upsName) {
    cockpit.spawn(["sudo", "-n", "upsc", "-j", upsName + "@localhost"],
        {err: "message"})
    .done(function(out) {
        var data = null;
        try { data = JSON.parse(out.trim()); } catch(e) {}
        if (!data) {
            // Fallback: text mode
            var obj = {};
            (out || "").split("\n").forEach(function(line) {
                var idx = line.indexOf(": ");
                if (idx > 0) obj[line.substring(0, idx).trim()] = line.substring(idx + 2).trim();
            });
            data = obj;
        }
        renderDashUps(data);
    })
    .fail(function() {
        renderUpsNoDevice();
    });
}

function renderDashUps(data) {
    var status = data["ups.status"] || "";
    var flags = status.split(" ");

    var icon, label, dotCls, cardCls;
    if (flags.indexOf("LB") >= 0) {
        icon = "🔴"; label = "Критический заряд"; dotCls = "db-dot-red"; cardCls = "db-card-crit";
    } else if (flags.indexOf("OB") >= 0) {
        icon = "🟡"; label = "На батарее"; dotCls = "db-dot-orange"; cardCls = "db-card-warn";
    } else if (flags.indexOf("RB") >= 0) {
        icon = "🟠"; label = "Замените батарею"; dotCls = "db-dot-orange"; cardCls = "db-card-warn";
    } else if (flags.indexOf("CHRG") >= 0) {
        icon = "🔵"; label = "Зарядка"; dotCls = "db-dot-blue"; cardCls = "db-card-blue";
    } else if (flags.indexOf("OL") >= 0) {
        icon = "🟢"; label = "Питание от сети"; dotCls = "db-dot-green"; cardCls = "db-card-ok";
    } else if (status === "" || !status) {
        renderUpsNoDevice();
        return;
    } else {
        icon = "⚫"; label = status; dotCls = "db-dot-gray"; cardCls = "";
    }

    el("card-ups").className = "db-card " + cardCls;
    el("card-ups").style.cursor = "pointer";
    el("ups-status-dot").className = "db-status-dot " + dotCls;
    el("db-ups-icon").textContent = icon;
    el("db-ups-label").textContent = label;

    var charge = parseInt(data["battery.charge"]) || 0;
    var runtime = parseInt(data["battery.runtime"]) || 0;
    var load = parseInt(data["ups.load"]) || 0;
    var model = [data["device.mfr"], data["device.model"]].filter(Boolean).join(" ") || data["ups.model"] || "—";

    el("db-ups-charge").textContent = charge ? charge + "%" : "—";
    var fill = el("db-ups-charge-bar");
    fill.style.width = charge + "%";
    fill.style.background = charge > 50 ? "var(--success)" : charge > 20 ? "var(--warning)" : "var(--danger)";

    var rMin = Math.floor(runtime / 60);
    el("db-ups-runtime").textContent = runtime ? (rMin + " мин") : "—";
    el("db-ups-load").textContent = load ? load + "%" : "—";
    el("db-ups-model").textContent = model;

    el("db-ups-metrics").classList.remove("hidden");
    el("db-ups-nodev").classList.add("hidden");
}

function renderUpsNoDevice() {
    el("card-ups").className = "db-card";
    el("ups-status-dot").className = "db-status-dot db-dot-gray";
    el("db-ups-icon").textContent = "🔋";
    el("db-ups-label").textContent = "ИБП не настроен";
    el("db-ups-metrics").classList.add("hidden");
    el("db-ups-nodev").classList.remove("hidden");
}

// ── FileBrowser Status ────────────────────────────────────────────────────
function loadFbDashStatus() {
    cockpit.spawn(["bash", "-c", "systemctl is-active rusnas-filebrowser 2>/dev/null || echo inactive"],
        { err: "message" })
    .done(function(out) {
        var active = out.trim() === "active";
        var dot   = el("fb-status-dot");
        var label = el("fb-dash-status");
        if (dot) {
            dot.className = "db-status-dot " + (active ? "db-dot-green" : "db-dot-gray");
        }
        if (label) {
            label.innerHTML = active
                ? '<span class="db-ok">Сервис работает ✅</span>'
                : '<span class="text-muted">Сервис остановлен</span>';
        }
    })
    .fail(function() {
        var label = el("fb-dash-status");
        if (label) label.innerHTML = '<span class="text-muted">Не установлен</span>';
    });
}

// ── Alert Banner ──────────────────────────────────────────────────────────
function showAlertBanner(msg, cls) {
    var b = el("db-alert-banner");
    b.textContent = msg;
    b.className = "db-alert-banner " + cls;
}
function hideAlertBanner() {
    el("db-alert-banner").className = "db-alert-banner hidden";
}

// ── Metrics Endpoint ──────────────────────────────────────────────────────
function initMetricsBlock() {
    var host = window.location.hostname;
    var promUrl = "http://" + host + ":9100/metrics";
    var jsonUrl = "http://" + host + ":9100/metrics.json";
    el("metrics-url-prom").textContent = promUrl;
    el("metrics-url-json").textContent = jsonUrl;

    // Check if metrics server is running
    cockpit.spawn(["bash", "-c", "systemctl is-active rusnas-metrics 2>/dev/null || echo inactive"],
        {err: "message"})
    .done(function(out) {
        var active = out.trim() === "active";
        el("metrics-server-status").innerHTML = active
            ? '<span class="db-ok">Сервис метрик: активен ✅</span>'
            : '<span class="text-muted">Сервис метрик не запущен</span>';
    });
}

window.copyMetricsUrl = function(type) {
    var url = type === "prom" ? el("metrics-url-prom").textContent : el("metrics-url-json").textContent;
    navigator.clipboard.writeText(url).catch(function() {
        // fallback
        var ta = document.createElement("textarea");
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
    });
};

// ── Tick loops ────────────────────────────────────────────────────────────
function tickFast() {
    updateDateTime();
    loadCpu();
    loadRam();
    loadNet();
    loadDiskIO();
    if (guardPollFast) loadGuard();
}

function tickStorage() {
    loadStorage();
    loadRaid();
    loadServices();
}

function tickSmart() {
    loadDiskHealth();
}

function tickEvents() {
    loadEvents();
}

function tickSnaps() {
    loadSnapshots();
}

function tickGuard() {
    if (!guardPollFast) loadGuard();
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function() {
    loadIdentity();
    initMetricsBlock();


    // Initial loads
    tickFast();
    tickStorage();
    tickSmart();
    tickEvents();
    tickSnaps();
    tickGuard();
    loadUpsStatus();
    loadSsdCacheStatus();
    loadFbDashStatus();

    // Recurring ticks
    setInterval(tickFast,    TICK_FAST);
    setInterval(tickStorage, TICK_STORAGE);
    setInterval(tickSmart,   TICK_SMART);
    setInterval(tickEvents,  TICK_EVENTS);
    setInterval(tickSnaps,   TICK_SNAPS);
    setInterval(tickGuard,   TICK_GUARD);
    setInterval(loadUpsStatus, TICK_UPS);
    setInterval(loadFbDashStatus, TICK_UPS);
    setInterval(loadSsdCacheStatus, TICK_STORAGE);
    setInterval(loadIdentity, 30000);
});
