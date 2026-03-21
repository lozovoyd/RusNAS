// ─── Modal helpers ───────────────────────────────────────────────────────────

function showModal(id) {
    document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
}

// ─── FileBrowser URL helper ───────────────────────────────────────────────────

function getFileBrowserUrl(path, options) {
    var base = window.location.protocol + '//' + window.location.hostname + '/files/';
    var params = new URLSearchParams();
    if (path) params.set('path', path);
    if (options && options.sort)  params.set('sort', options.sort);
    if (options && options.order) params.set('order', options.order);
    return base + (params.toString() ? '?' + params.toString() : '');
}

// ─── Volumes (mounted non-system) ────────────────────────────────────────────

var SKIP_TARGETS = /^(\/boot|\/sys|\/proc|\/dev|\/run|\/snap|\/efi)(\/|$)/;
var SKIP_FSTYPES = /tmpfs|devtmpfs|sysfs|proc|cgroup|pstore|efivarfs|hugetlbfs|mqueue|debugfs|tracefs|configfs|fusectl|bpf/;

function spawnBtrfsSubvols(mountPoint) {
    return new Promise(function(resolve) {
        var proc = cockpit.spawn(
            ["btrfs", "subvolume", "list", "-o", mountPoint],
            { superuser: "require", err: "message" }
        );
        var out = "";
        proc.stream(function(data) { out += data; });
        proc.then(function() {
            var subvols = out.trim().split("\n").filter(Boolean)
                .map(function(line) {
                    return mountPoint.replace(/\/$/, "") + "/" + line.split(" ").pop();
                })
                .filter(function(p) { return p.indexOf(".snapshots") === -1; });
            resolve({ target: mountPoint, subvols: subvols });
        }).catch(function() {
            resolve({ target: mountPoint, subvols: [] });
        });
    });
}

// Populate volume <select> element(s). targetId — optional specific select ID to populate.
function loadVolumeSelects(callback, targetId) {
    var selIds = targetId ? [targetId] : ["sm-volume"];
    var proc = cockpit.spawn(["findmnt", "-rno", "TARGET,SOURCE,FSTYPE,SIZE"], { err: "message" });
    var out = "";
    proc.stream(function(data) { out += data; });
    proc.then(function() {
        var volumes = out.trim().split("\n").filter(Boolean)
            .map(function(line) {
                var p = line.trim().split(/\s+/);
                return { target: p[0], source: p[1] || "", fstype: p[2] || "", size: p[3] || "" };
            })
            .filter(function(v) {
                return v.target !== "/" &&
                    !SKIP_TARGETS.test(v.target) &&
                    !SKIP_FSTYPES.test(v.fstype);
            });

        if (volumes.length === 0) {
            selIds.forEach(function(id) {
                var sel = document.getElementById(id);
                if (sel) sel.innerHTML = "<option value=''>— нет смонтированных томов —</option>";
            });
            if (callback) callback("");
            return;
        }

        var btrfsVols = volumes.filter(function(v) { return v.fstype === "btrfs"; });
        var svPromises = btrfsVols.map(function(v) { return spawnBtrfsSubvols(v.target); });

        Promise.all(svPromises).then(function(svResults) {
            var svMap = {};
            svResults.forEach(function(r) { svMap[r.target] = r.subvols; });

            var html = volumes.map(function(v) {
                var label = v.target + " (" + v.source + ", " + v.fstype + ", " + v.size + ")";
                var subvols = svMap[v.target] || [];
                if (v.fstype === "btrfs" && subvols.length > 0) {
                    var inner = "<option value='" + v.target + "' data-is-subvol='false'>  Весь том</option>";
                    inner += subvols.map(function(sv) {
                        var svName = sv.split("/").pop();
                        return "<option value='" + sv + "' data-is-subvol='true' data-subvol-name='" + svName + "'>  📁 " + svName + "</option>";
                    }).join("");
                    return "<optgroup label='" + label + "'>" + inner + "</optgroup>";
                }
                return "<option value='" + v.target + "' data-is-subvol='false'>" + label + "</option>";
            }).join("");

            selIds.forEach(function(id) {
                var sel = document.getElementById(id);
                if (sel) sel.innerHTML = html;
            });
            if (callback) callback(volumes[0].target);
        });
    }).catch(function() {
        selIds.forEach(function(id) {
            var sel = document.getElementById(id);
            if (sel) sel.innerHTML = "<option value=''>— ошибка загрузки томов —</option>";
        });
    });
}


// ─── Populate owner/group selects ────────────────────────────────────────────

function populateOwnerSelects(userSelId, groupSelId, currentUser, currentGroup) {
    cockpit.spawn(
        ["bash", "-c", "awk -F: '$3>=1000 && $1!=\"nobody\" {print $1}' /etc/passwd"],

    ).done(function(out) {
        var users = out.trim().split("\n").filter(Boolean);
        var sel = document.getElementById(userSelId);
        if (sel) {
            sel.innerHTML = ["root"].concat(users).map(function(u) {
                return "<option value='" + u + "'" + (u === currentUser ? " selected" : "") + ">" + u + "</option>";
            }).join("");
        }
    });

    cockpit.spawn(
        ["bash", "-c", "awk -F: '$3>=1000 {print $1}' /etc/group"],

    ).done(function(out) {
        var groups = out.trim().split("\n").filter(Boolean);
        var sel = document.getElementById(groupSelId);
        if (sel) {
            sel.innerHTML = ["root"].concat(groups).map(function(g) {
                return "<option value='" + g + "'" + (g === currentGroup ? " selected" : "") + ">" + g + "</option>";
            }).join("");
        }
    });
}

function populateUserCheckboxes(containerId, selectedUsers) {
    cockpit.spawn(
        ["bash", "-c", "awk -F: '$3>=1000 && $1!=\"nobody\" {print $1}' /etc/passwd"],

    ).done(function(out) {
        var users = out.trim().split("\n").filter(Boolean);
        var container = document.getElementById(containerId);
        if (!container) return;
        if (users.length === 0) {
            container.innerHTML = "<small>Нет локальных пользователей</small>";
            return;
        }
        container.innerHTML = users.map(function(u) {
            var checked = selectedUsers && selectedUsers.indexOf(u) !== -1 ? "checked" : "";
            return "<label class='checkbox-label'><input type='checkbox' value='" + u + "' " + checked + "> " + u + "</label>";
        }).join("");
    });
}

// ─── Storage Tabs ─────────────────────────────────────────────────────────────

var _tabsLoaded = {};

function setupStorageTabs() {
    var tabPanels = ["shares", "iscsi", "worm", "services", "filebrowser"];
    document.querySelectorAll("#storage-tabs .advisor-tab-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            document.querySelectorAll("#storage-tabs .advisor-tab-btn").forEach(function(b) {
                b.classList.remove("active");
            });
            tabPanels.forEach(function(t) {
                var el = document.getElementById("tab-" + t);
                if (el) el.classList.toggle("hidden", t !== btn.dataset.tab);
            });
            btn.classList.add("active");

            var tab = btn.dataset.tab;
            if (tab === "iscsi") { loadISCSI(); }
            if (tab === "worm" && !_tabsLoaded.worm) { _tabsLoaded.worm = true; loadWorm(); }
            if (tab === "services" && !_tabsLoaded.services) {
                _tabsLoaded.services = true;
                loadFtp();
                loadWebdav();
            }
            if (tab === "filebrowser" && !_tabsLoaded.filebrowser) {
                _tabsLoaded.filebrowser = true;
                loadFbStatus();
                loadFileBrowserUsers();
            }
        });
    });
}

// ─── Unified Share Modal Tabs ─────────────────────────────────────────────────

function setupShareModalTabs() {
    document.querySelectorAll("#share-modal .tab-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            document.querySelectorAll("#share-modal .tab-btn").forEach(function(b) {
                b.classList.remove("tab-active");
            });
            document.querySelectorAll("#share-modal .tab-panel").forEach(function(p) {
                p.classList.add("hidden");
            });
            btn.classList.add("tab-active");
            document.getElementById(btn.dataset.tab).classList.remove("hidden");
        });
    });

    // SMB toggle shows/hides settings
    document.getElementById("sm-smb-enabled").addEventListener("change", function() {
        document.getElementById("sm-smb-settings").classList.toggle("hidden", !this.checked);
    });

    // NFS toggle shows/hides settings
    document.getElementById("sm-nfs-enabled").addEventListener("change", function() {
        document.getElementById("sm-nfs-settings").classList.toggle("hidden", !this.checked);
    });

    // Volume select: auto-fill name from subvol, show path hint
    document.getElementById("sm-volume").addEventListener("change", function() {
        var opt = this.options[this.selectedIndex];
        var isSubvol = opt && opt.dataset.isSubvol === "true";
        var nameInput = document.getElementById("sm-name");
        var hint = document.getElementById("sm-path-hint");
        if (isSubvol) {
            if (!nameInput.value || nameInput.dataset.autoFilled === "true") {
                nameInput.value = opt.dataset.subvolName;
                nameInput.dataset.autoFilled = "true";
            }
            hint.textContent = "Путь шары: " + opt.value + " (Btrfs субтом)";
        } else {
            nameInput.dataset.autoFilled = "";
            hint.textContent = "";
        }
    });
    document.getElementById("sm-name").addEventListener("input", function() {
        this.dataset.autoFilled = "";
    });
}

// ─── Service Status Bar ───────────────────────────────────────────────────────

function loadServiceStatus() {
    cockpit.spawn(["bash", "-c",
        "systemctl is-active smbd 2>/dev/null || echo inactive; echo '---';" +
        "systemctl is-active nfs-kernel-server 2>/dev/null || echo inactive"
    ], { err: "message" })
    .done(function(out) {
        var parts = out.split("---\n");
        var smbActive = (parts[0] || "").trim() === "active";
        var nfsActive = (parts[1] || "").trim() === "active";
        document.getElementById("smb-status-dot").innerHTML =
            "<span class='badge " + (smbActive ? "badge-success'>● Активен" : "badge-danger'>● Остановлен") + "</span>";
        document.getElementById("nfs-status-dot").innerHTML =
            "<span class='badge " + (nfsActive ? "badge-success'>● Активен" : "badge-danger'>● Остановлен") + "</span>";
    });
}

// ─── Parse SMB config (returns Promise<SmbShare[]>) ──────────────────────────

function parseSmbConf() {
    return new Promise(function(resolve) {
        var cmd = "python3 -c \"\nimport subprocess\nout=subprocess.check_output(['testparm','-s'],stderr=subprocess.DEVNULL,text=True)\nshare=None\nskip={'global','homes','printers','print$'}\ndata={}\nfor line in out.splitlines():\n  line=line.strip()\n  if line.startswith('['):\n    name=line.strip('[]')\n    share=name if name not in skip else None\n    if share: data[share]={'name':share}\n  elif share and '=' in line:\n    k,v=line.split('=',1)\n    data[share][k.strip().replace(' ','_')]=v.strip()\nfor n,s in data.items():\n  print(n+'\\\\t'+s.get('path','')+'\\\\t'+s.get('guest_ok','no')+'\\\\t'+s.get('browseable','yes')+'\\\\t'+s.get('writable','yes')+'\\\\t'+s.get('valid_users',''))\n\"";
        cockpit.spawn(["bash", "-c", cmd], { superuser: "require", err: "message" })
        .done(function(out) {
            var shares = out.trim().split("\n").filter(Boolean).map(function(line) {
                var p = line.split("\t");
                return {
                    name:       p[0] || "",
                    path:       p[1] || ("/mnt/data/shares/" + p[0]),
                    guestOk:    p[2] || "no",
                    browseable: p[3] || "yes",
                    writable:   p[4] || "yes",
                    validUsers: p[5] || ""
                };
            }).filter(function(s) { return s.name && s.path; });
            resolve(shares);
        })
        .fail(function() { resolve([]); });
    });
}

// ─── Parse NFS exports (returns Promise<NfsShare[]>) ─────────────────────────

function parseNfsExports() {
    return new Promise(function(resolve) {
        cockpit.spawn(
            ["bash", "-c", "cat /etc/exports 2>/dev/null | grep -v '^#' | grep -v '^[[:space:]]*$' || true"],
            { superuser: "require", err: "message" }
        )
        .done(function(out) {
            var shares = out.trim().split("\n").filter(Boolean).map(function(line) {
                var parts      = line.trim().split(/\s+/);
                var path       = parts[0];
                var clientPart = parts[1] || "*(rw,sync,no_subtree_check,no_root_squash,insecure)";
                var client     = clientPart.split("(")[0] || "*";
                var optsMatch  = clientPart.match(/\(([^)]+)\)/);
                var opts       = optsMatch ? optsMatch[1].split(",") : [];
                var rw         = opts.indexOf("ro") === -1;
                var rootSquash = opts.indexOf("root_squash") !== -1 && opts.indexOf("no_root_squash") === -1;
                return { path: path, clients: client, rw: rw, rootSquash: rootSquash };
            }).filter(function(s) { return s.path; });
            resolve(shares);
        })
        .fail(function() { resolve([]); });
    });
}

// ─── Load + Render unified Shares table ──────────────────────────────────────

function loadAllShares() {
    var tbody = document.getElementById("shares-body");
    tbody.innerHTML = "<tr><td colspan='5'>Загрузка...</td></tr>";

    var p1 = new Promise(function(resolve, reject) {
        parseSmbConf().then(resolve).catch(reject);
    });
    var p2 = new Promise(function(resolve, reject) {
        parseNfsExports().then(resolve).catch(reject);
    });

    Promise.all([p1, p2]).then(function(results) {
        var smbShares = results[0];
        var nfsShares = results[1];

        var byPath = {};

        smbShares.forEach(function(s) {
            byPath[s.path] = { name: s.name, path: s.path, smb: s, nfs: null };
        });

        nfsShares.forEach(function(n) {
            if (byPath[n.path]) {
                byPath[n.path].nfs = n;
            } else {
                var name = n.path.split("/").pop() || n.path;
                byPath[n.path] = { name: name, path: n.path, smb: null, nfs: n };
            }
        });

        renderSharesTable(Object.values(byPath));
    }).catch(function() {
        tbody.innerHTML = "<tr><td colspan='5' class='text-muted'>Ошибка загрузки шар</td></tr>";
    });
}

function renderSharesTable(shares) {
    var tbody = document.getElementById("shares-body");
    window._sharesData = shares;

    if (!shares.length) {
        tbody.innerHTML = "<tr><td colspan='5' class='text-muted'>Нет шар. Нажмите «+ Создать шару».</td></tr>";
        return;
    }

    tbody.innerHTML = shares.map(function(share, idx) {
        var badges = "";
        if (share.smb) badges += "<span class='badge badge-info'>SMB</span> ";
        if (share.nfs) badges += "<span class='badge badge-info'>NFS</span>";
        if (!share.smb && !share.nfs) badges = "<span class='badge badge-secondary'>нет протоколов</span>";

        var access = share.smb
            ? (share.smb.guestOk === "yes" ? "Публичный" : "Приватный")
            : "—";

        return "<tr>" +
            "<td><b>" + share.name + "</b></td>" +
            "<td><code style='font-size:12px;'>" + share.path + "</code></td>" +
            "<td><div class='share-proto-badges'>" + badges + "</div></td>" +
            "<td>" + access + "</td>" +
            "<td>" +
              "<a class='btn btn-secondary btn-sm fb-share-link' href='" + getFileBrowserUrl(share.path) + "' target='_blank' style='margin-right:4px;'>📂 Файлы</a>" +
              "<button class='btn btn-secondary btn-sm edit-share-btn' data-idx='" + idx + "' style='margin-right:4px;'>✏️ Изменить</button>" +
              "<button class='btn btn-danger btn-sm delete-share-btn' data-idx='" + idx + "'>🗑️ Удалить</button>" +
            "</td>" +
            "</tr>";
    }).join("");

    document.querySelectorAll(".edit-share-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            openShareModal(window._sharesData[parseInt(this.dataset.idx)]);
        });
    });
    document.querySelectorAll(".delete-share-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            deleteShareEntry(window._sharesData[parseInt(this.dataset.idx)]);
        });
    });
}

// ─── Open unified Share modal ─────────────────────────────────────────────────

var _shareModalMode = "create";
var _shareModalData = null;

function openShareModal(shareData) {
    _shareModalMode = shareData ? "edit" : "create";
    _shareModalData = shareData || null;

    // Reset inner tabs to "Основные"
    document.querySelectorAll("#share-modal .tab-btn").forEach(function(b) { b.classList.remove("tab-active"); });
    document.querySelectorAll("#share-modal .tab-panel").forEach(function(p) { p.classList.add("hidden"); });
    document.querySelector("#share-modal .tab-btn[data-tab='share-tab-general']").classList.add("tab-active");
    document.getElementById("share-tab-general").classList.remove("hidden");

    var title     = document.getElementById("share-modal-title");
    var nameInput = document.getElementById("sm-name");
    var volSel    = document.getElementById("sm-volume");
    var volLabel  = document.getElementById("sm-volume-label");
    var pathHint  = document.getElementById("sm-path-hint");

    if (!shareData) {
        // ── Create mode ──
        title.textContent = "Новая шара";
        nameInput.value    = "";
        nameInput.disabled = false;
        nameInput.dataset.autoFilled = "";
        pathHint.textContent = "";
        volLabel.textContent = "Том (точка монтирования)";
        volSel.disabled = false;

        document.getElementById("sm-chmod").value = "755";
        populateOwnerSelects("sm-owner", "sm-group", "root", "root");
        populateUserCheckboxes("sm-smb-users", []);

        document.getElementById("sm-smb-enabled").checked = true;
        document.getElementById("sm-smb-settings").classList.remove("hidden");
        document.getElementById("sm-smb-access").value     = "public";
        document.getElementById("sm-smb-browseable").value = "yes";
        document.getElementById("sm-smb-writable").value   = "yes";

        document.getElementById("sm-nfs-enabled").checked = false;
        document.getElementById("sm-nfs-settings").classList.add("hidden");
        document.getElementById("sm-nfs-clients").value = "*";
        document.getElementById("sm-nfs-access").value  = "rw";
        document.getElementById("sm-nfs-squash").value  = "no_root_squash";

        loadVolumeSelects(null, "sm-volume");

    } else {
        // ── Edit mode ──
        title.textContent = "Редактировать: " + shareData.name;
        nameInput.value    = shareData.name;
        nameInput.disabled = true;
        pathHint.textContent = "";
        volLabel.textContent = "Путь";
        volSel.innerHTML = "<option value='" + shareData.path + "'>" + shareData.path + "</option>";
        volSel.disabled = true;

        // SMB
        var smb = shareData.smb;
        document.getElementById("sm-smb-enabled").checked = !!smb;
        document.getElementById("sm-smb-settings").classList.toggle("hidden", !smb);
        if (smb) {
            document.getElementById("sm-smb-access").value     = smb.guestOk === "yes" ? "public" : "private";
            document.getElementById("sm-smb-browseable").value = smb.browseable || "yes";
            document.getElementById("sm-smb-writable").value   = smb.writable   || "yes";
            populateUserCheckboxes("sm-smb-users",
                smb.validUsers ? smb.validUsers.trim().split(/[\s,]+/).filter(Boolean) : []);
        } else {
            populateUserCheckboxes("sm-smb-users", []);
        }

        // NFS
        var nfs = shareData.nfs;
        document.getElementById("sm-nfs-enabled").checked = !!nfs;
        document.getElementById("sm-nfs-settings").classList.toggle("hidden", !nfs);
        if (nfs) {
            document.getElementById("sm-nfs-clients").value = nfs.clients || "*";
            document.getElementById("sm-nfs-access").value  = nfs.rw ? "rw" : "ro";
            document.getElementById("sm-nfs-squash").value  = nfs.rootSquash ? "root_squash" : "no_root_squash";
        } else {
            document.getElementById("sm-nfs-clients").value = "*";
            document.getElementById("sm-nfs-access").value  = "rw";
            document.getElementById("sm-nfs-squash").value  = "no_root_squash";
        }

        // chmod / owner from filesystem
        cockpit.spawn(["bash", "-c",
            "stat -c '%a %U %G' " + shareData.path + " 2>/dev/null || echo '755 root root'"
        ], { superuser: "require", err: "message" })
        .done(function(statOut) {
            var parts = (statOut || "755 root root").trim().split(" ");
            document.getElementById("sm-chmod").value = parts[0] || "755";
            populateOwnerSelects("sm-owner", "sm-group", parts[1] || "root", parts[2] || "root");
        })
        .fail(function() {
            document.getElementById("sm-chmod").value = "755";
            populateOwnerSelects("sm-owner", "sm-group", "root", "root");
        });
    }

    showModal("share-modal");
}

// ─── Save unified Share modal ─────────────────────────────────────────────────

function saveShareModal() {
    var name = _shareModalMode === "edit" ? _shareModalData.name : document.getElementById("sm-name").value.trim();
    if (!name) { alert("Введите имя шары"); return; }

    // Determine path
    var path;
    if (_shareModalMode === "create") {
        var volSel = document.getElementById("sm-volume");
        var volume = volSel.value;
        if (!volume) { alert("Выберите том"); return; }
        var opt      = volSel.options[volSel.selectedIndex];
        var isSubvol = opt && opt.dataset.isSubvol === "true";
        path = isSubvol ? volume : (volume.replace(/\/$/, "") + "/" + name);
    } else {
        path = _shareModalData.path;
    }

    var chmod = document.getElementById("sm-chmod").value;
    var owner = document.getElementById("sm-owner").value || "root";
    var group = document.getElementById("sm-group").value || "root";

    var smbEnabled    = document.getElementById("sm-smb-enabled").checked;
    var nfsEnabled    = document.getElementById("sm-nfs-enabled").checked;
    var wasSmbEnabled = _shareModalData && !!_shareModalData.smb;
    var wasNfsEnabled = _shareModalData && !!_shareModalData.nfs;

    var cmds = [];

    // 1. Ensure directory exists with correct permissions
    cmds.push(
        "mkdir -p " + path +
        " && chmod " + chmod + " " + path +
        " && chown " + owner + ":" + group + " " + path
    );

    // 2. SMB
    if (smbEnabled) {
        var access     = document.getElementById("sm-smb-access").value;
        var guestOk    = access === "public" ? "yes" : "no";
        var browseable = document.getElementById("sm-smb-browseable").value;
        var writable   = document.getElementById("sm-smb-writable").value;
        var checkedUsers  = document.querySelectorAll("#sm-smb-users input:checked");
        var validUsers    = Array.from(checkedUsers).map(function(cb) { return cb.value; }).join(" ");

        // Delete old section (idempotent), then append fresh block
        cmds.push(
            "sed -i '/^\\[" + name + "\\]/,/^\\[/{/^\\[" + name + "\\]/d;/^\\[/!d}' /etc/samba/smb.conf"
        );
        cmds.push(
            "printf '\\n[" + name + "]\\n" +
            "path = " + path + "\\n" +
            "browseable = " + browseable + "\\n" +
            "writable = " + writable + "\\n" +
            "guest ok = " + guestOk +
            (validUsers ? "\\nvalid users = " + validUsers : "") +
            "\\n' >> /etc/samba/smb.conf"
        );
        cmds.push("systemctl reload smbd");
    } else if (wasSmbEnabled) {
        // Remove section
        cmds.push(
            "sed -i '/^\\[" + name + "\\]/,/^\\[/{/^\\[" + name + "\\]/d;/^\\[/!d}' /etc/samba/smb.conf" +
            " && systemctl reload smbd"
        );
    }

    // 3. NFS
    if (nfsEnabled) {
        var clients   = document.getElementById("sm-nfs-clients").value.trim() || "*";
        var nfsAccess = document.getElementById("sm-nfs-access").value;
        var squash    = document.getElementById("sm-nfs-squash").value;
        var opts      = nfsAccess + ",sync,no_subtree_check," + squash + ",insecure";
        var exportLine = path + " " + clients + "(" + opts + ")";

        cmds.push("sed -i '\\|^" + path + " |d' /etc/exports");
        cmds.push("echo '" + exportLine + "' >> /etc/exports");
        cmds.push("exportfs -ra");
        if (!wasNfsEnabled) {
            cmds.push("systemctl enable --now nfs-server 2>/dev/null || true");
        }
    } else if (wasNfsEnabled) {
        cmds.push("sed -i '\\|^" + path + " |d' /etc/exports && exportfs -ra");
    }

    cockpit.spawn(["bash", "-c", cmds.join(" && ")], { superuser: "require", err: "message" })
    .done(function() {
        closeModal("share-modal");
        loadAllShares();
    })
    .fail(function(err) { alert("Ошибка сохранения: " + err); });
}

// ─── Delete share entry ───────────────────────────────────────────────────────

function deleteShareEntry(shareData) {
    var protocols = [];
    if (shareData.smb) protocols.push("SMB");
    if (shareData.nfs) protocols.push("NFS");

    var msg = "Удалить шару «" + shareData.name + "»" +
        (protocols.length ? " (" + protocols.join(", ") + ")" : "") +
        "?\n\nДиректория НЕ будет удалена, только конфигурация протоколов.";
    if (!confirm(msg)) return;

    var cmds = [];
    if (shareData.smb) {
        cmds.push(
            "sed -i '/^\\[" + shareData.name + "\\]/,/^\\[/{/^\\[" + shareData.name + "\\]/d;/^\\[/!d}' /etc/samba/smb.conf" +
            " && systemctl reload smbd"
        );
    }
    if (shareData.nfs) {
        cmds.push("sed -i '\\|^" + shareData.path + " |d' /etc/exports && exportfs -ra");
    }

    if (!cmds.length) { loadAllShares(); return; }

    cockpit.spawn(["bash", "-c", cmds.join(" && ")], { superuser: "require", err: "message" })
    .done(function() { loadAllShares(); })
    .fail(function(err) { alert("Ошибка удаления: " + err); });
}

// ─── iSCSI Redesign ──────────────────────────────────────────────────────────

var _iscsiState = { backstores: [], targets: [], loaded: false };
var _iscsiDeleteCtx = null;

/// Helper: run a targetcli command
function _tcli(args) {
    return new Promise(function(resolve, reject) {
        cockpit.spawn(["sudo", "targetcli"].concat(args), { err: "message" })
            .done(resolve).fail(reject);
    });
}

// Read and parse saveconfig.json (rtslib-fb saves to /etc/rtslib-fb-target/)
var _SAVECONFIG_PATH = "/etc/rtslib-fb-target/saveconfig.json";
function _readSaveconfig() {
    return new Promise(function(resolve, reject) {
        cockpit.spawn(["sudo", "cat", _SAVECONFIG_PATH], { err: "message" })
            .done(function(out) {
                try { resolve(JSON.parse(out)); }
                catch(e) { reject(new Error("Ошибка разбора saveconfig.json: " + e.message)); }
            })
            .fail(function(err) { reject(err); });
    });
}

// Parse saveconfig into _iscsiState
// Actual rtslib-fb JSON structure:
//   storage_objects: flat array, each with { name, plugin, dev, size, ... }
//   targets: flat array, each with { wwn, fabric, tpgs: [{ luns, node_acls, portals, ... }] }
function _iscsiLoadConfig(cfg) {
    var backstores = [];
    var targets = [];

    // First pass: collect lunUsage — which targets reference each backstore
    // lun.storage_object in JSON is "/backstores/fileio/backup1" — normalize to "fileio/backup1"
    var lunUsage = {};
    function _normStore(s) { return s.replace(/^\/backstores\//, ""); }
    (cfg.targets || []).forEach(function(tgt) {
        if (tgt.fabric !== "iscsi") return;
        var iqn = tgt.wwn;
        (tgt.tpgs || []).forEach(function(tpg) {
            (tpg.luns || []).forEach(function(lun) {
                var stor = _normStore(lun.storage_object || "");
                if (!lunUsage[stor]) lunUsage[stor] = [];
                if (lunUsage[stor].indexOf(iqn) === -1) lunUsage[stor].push(iqn);
            });
        });
    });

    // Parse backstores (flat list in storage_objects)
    (cfg.storage_objects || []).forEach(function(so) {
        var type = so.plugin || "fileio";
        var key = type + "/" + so.name;
        var sizeBytes = so.size || 0;
        var sizeMB = Math.round(sizeBytes / 1024 / 1024);
        var sizeStr = sizeMB >= 1024 ? (sizeMB / 1024).toFixed(1) + " ГБ" : sizeMB + " МБ";
        backstores.push({
            name: so.name,
            type: type,
            dev: so.dev || so.udev_path || "",
            file: (type === "fileio") ? (so.dev || "") : "",
            size: sizeStr,
            sizeRaw: sizeBytes,
            inUseBy: lunUsage[key] || []
        });
    });

    // Parse targets (flat list in targets, fabric="iscsi")
    (cfg.targets || []).forEach(function(tgt) {
        if (tgt.fabric !== "iscsi") return;
        var iqn = tgt.wwn;
        var tpgs = tgt.tpgs || [];
        var tpg = tpgs[0] || {};
        var luns = (tpg.luns || []).map(function(l) {
            return { index: l.index, storage_object: _normStore(l.storage_object || "") };
        });
        var acls = (tpg.node_acls || []).map(function(a) { return a.node_wwn; });
        var portals = (tpg.portals || []).map(function(p) { return p.ip_address + ":" + p.port; });
        var allowAll = !acls.length;
        targets.push({ iqn: iqn, luns: luns, acls: acls, portals: portals, allowAll: allowAll });
    });

    _iscsiState.backstores = backstores;
    _iscsiState.targets = targets;
}

function loadISCSI() {
    var lb = document.getElementById("luns-body");
    var tb = document.getElementById("targets-body");
    lb.innerHTML = "<tr><td colspan='6'>Загрузка...</td></tr>";
    tb.innerHTML = "<tr><td colspan='5'>Загрузка...</td></tr>";

    // Always save first to ensure saveconfig.json is fresh and exists
    _tcli(["saveconfig"])
    .then(function() { return _readSaveconfig(); })
    .then(function(cfg) {
        _iscsiLoadConfig(cfg);
        _iscsiState.loaded = true;
        renderLunsTable(_iscsiState.backstores);
        renderTargetsTable(_iscsiState.targets);
    })
    .catch(function(err) {
        var msg = "<tr><td colspan='6' class='text-muted'>Ошибка: " + (err.message || err) + "</td></tr>";
        lb.innerHTML = msg;
        tb.innerHTML = "<tr><td colspan='5' class='text-muted'>Ошибка загрузки конфигурации</td></tr>";
    });
}

function renderLunsTable(backstores) {
    var tbody = document.getElementById("luns-body");
    if (!backstores.length) {
        tbody.innerHTML = "<tr><td colspan='6' class='text-muted'>Нет LUN / хранилищ</td></tr>";
        return;
    }
    tbody.innerHTML = backstores.map(function(bs) {
        var devCell = bs.type === "fileio" ? bs.file : bs.dev;
        var usedBy = bs.inUseBy.length ? bs.inUseBy.map(function(iqn) {
            // Show only the suffix after last ':'
            return iqn.split(":").pop();
        }).join(", ") : "—";
        var inUse = bs.inUseBy.length > 0;
        var delBtn = inUse
            ? "<button class='btn btn-danger btn-sm' disabled title='Используется в: " + bs.inUseBy.join(", ") + "'>Удалить</button>"
            : "<button class='btn btn-danger btn-sm lun-del-btn' data-name='" + _esc(bs.name) + "' data-type='" + _esc(bs.type) + "' data-file='" + _esc(bs.file) + "'>Удалить</button>";
        return "<tr>" +
            "<td><strong>" + _esc(bs.name) + "</strong></td>" +
            "<td><code>" + _esc(bs.type) + "</code></td>" +
            "<td style='font-size:12px'>" + _esc(devCell) + "</td>" +
            "<td>" + bs.size + "</td>" +
            "<td>" + _esc(usedBy) + "</td>" +
            "<td>" + delBtn + "</td>" +
            "</tr>";
    }).join("");
    tbody.querySelectorAll(".lun-del-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            confirmDeleteLun({ name: this.dataset.name, type: this.dataset.type, file: this.dataset.file });
        });
    });
}

function renderTargetsTable(targets) {
    var tbody = document.getElementById("targets-body");
    if (!targets.length) {
        tbody.innerHTML = "<tr><td colspan='5' class='text-muted'>Нет iSCSI targets</td></tr>";
        return;
    }
    tbody.innerHTML = targets.map(function(t) {
        var lunNames = t.luns.length
            ? t.luns.map(function(l) { return "LUN" + l.index + " (" + l.storage_object.split("/").pop() + ")"; }).join(", ")
            : "—";
        var portals = t.portals.length ? t.portals.join(", ") : "0.0.0.0:3260";
        var acls = t.allowAll || !t.acls.length ? "Все" : t.acls.length + " ACL";
        return "<tr>" +
            "<td style='font-size:12px'>" + _esc(t.iqn) + "</td>" +
            "<td>" + _esc(lunNames) + "</td>" +
            "<td>" + _esc(portals) + "</td>" +
            "<td>" + acls + "</td>" +
            "<td>" +
                "<button class='btn btn-default btn-sm target-edit-btn' data-iqn='" + _esc(t.iqn) + "' style='margin-right:4px'>Изменить</button>" +
                "<button class='btn btn-danger btn-sm target-del-btn' data-iqn='" + _esc(t.iqn) + "'>Удалить</button>" +
            "</td>" +
            "</tr>";
    }).join("");
    tbody.querySelectorAll(".target-del-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var t = _iscsiState.targets.filter(function(x) { return x.iqn === btn.dataset.iqn; })[0];
            if (t) confirmDeleteTarget(t);
        });
    });
    tbody.querySelectorAll(".target-edit-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var t = _iscsiState.targets.filter(function(x) { return x.iqn === btn.dataset.iqn; })[0];
            if (t) openTargetModal(t);
        });
    });
}

// Escape for HTML attribute/content
function _esc(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── LUN Modal ────────────────────────────────────────────────────────────────

function openLunModal(existing) {
    document.getElementById("lun-name").value = existing ? existing.name : "";
    document.getElementById("lun-name").disabled = !!existing;
    document.getElementById("lun-type").value = existing ? existing.type : "fileio";
    document.getElementById("lun-filepath").value = existing ? existing.file : "/mnt/data/iscsi/";
    document.getElementById("lun-size").value = 10;
    document.getElementById("lun-blockdev").value = existing ? existing.dev : "";
    document.getElementById("lun-create-file").checked = true;
    document.getElementById("lun-modal-title").textContent = existing ? "Изменить LUN" : "Создать LUN";
    document.getElementById("btn-lun-save").textContent = existing ? "Сохранить" : "Создать";
    _iscsiToggleLunType();
    showModal("iscsi-lun-modal");
}

function _iscsiToggleLunType() {
    var t = document.getElementById("lun-type").value;
    document.getElementById("lun-fileio-fields").style.display = t === "fileio" ? "" : "none";
    document.getElementById("lun-block-fields").style.display  = t === "block"  ? "" : "none";
}

function saveLun() {
    var name = document.getElementById("lun-name").value.trim();
    var type = document.getElementById("lun-type").value;
    if (!name) { alert("Введите имя LUN"); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) { alert("Имя должно содержать только буквы, цифры, _ и -"); return; }

    var p;
    if (type === "fileio") {
        var filePath = document.getElementById("lun-filepath").value.trim();
        var size = parseInt(document.getElementById("lun-size").value) || 10;
        var createFile = document.getElementById("lun-create-file").checked;
        if (!filePath) { alert("Укажите путь к файлу"); return; }
        var dir = filePath.substring(0, filePath.lastIndexOf("/"));
        var mkdirP = dir
            ? new Promise(function(res, rej) { cockpit.spawn(["sudo", "mkdir", "-p", dir], { err: "message" }).done(res).fail(rej); })
            : Promise.resolve();
        p = mkdirP.then(function() {
            return _tcli(["/backstores/fileio", "create", "name=" + name, "file_or_dev=" + filePath, "size=" + size + "G"]);
        });
    } else {
        var dev = document.getElementById("lun-blockdev").value.trim();
        if (!dev) { alert("Укажите блочное устройство"); return; }
        p = _tcli(["/backstores/block", "create", "name=" + name, "dev=" + dev]);
    }

    p.then(function() { return _tcli(["saveconfig"]); })
    .then(function() {
        closeModal("iscsi-lun-modal");
        loadISCSI();
    })
    .catch(function(err) { alert("Ошибка создания LUN: " + (err.message || err)); });
}

// ── LUN Delete ───────────────────────────────────────────────────────────────

function confirmDeleteLun(bs) {
    _iscsiDeleteCtx = { type: "lun", data: bs };
    document.getElementById("iscsi-delete-msg").textContent =
        "Удалить LUN «" + bs.name + "» (" + bs.type + ")? Конфигурация цели не затрагивается.";
    var fileRow = document.getElementById("iscsi-delete-file-row");
    var fileChk = document.getElementById("iscsi-delete-file-chk");
    if (bs.type === "fileio" && bs.file) {
        fileRow.style.display = "";
        fileRow.querySelector("label").lastChild.textContent = " Удалить файл " + bs.file;
        fileChk.checked = false;
    } else {
        fileRow.style.display = "none";
        fileChk.checked = false;
    }
    showModal("iscsi-delete-modal");
}

function _iscsiExecuteDeleteLun() {
    if (!_iscsiDeleteCtx || _iscsiDeleteCtx.type !== "lun") return;
    var bs = _iscsiDeleteCtx.data;
    var deleteFile = document.getElementById("iscsi-delete-file-chk").checked;
    closeModal("iscsi-delete-modal");

    _tcli(["/" + (bs.type === "fileio" ? "backstores/fileio" : "backstores/block"), "delete", bs.name])
    .then(function() {
        if (deleteFile && bs.file) {
            return new Promise(function(res, rej) {
                cockpit.spawn(["sudo", "rm", "-f", bs.file], { err: "message" }).done(res).fail(rej);
            });
        }
    })
    .then(function() { return _tcli(["saveconfig"]); })
    .then(function() { loadISCSI(); })
    .catch(function(err) { alert("Ошибка удаления LUN: " + (err.message || err)); });
}

// ── Target Modal ─────────────────────────────────────────────────────────────

function openTargetModal(existing) {
    var ts = Math.floor(Date.now() / 1000);
    var defIqn = "iqn.2026-03.com.rusnas:target-" + ts;
    document.getElementById("target-iqn").value = existing ? existing.iqn : defIqn;
    document.getElementById("target-iqn").disabled = !!existing;
    document.getElementById("target-modal-title").textContent = existing ? "Изменить Target" : "Создать iSCSI Target";
    document.getElementById("btn-target-save").textContent = existing ? "Сохранить" : "Создать";
    document.getElementById("target-chap-user").value = "";
    document.getElementById("target-chap-pass").value = "";

    // ACL
    var allowAll = existing ? existing.allowAll : true;
    document.getElementById("target-allow-all").checked = allowAll;
    document.getElementById("target-acl-fields").style.display = allowAll ? "none" : "";
    document.getElementById("target-acls").value = existing && existing.acls.length ? existing.acls.join("\n") : "";

    // LUN checklist
    var checklist = document.getElementById("target-lun-checklist");
    var existingLunStores = existing ? existing.luns.map(function(l) { return l.storage_object; }) : [];
    if (!_iscsiState.backstores.length) {
        checklist.innerHTML = "<span class='text-muted'>Нет доступных LUN. Создайте хранилище сначала.</span>";
    } else {
        checklist.innerHTML = _iscsiState.backstores.map(function(bs, i) {
            var storePath = bs.type + "/" + bs.name;
            var checked = existingLunStores.indexOf(storePath) !== -1 ? "checked" : "";
            return "<label style='display:flex;align-items:center;gap:8px;padding:2px 0'>" +
                "<input type='checkbox' class='target-lun-chk' data-store='" + _esc(storePath) + "' data-name='" + _esc(bs.name) + "' data-type='" + _esc(bs.type) + "' " + checked + ">" +
                _esc(bs.name) + " <span class='text-muted'>(" + bs.type + ", " + bs.size + ")</span>" +
                "</label>";
        }).join("");
    }

    showModal("iscsi-target-modal");
}

function saveTarget() {
    var iqn = document.getElementById("target-iqn").value.trim();
    var isEdit = document.getElementById("target-iqn").disabled;
    if (!iqn) { alert("Введите IQN"); return; }

    var allowAll = document.getElementById("target-allow-all").checked;
    var aclText = document.getElementById("target-acls").value.trim();
    var acls = allowAll ? [] : aclText.split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
    var chapUser = document.getElementById("target-chap-user").value.trim();
    var chapPass = document.getElementById("target-chap-pass").value.trim();

    var checkedLuns = [];
    document.querySelectorAll(".target-lun-chk:checked").forEach(function(chk) {
        checkedLuns.push({ store: chk.dataset.store, name: chk.dataset.name, type: chk.dataset.type });
    });

    var p = Promise.resolve();

    if (!isEdit) {
        p = p.then(function() { return _tcli(["/iscsi", "create", iqn]); });
    }

    // Set authentication mode
    if (allowAll) {
        p = p.then(function() { return _tcli(["/iscsi/" + iqn + "/tpg1", "set", "attribute", "authentication=0"]); });
        p = p.then(function() { return _tcli(["/iscsi/" + iqn + "/tpg1", "set", "attribute", "generate_node_acls=1"]); });
    } else {
        p = p.then(function() { return _tcli(["/iscsi/" + iqn + "/tpg1", "set", "attribute", "authentication=0"]); });
        p = p.then(function() { return _tcli(["/iscsi/" + iqn + "/tpg1", "set", "attribute", "generate_node_acls=0"]); });
    }

    // Add LUN mappings
    checkedLuns.forEach(function(lun) {
        p = p.then(function() {
            return _tcli(["/iscsi/" + iqn + "/tpg1/luns", "create", "/backstores/" + lun.store]);
        });
    });

    // Add ACLs
    acls.forEach(function(acl) {
        p = p.then(function() {
            return _tcli(["/iscsi/" + iqn + "/tpg1/acls", "create", acl]);
        });
    });

    // CHAP credentials
    if (chapUser && chapPass) {
        p = p.then(function() {
            return _tcli(["/iscsi/" + iqn + "/tpg1", "set", "auth", "userid=" + chapUser, "password=" + chapPass]);
        });
    }

    p.then(function() { return _tcli(["saveconfig"]); })
    .then(function() {
        closeModal("iscsi-target-modal");
        loadISCSI();
    })
    .catch(function(err) { alert("Ошибка сохранения Target: " + (err.message || err)); });
}

// ── Target Delete ────────────────────────────────────────────────────────────

function confirmDeleteTarget(target) {
    _iscsiDeleteCtx = { type: "target", data: target };
    var suffix = target.iqn.split(":").pop();
    document.getElementById("iscsi-delete-msg").textContent =
        "Удалить target «" + suffix + "»? Файлы LUN останутся на диске.";
    document.getElementById("iscsi-delete-file-row").style.display = "none";
    document.getElementById("iscsi-delete-file-chk").checked = false;
    showModal("iscsi-delete-modal");
}

function _iscsiExecuteDeleteTarget() {
    if (!_iscsiDeleteCtx || _iscsiDeleteCtx.type !== "target") return;
    var iqn = _iscsiDeleteCtx.data.iqn;
    closeModal("iscsi-delete-modal");

    _tcli(["/iscsi", "delete", iqn])
    .then(function() { return _tcli(["saveconfig"]); })
    .then(function() { loadISCSI(); })
    .catch(function(err) { alert("Ошибка удаления Target: " + (err.message || err)); });
}

function closeIscsiDeleteModal() {
    closeModal("iscsi-delete-modal");
    _iscsiDeleteCtx = null;
}

// ─── FileBrowser Management ───────────────────────────────────────────────────

var FB_SCRIPTS = "/usr/share/cockpit/rusnas";
var _fbUserModalData = null;

function loadFbStatus() {
    var badge = document.getElementById("fb-status-badge");
    var btnStart = document.getElementById("btn-fb-start");
    var btnStop  = document.getElementById("btn-fb-stop");
    var openLink = document.getElementById("fb-open-link");
    if (!badge) return;

    cockpit.spawn(["sudo", "-n", "systemctl", "is-active", "rusnas-filebrowser"],
        { err: "message" })
    .done(function(out) {
        var active = out.trim() === "active";
        badge.className = "badge " + (active ? "badge-success" : "badge-danger");
        badge.textContent = active ? "● Работает" : "● Остановлен";
        if (btnStart) btnStart.disabled = active;
        if (btnStop)  btnStop.disabled  = !active;
        if (openLink) openLink.style.display = active ? "" : "none";
    })
    .fail(function() {
        badge.className = "badge badge-secondary";
        badge.textContent = "● Неизвестно";
    });
}

function startStopFb(action) {
    cockpit.spawn(["sudo", "-n", "systemctl", action, "rusnas-filebrowser"],
        { err: "message" })
    .done(function() {
        setTimeout(function() { loadFbStatus(); loadFileBrowserUsers(); }, 1500);
    })
    .fail(function(err) { alert("Ошибка: " + err); });
}

function loadFileBrowserUsers() {
    var wrap = document.getElementById("fb-users-wrap");
    if (!wrap) return;
    wrap.innerHTML = "<tr><td colspan='5'>Загрузка...</td></tr>";

    cockpit.spawn(["sudo", "-n", "python3", FB_SCRIPTS + "/cgi/fb-users-list.py"],
        { err: "message" })
    .done(function(out) {
        try {
            var data = JSON.parse(out);
            if (!data.ok) {
                wrap.innerHTML = "<tr><td colspan='5' class='text-muted'>" +
                    (data.error || "Сервис недоступен") + "</td></tr>";
                return;
            }
            renderFbUsersTable(data.users || []);
        } catch(e) {
            wrap.innerHTML = "<tr><td colspan='5' class='text-muted'>Ошибка разбора ответа</td></tr>";
        }
    })
    .fail(function(err) {
        wrap.innerHTML = "<tr><td colspan='5' class='text-muted'>Ошибка: " + err + "</td></tr>";
    });
}

function renderFbUsersTable(users) {
    var wrap = document.getElementById("fb-users-wrap");
    if (!wrap) return;
    if (!users.length) {
        wrap.innerHTML = "<tr><td colspan='5' class='text-muted'>Нет пользователей</td></tr>";
        return;
    }
    wrap.innerHTML = users.map(function(u) {
        var scope = u.scope || "/";
        var wanBadge = u.wan_enabled
            ? "<span class='badge badge-success'>Да</span>"
            : "<span class='badge badge-secondary'>Нет</span>";
        var adminBadge = u.is_admin ? " <span class='badge badge-warning'>admin</span>" : "";
        return "<tr>" +
            "<td><b>" + u.username + "</b>" + adminBadge + "</td>" +
            "<td><code style='font-size:11px;'>" + scope + "</code></td>" +
            "<td>" + wanBadge + "</td>" +
            "<td>" +
                (u.can_download ? "⬇" : "") +
                (u.can_upload   ? " ⬆" : "") +
                (u.can_delete   ? " 🗑" : "") +
            "</td>" +
            "<td>" +
                "<button class='btn btn-secondary btn-sm fb-edit-user-btn' " +
                    "data-username='" + u.username + "' " +
                    "data-scope='" + scope + "' " +
                    "data-wan='"  + (u.wan_enabled   ? "1" : "0") + "' " +
                    "data-dl='"   + (u.can_download  ? "1" : "0") + "' " +
                    "data-ul='"   + (u.can_upload    ? "1" : "0") + "' " +
                    "data-del='"  + (u.can_delete    ? "1" : "0") + "'>Настройки</button>" +
            "</td>" +
            "</tr>";
    }).join("");

    wrap.querySelectorAll(".fb-edit-user-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            openFbUserModal(this.dataset.username, {
                scope:       this.dataset.scope,
                wan_enabled: this.dataset.wan  === "1",
                can_download:this.dataset.dl   === "1",
                can_upload:  this.dataset.ul   === "1",
                can_delete:  this.dataset.del  === "1"
            });
        });
    });
}

function openFbUserModal(username, data) {
    _fbUserModalData = { username: username, data: data };
    document.getElementById("fb-modal-username").textContent = username;
    document.getElementById("fb-modal-scope").value    = data.scope || "/";
    document.getElementById("fb-modal-wan").checked    = !!data.wan_enabled;
    document.getElementById("fb-modal-dl").checked     = data.can_download !== false;
    document.getElementById("fb-modal-ul").checked     = data.can_upload   !== false;
    document.getElementById("fb-modal-del").checked    = data.can_delete   !== false;
    showModal("fb-user-modal");
}

function saveFbUserAccess() {
    if (!_fbUserModalData) return;
    var username = _fbUserModalData.username;
    var scope    = document.getElementById("fb-modal-scope").value.trim() || "/";
    var wan      = document.getElementById("fb-modal-wan").checked ? "1" : "0";
    var dl       = document.getElementById("fb-modal-dl").checked  ? "1" : "0";
    var ul       = document.getElementById("fb-modal-ul").checked  ? "1" : "0";
    var del      = document.getElementById("fb-modal-del").checked ? "1" : "0";

    cockpit.spawn(
        ["sudo", "-n", "python3", FB_SCRIPTS + "/cgi/fb-set-user-access.py",
         username, scope, wan, dl, ul, del],
        { err: "message" }
    )
    .done(function(out) {
        try {
            var r = JSON.parse(out);
            if (!r.ok) { alert("Ошибка: " + (r.error || "неизвестно")); return; }
        } catch(e) {}
        closeModal("fb-user-modal");
        loadFileBrowserUsers();
    })
    .fail(function(err) { alert("Ошибка: " + err); });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {

    setupStorageTabs();
    setupShareModalTabs();

    // Shares tab
    document.getElementById("btn-add-share").addEventListener("click", function() {
        openShareModal(null);
    });
    document.getElementById("btn-sm-save").addEventListener("click", saveShareModal);
    document.getElementById("btn-sm-cancel").addEventListener("click", function() {
        closeModal("share-modal");
    });

    // iSCSI tab — LUN
    document.getElementById("btn-add-lun").addEventListener("click", function() { openLunModal(null); });
    document.getElementById("btn-lun-save").addEventListener("click", saveLun);
    document.getElementById("btn-lun-cancel").addEventListener("click", function() { closeModal("iscsi-lun-modal"); });
    document.getElementById("lun-type").addEventListener("change", _iscsiToggleLunType);

    // iSCSI tab — Target
    document.getElementById("btn-add-target").addEventListener("click", function() { openTargetModal(null); });
    document.getElementById("btn-target-save").addEventListener("click", saveTarget);
    document.getElementById("btn-target-cancel").addEventListener("click", function() { closeModal("iscsi-target-modal"); });
    document.getElementById("target-allow-all").addEventListener("change", function() {
        document.getElementById("target-acl-fields").style.display = this.checked ? "none" : "";
    });

    // iSCSI tab — Delete confirmation
    document.getElementById("iscsi-delete-confirm-btn").addEventListener("click", function() {
        if (!_iscsiDeleteCtx) return;
        if (_iscsiDeleteCtx.type === "lun") _iscsiExecuteDeleteLun();
        else _iscsiExecuteDeleteTarget();
    });
    document.getElementById("iscsi-delete-cancel-btn").addEventListener("click", closeIscsiDeleteModal);

    // WORM tab
    document.getElementById("btn-worm-refresh").addEventListener("click", loadWormStatus);
    document.getElementById("btn-add-worm").addEventListener("click", openAddWormModal);
    document.getElementById("btn-worm-add-confirm").addEventListener("click", confirmAddWorm);
    document.getElementById("btn-worm-add-cancel").addEventListener("click", function() {
        closeModal("add-worm-modal");
    });
    document.getElementById("btn-worm-browse").addEventListener("click", wormBrowsePath);
    document.getElementById("worm-grace-select").addEventListener("change", function() {
        document.getElementById("worm-grace-custom-wrap").classList.toggle("hidden", this.value !== "custom");
    });
    document.getElementById("worm-path-input").addEventListener("input", function() {
        checkWormSambaMatch(this.value.trim());
    });

    // Services tab
    document.getElementById("btn-ftp-start").addEventListener("click", function() {
        cockpit.spawn(["bash", "-c", "sudo systemctl start vsftpd"], { superuser: "require", err: "message" })
        .done(function() { loadFtp(); });
    });
    document.getElementById("btn-ftp-stop").addEventListener("click", function() {
        cockpit.spawn(["bash", "-c", "sudo systemctl stop vsftpd"], { superuser: "require", err: "message" })
        .done(function() { loadFtp(); });
    });
    document.getElementById("btn-ftp-save").addEventListener("click", saveFtp);

    document.getElementById("btn-webdav-start").addEventListener("click", function() {
        cockpit.spawn(["bash", "-c", "sudo systemctl start apache2"], { superuser: "require", err: "message" })
        .done(function() { loadWebdav(); });
    });
    document.getElementById("btn-webdav-stop").addEventListener("click", function() {
        cockpit.spawn(["bash", "-c", "sudo systemctl stop apache2"], { superuser: "require", err: "message" })
        .done(function() { loadWebdav(); });
    });
    document.getElementById("btn-webdav-save").addEventListener("click", saveWebdav);
    document.getElementById("btn-webdav-add-user").addEventListener("click", addWebdavUser);

    // FileBrowser tab
    var btnFbStart = document.getElementById("btn-fb-start");
    var btnFbStop  = document.getElementById("btn-fb-stop");
    var btnFbSave  = document.getElementById("btn-fb-user-save");
    var btnFbCancel= document.getElementById("btn-fb-user-cancel");
    if (btnFbStart)  btnFbStart.addEventListener("click", function() { startStopFb("start"); });
    if (btnFbStop)   btnFbStop.addEventListener("click",  function() { startStopFb("stop"); });
    if (btnFbSave)   btnFbSave.addEventListener("click",  saveFbUserAccess);
    if (btnFbCancel) btnFbCancel.addEventListener("click", function() { closeModal("fb-user-modal"); });

    // Initial load
    loadAllShares();
    loadServiceStatus();
});

// ─── FTP (vsftpd) ─────────────────────────────────────────────────────────────

function loadFtp() {
    cockpit.spawn(["bash", "-c",
        "systemctl is-active vsftpd 2>/dev/null || true; echo '---'; " +
        "cat /etc/vsftpd.conf 2>/dev/null | grep -E '^(anonymous_enable|write_enable|chroot_local_user|pasv_min_port|pasv_max_port)\\s*=' || true; echo '---'; " +
        "cat /proc/net/tcp6 /proc/net/tcp 2>/dev/null | grep -c ' 00000000:7530 ' || echo 0"
    ], { superuser: "require", err: "message" })
    .done(function(out) {
        var parts = out.split("---\n");
        var active = (parts[0] || "").trim() === "active";
        var badge = document.getElementById("ftp-status-badge");
        badge.className = "badge " + (active ? "badge-success" : "badge-danger");
        badge.textContent = active ? "✅ Активен" : "🔴 Остановлен";

        var cfg = {};
        (parts[1] || "").trim().split("\n").filter(Boolean).forEach(function(line) {
            var m = line.match(/^(\w+)\s*=\s*(.+)/);
            if (m) cfg[m[1].trim()] = m[2].trim().toUpperCase();
        });
        document.getElementById("ftp-anonymous").checked = cfg.anonymous_enable === "YES";
        document.getElementById("ftp-write").checked     = cfg.write_enable !== "NO";
        document.getElementById("ftp-chroot").checked    = cfg.chroot_local_user === "YES";
        document.getElementById("ftp-pasv-min").value    = cfg.pasv_min_port || "30000";
        document.getElementById("ftp-pasv-max").value    = cfg.pasv_max_port || "30100";

        var conns = parseInt((parts[2] || "").trim()) || 0;
        document.getElementById("ftp-connections").textContent =
            conns > 0 ? conns + " активных соединений" : "Нет активных соединений";
    });
}

function saveFtp() {
    var anon    = document.getElementById("ftp-anonymous").checked ? "YES" : "NO";
    var write   = document.getElementById("ftp-write").checked     ? "YES" : "NO";
    var chroot  = document.getElementById("ftp-chroot").checked    ? "YES" : "NO";
    var pasvMin = document.getElementById("ftp-pasv-min").value || "30000";
    var pasvMax = document.getElementById("ftp-pasv-max").value || "30100";

    cockpit.spawn(["bash", "-c",
        "python3 << 'PYEOF'\n" +
        "import re\n" +
        "f = open('/etc/vsftpd.conf'); c = f.read(); f.close()\n" +
        "opts = {'anonymous_enable':'" + anon + "','write_enable':'" + write + "',\n" +
        "        'chroot_local_user':'" + chroot + "','allow_writeable_chroot':'" + chroot + "',\n" +
        "        'pasv_min_port':'" + pasvMin + "','pasv_max_port':'" + pasvMax + "'}\n" +
        "for k,v in opts.items():\n" +
        "    if re.search(r'^' + k + r'\\s*=', c, re.M): c = re.sub(r'^' + k + r'\\s*=.*$', k+'='+v, c, flags=re.M)\n" +
        "    else: c += k+'='+v+'\\n'\n" +
        "open('/etc/vsftpd.conf','w').write(c)\n" +
        "PYEOF\n" +
        "systemctl restart vsftpd"
    ], { superuser: "require", err: "message" })
    .done(function() { loadFtp(); })
    .fail(function(e) { alert("Ошибка сохранения FTP: " + e); });
}

// ─── WebDAV (Apache) ──────────────────────────────────────────────────────────

var WEBDAV_CONF = "/etc/apache2/sites-enabled/webdav.conf";
var WEBDAV_PASS = "/etc/apache2/webdav.passwords";

function loadWebdav() {
    cockpit.spawn(["bash", "-c",
        "systemctl is-active apache2 2>/dev/null || true; echo '---'; " +
        "cat " + WEBDAV_CONF + " 2>/dev/null; echo '---'; " +
        "cat " + WEBDAV_PASS + " 2>/dev/null | cut -d: -f1 | sort -u || true"
    ], { superuser: "require", err: "message" })
    .done(function(out) {
        var parts = out.split("---\n");
        var active = (parts[0] || "").trim() === "active";
        var badge = document.getElementById("webdav-status-badge");
        badge.className = "badge " + (active ? "badge-success" : "badge-danger");
        badge.textContent = active ? "✅ Активен" : "🔴 Остановлен";

        var conf   = parts[1] || "";
        var aliasM = conf.match(/^Alias\s+(\S+)/m);
        var dirM   = conf.match(/<Directory\s+([^>]+?)>/m);
        document.getElementById("webdav-alias").value = aliasM ? aliasM[1] : "/webdav";
        document.getElementById("webdav-path").value  = dirM   ? dirM[1]   : "";

        var users  = (parts[2] || "").trim().split("\n").filter(Boolean);
        var listEl = document.getElementById("webdav-users-list");
        if (!users.length) {
            listEl.innerHTML = '<span class="text-muted">Пользователей нет</span>';
        } else {
            listEl.innerHTML = users.map(function(u) {
                return '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;">' +
                    '<span>' + u + '</span>' +
                    '<button class="btn btn-danger btn-sm webdav-del-user" data-user="' + u.replace(/"/g, "") + '">✕</button>' +
                    '</div>';
            }).join("");
            document.querySelectorAll(".webdav-del-user").forEach(function(btn) {
                btn.addEventListener("click", function() { removeWebdavUser(this.dataset.user); });
            });
        }
    });
}

function saveWebdav() {
    var alias = document.getElementById("webdav-alias").value.trim() || "/webdav";
    var path  = document.getElementById("webdav-path").value.trim();
    if (!path) { alert("Укажите путь к директории"); return; }

    var conf = "Alias " + alias + " " + path + "\n\n" +
        "<Directory " + path + ">\n" +
        "    DAV On\n" +
        "    Options Indexes\n" +
        "    AuthType Digest\n" +
        "    AuthName \"WebDAV\"\n" +
        "    AuthUserFile " + WEBDAV_PASS + "\n" +
        "    Require valid-user\n" +
        "    AllowOverride None\n" +
        "    Order allow,deny\n" +
        "    Allow from all\n" +
        "</Directory>\n";

    cockpit.spawn(["bash", "-c",
        "mkdir -p " + path + " && " +
        "tee " + WEBDAV_CONF + " << 'CONFEOF'\n" + conf + "CONFEOF\n" +
        "&& systemctl reload apache2"
    ], { superuser: "require", err: "message" })
    .done(function() { loadWebdav(); })
    .fail(function(e) { alert("Ошибка сохранения WebDAV: " + e); });
}

function addWebdavUser() {
    var user = document.getElementById("webdav-new-user").value.trim();
    var pass = document.getElementById("webdav-new-pass").value;
    if (!user || !pass) { alert("Укажите логин и пароль"); return; }

    cockpit.spawn(["bash", "-c",
        "htdigest -b " + WEBDAV_PASS + " WebDAV " + user + " " + pass +
        " 2>/dev/null || htdigest " + WEBDAV_PASS + " WebDAV " + user
    ], { superuser: "require", err: "message" })
    .done(function() {
        document.getElementById("webdav-new-user").value = "";
        document.getElementById("webdav-new-pass").value = "";
        loadWebdav();
    })
    .fail(function() {
        cockpit.spawn(["python3", "-c",
            "import hashlib, os\n" +
            "realm='WebDAV'\n" +
            "user='" + user.replace(/'/g, "") + "'\n" +
            "pw='" + pass.replace(/'/g, "") + "'\n" +
            "h=hashlib.md5((user+':'+realm+':'+pw).encode()).hexdigest()\n" +
            "line=user+':'+realm+':'+h+'\\n'\n" +
            "f='" + WEBDAV_PASS + "'\n" +
            "lines=[l for l in (open(f).readlines() if os.path.exists(f) else []) if not l.startswith(user+':')]\n" +
            "lines.append(line)\n" +
            "open(f,'w').writelines(lines)\n"
        ], { superuser: "require", err: "message" })
        .done(function() {
            document.getElementById("webdav-new-user").value = "";
            document.getElementById("webdav-new-pass").value = "";
            loadWebdav();
        });
    });
}

function removeWebdavUser(user) {
    if (!confirm("Удалить пользователя " + user + "?")) return;
    cockpit.spawn(["bash", "-c",
        "sed -i '/^" + user + ":/d' " + WEBDAV_PASS
    ], { superuser: "require", err: "message" })
    .done(function() { loadWebdav(); });
}

// ─── WriteOnce / WORM ─────────────────────────────────────────────────────────

var WORM_CONFIG = "/etc/rusnas/worm.json";
var WORM_BIN    = "/usr/local/bin/rusnas-worm";
var _wormConfig = { paths: [] };
var _wormStatus = {};

var GRACE_LABELS = {
    "3600":    "1 час",
    "28800":   "8 часов",
    "86400":   "1 день",
    "604800":  "7 дней",
    "2592000": "30 дней",
};

function graceLabel(sec) {
    return GRACE_LABELS[String(sec)] || (sec < 3600 ? Math.round(sec/60) + " мин"
        : sec < 86400 ? Math.round(sec/3600) + " ч"
        : Math.round(sec/86400) + " д");
}

function loadWorm() {
    cockpit.file(WORM_CONFIG, { superuser: "require" }).read()
        .then(function(content) {
            try { _wormConfig = JSON.parse(content || '{"paths":[]}'); }
            catch(e) { _wormConfig = { paths: [] }; }
            renderWorm();
            loadWormStatus();
        })
        .catch(function() {
            _wormConfig = { paths: [] };
            renderWorm();
        });
}

function renderWorm() {
    var tbody = document.getElementById("worm-body");
    var paths = (_wormConfig || {}).paths || [];
    if (!paths.length) {
        tbody.innerHTML = "<tr><td colspan='7' class='text-muted'>Нет настроенных WORM-путей. Нажмите «+ Добавить путь».</td></tr>";
        return;
    }
    tbody.innerHTML = paths.map(function(p, idx) {
        var st      = _wormStatus[p.path] || {};
        var statStr = st.total != null
            ? "<span style='color:#22aa44;'>🔒 " + st.locked + "</span>/" + st.total +
              (st.pending ? " <span style='color:#e68a00;font-size:11px;'>(+"+st.pending+" скоро)</span>" : "")
            : "<span class='text-muted' style='font-size:11px;'>—</span>";
        var modeTag = p.mode === "compliance"
            ? "<span class='badge badge-danger' style='font-size:11px;'>Compliance</span>"
            : "<span class='badge badge-secondary' style='font-size:11px;'>Normal</span>";
        var sambaTag = p.samba_vfs
            ? "<span style='color:#22aa44;font-size:12px;'>✅ вкл</span>"
            : "<span class='text-muted' style='font-size:12px;'>—</span>";
        var unlockBtn = (p.mode !== "compliance")
            ? "<button class='btn btn-secondary btn-sm' onclick='wormUnlockPrompt(\""+idx+"\")' title='Разблокировать файл/папку'>🔓</button> "
            : "";
        return "<tr>" +
            "<td><code style='font-size:12px;'>" + p.path + "</code></td>" +
            "<td style='white-space:nowrap;'>" + graceLabel(p.grace_period) + "</td>" +
            "<td>" + modeTag + "</td>" +
            "<td style='text-align:center;'>" + sambaTag + "</td>" +
            "<td>" + statStr + "</td>" +
            "<td style='text-align:center;'><input type='checkbox' " + (p.enabled !== false ? "checked" : "") +
                " onchange='toggleWormPath(" + idx + ",this.checked)'></td>" +
            "<td style='white-space:nowrap;'>" + unlockBtn +
                "<button class='btn btn-danger btn-sm' onclick='removeWormPath(" + idx + ")'>✕</button></td>" +
            "</tr>";
    }).join("");
}

function loadWormStatus() {
    var paths = ((_wormConfig || {}).paths || []).filter(function(p){ return p.enabled !== false; });
    if (!paths.length) return;
    cockpit.spawn(["sudo", "-n", WORM_BIN, "--status"], { err: "message" })
        .done(function(out) {
            try {
                var arr = JSON.parse(out);
                arr.forEach(function(s) { _wormStatus[s.path] = s; });
                renderWorm();
            } catch(e) {}
        });
}

function saveWormConfig(callback) {
    var content = JSON.stringify(_wormConfig, null, 2);
    cockpit.file(WORM_CONFIG, { superuser: "require" })
        .replace(content)
        .then(function() { if (callback) callback(); })
        .catch(function(e) { alert("Ошибка сохранения WORM config: " + e); });
}

function toggleWormPath(idx, enabled) {
    _wormConfig.paths[idx].enabled = enabled;
    saveWormConfig(function() {
        if (enabled) loadWormStatus();
        else renderWorm();
    });
}

function removeWormPath(idx) {
    var p = _wormConfig.paths[idx];
    if (!confirm("Удалить WORM-путь " + p.path + "?\n\nСуществующие заблокированные файлы останутся с chattr +i — разблокировка только вручную.")) return;
    if (p.samba_vfs) { removeSambaWorm(p.path); }
    _wormConfig.paths.splice(idx, 1);
    saveWormConfig(renderWorm);
}

function openAddWormModal() {
    document.getElementById("worm-path-input").value = "";
    document.getElementById("worm-grace-select").value = "86400";
    document.getElementById("worm-grace-custom-wrap").classList.add("hidden");
    document.getElementById("worm-samba-option").style.display = "none";
    document.getElementById("worm-add-error").classList.add("hidden");
    document.querySelectorAll("input[name='worm-mode']")[0].checked = true;
    document.getElementById("worm-samba-vfs").checked = true;

    var sugg = document.getElementById("worm-path-suggestions");
    sugg.innerHTML = "<span style='font-size:11px;color:#888;'>Загрузка путей…</span>";

    var paths = {};
    var pending = 2;
    function done() {
        if (--pending > 0) return;
        sugg.innerHTML = "";
        var sorted = Object.keys(paths).sort();
        if (!sorted.length) {
            sugg.innerHTML = "<span style='font-size:11px;color:#888;'>Нет доступных путей</span>";
            return;
        }
        sorted.forEach(function(p) {
            var chip = document.createElement("button");
            chip.className = "btn btn-secondary btn-sm";
            chip.style.cssText = "font-size:11px;padding:2px 8px;";
            chip.textContent = p + (paths[p] ? " (" + paths[p] + ")" : "");
            chip.addEventListener("click", function() {
                document.getElementById("worm-path-input").value = p;
                checkWormSambaMatch(p);
            });
            sugg.appendChild(chip);
        });
    }

    cockpit.spawn(["bash", "-c",
        "findmnt --real -o TARGET,FSTYPE --noheadings 2>/dev/null | grep -vE '^/ |/boot|/efi|tmpfs|swap|/run|/sys|/proc|/dev'; true"
    ], { err: "message" })
    .done(function(out) {
        out.trim().split("\n").filter(Boolean).forEach(function(line) {
            var p = line.trim().split(/\s+/);
            if (p[0]) paths[p[0]] = p[1] || "";
        });
    })
    .always(done);

    cockpit.spawn(["bash", "-c",
        "grep -E '^\\s*path\\s*=' /etc/samba/smb.conf 2>/dev/null | sed 's/.*=\\s*//'; true"
    ], { err: "message" })
    .done(function(out) {
        out.trim().split("\n").filter(Boolean).forEach(function(line) {
            var p = line.trim();
            if (p && !paths[p]) paths[p] = "SMB";
        });
    })
    .always(done);

    showModal("add-worm-modal");
}

function wormBrowsePath() {
    var cur  = document.getElementById("worm-path-input").value.trim() || "/mnt";
    var sugg = document.getElementById("worm-path-suggestions");
    sugg.innerHTML = "<span style='font-size:11px;color:#888;'>Загрузка…</span>";

    cockpit.spawn(["bash", "-c",
        "find " + JSON.stringify(cur) + " -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort; true"
    ], { err: "message" })
    .done(function(out) {
        sugg.innerHTML = "";
        var dirs = out.trim().split("\n").filter(Boolean);
        if (!dirs.length) {
            sugg.innerHTML = "<span style='font-size:11px;color:#888;'>Нет подпапок в " + cur + "</span>";
            return;
        }
        if (cur !== "/") {
            var up = document.createElement("button");
            up.className = "btn btn-secondary btn-sm";
            up.style.cssText = "font-size:11px;padding:2px 8px;";
            up.textContent = "↑ ..";
            up.addEventListener("click", function() {
                document.getElementById("worm-path-input").value = cur.replace(/\/[^/]+$/, "") || "/";
                wormBrowsePath();
            });
            sugg.appendChild(up);
        }
        dirs.forEach(function(d) {
            var chip = document.createElement("button");
            chip.className = "btn btn-secondary btn-sm";
            chip.style.cssText = "font-size:11px;padding:2px 8px;";
            chip.textContent = d.split("/").pop() + "/";
            chip.addEventListener("click", function() {
                document.getElementById("worm-path-input").value = d;
                checkWormSambaMatch(d);
                wormBrowsePath();
            });
            sugg.appendChild(chip);
        });
    });
}

function checkWormSambaMatch(path) {
    cockpit.spawn(["bash", "-c",
        "grep -r 'path\\s*=\\s*" + path.replace(/\//g, "\\/") + "' /etc/samba/smb.conf 2>/dev/null | head -1; true"
    ], { err: "message" })
    .done(function(out) {
        document.getElementById("worm-samba-option").style.display = out.trim() ? "block" : "none";
    });
}

function getWormGraceSeconds() {
    var sel = document.getElementById("worm-grace-select").value;
    if (sel === "custom") {
        var val  = parseInt(document.getElementById("worm-grace-custom-val").value) || 1;
        var unit = parseInt(document.getElementById("worm-grace-custom-unit").value) || 3600;
        return val * unit;
    }
    return parseInt(sel);
}

function confirmAddWorm() {
    var path  = document.getElementById("worm-path-input").value.trim();
    var errEl = document.getElementById("worm-add-error");
    errEl.classList.add("hidden");

    if (!path) {
        errEl.textContent = "Укажите путь";
        errEl.classList.remove("hidden");
        return;
    }
    if ((_wormConfig.paths || []).some(function(p){ return p.path === path; })) {
        errEl.textContent = "Этот путь уже добавлен";
        errEl.classList.remove("hidden");
        return;
    }

    var mode     = document.querySelector("input[name='worm-mode']:checked").value;
    var graceSec = getWormGraceSeconds();
    var sambaVfs = document.getElementById("worm-samba-vfs").checked &&
                   document.getElementById("worm-samba-option").style.display !== "none";

    _wormConfig.paths = _wormConfig.paths || [];
    _wormConfig.paths.push({ path: path, enabled: true, grace_period: graceSec, mode: mode, samba_vfs: sambaVfs });

    saveWormConfig(function() {
        closeModal("add-worm-modal");
        renderWorm();
        if (sambaVfs) {
            addSambaWorm(path, graceSec, function() { loadWormStatus(); });
        } else {
            loadWormStatus();
        }
    });
}

function wormUnlockPrompt(idx) {
    var p    = _wormConfig.paths[idx];
    var path = prompt("Разблокировать файл или папку (введите полный путь):\nБаза: " + p.path);
    if (!path) return;
    cockpit.spawn(["sudo", "-n", WORM_BIN, "--unlock", path], { err: "message" })
        .done(function(out) {
            try {
                var r = JSON.parse(out);
                if (r.ok) { alert("Разблокировано: " + r.path); loadWormStatus(); }
                else       { alert("Ошибка: " + (r.message || r.error)); }
            } catch(e) { alert("OK"); loadWormStatus(); }
        })
        .fail(function(e) { alert("Ошибка разблокировки: " + e); });
}

// ── Samba vfs_worm helpers ─────────────────────────────────────────────────────

function addSambaWorm(sharePath, gracePeriod, callback) {
    var script =
        "python3 << 'PYEOF'\n" +
        "import re\n" +
        "path = '" + sharePath.replace(/'/g, "") + "'\n" +
        "with open('/etc/samba/smb.conf') as f: conf = f.read()\n" +
        "conf2 = re.sub(\n" +
        "    r'(path\\s*=\\s*" + sharePath.replace(/\//g, "\\/").replace(/'/g, "") + "\\s*\\n)',\n" +
        "    r'\\1    vfs objects = worm\\n    worm:grace_period = " + gracePeriod + "\\n',\n" +
        "    conf, flags=re.M\n" +
        ")\n" +
        "if conf2 != conf:\n" +
        "    with open('/etc/samba/smb.conf', 'w') as f: f.write(conf2)\n" +
        "PYEOF\n" +
        "systemctl reload smbd 2>/dev/null || true";

    cockpit.spawn(["bash", "-c", script], { superuser: "require", err: "message" })
        .always(function() { if (callback) callback(); });
}

function removeSambaWorm(sharePath) {
    var script =
        "sed -i '/^\\s*vfs objects = worm/d; /^\\s*worm:grace_period/d' /etc/samba/smb.conf && " +
        "systemctl reload smbd 2>/dev/null || true";
    cockpit.spawn(["bash", "-c", script], { superuser: "require", err: "message" });
}
