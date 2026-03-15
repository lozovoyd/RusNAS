// ─── rusNAS Guard UI ───────────────────────────────────────────────────────
//
// Communicates with rusnas-guard daemon via Unix socket
// at /run/rusnas-guard/control.sock through cockpit.channel (fsread1 + socket).
// Falls back to polling state.json via cockpit.file() for read-only status.
//
// ─────────────────────────────────────────────────────────────────────────────

var SOCK_PATH   = "/run/rusnas-guard/control.sock";
var STATE_PATH  = "/run/rusnas-guard/state.json";
var EXTS_PATH   = "/etc/rusnas-guard/ransom_extensions.txt";

var guardToken    = null;   // session token (valid 30 min)
var currentMode   = "monitor";
var refreshTimer  = null;
var pendingAction = null;   // function to call after PIN confirmed

// ── Modal helpers ─────────────────────────────────────────────────────────────

function showModal(id)  { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

// ── Socket communication ──────────────────────────────────────────────────────

function socketSend(req, callback) {
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
            } catch(e) {
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

function guardCmd(cmd, extra, callback) {
    var req = Object.assign({ cmd: cmd }, extra || {});
    if (guardToken) req.token = guardToken;
    socketSend(req, function(err, resp) {
        if (err) { callback(err, null); return; }
        if (resp && resp.data && resp.data.token) {
            guardToken = resp.data.token;
        }
        callback(null, resp);
    });
}

// ── PIN flow ──────────────────────────────────────────────────────────────────

function requirePin(title, desc, action) {
    pendingAction = action;
    document.getElementById("pin-modal-title").textContent = title || "🔐 PIN Guard";
    document.getElementById("pin-modal-desc").textContent  = desc  || "Введите PIN-код для продолжения.";
    document.getElementById("pin-input").value = "";
    document.getElementById("pin-error").classList.add("hidden");
    showModal("pin-modal");
    setTimeout(function() { document.getElementById("pin-input").focus(); }, 100);
}

function submitPin() {
    var pin = document.getElementById("pin-input").value;
    if (!pin) return;

    guardCmd("auth", { pin: pin }, function(err, resp) {
        if (err || !resp || !resp.ok) {
            if (resp && resp.error === "no_pin_set") {
                closeModal("pin-modal");
                showModal("setup-pin-modal");
                return;
            }
            var errEl = document.getElementById("pin-error");
            errEl.textContent = (resp && resp.error) || "Неверный PIN";
            errEl.classList.remove("hidden");
            return;
        }
        closeModal("pin-modal");
        if (pendingAction) {
            var fn = pendingAction;
            pendingAction = null;
            fn(pin);
        }
    });
}

// ── PIN setup check ───────────────────────────────────────────────────────────

var _pinCheckPending = false;

function checkPinSetup() {
    if (_pinCheckPending) return;
    _pinCheckPending = true;

    guardCmd("has_pin", {}, function(err, resp) {
        _pinCheckPending = false;
        if (!err && resp && resp.ok) {
            if (!resp.data.has_pin) {
                showModal("setup-pin-modal");
            }
            return;
        }
        // Socket unavailable — fall back to checking file existence directly
        cockpit.spawn(["test", "-f", "/etc/rusnas-guard/guard.pin"],
                      {err: "ignore"})
            .fail(function() {
                // Exit code 1 = file does not exist
                showModal("setup-pin-modal");
            });
    });
}

// ── Daemon status ─────────────────────────────────────────────────────────────

var _statusPending = false;

function refreshStatus() {
    if (_statusPending) return;   // previous request still in flight — skip
    _statusPending = true;

    guardCmd("status", {}, function(err, resp) {
        _statusPending = false;
        if (err || !resp || !resp.ok) {
            updateStatusBadge(null);
            checkPinSetup();
            return;
        }
        var s = resp.data;
        updateStatusBadge(s);
        updateDashboard(s);

        // Post-attack warning
        var banner = document.getElementById("post-attack-banner");
        if (s.post_attack_warning) {
            banner.classList.remove("hidden");
        } else {
            banner.classList.add("hidden");
        }

        // Load events only after status succeeds (sequential, not concurrent)
        guardCmd("get_events", { limit: 50 }, function(evErr, evResp) {
            if (!evErr && evResp && evResp.ok) {
                renderEvents(evResp.data);
            }
        });
    });
}

function updateStatusBadge(s) {
    var badge = document.getElementById("daemon-status-badge");
    if (!s) {
        // Daemon process not reachable
        badge.className = "badge badge-danger";
        badge.textContent = "⬤ Служба недоступна";
        return;
    }
    // Daemon process is always running; badge shows monitoring state
    if (s.daemon_running) {
        badge.className = "badge badge-success";
        badge.textContent = "⬤ Защита активна";
    } else {
        badge.className = "badge badge-warning";
        badge.textContent = "⬤ Мониторинг выключен";
    }

    // Mode buttons
    currentMode = s.mode || "monitor";
    document.querySelectorAll(".mode-btn").forEach(function(btn) {
        btn.classList.toggle("btn-primary",   btn.dataset.mode === currentMode);
        btn.classList.toggle("btn-secondary", btn.dataset.mode !== currentMode && btn.dataset.mode !== "super_safe");
        if (btn.dataset.mode === "super_safe") {
            btn.classList.toggle("btn-danger",  btn.dataset.mode !== currentMode);
        }
    });
}

function updateDashboard(s) {
    document.getElementById("stat-events-today").textContent  = s.events_today   || 0;
    document.getElementById("stat-iops").textContent          = s.current_iops   || 0;
    document.getElementById("stat-baseline").textContent      = s.baseline_status || "—";
    document.getElementById("stat-paths").textContent         = s.monitored_count || 0;
    document.getElementById("stat-blocked").textContent       = (s.blocked_ips || []).length;

    var snap = s.last_snapshot;
    document.getElementById("stat-last-snapshot").textContent =
        snap ? new Date(snap).toLocaleString("ru") : "нет";
}

// ── Event log ─────────────────────────────────────────────────────────────────

var METHOD_LABELS = {
    honeypot:  "🪤 Приманка",
    entropy:   "📊 Энтропия",
    iops:      "📈 IOPS",
    extension: "🔒 Расширение"
};

function renderEvents(events) {
    var body = document.getElementById("events-body");
    if (!events || events.length === 0) {
        body.innerHTML = "<tr><td colspan='7' class='text-muted'>Событий нет.</td></tr>";
        return;
    }

    body.innerHTML = events.map(function(ev) {
        var t       = ev.time ? new Date(ev.time).toLocaleString("ru") : "—";
        var method  = METHOD_LABELS[ev.method] || ev.method;
        var path    = ev.path    || "—";
        var ip      = ev.source_ip || "—";
        var action  = ev.action  || "logged";
        var status  = ev.status  === "acknowledged"
            ? "<span class='badge badge-secondary'>Просмотрено</span>"
            : "<span class='badge badge-danger'>Новое</span>";
        var ackBtn  = ev.status !== "acknowledged"
            ? "<button class='btn btn-secondary btn-sm' onclick='ackEvent(\"" + ev.id + "\")'>✓ Принято</button>"
            : "";

        var details = "";
        if (ev.files && ev.files.length) {
            details = ev.files.slice(0, 5).join(", ");
            if (ev.files.length > 5) details += " ...+" + (ev.files.length - 5);
        }
        if (ev.entropy) details += " [энтропия: " + ev.entropy + "]";
        if (ev.iops_rate) details += " [" + ev.iops_rate + " оп/мин]";

        return "<tr>" +
            "<td style='font-size:12px;white-space:nowrap;'>" + t + "</td>" +
            "<td>" + method + "</td>" +
            "<td style='font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' title='" + path + "'>" + path + "</td>" +
            "<td><code>" + ip + "</code></td>" +
            "<td style='font-size:12px;'>" + action +
                (details ? "<br><span class='text-muted' style='font-size:11px;'>" + details + "</span>" : "") +
            "</td>" +
            "<td>" + status + "</td>" +
            "<td>" + ackBtn + "</td>" +
            "</tr>";
    }).join("");
}

function ackEvent(eventId) {
    requirePin("✓ Подтвердить событие", "Введите PIN для подтверждения события.", function() {
        guardCmd("acknowledge", { event_id: eventId }, function(err, resp) {
            if (!err && resp && resp.ok) refreshStatus();
            else showAlert("danger", "Ошибка подтверждения события");
        });
    });
}

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
    guardCmd("get_config", {}, function(err, resp) {
        if (err || !resp || !resp.ok) return;
        var cfg = resp.data;

        // Detection settings
        var det = cfg.detection || {};
        document.getElementById("det-honeypot").checked    = det.honeypot !== false;
        document.getElementById("det-entropy").checked     = det.entropy  !== false;
        document.getElementById("det-iops").checked        = det.iops     !== false;
        document.getElementById("det-extensions").checked  = det.extensions !== false;

        var threshold = det.entropy_threshold || 7.2;
        document.getElementById("det-entropy-threshold").value = threshold;
        document.getElementById("entropy-threshold-val").textContent = threshold;

        var mult = String(det.iops_multiplier || 4);
        document.getElementById("det-iops-mult").value = mult;

        // Snapshot
        var snap   = cfg.snapshot || {};
        var remote = snap.remote  || {};
        document.getElementById("snap-local-enabled").checked   = snap.local !== false;
        document.getElementById("snap-remote-enabled").checked  = remote.enabled === true;
        document.getElementById("snap-remote-host").value       = remote.host || "";
        document.getElementById("snap-remote-user").value       = remote.user || "rusnas";
        document.getElementById("snap-remote-path").value       = remote.path || "/mnt/backup_pool";

        toggleRemoteFields(remote.enabled === true);

        // Paths table
        renderPaths(cfg.monitored_paths || []);
    });
}

function renderPaths(paths) {
    var body = document.getElementById("paths-body");
    if (!paths.length) {
        body.innerHTML = "<tr><td colspan='7' class='text-muted'>Нет мониторируемых путей. Добавьте путь или перезапустите Guard для автоопределения Btrfs.</td></tr>";
        return;
    }

    body.innerHTML = paths.map(function(p, idx) {
        function chk(key) {
            return "<input type='checkbox' " + (p[key] !== false ? "checked" : "") +
                   " onchange='updatePathFlag(" + idx + ",\"" + key + "\",this.checked)'>";
        }
        return "<tr>" +
            "<td><code>" + p.path + "</code></td>" +
            "<td style='text-align:center;'>" + chk("honeypot")   + "</td>" +
            "<td style='text-align:center;'>" + chk("entropy")    + "</td>" +
            "<td style='text-align:center;'>" + chk("iops")       + "</td>" +
            "<td style='text-align:center;'>" + chk("extensions") + "</td>" +
            "<td style='text-align:center;'>" + chk("enabled")    + "</td>" +
            "<td><button class='btn btn-danger btn-sm' onclick='removePath(" + idx + ")'>Удалить</button></td>" +
            "</tr>";
    }).join("");
}

function updatePathFlag(idx, key, val) {
    requirePin("Изменить настройки", "Введите PIN для изменения настроек мониторинга.", function() {
        guardCmd("get_config", {}, function(err, resp) {
            if (err || !resp || !resp.ok) return;
            var cfg = resp.data;
            if (cfg.monitored_paths && cfg.monitored_paths[idx]) {
                cfg.monitored_paths[idx][key] = val;
                guardCmd("set_config", { config: cfg }, function() { loadConfig(); });
            }
        });
    });
}

function removePath(idx) {
    requirePin("Удалить путь", "Введите PIN для удаления пути мониторинга.", function() {
        guardCmd("get_config", {}, function(err, resp) {
            if (err || !resp || !resp.ok) return;
            var cfg = resp.data;
            cfg.monitored_paths.splice(idx, 1);
            guardCmd("set_config", { config: cfg }, function() { loadConfig(); });
        });
    });
}

// ── Alert banner ──────────────────────────────────────────────────────────────

function showAlert(level, msg) {
    var icon = level === "danger" ? "🔴" : level === "warning" ? "🟡" : "🔵";
    var el   = document.getElementById("guard-alert-banner");
    el.innerHTML = "<div class='alert alert-" + level + "'>" + icon + " " + msg + "</div>";
    setTimeout(function() { el.innerHTML = ""; }, 6000);
}

// ── Toggle remote fields ──────────────────────────────────────────────────────

function toggleRemoteFields(show) {
    document.getElementById("snap-remote-fields").classList.toggle("hidden", !show);
}

// ── Path discovery for add-path modal ────────────────────────────────────────

function discoverAvailablePaths() {
    var listEl = document.getElementById("available-paths-list");

    // Get already configured paths to mark them
    guardCmd("get_config", {}, function(err, resp) {
        var configured = [];
        if (!err && resp && resp.ok) {
            configured = (resp.data.monitored_paths || []).map(function(p) { return p.path; });
        }

        // Run two discovery commands in parallel using cockpit.spawn
        var mounts = null, shares = null;
        var done = 0;

        function tryRender() {
            done++;
            if (done < 2) return;
            renderPathChoices(mounts || [], shares || [], configured);
        }

        // 1. All real non-system mounts (btrfs, ext4, xfs etc, excluding /, /boot, /efi, swap)
        cockpit.spawn(["bash", "-c",
            "findmnt --real -o TARGET,FSTYPE,SOURCE --noheadings 2>/dev/null | " +
            "grep -v '^/ \\|/boot\\|/efi\\|swap\\|tmpfs\\|devtmpfs\\|squashfs'; true"
        ], {err: "message"})
        .done(function(out) {
            mounts = [];
            out.trim().split("\n").filter(Boolean).forEach(function(line) {
                var p = line.trim().split(/\s+/);
                if (p[0]) mounts.push({ path: p[0], fstype: p[1] || "", source: p[2] || "" });
            });
        })
        .always(tryRender);

        // 2. SMB share paths from smb.conf
        cockpit.spawn(["bash", "-c",
            "grep -i '^\\s*path\\s*=' /etc/samba/smb.conf 2>/dev/null | " +
            "sed 's/.*=\\s*//' | sort -u; true"
        ], {err: "message"})
        .done(function(out) {
            shares = out.trim().split("\n").filter(Boolean);
        })
        .always(tryRender);
    });
}

function renderPathChoices(mounts, smbPaths, configured) {
    var listEl = document.getElementById("available-paths-list");

    // Build merged, deduped list
    var seen = {};
    var items = [];

    mounts.forEach(function(m) {
        if (!seen[m.path]) {
            seen[m.path] = true;
            items.push({ path: m.path, label: m.fstype + (m.source ? "  " + m.source : ""), group: "mount" });
        }
    });

    smbPaths.forEach(function(p) {
        if (!seen[p]) {
            seen[p] = true;
            items.push({ path: p, label: "SMB шара", group: "smb" });
        } else {
            // Mark existing mount item as also an SMB share
            items.forEach(function(item) {
                if (item.path === p) item.label += "  · SMB";
            });
        }
    });

    if (items.length === 0) {
        listEl.innerHTML = '<div class="text-muted" style="padding:8px 10px;font-size:13px;">Доступных томов не найдено</div>';
        return;
    }

    listEl.innerHTML = items.map(function(item) {
        var isConfigured = configured.indexOf(item.path) !== -1;
        var style = "padding:7px 10px;cursor:pointer;font-size:13px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--color-border);";
        if (isConfigured) {
            style += "opacity:0.5;cursor:default;";
        }
        var badge = isConfigured
            ? '<span style="font-size:11px;color:var(--color-muted);margin-left:8px;">уже добавлен</span>'
            : '<span style="font-size:11px;color:var(--color-muted);margin-left:8px;">' + (item.label || "") + '</span>';
        var dataAttr = isConfigured ? "" : ' data-path="' + item.path.replace(/"/g, "&quot;") + '"';
        var hoverClass = isConfigured ? "" : ' class="path-choice"';
        return '<div' + hoverClass + dataAttr + ' style="' + style + '">' +
            '<code style="font-size:13px;">' + item.path + '</code>' + badge + '</div>';
    }).join("");

    // Click to fill input
    listEl.querySelectorAll(".path-choice").forEach(function(el) {
        el.addEventListener("click", function() {
            document.getElementById("add-path-input").value = el.dataset.path;
            listEl.querySelectorAll(".path-choice").forEach(function(e) {
                e.style.background = "";
            });
            el.style.background = "var(--color-highlight, rgba(34,170,68,0.15))";
        });
        el.addEventListener("mouseenter", function() {
            if (!el.style.background || el.style.background === "") {
                el.style.background = "var(--color-row-hover, rgba(255,255,255,0.05))";
            }
        });
        el.addEventListener("mouseleave", function() {
            if (el.style.background === "var(--color-row-hover, rgba(255,255,255,0.05))") {
                el.style.background = "";
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Init & event wiring
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {

    // Check if PIN is set (also called from refreshStatus)
    checkPinSetup();

    // Initial load
    refreshStatus();
    loadConfig();

    // Auto-refresh every 10 seconds; pause when tab is hidden
    refreshTimer = setInterval(refreshStatus, 10000);
    document.addEventListener("visibilitychange", function() {
        if (document.hidden) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        } else {
            if (!refreshTimer) {
                refreshStatus();
                refreshTimer = setInterval(refreshStatus, 10000);
            }
        }
    });

    // ── Start / Stop monitoring (daemon process always runs) ──────────────────
    document.getElementById("btn-start-guard").addEventListener("click", function() {
        requirePin("▶ Включить защиту", "Введите PIN для включения мониторинга файловой системы.", function() {
            guardCmd("start", {}, function(err, resp) {
                if (!err && resp && resp.ok) {
                    refreshStatus();
                    showAlert("info", "Защита включена — Guard начал мониторинг файловой системы.");
                } else {
                    showAlert("danger", "Не удалось включить защиту: " + ((resp && resp.error) || "ошибка"));
                }
            });
        });
    });

    document.getElementById("btn-stop-guard").addEventListener("click", function() {
        requirePin("■ Выключить защиту", "Введите PIN для остановки мониторинга файловой системы.", function() {
            guardCmd("stop", {}, function(err, resp) {
                if (!err && resp && resp.ok) {
                    refreshStatus();
                    showAlert("warning", "Мониторинг остановлен. Служба rusnas-guard продолжает работать в фоне.");
                } else {
                    showAlert("danger", "Ошибка остановки мониторинга");
                }
            });
        });
    });

    // ── Mode buttons ──────────────────────────────────────────────────────────
    document.querySelectorAll(".mode-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var mode = btn.dataset.mode;
            if (mode === "super_safe") {
                showModal("supersafe-modal");
                return;
            }
            requirePin("Сменить режим", "Введите PIN для смены режима защиты.", function() {
                guardCmd("set_mode", { mode: mode }, function(err, resp) {
                    if (!err && resp && resp.ok) refreshStatus();
                    else showAlert("danger", "Ошибка смены режима");
                });
            });
        });
    });

    // Super-safe confirmation
    document.getElementById("btn-supersafe-confirm").addEventListener("click", function() {
        closeModal("supersafe-modal");
        requirePin("⚠ Супер-защита", "Введите PIN для активации режима Супер-защита.", function() {
            guardCmd("set_mode", { mode: "super_safe" }, function(err, resp) {
                if (!err && resp && resp.ok) refreshStatus();
                else showAlert("danger", "Ошибка смены режима");
            });
        });
    });
    document.getElementById("btn-supersafe-cancel").addEventListener("click", function() {
        closeModal("supersafe-modal");
    });

    // ── PIN modal ─────────────────────────────────────────────────────────────
    document.getElementById("btn-pin-confirm").addEventListener("click", submitPin);
    document.getElementById("btn-pin-cancel").addEventListener("click",  function() {
        closeModal("pin-modal");
        pendingAction = null;
    });
    document.getElementById("pin-input").addEventListener("keydown", function(e) {
        if (e.key === "Enter") submitPin();
    });

    // ── First-run PIN setup ───────────────────────────────────────────────────
    document.getElementById("btn-setup-pin-save").addEventListener("click", function() {
        var pin1 = document.getElementById("setup-pin-input").value;
        var pin2 = document.getElementById("setup-pin-confirm").value;
        var errEl = document.getElementById("setup-pin-error");

        if (pin1.length < 6) {
            errEl.textContent = "PIN должен быть не менее 6 символов";
            errEl.classList.remove("hidden");
            return;
        }
        if (pin1 !== pin2) {
            errEl.textContent = "PIN-коды не совпадают";
            errEl.classList.remove("hidden");
            return;
        }

        guardCmd("set_pin_initial", { pin: pin1 }, function(err, resp) {
            if (!err && resp && resp.ok) {
                closeModal("setup-pin-modal");
                showAlert("info", "PIN Guard установлен. Теперь вы можете запустить защиту.");
            } else {
                errEl.textContent = (resp && resp.error) || "Ошибка установки PIN";
                errEl.classList.remove("hidden");
            }
        });
    });

    // ── Clear blocks ──────────────────────────────────────────────────────────
    document.getElementById("btn-clear-blocks").addEventListener("click", function() {
        requirePin("Снять блокировки", "Введите PIN для снятия всех блокировок IP.", function() {
            guardCmd("clear_blocks", {}, function(err, resp) {
                if (!err && resp && resp.ok) {
                    showAlert("info", "Все блокировки IP сняты");
                    refreshStatus();
                } else {
                    showAlert("danger", "Ошибка снятия блокировок");
                }
            });
        });
    });

    // ── Post-attack acknowledge ───────────────────────────────────────────────
    document.getElementById("btn-clear-post-attack").addEventListener("click", function() {
        requirePin("Восстановить режим", "Введите PIN для восстановления режима защиты после атаки.", function() {
            guardCmd("acknowledge_post_attack", {}, function(err, resp) {
                if (!err && resp && resp.ok) {
                    document.getElementById("post-attack-banner").classList.add("hidden");
                    showAlert("info", "Режим защиты восстановлен");
                    refreshStatus();
                }
            });
        });
    });

    // ── Detection settings save ───────────────────────────────────────────────
    document.getElementById("det-entropy-threshold").addEventListener("input", function() {
        document.getElementById("entropy-threshold-val").textContent = this.value;
    });

    document.getElementById("btn-save-detection").addEventListener("click", function() {
        requirePin("Сохранить настройки", "Введите PIN для изменения настроек обнаружения.", function() {
            guardCmd("get_config", {}, function(err, resp) {
                if (err || !resp || !resp.ok) return;
                var cfg = resp.data;
                cfg.detection = cfg.detection || {};
                cfg.detection.honeypot          = document.getElementById("det-honeypot").checked;
                cfg.detection.entropy           = document.getElementById("det-entropy").checked;
                cfg.detection.entropy_threshold = parseFloat(document.getElementById("det-entropy-threshold").value);
                cfg.detection.iops              = document.getElementById("det-iops").checked;
                cfg.detection.iops_multiplier   = parseInt(document.getElementById("det-iops-mult").value, 10);
                cfg.detection.extensions        = document.getElementById("det-extensions").checked;

                guardCmd("set_config", { config: cfg }, function(e2, r2) {
                    if (!e2 && r2 && r2.ok) showAlert("info", "Настройки обнаружения сохранены");
                    else showAlert("danger", "Ошибка сохранения настроек");
                });
            });
        });
    });

    // ── Snapshot settings save ────────────────────────────────────────────────
    document.getElementById("snap-remote-enabled").addEventListener("change", function() {
        toggleRemoteFields(this.checked);
    });

    document.getElementById("btn-save-snapshot").addEventListener("click", function() {
        requirePin("Сохранить настройки снапшотов", "Введите PIN для изменения настроек репликации.", function() {
            guardCmd("get_config", {}, function(err, resp) {
                if (err || !resp || !resp.ok) return;
                var cfg = resp.data;
                cfg.snapshot = {
                    enabled: true,
                    local:   document.getElementById("snap-local-enabled").checked,
                    remote: {
                        enabled: document.getElementById("snap-remote-enabled").checked,
                        host:    document.getElementById("snap-remote-host").value.trim(),
                        user:    document.getElementById("snap-remote-user").value.trim() || "rusnas",
                        path:    document.getElementById("snap-remote-path").value.trim() || "/mnt/backup_pool",
                        ssh_key: "/etc/rusnas-guard/replication_key"
                    }
                };
                guardCmd("set_config", { config: cfg }, function(e2, r2) {
                    if (!e2 && r2 && r2.ok) showAlert("info", "Настройки снапшотов сохранены");
                    else showAlert("danger", "Ошибка сохранения");
                });
            });
        });
    });

    // SSH key generation
    document.getElementById("btn-gen-ssh-key").addEventListener("click", function() {
        requirePin("Генерация SSH-ключа", "Введите PIN для генерации SSH-ключа репликации.", function() {
            guardCmd("generate_ssh_key", {}, function(err, resp) {
                if (!err && resp && resp.ok) {
                    document.getElementById("ssh-pubkey").value = resp.data.public_key || "";
                    document.getElementById("ssh-pubkey-block").classList.remove("hidden");
                } else {
                    showAlert("danger", "Ошибка генерации ключа");
                }
            });
        });
    });

    // ── Monitored paths ───────────────────────────────────────────────────────
    document.getElementById("btn-add-path").addEventListener("click", function() {
        document.getElementById("add-path-input").value = "";
        document.getElementById("available-paths-list").innerHTML =
            '<div class="text-muted" style="padding:8px 10px;font-size:13px;">Сканирование…</div>';
        showModal("add-path-modal");
        discoverAvailablePaths();
    });
    document.getElementById("btn-add-path-cancel").addEventListener("click", function() {
        closeModal("add-path-modal");
    });
    document.getElementById("btn-add-path-confirm").addEventListener("click", function() {
        var path = document.getElementById("add-path-input").value.trim();
        if (!path) return;
        requirePin("Добавить путь", "Введите PIN для добавления пути мониторинга.", function() {
            guardCmd("get_config", {}, function(err, resp) {
                if (err || !resp || !resp.ok) return;
                var cfg = resp.data;
                cfg.monitored_paths = cfg.monitored_paths || [];
                cfg.monitored_paths.push({
                    path: path, enabled: true,
                    honeypot: true, entropy: true, iops: true, extensions: true
                });
                guardCmd("set_config", { config: cfg }, function() {
                    closeModal("add-path-modal");
                    loadConfig();
                });
            });
        });
    });

    // ── Extensions list ───────────────────────────────────────────────────────
    document.getElementById("btn-view-extensions").addEventListener("click", function() {
        cockpit.file(EXTS_PATH).read().then(function(content) {
            document.getElementById("extensions-text").value = content || "";
        }).catch(function() {
            document.getElementById("extensions-text").value = "# Файл не найден";
        });
        showModal("extensions-modal");
    });

    document.getElementById("btn-extensions-close").addEventListener("click", function() {
        closeModal("extensions-modal");
    });

    document.getElementById("btn-extensions-save").addEventListener("click", function() {
        var content = document.getElementById("extensions-text").value;
        requirePin("Сохранить расширения", "Введите PIN для изменения списка расширений.", function() {
            cockpit.file(EXTS_PATH, { superuser: "require" }).replace(content).then(function() {
                showAlert("info", "Список расширений сохранён");
                closeModal("extensions-modal");
            }).catch(function() {
                showAlert("danger", "Ошибка сохранения списка расширений");
            });
        });
    });
});
