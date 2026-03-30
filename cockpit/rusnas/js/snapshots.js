/* snapshots.js — rusNAS Btrfs Snapshot Manager UI */
(function () {
    "use strict";

    // ── State ─────────────────────────────────────────────────────────────────
    var currentSubvol      = null;
    var subvolList         = [];   // flat list for backward compat (modals etc.)
    var subvolGroups       = [];   // [{mountPoint: str, subvols: [str]}]
    var schedulesData      = [];
    var replicationsData   = [];
    var pendingRestore     = null;   // { id, snap_name }
    var pendingDelete      = null;   // { id, snap_name }
    var pendingLabel       = null;   // { id }
    var browseSnapId       = null;
    var activeTab          = "snapshots";
    var editingReplSubvol  = null;   // subvol_path being edited in replication modal
    var _snapRefreshTimer  = null;   // stored so it can be cleared

    // ── Init ──────────────────────────────────────────────────────────────────
    document.addEventListener("DOMContentLoaded", function () {
        setupTabs();
        setupModals();
        setupButtons();
        loadSubvols();
        _snapRefreshTimer = setInterval(function () {
            if (activeTab === "snapshots" && currentSubvol) loadSnapshots();
        }, 30000);
    });

    // ── Tabs ──────────────────────────────────────────────────────────────────
    /**
     * Initialize tab switching for Snapshots/Schedule/Replication/Events.
     * @returns {void}
     */
    function setupTabs() {
        document.querySelectorAll(".advisor-tab-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var tab = this.dataset.tab;
                activeTab = tab;
                document.querySelectorAll(".advisor-tab-btn").forEach(function (b) {
                    b.classList.remove("active");
                });
                this.classList.add("active");
                ["snapshots", "schedule", "replication", "events", "guide"].forEach(function (t) {
                    var el = document.getElementById("tab-" + t);
                    if (el) el.classList.toggle("hidden", t !== tab);
                });
                if (tab === "schedule")    renderSchedules();
                if (tab === "replication") renderReplications();
                if (tab === "events")      loadEvents();
            });
        });
    }

    // ── Modals ────────────────────────────────────────────────────────────────
    /**
     * Show a modal dialog by removing the 'hidden' class.
     * @param {string} id - DOM element ID of the modal
     * @returns {void}
     */
    function showModal(id) {
        document.getElementById(id).classList.remove("hidden");
    }
    /**
     * Hide a modal dialog by adding the 'hidden' class.
     * @param {string} id - DOM element ID of the modal
     * @returns {void}
     */
    function closeModal(id) {
        document.getElementById(id).classList.add("hidden");
    }

    /**
     * Wire up modal close buttons and overlay click-to-dismiss.
     * @returns {void}
     */
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
    /**
     * Display a temporary alert banner with auto-hide.
     * @param {string} type - Alert type (success|warning|danger)
     * @param {string} msg - Alert message text
     * @returns {void}
     */
    function showAlert(type, msg) {
        var el = document.getElementById("snap-alert");
        el.className = "alert alert-" + type;
        el.textContent = msg;
        el.classList.remove("hidden");
        clearTimeout(el._timer);
        el._timer = setTimeout(function () { el.classList.add("hidden"); }, 6000);
    }

    /**
     * Hide the currently displayed alert banner.
     * @returns {void}
     */
    function hideAlert() {
        var el = document.getElementById("snap-alert");
        clearTimeout(el._timer);
        el.classList.add("hidden");
    }

    // ── runCmd ────────────────────────────────────────────────────────────────
    /**
     * Execute a rusnas-snap CLI command and return stdout.
     * @param {Array<string>} args - CLI arguments for rusnas-snap
     * @returns {Promise<string>}
     */
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

    /**
     * Check if a Btrfs subvolume path is currently offline/unmounted.
     * @param {string} path - Subvolume path to check
     * @returns {boolean}
     */
    function isSubvolOffline(path) {
        for (var i = 0; i < subvolGroups.length; i++) {
            if (subvolGroups[i].offline && subvolGroups[i].subvols.indexOf(path) !== -1) return true;
        }
        return false;
    }

    // ── Subvol loading ────────────────────────────────────────────────────────

    // Returns [{mountPoint: str, subvols: [str], offline: bool}] grouped by Btrfs mount point
    /**
     * Discover all Btrfs subvolumes across mounted filesystems.
     * @returns {Promise<Array<Object>>}
     */
    function findBtrfsSubvols() {
        return new Promise(function (resolve) {
            cockpit.spawn(
                ["findmnt", "--real", "--noheadings", "-o", "TARGET", "-t", "btrfs"],
                { err: "message" }
            ).then(function (out) {
                var mounts = out.trim().split("\n")
                    .map(function (l) { return l.trim().replace(/\/$/, ""); })
                    .filter(function (mp) {
                        // exclude snapshot browse mounts
                        return mp && mp.indexOf("/mnt/rusnas-browse") !== 0;
                    });
                if (!mounts.length) { resolve([]); return; }
                var promises = mounts.map(function (mp) {
                    return new Promise(function (res) {
                        cockpit.spawn(
                            ["btrfs", "subvolume", "list", "-o", mp],
                            { superuser: "require", err: "message" }
                        ).then(function (svOut) {
                            var subvols = svOut.trim().split("\n").filter(Boolean)
                                .map(function (line) { return mp + "/" + line.split(" ").pop(); })
                                .filter(function (p) { return p.indexOf(".snapshots") === -1; });
                            res({ mountPoint: mp, subvols: subvols, offline: false });
                        }).catch(function () { res({ mountPoint: mp, subvols: [], offline: false }); });
                    });
                });
                Promise.all(promises).then(function (results) {
                    resolve(results.filter(function (g) { return g.subvols.length > 0; }));
                });
            }).catch(function () { resolve([]); });
        });
    }

    // Infer a "virtual mount point" from an absolute path (/mnt/foo/... → /mnt/foo)
    /**
     * Infer the mount point from a full subvolume path.
     * @param {string} path - Full subvolume path
     * @returns {string}
     */
    function inferMountPoint(path) {
        var parts = path.split("/").filter(Boolean);
        return "/" + parts.slice(0, 2).join("/");
    }

    /**
     * Load subvolume list from schedules and live filesystem discovery.
     * @returns {void}
     */
    function loadSubvols() {
        var schedPromise = runCmd(["rusnas-snap", "schedule", "list"])
            .then(function (out) {
                var data = safeJson(out);
                return (data && data.schedules || []).map(function (s) { return s.subvol_path; });
            })
            .catch(function () { return []; });

        var livePromise = findBtrfsSubvols();  // [{mountPoint, subvols}]

        Promise.all([schedPromise, livePromise]).then(function (results) {
            var schedPaths = results[0];
            var groups     = results[1].slice();  // [{mountPoint, subvols}]

            // Build set of already-known paths
            var known = {};
            groups.forEach(function (g) {
                g.subvols.forEach(function (p) { known[p] = true; });
            });

            // Assign schedule-only paths to their group (by mountPoint prefix),
            // or create offline groups grouped by inferred mount point
            schedPaths.forEach(function (p) {
                if (known[p]) return;
                var placed = false;
                for (var i = 0; i < groups.length; i++) {
                    if (p.indexOf(groups[i].mountPoint + "/") === 0) {
                        groups[i].subvols.push(p);
                        known[p] = true;
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    // Group offline paths by inferred mount point (/mnt/foo/... → /mnt/foo)
                    var inferredMp = inferMountPoint(p);
                    var offlineGroup = null;
                    for (var j = 0; j < groups.length; j++) {
                        if (groups[j].mountPoint === inferredMp && groups[j].offline) {
                            offlineGroup = groups[j];
                            break;
                        }
                    }
                    if (!offlineGroup) {
                        offlineGroup = { mountPoint: inferredMp, subvols: [], offline: true };
                        groups.push(offlineGroup);
                    }
                    offlineGroup.subvols.push(p);
                    known[p] = true;
                }
            });

            subvolGroups = groups.filter(function (g) { return g.subvols.length > 0; });
            subvolList = [];
            subvolGroups.forEach(function (g) { g.subvols.forEach(function (p) { subvolList.push(p); }); });

            if (subvolList.length === 0) {
                document.getElementById("snap-no-volumes").classList.remove("hidden");
            }
            populateSelects(subvolList);
            if (subvolList.length > 0) {
                currentSubvol = subvolList[0];
                updateCurrentTitle();
                loadSnapshots();
            }
            loadSchedulesData();
            loadStorageInfo();
        });
    }

    /**
     * Load storage statistics for all known subvolumes.
     * @returns {void}
     */
    function loadStorageInfo() {
        var totalSubvolsEl = document.getElementById("total-subvols-all");
        if (totalSubvolsEl) totalSubvolsEl.textContent = subvolList.length;

        runCmd(["rusnas-snap", "storage-info"])
            .then(function (out) {
                var data = safeJson(out);
                var statsMap = {};
                if (data) {
                    (data.subvols || []).forEach(function (s) { statsMap[s.subvol_path] = s; });
                    var tcEl = document.getElementById("total-count-all");
                    var tsEl = document.getElementById("total-size-all");
                    if (tcEl) tcEl.textContent = data.total_count || 0;
                    if (tsEl) tsEl.textContent = data.total_size_human || "0 Б";
                }
                renderSidebar(statsMap);
            })
            .catch(function () { renderSidebar({}); });
    }

    // ── Sidebar tree ──────────────────────────────────────────────────────────

    // Build a path tree from a flat list of absolute paths under mountPoint
    /**
     * Build a tree structure from flat subvolume paths.
     * @param {string} mountPoint - Root mount point
     * @param {Array<string>} paths - Array of subvolume paths
     * @returns {Object}
     */
    function buildPathTree(mountPoint, paths) {
        var root = { name: "", fullPath: null, children: [] };
        paths.forEach(function (path) {
            var prefix = mountPoint === "__orphan__" ? "" : mountPoint;
            var rel    = prefix ? path.slice(prefix.length).replace(/^\//, "") : path;
            var parts  = rel.split("/").filter(Boolean);
            var cur    = root;
            for (var i = 0; i < parts.length; i++) {
                var seg  = parts[i];
                var node = null;
                for (var j = 0; j < cur.children.length; j++) {
                    if (cur.children[j].name === seg) { node = cur.children[j]; break; }
                }
                if (!node) {
                    node = { name: seg, fullPath: null, children: [] };
                    cur.children.push(node);
                }
                if (i === parts.length - 1) node.fullPath = path;
                cur = node;
            }
        });
        return root;
    }

    /**
     * Render the subvolume tree sidebar with usage stats.
     * @param {Object} statsMap - Map of path to storage stats
     * @returns {void}
     */
    function renderSidebar(statsMap) {
        var list = document.getElementById("snap-sidebar-list");
        if (!list) return;
        if (!subvolList.length) {
            list.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--color-muted)">Нет субволюмов</div>';
            return;
        }

        var html = "";
        subvolGroups.forEach(function (group) {
            var mpName = group.mountPoint.split("/").filter(Boolean).pop();
            var icon = group.offline ? "📎" : "🖴";
            var label = escHtml(mpName) + (group.offline
                ? ' <span style="font-weight:400;opacity:0.6">(офлайн)</span>' : "");
            html += '<div class="snap-tree-group">' + icon + ' ' + label + '</div>';
            var tree = buildPathTree(group.mountPoint, group.subvols);
            tree.children.forEach(function (child) {
                html += renderTreeNodeHtml(child, statsMap, 0);
            });
        });
        list.innerHTML = html;

        // Click: select subvolume
        list.querySelectorAll(".snap-tree-real").forEach(function (el) {
            el.addEventListener("click", function () {
                currentSubvol = this.dataset.path;
                list.querySelectorAll(".snap-tree-real").forEach(function (n) { n.classList.remove("active"); });
                this.classList.add("active");
                updateCurrentTitle();
                if (activeTab === "snapshots")    loadSnapshots();
                if (activeTab === "schedule")     renderSchedules();
                if (activeTab === "replication")  renderReplications();
                if (activeTab === "events")       loadEvents();
            });
        });

        // Click: expand/collapse toggle
        list.querySelectorAll(".snap-tree-toggle").forEach(function (btn) {
            btn.addEventListener("click", function (e) {
                e.stopPropagation();
                var nodeEl    = this.closest(".snap-tree-node");
                var childrenEl = nodeEl ? nodeEl.nextElementSibling : null;
                if (childrenEl && childrenEl.classList.contains("snap-tree-children")) {
                    var collapsed = childrenEl.style.display === "none";
                    childrenEl.style.display = collapsed ? "" : "none";
                    this.textContent = collapsed ? "▼" : "▶";
                }
            });
        });
    }

    /**
     * Recursively render tree node HTML for sidebar.
     * @param {Object} node - Tree node object
     * @param {Object} statsMap - Storage stats map
     * @param {number} depth - Current nesting depth
     * @returns {string}
     */
    function renderTreeNodeHtml(node, statsMap, depth) {
        var isReal      = !!node.fullPath;
        var hasChildren = node.children.length > 0;
        var isActive    = node.fullPath === currentSubvol;
        var stats       = isReal ? (statsMap[node.fullPath] || { count: 0, size_human: "" }) : null;
        var indent      = 10 + depth * 14;

        var metaStr = "";
        if (stats) {
            metaStr = stats.count > 0
                ? stats.count + " снапш." + (stats.size_human ? " · " + stats.size_human : "")
                : "нет снапшотов";
        }

        var cls = "snap-tree-node" +
            (isReal ? " snap-tree-real" : " snap-tree-virtual") +
            (isActive ? " active" : "");
        var pathAttr = isReal ? ' data-path="' + escHtml(node.fullPath) + '"' : "";

        var html = '<div class="' + cls + '"' + pathAttr +
            ' style="padding-left:' + indent + 'px">';
        html += hasChildren
            ? '<span class="snap-tree-toggle">▼</span>'
            : '<span class="snap-tree-spacer"></span>';
        html += '<span class="snap-tree-icon">' + (isReal ? "📁" : "📂") + '</span>';
        html += '<div class="snap-tree-info">';
        html += '<div class="snap-tree-name">' + escHtml(node.name) +
            (hasChildren && !isReal ? "/" : "") + '</div>';
        if (metaStr) html += '<div class="snap-sidebar-meta">' + escHtml(metaStr) + '</div>';
        html += '</div></div>';

        if (hasChildren) {
            html += '<div class="snap-tree-children">';
            node.children.forEach(function (child) {
                html += renderTreeNodeHtml(child, statsMap, depth + 1);
            });
            html += '</div>';
        }
        return html;
    }

    // Compute local snapshot storage dir for a subvolume path
    /**
     * Get the snapshot directory path for a subvolume.
     * @param {string} subvolPath - Subvolume path
     * @returns {string}
     */
    function getSnapDir(subvolPath) {
        for (var i = 0; i < subvolGroups.length; i++) {
            var g = subvolGroups[i];
            if (g.mountPoint !== "__orphan__" && subvolPath.indexOf(g.mountPoint + "/") === 0) {
                var rel = subvolPath.slice(g.mountPoint.length + 1).replace(/\//g, "__");
                return g.mountPoint + "/.snapshots/" + rel;
            }
        }
        return null;
    }

    /**
     * Update the page header with currently selected subvolume name.
     * @returns {void}
     */
    function updateCurrentTitle() {
        if (!currentSubvol) return;
        var name    = currentSubvol.split("/").filter(Boolean).pop();
        var snapDir = getSnapDir(currentSubvol);
        var titleEl   = document.getElementById("snap-current-title");
        var pathEl    = document.getElementById("snap-current-path");
        var snapDirEl = document.getElementById("snap-current-snapdir");
        if (titleEl)   titleEl.textContent   = "📁 " + name;
        if (pathEl)    pathEl.textContent    = currentSubvol;
        if (snapDirEl) snapDirEl.textContent = snapDir ? "📦 снапшоты: " + snapDir : "";
    }

    /**
     * Populate all subvolume select dropdowns with available paths.
     * @param {Array<string>} paths - Available subvolume paths
     * @returns {void}
     */
    function populateSelects(paths) {
        ["modal-create-subvol", "modal-sched-subvol", "modal-repl-subvol"].forEach(function (id) {
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
    }

    /**
     * Format a subvolume path into a short display name.
     * @param {string} path - Full subvolume path
     * @returns {string}
     */
    function fmtSubvol(path) {
        var name = path.split("/").filter(Boolean).pop();
        if (path.indexOf("/iscsi") !== -1) return "💾 iSCSI: " + name;
        return "📁 " + name + "  (" + path + ")";
    }

    // ── Snapshots tab ─────────────────────────────────────────────────────────
    /**
     * Load snapshots list for the currently selected subvolume.
     * @returns {void}
     */
    function loadSnapshots() {
        if (!currentSubvol) return;
        if (isSubvolOffline(currentSubvol)) {
            document.getElementById("btn-create-snap").disabled = true;
            showAlert("warning",
                "⚠ Том <b>" + escHtml(currentSubvol) + "</b> недоступен — " +
                "массив отмонтирован или удалён. Снапшоты не загружаются. " +
                "Удалите расписание во вкладке «Расписание» если том больше не нужен.");
            document.getElementById("snap-tbody").innerHTML =
                '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px">Том недоступен</td></tr>';
            renderSummary({ total_count: 0, total_size_human: "—", snapshots: [] });
            return;
        }
        document.getElementById("btn-create-snap").disabled = false;
        runCmd(["rusnas-snap", "list", currentSubvol])
            .then(function (out) {
                var data = safeJson(out);
                if (!data) { showAlert("danger", "Ошибка чтения снапшотов"); return; }
                renderSummary(data);
                renderTable(data.snapshots || []);
                loadStorageInfo();
            })
            .catch(function (err) { showAlert("danger", "Ошибка: " + err); });
    }

    /**
     * Render the snapshot count summary bar.
     * @param {Object} data - Snapshot data with type counts
     * @returns {void}
     */
    function renderSummary(data) {
        document.getElementById("sum-count").textContent = data.total_count || 0;
        document.getElementById("sum-size").textContent  = data.total_size_human || "—";
        var last = data.snapshots && data.snapshots[0];
        document.getElementById("sum-last").textContent = last ? fmtAge(last.created_at) : "—";
    }

    /**
     * Render the snapshots table with action buttons.
     * @param {Array<Object>} snaps - Array of snapshot objects
     * @returns {void}
     */
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
    /**
     * Show deletion confirmation dialog for a snapshot.
     * @param {string} id - Snapshot ID
     * @param {string} name - Snapshot name
     * @returns {void}
     */
    function doDeleteConfirm(id, name) {
        pendingDelete = { id: id, snap_name: name };
        document.getElementById("delete-snap-name").textContent = name;
        showModal("modal-delete");
    }

    /**
     * Execute the confirmed snapshot deletion.
     * @returns {void}
     */
    function doDeleteExec() {
        if (!pendingDelete) return;
        closeModal("modal-delete");
        runCmd(["rusnas-snap", "delete", pendingDelete.id])
            .then(function () { showAlert("info", "✅ Снапшот удалён"); loadSnapshots(); })
            .catch(function (e) { showAlert("danger", "Ошибка удаления: " + e); });
        pendingDelete = null;
    }

    /**
     * Show restore confirmation dialog for a snapshot.
     * @param {string} id - Snapshot ID
     * @param {string} name - Snapshot name
     * @returns {void}
     */
    function doRestoreConfirm(id, name) {
        pendingRestore = { id: id, snap_name: name };
        document.getElementById("restore-snap-name").textContent  = name;
        document.getElementById("restore-subvol-name").textContent = currentSubvol;
        showModal("modal-restore");
    }

    /**
     * Execute the confirmed snapshot restore.
     * @returns {void}
     */
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

    /**
     * Open modal to edit a snapshot label.
     * @param {string} id - Snapshot ID
     * @param {string} current - Current label text
     * @returns {void}
     */
    function doLabelModal(id, current) {
        pendingLabel = { id: id };
        document.getElementById("modal-label-input").value = current || "";
        showModal("modal-label");
        setTimeout(function () { document.getElementById("modal-label-input").focus(); }, 50);
    }

    /**
     * Save the edited snapshot label.
     * @returns {void}
     */
    function doLabelSave() {
        if (!pendingLabel) return;
        var label = document.getElementById("modal-label-input").value.trim();
        closeModal("modal-label");
        runCmd(["rusnas-snap", "label", pendingLabel.id, label])
            .then(function () { loadSnapshots(); })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
        pendingLabel = null;
    }

    /**
     * Toggle lock/unlock state on a snapshot.
     * @param {string} id - Snapshot ID
     * @param {boolean} isLocked - Current lock state
     * @returns {void}
     */
    function doLock(id, isLocked) {
        var cmd = isLocked ? "unlock" : "lock";
        runCmd(["rusnas-snap", cmd, id])
            .then(function () { loadSnapshots(); })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    /**
     * Create a new manual snapshot for the selected subvolume.
     * @returns {void}
     */
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

    /**
     * Mount and browse a snapshot's contents in a modal.
     * @param {string} id - Snapshot ID
     * @returns {void}
     */
    function doBrowse(id) {
        showAlert("info", "Монтирование снапшота...");
        runCmd(["rusnas-snap", "browse", id])
            .then(function (out) {
                var data = safeJson(out);
                if (!data) { showAlert("danger", "Ошибка парсинга ответа"); return; }
                browseSnapId = id;
                var shareName = data.share_name;
                var hostname  = data.hostname || "rusNAS";
                var ip        = window.location.hostname || "10.10.10.72";
                var winPath   = "\\\\" + hostname + "\\" + shareName;
                var macPath   = "smb://" + ip + "/" + shareName;
                document.getElementById("browse-win-path").textContent = winPath;
                document.getElementById("browse-mac-path").textContent = macPath;
                document.getElementById("browse-snap-label").textContent = data.snap_name || shareName;
                showModal("modal-browse");
                hideAlert();
            })
            .catch(function (e) { showAlert("danger", "Ошибка монтирования: " + e); });
    }

    /**
     * Copy text to clipboard with user feedback.
     * @param {string} text - Text to copy
     * @returns {void}
     */
    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).catch(function () {
            // fallback
            var ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        });
    }

    /**
     * Unmount a previously mounted snapshot browse session.
     * @returns {void}
     */
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
    /**
     * Load snapshot schedule configurations from CLI.
     * @returns {Promise<Object>}
     */
    function loadSchedulesData() {
        return runCmd(["rusnas-snap", "schedule", "list"])
            .then(function (out) {
                var data = safeJson(out);
                schedulesData = (data && data.schedules) || [];
            })
            .catch(function () { schedulesData = []; });
    }

    /**
     * Render the snapshot schedules table.
     * @returns {void}
     */
    function renderSchedules() {
        var el = document.getElementById("schedule-content");
        loadSchedulesData().then(function () {
            // Filter by selected subvolume (show all if none selected)
            var filtered = currentSubvol
                ? schedulesData.filter(function (s) { return s.subvol_path === currentSubvol; })
                : schedulesData;

            if (!filtered.length) {
                el.innerHTML =
                    '<div class="section">' +
                    '<p class="text-muted">Расписания не настроены.</p>' +
                    '<button id="btn-add-schedule" class="btn btn-primary">+ Добавить расписание</button>' +
                    '</div>';
                var addBtn = document.getElementById("btn-add-schedule");
                if (addBtn) addBtn.addEventListener("click", function () { openScheduleModal(); });
                return;
            }
            el.innerHTML = filtered.map(function (s) {
                var offline = isSubvolOffline(s.subvol_path);
                var offlineBadge = offline
                    ? ' <span class="badge badge-danger" title="Директория не найдена на диске">⚠ путь недоступен</span>'
                    : '';
                return '<div class="section" style="margin-bottom:12px">' +
                    '<div class="section-toolbar">' +
                    '<h2 style="margin:0;border:none;padding:0">' + fmtSubvol(s.subvol_path) + offlineBadge + '</h2>' +
                    '<div class="btn-group">' +
                    '<button class="btn btn-secondary btn-sm sched-edit" data-path="' + escHtml(s.subvol_path) + '"' + (offline ? ' disabled' : '') + '>Изменить</button>' +
                    '<button class="btn btn-' + (s.enabled ? 'warning' : 'success') + ' btn-sm sched-toggle" data-path="' + escHtml(s.subvol_path) + '" data-enabled="' + (s.enabled ? '1' : '0') + '"' + (offline ? ' disabled' : '') + '>' +
                        (s.enabled ? 'Отключить' : 'Включить') +
                    '</button>' +
                    '<button class="btn btn-default btn-sm sched-run-now" data-path="' + escHtml(s.subvol_path) + '"' + (offline ? ' disabled title="Том недоступен"' : '') + '>▶ Запустить сейчас</button>' +
                    '<button class="btn btn-danger btn-sm sched-delete" data-path="' + escHtml(s.subvol_path) + '">Удалить</button>' +
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
                    (function () {
                        var sd = getSnapDir(s.subvol_path);
                        return sd ? '<tr><td style="color:var(--color-muted)">Хранение</td><td><code style="font-size:11px;word-break:break-all">' + escHtml(sd) + '</code></td></tr>' : '';
                    })() +
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
            el.querySelectorAll(".sched-delete").forEach(function (b) {
                b.addEventListener("click", function () { deleteSchedule(this.dataset.path); });
            });
            var addBtn = document.getElementById("btn-add-schedule");
            if (addBtn) addBtn.addEventListener("click", function () { openScheduleModal(); });
        });
    }

    /**
     * Open modal to create/edit a snapshot schedule.
     * @param {string} subvolPath - Subvolume path for the schedule
     * @returns {void}
     */
    function openScheduleModal(subvolPath) {
        document.getElementById("modal-schedule-title").textContent =
            subvolPath ? "Изменить расписание" : "Добавить расписание";

        var sel = document.getElementById("modal-sched-subvol");
        if (subvolPath) {
            sel.value = subvolPath;
            sel.disabled = true;
        } else {
            sel.disabled = false;
            if (currentSubvol) sel.value = currentSubvol;
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

    /**
     * Save snapshot schedule configuration.
     * @returns {void}
     */
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

    /**
     * Enable or disable a snapshot schedule.
     * @param {string} subvolPath - Subvolume path
     * @param {boolean} isEnabled - New enabled state
     * @returns {void}
     */
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

    /**
     * Delete a snapshot schedule for a subvolume.
     * @param {string} subvolPath - Subvolume path
     * @returns {void}
     */
    function deleteSchedule(subvolPath) {
        if (!confirm("Удалить расписание для «" + subvolPath + "»?\n\nСнапшоты созданные по расписанию останутся нетронутыми.")) return;
        runCmd(["rusnas-snap", "schedule", "delete", subvolPath])
            .then(function () {
                showAlert("info", "✅ Расписание удалено");
                loadSchedulesData();
                if (activeTab === "schedule") renderSchedules();
            })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    /**
     * Manually run snapshot retention policy for a subvolume.
     * @param {string} subvolPath - Subvolume path
     * @returns {void}
     */
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
    /**
     * Load snapshot system events log.
     * @returns {void}
     */
    function loadEvents() {
        var cmd = ["rusnas-snap", "events", "--limit", "50"];
        if (currentSubvol) cmd = cmd.concat(["--subvol", currentSubvol]);
        runCmd(cmd)
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
    /**
     * Wire up all page action buttons to their handlers.
     * @returns {void}
     */
    function setupButtons() {
        document.getElementById("btn-create-snap").addEventListener("click", function () {
            var sel = document.getElementById("modal-create-subvol");
            if (sel && currentSubvol) sel.value = currentSubvol;
            showModal("modal-create");
        });

        document.getElementById("btn-refresh").addEventListener("click", function () {
            if (activeTab === "snapshots")    loadSnapshots();
            if (activeTab === "schedule")     renderSchedules();
            if (activeTab === "replication")  renderReplications();
            if (activeTab === "events")       loadEvents();
        });

        document.getElementById("modal-create-confirm").addEventListener("click", doCreate);
        document.getElementById("modal-restore-confirm").addEventListener("click", doRestore);
        document.getElementById("modal-label-confirm").addEventListener("click", doLabelSave);
        document.getElementById("modal-delete-confirm").addEventListener("click", doDeleteExec);
        document.getElementById("modal-sched-save").addEventListener("click", saveSchedule);
        document.getElementById("browse-umount-btn").addEventListener("click", function(e) { e.stopPropagation(); doBrowseUmount(); });
        document.getElementById("browse-keep-btn").addEventListener("click", function(e) { e.stopPropagation(); closeModal("modal-browse"); });
        document.getElementById("browse-copy-win").addEventListener("click", function () {
            copyToClipboard(document.getElementById("browse-win-path").textContent);
            this.textContent = "✓";
            var self = this;
            setTimeout(function () { self.textContent = "Копировать"; }, 1500);
        });
        document.getElementById("browse-copy-mac").addEventListener("click", function () {
            copyToClipboard(document.getElementById("browse-mac-path").textContent);
            this.textContent = "✓";
            var self = this;
            setTimeout(function () { self.textContent = "Копировать"; }, 1500);
        });

        // Enter key in label modal
        document.getElementById("modal-label-input").addEventListener("keydown", function (e) {
            if (e.key === "Enter") doLabelSave();
        });

        // Cron presets (schedule modal)
        document.querySelectorAll(".cron-preset").forEach(function (btn) {
            btn.addEventListener("click", function () {
                document.getElementById("modal-sched-cron").value = this.dataset.cron;
            });
        });

        // Cron presets (replication modal)
        document.querySelectorAll(".repl-cron-preset").forEach(function (btn) {
            btn.addEventListener("click", function () {
                document.getElementById("modal-repl-cron").value = this.dataset.cron;
            });
        });

        // Replication modal save + test
        document.getElementById("modal-repl-save").addEventListener("click", saveReplication);
        document.getElementById("modal-repl-test").addEventListener("click", testSshFromModal);
    }

    // ── Replication tab ───────────────────────────────────────────────────────

    /**
     * Load replication task configurations from CLI.
     * @returns {Promise<Object>}
     */
    function loadReplicationsData() {
        return runCmd(["rusnas-snap", "replication", "list"])
            .then(function (out) {
                var data = safeJson(out);
                replicationsData = (data && data.tasks) || [];
                return replicationsData;
            })
            .catch(function () { replicationsData = []; return []; });
    }

    /**
     * Render the replication tasks table.
     * @returns {void}
     */
    function renderReplications() {
        var el = document.getElementById("replication-content");
        if (!el) return;
        el.innerHTML = '<div class="text-muted" style="padding:12px">Загрузка...</div>';

        loadReplicationsData().then(function (tasks) {
            if (!tasks.length) {
                el.innerHTML =
                    '<div class="section">' +
                    '<p class="text-muted">Задачи репликации не настроены.</p>' +
                    '<p style="font-size:13px;margin-bottom:12px">Репликация копирует Btrfs-снапшоты на удалённый сервер ' +
                    'с помощью <code>btrfs send/receive</code> по SSH. ' +
                    'Только изменения с момента последней передачи (инкрементально).</p>' +
                    '<button id="btn-add-replication" class="btn btn-primary">+ Добавить репликацию</button>' +
                    '</div>';
                var b = document.getElementById("btn-add-replication");
                if (b) b.addEventListener("click", function () { openReplicationModal(); });
                return;
            }

            var statusIcon = { ok: "✅", error: "❌", running: "⏳", null: "⬜" };
            var statusLabel = { ok: "OK", error: "Ошибка", running: "Выполняется" };

            el.innerHTML = tasks.map(function (t) {
                var st = t.last_status || "";
                var icon = statusIcon[st] || "⬜";
                var stLabel = statusLabel[st] || "Ожидает";
                var stCls = st === "ok" ? "badge-success" :
                            st === "error" ? "badge-danger" :
                            st === "running" ? "badge-warning" : "badge-secondary";
                return '<div class="section" style="margin-bottom:12px">' +
                    '<div class="section-toolbar">' +
                    '<h2 style="margin:0;border:none;padding:0">' + escHtml(fmtSubvol(t.subvol_path)) + '</h2>' +
                    '<div class="btn-group">' +
                    '<button class="btn btn-primary btn-sm repl-run" data-path="' + escHtml(t.subvol_path) + '">▶ Запустить</button>' +
                    '<button class="btn btn-secondary btn-sm repl-edit" data-path="' + escHtml(t.subvol_path) + '">Изменить</button>' +
                    '<button class="btn btn-' + (t.enabled ? 'warning' : 'success') + ' btn-sm repl-toggle" data-path="' + escHtml(t.subvol_path) + '" data-enabled="' + (t.enabled ? '1' : '0') + '">' +
                        (t.enabled ? 'Отключить' : 'Включить') +
                    '</button>' +
                    '<button class="btn btn-danger btn-sm repl-delete" data-path="' + escHtml(t.subvol_path) + '">Удалить</button>' +
                    '</div>' +
                    '</div>' +
                    '<table style="margin-top:10px">' +
                    '<tbody>' +
                    '<tr><td style="width:160px;color:var(--color-muted)">Назначение</td>' +
                        '<td><code>' + escHtml(t.remote_user + '@' + t.remote_host + ':' + t.remote_path) + '</code></td></tr>' +
                    '<tr><td style="color:var(--color-muted)">Расписание</td>' +
                        '<td><code>' + escHtml(t.cron_expr) + '</code> — ' + escHtml(cronHuman(t.cron_expr)) + '</td></tr>' +
                    '<tr><td style="color:var(--color-muted)">Статус</td>' +
                        '<td><span class="badge ' + stCls + '">' + icon + ' ' + escHtml(stLabel) + '</span>' +
                        (t.last_run_at ? ' <span class="text-muted" style="font-size:12px">· ' + escHtml(fmtDate(t.last_run_at)) + '</span>' : '') +
                        '</td></tr>' +
                    (t.last_error ? '<tr><td style="color:var(--color-muted)">Ошибка</td>' +
                        '<td style="color:var(--color-danger);font-size:12px">' + escHtml(t.last_error) + '</td></tr>' : '') +
                    '<tr><td style="color:var(--color-muted)">Активно</td>' +
                        '<td>' + (t.enabled ? '<span class="status-active">✅ Да</span>' : '<span class="status-inactive">❌ Нет</span>') + '</td></tr>' +
                    '</tbody></table>' +
                    '</div>';
            }).join("") +
            '<button id="btn-add-replication" class="btn btn-primary" style="margin-top:4px">+ Добавить репликацию</button>';

            // Wire buttons
            el.querySelectorAll(".repl-run").forEach(function (b) {
                b.addEventListener("click", function () { runReplicationNow(this.dataset.path); });
            });
            el.querySelectorAll(".repl-edit").forEach(function (b) {
                b.addEventListener("click", function () { openReplicationModal(this.dataset.path); });
            });
            el.querySelectorAll(".repl-toggle").forEach(function (b) {
                b.addEventListener("click", function () { toggleReplication(this.dataset.path, this.dataset.enabled === "1"); });
            });
            el.querySelectorAll(".repl-delete").forEach(function (b) {
                b.addEventListener("click", function () { deleteReplication(this.dataset.path); });
            });
            var addBtn = document.getElementById("btn-add-replication");
            if (addBtn) addBtn.addEventListener("click", function () { openReplicationModal(); });
        });
    }

    /**
     * Open modal to create/edit a replication task.
     * @param {string} subvolPath - Subvolume path for replication
     * @returns {void}
     */
    function openReplicationModal(subvolPath) {
        editingReplSubvol = subvolPath || null;
        document.getElementById("modal-repl-title").textContent =
            subvolPath ? "Изменить репликацию" : "Добавить репликацию";

        var sel = document.getElementById("modal-repl-subvol");
        // Populate select with all known subvols
        sel.innerHTML = "";
        subvolList.forEach(function (p) {
            var opt = document.createElement("option");
            opt.value = p;
            opt.textContent = fmtSubvol(p);
            sel.appendChild(opt);
        });
        if (subvolPath) {
            sel.value = subvolPath;
            sel.disabled = true;
        } else {
            sel.disabled = false;
            if (currentSubvol) sel.value = currentSubvol;
        }

        var existing = replicationsData.filter(function (t) { return t.subvol_path === subvolPath; })[0];
        document.getElementById("modal-repl-host").value = existing ? existing.remote_host : "";
        document.getElementById("modal-repl-user").value = existing ? existing.remote_user : "rusnas";
        document.getElementById("modal-repl-path").value = existing ? existing.remote_path : "";
        document.getElementById("modal-repl-cron").value = existing ? existing.cron_expr : "0 1 * * *";

        showModal("modal-replication");
    }

    /**
     * Save replication task configuration.
     * @returns {void}
     */
    function saveReplication() {
        var subvol = document.getElementById("modal-repl-subvol").value;
        var host   = document.getElementById("modal-repl-host").value.trim();
        var user   = document.getElementById("modal-repl-user").value.trim() || "rusnas";
        var path   = document.getElementById("modal-repl-path").value.trim();
        var cron   = document.getElementById("modal-repl-cron").value.trim();

        if (!subvol || !host || !path) {
            showAlert("warning", "Заполните: субволюм, хост, удалённый путь");
            return;
        }
        var args = [
            "rusnas-snap", "replication", "set", subvol,
            "--host", host, "--user", user, "--path", path, "--cron", cron
        ];
        runCmd(args)
            .then(function () {
                closeModal("modal-replication");
                showAlert("info", "✅ Задача репликации сохранена");
                if (activeTab === "replication") renderReplications();
            })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    /**
     * Test SSH connection from the replication modal settings.
     * @returns {void}
     */
    function testSshFromModal() {
        var subvol = document.getElementById("modal-repl-subvol").value;
        // If we have an existing task already saved, test it
        // Otherwise give a hint
        var existing = replicationsData.filter(function (t) { return t.subvol_path === subvol; })[0];
        if (!existing) {
            showAlert("warning", "Сначала сохраните задачу, затем проверьте SSH");
            return;
        }
        showAlert("info", "Проверка SSH-подключения...");
        runCmd(["rusnas-snap", "replication", "check-ssh", subvol])
            .then(function (out) {
                var data = safeJson(out);
                if (data && data.ssh_ok) {
                    showAlert("info", "✅ SSH-подключение работает: " + (data.host || ""));
                } else {
                    showAlert("danger", "❌ SSH не работает: " + ((data && data.error) || "нет ответа"));
                }
            })
            .catch(function (e) { showAlert("danger", "Ошибка проверки: " + e); });
    }

    /**
     * Delete a replication task for a subvolume.
     * @param {string} subvolPath - Subvolume path
     * @returns {void}
     */
    function deleteReplication(subvolPath) {
        if (!confirm("Удалить задачу репликации для «" + subvolPath + "»?\n\nСнапшоты на удалённом сервере останутся нетронутыми.")) return;
        runCmd(["rusnas-snap", "replication", "delete", subvolPath])
            .then(function () {
                showAlert("info", "✅ Задача репликации удалена");
                renderReplications();
            })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    /**
     * Enable or disable a replication task.
     * @param {string} subvolPath - Subvolume path
     * @param {boolean} isEnabled - New enabled state
     * @returns {void}
     */
    function toggleReplication(subvolPath, isEnabled) {
        var existing = replicationsData.filter(function (t) { return t.subvol_path === subvolPath; })[0];
        if (!existing) return;
        var args = [
            "rusnas-snap", "replication", "set", subvolPath,
            "--host", existing.remote_host,
            "--user", existing.remote_user,
            "--path", existing.remote_path,
            "--cron", existing.cron_expr,
        ];
        if (isEnabled) args.push("--disabled");
        runCmd(args)
            .then(function () { renderReplications(); })
            .catch(function (e) { showAlert("danger", "Ошибка: " + e); });
    }

    /**
     * Manually trigger a replication run for a subvolume.
     * @param {string} subvolPath - Subvolume path
     * @returns {void}
     */
    function runReplicationNow(subvolPath) {
        showAlert("info", "⏳ Репликация запущена... Это может занять несколько минут.");
        // Disable the run button visually by rerendering after a delay
        runCmd(["rusnas-snap", "replication", "run", subvolPath])
            .then(function (out) {
                var data = safeJson(out);
                var inc = data && data.incremental;
                var snap = data && data.snap_name || "";
                showAlert("info", "✅ Реплицировано: " + snap +
                    (inc ? " (инкрементально)" : " (полная копия)"));
                renderReplications();
            })
            .catch(function (e) {
                showAlert("danger", "❌ Ошибка репликации: " + e);
                renderReplications();
            });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    /**
     * Safely parse JSON string, returning null on failure.
     * @param {string} str - JSON string to parse
     * @returns {Object|null}
     */
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

    /**
     * Format ISO date string to localized short date.
     * @param {string} isoStr - ISO 8601 date string
     * @returns {string}
     */
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

    /**
     * Format ISO date string as relative time ago.
     * @param {string} isoStr - ISO 8601 date string
     * @returns {string}
     */
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

    /**
     * Convert cron expression to human-readable Russian text.
     * @param {string} expr - Cron expression string
     * @returns {string}
     */
    function cronHuman(expr) {
        var map = {
            "0 * * * *": "каждый час",
            "0 0 * * *": "каждый день в 00:00",
            "0 0 * * 0": "каждую неделю (вс 00:00)",
            "0 0 1 * *": "каждый месяц (1-е)"
        };
        return map[expr] || expr;
    }

    /**
     * Escape HTML special characters to prevent XSS.
     * @param {string} s - Raw string to escape
     * @returns {string}
     */
    function escHtml(s) {
        return String(s || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

})();
