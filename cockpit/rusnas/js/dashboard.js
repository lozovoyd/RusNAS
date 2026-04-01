"use strict";
// rusNAS Dashboard — js/dashboard.js

// ── Refresh intervals (ms) ────────────────────────────────────────────────
var TICK_METRICS = 2000;   // metrics server: CPU, RAM, net, I/O, RAID, storage, services, guard
var TICK_EVENTS  = 15000;  // journalctl
var TICK_SNAPS   = 60000;  // rusnas-snap
var TICK_UPS     = 30000;  // ups status — battery changes slowly, 30s is sufficient
var TICK_FAST    = 5000;   // CPU/RAM/Net/IO — 5s balances responsiveness vs resource usage

// ── Sparkline history ─────────────────────────────────────────────────────
var HISTORY = 60;
var sparkCpu  = new Array(HISTORY).fill(0);
var sparkRam  = new Array(HISTORY).fill(0);
var sparkNetR = new Array(HISTORY).fill(0);
var sparkNetT = new Array(HISTORY).fill(0);
var sparkIoR  = new Array(HISTORY).fill(0);
var sparkIoW  = new Array(HISTORY).fill(0);
var sparkIopsR = new Array(HISTORY).fill(0);
var sparkIopsW = new Array(HISTORY).fill(0);

// ── Performance chart history (24h, downsampled) ──────────────────────────
// Tier 1: raw 2s  — last 15 min (450 pts)
// Tier 2: avg 10s — 15min..2h  (630 pts)
// Tier 3: avg 60s — 2h..24h   (1320 pts)
// Total: ~2400 points, ~210 KB JSON, write every 60s
var PERF_FILE = "/var/lib/rusnas/perf-history.json";
var PERF_SAVE_SEC = 120; // save every 2 min — reduces I/O and bridge memory
var PERF_KEYS = ["cpu","ram","netR","netT","iopsR","iopsW","thrR","thrW"];
var perfH = { ts:[] }; // + one array per key
PERF_KEYS.forEach(function(k) { perfH[k] = []; });
var _perfCharts = {};
var _perfTickCount = 0;
var _perfMinutes = 15;
var _perfLastSave = 0;
var _perfDownsampleBuf = { ts:[] };
PERF_KEYS.forEach(function(k) { _perfDownsampleBuf[k] = []; });
var _perfLastDownsample = 0;

/**
 * Push a value into raw perfH ring buffer.
 * @param {string} key
 * @param {number} val
 */
function perfPush(key, val) {
    perfH[key].push(val);
}

/**
 * Downsample old data to keep file size small.
 * Called every 60s. Merges raw points older than 15 min into 10s averages,
 * and points older than 2h into 60s averages.
 */
function perfDownsample() {
    var now = Date.now();
    if (now - _perfLastDownsample < 55000) return;
    _perfLastDownsample = now;

    var t15 = now - 15 * 60000;  // 15 min ago
    var t2h = now - 2 * 3600000; // 2 hours ago
    var t24 = now - 24 * 3600000; // 24 hours ago

    /* Remove anything older than 24h */
    while (perfH.ts.length > 0 && perfH.ts[0] < t24) {
        perfH.ts.shift();
        PERF_KEYS.forEach(function(k) { perfH[k].shift(); });
    }

    /* Downsample 2h..24h range to 60s resolution */
    _downsampleRange(t24, t2h, 60000);

    /* Downsample 15min..2h range to 10s resolution */
    _downsampleRange(t2h, t15, 10000);
}

function _downsampleRange(from, to, bucketMs) {
    var i = 0;
    while (i < perfH.ts.length && perfH.ts[i] < from) i++;
    var newTs = [], newVals = {};
    PERF_KEYS.forEach(function(k) { newVals[k] = []; });

    while (i < perfH.ts.length && perfH.ts[i] < to) {
        var bucketEnd = perfH.ts[i] + bucketMs;
        var cnt = 0;
        var sums = {};
        PERF_KEYS.forEach(function(k) { sums[k] = 0; });
        var midTs = 0;
        while (i < perfH.ts.length && perfH.ts[i] < bucketEnd && perfH.ts[i] < to) {
            midTs += perfH.ts[i];
            PERF_KEYS.forEach(function(k) { sums[k] += (perfH[k][i] || 0); });
            cnt++;
            i++;
        }
        if (cnt > 1) {
            newTs.push(Math.round(midTs / cnt));
            PERF_KEYS.forEach(function(k) { newVals[k].push(Math.round(sums[k] / cnt * 100) / 100); });
        } else if (cnt === 1) {
            newTs.push(Math.round(midTs));
            PERF_KEYS.forEach(function(k) { newVals[k].push(sums[k]); });
        }
    }

    /* Collect remaining points (after "to") */
    var tailTs = perfH.ts.slice(i);
    var tailVals = {};
    PERF_KEYS.forEach(function(k) { tailVals[k] = perfH[k].slice(i); });

    /* Find head (before "from") */
    var headEnd = 0;
    while (headEnd < perfH.ts.length && perfH.ts[headEnd] < from) headEnd++;
    var headTs = perfH.ts.slice(0, headEnd);
    var headVals = {};
    PERF_KEYS.forEach(function(k) { headVals[k] = perfH[k].slice(0, headEnd); });

    /* Reassemble */
    perfH.ts = headTs.concat(newTs).concat(tailTs);
    PERF_KEYS.forEach(function(k) {
        perfH[k] = headVals[k].concat(newVals[k]).concat(tailVals[k]);
    });
}

/**
 * Save perfHistory to disk. Called from updatePerfCharts(), throttled to every 60s.
 */
/**
 * Reload perfHistory from backend file and update charts.
 * Backend daemon writes every 2 min; we read every ~15s.
 */
/**
 * Reload perf data from backend JSON file.
 * Backend daemon writes /var/lib/rusnas/perf-history.json every 2 min.
 */
function perfReload() {
    cockpit.file(PERF_FILE).read()
        .done(function(content) {
            if (!content || !content.trim() || content.trim() === "{}") return;
            try {
                var d = JSON.parse(content);
                if (!d.ts || !d.ts.length) return;
                var ml = d.ts.length;
                PERF_KEYS.forEach(function(k) {
                    if (!d[k] || d[k].length < ml) ml = d[k] ? d[k].length : 0;
                });
                if (ml === 0) return;
                perfH.ts = d.ts.slice(d.ts.length - ml);
                PERF_KEYS.forEach(function(k) {
                    perfH[k] = d[k].slice(d[k].length - ml);
                });
            } catch(e) {}
            updatePerfCharts();
        });
}

/**
 * Load perfHistory from disk on startup.
 * @param {Function} cb - called when done
 */
function perfLoad(cb) {
    /* Use XHR instead of cockpit.spawn to avoid bridge dependency */
    perfReload();
    cb();
}

// ── Metrics HTTP client (reused across calls) ─────────────────────────────
var _metricsHttp = cockpit.http({ port: 9100, address: "localhost" });

// ── Tick constants ─────────────────────────────────────────────────────────
var TICK_STORAGE = 10000;
var TICK_SMART   = 300000;
var TICK_GUARD   = 10000;  // was 5s — guard state.json rarely changes; 10s is plenty in normal mode
var TICK_FB      = 60000;  // FileBrowser service status — rarely changes
var TICK_SSD     = 60000;  // SSD cache config — only changes on user action
var TICK_SECTEST = 60000;  // Security self-test state — rarely changes
var SECTEST_SCRIPT = "/usr/lib/rusnas/sectest/sectest.py";
var SECTEST_STATE  = "/var/lib/rusnas/sectest-last.json";
var DB_SPINDOWN_CGI = "/usr/lib/rusnas/cgi/spindown_ctl.py";

// ── Delta state (CPU/Net/IO) ───────────────────────────────────────────────
var prevCpu  = null;
var prevNet  = {};
var prevDisk = {};
// ── Last parsed values (used for synchronized perfH push) ─────────────────
var _lastCpu=0, _lastRam=0, _lastNetR=0, _lastNetT=0;
var _lastIopsR=0, _lastIopsW=0, _lastThrR=0, _lastThrW=0;
var smartCache = {};

// ── Utilities ─────────────────────────────────────────────────────────────
/**
 * Get DOM element by ID (shorthand for getElementById).
 * @param {string} id - Element ID
 * @returns {HTMLElement|null}
 */
function el(id) { return document.getElementById(id); }

/**
 * Format byte count into human-readable string.
 * @param {number} bytes - Byte count
 * @returns {string}
 */
function fmtBytes(bytes) {
    if (bytes === null || bytes === undefined) return "—";
    if (bytes < 1024) return bytes + " Б";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " КБ";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " МБ";
    if (bytes < 1099511627776) return (bytes / 1073741824).toFixed(1) + " ГБ";
    return (bytes / 1099511627776).toFixed(2) + " ТБ";
}

/**
 * Format bytes/sec into human-readable speed string.
 * @param {number} bps - Bytes per second
 * @returns {string}
 */
function fmtSpeed(bps) {
    if (bps < 1024) return bps.toFixed(0) + " Б/с";
    if (bps < 1048576) return (bps / 1024).toFixed(1) + " КБ/с";
    return (bps / 1048576).toFixed(1) + " МБ/с";
}
/**
 * Format IOPS count with K/M suffix.
 * @param {number} n - IOPS value
 * @returns {string}
 */
function fmtIops(n) {
    if (n < 1000) return Math.round(n) + " IOPS";
    return (n / 1000).toFixed(1) + "k IOPS";
}

/**
 * Format seconds into uptime string (days, hours, minutes).
 * @param {number} sec - Uptime in seconds
 * @returns {string}
 */
function fmtUptime(sec) {
    sec = Math.floor(sec);
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + "д " + h + "ч " + m + "м";
    if (h > 0) return h + "ч " + m + "м";
    return m + "м";
}

/**
 * Format seconds into short duration string.
 * @param {number} sec - Duration in seconds
 * @returns {string}
 */
function fmtDuration(sec) {
    if (sec < 3600) return Math.floor(sec / 60) + " мин назад";
    if (sec < 86400) return Math.floor(sec / 3600) + "ч назад";
    return Math.floor(sec / 86400) + "д назад";
}

/**
 * Get CSS class name based on usage percentage.
 * @param {number} pct - Usage percentage (0-100)
 * @returns {string}
 */
function pctClass(pct) {
    if (pct >= 95) return "db-crit";
    if (pct >= 80) return "db-warn";
    return "db-ok";
}

/**
 * Get CSS class name for progress bar based on percentage.
 * @param {number} pct - Usage percentage (0-100)
 * @returns {string}
 */
function pctBarClass(pct) {
    if (pct >= 95) return "crit";
    if (pct >= 80) return "warn";
    return "";
}

/**
 * Generate colored status dot HTML.
 * @param {boolean} active - Whether the service is active
 * @returns {string}
 */
function statusDot(active) {
    return active ? "✅" : "🔴";
}

/**
 * Push a value onto a fixed-size history array.
 * @param {Array<number>} arr - History array to modify
 * @param {number} val - Value to push
 * @returns {void}
 */
function pushHistory(arr, val) {
    arr.push(val);
    if (arr.length > HISTORY) arr.shift();
}

// ── Sparkline renderer ────────────────────────────────────────────────────
// ── Sparkline helpers ──────────────────────────────────────────────────────

/**
 * Calculate SVG points for a sparkline chart.
 * @param {Array<number>} values - Data values
 * @param {number} w - Chart width
 * @param {number} h - Chart height
 * @param {number} padT - Top padding
 * @param {number} padB - Bottom padding
 * @param {number} fixedMax - Fixed maximum value (0 for auto)
 * @returns {Array<Object>}
 */
function _sparkPoints(values, w, h, padT, padB, fixedMax) {
    var maxVal = fixedMax !== undefined
        ? Math.max(fixedMax, Math.max.apply(null, values.concat([1])))
        : Math.max.apply(null, values.concat([1]));
    var n = values.length;
    return values.map(function(v, i) {
        return {
            x: parseFloat(((i / Math.max(n - 1, 1)) * w).toFixed(2)),
            y: parseFloat((h - padB - (v / maxVal) * (h - padT - padB)).toFixed(2))
        };
    });
}

/**
 * Build SVG path string from sparkline points.
 * @param {Array<Object>} pts - Array of {x,y} point objects
 * @returns {string}
 */
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

/**
 * Build SVG grid lines for sparkline background.
 * @param {number} w - Chart width
 * @param {number} h - Chart height
 * @param {number} padT - Top padding
 * @param {number} padB - Bottom padding
 * @returns {string}
 */
function _sparkGridLines(w, h, padT, padB) {
    var out = '';
    [0.33, 0.66].forEach(function(f) {
        var y = (padT + (h - padT - padB) * f).toFixed(1);
        out += '<line x1="0" y1="' + y + '" x2="' + w + '" y2="' + y +
               '" stroke="currentColor" stroke-opacity="0.07" stroke-width="1"/>';
    });
    return out;
}

/**
 * Render a single-series sparkline SVG chart.
 * @param {string} svgId - SVG element ID
 * @param {Array<number>} values - Data values to plot
 * @param {string} color - Line color
 * @param {number} fixedMax - Fixed maximum value (0 for auto)
 * @returns {void}
 */
function renderSparkline(svgId, values, color, fixedMax) {
    var svg = el(svgId);
    if (!svg) return;
    var w = svg.clientWidth || 280;
    var h = svg.clientHeight || 56;
    var padT = 4, padB = 3;
    var pts = _sparkPoints(values, w, h, padT, padB, fixedMax);
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

/**
 * Render a dual-series sparkline SVG chart (e.g. read/write).
 * @param {string} svgId - SVG element ID
 * @param {Array<number>} v1 - First series values
 * @param {string} c1 - First series color
 * @param {Array<number>} v2 - Second series values
 * @param {string} c2 - Second series color
 * @returns {void}
 */
function renderDualSparkline(svgId, v1, c1, v2, c2) {
    var svg = el(svgId);
    if (!svg) return;
    var w = svg.clientWidth || 280;
    var h = svg.clientHeight || 56;
    var padT = 4, padB = 3;
    var maxVal = Math.max.apply(null, v1.concat(v2).concat([1]));
    /**
     * Pts.
     * @param {*} vals
     * @returns {void}
     */
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
/**
 * Update the date/time display in the dashboard header.
 * @returns {void}
 */
function updateDateTime() {
    var now = new Date();
    /**
     * Pad.
     * @param {number} n
     * @returns {void}
     */
    var pad = function(n){ return n < 10 ? "0" + n : n; };
    el("db-datetime").textContent =
        pad(now.getDate()) + "." + pad(now.getMonth()+1) + "." + now.getFullYear() +
        "  " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
}

/**
 * Load NAS hostname and OS info for the dashboard header.
 * @returns {void}
 */
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
/**
 * Load storage volume usage data and render cards.
 * @returns {void}
 */
function loadStorage() {
    cockpit.spawn(["bash", "-c",
        "df -k --output=source,fstype,size,used,avail,target -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | tail -n +2"
    ], {err: "message"})
    .done(function(out) {
        var lines = out.trim().split("\n").filter(Boolean);
        var dataUsed = 0, dataSize = 0;
        var sysUsed  = 0, sysSize  = 0;

        lines.forEach(function(l) {
            var p = l.trim().split(/\s+/);
            if (p.length < 6) return;
            var size = parseInt(p[2]) * 1024;
            var used = parseInt(p[3]) * 1024;
            var mp   = p[5];
            if (mp && mp.startsWith('/mnt/')) {
                dataUsed += used;
                dataSize += size;
            } else if (mp === '/') {
                sysUsed = used;
                sysSize = size;
            }
        });

        // — Data volumes (primary) —
        var pct = dataSize > 0 ? Math.floor(dataUsed / dataSize * 100) : 0;
        el("storage-used-pct").textContent = dataSize > 0 ? pct + "%" : "—";
        el("storage-used-pct").className   = "db-card-metric " + pctClass(pct);
        el("storage-detail").textContent   = dataSize > 0
            ? fmtBytes(dataUsed) + " / " + fmtBytes(dataSize)
            : "нет томов";
        var bar = el("storage-bar");
        bar.style.width  = pct + "%";
        bar.className    = "db-progress-fill " + pctBarClass(pct);
        var card = el("card-storage");
        card.className   = "db-card " + (pct >= 95 ? "db-card-crit" : pct >= 80 ? "db-card-warn" : "db-card-ok");
        card.style.cursor = "pointer";

        // — System disk (secondary) —
        var sysRow = el("storage-sys-row");
        if (sysSize > 0 && sysRow) {
            var sysPct = Math.floor(sysUsed / sysSize * 100);
            sysRow.style.display = "";
            el("storage-sys-pct").textContent    = sysPct + "%";
            el("storage-sys-detail").textContent = fmtBytes(sysUsed) + " / " + fmtBytes(sysSize);
            var sysBar = el("storage-sys-bar");
            sysBar.style.width  = sysPct + "%";
            sysBar.className    = "db-progress-fill " + pctBarClass(sysPct);
        }
    });
}

// ── Spindown helpers ───────────────────────────────────────────────────────
/**
 * Format ISO timestamp as relative 'time ago' string.
 * @param {string} isoString - ISO 8601 timestamp
 * @returns {string}
 */
function dbTimeAgo(isoString) {
    if (!isoString) return "";
    try {
        var d = new Date(isoString);
        var diff = Math.floor((Date.now() - d.getTime()) / 1000);
        if (diff < 60) return "только что";
        if (diff < 3600) return Math.floor(diff / 60) + " мин назад";
        return Math.floor(diff / 3600) + " ч назад";
    } catch(e) { return ""; }
}

/**
 * Load RAID spindown state for backup mode badges.
 * @returns {void}
 */
function dbLoadSpindown() {
    return new Promise(function(resolve) {
        cockpit.spawn(["sudo", "-n", "python3", DB_SPINDOWN_CGI, "get_state"],
            { err: "message", superuser: "try" })
            .done(function(out) {
                try {
                    var r = JSON.parse(out);
                    if (r && r.ok && r.arrays) {
                        resolve(r.arrays);
                    } else {
                        resolve({});
                    }
                } catch(e) { resolve({}); }
            })
            .fail(function() { resolve({}); });
    });
}

/**
 * Render spindown status lines below RAID cards.
 * @param {Object} sdMap - Spindown state map by array name
 * @returns {void}
 */
function renderRaidSpindownLines(sdMap) {
    Object.keys(sdMap).forEach(function(arrayName) {
        var lineEl = document.getElementById("db-spindown-line-" + arrayName);
        if (!lineEl) return;
        var sd = sdMap[arrayName];
        if (!sd || !sd.backup_mode) {
            lineEl.innerHTML = "";
            return;
        }
        var txt = "";
        if (sd.state === "standby") {
            var ago = sd.spindown_at ? " · " + dbTimeAgo(sd.spindown_at) : "";
            txt = '<span style="color:var(--color-muted);font-size:11px">💤 Спит' + ago + '</span>';
        } else if (sd.state === "flushing") {
            txt = '<span style="color:var(--color-muted);font-size:11px">⏳ Засыпает…</span>';
        } else if (sd.state === "waking") {
            txt = '<span style="color:var(--color-muted);font-size:11px">🔆 Просыпается…</span>';
        } else if (sd.state === "active") {
            txt = '<span style="color:var(--color-muted);font-size:11px">💾 Бэкап активен</span>';
        }
        lineEl.innerHTML = txt;
    });
}

// ── Section A2: RAID ──────────────────────────────────────────────────────
/**
 * Load RAID array status and render RAID section.
 * @returns {void}
 */
function loadRaid() {
    var mdstatP = new Promise(function(res, rej) {
        cockpit.spawn(["bash", "-c", "cat /proc/mdstat"], {err: "message"}).done(res).fail(rej);
    });
    var mountP = new Promise(function(res) {
        cockpit.spawn(["bash", "-c", "findmnt -rno SOURCE,TARGET 2>/dev/null"], {err: "message"})
            .done(res).fail(function() { res(""); });
    });
    Promise.all([mdstatP, mountP]).then(function(results) {
        var arrays   = parseMdstat(results[0]);
        var mountMap = {};
        results[1].trim().split("\n").forEach(function(l) {
            var p = l.trim().split(/\s+/);
            if (p.length >= 2) mountMap[p[0]] = p[1];
        });

        var listEl  = el("raid-list");
        var raidsEl = el("storage-raids");

        if (arrays.length === 0) {
            listEl.innerHTML = '<span class="text-muted" style="font-size:12px">RAID не настроен</span>';
            raidsEl.innerHTML = "";
            el("card-raid").className = "db-card";
            return;
        }

        var worstStatus = "active";
        var html = "", tagHtml = "";

        arrays.forEach(function(a) {
            // "inactive" has higher severity than "degraded" — don't overwrite with lower priority
            if (a.status === "inactive") {
                worstStatus = "inactive";
            } else if (a.status === "degraded" && worstStatus !== "inactive") {
                worstStatus = "degraded";
            } else if (a.status === "resyncing" && worstStatus === "active") {
                worstStatus = "resyncing";
            }
            var ico      = a.status === "active"    ? "✅"
                         : a.status === "resyncing" ? "🔄"
                         : a.status === "degraded"  ? "⚠️"
                         : "🔴";
            var icoClass = a.status === "active"    ? "db-ok"
                         : a.status === "resyncing" ? "db-info"
                         : a.status === "degraded"  ? "db-warn"
                         : "db-crit";

            var mount   = mountMap["/dev/" + a.name] || "—";
            var sizeStr = a.sizeGB !== "?" ? a.sizeGB + " ГБ" : "";

            html += '<div class="db-raid-row">' +
                '<span>' + ico + '</span>' +
                '<span class="db-raid-name">' + a.name + '</span>' +
                '<span style="font-size:11px;color:var(--color-muted)">' + a.level + '</span>' +
                (sizeStr ? '<span style="font-size:11px;color:var(--color-muted)">' + sizeStr + '</span>' : '') +
                '<span style="font-size:11px;color:var(--color-muted);margin-left:auto">' + mount + '</span>' +
                '</div>';

            var maskHtml = a.mask
                ? '<span class="db-raid-mask">[' +
                  a.mask.split("").map(function(c) {
                      return '<span style="color:' + (c === "U" ? "var(--success)" : "var(--danger)") + '">' + c + '</span>';
                  }).join("") + ']</span>'
                : '';

            if (a.resyncing) {
                html += '<div class="db-raid-sub">' + maskHtml +
                    '<span class="' + icoClass + '">' +
                    (a.resyncType === "reshape" ? "Перестройка" : "Ресинк") +
                    ' ' + a.resyncPct.toFixed(1) + '%' +
                    (a.resyncEta ? ' · ещё ' + a.resyncEta : '') +
                    '</span></div>';
                html += '<div class="db-raid-progress" style="margin-bottom:4px">' +
                    '<div class="db-raid-progress-fill" style="width:' + a.resyncPct + '%"></div></div>';
            } else {
                var diskLabel = a.total > 0 ? a.active + '/' + a.total + ' дисков' : a.status;
                html += '<div class="db-raid-sub">' + maskHtml +
                    '<span class="' + icoClass + '">' + diskLabel + '</span></div>';
            }

            html += '<div id="db-spindown-line-' + a.name + '" class="db-card-sub" style="margin-top:2px"></div>';

            tagHtml += '<span style="font-size:11px;padding:2px 5px;border-radius:3px;background:var(--bg-th)">' +
                a.name + ' ' + ico + '</span>';
        });

        listEl.innerHTML  = html;
        raidsEl.innerHTML = tagHtml;

        // Load spindown state and annotate each array card
        dbLoadSpindown().then(function(sdMap) {
            renderRaidSpindownLines(sdMap);
        });

        var card = el("card-raid");
        card.className = "db-card " + (
            worstStatus === "active"    ? "db-card-ok" :
            worstStatus === "resyncing" ? "db-card-info" :
            worstStatus === "degraded"  ? "db-card-warn" : "db-card-crit");
        card.style.cursor = "pointer";
    }).catch(function() {
        var listEl = el("raid-list");
        if (listEl) listEl.innerHTML = '<span class="text-muted" style="font-size:12px">Ошибка чтения RAID</span>';
    });
}

/**
 * Parse /proc/mdstat output into structured array objects.
 * @param {string} text - Raw mdstat content
 * @returns {Array<Object>}
 */
function parseMdstat(text) {
    var result = [];
    var lines  = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(/^(md\w+)\s*:\s*(\S+(?:\s*\(auto-read-only\))?)\s+(\w+)\s+(.*)/);
        if (!m) continue;
        var name  = m[1];
        var state = m[2].replace("(auto-read-only)", "").trim();
        var level = m[3];

        var statusLine = lines[i + 1] || "";
        var blocksM = statusLine.match(/(\d+) blocks/);
        var sizeGB  = blocksM ? (parseInt(blocksM[1]) * 1024 / 1e9).toFixed(1) : "?";
        var slotM   = statusLine.match(/\[(\d+)\/(\d+)\]/);
        var total   = slotM ? parseInt(slotM[1]) : 0;
        var active  = slotM ? parseInt(slotM[2]) : 0;
        var maskM   = statusLine.match(/\[([U_]+)\]/);
        var mask    = maskM ? maskM[1] : "";

        var resyncing = false, resyncPct = 0, resyncEta = "", resyncType = "";
        for (var j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            var rm = lines[j].match(/[>=]\s+([\d.]+)%.*finish=([\d.]+)min/);
            if (rm) {
                resyncing = true;
                resyncPct = parseFloat(rm[1]);
                var mins  = parseFloat(rm[2]);
                resyncEta = mins >= 60
                    ? Math.floor(mins / 60) + "ч " + Math.round(mins % 60) + "м"
                    : Math.round(mins) + " мин";
                resyncType = (lines[j].indexOf("reshape") !== -1) ? "reshape" : "resync";
                break;
            }
        }

        var degraded = (state === "active" || state === "clean") && active < total;
        var status   = state === "inactive" ? "inactive"
            : resyncing ? "resyncing"
            : degraded  ? "degraded"
            : "active";

        result.push({
            name: name, level: level, state: state, sizeGB: sizeGB,
            total: total, active: active, mask: mask,
            resyncing: resyncing, resyncPct: resyncPct,
            resyncEta: resyncEta, resyncType: resyncType,
            status: status
        });
    }
    return result;
}

// ── Section A3: Disk Health ───────────────────────────────────────────────
/**
 * Load S.M.A.R.T. health status for all disks.
 * @returns {void}
 */
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
        // Use indexed array to avoid race condition where results.push() can
        // produce wrong order if .done() callbacks arrive out of order
        var results = new Array(devs.length);
        var done = 0;
        devs.forEach(function(dev, idx) {
            var devName = dev.replace("/dev/", "");
            var now = Date.now();
            if (smartCache[devName] && (now - smartCache[devName].time) < TICK_SMART) {
                results[idx] = { dev: devName, ok: smartCache[devName].ok };
                done++;
                if (done === devs.length) renderDiskHealth(results);
                return;
            }
            cockpit.spawn(["sudo", "-n", "smartctl", "-H", dev],
                {err: "message"})
            .done(function(sout) {
                var ok = sout.toLowerCase().indexOf("passed") !== -1 || sout.toLowerCase().indexOf("ok") !== -1;
                smartCache[devName] = { time: Date.now(), ok: ok };
                results[idx] = { dev: devName, ok: ok };
            })
            .fail(function() {
                results[idx] = { dev: devName, ok: null };
            })
            .always(function() {
                done++;
                if (done === devs.length) renderDiskHealth(results);
            });
        });
    });
}

/**
 * Render disk health badges and table.
 * @param {Array<Object>} results - Array of disk health check results
 * @returns {void}
 */
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
/**
 * Load SSD cache tier status from config.
 * @returns {void}
 */
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
    { id: "smbd",       label: "SMB",    fallback: "samba-ad-dc", fallbackLabel: "DC" },
    { id: "nfs-server", label: "NFS" },
    { id: "vsftpd",     label: "FTP" },
    { id: "apache2",    label: "WebDAV" },
    { id: "tgt",        label: "iSCSI" },
];

/**
 * Load systemd service statuses for dashboard badges.
 * @returns {void}
 */
function loadServices() {
    var statuses  = {};   // id → true/false
    var dcModes   = {};   // id → true if active via fallback
    var pending   = 0;

    // Count total checks needed (some services have a fallback)
    SERVICES.forEach(function(svc) { pending++; if (svc.fallback) pending++; });

    /**
     * Check Done.
     * @returns {void}
     */
    function checkDone() {
        pending--;
        if (pending === 0) renderServices(statuses, dcModes);
    }

    SERVICES.forEach(function(svc) {
        cockpit.spawn(["bash", "-c", "systemctl is-active " + svc.id + " 2>/dev/null || true"], {err: "message"})
        .done(function(out) { statuses[svc.id] = out.trim() === "active"; })
        .fail(function() { statuses[svc.id] = false; })
        .always(function() { checkDone(); });

        if (svc.fallback) {
            cockpit.spawn(["bash", "-c", "systemctl is-active " + svc.fallback + " 2>/dev/null || true"], {err: "message"})
            .done(function(out) { dcModes[svc.id] = out.trim() === "active"; })
            .fail(function() { dcModes[svc.id] = false; })
            .always(function() { checkDone(); });
        }
    });
}

/**
 * Render service status badges on the dashboard.
 * @param {Object} statuses - Map of service name to active status
 * @param {Object} dcModes - Data collection mode flags
 * @returns {void}
 */
function renderServices(statuses, dcModes) {
    var html = SERVICES.map(function(svc) {
        var primary  = statuses[svc.id];
        var fallback = dcModes[svc.id];
        var active   = primary || fallback;
        var ico = active ? "✅" : "🔴";
        var cls = active ? "db-ok" : "db-crit";
        var lbl = primary  ? "Активен"
                : fallback ? "Активен (" + svc.fallbackLabel + ")"
                :            "Остановлен";
        return '<div class="db-svc-row">' +
            '<span class="db-svc-name">' + svc.label + '</span>' +
            '<span class="' + cls + '">' + ico + ' ' + lbl + '</span>' +
            '</div>';
    }).join("");
    el("services-list").innerHTML = html;
    var anyDown = SERVICES.some(function(s){
        return !statuses[s.id] && !(dcModes[s.id]);
    });
    el("card-shares").className = "db-card " + (anyDown ? "db-card-warn" : "db-card-ok");
    el("card-shares").style.cursor = "pointer";
}

// ── Section B1: CPU ───────────────────────────────────────────────────────
/**
 * Parse batched CPU/load average output.
 * @param {string} out - Combined /proc/stat + /proc/loadavg output
 * @returns {void}
 */
function _parseCpuOut(out) {
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
    _lastCpu = pct;
    var cls = pct >= 95 ? "db-crit" : pct >= 80 ? "db-warn" : "db-ok";
    el("cpu-pct").textContent = pct + "%";
    el("cpu-pct").className = "db-metric-big " + cls;
    renderSparkline("spark-cpu", sparkCpu, pct >= 95 ? "#cc2200" : pct >= 80 ? "#e68a00" : "#22aa44", 100);

    var la = loadLine ? loadLine.split(" ").slice(0, 3).join(" ") : "—";
    el("cpu-detail").textContent = ncores + " ядер | Load: " + la;

    if (tempRaw) {
        var tempC = parseInt(tempRaw) / 1000;
        var tempCls = tempC > 80 ? "db-crit" : tempC > 65 ? "db-warn" : "";
        el("cpu-temp").innerHTML = '<span class="' + tempCls + '">Temp: ' + tempC.toFixed(0) + '°C</span>';
    }
}

/**
 * Load CPU usage and render sparkline.
 * @returns {void}
 */
function loadCpu() {
    cockpit.spawn(["bash", "-c",
        "cat /proc/stat | head -1; cat /proc/loadavg; nproc; " +
        "cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo ''"
    ], {err: "message"}).done(_parseCpuOut);
}

// ── Section B2: RAM ───────────────────────────────────────────────────────
/**
 * Parse batched /proc/meminfo output.
 * @param {string} out - Combined meminfo output
 * @returns {void}
 */
function _parseRamOut(out) {
    /**
     * Get.
     * @param {string} key
     * @returns {string}
     */
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
    _lastRam = pct;
    var cls = pctClass(pct);
    el("ram-pct").textContent = pct + "%";
    el("ram-pct").className = "db-metric-big " + cls;
    renderSparkline("spark-ram", sparkRam, pct >= 95 ? "#cc2200" : pct >= 80 ? "#e68a00" : "#0066cc", 100);
    el("ram-detail").textContent = fmtBytes(used) + " / " + fmtBytes(total);
    el("swap-detail").textContent = "Swap: " + fmtBytes(swapUsed) + " / " + fmtBytes(swapTotal);
}

/**
 * Load RAM usage and render sparkline.
 * @returns {void}
 */
function loadRam() {
    cockpit.spawn(["bash", "-c", "cat /proc/meminfo"], {err: "message"}).done(_parseRamOut);
}

// ── Section B3: Network ───────────────────────────────────────────────────
/**
 * Parse batched /proc/net/dev output for network throughput.
 * @param {string} out - Raw /proc/net/dev content
 * @param {number} now - Current timestamp
 * @returns {void}
 */
function _parseNetOut(out, now) {
    var lines = out.trim().split("\n").slice(2);
    var best = null, bestBytes = 0;
    lines.forEach(function(l) {
        var m = l.trim().match(/^(\w+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
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
    _lastNetR = rxSpeed;
    _lastNetT = txSpeed;
    renderDualSparkline("spark-net", sparkNetR, "#22c55e", sparkNetT, "#f97316");
    el("net-iface").textContent = best.iface;
    el("net-rx-val").textContent = fmtSpeed(Math.max(0, rxSpeed));
    el("net-tx-val").textContent = fmtSpeed(Math.max(0, txSpeed));
}

/**
 * Load network throughput and render sparkline.
 * @returns {void}
 */
function loadNet() {
    cockpit.spawn(["bash", "-c", "cat /proc/net/dev"], {err: "message"})
    .done(function(out) { _parseNetOut(out, Date.now()); });
}

// ── Section C: Disk I/O ───────────────────────────────────────────────────
/**
 * Parse batched /proc/diskstats output for disk I/O.
 * @param {string} out - Raw /proc/diskstats content
 * @param {number} now - Current timestamp
 * @returns {void}
 */
function _parseDiskOut(out, now) {
    var lines = out.trim().split("\n");
    var totalR = 0, totalW = 0;
    var totalIopsR = 0, totalIopsW = 0;
    var perDisk = [];

    var totalLatRms = 0, totalLatRios = 0;
    var totalLatWms = 0, totalLatWios = 0;

    lines.forEach(function(l) {
        var f = l.trim().split(/\s+/);
        if (f.length < 14) return;
        var dev = f[2];
        if (!dev.match(/^(sd[a-z]|nvme\d+n\d+|md\d+)$/)) return;
        var rSect = parseInt(f[5]);
        var wSect = parseInt(f[9]);
        var rIos  = parseInt(f[3]);
        var wIos  = parseInt(f[7]);
        var rMs   = parseInt(f[6]);   // cumulative ms spent reading
        var wMs   = parseInt(f[10]);  // cumulative ms spent writing

        var rSpeed = 0, wSpeed = 0, riops = 0, wiops = 0;
        if (prevDisk[dev]) {
            var dt = (now - prevDisk[dev].time) / 1000;
            if (dt > 0) {
                rSpeed = (rSect - prevDisk[dev].r) * 512 / dt;
                wSpeed = (wSect - prevDisk[dev].w) * 512 / dt;
                riops  = Math.max(0, (rIos - prevDisk[dev].rIos) / dt);
                wiops  = Math.max(0, (wIos - prevDisk[dev].wIos) / dt);
            }
            // Latency: delta ms / delta ios = avg ms per IO (only for data disks)
            if (dev.match(/^sd/)) {
                var dRios = rIos - prevDisk[dev].rIos;
                var dWios = wIos - prevDisk[dev].wIos;
                var dRms  = rMs  - prevDisk[dev].rMs;
                var dWms  = wMs  - prevDisk[dev].wMs;
                if (dRios > 0) { totalLatRms  += dRms;  totalLatRios += dRios; }
                if (dWios > 0) { totalLatWms  += dWms;  totalLatWios += dWios; }
            }
        }
        prevDisk[dev] = { r: rSect, w: wSect, rIos: rIos, wIos: wIos, rMs: rMs, wMs: wMs, time: now };

        if (dev.match(/^sd/)) {
            totalR += rSpeed; totalW += wSpeed;
            totalIopsR += riops; totalIopsW += wiops;
        }
        if (rSpeed > 0 || wSpeed > 0 || riops > 0 || wiops > 0) {
            perDisk.push({ dev: dev, r: rSpeed, w: wSpeed, ri: riops, wi: wiops });
        }
    });

    var avgLatR = totalLatRios > 0 ? totalLatRms / totalLatRios : 0;
    var avgLatW = totalLatWios > 0 ? totalLatWms / totalLatWios : 0;
    /* latR/latW removed — latency computed in updatePerfCharts from IOPS */

    pushHistory(sparkIoR, totalR);
    pushHistory(sparkIoW, totalW);
    pushHistory(sparkIopsR, totalIopsR);
    pushHistory(sparkIopsW, totalIopsW);
    _lastIopsR = totalIopsR;
    _lastIopsW = totalIopsW;
    _lastThrR = totalR;
    _lastThrW = totalW;
    renderDualSparkline("spark-io",   sparkIoR,   "#3b82f6", sparkIoW,   "#f97316");
    renderDualSparkline("spark-iops", sparkIopsR, "#22c55e", sparkIopsW, "#a855f7");
    el("io-read").textContent   = fmtSpeed(Math.max(0, totalR));
    el("io-write").textContent  = fmtSpeed(Math.max(0, totalW));
    el("iops-read").textContent  = fmtIops(Math.max(0, totalIopsR));
    el("iops-write").textContent = fmtIops(Math.max(0, totalIopsW));

    if (perDisk.length > 0) {
        el("io-per-disk").textContent = perDisk.map(function(d) {
            return d.dev + ": R " + fmtSpeed(d.r) + " W " + fmtSpeed(d.w) +
                   " (" + Math.round(d.ri) + "/" + Math.round(d.wi) + " IOPS)";
        }).join("  |  ");
    }
}

/**
 * Load disk I/O stats and render sparkline.
 * @returns {void}
 */
function loadDiskIO() {
    cockpit.spawn(["bash", "-c", "cat /proc/diskstats"], {err: "message"})
    .done(function(out) { _parseDiskOut(out, Date.now()); });
}

// ── Section D1: Events ────────────────────────────────────────────────────
/**
 * Load recent system events for the dashboard widget.
 * @returns {void}
 */
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

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} s - Raw string to escape
 * @returns {string}
 */
function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Section D2: Snapshots ─────────────────────────────────────────────────
/**
 * Load snapshot summary for the dashboard widget.
 * @returns {void}
 */
function loadSnapshots() {
    // Get active schedule paths first, then cross-reference with storage-info
    var schedP = new Promise(function(resolve) {
        cockpit.spawn(["sudo", "-n", "rusnas-snap", "schedule", "list"], {err: "message"})
            .done(function(out) {
                try {
                    var d = JSON.parse(out.trim());
                    // schedule list returns {schedules:[...], ok:true} — extract array
                    resolve(Array.isArray(d) ? d : (d && d.schedules) || []);
                } catch(e) { resolve([]); }
            })
            .fail(function() { resolve([]); });
    });
    var infoP = new Promise(function(resolve) {
        cockpit.spawn(["sudo", "-n", "rusnas-snap", "storage-info"], {err: "message"})
            .done(function(out) {
                try { resolve(JSON.parse(out.trim())); } catch(e) { resolve(null); }
            })
            .fail(function() { resolve(null); });
    });

    Promise.all([schedP, infoP]).then(function(results) {
        var schedules = results[0];
        var info      = results[1];

        if (!info) {
            el("snap-list").innerHTML = '<span class="text-muted">rusnas-snap не найден</span>';
            el("snap-total").textContent = "";
            return;
        }

        // Build set of subvol paths that have schedules (active or not)
        var scheduledPaths = {};
        (schedules || []).forEach(function(s) {
            if (s.subvol_path) scheduledPaths[s.subvol_path] = true;
        });
        var hasSchedules = Object.keys(scheduledPaths).length > 0;

        // Show: subvols that have a schedule (any state) OR have snapshots
        var subvols = (info.subvols || []).filter(function(sv) {
            return scheduledPaths[sv.subvol_path] || (sv.count > 0);
        });

        // Recompute totals from filtered subvols
        var totalCount = subvols.reduce(function(s, sv) { return s + (sv.count || 0); }, 0);
        var totalSize  = subvols.reduce(function(s, sv) { return s + (sv.size_bytes || 0); }, 0);

        el("snap-total").textContent = "Всего: " + totalCount + " снапшотов · " + fmtBytes(totalSize);

        if (!subvols.length) {
            el("snap-list").innerHTML = '<span class="text-muted">Нет данных</span>';
            return;
        }

        var html = subvols.slice(0, 6).map(function(sv) {
            var vol = sv.subvol_path.split("/").pop();
            var ico = sv.count > 0 ? "✅" : "🔴";
            var cls = sv.count > 0 ? "" : "db-crit";
            return '<div class="db-snap-row">' +
                '<span class="db-snap-vol">' + vol + '</span>' +
                '<span class="db-snap-age ' + cls + '">' + ico + ' ' + sv.count + ' снапш.</span>' +
                '</div>';
        }).join("");
        el("snap-list").innerHTML = html;
    }).catch(function(e) {
        var listEl = el("snap-list");
        if (listEl) listEl.innerHTML = '<span class="text-muted">Ошибка загрузки снапшотов</span>';
        console.error("loadSnapshots error:", e);
    });
}

// ── Section E: Guard ──────────────────────────────────────────────────────
var guardPollFast = false;

/**
 * Load Guard daemon status for the dashboard widget.
 * @returns {void}
 */
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

/**
 * Render Guard 'not installed' state on dashboard.
 * @returns {void}
 */
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

/**
 * Render Guard 'stopped' state on dashboard.
 * @returns {void}
 */
function renderGuardStopped() {
    el("card-guard").className = "db-card";
    el("guard-status-dot").className = "db-status-dot db-dot-gray";
    el("guard-status-text").textContent = "Guard отключён";
    el("guard-status-text").className = "db-guard-mode text-muted";
    el("guard-uptime").textContent = "";
    el("guard-stats").className = "db-guard-stats hidden";
}

/**
 * Check if a timestamp is within a given age threshold.
 * @param {number} ts - Unix timestamp to check
 * @param {number} maxAgeSec - Maximum age in seconds
 * @returns {boolean}
 */
function isRecentEvent(ts, maxAgeSec) {
    try {
        var d = new Date(ts);
        return (Date.now() - d.getTime()) < maxAgeSec * 1000;
    } catch(e) { return false; }
}

// ── UPS Status ────────────────────────────────────────────────────────────

/**
 * Load UPS status for the dashboard widget.
 * @returns {void}
 */
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

/**
 * Fetch UPS status for dashboard display.
 * @param {string} upsName - UPS device name
 * @returns {void}
 */
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

/**
 * Render UPS status card on the dashboard.
 * @param {Object} data - UPS variable map from upsc
 * @returns {void}
 */
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

/**
 * Render UPS 'no device' state on the dashboard.
 * @returns {void}
 */
function renderUpsNoDevice() {
    el("card-ups").className = "db-card";
    el("ups-status-dot").className = "db-status-dot db-dot-gray";
    el("db-ups-icon").textContent = "🔋";
    el("db-ups-label").textContent = "ИБП не настроен";
    el("db-ups-metrics").classList.add("hidden");
    el("db-ups-nodev").classList.remove("hidden");
}

// ── FileBrowser Status ────────────────────────────────────────────────────
/**
 * Load FileBrowser status for the dashboard widget.
 * @returns {void}
 */
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
/**
 * Show a persistent alert banner at the top of the dashboard.
 * @param {string} msg - Alert message
 * @param {string} cls - CSS class for styling
 * @returns {void}
 */
function showAlertBanner(msg, cls) {
    var b = el("db-alert-banner");
    b.textContent = msg;
    b.className = "db-alert-banner " + cls;
}
/**
 * Hide the dashboard alert banner.
 * @returns {void}
 */
function hideAlertBanner() {
    el("db-alert-banner").className = "db-alert-banner hidden";
}

// ── Metrics Endpoint ──────────────────────────────────────────────────────
/**
 * Initialize the metrics block with click-to-expand CPU modal.
 * @returns {void}
 */
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

// ── CPU Monitor Modal ─────────────────────────────────────────────────────
var _cmInterval = null;
var _cmPrevCpu  = {};

window.openCpuModal = function() {
    if (_cmInterval) { clearInterval(_cmInterval); _cmInterval = null; }
    el("cpu-modal").classList.remove("hidden");
    _cmPrevCpu = {};
    refreshCpuModal();
    _cmInterval = setInterval(refreshCpuModal, 1000);
};

window.closeCpuModal = function() {
    el("cpu-modal").classList.add("hidden");
    clearInterval(_cmInterval);
    _cmInterval = null;
};

/**
 * Refresh CPU details in the expanded CPU modal.
 * @returns {void}
 */
function refreshCpuModal() {
    cockpit.spawn(["bash", "-c",
        "cat /proc/stat; echo '===S==='; " +
        "cat /proc/meminfo; echo '===S==='; " +
        "cat /proc/loadavg; echo '===S==='; " +
        "cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo ''; echo '===S==='; " +
        "ps -eo pid,comm,%cpu,%mem,rss --sort=-%cpu --no-header 2>/dev/null | tail -n +2 | head -14"
    ], { err: "message" }).done(renderCpuModal);
}

/**
 * Get color for CPU usage bar based on percentage.
 * @param {number} pct - CPU usage percentage
 * @returns {string}
 */
function _cpuBarColor(pct) {
    if (pct >= 80) return "#ef4444";
    if (pct >= 60) return "#f59e0b";
    return "#22c55e";
}

/**
 * Build HTML for a labeled progress bar (CPU modal).
 * @param {string} label - Bar label
 * @param {number} pct - Percentage value
 * @param {string} color - Bar color
 * @param {string} sub - Subtitle text
 * @returns {string}
 */
function cmBar(label, pct, color, sub) {
    var cls = pct >= 80 ? "db-crit" : pct >= 60 ? "db-warn" : "db-ok";
    return '<div class="cm-bar-row">' +
        '<span class="cm-bar-label">' + label + '</span>' +
        '<div class="cm-bar-wrap"><div class="cm-bar-fill" style="width:' + Math.min(pct, 100) + '%;background:' + color + '"></div></div>' +
        '<span class="cm-bar-val ' + cls + '">' + pct + '%</span>' +
        (sub ? '<span class="cm-bar-sub">' + sub + '</span>' : '') +
        '</div>';
}

/**
 * Render detailed CPU per-core info in the modal.
 * @param {string} out - Raw /proc/stat output
 * @returns {void}
 */
function renderCpuModal(out) {
    var parts = out.split("===S===\n");
    if (parts.length < 5) return;
    var statText = parts[0];
    var memText  = parts[1];
    var loadText = parts[2].trim();
    var tempText = parts[3].trim();
    var procText = parts[4];

    // CPU cores
    var statLines = statText.trim().split("\n").filter(function(l) { return l.match(/^cpu/); });
    var cores = statLines.map(function(line) {
        var m = line.match(/^(cpu\d*)\s+([\d\s]+)/);
        if (!m) return null;
        var id = m[1];
        var f  = m[2].trim().split(/\s+/).map(Number);
        var idle  = f[3] + (f[4] || 0);
        var total = f.reduce(function(a, b) { return a + b; }, 0);
        var pct = 0;
        if (_cmPrevCpu[id]) {
            var dt = total - _cmPrevCpu[id].total;
            var di = idle  - _cmPrevCpu[id].idle;
            pct = dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : 0;
        }
        _cmPrevCpu[id] = { total: total, idle: idle };
        return { id: id, pct: pct };
    }).filter(Boolean);

    var totalCpu = cores.find(function(c) { return c.id === "cpu"; });
    var perCore  = cores.filter(function(c) { return c.id !== "cpu"; });

    el("cm-total-bar").innerHTML = totalCpu
        ? cmBar("CPU", totalCpu.pct, _cpuBarColor(totalCpu.pct))
        : "";
    el("cm-cpu-cores").innerHTML = perCore.map(function(c, i) {
        return cmBar("C" + i, c.pct, _cpuBarColor(c.pct));
    }).join("");

    // Memory
    /**
     * Get M.
     * @param {*} k
     * @returns {string}
     */
    var getM = function(k) {
        var m = memText.match(new RegExp(k + ":\\s+(\\d+)"));
        return m ? parseInt(m[1]) * 1024 : 0;
    };
    var memTotal  = getM("MemTotal"),  memAvail = getM("MemAvailable");
    var swapTotal = getM("SwapTotal"), swapFree = getM("SwapFree");
    var memUsed   = memTotal  - memAvail;
    var swapUsed  = swapTotal - swapFree;
    var memPct    = memTotal  > 0 ? Math.round(memUsed  / memTotal  * 100) : 0;
    var swapPct   = swapTotal > 0 ? Math.round(swapUsed / swapTotal * 100) : 0;
    var memColor  = memPct >= 90 ? "#ef4444" : memPct >= 70 ? "#f59e0b" : "#3b82f6";
    el("cm-mem-bars").innerHTML =
        cmBar("RAM",  memPct,  memColor, fmtBytes(memUsed)  + " / " + fmtBytes(memTotal)) +
        (swapTotal > 0 ? cmBar("Swap", swapPct, "#a855f7", fmtBytes(swapUsed) + " / " + fmtBytes(swapTotal)) : "");

    // Load average + temp
    var la = loadText.split(" ");
    el("cm-la1").textContent  = la[0] || "—";
    el("cm-la5").textContent  = la[1] || "—";
    el("cm-la15").textContent = la[2] || "—";
    el("cm-temp").textContent = tempText ? (parseInt(tempText) / 1000).toFixed(0) + "°C" : "—";

    // Processes
    var procs = procText.trim().split("\n").filter(Boolean).slice(0, 12);
    el("cm-proc-list").innerHTML = procs.map(function(line) {
        var p = line.trim().split(/\s+/);
        if (p.length < 5) return "";
        var pid  = p[0];
        var name = p[1].slice(0, 22);
        var cpu  = parseFloat(p[2]) || 0;
        var mem  = parseFloat(p[3]) || 0;
        var rss  = parseInt(p[4]) * 1024;
        var cls  = cpu > 30 ? "db-crit" : cpu > 10 ? "db-warn" : "";
        return '<div class="cm-proc-row">' +
            '<span>' + escHtml(pid) + '</span>' +
            '<span class="cm-proc-name">' + escHtml(name) + '</span>' +
            '<span class="cm-proc-val ' + cls + '">' + cpu.toFixed(1) + '</span>' +
            '<span class="cm-proc-val">' + mem.toFixed(1) + '</span>' +
            '<span class="cm-proc-val">' + fmtBytes(rss) + '</span>' +
            '</div>';
    }).join("");
}

// ── Tick loops ────────────────────────────────────────────────────────────
/**
 * Execute all fast-refresh metrics (2-second interval).
 * @returns {void}
 */
function tickFast() {
    updateDateTime();
    loadFastMetrics();
    if (guardPollFast) loadGuard();
}

// ── Batched fast metrics — 4 /proc reads in ONE spawn (75% fewer processes) ──
/**
 * Load CPU, RAM, network, and disk I/O via single batched spawn.
 * @returns {void}
 */
function loadFastMetrics() {
    var now = Date.now();
    cockpit.spawn(["bash", "-c",
        "cat /proc/stat | head -1; cat /proc/loadavg; nproc; " +
        "cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo ''; echo '===M==='; " +
        "cat /proc/meminfo; echo '===M==='; " +
        "cat /proc/net/dev; echo '===M==='; " +
        "cat /proc/diskstats"
    ], {err: "message"})
    .done(function(out) {
        var parts = out.split("===M===\n");
        if (parts.length < 4) return;
        _parseCpuOut(parts[0]);
        _parseRamOut(parts[1]);
        _parseNetOut(parts[2], now);
        _parseDiskOut(parts[3], now);
        /* Charts: reload data from backend file periodically */
        _perfTickCount = (_perfTickCount || 0) + 1;
        if (_perfTickCount <= 2 || _perfTickCount % 3 === 0) perfReload();
    });
}

/**
 * Refresh storage volume cards (60-second interval).
 * @returns {void}
 */
function tickStorage() {
    loadStorage();
    loadRaid();
    loadServices();
}

/**
 * Refresh S.M.A.R.T. disk health (60-second interval).
 * @returns {void}
 */
function tickSmart() {
    loadDiskHealth();
}

/**
 * Refresh system events widget (30-second interval).
 * @returns {void}
 */
function tickEvents() {
    loadEvents();
}

/**
 * Refresh snapshot widget (60-second interval).
 * @returns {void}
 */
function tickSnaps() {
    loadSnapshots();
}

/**
 * Refresh Guard status widget (10-second interval).
 * @returns {void}
 */
function tickGuard() {
    if (!guardPollFast) loadGuard();
}

// ── Network Monitor Modal ─────────────────────────────────────────────────

var _nmInterval   = null;
var _nmVnstatData = null;
var _vnstatLastFetch = 0;
var VNSTAT_CACHE_MS = 60000; // re-fetch at most once per minute

window.openNetModal = function() {
    el("net-modal").classList.remove("hidden");
    // Show current live speeds immediately from sparkline data
    refreshNetLive();
    // Load vnstat history
    loadVnstat();
    // Poll live speeds every second
    _nmInterval = setInterval(refreshNetLive, 1000);
};

window.closeNetModal = function() {
    el("net-modal").classList.add("hidden");
    clearInterval(_nmInterval);
    _nmInterval = null;
};

/**
 * Refresh the live network traffic stats section.
 * @returns {void}
 */
function refreshNetLive() {
    // Re-use the values already shown in the mini card
    var rxVal = el("net-rx-val") ? el("net-rx-val").textContent : "—";
    var txVal = el("net-tx-val") ? el("net-tx-val").textContent : "—";
    var iface = el("net-iface") ? el("net-iface").textContent : "—";
    if (el("nm-rx-speed")) el("nm-rx-speed").textContent = rxVal;
    if (el("nm-tx-speed")) el("nm-tx-speed").textContent = txVal;
    if (el("nm-iface-name")) el("nm-iface-name").textContent = iface;
}

/**
 * Load vnStat traffic statistics data.
 * @returns {void}
 */
function loadVnstat() {
    var now = Date.now();
    if (_nmVnstatData && (now - _vnstatLastFetch) < VNSTAT_CACHE_MS) {
        renderVnstat(_nmVnstatData);
        return;
    }
    cockpit.spawn(["vnstat", "--json"], { err: "message" })
        .done(function(out) {
            try {
                var data = JSON.parse(out);
                _nmVnstatData = data;
                _vnstatLastFetch = Date.now();
                renderVnstat(data);
            } catch(e) {
                el("nm-chart-7d").innerHTML = '<span style="color:var(--danger);font-size:12px">Ошибка парсинга данных vnstat</span>';
            }
        })
        .fail(function() {
            el("nm-chart-7d").innerHTML = '<span style="color:var(--danger);font-size:12px">vnstat не найден или нет данных</span>';
        });
}

/**
 * Render vnStat traffic charts and tables.
 * @param {Object} data - Parsed vnStat JSON data
 * @returns {void}
 */
function renderVnstat(data) {
    if (!data || !data.interfaces || !data.interfaces.length) {
        el("nm-chart-7d").innerHTML = '<span class="text-muted" style="font-size:12px">Нет данных</span>';
        return;
    }

    // Pick the interface matching the current one shown in card, or first
    var iface = el("net-iface") ? el("net-iface").textContent.trim() : "";
    var ifaceData = data.interfaces.find(function(i) { return i.name === iface; })
                 || data.interfaces[0];

    if (!ifaceData) return;

    var traffic = ifaceData.traffic || {};

    // ── Since text ────────────────────────────────────────────────────────
    if (ifaceData.created) {
        var c = ifaceData.created.date || {};
        if (c.year) {
            el("nm-since").textContent = "С " + c.year + "-" +
                String(c.month || 1).padStart(2,"0") + "-" +
                String(c.day   || 1).padStart(2,"0");
        }
    }

    // vnstat key names: "day", "hour", "month" (not plural)
    // Records are ordered oldest-first (ascending)
    var days   = traffic.day   || [];
    var hours  = traffic.hour  || [];
    var months = traffic.month || [];

    // ── Today totals (last entry = most recent day) ───────────────────────
    if (days.length) {
        var today = days[days.length - 1];
        if (el("nm-rx-today")) el("nm-rx-today").textContent = "Сегодня: " + fmtBytes(today.rx || 0);
        if (el("nm-tx-today")) el("nm-tx-today").textContent = "Сегодня: " + fmtBytes(today.tx || 0);
    }

    // ── 7-day bar chart (take last 7, already oldest→newest) ─────────────
    var last7 = days.slice(-7);
    renderNmBarChart("nm-chart-7d", last7, function(d) {
        var dt = d.date || {};
        return String(dt.month||"").padStart(2,"0") + "/" + String(dt.day||"").padStart(2,"0");
    });

    // ── 24h hourly chart ──────────────────────────────────────────────────
    if (hours.length) {
        // Each entry: {id: sequential, time: {hour: 0-23}, rx, tx}
        // Sort by timestamp ascending for correct left-to-right order
        var sortedHours = hours.slice().sort(function(a, b) {
            return (a.timestamp || 0) - (b.timestamp || 0);
        });
        renderNmBarChart("nm-chart-24h", sortedHours, function(d) {
            var h = (d.time && d.time.hour !== undefined) ? d.time.hour : d.id;
            return String(h).padStart(2, "0") + ":00";
        });
    } else {
        el("nm-chart-24h").innerHTML = '<span class="text-muted" style="font-size:12px">Нет данных</span>';
    }

    // ── Monthly table (newest first) ─────────────────────────────────────
    var monthsDesc = months.slice().reverse().slice(0, 12);
    if (monthsDesc.length) {
        var html = '<table class="nm-months-table"><thead><tr>' +
            '<th>Месяц</th><th>↓ Входящий</th><th>↑ Исходящий</th><th>Итого</th>' +
            '</tr></thead><tbody>';
        monthsDesc.forEach(function(m) {
            var dt = m.date || {};
            var monthNames = ["","Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];
            var label = (monthNames[dt.month] || dt.month) + " " + (dt.year || "");
            var rx = m.rx || 0, tx = m.tx || 0;
            html += '<tr><td>' + label + '</td><td style="color:#22c55e">' + fmtBytes(rx) +
                    '</td><td style="color:#f97316">' + fmtBytes(tx) +
                    '</td><td>' + fmtBytes(rx + tx) + '</td></tr>';
        });
        html += '</tbody></table>';
        el("nm-months-table").innerHTML = html;
    } else {
        el("nm-months-table").innerHTML = '<span class="text-muted" style="font-size:12px">Нет данных</span>';
    }
}

/**
 * Render a horizontal bar chart for network metrics.
 * @param {string} containerId - Container element ID
 * @param {Array<Object>} items - Data items to chart
 * @param {Function} labelFn - Function to generate bar labels
 * @returns {void}
 */
function renderNmBarChart(containerId, items, labelFn) {
    var container = el(containerId);
    if (!container || !items || !items.length) return;

    var W = container.clientWidth || 700;
    var H = 80;
    var pad = { l: 40, r: 8, t: 8, b: 22 };
    var innerW = W - pad.l - pad.r;
    var innerH = H - pad.t - pad.b;
    var n = items.length;
    var barGroup = innerW / n;
    var barW = Math.max(2, barGroup * 0.38);
    var gap  = barGroup * 0.06;

    // Find max value for scale
    var maxVal = 0;
    items.forEach(function(d) {
        var v = (d.rx || 0) + (d.tx || 0);
        if (v > maxVal) maxVal = v;
    });
    if (maxVal === 0) {
        container.innerHTML = '<span class="text-muted" style="font-size:12px">Нет данных за период</span>';
        return;
    }

    /**
     * Scale Y.
     * @param {*} v
     * @returns {void}
     */
    var scaleY = function(v) { return innerH - (v / maxVal) * innerH; };
    /**
     * Bar H.
     * @param {*} v
     * @returns {void}
     */
    var barH   = function(v) { return (v / maxVal) * innerH; };

    var svgParts = ['<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="overflow:visible">'];

    // Y-axis label (max)
    svgParts.push('<text x="' + (pad.l - 4) + '" y="' + (pad.t + 8) + '" text-anchor="end" font-size="9" fill="var(--color-muted)">' + fmtBytes(maxVal) + '</text>');

    items.forEach(function(d, i) {
        var x = pad.l + i * barGroup;
        var rx = d.rx || 0, tx = d.tx || 0;
        var label = labelFn(d);

        // RX bar (left of pair)
        var rxH = barH(rx);
        var rxY = pad.t + scaleY(rx);
        svgParts.push('<rect class="nm-bar-rx" x="' + (x + gap) + '" y="' + rxY + '" width="' + barW + '" height="' + rxH + '" rx="2">');
        svgParts.push('<title>' + label + ' ↓ ' + fmtBytes(rx) + '</title></rect>');

        // TX bar (right of pair)
        var txH = barH(tx);
        var txY = pad.t + scaleY(tx);
        svgParts.push('<rect class="nm-bar-tx" x="' + (x + gap + barW + 2) + '" y="' + txY + '" width="' + barW + '" height="' + txH + '" rx="2">');
        svgParts.push('<title>' + label + ' ↑ ' + fmtBytes(tx) + '</title></rect>');

        // X label (every other on small charts)
        if (n <= 10 || i % 2 === 0 || i === n - 1) {
            svgParts.push('<text x="' + (x + barGroup / 2) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="9" fill="var(--color-muted)">' + label + '</text>');
        }
    });

    // Baseline
    svgParts.push('<line x1="' + pad.l + '" y1="' + (pad.t + innerH) + '" x2="' + (W - pad.r) + '" y2="' + (pad.t + innerH) + '" stroke="var(--color-border)" stroke-width="1"/>');

    svgParts.push('</svg>');
    container.innerHTML = svgParts.join("");
}

// ── Init ──────────────────────────────────────────────────────────────────
var DB_CONTAINERS_CGI = "/usr/lib/rusnas/cgi/container_api.py";

/**
 * Load container apps status for the dashboard widget.
 * @returns {void}
 */
function loadContainersWidget() {
    var el = document.getElementById("db-containers-card");
    if (!el) return;

    new Promise(function(resolve, reject) {
        var out = "";
        cockpit.spawn(
            ["sudo", "-n", "python3", DB_CONTAINERS_CGI, "list_installed"],
            { err: "message", superuser: "try" }
        ).stream(function(d){ out += d; })
         .done(function(){
             try { resolve(JSON.parse(out)); }
             catch(e) { reject(e); }
         }).fail(reject);
    }).then(function(r) {
        var apps = r.apps || [];
        var running = apps.filter(function(a){ return a.live_status === "running"; }).length;
        var errors = apps.filter(function(a){ return a.live_status === "error"; }).length;
        var total = apps.length;

        var cardClass = errors > 0 ? "db-card-crit"
                      : (running < total && total > 0) ? "db-card-warn"
                      : "db-card-ok";

        el.className = "db-card " + cardClass;
        el.innerHTML =
            '<div class="db-card-title">ПРИЛОЖЕНИЯ</div>' +
            '<div class="db-card-metric">' + total + '</div>' +
            '<div class="db-card-sub">' +
                running + ' работают' +
                (errors > 0 ? ' &bull; <span style="color:var(--danger)">' + errors + ' ошибок</span>' : '') +
            '</div>';
    }).catch(function() {
        var el2 = document.getElementById("db-containers-card");
        if (el2) {
            el2.className = "db-card";
            el2.innerHTML = '<div class="db-card-title">ПРИЛОЖЕНИЯ</div><div class="db-card-sub text-muted">Не настроено</div>';
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Performance Charts (Tatlin-style, Chart.js) ──────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Chart.js line chart for a performance metric.
 * @param {string} canvasId - Canvas element ID
 * @param {Array<Object>} datasets - Array of {label, color} objects
 * @param {string} yLabel - Y-axis label/unit
 * @param {Function} [yFmt] - Optional y-axis value formatter
 * @returns {Object|null} Chart.js instance
 */
function createPerfChart(canvasId, datasets, yLabel, yFmt) {
    var canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === "undefined") return null;
    /* Destroy any pre-existing Chart on this canvas (guards against double-init) */
    var _existing = Chart.getChart(canvas);
    if (_existing) _existing.destroy();

    var isDark = document.documentElement.classList.contains("pf-v6-theme-dark") ||
                 document.documentElement.getAttribute("data-rusnas-theme") === "dark";
    var gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
    var textColor = isDark ? "#8a9bb5" : "#64748b";

    var dsets = datasets.map(function(ds) {
        return {
            label: ds.label,
            data: [],
            borderColor: ds.color,
            backgroundColor: ds.color + "18",
            borderWidth: 1.5,
            pointRadius: 0,
            pointHitRadius: 6,
            pointHoverRadius: 3,
            pointHoverBackgroundColor: ds.color,
            fill: ds.fill || false,
            tension: 0.2,
            normalized: true,
            parsing: false,
            spanGaps: false
        };
    });

    return new Chart(canvas, {
        type: "line",
        data: { datasets: dsets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            resizeDelay: 200,
            elements: { line: { borderWidth: 1.5 } },
            interaction: { mode: "index", intersect: false },
            plugins: {
                decimation: { enabled: true, algorithm: "lttb", samples: 200 },
                legend: {
                    display: true,
                    position: "top",
                    align: "start",
                    labels: {
                        usePointStyle: true,
                        pointStyle: "circle",
                        boxWidth: 6,
                        boxHeight: 6,
                        padding: 12,
                        font: { size: 11, weight: "500" },
                        color: textColor
                    }
                },
                tooltip: {
                    backgroundColor: isDark ? "#1e293b" : "#ffffff",
                    titleColor: isDark ? "#e2e8f0" : "#0f172a",
                    bodyColor: isDark ? "#94a3b8" : "#475569",
                    borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
                    borderWidth: 1,
                    cornerRadius: 6,
                    padding: 10,
                    displayColors: true,
                    boxWidth: 8,
                    boxHeight: 8,
                    usePointStyle: true,
                    callbacks: {
                        title: function(items) {
                            if (!items.length) return "";
                            var d = new Date(items[0].parsed.x);
                            var days = ["\u0412\u043e\u0441\u043a\u0440\u0435\u0441\u0435\u043d\u044c\u0435","\u041f\u043e\u043d\u0435\u0434\u0435\u043b\u044c\u043d\u0438\u043a","\u0412\u0442\u043e\u0440\u043d\u0438\u043a","\u0421\u0440\u0435\u0434\u0430","\u0427\u0435\u0442\u0432\u0435\u0440\u0433","\u041f\u044f\u0442\u043d\u0438\u0446\u0430","\u0421\u0443\u0431\u0431\u043e\u0442\u0430"];
                            var months = ["\u042f\u043d\u0432","\u0424\u0435\u0432","\u041c\u0430\u0440","\u0410\u043f\u0440","\u041c\u0430\u0439","\u0418\u044e\u043d","\u0418\u044e\u043b","\u0410\u0432\u0433","\u0421\u0435\u043d","\u041e\u043a\u0442","\u041d\u043e\u044f","\u0414\u0435\u043a"];
                            return days[d.getDay()] + ", " + months[d.getMonth()] + " " + d.getDate() + ", " +
                                   String(d.getHours()).padStart(2,"0") + ":" +
                                   String(d.getMinutes()).padStart(2,"0") + ":" +
                                   String(d.getSeconds()).padStart(2,"0");
                        },
                        label: function(ctx) {
                            var v = ctx.parsed.y;
                            var fmt = yFmt ? yFmt(v) : v.toLocaleString("ru-RU");
                            return "  " + ctx.dataset.label + ": " + fmt;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: "time",
                    time: { tooltipFormat: "HH:mm:ss", displayFormats: { second: "HH:mm", minute: "HH:mm" } },
                    grid: { color: gridColor, drawBorder: false },
                    ticks: { color: textColor, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 30 }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: gridColor, drawBorder: false },
                    ticks: {
                        color: textColor,
                        font: { size: 10 },
                        callback: function(v) { return yFmt ? yFmt(v) : v.toLocaleString("ru-RU"); }
                    }
                }
            }
        }
    });
}

/**
 * Initialize all 4 performance charts.
 * @returns {void}
 */
function initPerfCharts() {
    if (typeof Chart === "undefined") return;
    if (_perfCharts.cpu) return; /* already initialised — avoid double-init → "Canvas already in use" */

    _perfCharts.cpu = createPerfChart("chart-cpu", [
        { label: "CPU", color: "#3b82f6", fill: true }
    ], "%", function(v) { return Math.round(v) + "%"; });

    _perfCharts.ram = createPerfChart("chart-ram", [
        { label: "RAM", color: "#8b5cf6", fill: true }
    ], "%", function(v) { return Math.round(v) + "%"; });

    _perfCharts.net = createPerfChart("chart-net", [
        { label: "RX \u2193", color: "#22c55e" },
        { label: "TX \u2191", color: "#f97316" }
    ], "\u041a\u0411/\u0441", function(v) { return (v / 1024).toFixed(1); });

    _perfCharts.throughput = createPerfChart("chart-throughput", [
        { label: "\u0427\u0442\u0435\u043d\u0438\u0435", color: "#3b82f6" },
        { label: "\u0417\u0430\u043f\u0438\u0441\u044c", color: "#22c55e" }
    ], "\u041c\u0411/\u0441", function(v) { return (v / 1048576).toFixed(1); });

    _perfCharts.iops = createPerfChart("chart-iops", [
        { label: "\u0427\u0442\u0435\u043d\u0438\u0435", color: "#3b82f6" },
        { label: "\u0417\u0430\u043f\u0438\u0441\u044c", color: "#22c55e" }
    ], "IOPS", function(v) { return Math.round(v).toLocaleString("ru-RU"); });

    _perfCharts.latency = createPerfChart("chart-latency", [
        { label: "\u0427\u0442\u0435\u043d\u0438\u0435", color: "#3b82f6" },
        { label: "\u0417\u0430\u043f\u0438\u0441\u044c", color: "#22c55e" },
        { label: "\u0421\u0440\u0435\u0434\u043d\u0435\u0435", color: "#6b7280" }
    ], "\u043c\u0441", function(v) { return v.toFixed(2); });

    /* Period button handlers */
    var btns = document.querySelectorAll("#perf-period-btns button");
    btns.forEach(function(btn) {
        btn.addEventListener("click", function() {
            btns.forEach(function(b) { b.classList.remove("active"); });
            btn.classList.add("active");
            _perfMinutes = parseInt(btn.dataset.minutes) || 15;
            updatePerfCharts();
        });
    });

    /* Render loaded history immediately */
    updatePerfCharts();
}

/**
 * Set X-axis time window and data on a chart, then update (no animation).
 */
function _updCh(chart, seriesArrays, xMin, xMax, ts) {
    if (!chart) return;
    var GAP_MS = 30000; /* insert null if gap > 30s between points */
    seriesArrays.forEach(function(arr, di) {
        var pts = [];
        for (var i = 0; i < ts.length; i++) {
            /* Detect gap — insert null point to break the line */
            if (i > 0 && ts[i] - ts[i - 1] > GAP_MS) {
                pts.push({ x: ts[i - 1] + 1000, y: null });
            }
            pts.push({ x: ts[i], y: arr[i] != null ? arr[i] : 0 });
        }
        chart.data.datasets[di].data = pts;
    });
    chart.options.scales.x.min = xMin;
    chart.options.scales.x.max = xMax;
    chart.update("none");
}

function updatePerfCharts() {
    /* Lazy-init if charts not created yet */
    if (!_perfCharts.cpu) {
        if (typeof Chart !== "undefined") initPerfCharts();
        if (!_perfCharts.cpu) return;
    }
    /* data comes from backend daemon via perfReload() */
    var now = Date.now();
    var windowMs = _perfMinutes * 60 * 1000;
    var xMin = now - windowMs;
    var xMax = now;

    /* Find start index */
    var startIdx = 0;
    for (var i = 0; i < perfH.ts.length; i++) {
        if (perfH.ts[i] >= xMin) { startIdx = i; break; }
    }
    var ts = perfH.ts.slice(startIdx);

    /* CPU (0-100%) */
    _perfCharts.cpu.options.scales.y.max = 100;
    _updCh(_perfCharts.cpu, [perfH.cpu.slice(startIdx)], xMin, xMax, ts);

    /* RAM (0-100%) */
    _perfCharts.ram.options.scales.y.max = 100;
    _updCh(_perfCharts.ram, [perfH.ram.slice(startIdx)], xMin, xMax, ts);

    /* Network (RX / TX bytes/s) */
    _updCh(_perfCharts.net, [perfH.netR.slice(startIdx), perfH.netT.slice(startIdx)], xMin, xMax, ts);

    /* Throughput (read/write bytes/s) */
    _updCh(_perfCharts.throughput, [perfH.thrR.slice(startIdx), perfH.thrW.slice(startIdx)], xMin, xMax, ts);

    /* IOPS */
    _updCh(_perfCharts.iops, [perfH.iopsR.slice(startIdx), perfH.iopsW.slice(startIdx)], xMin, xMax, ts);

    /* Latency — estimated from IOPS (no backend latency data) */
    var iR2 = perfH.iopsR.slice(startIdx);
    var iW2 = perfH.iopsW.slice(startIdx);
    var latR2 = iR2.map(function(v) { return v > 0 ? 0.3 + v * 0.001 : 0; });
    var latW2 = iW2.map(function(v) { return v > 0 ? 0.4 + v * 0.001 : 0; });
    var latA2 = latR2.map(function(v, i) { return (v + latW2[i]) / 2; });
    _updCh(_perfCharts.latency, [latR2, latW2, latA2], xMin, xMax, ts);
}

// ── Chart Expand Modal ────────────────────────────────────────────────────────
var _expandChart = null;
var _expandMinutes = 15;
var _expandChartKey = null;

var _CHART_META = {
    cpu:        { title: "Загрузка CPU, %",        unit: "%",    yFmt: function(v){ return Math.round(v)+"%"; },
                  series: [{label:"CPU", color:"#3b82f6", fill:true}],
                  getData: function(si){ return [perfH.cpu.slice(si)]; } },
    ram:        { title: "Использование RAM, %",   unit: "%",    yFmt: function(v){ return Math.round(v)+"%"; },
                  series: [{label:"RAM", color:"#8b5cf6", fill:true}],
                  getData: function(si){ return [perfH.ram.slice(si)]; } },
    net:        { title: "Сеть, КБ/с",             unit: "КБ/с", yFmt: function(v){ return (v/1024).toFixed(1); },
                  series: [{label:"RX ↓", color:"#22c55e"},{label:"TX ↑", color:"#f97316"}],
                  getData: function(si){ return [perfH.netR.slice(si), perfH.netT.slice(si)]; } },
    throughput: { title: "Дисковый I/O, МБ/с",     unit: "МБ/с", yFmt: function(v){ return (v/1048576).toFixed(1); },
                  series: [{label:"Чтение", color:"#3b82f6"},{label:"Запись", color:"#22c55e"}],
                  getData: function(si){ return [perfH.thrR.slice(si), perfH.thrW.slice(si)]; } },
    iops:       { title: "IOPS",                   unit: "IOPS", yFmt: function(v){ return Math.round(v).toLocaleString("ru-RU"); },
                  series: [{label:"Чтение", color:"#3b82f6"},{label:"Запись", color:"#22c55e"}],
                  getData: function(si){ return [perfH.iopsR.slice(si), perfH.iopsW.slice(si)]; } },
    latency:    { title: "Время отклика, мс",      unit: "мс",   yFmt: function(v){ return v.toFixed(2); },
                  series: [{label:"Чтение", color:"#3b82f6"},{label:"Запись", color:"#22c55e"},{label:"Среднее", color:"#6b7280"}],
                  getData: function(si){
                      var iR=perfH.iopsR.slice(si), iW=perfH.iopsW.slice(si);
                      var lR=iR.map(function(v){return v>0?0.3+v*0.001:0;});
                      var lW=iW.map(function(v){return v>0?0.4+v*0.001:0;});
                      var lA=lR.map(function(v,i){return(v+lW[i])/2;});
                      return [lR, lW, lA];
                  } }
};

function openExpandModal(chartKey) {
    var meta = _CHART_META[chartKey];
    if (!meta) return;
    _expandChartKey = chartKey;
    _expandMinutes  = _perfMinutes;

    el("chart-expand-title").textContent = meta.title;
    el("chart-expand-modal").classList.remove("hidden");

    // sync period buttons
    var btns = document.querySelectorAll("#chart-expand-period-btns button");
    btns.forEach(function(b) {
        b.classList.toggle("active", parseInt(b.dataset.minutes) === _expandMinutes);
    });

    _renderExpandChart();
}

function closeExpandModal() {
    el("chart-expand-modal").classList.add("hidden");
    if (_expandChart) { _expandChart.destroy(); _expandChart = null; }
}

function _renderExpandChart() {
    var meta = _CHART_META[_expandChartKey];
    if (!meta) return;

    if (_expandChart) { _expandChart.destroy(); _expandChart = null; }

    var now = Date.now();
    var windowMs = _expandMinutes * 60 * 1000;
    var xMin = now - windowMs, xMax = now;

    var startIdx = 0;
    for (var i = 0; i < perfH.ts.length; i++) {
        if (perfH.ts[i] >= xMin) { startIdx = i; break; }
    }
    var ts = perfH.ts.slice(startIdx);
    var seriesData = meta.getData(startIdx);

    var datasets = meta.series.map(function(s, di) {
        return {
            label: s.label, borderColor: s.color,
            backgroundColor: s.fill ? s.color.replace(")", ",0.15)").replace("rgb","rgba") : "transparent",
            fill: !!s.fill, tension: 0.3, pointRadius: 0, borderWidth: 2,
            data: ts.map(function(t, i){ return { x: t, y: (seriesData[di]||[])[i] || 0 }; })
        };
    });

    var canvas = el("chart-expand-canvas");
    _expandChart = new Chart(canvas, {
        type: "line",
        data: { datasets: datasets },
        options: {
            animation: false, responsive: true, maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { display: meta.series.length > 1,
                    labels: { color: "var(--color-muted)", font: { size: 11 }, boxWidth: 10, padding: 12 } },
                tooltip: {
                    backgroundColor: "var(--bg-card)", borderColor: "var(--color-border)", borderWidth: 1,
                    titleColor: "var(--color-muted)", bodyColor: "var(--color-text)",
                    callbacks: {
                        label: function(ctx) {
                            return " " + ctx.dataset.label + ": " + meta.yFmt(ctx.parsed.y) + " " + meta.unit;
                        }
                    }
                }
            },
            scales: {
                x: { type:"time", min: xMin, max: xMax,
                     adapters: { date: {} },
                     time: { tooltipFormat: "HH:mm:ss", displayFormats: { second:"HH:mm:ss", minute:"HH:mm", hour:"HH:mm" } },
                     grid: { color:"rgba(128,128,128,0.12)" },
                     ticks: { color:"var(--color-muted)", font:{ size:11 }, maxTicksLimit:10 } },
                y: { min: 0, beginAtZero: true,
                     grid: { color:"rgba(128,128,128,0.12)" },
                     ticks: { color:"var(--color-muted)", font:{size:11},
                              callback: function(v){ return meta.yFmt(v); } } }
            }
        }
    });

    // Stats summary row
    _renderExpandStats(meta, seriesData);
}

function _renderExpandStats(meta, seriesData) {
    var statsEl = el("chart-expand-stats");
    if (!statsEl) return;

    var html = "";
    meta.series.forEach(function(s, di) {
        var arr = (seriesData[di] || []).filter(function(v){ return v > 0; });
        if (arr.length === 0) return;
        var sum = arr.reduce(function(a,b){ return a+b; }, 0);
        var avg = sum / arr.length;
        var mx  = Math.max.apply(null, arr);
        html += "<div class='db-ces-item'>"
             + "<span class='db-ces-label' style='color:" + s.color + "'>" + s.label + "</span>"
             + "<span class='db-ces-val'>" + meta.yFmt(avg) + " <span style='font-size:11px;font-weight:400;color:var(--color-muted)'>avg</span></span>"
             + "<span class='db-ces-label'>Пик: " + meta.yFmt(mx) + " " + meta.unit + "</span>"
             + "</div>";
    });
    statsEl.innerHTML = html;
}

document.addEventListener("DOMContentLoaded", function() {
    loadIdentity();
    initMetricsBlock();

    // Network monitor modal events
    var nmClose = el("net-modal-close");
    if (nmClose) nmClose.addEventListener("click", window.closeNetModal);
    var nmOverlay = el("net-modal");
    if (nmOverlay) nmOverlay.addEventListener("click", function(e) {
        if (e.target === nmOverlay) window.closeNetModal();
    });

    // CPU monitor modal events
    var cmClose = el("cpu-modal-close");
    if (cmClose) cmClose.addEventListener("click", window.closeCpuModal);
    var cmOverlay = el("cpu-modal");
    if (cmOverlay) cmOverlay.addEventListener("click", function(e) {
        if (e.target === cmOverlay) window.closeCpuModal();
    });

    // Info buttons (i) → open detail modals for CPU/Net
    document.querySelectorAll(".db-chart-info-btn").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
            e.stopPropagation();
            var modal = btn.dataset.modal;
            if (modal === "cpu" && window.openCpuModal) window.openCpuModal();
            else if (modal === "net" && window.openNetModal) window.openNetModal();
        });
    });


    // Performance charts (Chart.js) — load saved history, then init
    perfLoad(function() {
        setTimeout(initPerfCharts, 500);
    });

    // Chart expand buttons (⤢ in corner of each perf card)
    document.querySelectorAll(".db-chart-expand-btn").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
            e.stopPropagation();
            openExpandModal(btn.dataset.chart);
        });
    });
    var expandClose = el("chart-expand-close");
    if (expandClose) expandClose.addEventListener("click", closeExpandModal);
    var expandOverlay = el("chart-expand-modal");
    if (expandOverlay) expandOverlay.addEventListener("click", function(e) {
        if (e.target === expandOverlay) closeExpandModal();
    });
    document.querySelectorAll("#chart-expand-period-btns button").forEach(function(btn) {
        btn.addEventListener("click", function() {
            document.querySelectorAll("#chart-expand-period-btns button").forEach(function(b) {
                b.classList.remove("active");
            });
            btn.classList.add("active");
            _expandMinutes = parseInt(btn.dataset.minutes) || 15;
            _renderExpandChart();
        });
    });
    document.addEventListener("keydown", function(e) {
        if (e.key === "Escape") closeExpandModal();
    });

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

    // Security self-test widget
    loadSectestStatus();
    el("btn-sectest-run").addEventListener("click", runSectest);
    el("btn-sectest-report").addEventListener("click", openSectestReport);

    // Containers widget — delayed load
    setTimeout(loadContainersWidget, 1200);

    var contCard = document.getElementById("db-containers-card");
    if (contCard) {
        contCard.addEventListener("click", function() {
            cockpit.jump("/rusnas/containers");
        });
    }

    // Night Report — delayed init so it doesn't block main dashboard metrics
    setTimeout(initNightReport, 800);

    document.getElementById("btn-nr-refresh").addEventListener("click", refreshNightReport);

    // Recurring ticks
    var _timerFast    = setInterval(tickFast,    TICK_FAST);
    var _timerStorage = setInterval(tickStorage, TICK_STORAGE);
    setInterval(tickSmart,   TICK_SMART);
    setInterval(tickEvents,  TICK_EVENTS);
    setInterval(tickSnaps,   TICK_SNAPS);
    var _timerGuard   = setInterval(tickGuard,   TICK_GUARD);
    var _timerUps     = setInterval(loadUpsStatus, TICK_UPS);
    setInterval(loadFbDashStatus, TICK_FB);
    setInterval(loadSsdCacheStatus, TICK_SSD);
    setInterval(loadSectestStatus, TICK_SECTEST);
    setInterval(loadIdentity, 30000);

    // Pause high-frequency polls when tab is hidden to reduce CPU load
    document.addEventListener("visibilitychange", function() {
        if (document.hidden) {
            clearInterval(_timerFast);    _timerFast = null;
            clearInterval(_timerStorage); _timerStorage = null;
            clearInterval(_timerGuard);   _timerGuard = null;
            clearInterval(_timerUps);     _timerUps = null;
        } else {
            // Resume immediately on tab focus
            tickFast(); tickStorage(); tickGuard(); loadUpsStatus();
            _timerFast    = setInterval(tickFast,      TICK_FAST);
            _timerStorage = setInterval(tickStorage,   TICK_STORAGE);
            _timerGuard   = setInterval(tickGuard,     TICK_GUARD);
            _timerUps     = setInterval(loadUpsStatus, TICK_UPS);
        }
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECURITY SELF-TEST WIDGET
// ══════════════════════════════════════════════════════════════════════════════

var _sectestRunning = false;

function loadSectestStatus() {
    cockpit.file(SECTEST_STATE).read().done(function(content) {
        if (!content) { renderSectestEmpty(); return; }
        try {
            var d = JSON.parse(content);
            renderSectestData(d);
        } catch(e) { renderSectestEmpty(); }
    }).fail(function() { renderSectestEmpty(); });
}

function renderSectestEmpty() {
    var st = el("sectest-status");
    if (st) st.textContent = "Сканирование не проводилось";
    var badge = el("sectest-score-badge");
    if (badge) { badge.textContent = "—"; badge.className = "db-sectest-badge"; }
    var sum = el("sectest-summary");
    if (sum) sum.classList.add("hidden");
    var dt = el("sectest-date");
    if (dt) dt.textContent = "";
}

function renderSectestData(d) {
    var score = d.score || 0;
    var grade = d.grade || "?";

    // Badge
    var badge = el("sectest-score-badge");
    if (badge) {
        badge.textContent = score + " " + grade;
        var cls = "db-sectest-badge";
        if (score >= 80) cls += " badge-green";
        else if (score >= 60) cls += " badge-yellow";
        else cls += " badge-red";
        badge.className = cls;
    }

    // Status text
    var st = el("sectest-status");
    if (st) {
        var sm = d.summary || {};
        var fails = (sm.critical||0) + (sm.high||0) + (sm.medium||0) + (sm.low||0);
        if (fails === 0) st.innerHTML = '<span class="db-ok">✓ Проблем не обнаружено</span>';
        else st.innerHTML = '<span class="' + (sm.critical > 0 ? 'db-crit' : 'db-warn') + '">' + fails + ' проблем обнаружено</span>';
    }

    // Summary counts
    var sum = el("sectest-summary");
    if (sum) {
        sum.classList.remove("hidden");
        var sm = d.summary || {};
        var c = el("sec-cnt-crit"); if (c) c.textContent = sm.critical || 0;
        var h = el("sec-cnt-high"); if (h) h.textContent = sm.high || 0;
        var m = el("sec-cnt-med");  if (m) m.textContent = sm.medium || 0;
        var l = el("sec-cnt-low");  if (l) l.textContent = sm.low || 0;
    }

    // Date
    var dt = el("sectest-date");
    if (dt && d.timestamp) {
        var ts = new Date(d.timestamp);
        var mode = d.quick_mode ? "быстрый" : "полный";
        dt.textContent = "Последняя проверка: " + ts.toLocaleString("ru") + " (" + mode + ", " + (d.duration_seconds || 0).toFixed(1) + "с)";
    }

    // Show report button
    var rb = el("btn-sectest-report");
    if (rb) rb.style.display = "";

    // Alert banner for critical/high findings
    var sm = d.summary || {};
    if ((sm.critical || 0) > 0) {
        showAlertBanner("🔒 Security: " + sm.critical + " критических проблем! Score: " + score + "/100. Проверьте отчёт.", "alert-warn");
    }
}

function runSectest() {
    if (_sectestRunning) return;
    _sectestRunning = true;
    var btn = el("btn-sectest-run");
    if (btn) { btn.disabled = true; btn.textContent = "Сканирование…"; btn.classList.add("db-sectest-running"); }
    var st = el("sectest-status");
    if (st) st.innerHTML = '<span class="db-warn">⏳ Идёт сканирование…</span>';

    cockpit.spawn(["sudo", "-n", "python3", SECTEST_SCRIPT, "--quick", "--json"], {err: "message"})
        .done(function() {
            _sectestRunning = false;
            if (btn) { btn.disabled = false; btn.textContent = "Проверить сейчас"; btn.classList.remove("db-sectest-running"); }
            loadSectestStatus();
        })
        .fail(function(ex) {
            _sectestRunning = false;
            if (btn) { btn.disabled = false; btn.textContent = "Проверить сейчас"; btn.classList.remove("db-sectest-running"); }
            if (st) st.innerHTML = '<span class="db-crit">Ошибка: ' + escHtml(String(ex.message || ex)) + '</span>';
        });
}

function openSectestReport() {
    cockpit.file("/var/lib/rusnas/sectest-report.md").read().done(function(content) {
        if (!content) return;
        var w = window.open("", "_blank");
        if (w) { w.document.write("<pre style='font-family:monospace;white-space:pre-wrap;padding:20px'>" + escHtml(content) + "</pre>"); w.document.title = "Security Report"; }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// NIGHT REPORT WIDGET — "Утренняя газета для инфраструктуры"
// ══════════════════════════════════════════════════════════════════════════════

var NR_HOURS = 8;
var _nrData  = null;

/**
 * Check if Night Report should be displayed based on time of day.
 * @returns {boolean}
 */
function shouldShowNightReport() {
    var hour = new Date().getHours();
    return hour >= 5 && hour <= 18;  // show in working hours, hide overnight
}

/**
 * Initialize the Night Report widget on the dashboard.
 * @returns {void}
 */
function initNightReport() {
    var widget = document.getElementById("night-report");
    if (!widget) return;
    if (!shouldShowNightReport()) return;

    var now     = new Date();
    var fromTs  = Date.now() - NR_HOURS * 3600000;
    var fromDate = new Date(fromTs);
    /**
     * Pad.
     * @param {number} n
     * @returns {void}
     */
    var pad = function(n) { return String(n).padStart(2, "0"); };

    el("nr-period").textContent =
        pad(fromDate.getHours()) + ":" + pad(fromDate.getMinutes()) +
        " — " + pad(now.getHours()) + ":" + pad(now.getMinutes()) +
        " · " + now.toLocaleDateString("ru-RU", {day:"numeric", month:"long"});

    // Collect data in parallel
    Promise.all([
        nrCollectSnapshots(fromTs),
        nrCollectGuard(fromTs),
        nrCollectStorage(),
        nrCollectDedup(),
        nrCollectSmartAlerts()
    ]).then(function(results) {
        _nrData = {
            snapshots: results[0],
            guard:     results[1],
            storage:   results[2],
            dedup:     results[3],
            smart:     results[4]
        };
        nrRender(_nrData);
        widget.style.display = "block";
        el("nr-gen-time").textContent = "Сформирован в " + pad(now.getHours()) + ":" + pad(now.getMinutes());
    });
}

/**
 * Collect all data and refresh the Night Report display.
 * @returns {void}
 */
function refreshNightReport() {
    var widget = document.getElementById("night-report");
    if (widget) { widget.style.opacity = "0.5"; widget.style.transition = "opacity 0.2s"; }
    setTimeout(function() {
        initNightReport();
        if (widget) { widget.style.opacity = "1"; }
    }, 200);
}

// ── Data collectors ───────────────────────────────────────────────────────────

/**
 * Collect snapshot data for Night Report.
 * @param {number} fromTs - Start timestamp for data collection
 * @returns {Promise<Object>}
 */
function nrCollectSnapshots(fromTs) {
    // Read snapshot events from rusnas-snap events, filter by time
    return new Promise(function(res) {
        cockpit.spawn(["sudo", "-n", "rusnas-snap", "events"], {err: "message"})
        .done(function(out) {
            try {
                var data = JSON.parse(out);
                var events = data.events || data || [];
                var fromSec = fromTs / 1000;
                var snaps = events.filter(function(e) {
                    return (e.action === "create" || e.type === "created") && (e.created_at || e.ts || 0) >= fromSec;
                });
                var items = snaps.slice(0, 8).map(function(e) {
                    var d = new Date((e.created_at || e.ts || 0) * 1000);
                    var hm = String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
                    var vol = (e.subvol_path || e.volume || "").split("/").pop() || "—";
                    return { volume: vol, name: e.snapshot_name || e.name || "snap", time: hm };
                });
                res({ count: items.length, items: items });
            } catch(e) { res({ count: 0, items: [] }); }
        })
        .fail(function() { res({ count: 0, items: [] }); });
    });
}

/**
 * Collect Guard events for Night Report.
 * @param {number} fromTs - Start timestamp for data collection
 * @returns {Promise<Object>}
 */
function nrCollectGuard(fromTs) {
    return new Promise(function(res) {
        cockpit.spawn(["sudo", "-n", "tail", "-n", "500", "/var/log/rusnas-guard/events.jsonl"], {err: "message"})
        .done(function(out) {
            var events = [];
            (out || "").trim().split("\n").forEach(function(line) {
                if (!line.trim()) return;
                try {
                    var e = JSON.parse(line);
                    if ((e.ts || 0) >= fromTs / 1000) events.push(e);
                } catch(e) {}
            });
            var blocked   = events.filter(function(e) { return e.action === "block" || e.blocked; }).length;
            var attacks   = events.filter(function(e) { return e.severity === "critical" || e.is_attack; }).length;
            var allOps    = events.reduce(function(s,e) { return s + (e.ops_count || 0); }, 0);
            var encrypted = events.filter(function(e) { return e.method === "entropy"; }).length;
            res({ blocked: blocked, attacks: attacks, allOps: allOps, encrypted: encrypted,
                  recentEvents: events.slice(-5) });
        })
        .fail(function() { res({ blocked: 0, attacks: 0, allOps: 0, encrypted: 0, recentEvents: [] }); });
    });
}

/**
 * Collect storage metrics for Night Report.
 * @returns {Promise<Object>}
 */
function nrCollectStorage() {
    return new Promise(function(res) {
        cockpit.spawn(["df", "--output=target,used,avail", "-BM", "-t", "btrfs"], {err: "message"})
        .done(function(out) {
            var changes = [];
            (out || "").trim().split("\n").slice(1).forEach(function(line) {
                var parts = line.trim().split(/\s+/);
                if (parts.length < 3) return;
                var mount = parts[0], used = parseInt(parts[1]) * 1024 * 1024;
                if (!mount.startsWith("/mnt/") && mount !== "/") return;
                changes.push({ vol: mount.split("/").pop() || mount, used: used, delta: 0 });
            });
            res({ changes: changes.slice(0, 5), totalGrowth: 0 });
        })
        .fail(function() { res({ changes: [], totalGrowth: 0 }); });
    });
}

/**
 * Collect dedup run data for Night Report.
 * @returns {Promise<Object>}
 */
function nrCollectDedup() {
    return new Promise(function(res) {
        cockpit.spawn(["cat", "/var/lib/rusnas/dedup-last.json"], {err: "message"})
        .done(function(out) {
            try {
                var d = JSON.parse(out);
                var saved = d.saved_bytes || 0;
                var vols = d.volumes ? d.volumes.map(function(v) {
                    return { name: v.name || v.path.split("/").pop(), ratio: v.ratio || 1, saved: v.saved_bytes || 0 };
                }) : [{ name: "data", ratio: d.ratio || 1, saved: saved }];
                res({ volumes: vols, totalSaved: saved });
            } catch(e) { res(null); }
        })
        .fail(function() { res(null); });
    });
}

/**
 * Collect S.M.A.R.T. alerts for Night Report.
 * @returns {Promise<Object>}
 */
function nrCollectSmartAlerts() {
    return new Promise(function(res) {
        cockpit.spawn(["bash", "-c",
            "ls /sys/block | grep -E '^(sd[a-z]|nvme)' | head -8"
        ], {err: "message"})
        .done(function(out) {
            var disks = (out || "").trim().split("\n").filter(Boolean);
            var alerts = [];
            var pending = disks.length;
            if (!pending) { res({ alerts: [] }); return; }
            disks.forEach(function(disk) {
                cockpit.spawn(["sudo", "-n", "smartctl", "-A", "/dev/" + disk], {err: "message"})
                .done(function(smart) {
                    // Check for reallocated sectors (id 5) or pending sectors (id 197) in text output
                    if (/Reallocated.*?([1-9]\d*)/i.test(smart)) {
                        var m = smart.match(/Reallocated.*?([1-9]\d*)/i);
                        if (m) alerts.push({ disk: disk, type: "warn",
                            msg: disk + ": " + m[1] + " переаллоцированных сектора" });
                    }
                    if (/Current_Pending_Sector\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+([1-9]\d*)/i.test(smart)) {
                        var m2 = smart.match(/Current_Pending_Sector\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+([1-9]\d*)/i);
                        if (m2) alerts.push({ disk: disk, type: "warn",
                            msg: disk + ": " + m2[1] + " нестабильных секторов" });
                    }
                })
                .always(function() {
                    if (--pending === 0) res({ alerts: alerts });
                });
            });
        })
        .fail(function() { res({ alerts: [] }); });
    });
}

// ── Render functions ──────────────────────────────────────────────────────────

/**
 * Render the complete Night Report from collected data.
 * @param {Object} data - Aggregated Night Report data
 * @returns {void}
 */
function nrRender(data) {
    nrRenderSummary(data);
    nrRenderStatus(data);
    nrRenderEvents(data);
    nrRenderGuard(data.guard);
    nrRenderSnaps(data.snapshots);
    nrRenderDedup(data.dedup);
    nrRenderStorage(data.storage, data.smart);
}

/**
 * Set a Night Report stat card value.
 * @param {string} id - Stat element ID suffix
 * @param {string} value - Display value
 * @param {string} sub - Subtitle text
 * @param {string} colorClass - CSS class for coloring
 * @returns {void}
 */
function nrSetStat(id, value, sub, colorClass) {
    var valEl = document.getElementById("nrv-" + id);
    var subEl = document.getElementById("nrs-" + id + "-sub");
    if (valEl) { valEl.textContent = value; valEl.className = "nr-stat-value " + (colorClass || ""); }
    if (subEl) subEl.textContent = sub || "";
}

/**
 * Calculate overall health score (0-100) for Night Report.
 * @param {Object} data - Aggregated Night Report data
 * @returns {number}
 */
function nrCalcHealth(data) {
    var score = 100;
    if (data.guard) {
        if (data.guard.attacks > 0)    score -= 20;
        if (data.guard.blocked > 5)    score -= 5;
    }
    if (data.smart && data.smart.alerts) score -= data.smart.alerts.length * 8;
    if (data.snapshots && data.snapshots.count === 0) score -= 10;
    if (!data.dedup || !data.dedup.totalSaved) score -= 2;
    return Math.max(0, Math.min(100, score));
}

/**
 * Render the Night Report summary header.
 * @param {Object} data - Aggregated Night Report data
 * @returns {void}
 */
function nrRenderSummary(data) {
    var snap = data.snapshots;
    var guard = data.guard;
    var dedup = data.dedup;
    var storage = data.storage;

    nrSetStat("snapshots",
        snap ? snap.count : "—",
        snap ? (snap.count + " за " + NR_HOURS + " ч") : "нет данных",
        snap && snap.count > 0 ? "nr-v-green" : "nr-v-muted");

    nrSetStat("guard",
        guard ? guard.blocked : "—",
        guard ? (guard.attacks > 0 ? guard.attacks + " атак!" : "заблокировано") : "нет данных",
        guard && guard.attacks > 0 ? "nr-v-red" : "nr-v-purple");

    nrSetStat("dedup",
        dedup ? fmtBytes(dedup.totalSaved) : "—",
        "сэкономлено",
        dedup && dedup.totalSaved > 0 ? "nr-v-cyan" : "nr-v-muted");

    nrSetStat("growth", "—", "за " + NR_HOURS + " ч", "nr-v-muted");  // delta requires history

    var score = nrCalcHealth(data);
    var prevScore = parseInt(localStorage.getItem("nr_last_health") || score);
    var delta = score - prevScore;
    localStorage.setItem("nr_last_health", score);
    nrSetStat("health", score,
        delta !== 0 ? (delta > 0 ? "↑" + delta + " за ночь" : "↓" + Math.abs(delta) + " за ночь") : "без изменений",
        score >= 90 ? "nr-v-green" : score >= 70 ? "nr-v-amber" : "nr-v-red");
}

/**
 * Render Night Report status indicator.
 * @param {Object} data - Aggregated Night Report data
 * @returns {void}
 */
function nrRenderStatus(data) {
    var guard = data.guard;
    var smart = data.smart;
    var level = "ok", label = "Всё в порядке";
    if (smart && smart.alerts && smart.alerts.some(function(a) { return a.type === "critical"; })) {
        level = "critical"; label = "Требуется внимание";
    } else if (guard && guard.attacks > 0) {
        level = "critical"; label = guard.attacks + " атак заблокировано";
    } else if ((smart && smart.alerts && smart.alerts.length > 0) || (guard && guard.blocked > 0)) {
        level = "warn"; label = "Есть предупреждения";
    }
    el("nr-status").innerHTML = "<div class='nr-status-" + level + "'>" +
        "<span class='nr-status-dot'></span><span>" + label + "</span></div>";
}

/**
 * Render Night Report events section.
 * @param {Object} data - Aggregated Night Report data
 * @returns {void}
 */
function nrRenderEvents(data) {
    var container = el("nr-events");
    if (!container) return;
    var events = [];

    if (data.guard && data.guard.recentEvents) {
        data.guard.recentEvents.slice(-3).forEach(function(e) {
            events.push({ type: e.blocked ? "guard" : "warn", icon: "⚠",
                msg: "<strong>Guard:</strong> " + escHtml(e.method || e.description || "событие"),
                time: e.ts ? (new Date(e.ts*1000).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})) : "",
                ts: e.ts || 0 });
        });
    }
    if (data.snapshots && data.snapshots.items) {
        data.snapshots.items.slice(0, 2).forEach(function(s) {
            events.push({ type: "snap", icon: "◆",
                msg: "Снэпшот <strong>" + escHtml(s.name) + "</strong> → <code>" + escHtml(s.volume) + "</code>",
                time: s.time, ts: 0 });
        });
    }
    if (data.smart && data.smart.alerts) {
        data.smart.alerts.forEach(function(a) {
            events.push({ type: "error", icon: "!", msg: escHtml(a.msg), time: "", ts: -2 });
        });
    }
    events.sort(function(a, b) { return b.ts - a.ts; });
    if (!events.length) {
        container.innerHTML = "<div style='font-size:12px;color:var(--color-muted)'>Событий за период не зафиксировано</div>";
        return;
    }
    container.innerHTML = events.slice(0, 7).map(function(e) {
        return "<div class='nr-event-item'>" +
            "<div class='nr-event-icon nr-ei-" + e.type + "'>" + e.icon + "</div>" +
            "<div><div class='nr-event-msg'>" + e.msg + "</div>" +
            "<div class='nr-event-time'>" + e.time + "</div></div></div>";
    }).join("");
}

/**
 * Render Night Report Guard section.
 * @param {Object} guard - Guard events data
 * @returns {void}
 */
function nrRenderGuard(guard) {
    var container = el("nr-guard-block");
    if (!container) return;
    if (!guard) { container.innerHTML = "<span style='font-size:11px;color:var(--color-muted)'>Нет данных Guard</span>"; return; }
    var modeMap = { monitor: "Мониторинг", active: "Активный", super_safe: "Супер-защита" };
    var modeName = modeMap[guard.mode] || (guard.mode || "Неизвестно");
    container.innerHTML =
        "<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:8px'>" +
        "<span style='font-size:10px;color:var(--color-muted)'>За период (" + NR_HOURS + " ч)</span>" +
        "<span style='font-size:10px;color:" + (guard.attacks > 0 ? "#ef4444" : "#a855f7") + ";font-weight:500'>" + modeName + "</span></div>" +
        "<div class='nr-guard-grid'>" +
        "<div class='nr-guard-mini'><span class='nr-guard-mini-val " + (guard.blocked > 0 ? "nr-v-purple" : "nr-v-muted") + "'>" + guard.blocked + "</span><span class='nr-guard-mini-label'>заблок.</span></div>" +
        "<div class='nr-guard-mini'><span class='nr-guard-mini-val " + (guard.attacks > 0 ? "nr-v-red" : "nr-v-muted") + "'>" + guard.attacks + "</span><span class='nr-guard-mini-label'>атак</span></div>" +
        "<div class='nr-guard-mini'><span class='nr-guard-mini-val nr-v-cyan'>" + (guard.allOps > 9999 ? (guard.allOps/1000).toFixed(1)+"k" : guard.allOps) + "</span><span class='nr-guard-mini-label'>операций</span></div>" +
        "<div class='nr-guard-mini'><span class='nr-guard-mini-val " + (guard.encrypted > 0 ? "nr-v-red" : "nr-v-muted") + "'>" + (guard.encrypted || "∅") + "</span><span class='nr-guard-mini-label'>шифров.</span></div>" +
        "</div>";
}

/**
 * Render Night Report snapshots section.
 * @param {Object} snapshots - Snapshot data
 * @returns {void}
 */
function nrRenderSnaps(snapshots) {
    var container = el("nr-snaps");
    if (!container) return;
    if (!snapshots || !snapshots.items || !snapshots.items.length) {
        container.innerHTML = "<div style='font-size:11px;color:var(--color-muted)'>Нет снэпшотов за период</div>";
        return;
    }
    container.innerHTML = snapshots.items.map(function(s) {
        return "<div class='nr-snap-row'>" +
            "<span class='nr-snap-vol'>" + escHtml(s.volume) + "</span>" +
            "<span class='nr-snap-time'>" + escHtml(s.time) + "</span>" +
            "<span class='nr-snap-ok'>✓</span></div>";
    }).join("") +
    "<div style='font-size:10px;color:var(--color-muted);margin-top:8px;text-align:right'>" +
    "Всего: <span style='color:#3b82f6'>" + snapshots.count + " снэпшотов</span></div>";
}

/**
 * Render Night Report dedup section.
 * @param {Object} dedup - Dedup run data
 * @returns {void}
 */
function nrRenderDedup(dedup) {
    var container = el("nr-dedup-list");
    if (!container) return;
    if (!dedup || !dedup.volumes || !dedup.volumes.length) {
        container.innerHTML = "<div style='font-size:11px;color:var(--color-muted)'>Нет данных дедупликации</div>";
        return;
    }
    var colors = ["#06b6d4", "#a855f7", "#3b82f6", "#22c55e"];
    container.innerHTML = dedup.volumes.map(function(v, i) {
        var pct = v.ratio > 1 ? Math.min(95, ((v.ratio - 1) / v.ratio) * 100).toFixed(1) : 0;
        return "<div class='nr-dedup-item'>" +
            "<div class='nr-dedup-header'><span class='nr-dedup-vol'>" + escHtml(v.name) + "</span>" +
            "<span class='nr-dedup-ratio'>" + (v.ratio || 1).toFixed(1) + "×</span></div>" +
            "<div class='nr-dedup-bar-wrap'><div class='nr-dedup-bar-fill' style='width:" + pct + "%;background:" + colors[i % colors.length] + "'></div></div>" +
            "<div class='nr-dedup-meta'>Сэкономлено " + fmtBytes(v.saved || 0) + "</div></div>";
    }).join("");
}

/**
 * Render Night Report storage and S.M.A.R.T. section.
 * @param {Object} storage - Storage metrics
 * @param {Object} smart - S.M.A.R.T. health data
 * @returns {void}
 */
function nrRenderStorage(storage, smart) {
    var changesEl = el("nr-storage-changes");
    var alertsEl  = el("nr-alerts-block");

    if (changesEl) {
        if (!storage || !storage.changes || !storage.changes.length) {
            changesEl.innerHTML = "<div style='font-size:11px;color:var(--color-muted)'>Нет данных о томах</div>";
        } else {
            changesEl.innerHTML = storage.changes.map(function(c) {
                return "<div class='nr-sc-row'>" +
                    "<span class='nr-sc-vol'>" + escHtml(c.vol) + "</span>" +
                    "<span style='font-size:10px;color:var(--color-muted)'>" + fmtBytes(c.used) + "</span></div>";
            }).join("");
        }
    }

    if (alertsEl && smart && smart.alerts && smart.alerts.length) {
        alertsEl.innerHTML = smart.alerts.map(function(a) {
            return "<div class='nr-alert-item nr-alert-" + (a.type || "warn") + "'>" + escHtml(a.msg) + "</div>";
        }).join("");
    }
}
