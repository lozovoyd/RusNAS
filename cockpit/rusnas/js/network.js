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
    document.querySelectorAll("#netTabs li").forEach(function(li) {
        li.classList.remove("active");
    });
    var content = document.getElementById("tab-" + tabName);
    if (content) content.style.display = "";
    var link = document.querySelector('#netTabs a[data-tab="' + tabName + '"]');
    if (link) link.parentElement.classList.add("active");

    if (!_tabLoaded[tabName]) {
        _tabLoaded[tabName] = true;
        if (tabName === "dns")    loadDns(); loadHosts();
        if (tabName === "routes") loadRoutes();
        if (tabName === "diag")   populateWolIfaceSelect();
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
            return;
        }
        if (data.warn) {
            console.warn(data.warn);
        }
        loadInterfaces();
    }).catch(function(e) {
        alert("Ошибка: " + String(e));
    });
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

// ── DOMContentLoaded ──────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {

    wireModalDismiss();

    // Tab switching
    document.querySelectorAll("#netTabs a[data-tab]").forEach(function(a) {
        a.addEventListener("click", function(e) {
            e.preventDefault();
            switchTab(a.dataset.tab);
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

    // Initial load
    loadInterfaces();
    startTrafficPoll();

    // DNS and hosts load lazily via tab switch handler
    // but load immediately so if user starts on Interfaces tab these are ready too
    loadDns();
    loadHosts();
    loadRoutes();
});
