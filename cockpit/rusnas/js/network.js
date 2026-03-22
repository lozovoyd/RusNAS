"use strict";

var NET_API = "/usr/share/cockpit/rusnas/scripts/network-api.py";

// ── Global state ──────────────────────────────────────────────────────────────
var _netInterfaces = [];
var _netHosts      = [];
var _netRoutes     = [];
var _trafficPrev   = {};       // {iface: {rx, tx, ts}}
var _trafficTimer  = null;
var _diagProc      = null;     // running cockpit.spawn process
var _diagTool      = "ping";
var _hostEditIdx   = -1;       // index in _netHosts for edit mode, -1 = new
var _confirmCb     = null;     // callback for generic confirm modal
var _ifacePendingCfg = null;   // pending iface config waiting for IP-warn confirm
var _wolHistory    = [];
var _rollbackState = null;     // { iface, timer } | null — active auto-revert session

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmtBytes(b) {
    b = parseInt(b) || 0;
    if (b === 0) return "0 Б";
    var u = ["Б","КБ","МБ","ГБ","ТБ"];
    var i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(1) + "\u00a0" + u[Math.min(i,4)];
}

function fmtSpeed(bps) {
    bps = parseInt(bps) || 0;
    if (bps < 1024)        return bps + "\u00a0Б/с";
    if (bps < 1048576)     return (bps/1024).toFixed(1) + "\u00a0КБ/с";
    if (bps < 1073741824)  return (bps/1048576).toFixed(1) + "\u00a0МБ/с";
    return (bps/1073741824).toFixed(2) + "\u00a0ГБ/с";
}

function safeJson(str) {
    try { return JSON.parse(str.trim()); } catch(e) { return null; }
}

function validateIp(ip) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) ||
           /^[0-9a-fA-F:]+$/.test(ip);
}

function validateCidr(s) {
    var m = s.match(/^([\d.]+)\/(\d+)$/);
    if (m) return {valid: true, ip: m[1], prefix: parseInt(m[2])};
    return {valid: false};
}

function maskToPrefix(mask) {
    if (/^\d+$/.test(mask)) return parseInt(mask);
    var parts = mask.split(".");
    if (parts.length === 4) {
        return parts.reduce(function(n, p) {
            return n + parseInt(p).toString(2).replace(/0/g,"").length;
        }, 0);
    }
    return 24;
}

function escHtml(s) {
    return String(s)
        .replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── API wrapper ───────────────────────────────────────────────────────────────

function netApi(args) {
    return new Promise(function(resolve, reject) {
        var out = "";
        var proc = cockpit.spawn(
            ["sudo", "-n", "python3", NET_API].concat(args),
            { err: "message", superuser: "try" }
        );
        proc.stream(function(data) { out += data; });
        proc.done(function() {
            var j = safeJson(out);
            if (j) resolve(j); else reject(new Error("Bad JSON: " + out.slice(0,200)));
        });
        proc.fail(function(ex) {
            var j = safeJson(out);
            if (j) resolve(j); else reject(ex);
        });
    });
}

// ── Tab switching ─────────────────────────────────────────────────────────────

var _tabLoaded = {};

function switchTab(tabName) {
    document.querySelectorAll(".net-tab-content").forEach(function(el) {
        el.style.display = "none";
    });
    document.querySelectorAll("#netTabs .advisor-tab-btn").forEach(function(btn) {
        btn.classList.remove("active");
    });
    var content = document.getElementById("tab-" + tabName);
    if (content) content.style.display = "";
    var btn = document.querySelector('#netTabs .advisor-tab-btn[data-tab="' + tabName + '"]');
    if (btn) btn.classList.add("active");

    if (!_tabLoaded[tabName]) {
        _tabLoaded[tabName] = true;
        if (tabName === "dns")    { loadDns(); loadHosts(); }
        if (tabName === "routes") loadRoutes();
        if (tabName === "diag")   populateWolIfaceSelect();
        if (tabName === "certs")  loadCerts();
        if (tabName === "domain") initDomainTab();
    }
}

// ── Interfaces tab ────────────────────────────────────────────────────────────

function loadInterfaces() {
    netApi(["get-interfaces"]).then(function(data) {
        if (!data.ok) {
            document.getElementById("ifaceCards").innerHTML =
                '<div class="net-loading" style="color:var(--danger)">Ошибка: ' + escHtml(data.error || "") + '</div>';
            return;
        }
        _netInterfaces = data.interfaces || [];
        renderIfaceCards();
        renderStatusBar();
        populateWolIfaceSelect();

        // Check if any interface has a pending auto-revert (e.g. after page reload)
        if (!_rollbackState) {
            _netInterfaces.forEach(function(iface) {
                netApi(["get-pending", iface.name]).then(function(r) {
                    if (r.pending && !_rollbackState) {
                        startRollbackCountdown(iface.name, r.seconds);
                    }
                }).catch(function() {});
            });
        }
    }).catch(function(e) {
        document.getElementById("ifaceCards").innerHTML =
            '<div class="net-loading" style="color:var(--danger)">Ошибка загрузки: ' + escHtml(String(e)) + '</div>';
    });
}

function renderStatusBar() {
    var bar = document.getElementById("ifaceStatusBar");
    if (!bar) return;
    bar.innerHTML = _netInterfaces.map(function(iface) {
        var cls = iface.up ? "up" : "down";
        var lbl = iface.up ? "UP" : "DOWN";
        return '<span class="net-iface-badge ' + cls + '">' +
               '<span class="net-iface-badge-dot"></span>' +
               escHtml(iface.name) + ' ' + lbl +
               '</span>';
    }).join("");
}

function renderIfaceCards() {
    var container = document.getElementById("ifaceCards");
    if (_netInterfaces.length === 0) {
        container.innerHTML = '<div class="net-loading">Интерфейсы не найдены</div>';
        return;
    }

    container.innerHTML = _netInterfaces.map(function(iface) {
        var status    = iface.up ? "up" : "down";
        var statusLbl = iface.up ? "● Подключён" : "○ Отключён";

        var ipv4str = iface.ipv4.length
            ? iface.ipv4.map(function(a) { return a.ip + "/" + a.prefix; }).join(", ")
            : "—";

        var ipv6str = iface.ipv6.filter(function(a){ return a.scope !== "link"; }).map(function(a) {
            return a.ip + "/" + a.prefix;
        }).join(", ") || "—";

        var gw = iface.gateway || "—";

        return [
            '<div class="net-iface-card' + (iface.up ? '' : ' status-down') + '" id="card-' + iface.name + '">',
            '  <div class="net-iface-card-header">',
            '    <span class="net-iface-card-name">' + escHtml(iface.name) + '</span>',
            '    <span class="net-iface-card-status ' + status + '">' + statusLbl + '</span>',
            '  </div>',
            '  <div class="net-iface-card-body">',
            '    <div class="net-iface-field"><div class="net-iface-field-label">IPv4</div><div class="net-iface-field-value">' + escHtml(ipv4str) + '</div></div>',
            '    <div class="net-iface-field"><div class="net-iface-field-label">Шлюз</div><div class="net-iface-field-value">' + escHtml(gw) + '</div></div>',
            '    <div class="net-iface-field"><div class="net-iface-field-label">IPv6</div><div class="net-iface-field-value net-mono">' + escHtml(ipv6str) + '</div></div>',
            '    <div class="net-iface-field"><div class="net-iface-field-label">MAC</div><div class="net-iface-field-value net-mono">' + escHtml(iface.mac || "—") + '</div></div>',
            '    <div class="net-iface-field"><div class="net-iface-field-label">MTU</div><div class="net-iface-field-value">' + escHtml(iface.mtu) + '</div></div>',
            '    <div class="net-iface-field"><div class="net-iface-field-label">Режим</div><div class="net-iface-field-value">' + escHtml(iface.config_mode || "—") + '</div></div>',
            '  </div>',
            '  <div class="net-iface-card-traffic" id="traffic-' + iface.name + '">',
            '    <div class="net-traffic-item"><span class="net-traffic-label rx">↓</span>',
            '      <span class="net-traffic-speed" id="rx-speed-' + iface.name + '">—</span>',
            '      <svg class="net-sparkline" id="rx-spark-' + iface.name + '" width="80" height="24" viewBox="0 0 80 24"></svg>',
            '    </div>',
            '    <div class="net-traffic-item"><span class="net-traffic-label tx">↑</span>',
            '      <span class="net-traffic-speed" id="tx-speed-' + iface.name + '">—</span>',
            '      <svg class="net-sparkline" id="tx-spark-' + iface.name + '" width="80" height="24" viewBox="0 0 80 24"></svg>',
            '    </div>',
            '  </div>',
            '  <div class="net-iface-card-footer">',
            '    <button class="btn btn-default btn-sm" data-iface="' + iface.name + '" id="btn-edit-' + iface.name + '">✏ Настроить</button>',
            iface.up
              ? '<button class="btn btn-default btn-sm" data-iface="' + iface.name + '" id="btn-ifdown-' + iface.name + '">⏹ Откл.</button>'
              : '<button class="btn btn-default btn-sm" data-iface="' + iface.name + '" id="btn-ifup-' + iface.name + '">▶ Вкл.</button>',
            '  </div>',
            '</div>'
        ].join("\n");
    }).join("\n");

    // Wire edit buttons
    _netInterfaces.forEach(function(iface) {
        var editBtn = document.getElementById("btn-edit-" + iface.name);
        if (editBtn) {
            editBtn.addEventListener("click", function() { openIfaceModal(iface.name); });
        }
        var downBtn = document.getElementById("btn-ifdown-" + iface.name);
        if (downBtn) {
            downBtn.addEventListener("click", function() { doIfdown(iface.name); });
        }
        var upBtn = document.getElementById("btn-ifup-" + iface.name);
        if (upBtn) {
            upBtn.addEventListener("click", function() { doIfup(iface.name); });
        }
    });
}

// ── Traffic sparklines ─────────────────────────────────────────────────────────

var _sparkData = {};  // {iface: {rx: [], tx: []}}  max 60 points

function startTrafficPoll() {
    if (_trafficTimer) return;
    _trafficTimer = setInterval(pollTraffic, 1000);
}

function pollTraffic() {
    cockpit.file("/proc/net/dev").read().then(function(content) {
        if (!content) return;
        var now = Date.now();
        var lines = content.split("\n");
        lines.forEach(function(line) {
            var m = line.match(/^\s*(\S+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
            if (!m) return;
            var iface = m[1];
            var rx = parseInt(m[2]);
            var tx = parseInt(m[3]);

            if (!_sparkData[iface]) _sparkData[iface] = {rx:[], tx:[]};

            if (_trafficPrev[iface]) {
                var dt = (now - _trafficPrev[iface].ts) / 1000;
                if (dt > 0) {
                    var rxRate = Math.max(0, (rx - _trafficPrev[iface].rx) / dt);
                    var txRate = Math.max(0, (tx - _trafficPrev[iface].tx) / dt);
                    _sparkData[iface].rx.push(rxRate);
                    _sparkData[iface].tx.push(txRate);
                    if (_sparkData[iface].rx.length > 60) _sparkData[iface].rx.shift();
                    if (_sparkData[iface].tx.length > 60) _sparkData[iface].tx.shift();
                    updateSparkline("rx", iface, rxRate);
                    updateSparkline("tx", iface, txRate);
                }
            }
            _trafficPrev[iface] = {rx: rx, tx: tx, ts: now};
        });
    });
}

function updateSparkline(dir, iface, rate) {
    var speedEl = document.getElementById(dir + "-speed-" + iface);
    var svgEl   = document.getElementById(dir + "-spark-" + iface);
    if (!speedEl || !svgEl) return;

    speedEl.textContent = fmtSpeed(rate);

    var data = (_sparkData[iface] || {})[dir] || [];
    if (data.length < 2) return;

    var W = 80, H = 24;
    var max = Math.max.apply(null, data) || 1;
    var step = W / (data.length - 1);
    var pts = data.map(function(v, i) {
        return (i * step).toFixed(1) + "," + (H - (v / max * (H - 2)) - 1).toFixed(1);
    }).join(" ");

    var color = dir === "rx" ? "#2563eb" : "#16a34a";
    svgEl.innerHTML =
        '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round"/>';
}

// ── Interface Modal ────────────────────────────────────────────────────────────

function openIfaceModal(ifaceName) {
    var iface = _netInterfaces.find(function(i){ return i.name === ifaceName; });
    if (!iface) return;

    document.getElementById("ifaceModalTitle").textContent = "Настройка интерфейса: " + ifaceName;
    document.getElementById("ifaceModalName").value = ifaceName;

    var mode = iface.config_mode || (iface.ipv4.length ? "static" : "dhcp");
    document.getElementById("ifaceModeDhcp").checked   = (mode === "dhcp");
    document.getElementById("ifaceModeStatic").checked = (mode === "static");
    toggleIfaceStaticFields(mode === "static");

    var ipv4 = iface.ipv4[0] || {};
    document.getElementById("ifaceIp").value      = ipv4.ip || "";
    document.getElementById("ifaceMask").value    = ipv4.prefix ? String(ipv4.prefix) : "24";
    document.getElementById("ifaceGateway").value = iface.gateway || "";
    document.getElementById("ifaceMtu").value     = iface.mtu || 1500;

    // IPv6
    var hasV6 = iface.ipv6.filter(function(a){ return a.scope !== "link"; }).length > 0;
    document.getElementById("ifaceIpv6Mode").value = hasV6 ? "auto" : "off";
    toggleIfaceIpv6Fields("off");

    document.getElementById("ifaceModalError").style.display = "none";
    document.getElementById("ifaceModal").style.display = "flex";
}

function toggleIfaceStaticFields(show) {
    document.getElementById("ifaceStaticFields").style.display = show ? "" : "none";
}

function toggleIfaceIpv6Fields(mode) {
    document.getElementById("ifaceIpv6Fields").style.display = (mode === "static") ? "" : "none";
}

function saveIfaceModal() {
    var name    = document.getElementById("ifaceModalName").value;
    var mode    = document.querySelector('input[name="ifaceMode"]:checked').value;
    var ip      = document.getElementById("ifaceIp").value.trim();
    var mask    = document.getElementById("ifaceMask").value.trim();
    var gw      = document.getElementById("ifaceGateway").value.trim();
    var mtu     = document.getElementById("ifaceMtu").value.trim();
    var ipv6Mode= document.getElementById("ifaceIpv6Mode").value;
    var ipv6Addr= document.getElementById("ifaceIpv6Addr").value.trim();
    var ipv6Pfx = document.getElementById("ifaceIpv6Prefix").value.trim();

    var errEl = document.getElementById("ifaceModalError");
    errEl.style.display = "none";

    if (mode === "static") {
        if (!ip) { showIfaceError("Введите IP-адрес"); return; }
        if (!validateIp(ip)) { showIfaceError("Некорректный IP-адрес"); return; }
    }

    var cfg = {
        mode:       mode,
        ip:         ip,
        prefix:     maskToPrefix(mask),
        gateway:    gw,
        mtu:        mtu,
        ipv6_mode:  ipv6Mode,
        ipv6_addr:  ipv6Addr,
        ipv6_prefix: ipv6Pfx
    };

    // Check if IP is changing — warn user
    var currentIface = _netInterfaces.find(function(i){ return i.name === name; });
    var currentIp = currentIface && currentIface.ipv4[0] ? currentIface.ipv4[0].ip : "";
    if (mode === "static" && ip && ip !== currentIp && currentIp) {
        _ifacePendingCfg = {name: name, cfg: cfg};
        document.getElementById("ifaceModal").style.display = "none";
        document.getElementById("ipChangeWarnModal").style.display = "flex";
        return;
    }

    doSaveIface(name, cfg);
}

function showIfaceError(msg) {
    var el = document.getElementById("ifaceModalError");
    el.textContent = msg;
    el.style.display = "";
}

function doSaveIface(name, cfg) {
    document.getElementById("ifaceModal").style.display = "none";
    netApi(["set-interface", name, JSON.stringify(cfg)]).then(function(data) {
        if (!data.ok) {
            alert("Ошибка: " + (data.error || "неизвестная ошибка"));
            loadInterfaces();
            return;
        }
        if (data.warn) {
            console.warn(data.warn);
        }
        if (data.pending) {
            startRollbackCountdown(name, data.seconds || REVERT_TIMEOUT_SECS);
            // Show safety modal for critical changes
            var oldIface = _netInterfaces.find(function(i){ return i.name === name; });
            if (oldIface) {
                var oldMode = oldIface.config_mode || "dhcp";
                var oldIp   = oldIface.ipv4[0] ? oldIface.ipv4[0].ip : "";
                var oldGw   = oldIface.gateway || "";
                var isCritical = (cfg.mode !== oldMode)
                              || (cfg.mode === "static" && cfg.ip && oldIp && cfg.ip !== oldIp)
                              || (cfg.gateway && cfg.gateway !== oldGw);
                if (isCritical) {
                    showNetSafetyModal(oldIface, cfg, data.seconds || REVERT_TIMEOUT_SECS);
                }
            }
        }
        loadInterfaces();
    }).catch(function(e) {
        alert("Ошибка: " + String(e));
    });
}

var REVERT_TIMEOUT_SECS = 90;

function startRollbackCountdown(iface, seconds) {
    if (_rollbackState && _rollbackState.timer) {
        clearInterval(_rollbackState.timer);
    }
    var count = parseInt(seconds) || REVERT_TIMEOUT_SECS;
    var bannerEl = document.getElementById("netRollbackBanner");
    document.getElementById("rollbackIfaceName").textContent = iface;
    document.getElementById("rollbackCountdown").textContent = count;
    bannerEl.style.display = "flex";

    _rollbackState = {
        iface: iface,
        timer: setInterval(function() {
            count--;
            var el = document.getElementById("rollbackCountdown");
            if (el) el.textContent = count;
            if (count <= 0) {
                clearInterval(_rollbackState.timer);
                _rollbackState = null;
                bannerEl.style.display = "none";
                loadInterfaces();  // show reverted config
            }
        }, 1000)
    };
}

function showNetSafetyModal(oldIface, newCfg, seconds) {
    var changes = [];
    var oldMode = oldIface.config_mode || "dhcp";
    var oldIp   = oldIface.ipv4[0] ? oldIface.ipv4[0].ip : "—";
    var oldGw   = oldIface.gateway || "—";

    if (oldMode !== newCfg.mode) {
        changes.push("Режим: <b>" + escHtml(oldMode) + "</b> → <b>" + escHtml(newCfg.mode) + "</b>");
    }
    if (newCfg.mode === "static" && newCfg.ip && newCfg.ip !== oldIp) {
        changes.push("IP: <b>" + escHtml(oldIp) + "</b> → <b>" + escHtml(newCfg.ip + "/" + (newCfg.prefix || 24)) + "</b>");
    }
    if (newCfg.gateway && newCfg.gateway !== oldGw) {
        changes.push("Шлюз: <b>" + escHtml(oldGw) + "</b> → <b>" + escHtml(newCfg.gateway) + "</b>");
    }

    var changesHtml = changes.length
        ? "<ul style='margin:4px 0 0 16px;padding:0'>" + changes.map(function(c){ return "<li>" + c + "</li>"; }).join("") + "</ul>"
        : "<p style='margin:0'>Настройки применены.</p>";

    document.getElementById("netSafetyChanges").innerHTML = changesHtml;
    document.getElementById("netSafetySeconds").textContent  = seconds;
    document.getElementById("netSafetySeconds2").textContent = seconds;
    document.getElementById("netSafetyModal").style.display  = "flex";
}

function doIfdown(name) {
    netApi(["ifdown", name]).then(function() { loadInterfaces(); });
}

function doIfup(name) {
    netApi(["ifup", name]).then(function() { loadInterfaces(); });
}

// ── VLAN Modal ─────────────────────────────────────────────────────────────────

function openVlanModal() {
    var sel = document.getElementById("vlanParent");
    sel.innerHTML = _netInterfaces
        .filter(function(i){ return !i.name.includes("."); })
        .map(function(i){
            return '<option value="' + escHtml(i.name) + '">' + escHtml(i.name) + '</option>';
        }).join("");
    document.getElementById("vlanId").value = "";
    document.getElementById("vlanIp").value = "";
    document.querySelectorAll('input[name="vlanMode"]')[0].checked = true;
    document.getElementById("vlanStaticFields").style.display = "none";
    document.getElementById("vlanModalError").style.display = "none";
    document.getElementById("vlanModal").style.display = "flex";
}

function saveVlanModal() {
    var parent = document.getElementById("vlanParent").value;
    var vid    = parseInt(document.getElementById("vlanId").value);
    var mode   = document.querySelector('input[name="vlanMode"]:checked').value;
    var ip     = document.getElementById("vlanIp").value.trim();

    if (!vid || vid < 1 || vid > 4094) {
        document.getElementById("vlanModalError").textContent = "VLAN ID: 1–4094";
        document.getElementById("vlanModalError").style.display = "";
        return;
    }

    var ifaceName = parent + "." + vid;
    var cfg = { mode: mode, ip: "", prefix: 24, gateway: "" };

    if (mode === "static") {
        var c = validateCidr(ip);
        if (!c.valid) {
            document.getElementById("vlanModalError").textContent = "Введите IP в формате 192.168.100.1/24";
            document.getElementById("vlanModalError").style.display = "";
            return;
        }
        cfg.ip = c.ip;
        cfg.prefix = c.prefix;
    }

    document.getElementById("vlanModal").style.display = "none";

    // Write vlan-raw-device line + new iface block
    netApi(["set-interface", ifaceName, JSON.stringify(cfg)]).then(function(data) {
        if (!data.ok) { alert("Ошибка: " + (data.error || "")); return; }
        loadInterfaces();
    });
}

// ── DNS tab ───────────────────────────────────────────────────────────────────

function loadDns() {
    netApi(["get-dns"]).then(function(data) {
        if (!data.ok) return;

        var servers = data.servers || [];
        var search  = data.search  || "";
        var manager = data.manager;

        // View
        var view = document.getElementById("dnsView");
        view.innerHTML =
            '<div class="net-dns-view">' +
            '<div class="net-dns-field"><div class="net-dns-field-label">Основной DNS</div>' +
            '<div class="net-dns-field-value">' + escHtml(servers[0] || "—") + '</div></div>' +
            '<div class="net-dns-field"><div class="net-dns-field-label">Вторичный DNS</div>' +
            '<div class="net-dns-field-value">' + escHtml(servers[1] || "—") + '</div></div>' +
            '<div class="net-dns-field"><div class="net-dns-field-label">Домен поиска</div>' +
            '<div class="net-dns-field-value">' + escHtml(search || "—") + '</div></div>' +
            '</div>';

        // Pre-fill form
        document.getElementById("dnsServer1").value = servers[0] || "";
        document.getElementById("dnsServer2").value = servers[1] || "";
        document.getElementById("dnsSearch").value  = search;

        // Manager warning
        var warnEl = document.getElementById("dnsResolvconfWarn");
        if (manager) {
            document.getElementById("resolvconfManager").textContent = manager;
            warnEl.style.display = "";
        } else {
            warnEl.style.display = "none";
        }
    });
}

function loadHosts() {
    netApi(["get-hosts"]).then(function(data) {
        if (!data.ok) return;
        _netHosts = data.hosts || [];
        renderHostsTable();
    });
}

function renderHostsTable() {
    var tbody = document.getElementById("hostsTbody");
    if (_netHosts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="net-muted" style="padding:16px 12px;text-align:center">Нет записей</td></tr>';
        return;
    }
    tbody.innerHTML = _netHosts.map(function(h, idx) {
        return '<tr>' +
            '<td class="net-mono">' + escHtml(h.ip) + '</td>' +
            '<td class="net-mono">' + escHtml(h.hostname) + '</td>' +
            '<td class="net-muted">' + escHtml((h.aliases||[]).join(" ") || "—") + '</td>' +
            '<td style="text-align:right;white-space:nowrap">' +
              '<button class="btn btn-default btn-sm" data-idx="' + idx + '" id="btn-host-edit-' + idx + '">✏</button> ' +
              '<button class="btn btn-danger btn-sm" data-idx="' + idx + '" id="btn-host-del-' + idx + '">🗑</button>' +
            '</td>' +
            '</tr>';
    }).join("");

    _netHosts.forEach(function(h, idx) {
        document.getElementById("btn-host-edit-" + idx).addEventListener("click", function() {
            openHostModal(idx);
        });
        document.getElementById("btn-host-del-" + idx).addEventListener("click", function() {
            openConfirm("Удалить запись " + h.hostname + "?", function() {
                _netHosts.splice(idx, 1);
                saveHosts();
            });
        });
    });
}

function openHostModal(idx) {
    _hostEditIdx = idx;
    var h = idx >= 0 ? _netHosts[idx] : null;
    document.getElementById("hostModalTitle").textContent = h ? "Изменить запись" : "Добавить запись";
    document.getElementById("hostIp").value      = h ? h.ip : "";
    document.getElementById("hostName").value    = h ? h.hostname : "";
    document.getElementById("hostAliases").value = h ? (h.aliases||[]).join(" ") : "";
    document.getElementById("hostModalError").style.display = "none";
    document.getElementById("hostModal").style.display = "flex";
}

function saveHostModal() {
    var ip      = document.getElementById("hostIp").value.trim();
    var name    = document.getElementById("hostName").value.trim();
    var aliases = document.getElementById("hostAliases").value.trim().split(/\s+/).filter(Boolean);

    var errEl = document.getElementById("hostModalError");
    errEl.style.display = "none";

    if (!ip || !validateIp(ip)) { errEl.textContent = "Некорректный IP"; errEl.style.display=""; return; }
    if (!name) { errEl.textContent = "Введите имя хоста"; errEl.style.display=""; return; }

    var entry = {ip: ip, hostname: name, aliases: aliases};

    if (_hostEditIdx >= 0) {
        _netHosts[_hostEditIdx] = entry;
    } else {
        _netHosts.push(entry);
    }

    document.getElementById("hostModal").style.display = "none";
    saveHosts();
}

function saveHosts() {
    netApi(["set-hosts", JSON.stringify(_netHosts)]).then(function(data) {
        if (!data.ok) alert("Ошибка сохранения: " + (data.error||""));
        else loadHosts();
    });
}

function saveDns() {
    var s1 = document.getElementById("dnsServer1").value.trim();
    var s2 = document.getElementById("dnsServer2").value.trim();
    var search = document.getElementById("dnsSearch").value.trim();
    var servers = [s1, s2].filter(Boolean).join(",");
    netApi(["set-dns", servers, search]).then(function(data) {
        if (!data.ok) alert("Ошибка: " + (data.error||""));
        else {
            document.getElementById("dnsForm").style.display = "none";
            document.getElementById("dnsView").style.display = "";
            loadDns();
        }
    });
}

function testDns() {
    var host = "google.com";
    var resultEl = document.getElementById("dnsTestResult");
    resultEl.style.display = "";
    resultEl.textContent = "Проверка...";

    var out = "";
    var proc = cockpit.spawn(["dig", "+short", "+time=3", host], { err: "message" });
    proc.stream(function(d) { out += d; });
    proc.done(function() {
        var ips = out.trim().split("\n").filter(Boolean);
        if (ips.length) {
            resultEl.innerHTML = '<span class="net-diag-ok">✅ ' + escHtml(host) + ' → ' + ips.map(escHtml).join(", ") + '</span>';
        } else {
            resultEl.innerHTML = '<span class="net-diag-err">❌ DNS не отвечает</span>';
        }
    });
    proc.fail(function() {
        resultEl.innerHTML = '<span class="net-diag-err">❌ dig недоступен или DNS не работает</span>';
    });
}

function detachResolvconf() {
    var out = "";
    cockpit.spawn(["sudo", "-n", "rm", "-f", "/etc/resolv.conf"], {err:"message"})
        .done(function() {
            var lines = [];
            var s1 = document.getElementById("dnsServer1").value.trim();
            var s2 = document.getElementById("dnsServer2").value.trim();
            if (s1) lines.push("nameserver " + s1);
            if (s2) lines.push("nameserver " + s2);
            saveDns();
        });
}

// ── Routes tab ────────────────────────────────────────────────────────────────

function loadRoutes() {
    netApi(["get-routes"]).then(function(data) {
        if (!data.ok) return;
        _netRoutes = data.routes || [];
        renderRoutesTable();
    });
}

function renderRoutesTable() {
    var tbody = document.getElementById("routesTbody");
    if (_netRoutes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="net-muted" style="padding:16px 12px;text-align:center">Нет маршрутов</td></tr>';
        return;
    }

    tbody.innerHTML = _netRoutes.map(function(r, idx) {
        var isDefault = r.dst === "default" || r.dst === "0.0.0.0/0";
        var permBadge = r.persistent ? '<span class="net-badge-perm">постоянный</span>' : '';
        var actions   = isDefault ? '' :
            '<button class="btn btn-danger btn-sm" id="btn-route-del-' + idx + '">🗑</button>';
        return '<tr' + (isDefault ? ' class="net-route-default"' : '') + '>' +
            '<td class="net-mono">' + escHtml(r.dst) + '</td>' +
            '<td class="net-mono">' + escHtml(r.gateway || "—") + '</td>' +
            '<td>' + escHtml(r.dev || "—") + '</td>' +
            '<td>' + escHtml(r.metric !== "" ? String(r.metric) : "—") + '</td>' +
            '<td>' + permBadge + '</td>' +
            '<td style="text-align:right">' + actions + '</td>' +
            '</tr>';
    }).join("");

    _netRoutes.forEach(function(r, idx) {
        var delBtn = document.getElementById("btn-route-del-" + idx);
        if (delBtn) {
            delBtn.addEventListener("click", function() {
                openConfirm("Удалить маршрут " + r.dst + "?", function() {
                    netApi(["del-route", r.dst, r.gateway || ""]).then(function(data) {
                        if (!data.ok) alert("Ошибка: " + (data.error||""));
                        else loadRoutes();
                    });
                });
            });
        }
    });
}

function openRouteModal() {
    var sel = document.getElementById("routeIface");
    sel.innerHTML = _netInterfaces.map(function(i){
        return '<option value="' + escHtml(i.name) + '">' + escHtml(i.name) + '</option>';
    }).join("");
    document.getElementById("routeNetwork").value = "";
    document.getElementById("routeGateway").value = "";
    document.getElementById("routeMetric").value  = "";
    document.getElementById("routePersist").checked = true;
    document.getElementById("routeModalError").style.display = "none";
    document.getElementById("routeModal").style.display = "flex";
}

function saveRouteModal() {
    var network = document.getElementById("routeNetwork").value.trim();
    var gateway = document.getElementById("routeGateway").value.trim();
    var iface   = document.getElementById("routeIface").value;
    var metric  = document.getElementById("routeMetric").value.trim();
    var persist = document.getElementById("routePersist").checked ? "1" : "0";

    var errEl = document.getElementById("routeModalError");
    errEl.style.display = "none";

    if (!network) { errEl.textContent = "Введите сеть назначения"; errEl.style.display=""; return; }
    if (!gateway) { errEl.textContent = "Введите шлюз"; errEl.style.display=""; return; }

    document.getElementById("routeModal").style.display = "none";
    netApi(["add-route", network, gateway, iface, metric, persist]).then(function(data) {
        if (!data.ok) alert("Ошибка: " + (data.error||""));
        else loadRoutes();
    });
}

// ── Diagnostics tab ───────────────────────────────────────────────────────────

function switchDiagTool(tool) {
    _diagTool = tool;
    document.querySelectorAll(".net-tool-btn").forEach(function(btn) {
        btn.classList.toggle("active", btn.dataset.tool === tool);
    });
    document.querySelectorAll(".net-diag-form").forEach(function(f) {
        f.style.display = "none";
    });
    var form = document.getElementById("diag-" + tool);
    if (form) form.style.display = "";
}

function appendDiag(html) {
    var el = document.getElementById("diagOutput");
    el.innerHTML += html;
    el.scrollTop = el.scrollHeight;
    document.getElementById("diagOutputHeader").style.display = "";
}

function clearDiag() {
    document.getElementById("diagOutput").innerHTML = "";
    document.getElementById("diagOutputHeader").style.display = "none";
}

function stopDiag() {
    if (_diagProc) {
        _diagProc.close();
        _diagProc = null;
    }
    document.getElementById("btnStopDiag").style.display  = "none";
    document.getElementById("btnStopTrace").style.display = "none";
}

function runPing() {
    var host  = document.getElementById("pingHost").value.trim();
    var count = document.getElementById("pingCount").value;
    if (!host) { alert("Введите хост"); return; }

    clearDiag();
    document.getElementById("diagOutputTitle").textContent = "ping " + host;
    document.getElementById("btnStopDiag").style.display = "";
    appendDiag('<span class="net-diag-hdr">PING ' + escHtml(host) + ' (' + count + ' пакетов)\n</span>');

    _diagProc = cockpit.spawn(
        ["/bin/ping", "-c", count, "-W", "2", host],
        { err: "message" }
    );
    _diagProc.stream(function(data) {
        var lines = data.split("\n");
        lines.forEach(function(line) {
            if (!line) return;
            var cls = line.includes("bytes from") ? "net-diag-ok"
                    : line.includes("Destination") || line.includes("unreachable") ? "net-diag-err"
                    : "";
            appendDiag('<span class="' + cls + '">' + escHtml(line) + '\n</span>');
        });
    });
    _diagProc.done(function() {
        appendDiag('\n<span class="net-diag-hdr">Завершено</span>\n');
        document.getElementById("btnStopDiag").style.display = "none";
        _diagProc = null;
    });
    _diagProc.fail(function(ex) {
        appendDiag('<span class="net-diag-err">Ошибка: ' + escHtml(String(ex)) + '\n</span>');
        document.getElementById("btnStopDiag").style.display = "none";
        _diagProc = null;
    });
}

function runTraceroute() {
    var host = document.getElementById("traceHost").value.trim();
    if (!host) { alert("Введите хост"); return; }

    clearDiag();
    document.getElementById("diagOutputTitle").textContent = "traceroute " + host;
    document.getElementById("btnStopTrace").style.display = "";
    appendDiag('<span class="net-diag-hdr">TRACEROUTE ' + escHtml(host) + '\n\n</span>');

    _diagProc = cockpit.spawn(
        ["/usr/bin/traceroute", "-n", "-w", "2", "-q", "1", host],
        { err: "message" }
    );
    _diagProc.stream(function(data) {
        var lines = data.split("\n");
        lines.forEach(function(line) {
            if (!line.trim()) return;
            var hopMatch = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)/);
            if (hopMatch) {
                var rtt = hopMatch[3].trim();
                var hopIp = hopMatch[2];
                var timeoutHop = hopIp === "*";
                appendDiag(
                    '<span class="net-diag-hop">' + hopMatch[1].padStart(3) + '  </span>' +
                    (timeoutHop
                        ? '<span class="net-diag-warn">' + escHtml(hopIp) + '</span>'
                        : '<span class="net-diag-ok">' + escHtml(hopIp) + '</span>') +
                    '  <span class="net-diag-hop">' + escHtml(rtt) + '</span>\n'
                );
            } else {
                appendDiag('<span class="net-diag-hop">' + escHtml(line) + '\n</span>');
            }
        });
    });
    _diagProc.done(function() {
        appendDiag('\n<span class="net-diag-hdr">Завершено</span>\n');
        document.getElementById("btnStopTrace").style.display = "none";
        _diagProc = null;
    });
    _diagProc.fail(function() {
        appendDiag('<span class="net-diag-err">Ошибка (traceroute не установлен?)\n</span>');
        document.getElementById("btnStopTrace").style.display = "none";
        _diagProc = null;
    });
}

function runDnsLookup() {
    var host   = document.getElementById("dnsLookupHost").value.trim();
    var type   = document.getElementById("dnsLookupType").value;
    var server = document.getElementById("dnsLookupServer").value.trim();
    if (!host) { alert("Введите хост"); return; }

    clearDiag();
    document.getElementById("diagOutputTitle").textContent = "dig " + type + " " + host;
    appendDiag('<span class="net-diag-hdr">DNS LOOKUP: ' + escHtml(host) + ' [' + type + ']\n\n</span>');

    var cmd = ["/usr/bin/dig", "+noall", "+answer", "+time=5", type, host];
    if (server) cmd.push("@" + server);

    var out = "";
    var proc = cockpit.spawn(cmd, { err: "message" });
    proc.stream(function(d) { out += d; });
    proc.done(function() {
        var lines = out.trim().split("\n");
        if (lines.length === 0 || (lines.length === 1 && !lines[0])) {
            appendDiag('<span class="net-diag-warn">Записей не найдено</span>\n');
        } else {
            lines.forEach(function(line) {
                appendDiag('<span class="net-diag-ok">' + escHtml(line) + '</span>\n');
            });
        }
    });
    proc.fail(function() {
        appendDiag('<span class="net-diag-err">Ошибка (dig не установлен?)\n</span>');
    });
}

function runPortCheck() {
    var host  = document.getElementById("portHost").value.trim();
    var port  = document.getElementById("portNum").value.trim();
    var proto = document.getElementById("portProto").value;
    if (!host || !port) { alert("Введите хост и порт"); return; }

    clearDiag();
    document.getElementById("diagOutputTitle").textContent = "Проверка порта " + host + ":" + port;
    appendDiag('<span class="net-diag-hdr">PORT CHECK ' + escHtml(host) + ':' + escHtml(port) + ' (' + proto.toUpperCase() + ')\n\n</span>');

    var cmd = proto === "udp"
        ? ["timeout", "3", "/bin/nc", "-zu", "-w", "3", host, port]
        : ["timeout", "3", "/bin/nc", "-z", "-w", "3", host, port];

    var out = "";
    var proc = cockpit.spawn(cmd, { err: "out" });
    proc.stream(function(d) { out += d; });
    proc.done(function() {
        appendDiag('<span class="net-diag-ok">✅ Порт ' + escHtml(port) + ' открыт</span>\n');
    });
    proc.fail(function(ex) {
        var msg = String(ex);
        if (msg.includes("124") || msg.includes("timeout")) {
            appendDiag('<span class="net-diag-warn">⏳ Timeout — порт ' + escHtml(port) + ' не отвечает</span>\n');
        } else {
            appendDiag('<span class="net-diag-err">❌ Порт ' + escHtml(port) + ' закрыт</span>\n');
        }
    });
}

function runWol() {
    var mac   = document.getElementById("wolMac").value.trim();
    var iface = document.getElementById("wolIface").value;
    if (!mac) { alert("Введите MAC-адрес"); return; }

    clearDiag();
    document.getElementById("diagOutputTitle").textContent = "Wake-on-LAN → " + mac;
    appendDiag('<span class="net-diag-hdr">WAKE-ON-LAN → ' + escHtml(mac) + '\n\n</span>');

    var cmd = iface
        ? ["sudo", "-n", "/usr/bin/etherwake", "-i", iface, mac]
        : ["sudo", "-n", "/usr/bin/etherwake", mac];

    var proc = cockpit.spawn(cmd, { err: "message" });
    proc.done(function() {
        appendDiag('<span class="net-diag-ok">✅ Магический пакет отправлен на ' + escHtml(mac) + '</span>\n');
        // Save to history
        if (!_wolHistory.includes(mac)) {
            _wolHistory.unshift(mac);
            if (_wolHistory.length > 5) _wolHistory.pop();
        }
    });
    proc.fail(function(ex) {
        appendDiag('<span class="net-diag-err">❌ Ошибка: ' + escHtml(String(ex)) + '\n</span>');
    });
}

function populateWolIfaceSelect() {
    var sel = document.getElementById("wolIface");
    if (!sel) return;
    sel.innerHTML = '<option value="">Авто (broadcast)</option>' +
        _netInterfaces.map(function(i) {
            return '<option value="' + escHtml(i.name) + '">' + escHtml(i.name) + '</option>';
        }).join("");
}

// ── Confirm modal ─────────────────────────────────────────────────────────────

function openConfirm(msg, cb) {
    _confirmCb = cb;
    document.getElementById("confirmMsg").textContent = msg;
    document.getElementById("confirmModal").style.display = "flex";
}

// ── Modals close / dismiss ────────────────────────────────────────────────────

function closeAllModals() {
    document.querySelectorAll(".modal-overlay").forEach(function(m) {
        m.style.display = "none";
    });
}

function wireModalDismiss() {
    document.querySelectorAll("[data-dismiss='modal']").forEach(function(btn) {
        btn.addEventListener("click", closeAllModals);
    });
    document.querySelectorAll(".modal-overlay").forEach(function(m) {
        m.addEventListener("click", function(e) {
            if (e.target === m) m.style.display = "none";
        });
    });
}

// ── Reconnect countdown ────────────────────────────────────────────────────────

function startReconnectCountdown(newIp, seconds) {
    document.getElementById("reconnectModal").style.display = "flex";
    document.getElementById("reconnectNewIp").textContent = newIp;
    var count = seconds || 5;
    document.getElementById("reconnectCountdown").textContent = count;

    var timer = setInterval(function() {
        count--;
        document.getElementById("reconnectCountdown").textContent = count;
        if (count <= 0) {
            clearInterval(timer);
            var proto = window.location.protocol;
            var port  = window.location.port ? ":" + window.location.port : "";
            window.location.replace(proto + "//" + newIp + port + window.location.pathname);
        }
    }, 1000);
}

// ══════════════════════════════════════════════════════════════════════════════
// CERTIFICATES TAB
// ══════════════════════════════════════════════════════════════════════════════

var CERTS_API = "/usr/share/cockpit/rusnas/scripts/certs-api.py";
var _certsData = [];
var _certDetailsCurrent = null;

function certsApi(args) {
    return new Promise(function(resolve, reject) {
        var out = "";
        var proc = cockpit.spawn(
            ["sudo", "-n", "python3", CERTS_API].concat(args),
            { err: "message", superuser: "try" }
        );
        proc.stream(function(d) { out += d; });
        proc.done(function() {
            var j = safeJson(out);
            if (j) resolve(j); else reject(new Error("Bad JSON: " + out.slice(0, 200)));
        });
        proc.fail(function(ex) {
            var j = safeJson(out);
            if (j) resolve(j); else reject(ex);
        });
    });
}

// ── Load certs ────────────────────────────────────────────────────────────────

function loadCerts() {
    document.getElementById("certsLoading").style.display = "";
    document.getElementById("certsTable").style.display   = "none";
    document.getElementById("certsEmpty").style.display   = "none";

    certsApi(["list-certs"]).then(function(data) {
        document.getElementById("certsLoading").style.display = "none";
        if (!data.ok) {
            document.getElementById("certsEmpty").style.display = "";
            document.getElementById("certsEmpty").querySelector(".net-certs-empty-sub").textContent =
                "Ошибка: " + (data.error || "");
            return;
        }
        _certsData = data.certs || [];
        renderCertsTable();
        updateCertExpBadge();
    }).catch(function(e) {
        document.getElementById("certsLoading").style.display = "none";
        document.getElementById("certsEmpty").style.display = "";
        document.getElementById("certsEmpty").querySelector(".net-certs-empty-sub").textContent =
            "Ошибка загрузки: " + escHtml(String(e));
    });

    loadCertDaemonStatus();
    checkCertbot();
}

function checkCertbot() {
    certsApi(["check-certbot"]).then(function(data) {
        var alertEl = document.getElementById("certsNoCertbot");
        if (data.installed) {
            alertEl.style.display = "none";
        } else {
            alertEl.style.display = "";
        }
    });
}

function renderCertsTable() {
    var tbody = document.getElementById("certsTbody");

    if (_certsData.length === 0) {
        document.getElementById("certsEmpty").style.display = "";
        return;
    }

    document.getElementById("certsTable").style.display = "";

    tbody.innerHTML = _certsData.map(function(c, idx) {
        var status    = c.status || "unknown";
        var daysLeft  = c.days_left != null ? c.days_left : "?";
        var expDate   = c.not_after_iso || "—";
        var typeLabel = {
            letsencrypt: '<span class="net-cert-type net-cert-le">Let\'s Encrypt</span>',
            selfsigned:  '<span class="net-cert-type net-cert-ss">Самоподписанный</span>',
            custom:      '<span class="net-cert-type net-cert-custom">Внешний</span>',
        }[c.type] || '<span class="net-cert-type net-cert-custom">Внешний</span>';

        var statusBadge = {
            valid:    '<span class="net-cert-status net-cert-valid">Действует</span>',
            expiring: '<span class="net-cert-status net-cert-expiring">Истекает</span>',
            expired:  '<span class="net-cert-status net-cert-expired">Истёк</span>',
            unknown:  '<span class="net-cert-status">Неизвестно</span>',
        }[status] || '<span class="net-cert-status">—</span>';

        var daysClass = daysLeft < 0 ? "net-cert-days-expired"
            : daysLeft < 14  ? "net-cert-days-critical"
            : daysLeft < 30  ? "net-cert-days-warn"
            : "net-cert-days-ok";
        var daysStr = daysLeft < 0 ? "Истёк" : daysLeft + " дн.";

        var renewBtn = (c.renewable || c.source === "letsencrypt")
            ? '<button class="btn btn-default btn-sm" data-idx="' + idx + '" id="cert-renew-' + idx + '">🔄</button> '
            : '';

        return '<tr>' +
            '<td><strong class="net-mono">' + escHtml(c.cn || c.name) + '</strong>' +
            (c.sans && c.sans.length > 0
                ? '<br><small class="net-muted">' + c.sans.slice(0,3).map(escHtml).join(", ") + '</small>'
                : '') +
            '</td>' +
            '<td>' + typeLabel + '</td>' +
            '<td class="net-muted">' + escHtml(c.issuer || "—") + '</td>' +
            '<td>' + escHtml(expDate) + '</td>' +
            '<td><span class="' + daysClass + '">' + daysStr + '</span></td>' +
            '<td>' + statusBadge + '</td>' +
            '<td style="text-align:right;white-space:nowrap">' +
              renewBtn +
              '<button class="btn btn-default btn-sm" data-idx="' + idx + '" id="cert-detail-' + idx + '">ℹ</button> ' +
              '<button class="btn btn-danger btn-sm" data-idx="' + idx + '" id="cert-del-' + idx + '">🗑</button>' +
            '</td>' +
            '</tr>';
    }).join("");

    // Wire buttons
    _certsData.forEach(function(c, idx) {
        var detBtn = document.getElementById("cert-detail-" + idx);
        if (detBtn) detBtn.addEventListener("click", function() { openCertDetails(idx); });

        var delBtn = document.getElementById("cert-del-" + idx);
        if (delBtn) delBtn.addEventListener("click", function() {
            openConfirm("Удалить сертификат " + (c.cn || c.name) + "?", function() {
                certsApi(["delete-cert", c.name, c.source || "custom"]).then(function() {
                    loadCerts();
                });
            });
        });

        var renBtn = document.getElementById("cert-renew-" + idx);
        if (renBtn) renBtn.addEventListener("click", function() { renewCert(c.name); });
    });
}

function updateCertExpBadge() {
    var badge = document.getElementById("certExpBadge");
    var expiring = _certsData.filter(function(c) {
        return c.status === "expiring" || c.status === "expired";
    });
    if (expiring.length > 0) {
        badge.textContent = expiring.length;
        badge.style.display = "";
    } else {
        badge.style.display = "none";
    }
}

// ── Cert details modal ────────────────────────────────────────────────────────

function openCertDetails(idx) {
    var c = _certsData[idx];
    if (!c) return;
    _certDetailsCurrent = c;

    document.getElementById("certDetailsTitle").textContent =
        "Сертификат: " + (c.cn || c.name);

    var rows = [
        ["Домен (CN)",    c.cn || "—"],
        ["Тип",           c.type === "letsencrypt" ? "Let's Encrypt"
                        : c.type === "selfsigned" ? "Самоподписанный" : "Внешний"],
        ["Издатель",      c.issuer || "—"],
        ["Subject",       c.subject || "—"],
        ["Действует с",   c.not_before || "—"],
        ["Действует до",  c.not_after_iso || "—"],
        ["Осталось",      c.days_left != null ? c.days_left + " дней" : "—"],
        ["SAN",           (c.sans || []).join(", ") || "—"],
        ["Путь к cert",   c.cert_path || "—"],
        ["Путь к key",    c.key_path  || "—"],
    ];

    document.getElementById("certDetailsBody").innerHTML =
        '<table class="table net-table" style="margin:0">' +
        rows.map(function(r) {
            return '<tr><td style="font-weight:600;width:140px">' + escHtml(r[0]) + '</td>' +
                   '<td class="net-mono">' + escHtml(String(r[1])) + '</td></tr>';
        }).join("") +
        '</table>';

    var renewBtn = document.getElementById("btnCertRenew");
    renewBtn.style.display = c.renewable ? "" : "none";

    document.getElementById("certDetailsModal").style.display = "flex";
}

function renewCert(name) {
    document.getElementById("certDetailsModal").style.display = "none";
    var loadingMsg = '<div class="net-loading"><div class="net-spinner"></div> Обновление сертификата ' + escHtml(name) + '...</div>';
    document.getElementById("certsLoading").innerHTML = loadingMsg;
    document.getElementById("certsLoading").style.display = "";
    document.getElementById("certsTable").style.display = "none";

    certsApi(["renew-cert", name]).then(function(data) {
        loadCerts();
        if (!data.ok) {
            alert("Ошибка обновления:\n" + (data.output || data.error || ""));
        }
    });
}

// ── Let's Encrypt modal ───────────────────────────────────────────────────────

function openLeModal() {
    document.getElementById("leDomain").value  = "";
    document.getElementById("leEmail").value   = "";
    document.getElementById("leMethod").value  = "webroot";
    document.getElementById("leWebroot").value = "/var/www/rusnas-landing";
    document.getElementById("leAgree").checked = false;
    document.getElementById("leProgress").style.display = "none";
    document.getElementById("leOutput").textContent = "";
    document.getElementById("leError").style.display = "none";
    document.getElementById("leCancelBtn").style.display = "";
    document.getElementById("btnIssueLe").style.display = "";
    document.getElementById("leModal").style.display = "flex";
}

function issueLetEncrypt() {
    var domain  = document.getElementById("leDomain").value.trim();
    var email   = document.getElementById("leEmail").value.trim();
    var method  = document.getElementById("leMethod").value;
    var webroot = document.getElementById("leWebroot").value.trim();
    var agreed  = document.getElementById("leAgree").checked;

    var errEl = document.getElementById("leError");
    errEl.style.display = "none";

    if (!domain) { errEl.textContent = "Введите доменное имя"; errEl.style.display = ""; return; }
    if (!email)  { errEl.textContent = "Введите email"; errEl.style.display = ""; return; }
    if (!agreed) { errEl.textContent = "Необходимо принять условия использования"; errEl.style.display = ""; return; }

    document.getElementById("leProgress").style.display = "";
    document.getElementById("btnIssueLe").style.display = "none";
    document.getElementById("leCancelBtn").style.display = "none";

    var outputEl = document.getElementById("leOutput");
    outputEl.textContent = "$ certbot certonly...\n";

    certsApi(["issue-letsencrypt", domain, email, method, webroot]).then(function(data) {
        outputEl.textContent += (data.output || "");
        if (data.ok) {
            outputEl.textContent += "\n✅ Сертификат получен!";
            setTimeout(function() {
                document.getElementById("leModal").style.display = "none";
                loadCerts();
            }, 2000);
        } else {
            errEl.textContent = data.error || "Ошибка certbot";
            errEl.style.display = "";
            document.getElementById("leCancelBtn").style.display = "";
        }
    }).catch(function(e) {
        errEl.textContent = String(e);
        errEl.style.display = "";
        document.getElementById("leCancelBtn").style.display = "";
    });
}

// ── Self-signed modal ─────────────────────────────────────────────────────────

function openSelfSignedModal() {
    document.getElementById("ssCommonName").value = "";
    document.getElementById("ssOrg").value = "rusNAS";
    document.getElementById("ssSan").value = "";
    document.getElementById("ssDays").value = "730";
    document.getElementById("ssKeySize").value = "4096";
    document.getElementById("ssError").style.display = "none";
    document.getElementById("selfSignedModal").style.display = "flex";
}

function createSelfSigned() {
    var cn      = document.getElementById("ssCommonName").value.trim();
    var org     = document.getElementById("ssOrg").value.trim() || "rusNAS";
    var san     = document.getElementById("ssSan").value.trim();
    var days    = document.getElementById("ssDays").value;
    var keySize = document.getElementById("ssKeySize").value;

    var errEl = document.getElementById("ssError");
    errEl.style.display = "none";

    if (!cn) { errEl.textContent = "Введите доменное имя"; errEl.style.display = ""; return; }

    // Name = CN sanitized
    var name = cn.replace(/[^a-zA-Z0-9._-]/g, "_");

    document.getElementById("selfSignedModal").style.display = "none";

    certsApi(["create-selfsigned", name, cn, org, san, days, keySize]).then(function(data) {
        if (!data.ok) {
            alert("Ошибка создания сертификата:\n" + (data.error || ""));
        }
        loadCerts();
    });
}

// ── Import cert modal ─────────────────────────────────────────────────────────

function openImportModal() {
    document.getElementById("importName").value     = "";
    document.getElementById("importCertPem").value  = "";
    document.getElementById("importKeyPem").value   = "";
    document.getElementById("importChainPem").value = "";
    document.getElementById("importCertError").style.display = "none";
    document.getElementById("importCertModal").style.display = "flex";
}

function saveImportCert() {
    var name    = document.getElementById("importName").value.trim();
    var certPem = document.getElementById("importCertPem").value.trim();
    var keyPem  = document.getElementById("importKeyPem").value.trim();
    var chainPem= document.getElementById("importChainPem").value.trim();

    var errEl = document.getElementById("importCertError");
    errEl.style.display = "none";

    if (!name)    { errEl.textContent = "Введите имя"; errEl.style.display = ""; return; }
    if (!certPem) { errEl.textContent = "Вставьте сертификат PEM"; errEl.style.display = ""; return; }
    if (!keyPem)  { errEl.textContent = "Вставьте приватный ключ PEM"; errEl.style.display = ""; return; }

    var certB64  = btoa(unescape(encodeURIComponent(certPem)));
    var keyB64   = btoa(unescape(encodeURIComponent(keyPem)));
    var chainB64 = chainPem ? btoa(unescape(encodeURIComponent(chainPem))) : "";

    document.getElementById("importCertModal").style.display = "none";

    certsApi(["import-cert", name, certB64, keyB64, chainB64]).then(function(data) {
        if (!data.ok) {
            alert("Ошибка импорта:\n" + (data.error || ""));
        }
        loadCerts();
    });
}

// ── Daemon status ─────────────────────────────────────────────────────────────

function loadCertDaemonStatus() {
    certsApi(["daemon-status"]).then(function(data) {
        if (!data.ok) return;
        var statusEl = document.getElementById("certDaemonStatus");
        var toggleBtn = document.getElementById("btnToggleCertDaemon");

        if (data.active) {
            statusEl.innerHTML = '<span class="net-iface-badge up"><span class="net-iface-badge-dot"></span>Активен</span>';
            toggleBtn.textContent = "Выключить";
            toggleBtn.className = "btn btn-default btn-sm";
        } else {
            statusEl.innerHTML = '<span class="net-iface-badge down"><span class="net-iface-badge-dot"></span>Остановлен</span>';
            toggleBtn.textContent = "Включить";
            toggleBtn.className = "btn btn-primary btn-sm";
        }

        document.getElementById("certDaemonLastCheck").textContent =
            data.last_run ? data.last_run : "Никогда";
        document.getElementById("certDaemonNextCheck").textContent =
            data.next_run ? data.next_run : "—";
    });
}

function toggleCertDaemon() {
    var btn = document.getElementById("btnToggleCertDaemon");
    var enabling = btn.textContent.trim() === "Включить";
    certsApi([enabling ? "daemon-enable" : "daemon-disable"]).then(function() {
        setTimeout(loadCertDaemonStatus, 500);
    });
}

function showCertLog() {
    var wrap = document.getElementById("certLogWrap");
    wrap.style.display = "";
    document.getElementById("certLogOutput").textContent = "Загрузка...";

    certsApi(["get-log"]).then(function(data) {
        document.getElementById("certLogOutput").textContent = data.log || "Лог пустой";
    });
}

// ── LE method hint ────────────────────────────────────────────────────────────

function updateLeMethodHint() {
    var method = document.getElementById("leMethod").value;
    var hints = {
        webroot:    "Использует существующий Apache, путь /var/www/rusnas-landing. Рекомендуется.",
        standalone: "certbot временно запустит собственный HTTP-сервер. Apache должен быть остановлен или порт 80 свободен.",
    };
    document.getElementById("leMethodHint").textContent = hints[method] || "";
    document.getElementById("leWebrootGroup").style.display = (method === "webroot") ? "" : "none";
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {

    wireModalDismiss();

    // Tab switching
    document.querySelectorAll("#netTabs .advisor-tab-btn[data-tab]").forEach(function(btn) {
        btn.addEventListener("click", function() {
            switchTab(btn.dataset.tab);
        });
    });

    // Interface tab buttons
    document.getElementById("btnAddVlan").addEventListener("click", openVlanModal);
    document.getElementById("btnAddBond").addEventListener("click", function() {
        alert("Bond (агрегация каналов) — будет реализован в следующей версии");
    });

    // DNS tab
    document.getElementById("btnEditDns").addEventListener("click", function() {
        document.getElementById("dnsView").style.display = "none";
        document.getElementById("dnsForm").style.display = "";
    });
    document.getElementById("btnSaveDns").addEventListener("click", saveDns);
    document.getElementById("btnCancelDns").addEventListener("click", function() {
        document.getElementById("dnsForm").style.display = "none";
        document.getElementById("dnsView").style.display = "";
    });
    document.getElementById("btnTestDns").addEventListener("click", testDns);
    document.getElementById("btnDetachResolvconf").addEventListener("click", detachResolvconf);

    // Hosts
    document.getElementById("btnAddHost").addEventListener("click", function() {
        openHostModal(-1);
    });
    document.getElementById("btnSaveHost").addEventListener("click", saveHostModal);

    // Routes
    document.getElementById("btnAddRoute").addEventListener("click", openRouteModal);
    document.getElementById("btnSaveRoute").addEventListener("click", saveRouteModal);

    // Iface modal
    document.getElementById("btnSaveIface").addEventListener("click", saveIfaceModal);
    document.querySelectorAll("input[name='ifaceMode']").forEach(function(radio) {
        radio.addEventListener("change", function() {
            toggleIfaceStaticFields(radio.value === "static");
        });
    });
    document.getElementById("ifaceIpv6Mode").addEventListener("change", function() {
        toggleIfaceIpv6Fields(this.value);
    });

    // IP change warn modal
    document.getElementById("btnIpWarnCancel").addEventListener("click", function() {
        document.getElementById("ipChangeWarnModal").style.display = "none";
        _ifacePendingCfg = null;
        document.getElementById("ifaceModal").style.display = "flex";
    });
    document.getElementById("btnIpWarnConfirm").addEventListener("click", function() {
        document.getElementById("ipChangeWarnModal").style.display = "none";
        if (_ifacePendingCfg) {
            var newIp = _ifacePendingCfg.cfg.ip;
            doSaveIface(_ifacePendingCfg.name, _ifacePendingCfg.cfg);
            if (newIp) {
                setTimeout(function() { startReconnectCountdown(newIp, 5); }, 500);
            }
            _ifacePendingCfg = null;
        }
    });

    // Rollback banner buttons
    document.getElementById("btnConfirmNetChange").addEventListener("click", function() {
        if (!_rollbackState) return;
        var iface = _rollbackState.iface;
        netApi(["confirm-change", iface]).then(function() {
            if (_rollbackState) clearInterval(_rollbackState.timer);
            _rollbackState = null;
            document.getElementById("netRollbackBanner").style.display = "none";
        }).catch(function() {});
    });

    document.getElementById("btnRevertNetChange").addEventListener("click", function() {
        if (!_rollbackState) return;
        clearInterval(_rollbackState.timer);
        var iface = _rollbackState.iface;
        _rollbackState = null;
        document.getElementById("netRollbackBanner").style.display = "none";
        netApi(["revert-change", iface]).then(function(r) {
            if (r && !r.ok) alert("Ошибка отката: " + (r.error || ""));
            loadInterfaces();
        }).catch(function() { loadInterfaces(); });
    });

    // Safety modal — close button
    document.getElementById("btnNetSafetyOk").addEventListener("click", function() {
        document.getElementById("netSafetyModal").style.display = "none";
    });

    // Confirm modal
    document.getElementById("btnConfirmOk").addEventListener("click", function() {
        document.getElementById("confirmModal").style.display = "none";
        if (_confirmCb) { _confirmCb(); _confirmCb = null; }
    });

    // VLAN modal
    document.getElementById("btnSaveVlan").addEventListener("click", saveVlanModal);
    document.querySelectorAll("input[name='vlanMode']").forEach(function(r) {
        r.addEventListener("change", function() {
            document.getElementById("vlanStaticFields").style.display = (r.value === "static") ? "" : "none";
        });
    });

    // Diagnostics
    document.querySelectorAll(".net-tool-btn").forEach(function(btn) {
        btn.addEventListener("click", function() { switchDiagTool(btn.dataset.tool); });
    });
    document.getElementById("btnRunPing").addEventListener("click", runPing);
    document.getElementById("btnStopDiag").addEventListener("click", stopDiag);
    document.getElementById("btnRunTrace").addEventListener("click", runTraceroute);
    document.getElementById("btnStopTrace").addEventListener("click", stopDiag);
    document.getElementById("btnRunDnsLookup").addEventListener("click", runDnsLookup);
    document.getElementById("btnRunPortCheck").addEventListener("click", runPortCheck);
    document.getElementById("btnRunWol").addEventListener("click", runWol);
    document.getElementById("btnClearDiag").addEventListener("click", clearDiag);

    // Certificates tab
    document.getElementById("btnRefreshCerts").addEventListener("click", loadCerts);
    document.getElementById("btnGetLetsEncrypt").addEventListener("click", openLeModal);
    document.getElementById("btnNewSelfSigned").addEventListener("click", openSelfSignedModal);
    document.getElementById("btnImportCert").addEventListener("click", openImportModal);
    document.getElementById("btnInstallCertbot").addEventListener("click", function() {
        this.disabled = true;
        this.textContent = "Устанавливается...";
        var self = this;
        certsApi(["install-certbot"]).then(function(data) {
            self.disabled = false;
            if (data.ok) {
                self.closest(".net-alert").style.display = "none";
            } else {
                self.textContent = "Ошибка — попробуйте вручную";
            }
        });
    });

    // LE modal
    document.getElementById("btnIssueLe").addEventListener("click", issueLetEncrypt);
    document.getElementById("leMethod").addEventListener("change", updateLeMethodHint);
    updateLeMethodHint();

    // Self-signed modal
    document.getElementById("btnCreateSelfSigned").addEventListener("click", createSelfSigned);

    // Import modal
    document.getElementById("btnSaveImportCert").addEventListener("click", saveImportCert);

    // Cert details modal
    document.getElementById("btnCertRenew").addEventListener("click", function() {
        if (_certDetailsCurrent) renewCert(_certDetailsCurrent.name);
    });

    // Daemon
    document.getElementById("btnToggleCertDaemon").addEventListener("click", toggleCertDaemon);
    document.getElementById("btnCertLog").addEventListener("click", showCertLog);
    document.getElementById("btnCloseCertLog").addEventListener("click", function() {
        document.getElementById("certLogWrap").style.display = "none";
    });

    // Initial load
    loadInterfaces();
    startTrafficPoll();

    // DNS and hosts load lazily via tab switch handler
    // but load immediately so if user starts on Interfaces tab these are ready too
    loadDns();
    loadHosts();
    loadRoutes();
});

// ══════════════════════════════════════════════════════════════════════════════
// DOMAIN SERVICES TAB
// ══════════════════════════════════════════════════════════════════════════════

var DOMAIN_API = "/usr/share/cockpit/rusnas/scripts/domain-api.py";
var _domainMode = null;   // null | "member" | "dc" | "none"
var _domainState = { joined: false, domain: "", workgroup: "", dc: "", method: "winbind" };
var _dcState = { provisioned: false, domain: "", realm: "", fsmo: {} };
var _domainTabLoaded = false;
var _dcGroupCurrent = "";

function domainApi(args) {
    return new Promise(function(resolve, reject) {
        var out = "";
        var proc = cockpit.spawn(
            ["sudo", "-n", "python3", DOMAIN_API].concat(args),
            { err: "message", superuser: "try" }
        );
        proc.stream(function(d) { out += d; });
        proc.done(function() {
            var j = safeJson(out);
            if (j) resolve(j); else reject(new Error("Bad JSON: " + out.slice(0,300)));
        });
        proc.fail(function(err, msg) {
            var j = safeJson(out);
            if (j) resolve(j); else reject(new Error(msg || "domain-api error"));
        });
    });
}

// ── Mode selector ──────────────────────────────────────────────────────────

function loadDomain() {
    document.getElementById("domainLoading").style.display = "";
    document.getElementById("domainMemberPanel").style.display = "none";
    document.getElementById("domainDcPanel").style.display = "none";

    domainApi(["detect-mode"]).then(function(r) {
        document.getElementById("domainLoading").style.display = "none";
        if (!r.ok) { showDomainError(r.error || "Ошибка определения режима"); return; }
        _domainMode = r.mode;
        updateDomainModeSelector(r.mode);
        if (r.mode === "member" || r.mode === "none") {
            showMemberPanel();
        } else if (r.mode === "dc") {
            showDcPanel();
        }
    }).catch(function(e) {
        document.getElementById("domainLoading").style.display = "none";
        // Default to member mode on error
        _domainMode = "none";
        updateDomainModeSelector("none");
        showMemberPanel();
    });
}

function updateDomainModeSelector(mode) {
    var isDc = (mode === "dc");
    document.getElementById("domainModeCardMember").classList.toggle("active", !isDc);
    document.getElementById("domainModeCardDc").classList.toggle("active", isDc);
    document.querySelector('#domainModeCardMember input[type=radio]').checked = !isDc;
    document.querySelector('#domainModeCardDc input[type=radio]').checked = isDc;
}

function showMemberPanel() {
    document.getElementById("domainMemberPanel").style.display = "";
    document.getElementById("domainDcPanel").style.display = "none";
    loadMemberOverview();
}

function showDcPanel() {
    document.getElementById("domainMemberPanel").style.display = "none";
    document.getElementById("domainDcPanel").style.display = "";
    loadDcOverview();
}

function showDomainError(msg) {
    document.getElementById("domainLoading").innerHTML =
        '<div class="net-alert net-alert-danger">' + escHtml(msg) + '</div>';
}

// ── Mode selector click handlers ───────────────────────────────────────────

function initDomainModeSelector() {
    document.getElementById("domainModeCardMember").addEventListener("click", function() {
        if (_domainMode === "dc") {
            if (!confirm("Переключение в режим «Участник домена» потребует остановки Samba AD DC. Продолжить?")) return;
        }
        _domainMode = "none";
        updateDomainModeSelector("none");
        showMemberPanel();
    });
    document.getElementById("domainModeCardDc").addEventListener("click", function() {
        _domainMode = "dc";
        updateDomainModeSelector("dc");
        showDcPanel();
    });
}

// ── Sub-tabs ───────────────────────────────────────────────────────────────

function initSubtabs(containerSelector, contentPrefix) {
    var container = document.querySelector(containerSelector);
    if (!container) return;
    container.querySelectorAll(".domain-subtab-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            container.querySelectorAll(".domain-subtab-btn").forEach(function(b) { b.classList.remove("active"); });
            btn.classList.add("active");
            var tab = btn.dataset.subtab;
            document.querySelectorAll(".domain-subtab-content").forEach(function(el) {
                el.style.display = (el.id === "subtab-" + tab) ? "" : "none";
            });
            onDomainSubtabSwitch(tab);
        });
    });
}

function onDomainSubtabSwitch(tab) {
    if (tab === "member-overview") loadMemberOverview();
    else if (tab === "member-join") loadMemberJoin();
    else if (tab === "member-users") { loadDomainUsers(); loadDomainGroups(); loadPermittedGroups(); }
    else if (tab === "member-samba") loadSmbGlobal();
    else if (tab === "dc-overview") loadDcOverview();
    else if (tab === "dc-users") loadDcUsers();
    else if (tab === "dc-groups") loadDcGroups();
    else if (tab === "dc-repl") loadDcRepl();
    else if (tab === "dc-dns") loadDcDnsZones();
    else if (tab === "dc-gpo") loadDcGpo();
    else if (tab === "dc-provision") { /* just show form */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// MEMBER MODE
// ══════════════════════════════════════════════════════════════════════════════

function loadMemberOverview() {
    var el = document.getElementById("memberOverviewContent");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div> Загрузка...</div>';
    domainApi(["status"]).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(r.error) + '</div>'; return; }
        _domainState = r;
        renderMemberOverview(r, el);
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

function renderMemberOverview(r, el) {
    var joined = r.joined;
    var joinedHtml = joined
        ? '<span style="color:#16a34a;font-weight:700">● Подключён к домену</span>'
        : '<span style="color:#dc2626;font-weight:700">○ Не подключён к домену</span>';

    var svcs = r.services || {};
    function svcBadge(name, key) {
        var st = svcs[key] || "unknown";
        return '<span class="domain-svc-badge ' + (st === "active" ? "active" : "inactive") + '">'
            + '<span class="domain-svc-dot"></span>' + escHtml(name) + ' ' + escHtml(st) + '</span>';
    }

    var html = '<div class="domain-status-card">'
        + '<div class="domain-status-header">'
        + '<div class="domain-status-icon">🏢</div>'
        + '<div><div class="domain-status-title">' + joinedHtml + '</div>'
        + '<div class="domain-status-subtitle">Active Directory — Участник домена</div></div>'
        + '</div>';

    if (joined) {
        html += '<div class="domain-info-grid">'
            + infoItem("Домен", r.domain || "—")
            + infoItem("Рабочая группа", r.workgroup || "—")
            + infoItem("DC адрес", r.dc || "—")
            + infoItem("Метод", r.method || "winbind")
            + infoItem("Realm", r.realm || "—")
            + infoItem("Kerberos TGT", r.kerberos_tgt ? "✓ Активен" : "✗ Нет")
            + '</div>';
    }

    html += '<div class="domain-services-row">'
        + svcBadge("winbind", "winbind")
        + svcBadge("smbd", "smbd")
        + '<button class="btn btn-default btn-sm" id="btnRestartWinbind">↻ Перезапустить winbind</button>'
        + '<button class="btn btn-default btn-sm" id="btnKerberosRenew">🔑 Обновить Kerberos TGT</button>'
        + '<button class="btn btn-default btn-sm" id="btnRefreshMemberOverview">↻ Обновить</button>';

    if (!joined) {
        html += '<button class="btn btn-primary btn-sm" id="btnGoJoin">→ Подключиться к домену</button>';
    }

    html += '</div></div>';
    el.innerHTML = html;

    document.getElementById("btnRestartWinbind").addEventListener("click", function() {
        this.disabled = true; this.textContent = "...";
        var btn = this;
        domainApi(["restart-winbind"]).then(function(r) {
            btn.disabled = false; btn.textContent = "↻ Перезапустить winbind";
            loadMemberOverview();
        }).catch(function(e) { btn.disabled = false; btn.textContent = "↻ Перезапустить winbind"; });
    });

    document.getElementById("btnKerberosRenew").addEventListener("click", function() {
        this.disabled = true;
        var btn = this;
        domainApi(["kerberos-renew"]).then(function(r) {
            btn.disabled = false;
            if (r.ok) alert("Kerberos TGT обновлён успешно");
            else alert("Ошибка: " + r.error);
        }).catch(function(e) { btn.disabled = false; alert(e.message); });
    });

    document.getElementById("btnRefreshMemberOverview").addEventListener("click", loadMemberOverview);

    if (!joined && document.getElementById("btnGoJoin")) {
        document.getElementById("btnGoJoin").addEventListener("click", function() {
            document.querySelector('[data-subtab="member-join"]').click();
        });
    }
}

function infoItem(label, value) {
    return '<div class="domain-info-item">'
        + '<div class="domain-info-label">' + escHtml(label) + '</div>'
        + '<div class="domain-info-value">' + escHtml(value) + '</div>'
        + '</div>';
}

// ── Join / Leave ───────────────────────────────────────────────────────────

function loadMemberJoin() {
    var el = document.getElementById("memberJoinContent");
    if (_domainState.joined) {
        renderLeaveForm(el);
    } else {
        renderJoinForm(el);
    }
}

function renderJoinForm(el) {
    el.innerHTML = '<div class="domain-join-section">'
        + '<div class="domain-join-title">🔗 Присоединиться к домену</div>'
        + '<div class="form-group">'
        + '<label class="form-label">Домен (FQDN)</label>'
        + '<div style="display:flex;gap:8px">'
        + '<input type="text" class="form-control" id="joinDomain" placeholder="company.local">'
        + '<button class="btn btn-default btn-sm" id="btnDiscoverDomain">🔍 Проверить DNS</button>'
        + '</div>'
        + '<div id="discoverResult" style="margin-top:8px"></div>'
        + '</div>'
        + '<div class="form-group">'
        + '<label class="form-label">Метод интеграции</label>'
        + '<div class="net-radio-group">'
        + '<label><input type="radio" name="joinMethod" value="winbind" checked> Winbind (рекомендуется для NAS)</label>'
        + '<label><input type="radio" name="joinMethod" value="sssd"> SSSD (для Linux-логинов)</label>'
        + '</div></div>'
        + '<div class="form-group"><label class="form-label">Пользователь AD (с правами join)</label>'
        + '<input type="text" class="form-control" id="joinUser" placeholder="Administrator"></div>'
        + '<div class="form-group"><label class="form-label">Пароль</label>'
        + '<input type="password" class="form-control" id="joinPass" placeholder="••••••••"></div>'
        + '<div id="joinSteps" class="domain-progress-steps" style="display:none"></div>'
        + '<div id="joinError" class="net-alert net-alert-danger" style="display:none"></div>'
        + '<button class="btn btn-primary" id="btnJoinDomain">🔗 Подключиться к домену</button>'
        + '</div>';

    document.getElementById("btnDiscoverDomain").addEventListener("click", function() {
        var domain = document.getElementById("joinDomain").value.trim();
        if (!domain) { alert("Введите доменное имя"); return; }
        var res = document.getElementById("discoverResult");
        res.innerHTML = '<div class="net-loading"><div class="net-spinner"></div> Поиск DC...</div>';
        domainApi(["discover", domain]).then(function(r) {
            if (!r.ok) {
                res.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(r.error) + '</div>';
            } else {
                var dcs = (r.domain_controllers || []).map(function(dc) { return escHtml(dc); }).join(", ");
                res.innerHTML = '<div class="net-alert net-alert-info" style="background:rgba(37,99,235,0.06);border:1px solid rgba(37,99,235,0.2);border-radius:6px;padding:10px">'
                    + '✓ Домен найден: <strong>' + escHtml(r.realm || domain) + '</strong><br>'
                    + (dcs ? 'Контроллеры: ' + dcs : '')
                    + '</div>';
            }
        }).catch(function(e) {
            res.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
        });
    });

    document.getElementById("btnJoinDomain").addEventListener("click", function() {
        var domain = document.getElementById("joinDomain").value.trim();
        var user = document.getElementById("joinUser").value.trim();
        var pass = document.getElementById("joinPass").value;
        var method = document.querySelector('input[name="joinMethod"]:checked').value;
        var errEl = document.getElementById("joinError");
        errEl.style.display = "none";

        if (!domain || !user || !pass) { errEl.textContent = "Заполните все поля"; errEl.style.display = ""; return; }

        var steps = [
            "Проверка DNS",
            "Получение Kerberos TGT",
            "Добавление в домен",
            "Обновление smb.conf",
            "Обновление nsswitch.conf",
            "Запуск Winbind"
        ];
        var stepsEl = document.getElementById("joinSteps");
        stepsEl.style.display = "";
        stepsEl.innerHTML = steps.map(function(s, i) {
            return '<div class="domain-progress-step" id="joinStep' + i + '">'
                + '<div class="domain-step-icon" id="joinStepIcon' + i + '">○</div>'
                + '<div class="domain-step-label">' + escHtml(s) + '</div>'
                + '<div class="domain-step-status" id="joinStepStatus' + i + '"></div>'
                + '</div>';
        }).join("");

        document.getElementById("btnJoinDomain").disabled = true;

        setStep(0, "running"); setStep(1, "running");

        domainApi(["join", domain, user, method, pass]).then(function(r) {
            if (r.ok) {
                for (var i = 0; i < steps.length; i++) setStep(i, "done");
                _domainState.joined = true;
                _domainState.domain = domain;
                _domainMode = "member";
                setTimeout(function() { loadMemberOverview(); loadMemberJoin(); }, 1200);
            } else {
                for (var i = 0; i < 2; i++) setStep(i, "done");
                setStep(2, "error");
                errEl.textContent = r.error || "Ошибка подключения к домену";
                errEl.style.display = "";
                document.getElementById("btnJoinDomain").disabled = false;
            }
        }).catch(function(e) {
            setStep(0, "error");
            errEl.textContent = e.message;
            errEl.style.display = "";
            document.getElementById("btnJoinDomain").disabled = false;
        });
    });
}

function setStep(i, state) {
    var icon = document.getElementById("joinStepIcon" + i);
    if (!icon) return;
    icon.className = "domain-step-icon " + state;
    if (state === "done") icon.textContent = "✓";
    else if (state === "error") icon.textContent = "✗";
    else if (state === "running") icon.textContent = "⟳";
    else icon.textContent = "○";
}

function renderLeaveForm(el) {
    el.innerHTML = '<div class="domain-join-section">'
        + '<div class="net-alert net-alert-warn" style="margin-bottom:16px">⚠ Покидание домена прервёт доступ доменных пользователей к шарам. SMB-соединения будут разорваны.</div>'
        + '<div class="form-group"><label class="form-label">Пользователь AD (с правами remove)</label>'
        + '<input type="text" class="form-control" id="leaveUser" placeholder="Administrator"></div>'
        + '<div class="form-group"><label class="form-label">Пароль</label>'
        + '<input type="password" class="form-control" id="leavePass" placeholder="••••••••"></div>'
        + '<div id="leaveError" class="net-alert net-alert-danger" style="display:none"></div>'
        + '<button class="btn btn-danger" id="btnLeaveDomain">🚪 Покинуть домен</button>'
        + '</div>';

    document.getElementById("btnLeaveDomain").addEventListener("click", function() {
        var user = document.getElementById("leaveUser").value.trim();
        var pass = document.getElementById("leavePass").value;
        var errEl = document.getElementById("leaveError");
        errEl.style.display = "none";
        if (!user || !pass) { errEl.textContent = "Заполните все поля"; errEl.style.display = ""; return; }
        if (!confirm("Покинуть домен " + (_domainState.domain || "") + "? Доменные пользователи потеряют доступ.")) return;
        this.disabled = true;
        var btn = this;
        domainApi(["leave", user, pass]).then(function(r) {
            btn.disabled = false;
            if (r.ok) {
                _domainState.joined = false;
                _domainState.domain = "";
                _domainMode = "none";
                loadMemberOverview();
                renderJoinForm(el);
            } else {
                errEl.textContent = r.error || "Ошибка";
                errEl.style.display = "";
            }
        }).catch(function(e) { btn.disabled = false; errEl.textContent = e.message; errEl.style.display = ""; });
    });
}

// ── Domain users / groups (member mode) ───────────────────────────────────

function loadDomainUsers() {
    var el = document.getElementById("domainUsersList");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div></div>';
    domainApi(["list-users"]).then(function(r) {
        if (!r.ok || !r.users || !r.users.length) {
            el.innerHTML = '<div class="net-muted" style="padding:12px;font-size:0.85rem">'
                + (r.ok ? 'Пользователи не найдены. Убедитесь что NAS подключён к домену.' : escHtml(r.error || "Ошибка"))
                + '</div>';
            return;
        }
        var search = (document.getElementById("domainUserSearch").value || "").toLowerCase();
        var users = r.users.filter(function(u) { return !search || u.username.toLowerCase().includes(search); });
        var html = '<table class="domain-table"><thead><tr><th>Имя входа</th><th>UID</th></tr></thead><tbody>';
        users.forEach(function(u) {
            html += '<tr><td>' + escHtml(u.username) + '</td><td>' + escHtml(u.uid || "—") + '</td></tr>';
        });
        html += '</tbody></table>';
        el.innerHTML = html;
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

function loadDomainGroups() {
    var el = document.getElementById("domainGroupsList");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div></div>';
    domainApi(["list-groups"]).then(function(r) {
        if (!r.ok || !r.groups || !r.groups.length) {
            el.innerHTML = '<div class="net-muted" style="padding:12px;font-size:0.85rem">'
                + (r.ok ? 'Группы не найдены.' : escHtml(r.error || "Ошибка"))
                + '</div>';
            return;
        }
        var html = '<table class="domain-table"><thead><tr><th>Имя группы</th><th>GID</th></tr></thead><tbody>';
        r.groups.forEach(function(g) {
            html += '<tr><td>' + escHtml(g.name) + '</td><td>' + escHtml(g.gid || "—") + '</td></tr>';
        });
        html += '</tbody></table>';
        el.innerHTML = html;
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

function loadPermittedGroups() {
    var el = document.getElementById("permittedGroupsList");
    el.innerHTML = '<span class="net-muted" style="font-size:0.85rem">Загрузка...</span>';
    domainApi(["list-permitted"]).then(function(r) {
        if (!r.ok) { el.innerHTML = '<span class="net-muted">' + escHtml(r.error || "Ошибка") + '</span>'; return; }
        var groups = r.groups || [];
        if (!groups.length) { el.innerHTML = '<span class="net-muted" style="font-size:0.85rem">Нет ограничений — все группы разрешены</span>'; return; }
        el.innerHTML = groups.map(function(g) {
            return '<span class="domain-group-tag">' + escHtml(g)
                + '<button data-group="' + escHtml(g) + '" title="Запретить">×</button></span>';
        }).join("");
        el.querySelectorAll("button[data-group]").forEach(function(btn) {
            btn.addEventListener("click", function() {
                var g = this.dataset.group;
                domainApi(["deny-group", g]).then(function() { loadPermittedGroups(); });
            });
        });
    }).catch(function(e) {
        el.innerHTML = '<span class="net-muted">' + escHtml(e.message) + '</span>';
    });
}

// ── Samba global settings ──────────────────────────────────────────────────

function loadSmbGlobal() {
    var el = document.getElementById("smbGlobalForm");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div></div>';
    domainApi(["get-smb-global"]).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(r.error) + '</div>'; return; }
        var s = r.settings || {};
        var fields = ["workgroup","realm","security","kerberos method","winbind enum users","winbind enum groups","winbind use default domain","template shell","template homedir","idmap config * : backend","idmap config * : range"];
        var html = '';
        fields.forEach(function(k) {
            html += '<div class="net-form-row"><label>' + escHtml(k) + '</label>'
                + '<input type="text" class="form-control net-input-sm" data-key="' + escHtml(k) + '" value="' + escHtml(s[k] || "") + '"></div>';
        });
        html += '<div class="net-form-actions"><button class="btn btn-primary btn-sm" id="btnSaveSmbGlobal">Применить</button></div>'
            + '<div id="smbGlobalMsg" style="margin-top:8px"></div>';
        el.innerHTML = html;
        document.getElementById("btnSaveSmbGlobal").addEventListener("click", function() {
            var inputs = el.querySelectorAll("input[data-key]");
            var btn = this;
            btn.disabled = true;
            var promises = [];
            inputs.forEach(function(inp) {
                var k = inp.dataset.key;
                var v = inp.value.trim();
                if (v) promises.push(domainApi(["set-smb-global", k, v]));
            });
            Promise.all(promises).then(function() {
                btn.disabled = false;
                document.getElementById("smbGlobalMsg").innerHTML = '<span style="color:#16a34a">✓ Настройки применены</span>';
            }).catch(function(e) {
                btn.disabled = false;
                document.getElementById("smbGlobalMsg").innerHTML = '<span style="color:#dc2626">' + escHtml(e.message) + '</span>';
            });
        });
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// DC MODE
// ══════════════════════════════════════════════════════════════════════════════

function loadDcOverview() {
    var el = document.getElementById("dcOverviewContent");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div> Загрузка...</div>';
    domainApi(["dc-status"]).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(r.error) + '</div>'; return; }
        _dcState = r;
        renderDcOverview(r, el);
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

function renderDcOverview(r, el) {
    var svcs = r.services || {};
    var provisioned = r.provisioned;

    var html = '<div class="domain-status-card">';
    if (provisioned) {
        html += '<div class="domain-status-header">'
            + '<div class="domain-status-icon">🏛</div>'
            + '<div><div class="domain-status-title"><span style="color:#16a34a;font-weight:700">● Контроллер домена активен</span></div>'
            + '<div class="domain-status-subtitle">Samba AD DC</div></div></div>'
            + '<div class="domain-info-grid">'
            + infoItem("Домен", r.domain || "—")
            + infoItem("Realm", r.realm || "—")
            + infoItem("NetBIOS", r.netbios || "—")
            + infoItem("DC hostname", r.dc_hostname || "—")
            + infoItem("Уровень леса", r.level || "—")
            + infoItem("Клиентов", String(r.clients || 0))
            + '</div>';

        var fsmo = r.fsmo || {};
        if (Object.keys(fsmo).length) {
            html += '<div style="margin:12px 0 8px;font-weight:700;font-size:0.82rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-muted)">FSMO роли</div>'
                + '<div class="domain-fsmo-grid">';
            var fsmoLabels = {
                "SchemaMaster": "Schema Master",
                "DomainMaster": "Domain Master",
                "PDCEmulator": "PDC Emulator",
                "RIDManager": "RID Manager",
                "InfrastructureMaster": "Infrastructure Master"
            };
            Object.keys(fsmoLabels).forEach(function(k) {
                var holder = fsmo[k] || "—";
                var isSelf = holder && r.dc_hostname && holder.toLowerCase().includes(r.dc_hostname.toLowerCase().split(".")[0]);
                html += '<div class="domain-fsmo-item">'
                    + '<div class="domain-fsmo-role">' + escHtml(fsmoLabels[k]) + '</div>'
                    + '<div class="domain-fsmo-holder' + (isSelf ? " domain-fsmo-self" : "") + '">' + escHtml(holder) + (isSelf ? ' <span style="font-size:0.7rem">(этот сервер)</span>' : '') + '</div>'
                    + '</div>';
            });
            html += '</div>';

            // Info block — SMB shares work natively in DC mode
            html += '<div class="domain-info-block">'
                + '<div style="font-size:1.1rem;flex-shrink:0">ℹ️</div>'
                + '<div><strong>SMB-шары работают нативно</strong><br>'
                + 'Когда rusNAS является контроллером домена, пользователи домена <code>CORP\\имя</code> '
                + 'подключаются к SMB-шарам напрямую — samba-ad-dc аутентифицирует их самостоятельно. '
                + 'Режим «Участник домена» (Winbind) недоступен одновременно с DC: '
                + 'DC сам выполняет роль, которую выполнял бы Winbind на member-сервере.</div>'
                + '</div>';
        }
    } else {
        html += '<div class="domain-status-header">'
            + '<div class="domain-status-icon">🏛</div>'
            + '<div><div class="domain-status-title"><span style="color:var(--color-muted)">○ Домен не настроен</span></div>'
            + '<div class="domain-status-subtitle">Samba AD DC не настроен</div></div></div>'
            + '<p style="color:var(--color-muted);font-size:0.85rem">Используйте вкладку «Создать домен» для первоначальной настройки.</p>'
            + '<button class="btn btn-primary btn-sm" id="btnGotoProvision">🚀 Создать домен</button>';
    }

    function svcBadge(name, key) {
        var st = svcs[key] || "unknown";
        return '<span class="domain-svc-badge ' + (st === "active" ? "active" : "inactive") + '">'
            + '<span class="domain-svc-dot"></span>' + escHtml(name) + ' ' + escHtml(st) + '</span>';
    }
    var dcActive = (svcs.samba_ad_dc === "active");
    html += '<div class="domain-services-row">'
        + svcBadge("samba-ad-dc", "samba_ad_dc")
        + svcBadge("bind9 (DNS)", "bind9")
        + '<button class="btn btn-default btn-sm" id="btnRefreshDcOverview">↻ Обновить</button>';
    if (provisioned) {
        html += '<button class="btn btn-default btn-sm" id="btnToggleDc">'
            + (dcActive ? "⏹ Остановить DC" : "▶ Запустить DC") + '</button>'
            + '<button class="btn btn-danger btn-sm" id="btnDeprovisionDc">🗑 Удалить домен</button>';
    }
    html += '</div>';

    html += '</div>';
    el.innerHTML = html;

    document.getElementById("btnRefreshDcOverview").addEventListener("click", loadDcOverview);
    var btnGoto = document.getElementById("btnGotoProvision");
    if (btnGoto) {
        btnGoto.addEventListener("click", function() {
            document.querySelector('[data-subtab="dc-provision"]').click();
        });
    }
    var btnToggle = document.getElementById("btnToggleDc");
    if (btnToggle) {
        btnToggle.addEventListener("click", function() {
            var cmd = dcActive ? "dc-stop" : "dc-start";
            btnToggle.disabled = true;
            domainApi([cmd]).then(function(r) {
                if (!r.ok) { alert(r.error || "Ошибка"); }
                loadDcOverview();
            }).catch(function(e) {
                alert(e.message || "Ошибка");
                loadDcOverview();
            });
        });
    }
    var btnDepr = document.getElementById("btnDeprovisionDc");
    if (btnDepr) {
        btnDepr.addEventListener("click", function() {
            document.getElementById("dcDeprovisionConfirm").value = "";
            document.getElementById("dcDeprovisionErr").style.display = "none";
            document.getElementById("dcDeprovisionModal").style.display = "flex";
        });
    }
}

// ── DC Deprovision ─────────────────────────────────────────────────────────

function initDcDeprovisionModal() {
    var modal = document.getElementById("dcDeprovisionModal");
    if (!modal) return;
    document.getElementById("btnCancelDeprovision").addEventListener("click", function() {
        modal.style.display = "none";
    });
    document.getElementById("btnConfirmDeprovision").addEventListener("click", function() {
        var entered = (document.getElementById("dcDeprovisionConfirm").value || "").trim().toLowerCase();
        var expected = (_dcState && _dcState.domain ? _dcState.domain.toLowerCase() : "");
        var errEl = document.getElementById("dcDeprovisionErr");
        if (!entered) {
            errEl.textContent = "Введите имя домена для подтверждения";
            errEl.style.display = "";
            return;
        }
        if (entered !== expected) {
            errEl.textContent = "Имя домена не совпадает. Ожидается: " + (_dcState.domain || "—");
            errEl.style.display = "";
            return;
        }
        errEl.style.display = "none";
        document.getElementById("btnConfirmDeprovision").disabled = true;
        domainApi(["dc-deprovision"]).then(function(r) {
            modal.style.display = "none";
            document.getElementById("btnConfirmDeprovision").disabled = false;
            if (!r.ok) {
                alert("Ошибка при удалении домена: " + (r.error || "неизвестная ошибка"));
            }
            _domainTabLoaded = false;
            initDomainTab();
        }).catch(function(e) {
            modal.style.display = "none";
            document.getElementById("btnConfirmDeprovision").disabled = false;
            alert("Ошибка: " + (e.message || e));
            _domainTabLoaded = false;
            initDomainTab();
        });
    });
}

// ── DC Provision ───────────────────────────────────────────────────────────

function initDcProvision() {
    var fqdnEl = document.getElementById("dcDomainFqdn");
    var nbEl = document.getElementById("dcNetbiosName");
    if (fqdnEl && nbEl) {
        fqdnEl.addEventListener("input", function() {
            var first = this.value.split(".")[0].toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,15);
            // NetBIOS must differ from server hostname — append suffix if equal
            var hostname = (typeof location !== "undefined" ? location.hostname : "").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,15);
            nbEl.value = (first && hostname && first === hostname) ? first.slice(0,13) + "AD" : first;
        });
    }

    var btn = document.getElementById("btnProvisionDomain");
    if (!btn) return;
    btn.addEventListener("click", function() {
        var fqdn = (document.getElementById("dcDomainFqdn").value || "").trim();
        var nb = (document.getElementById("dcNetbiosName").value || "").trim();
        var pass = (document.getElementById("dcAdminPass").value || "");
        var passC = (document.getElementById("dcAdminPassConfirm").value || "");
        var dns = document.querySelector('input[name="dcDnsBackend"]:checked').value;
        var rfc = document.getElementById("dcRfc2307").checked ? "yes" : "no";
        var errEl = document.getElementById("dcProvisionError");
        errEl.style.display = "none";

        if (!fqdn) { errEl.textContent = "Введите имя домена"; errEl.style.display = ""; return; }
        if (!nb) { errEl.textContent = "Введите NetBIOS имя"; errEl.style.display = ""; return; }
        // NetBIOS must not equal the server's short hostname
        var hostname = (typeof location !== "undefined" ? location.hostname : "").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,15);
        if (hostname && nb.toUpperCase() === hostname) {
            errEl.textContent = "NetBIOS имя домена не может совпадать с именем сервера (" + hostname + "). Используйте другое имя, например: " + nb.slice(0,13) + "AD";
            errEl.style.display = "";
            return;
        }
        if (!pass) { errEl.textContent = "Введите пароль"; errEl.style.display = ""; return; }
        if (pass !== passC) { errEl.textContent = "Пароли не совпадают"; errEl.style.display = ""; return; }

        document.getElementById("dcProvisionForm").style.display = "none";
        var progEl = document.getElementById("dcProvisionProgress");
        progEl.style.display = "";
        var stepsEl = document.getElementById("dcProvisionSteps");
        var steps = [
            "Проверка hostname и DNS",
            "samba-tool domain provision",
            "Настройка Kerberos (/etc/krb5.conf)",
            "Запуск samba AD DC"
        ];
        stepsEl.innerHTML = steps.map(function(s, i) {
            return '<div class="domain-progress-step">'
                + '<div class="domain-step-icon" id="dcStep' + i + '">○</div>'
                + '<div class="domain-step-label">' + escHtml(s) + '</div>'
                + '</div>';
        }).join("");

        function dcStep(i, st) {
            var el2 = document.getElementById("dcStep" + i);
            if (!el2) return;
            el2.className = "domain-step-icon " + st;
            if (st === "done") el2.textContent = "✓";
            else if (st === "error") el2.textContent = "✗";
            else if (st === "running") el2.textContent = "⟳";
        }

        dcStep(0, "running"); dcStep(1, "running"); dcStep(2, "running"); dcStep(3, "running");

        domainApi(["dc-provision", fqdn, nb, pass, dns, rfc]).then(function(r) {
            if (r.ok) {
                for (var i = 0; i < steps.length; i++) dcStep(i, "done");
                _dcState.provisioned = true;
                _dcState.realm = fqdn;
                _domainMode = "dc";
                updateDomainModeSelector("dc");
                setTimeout(function() { loadDcOverview(); document.querySelector('[data-subtab="dc-overview"]').click(); }, 1500);
            } else {
                dcStep(1, "error");
                var errEl2 = document.getElementById("dcProvisionError");
                errEl2.textContent = r.error || "Ошибка провизии домена";
                errEl2.style.display = "";
                document.getElementById("dcProvisionForm").style.display = "";
                progEl.style.display = "none";
            }
        }).catch(function(e) {
            dcStep(1, "error");
            var errEl2 = document.getElementById("dcProvisionError");
            errEl2.textContent = e.message;
            errEl2.style.display = "";
            document.getElementById("dcProvisionForm").style.display = "";
            progEl.style.display = "none";
        });
    });
}

// ── DC Users ───────────────────────────────────────────────────────────────

function loadDcUsers() {
    var el = document.getElementById("dcUsersTable");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div></div>';
    domainApi(["dc-user-list"]).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(r.error) + '</div>'; return; }
        var users = r.users || [];
        var search = (document.getElementById("dcUserSearch").value || "").toLowerCase();
        if (search) users = users.filter(function(u) { return u.username.toLowerCase().includes(search); });
        if (!users.length) { el.innerHTML = '<div class="net-muted" style="padding:12px;font-size:0.85rem">Пользователи не найдены</div>'; return; }
        var html = '<table class="domain-table"><thead><tr><th>Имя входа</th><th>Полное имя</th><th>Email</th><th>Статус</th><th></th></tr></thead><tbody>';
        users.forEach(function(u) {
            var enabled = u.enabled !== false;
            html += '<tr>'
                + '<td><strong>' + escHtml(u.username) + '</strong></td>'
                + '<td>' + escHtml(u.fullname || "—") + '</td>'
                + '<td>' + escHtml(u.email || "—") + '</td>'
                + '<td>' + (enabled
                    ? '<span class="domain-user-enabled">● Вкл.</span>'
                    : '<span class="domain-user-disabled">○ Откл.</span>') + '</td>'
                + '<td style="white-space:nowrap">'
                + '<button class="btn btn-sm btn-default dc-user-pass" data-user="' + escHtml(u.username) + '" title="Сменить пароль">🔑</button> '
                + (enabled
                    ? '<button class="btn btn-sm btn-default dc-user-disable" data-user="' + escHtml(u.username) + '" title="Отключить">⊘</button> '
                    : '<button class="btn btn-sm btn-default dc-user-enable" data-user="' + escHtml(u.username) + '" title="Включить">✓</button> ')
                + '<button class="btn btn-sm btn-danger dc-user-delete" data-user="' + escHtml(u.username) + '" title="Удалить">✕</button>'
                + '</td></tr>';
        });
        html += '</tbody></table>';
        el.innerHTML = html;

        el.querySelectorAll(".dc-user-pass").forEach(function(btn) {
            btn.addEventListener("click", function() { openDcPassModal(this.dataset.user); });
        });
        el.querySelectorAll(".dc-user-disable").forEach(function(btn) {
            btn.addEventListener("click", function() {
                domainApi(["dc-user-disable", this.dataset.user]).then(function() { loadDcUsers(); });
            });
        });
        el.querySelectorAll(".dc-user-enable").forEach(function(btn) {
            btn.addEventListener("click", function() {
                domainApi(["dc-user-enable", this.dataset.user]).then(function() { loadDcUsers(); });
            });
        });
        el.querySelectorAll(".dc-user-delete").forEach(function(btn) {
            btn.addEventListener("click", function() {
                var u = this.dataset.user;
                if (!confirm("Удалить пользователя " + u + "?")) return;
                domainApi(["dc-user-delete", u]).then(function() { loadDcUsers(); });
            });
        });
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

function openDcPassModal(username) {
    document.getElementById("dcPassUsername").textContent = username;
    document.getElementById("dcPassNew").value = "";
    document.getElementById("dcPassError").style.display = "none";
    document.getElementById("dcPassModal")._username = username;
    document.getElementById("dcPassModal").style.display = "";
}

// ── DC Groups ──────────────────────────────────────────────────────────────

function loadDcGroups() {
    var el = document.getElementById("dcGroupsTable");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div></div>';
    domainApi(["dc-group-list"]).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(r.error) + '</div>'; return; }
        var groups = r.groups || [];
        if (!groups.length) { el.innerHTML = '<div class="net-muted" style="padding:12px;font-size:0.85rem">Группы не найдены</div>'; return; }
        var html = '<table class="domain-table"><thead><tr><th>Имя группы</th><th>Тип</th><th>Участников</th><th></th></tr></thead><tbody>';
        groups.forEach(function(g) {
            html += '<tr>'
                + '<td><strong>' + escHtml(g.name) + '</strong></td>'
                + '<td>' + escHtml(g.type || "Security Group") + '</td>'
                + '<td>' + escHtml(String(g.members_count || 0)) + '</td>'
                + '<td style="white-space:nowrap">'
                + '<button class="btn btn-sm btn-default dc-group-members" data-group="' + escHtml(g.name) + '" title="Управление участниками">👥</button> '
                + '<button class="btn btn-sm btn-danger dc-group-delete" data-group="' + escHtml(g.name) + '" title="Удалить">✕</button>'
                + '</td></tr>';
        });
        html += '</tbody></table>';
        el.innerHTML = html;

        el.querySelectorAll(".dc-group-members").forEach(function(btn) {
            btn.addEventListener("click", function() { openGroupMembersModal(this.dataset.group); });
        });
        el.querySelectorAll(".dc-group-delete").forEach(function(btn) {
            btn.addEventListener("click", function() {
                var g = this.dataset.group;
                if (!confirm("Удалить группу " + g + "?")) return;
                domainApi(["dc-group-delete", g]).then(function() { loadDcGroups(); });
            });
        });
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

function openGroupMembersModal(groupName) {
    _dcGroupCurrent = groupName;
    document.getElementById("dcGroupMembersName").textContent = groupName;
    document.getElementById("dcGroupAddMember").value = "";
    document.getElementById("dcGroupMembersError").style.display = "none";
    document.getElementById("dcGroupMembersModal").style.display = "";
    loadGroupMembers(groupName);
}

function loadGroupMembers(groupName) {
    var el = document.getElementById("dcGroupMembersContent");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div></div>';
    domainApi(["dc-group-members", groupName]).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(r.error) + '</div>'; return; }
        var members = r.members || [];
        if (!members.length) { el.innerHTML = '<div class="net-muted" style="font-size:0.85rem">Нет участников</div>'; return; }
        el.innerHTML = '<ul style="margin:0;padding:0 0 0 16px">'
            + members.map(function(m) {
                return '<li style="padding:4px 0;display:flex;justify-content:space-between;align-items:center">'
                    + '<span>' + escHtml(m) + '</span>'
                    + '<button class="btn btn-sm btn-danger dc-rm-member" data-member="' + escHtml(m) + '">✕</button>'
                    + '</li>';
            }).join("") + '</ul>';
        el.querySelectorAll(".dc-rm-member").forEach(function(btn) {
            btn.addEventListener("click", function() {
                domainApi(["dc-group-delmember", groupName, this.dataset.member]).then(function() {
                    loadGroupMembers(groupName);
                });
            });
        });
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

// ── DC Replication ─────────────────────────────────────────────────────────

function loadDcRepl() {
    var el = document.getElementById("dcReplContent");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div></div>';
    domainApi(["dc-repl-status"]).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(r.error) + '</div>'; return; }
        var partners = r.partners || [];
        var html = '';
        if (!partners.length) {
            html = '<div class="net-muted" style="font-size:0.85rem;padding:8px 0">Нет дополнительных контроллеров домена. Это единственный DC.</div>';
        } else {
            html = '<table class="domain-table"><thead><tr><th>Хост</th><th>Последняя синхр.</th><th>Статус</th></tr></thead><tbody>';
            partners.forEach(function(p) {
                html += '<tr><td>' + escHtml(p.host || "—") + '</td><td>' + escHtml(p.last_sync || "—") + '</td>'
                    + '<td><span class="domain-svc-badge ' + (p.ok ? "active" : "inactive") + '"><span class="domain-svc-dot"></span>' + (p.ok ? "Sync OK" : "Error") + '</span></td></tr>';
            });
            html += '</tbody></table>';
        }
        if (r.last_sync) html += '<div style="margin-top:8px;font-size:0.82rem;color:var(--color-muted)">Последняя репликация: ' + escHtml(r.last_sync) + '</div>';
        el.innerHTML = html;
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

// ── DC DNS ─────────────────────────────────────────────────────────────────

function loadDcDnsZones() {
    var sel = document.getElementById("dcDnsZone");
    if (!sel) return;
    if (_dcState && _dcState.realm) {
        sel.innerHTML = '<option value="' + escHtml(_dcState.realm) + '">' + escHtml(_dcState.realm) + '</option>';
    }
}

function queryDcDns() {
    var zone = document.getElementById("dcDnsZone").value;
    if (!zone) { alert("Выберите зону"); return; }
    var el = document.getElementById("dcDnsTable");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div></div>';
    domainApi(["dc-dns-query", zone]).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(r.error) + '</div>'; return; }
        var records = r.records || [];
        if (!records.length) { el.innerHTML = '<div class="net-muted" style="padding:20px;text-align:center">Записи не найдены</div>'; return; }
        var html = '<table class="domain-table"><thead><tr><th>Имя</th><th>Тип</th><th>Значение</th><th>TTL</th><th></th></tr></thead><tbody>';
        records.forEach(function(rec) {
            html += '<tr><td>' + escHtml(rec.name || "@") + '</td><td>' + escHtml(rec.type || "") + '</td>'
                + '<td style="font-family:monospace;font-size:0.82rem">' + escHtml(rec.value || "") + '</td>'
                + '<td>' + escHtml(String(rec.ttl || "")) + '</td>'
                + '<td><button class="btn btn-sm btn-danger dc-dns-del" data-name="' + escHtml(rec.name || "@") + '" data-type="' + escHtml(rec.type || "") + '" data-value="' + escHtml(rec.value || "") + '">✕</button></td>'
                + '</tr>';
        });
        html += '</tbody></table>';
        el.innerHTML = html;
        el.querySelectorAll(".dc-dns-del").forEach(function(btn) {
            btn.addEventListener("click", function() {
                var z = document.getElementById("dcDnsZone").value;
                domainApi(["dc-dns-delete", z, this.dataset.name, this.dataset.type, this.dataset.value])
                    .then(function() { queryDcDns(); });
            });
        });
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

// ── DC GPO ─────────────────────────────────────────────────────────────────

function loadDcGpo() {
    var el = document.getElementById("dcGpoTable");
    el.innerHTML = '<div class="net-loading"><div class="net-spinner"></div></div>';
    domainApi(["dc-gpo-list"]).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(r.error) + '</div>'; return; }
        var gpos = r.gpos || [];
        if (!gpos.length) { el.innerHTML = '<div class="net-muted" style="padding:12px;font-size:0.85rem">GPO не найдены</div>'; return; }
        var html = '<table class="domain-table"><thead><tr><th>Имя GPO</th><th>GUID</th><th>Путь</th></tr></thead><tbody>';
        gpos.forEach(function(g) {
            html += '<tr><td><strong>' + escHtml(g.name) + '</strong></td><td style="font-family:monospace;font-size:0.78rem">' + escHtml(g.guid || "—") + '</td><td style="font-size:0.8rem">' + escHtml(g.path || "—") + '</td></tr>';
        });
        html += '</tbody></table>';
        el.innerHTML = html;
    }).catch(function(e) {
        el.innerHTML = '<div class="net-alert net-alert-danger">' + escHtml(e.message) + '</div>';
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// DOMAIN MODAL HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

function initDomainModals() {
    // DC User modal
    var btnAddUser = document.getElementById("btnAddDcUser");
    if (btnAddUser) {
        btnAddUser.addEventListener("click", function() {
            document.getElementById("dcUserModalTitle").textContent = "Создать пользователя домена";
            document.getElementById("dcUserUsername").value = "";
            document.getElementById("dcUserFullname").value = "";
            document.getElementById("dcUserEmail").value = "";
            document.getElementById("dcUserPass").value = "";
            document.getElementById("dcUserEnabled").checked = true;
            document.getElementById("dcUserModalError").style.display = "none";
            document.getElementById("dcUserPassGroup").style.display = "";
            document.getElementById("dcUserModal").style.display = "";
        });
    }

    var btnSaveUser = document.getElementById("btnSaveDcUser");
    if (btnSaveUser) {
        btnSaveUser.addEventListener("click", function() {
            var u = document.getElementById("dcUserUsername").value.trim();
            var fn = document.getElementById("dcUserFullname").value.trim();
            var email = document.getElementById("dcUserEmail").value.trim();
            var pass = document.getElementById("dcUserPass").value;
            var errEl = document.getElementById("dcUserModalError");
            errEl.style.display = "none";
            if (!u || !pass) { errEl.textContent = "Введите имя и пароль"; errEl.style.display = ""; return; }
            this.disabled = true;
            var btn = this;
            domainApi(["dc-user-add", u, pass, fn, email]).then(function(r) {
                btn.disabled = false;
                if (r.ok) { document.getElementById("dcUserModal").style.display = "none"; loadDcUsers(); }
                else { errEl.textContent = r.error || "Ошибка"; errEl.style.display = ""; }
            }).catch(function(e) { btn.disabled = false; errEl.textContent = e.message; errEl.style.display = ""; });
        });
    }

    // DC Password modal
    var btnSavePass = document.getElementById("btnSaveDcPass");
    if (btnSavePass) {
        btnSavePass.addEventListener("click", function() {
            var username = document.getElementById("dcPassModal")._username;
            var pass = document.getElementById("dcPassNew").value;
            var errEl = document.getElementById("dcPassError");
            errEl.style.display = "none";
            if (!pass) { errEl.textContent = "Введите пароль"; errEl.style.display = ""; return; }
            this.disabled = true;
            var btn = this;
            domainApi(["dc-user-setpass", username, pass]).then(function(r) {
                btn.disabled = false;
                if (r.ok) { document.getElementById("dcPassModal").style.display = "none"; }
                else { errEl.textContent = r.error || "Ошибка"; errEl.style.display = ""; }
            }).catch(function(e) { btn.disabled = false; errEl.textContent = e.message; errEl.style.display = ""; });
        });
    }

    // DC Group modal
    var btnAddGroup = document.getElementById("btnAddDcGroup");
    if (btnAddGroup) {
        btnAddGroup.addEventListener("click", function() {
            document.getElementById("dcGroupName").value = "";
            document.getElementById("dcGroupModalError").style.display = "none";
            document.getElementById("dcGroupModal").style.display = "";
        });
    }

    var btnSaveGroup = document.getElementById("btnSaveDcGroup");
    if (btnSaveGroup) {
        btnSaveGroup.addEventListener("click", function() {
            var name = document.getElementById("dcGroupName").value.trim();
            var errEl = document.getElementById("dcGroupModalError");
            errEl.style.display = "none";
            if (!name) { errEl.textContent = "Введите имя группы"; errEl.style.display = ""; return; }
            this.disabled = true;
            var btn = this;
            domainApi(["dc-group-add", name]).then(function(r) {
                btn.disabled = false;
                if (r.ok) { document.getElementById("dcGroupModal").style.display = "none"; loadDcGroups(); }
                else { errEl.textContent = r.error || "Ошибка"; errEl.style.display = ""; }
            }).catch(function(e) { btn.disabled = false; errEl.textContent = e.message; errEl.style.display = ""; });
        });
    }

    // Group members modal
    var btnAddMember = document.getElementById("btnAddGroupMember");
    if (btnAddMember) {
        btnAddMember.addEventListener("click", function() {
            var member = document.getElementById("dcGroupAddMember").value.trim();
            var errEl = document.getElementById("dcGroupMembersError");
            errEl.style.display = "none";
            if (!member) { errEl.textContent = "Введите имя пользователя"; errEl.style.display = ""; return; }
            domainApi(["dc-group-addmember", _dcGroupCurrent, member]).then(function(r) {
                if (r.ok) { document.getElementById("dcGroupAddMember").value = ""; loadGroupMembers(_dcGroupCurrent); }
                else { errEl.textContent = r.error || "Ошибка"; errEl.style.display = ""; }
            }).catch(function(e) { errEl.textContent = e.message; errEl.style.display = ""; });
        });
    }

    // DNS record modal
    var btnAddDns = document.getElementById("btnAddDnsRecord");
    if (btnAddDns) {
        btnAddDns.addEventListener("click", function() {
            var zone = document.getElementById("dcDnsZone").value;
            document.getElementById("dnsRecordZone").value = zone;
            document.getElementById("dnsRecordName").value = "";
            document.getElementById("dnsRecordValue").value = "";
            document.getElementById("dcDnsModalError").style.display = "none";
            document.getElementById("dcDnsModal").style.display = "";
        });
    }

    var btnSaveDns = document.getElementById("btnSaveDnsRecord");
    if (btnSaveDns) {
        btnSaveDns.addEventListener("click", function() {
            var zone = document.getElementById("dnsRecordZone").value.trim();
            var name = document.getElementById("dnsRecordName").value.trim();
            var type = document.getElementById("dnsRecordType").value;
            var value = document.getElementById("dnsRecordValue").value.trim();
            var errEl = document.getElementById("dcDnsModalError");
            errEl.style.display = "none";
            if (!zone || !name || !value) { errEl.textContent = "Заполните все поля"; errEl.style.display = ""; return; }
            this.disabled = true;
            var btn = this;
            domainApi(["dc-dns-add", zone, name, type, value]).then(function(r) {
                btn.disabled = false;
                if (r.ok) { document.getElementById("dcDnsModal").style.display = "none"; queryDcDns(); }
                else { errEl.textContent = r.error || "Ошибка"; errEl.style.display = ""; }
            }).catch(function(e) { btn.disabled = false; errEl.textContent = e.message; errEl.style.display = ""; });
        });
    }

    var btnQueryDns = document.getElementById("btnQueryDns");
    if (btnQueryDns) btnQueryDns.addEventListener("click", queryDcDns);

    // GPO modal
    var btnCreateGpo = document.getElementById("btnCreateGpo");
    if (btnCreateGpo) {
        btnCreateGpo.addEventListener("click", function() {
            document.getElementById("dcGpoName").value = "";
            document.getElementById("dcGpoModalError").style.display = "none";
            document.getElementById("dcGpoModal").style.display = "";
        });
    }

    var btnSaveGpo = document.getElementById("btnSaveDcGpo");
    if (btnSaveGpo) {
        btnSaveGpo.addEventListener("click", function() {
            var name = document.getElementById("dcGpoName").value.trim();
            var errEl = document.getElementById("dcGpoModalError");
            errEl.style.display = "none";
            if (!name) { errEl.textContent = "Введите имя GPO"; errEl.style.display = ""; return; }
            this.disabled = true;
            var btn = this;
            domainApi(["dc-gpo-create", name]).then(function(r) {
                btn.disabled = false;
                if (r.ok) { document.getElementById("dcGpoModal").style.display = "none"; loadDcGpo(); }
                else { errEl.textContent = r.error || "Ошибка"; errEl.style.display = ""; }
            }).catch(function(e) { btn.disabled = false; errEl.textContent = e.message; errEl.style.display = ""; });
        });
    }

    // Replication buttons
    var btnSync = document.getElementById("btnSyncRepl");
    if (btnSync) {
        btnSync.addEventListener("click", function() {
            this.disabled = true;
            var btn = this;
            domainApi(["dc-repl-sync"]).then(function(r) {
                btn.disabled = false;
                if (!r.ok) alert("Ошибка: " + (r.error || ""));
                else loadDcRepl();
            }).catch(function(e) { btn.disabled = false; alert(e.message); });
        });
    }

    var btnReplLog = document.getElementById("btnShowReplLog");
    if (btnReplLog) {
        btnReplLog.addEventListener("click", function() {
            document.getElementById("dcReplLogModal").style.display = "";
            var el = document.getElementById("dcReplLogOutput");
            el.textContent = "Загрузка...";
            domainApi(["dc-repl-status"]).then(function(r) {
                el.textContent = r.raw || JSON.stringify(r, null, 2);
            }).catch(function(e) { el.textContent = e.message; });
        });
    }

    // Refresh buttons
    var btnRefUsers = document.getElementById("btnRefreshDomainUsers");
    if (btnRefUsers) btnRefUsers.addEventListener("click", loadDomainUsers);

    var btnRefGroups = document.getElementById("btnRefreshDomainGroups");
    if (btnRefGroups) btnRefGroups.addEventListener("click", loadDomainGroups);

    var btnRefDcUsers = document.getElementById("btnRefreshDcUsers");
    if (btnRefDcUsers) btnRefDcUsers.addEventListener("click", loadDcUsers);

    var btnRefDcGroups = document.getElementById("btnRefreshDcGroups");
    if (btnRefDcGroups) btnRefDcGroups.addEventListener("click", loadDcGroups);

    var btnRefGpo = document.getElementById("btnRefreshGpo");
    if (btnRefGpo) btnRefGpo.addEventListener("click", loadDcGpo);

    var dcUserSearch = document.getElementById("dcUserSearch");
    if (dcUserSearch) dcUserSearch.addEventListener("input", loadDcUsers);

    var domainUserSearch = document.getElementById("domainUserSearch");
    if (domainUserSearch) domainUserSearch.addEventListener("input", loadDomainUsers);

    var btnPermit = document.getElementById("btnPermitGroup");
    if (btnPermit) {
        btnPermit.addEventListener("click", function() {
            var g = document.getElementById("permitGroupInput").value.trim();
            if (!g) return;
            domainApi(["permit-group", g]).then(function() {
                document.getElementById("permitGroupInput").value = "";
                loadPermittedGroups();
            });
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// DOMAIN INIT
// ══════════════════════════════════════════════════════════════════════════════

function initDomainTab() {
    if (_domainTabLoaded) return;
    _domainTabLoaded = true;
    initDomainModeSelector();
    initSubtabs("#memberSubtabs", "member");
    initSubtabs("#dcSubtabs", "dc");
    initDcProvision();
    initDcDeprovisionModal();
    initDomainModals();
    loadDomain();
}
