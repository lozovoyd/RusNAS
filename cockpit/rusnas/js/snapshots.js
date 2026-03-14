/* snapshots.js — rusNAS Btrfs Snapshot Manager UI */
(function () {
    "use strict";

    // ── State ─────────────────────────────────────────────────────────────────
    var currentSubvol  = null;
    var subvolList     = [];
    var schedulesData  = [];
    var pendingRestore = null;   // { id, snap_name }
    var pendingDelete  = null;   // { id, snap_name }
    var pendingLabel   = null;   // { id }
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
        document.querySelectorAll(".advisor-tab-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var tab = this.dataset.tab;
                activeTab = tab;
                document.querySelectorAll(".advisor-tab-btn").forEach(function (b) {
                    b.classList.remove("active");
                });
                this.classList.add("active");
                ["snapshots", "schedule", "events"].forEach(function (t) {
                    var el = document.getElementById("tab-" + t);
                    if (el) el.classList.toggle("hidden", t !== tab);
                });
                if (tab === "schedule") renderSchedules();
                if (tab === "events")   loadEvents();
            });
        });
    }

    // ── Modals ────────────────────────────────────────────────────────────────
    function showModal(id) {
        document.getElementById(id).classList.remove("hidden");
    }
    function closeModal(id) {
        document.getElementById(id).classList.add("hidden");
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
        el.classList.remove("hidden");
        clearTimeout(el._timer);
        el._timer = setTimeout(function () { el.classList.add("hidden"); }, 6000);
    }

    // ── runCmd ────────────────────────────────────────────────────────────────
    function runCmd(args) {
        return new Promise(function (resolve, reject) {
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
        runCmd(["rusnas-snap", "schedule", "list"])
            .then(function (out) {
                var data = safeJson(out);
                var paths = (data && data.schedules || []).map(function (s) { return s.subvol_path; });
                if (paths.length > 0) return paths;
                return findBtrfsSubvols();
            })
            .catch(function () { return findBtrfsSubvols(); })
            .then(function (paths) {
                subvolList = (paths || []).filter(Boolean);
                if (subvolList.length === 0) {
                    document.getElementById("snap-no-volumes").classList.remove("hidden");
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
        return runCmd(["bash", "-c",
            "findmnt --real --noheadings -o TARGET -t btrfs 2>/dev/null || true"
        ]).then(function (out) {
            var mounts = out.trim().split("\n").filter(function (l) { return l.trim(); });
            if (!mounts.length) return [];
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
        runCmd(["rusnas-snap", "list", currentSubvol])
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
            tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px">Снапшотов нет. Нажмите «+ Создать снапшот».</td></tr>';
            return;
        }
        var typeMap = { "manual": "badge-info", "scheduled": "badge-success", "pre_update": "badge-warning" };
        tbody.innerHTML = snaps.map(function (s) {
            var typeCls = typeMap[s.snap_type] || "badge-secondary";
            return '<tr>' +
                '<td>' +
                    '<div style="font-weight:600;font-size:13px">' + escHtml(s.snap_name) + '</div>' +
                    (s.label ? '<div class="text-muted" style="font-size:12px;margin-top:2px">' + escHtml(s.label) + '</div>' : '') +
                '</td>' +
                '<td>' +
                    '<span class="badge ' + typeCls + '">' + escHtml(s.snap_type) + '</span>' +
                    (s.locked ? ' <span class="badge badge-warning">🔒</span>' : '') +
                '</td>' +
                '<td style="font-size:12px;white-space:nowrap">' + fmtDate(s.created_at) + '</td>' +
                '<td style="font-size:12px;white-space:nowrap">' + escHtml(s.size_human || '—') + '</td>' +
                '<td>' +
                    '<div class="btn-group">' +
                    '<button class="btn btn-secondary btn-sm" data-action="browse"   data-id="' + s.id + '">Просмотр</button>' +
                    '<button class="btn btn-secondary btn-sm" data-action="restore"  data-id="' + s.id + '" data-name="' + escHtml(s.snap_name) + '">Восстановить</button>' +
                    '<button class="btn btn-default   btn-sm" data-action="label"    data-id="' + s.id + '" data-label="' + escHtml(s.label || '') + '">Метка</button>' +
                    '<button class="btn btn-' + (s.locked ? 'warning' : 'default') + ' btn-sm" data-action="lock" data-id="' + s.id + '" data-locked="' + (s.locked ? '1' : '0') + '">' +
                        (s.locked ? 'Разблокировать' : 'Заблокировать') +
                    '</button>' +
                    '<button class="btn btn-danger btn-sm" data-action="delete" data-id="' + s.id + '" data-name="' + escHtml(s.snap_name) + '">Удалить</button>' +
                    '</div>' +
                '</td>' +
            '</tr>';
        }).join("");

        tbody.querySelectorAll("button[data-action]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var action = this.dataset.action;
                var id     = this.dataset.id;
                if (action === "browse")  doBrowse(id);
                if (action === "restore") doRestoreConfirm(id, this.dataset.name);
                if (action === "label")   doLabelModal(id, this.dataset.label);
                if (action === "lock")    doLock(id, this.dataset.locked === "1");
                if (action === "delete")  doDeleteConfirm(id, this.dataset.name);
            });
        });
    }

    // ── Snapshot actions ──────────────────────────────────────────────────────
    function doDeleteConfirm(id, name) {
        pendingDelete = { id: id, snap_name: name };
        document.getElementById("delete-snap-name").textContent = name;
        showModal("modal-delete");
    }

    function doDeleteExec() {
        if (!pendingDelete) return;
        closeModal("modal-delete");
        runCmd(["rusnas-snap", "delete", pendingDelete.id])
            .then(function () { showAlert("info", "✅ Снапшот удалён"); loadSnapshots(); })
            .catch(function (e) { showAlert("danger", "Ошибка удаления: " + e); });
        pendingDelete = null;
    }

    function doRestoreConfirm(id, name) {
        pendingRestore = { id: id, snap_name: name };
        document.getElementById("restore-snap-name").textContent  = name;
        document.getElementById("restore-subvol-name").textContent = currentSubvol;
        showModal("modal-restore");
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

    function doLabelModal(id, current) {
        pendingLabel = { id: id };
        document.getElementById("modal-label-input").value = current || "";
        showModal("modal-label");
        setTimeout(function () { document.getElementById("modal-label-input").focus(); }, 50);
    }

    function doLabelSave() {
        if (!pendingLabel) return;
        var label = document.getElementById("modal-label-input").value.trim();
        closeModal("modal-label");
        runCmd(["rusnas-snap", "label", pendingLabel.id, label])
            .then(function () { loadSnapshots(); })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
        pendingLabel = null;
    }

    function doLock(id, isLocked) {
        var cmd = isLocked ? "unlock" : "lock";
        runCmd(["rusnas-snap", cmd, id])
            .then(function () { loadSnapshots(); })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
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
                showAlert("info", "✅ Снапшот размонтирован");
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
                    '<div class="section">' +
                    '<p class="text-muted">Расписания не настроены.</p>' +
                    '<button id="btn-add-schedule" class="btn btn-primary">+ Добавить расписание</button>' +
                    '</div>';
                var addBtn = document.getElementById("btn-add-schedule");
                if (addBtn) addBtn.addEventListener("click", function () { openScheduleModal(); });
                return;
            }
            el.innerHTML = schedulesData.map(function (s) {
                return '<div class="section" style="margin-bottom:12px">' +
                    '<div class="section-toolbar">' +
                    '<h2 style="margin:0;border:none;padding:0">' + fmtSubvol(s.subvol_path) + '</h2>' +
                    '<div class="btn-group">' +
                    '<button class="btn btn-secondary btn-sm sched-edit" data-path="' + escHtml(s.subvol_path) + '">Изменить</button>' +
                    '<button class="btn btn-' + (s.enabled ? 'warning' : 'success') + ' btn-sm sched-toggle" data-path="' + escHtml(s.subvol_path) + '" data-enabled="' + (s.enabled ? '1' : '0') + '">' +
                        (s.enabled ? 'Отключить' : 'Включить') +
                    '</button>' +
                    '<button class="btn btn-default btn-sm sched-run-now" data-path="' + escHtml(s.subvol_path) + '">▶ Запустить сейчас</button>' +
                    '</div>' +
                    '</div>' +
                    '<table style="margin-top:10px">' +
                    '<tbody>' +
                    '<tr><td style="width:160px;color:var(--color-muted)">Расписание</td><td><code>' + escHtml(s.cron_expr) + '</code> — ' + cronHuman(s.cron_expr) + '</td></tr>' +
                    '<tr><td style="color:var(--color-muted)">Последние</td><td>' + s.retention_last + ' снапшотов</td></tr>' +
                    '<tr><td style="color:var(--color-muted)">Hourly</td><td>' + s.retention_hourly + ' ч</td></tr>' +
                    '<tr><td style="color:var(--color-muted)">Daily</td><td>' + s.retention_daily + ' д</td></tr>' +
                    '<tr><td style="color:var(--color-muted)">Weekly</td><td>' + s.retention_weekly + ' нед</td></tr>' +
                    '<tr><td style="color:var(--color-muted)">Monthly</td><td>' + s.retention_monthly + ' мес</td></tr>' +
                    '<tr><td style="color:var(--color-muted)">Активно</td><td>' +
                        (s.enabled ? '<span class="status-active">✅ Да</span>' : '<span class="status-inactive">❌ Нет</span>') +
                    '</td></tr>' +
                    '</tbody></table>' +
                    '</div>';
            }).join("") +
            '<button id="btn-add-schedule" class="btn btn-primary" style="margin-top:4px">+ Добавить расписание</button>';

            el.querySelectorAll(".sched-edit").forEach(function (b) {
                b.addEventListener("click", function () { openScheduleModal(this.dataset.path); });
            });
            el.querySelectorAll(".sched-toggle").forEach(function (b) {
                b.addEventListener("click", function () { toggleSchedule(this.dataset.path, this.dataset.enabled === "1"); });
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

        var sel = document.getElementById("modal-sched-subvol");
        if (subvolPath) {
            sel.value = subvolPath;
            sel.disabled = true;
        } else {
            sel.disabled = false;
        }

        var existing = schedulesData.filter(function (s) { return s.subvol_path === subvolPath; })[0];
        document.getElementById("modal-sched-cron").value      = existing ? existing.cron_expr          : "0 0 * * *";
        document.getElementById("sched-ret-last").value        = existing ? existing.retention_last      : 10;
        document.getElementById("sched-ret-hourly").value      = existing ? existing.retention_hourly    : 24;
        document.getElementById("sched-ret-daily").value       = existing ? existing.retention_daily     : 14;
        document.getElementById("sched-ret-weekly").value      = existing ? existing.retention_weekly    : 8;
        document.getElementById("sched-ret-monthly").value     = existing ? existing.retention_monthly   : 6;

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
                if (activeTab === "schedule") renderSchedules();
            })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    function toggleSchedule(subvolPath, isEnabled) {
        var existing = schedulesData.filter(function (s) { return s.subvol_path === subvolPath; })[0];
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
            .then(function () { loadSchedulesData(); if (activeTab === "schedule") renderSchedules(); })
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
                    tbody.innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:20px">Событий нет.</td></tr>';
                    return;
                }
                var typeClass = { created: "badge-success", deleted: "badge-warning", restored: "badge-info", error: "badge-danger" };
                tbody.innerHTML = events.map(function (ev) {
                    return '<tr>' +
                        '<td style="font-size:12px;white-space:nowrap">' + fmtDate(ev.created_at) + '</td>' +
                        '<td><span class="badge ' + (typeClass[ev.event_type] || "badge-secondary") + '">' + escHtml(ev.event_type) + '</span></td>' +
                        '<td style="font-size:12px">' + escHtml(ev.subvol_path || "—") + '</td>' +
                        '<td style="font-size:13px">' + escHtml(ev.message || "") + '</td>' +
                    '</tr>';
                }).join("");
            })
            .catch(function (e) {
                document.getElementById("events-tbody").innerHTML =
                    '<tr><td colspan="4" class="text-danger">Ошибка: ' + escHtml(e) + '</td></tr>';
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
        document.getElementById("modal-label-confirm").addEventListener("click", doLabelSave);
        document.getElementById("modal-delete-confirm").addEventListener("click", doDeleteExec);
        document.getElementById("modal-sched-save").addEventListener("click", saveSchedule);
        document.getElementById("browse-umount-btn").addEventListener("click", doBrowseUmount);

        // Enter key in label modal
        document.getElementById("modal-label-input").addEventListener("keydown", function (e) {
            if (e.key === "Enter") doLabelSave();
        });

        // Cron presets
        document.querySelectorAll(".cron-preset").forEach(function (btn) {
            btn.addEventListener("click", function () {
                document.getElementById("modal-sched-cron").value = this.dataset.cron;
            });
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function safeJson(str) {
        try {
            return JSON.parse(str);
        } catch (e) {
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
