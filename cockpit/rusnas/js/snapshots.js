/* snapshots.js — rusNAS Btrfs Snapshot Manager UI */
(function () {
    "use strict";

    // ── State ─────────────────────────────────────────────────────────────────
    var currentSubvol  = null;
    var subvolList     = [];
    var schedulesData  = [];
    var pendingRestore = null;   // { id, snap_name }
    var browseSnapId   = null;
    var activeTab      = "snapshots";

    // ── Init ──────────────────────────────────────────────────────────────────
    document.addEventListener("DOMContentLoaded", function () {
        setupTabs();
        setupModals();
        setupButtons();
        loadSubvols();
        setInterval(function () {
            if (activeTab === "snapshots" && currentSubvol) loadSnapshots();
        }, 30000);
    });

    // ── Tabs ──────────────────────────────────────────────────────────────────
    function setupTabs() {
        document.querySelectorAll("#snap-tabs a").forEach(function (link) {
            link.addEventListener("click", function (e) {
                e.preventDefault();
                var tab = this.dataset.tab;
                activeTab = tab;
                document.querySelectorAll("#snap-tabs li").forEach(function (li) {
                    li.classList.remove("active");
                });
                this.parentElement.classList.add("active");
                document.querySelectorAll(".tab-content").forEach(function (div) {
                    div.style.display = "none";
                });
                document.getElementById("tab-" + tab).style.display = "";
                if (tab === "schedule")  renderSchedules();
                if (tab === "events")    loadEvents();
            });
        });
    }

    // ── Modals ────────────────────────────────────────────────────────────────
    function showModal(id) {
        document.getElementById(id).style.display = "flex";
    }
    function closeModal(id) {
        document.getElementById(id).style.display = "none";
    }

    function setupModals() {
        document.querySelectorAll("[data-close]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                closeModal(this.dataset.close);
            });
        });
        document.querySelectorAll(".modal-overlay").forEach(function (overlay) {
            overlay.addEventListener("click", function (e) {
                if (e.target === this) closeModal(this.id);
            });
        });
    }

    // ── Alert ─────────────────────────────────────────────────────────────────
    function showAlert(type, msg) {
        var el = document.getElementById("snap-alert");
        el.className = "alert alert-" + type;
        el.textContent = msg;
        el.style.display = "";
        clearTimeout(el._timer);
        el._timer = setTimeout(function () { el.style.display = "none"; }, 6000);
    }

    // ── runCmd ────────────────────────────────────────────────────────────────
    function runCmd(args) {
        return new Promise(function (resolve, reject) {
            // Use sudo -n (non-interactive): NOPASSWD sudoers rule must allow this.
            // Do NOT use err:"out" — log lines from stderr would corrupt the JSON stdout.
            var proc = cockpit.spawn(["sudo", "-n"].concat(args), { err: "message" });
            var output = "";
            proc.stream(function (data) { output += data; });
            proc.then(function () { resolve(output); }).catch(function (err) {
                reject((err && err.message) ? err.message : String(err));
            });
        });
    }

    // ── Subvol loading ────────────────────────────────────────────────────────
    function loadSubvols() {
        // Try scheduled subvols first; if none found, fall back to btrfs discovery
        runCmd(["rusnas-snap", "schedule", "list"])
            .then(function (out) {
                var data = safeJson(out);
                var paths = (data && data.schedules || []).map(function (s) { return s.subvol_path; });
                // If we have scheduled paths, use them directly — avoid sudo bash
                if (paths.length > 0) return paths;
                // No schedules yet — discover btrfs subvols (requires bash in sudoers)
                return findBtrfsSubvols();
            })
            .catch(function () { return findBtrfsSubvols(); })
            .then(function (paths) {
                subvolList = (paths || []).filter(Boolean);
                if (subvolList.length === 0) {
                    document.getElementById("snap-no-volumes").style.display = "";
                }
                populateSelects(subvolList);
                if (subvolList.length > 0) {
                    currentSubvol = subvolList[0];
                    loadSnapshots();
                }
                loadSchedulesData();
            });
    }

    function findBtrfsSubvols() {
        // List btrfs mounts, then list subvolumes on each
        return runCmd(["bash", "-c",
            "findmnt --real --noheadings -o TARGET -t btrfs 2>/dev/null || true"
        ]).then(function (out) {
            var mounts = out.trim().split("\n").filter(function (l) { return l.trim(); });
            if (!mounts.length) return [];
            // For each mount, list subvolumes
            var cmds = mounts.map(function (mp) {
                return "btrfs subvolume list -o '" + mp + "' 2>/dev/null | awk '{print \"" + mp + "/\" $NF}' | grep -v '\\.snapshots'";
            });
            return runCmd(["bash", "-c", cmds.join("; ")]).then(function (out2) {
                return out2.trim().split("\n").filter(function (l) { return l.trim() && l.startsWith("/"); });
            });
        }).catch(function () { return []; });
    }

    function populateSelects(paths) {
        ["snap-object-select", "modal-create-subvol", "modal-sched-subvol"].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.innerHTML = "";
            if (paths.length === 0) {
                var opt = document.createElement("option");
                opt.textContent = "Нет Btrfs субволюмов";
                el.appendChild(opt);
                return;
            }
            paths.forEach(function (p) {
                var opt = document.createElement("option");
                opt.value = p;
                opt.textContent = fmtSubvol(p);
                el.appendChild(opt);
            });
        });

        var mainSel = document.getElementById("snap-object-select");
        if (mainSel) {
            mainSel.addEventListener("change", function () {
                currentSubvol = this.value;
                loadSnapshots();
            });
        }
    }

    function fmtSubvol(path) {
        var name = path.split("/").filter(Boolean).pop();
        if (path.indexOf("/shares/") !== -1) return "📁 " + name + "  (" + path + ")";
        if (path.indexOf("/iscsi") !== -1)   return "💾 iSCSI: " + name;
        return "🗄 " + path;
    }

    // ── Snapshots tab ─────────────────────────────────────────────────────────
    function loadSnapshots() {
        if (!currentSubvol) return;
        runCmd(["rusnas-snap", "list", currentSubvol, "--json"])
            .then(function (out) {
                var data = safeJson(out);
                if (!data) { showAlert("danger", "Ошибка чтения снапшотов"); return; }
                renderSummary(data);
                renderTable(data.snapshots || []);
            })
            .catch(function (err) { showAlert("danger", "Ошибка: " + err); });
    }

    function renderSummary(data) {
        document.getElementById("sum-count").textContent = data.total_count || 0;
        document.getElementById("sum-size").textContent  = data.total_size_human || "—";
        var last = data.snapshots && data.snapshots[0];
        document.getElementById("sum-last").textContent = last ? fmtAge(last.created_at) : "—";
    }

    function renderTable(snaps) {
        var tbody = document.getElementById("snap-tbody");
        if (!snaps.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Снапшотов нет. Нажмите «+ Создать снапшот».</td></tr>';
            return;
        }
        tbody.innerHTML = snaps.map(function (s) {
            var typeBadge = {
                "manual":     "badge-info",
                "scheduled":  "badge-success",
                "pre_update": "badge-warning",
            }[s.snap_type] || "badge-default";
            return '<tr>' +
                '<td>' +
                    '<div class="snap-name">' + escHtml(s.snap_name) + '</div>' +
                    (s.label ? '<div class="snap-label">' + escHtml(s.label) + '</div>' : '') +
                '</td>' +
                '<td>' +
                    '<span class="badge ' + typeBadge + '">' + s.snap_type + '</span>' +
                    (s.locked ? ' <span class="badge badge-locked">🔒</span>' : '') +
                '</td>' +
                '<td>' + fmtDate(s.created_at) + '</td>' +
                '<td>' + (s.size_human || '—') + '</td>' +
                '<td class="snap-actions">' +
                    '<button class="btn btn-sm btn-default" data-action="browse" data-id="' + s.id + '">Просмотр</button> ' +
                    '<button class="btn btn-sm btn-default" data-action="restore" data-id="' + s.id + '" data-name="' + escHtml(s.snap_name) + '">Восстановить</button> ' +
                    '<button class="btn btn-sm btn-default" data-action="label" data-id="' + s.id + '" data-label="' + escHtml(s.label) + '">Метка</button> ' +
                    '<button class="btn btn-sm ' + (s.locked ? 'btn-warning' : 'btn-default') + '" data-action="lock" data-id="' + s.id + '" data-locked="' + (s.locked ? '1' : '0') + '">' +
                        (s.locked ? 'Разблокировать' : 'Заблокировать') +
                    '</button> ' +
                    '<button class="btn btn-sm btn-danger" data-action="delete" data-id="' + s.id + '" data-name="' + escHtml(s.snap_name) + '">Удалить</button>' +
                '</td>' +
            '</tr>';
        }).join("");

        // Delegate events on table
        tbody.querySelectorAll("button[data-action]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var action = this.dataset.action;
                var id     = this.dataset.id;
                if (action === "browse")  doBrowse(id);
                if (action === "restore") doRestoreConfirm(id, this.dataset.name);
                if (action === "label")   doLabel(id, this.dataset.label);
                if (action === "lock")    doLock(id, this.dataset.locked === "1");
                if (action === "delete")  doDelete(id, this.dataset.name);
            });
        });
    }

    // ── Snapshot actions ──────────────────────────────────────────────────────
    function doDelete(id, name) {
        if (!confirm("Удалить снапшот " + name + "?\n\nЭто действие необратимо.")) return;
        runCmd(["rusnas-snap", "delete", id])
            .then(function () { showAlert("info", "Снапшот удалён"); loadSnapshots(); })
            .catch(function (e) { showAlert("danger", "Ошибка удаления: " + e); });
    }

    function doRestoreConfirm(id, name) {
        pendingRestore = { id: id, snap_name: name };
        document.getElementById("restore-snap-name").textContent  = name;
        document.getElementById("restore-subvol-name").textContent = currentSubvol;
        showModal("modal-restore");
    }

    function doLabel(id, current) {
        var label = prompt("Метка снапшота:", current || "");
        if (label === null) return;
        runCmd(["rusnas-snap", "label", id, label])
            .then(function () { loadSnapshots(); })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    function doLock(id, isLocked) {
        var cmd = isLocked ? "unlock" : "lock";
        runCmd(["rusnas-snap", cmd, id])
            .then(function () { loadSnapshots(); })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    function doRestore() {
        if (!pendingRestore) return;
        closeModal("modal-restore");
        showAlert("info", "Восстановление запущено...");
        runCmd(["rusnas-snap", "restore", pendingRestore.id])
            .then(function () {
                showAlert("info", "✅ Восстановление завершено успешно");
                loadSnapshots();
            })
            .catch(function (e) { showAlert("danger", "Ошибка восстановления: " + e); });
        pendingRestore = null;
    }

    function doCreate() {
        var subvol = document.getElementById("modal-create-subvol").value;
        var label  = document.getElementById("modal-create-label").value.trim();
        if (!subvol) { showAlert("warning", "Выберите объект"); return; }
        var args = ["rusnas-snap", "create", subvol];
        if (label) { args.push("--label"); args.push(label); }
        closeModal("modal-create");
        showAlert("info", "Создание снапшота...");
        runCmd(args)
            .then(function () {
                document.getElementById("modal-create-label").value = "";
                showAlert("info", "✅ Снапшот создан");
                if (subvol === currentSubvol) loadSnapshots();
            })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    function doBrowse(id) {
        showAlert("info", "Монтирование снапшота...");
        runCmd(["rusnas-snap", "browse", id])
            .then(function (out) {
                var data = safeJson(out);
                if (!data) { showAlert("danger", "Ошибка парсинга ответа"); return; }
                browseSnapId = id;
                document.getElementById("browse-path").textContent = data.mount_path;
                showModal("modal-browse");
            })
            .catch(function (e) { showAlert("danger", "Ошибка монтирования: " + e); });
    }

    function doBrowseUmount() {
        if (!browseSnapId) return;
        runCmd(["rusnas-snap", "browse-umount", browseSnapId])
            .then(function () {
                closeModal("modal-browse");
                showAlert("info", "Снапшот размонтирован");
                browseSnapId = null;
            })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    // ── Schedule tab ──────────────────────────────────────────────────────────
    function loadSchedulesData() {
        runCmd(["rusnas-snap", "schedule", "list"])
            .then(function (out) {
                var data = safeJson(out);
                schedulesData = (data && data.schedules) || [];
            })
            .catch(function () { schedulesData = []; });
    }

    function renderSchedules() {
        loadSchedulesData();
        var el = document.getElementById("schedule-content");
        setTimeout(function () {
            if (!schedulesData.length) {
                el.innerHTML =
                    '<div class="card"><div class="card-body">' +
                    '<p style="color:var(--color-muted)">Расписания не настроены.</p>' +
                    '<button id="btn-add-schedule" class="btn btn-primary">+ Добавить расписание</button>' +
                    '</div></div>';
                var addBtn = document.getElementById("btn-add-schedule");
                if (addBtn) addBtn.addEventListener("click", openScheduleModal);
                return;
            }
            el.innerHTML = schedulesData.map(function (s) {
                return '<div class="card" style="margin-bottom:12px">' +
                    '<div class="card-header">' + fmtSubvol(s.subvol_path) + '</div>' +
                    '<div class="card-body">' +
                    '<table class="table table-condensed" style="margin-bottom:8px">' +
                    '<tr><td style="width:160px">Расписание</td><td><code>' + s.cron_expr + '</code> — ' + cronHuman(s.cron_expr) + '</td></tr>' +
                    '<tr><td>Последние</td><td>' + s.retention_last + ' снапшотов</td></tr>' +
                    '<tr><td>Hourly</td><td>' + s.retention_hourly + ' ч</td></tr>' +
                    '<tr><td>Daily</td><td>' + s.retention_daily + ' д</td></tr>' +
                    '<tr><td>Weekly</td><td>' + s.retention_weekly + ' нед</td></tr>' +
                    '<tr><td>Monthly</td><td>' + s.retention_monthly + ' мес</td></tr>' +
                    '<tr><td>Активно</td><td>' + (s.enabled ? '✅ Да' : '❌ Нет') + '</td></tr>' +
                    '</table>' +
                    '<button class="btn btn-sm btn-default sched-edit" data-path="' + s.subvol_path + '">Изменить</button> ' +
                    '<button class="btn btn-sm ' + (s.enabled ? 'btn-warning' : 'btn-success') + ' sched-toggle" data-path="' + s.subvol_path + '" data-enabled="' + s.enabled + '">' +
                    (s.enabled ? 'Отключить' : 'Включить') + '</button> ' +
                    '<button class="btn btn-sm btn-default sched-run-now" data-path="' + s.subvol_path + '">Запустить сейчас</button>' +
                    '</div></div>';
            }).join("") +
                '<button id="btn-add-schedule" class="btn btn-primary" style="margin-top:8px">+ Добавить расписание</button>';

            el.querySelectorAll(".sched-edit").forEach(function (b) {
                b.addEventListener("click", function () { openScheduleModal(this.dataset.path); });
            });
            el.querySelectorAll(".sched-toggle").forEach(function (b) {
                b.addEventListener("click", function () { toggleSchedule(this.dataset.path, parseInt(this.dataset.enabled)); });
            });
            el.querySelectorAll(".sched-run-now").forEach(function (b) {
                b.addEventListener("click", function () { runRetentionNow(this.dataset.path); });
            });
            var addBtn = document.getElementById("btn-add-schedule");
            if (addBtn) addBtn.addEventListener("click", function () { openScheduleModal(); });
        }, 300);
    }

    function openScheduleModal(subvolPath) {
        document.getElementById("modal-schedule-title").textContent =
            subvolPath ? "Изменить расписание" : "Добавить расписание";

        // Populate subvol select
        var sel = document.getElementById("modal-sched-subvol");
        if (subvolPath) {
            sel.value = subvolPath;
            sel.disabled = true;
        } else {
            sel.disabled = false;
        }

        // Fill fields from existing schedule
        var existing = schedulesData.find(function (s) { return s.subvol_path === subvolPath; });
        document.getElementById("modal-sched-cron").value    = existing ? existing.cron_expr         : "0 0 * * *";
        document.getElementById("sched-ret-last").value      = existing ? existing.retention_last     : 10;
        document.getElementById("sched-ret-hourly").value    = existing ? existing.retention_hourly   : 24;
        document.getElementById("sched-ret-daily").value     = existing ? existing.retention_daily    : 14;
        document.getElementById("sched-ret-weekly").value    = existing ? existing.retention_weekly   : 8;
        document.getElementById("sched-ret-monthly").value   = existing ? existing.retention_monthly  : 6;

        showModal("modal-schedule");
    }

    function saveSchedule() {
        var subvol = document.getElementById("modal-sched-subvol").value;
        var cron   = document.getElementById("modal-sched-cron").value.trim();
        if (!subvol || !cron) { showAlert("warning", "Заполните все поля"); return; }
        var args = [
            "rusnas-snap", "schedule", "set", subvol,
            "--cron", cron,
            "--retention-last",    document.getElementById("sched-ret-last").value,
            "--retention-hourly",  document.getElementById("sched-ret-hourly").value,
            "--retention-daily",   document.getElementById("sched-ret-daily").value,
            "--retention-weekly",  document.getElementById("sched-ret-weekly").value,
            "--retention-monthly", document.getElementById("sched-ret-monthly").value,
        ];
        runCmd(args)
            .then(function () {
                closeModal("modal-schedule");
                showAlert("info", "✅ Расписание сохранено");
                loadSchedulesData();
                renderSchedules();
            })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    function toggleSchedule(subvolPath, isEnabled) {
        var existing = schedulesData.find(function (s) { return s.subvol_path === subvolPath; });
        if (!existing) return;
        var args = [
            "rusnas-snap", "schedule", "set", subvolPath,
            "--cron", existing.cron_expr,
            "--retention-last",    String(existing.retention_last),
            "--retention-hourly",  String(existing.retention_hourly),
            "--retention-daily",   String(existing.retention_daily),
            "--retention-weekly",  String(existing.retention_weekly),
            "--retention-monthly", String(existing.retention_monthly),
        ];
        if (isEnabled) args.push("--disabled");
        runCmd(args)
            .then(function () { loadSchedulesData(); renderSchedules(); })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    function runRetentionNow(subvolPath) {
        showAlert("info", "Применение retention...");
        runCmd(["rusnas-snap", "retention", subvolPath])
            .then(function (out) {
                var data = safeJson(out);
                var del = data && data.deleted ? data.deleted.length : 0;
                showAlert("info", "✅ Retention выполнен, удалено: " + del);
                loadSnapshots();
            })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    // ── Events tab ────────────────────────────────────────────────────────────
    function loadEvents() {
        runCmd(["rusnas-snap", "events", "--limit", "50"])
            .then(function (out) {
                var data = safeJson(out);
                var events = (data && data.events) || [];
                var tbody = document.getElementById("events-tbody");
                if (!events.length) {
                    tbody.innerHTML = '<tr><td colspan="4" class="table-empty">Событий нет.</td></tr>';
                    return;
                }
                var typeClass = { created: "badge-success", deleted: "badge-warning", restored: "badge-info", error: "badge-danger" };
                tbody.innerHTML = events.map(function (ev) {
                    return '<tr>' +
                        '<td>' + fmtDate(ev.created_at) + '</td>' +
                        '<td><span class="badge ' + (typeClass[ev.event_type] || "badge-default") + '">' + ev.event_type + '</span></td>' +
                        '<td style="font-size:12px">' + escHtml(ev.subvol_path || "—") + '</td>' +
                        '<td>' + escHtml(ev.message || "") + '</td>' +
                    '</tr>';
                }).join("");
            })
            .catch(function (e) {
                document.getElementById("events-tbody").innerHTML =
                    '<tr><td colspan="4" class="table-empty">Ошибка: ' + escHtml(e) + '</td></tr>';
            });
    }

    // ── Button wiring ─────────────────────────────────────────────────────────
    function setupButtons() {
        document.getElementById("btn-create-snap").addEventListener("click", function () {
            var sel = document.getElementById("modal-create-subvol");
            if (sel && currentSubvol) sel.value = currentSubvol;
            showModal("modal-create");
        });

        document.getElementById("btn-refresh").addEventListener("click", function () {
            if (activeTab === "snapshots") loadSnapshots();
            if (activeTab === "schedule")  renderSchedules();
            if (activeTab === "events")    loadEvents();
        });

        document.getElementById("modal-create-confirm").addEventListener("click", doCreate);
        document.getElementById("modal-restore-confirm").addEventListener("click", doRestore);
        document.getElementById("modal-sched-save").addEventListener("click", saveSchedule);
        document.getElementById("browse-umount-btn").addEventListener("click", doBrowseUmount);

        // Cron presets
        document.querySelectorAll(".cron-preset").forEach(function (btn) {
            btn.addEventListener("click", function () {
                document.getElementById("modal-sched-cron").value = this.dataset.cron;
            });
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function safeJson(str) {
        // Output from rusnas-snap is clean JSON (stderr is separate via err:"message").
        // Just parse the full string directly.
        try {
            return JSON.parse(str);
        } catch (e) {
            // Fallback: find the first '{' and parse from there (handles rare log prefix)
            var idx = str.indexOf("{");
            if (idx !== -1) {
                try { return JSON.parse(str.slice(idx)); } catch (e2) {}
            }
            return null;
        }
    }

    function fmtDate(isoStr) {
        if (!isoStr) return "—";
        try {
            var d = new Date(isoStr);
            return d.toLocaleString("ru-RU", {
                day: "2-digit", month: "short", year: "numeric",
                hour: "2-digit", minute: "2-digit"
            });
        } catch (e) { return isoStr; }
    }

    function fmtAge(isoStr) {
        if (!isoStr) return "—";
        try {
            var diff = Date.now() - new Date(isoStr).getTime();
            var h = Math.floor(diff / 3600000);
            if (h < 1)  return "только что";
            if (h < 24) return h + "ч назад";
            return Math.floor(h / 24) + "д назад";
        } catch (e) { return isoStr; }
    }

    function cronHuman(expr) {
        var map = {
            "0 * * * *": "каждый час",
            "0 0 * * *": "каждый день в 00:00",
            "0 0 * * 0": "каждую неделю (вс 00:00)",
            "0 0 1 * *": "каждый месяц (1-е)"
        };
        return map[expr] || expr;
    }

    function escHtml(s) {
        return String(s || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

})();
