// ─── Modal helpers ───────────────────────────────────────────────────────────

function showModal(id) {
    document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
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

function loadVolumeSelects(callback) {
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
            ["share-volume", "nfs-volume"].forEach(function(id) {
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

            ["share-volume", "nfs-volume"].forEach(function(id) {
                var sel = document.getElementById(id);
                if (sel) sel.innerHTML = html;
            });
            if (callback) callback(volumes[0].target);
        });
    }).catch(function() {
        ["share-volume", "nfs-volume"].forEach(function(id) {
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

// ─── SMB Shares ──────────────────────────────────────────────────────────────

function loadShares() {
    var tbody = document.getElementById("shares-body");
    tbody.innerHTML = "<tr><td colspan='5'>Загрузка...</td></tr>";
    var cmd = "python3 -c \"\nimport subprocess\nout=subprocess.check_output(['testparm','-s'],stderr=subprocess.DEVNULL,text=True)\nshare=None\nskip={'global','homes','printers','print\$'}\nfor line in out.splitlines():\n  line=line.strip()\n  if line.startswith('['):\n    name=line.strip('[]')\n    share=name if name not in skip else None\n  elif share and line.startswith('path ='):\n    print(share+'\\\\t'+line.split('=',1)[1].strip())\n\"";
    cockpit.spawn(
        ["bash", "-c", cmd],
        {superuser: "require", err: "message"}
    )
    .done(function(output) {
        var lines = output.trim().split("\n").filter(Boolean);
        if (lines.length === 0) {
            tbody.innerHTML = "<tr><td colspan='5'>Нет шар</td></tr>";
            return;
        }
        tbody.innerHTML = lines.map(function(line) {
            var parts = line.split("\t");
            var name = parts[0];
            var path = parts[1] || ("/mnt/data/shares/" + name);
            return "<tr>" +
                "<td>" + name + "</td>" +
                "<td>" + path + "</td>" +
                "<td>SMB</td>" +
                "<td class='status-active'>Активна</td>" +
                "<td>" +
                  "<button class='btn btn-secondary btn-sm edit-share' data-name='" + name + "'>Изменить</button> " +
                  "<button class='btn btn-danger btn-sm delete-share' data-name='" + name + "'>Удалить</button>" +
                "</td>" +
                "</tr>";
        }).join("");
        document.querySelectorAll(".delete-share").forEach(function(btn) {
            btn.addEventListener("click", function() { deleteShare(this.dataset.name); });
        });
        document.querySelectorAll(".edit-share").forEach(function(btn) {
            btn.addEventListener("click", function() { openEditShare(this.dataset.name); });
        });
    })
    .fail(function(err) {
        tbody.innerHTML = "<tr><td colspan='5'>Ошибка: " + err + "</td></tr>";
    });
}

function openEditShare(name) {
    var defaultPath = "/mnt/data/shares/" + name;

    function _showEditModal(sharePath, guestOk, browseable, writable, validUsers, chmod, owner, group) {
        document.getElementById("edit-share-name").value = name;
        document.getElementById("edit-share-path").value = sharePath;
        document.getElementById("edit-share-access").value = (guestOk === "yes") ? "public" : "private";
        document.getElementById("edit-share-browseable").value = (browseable === "no") ? "no" : "yes";
        document.getElementById("edit-share-writable").value = (writable === "no") ? "no" : "yes";
        document.getElementById("edit-share-chmod").value = chmod || "755";
        populateOwnerSelects("edit-share-owner", "edit-share-group", owner || "root", group || "root");
        populateUserCheckboxes("edit-share-users",
            validUsers ? validUsers.trim().split(/[\s,]+/).filter(Boolean) : []);
        showModal("edit-share-modal");
    }

    var cmd = "grep -A20 '^\\[" + name + "\\]' /etc/samba/smb.conf | grep -v '^\\[' | head -20";
    cockpit.spawn(["bash", "-c", cmd], {superuser: "require", err: "message"})
        .done(function(output) {
            var lines = (output || "").split("\n");
            function getVal(key, def) {
                var re = new RegExp("^\\s*" + key + "\\s*=\\s*(.+)", "i");
                for (var i = 0; i < lines.length; i++) {
                    var m = lines[i].match(re);
                    if (m) return m[1].trim();
                }
                return def;
            }
            var sharePath  = getVal("path", defaultPath);
            var guestOk    = getVal("guest ok", "no");
            var browseable = getVal("browseable", "yes");
            var writable   = getVal("writable", "yes");
            var validUsers = getVal("valid users", "");

            cockpit.spawn(["bash", "-c",
                "stat -c '%a %U %G' " + sharePath + " 2>/dev/null || echo '755 root root'"
            ], {superuser: "require", err: "message"})
            .done(function(statOut) {
                var parts = (statOut || "755 root root").trim().split(" ");
                _showEditModal(sharePath, guestOk, browseable, writable, validUsers,
                    parts[0], parts[1], parts[2]);
            })
            .fail(function() {
                _showEditModal(sharePath, guestOk, browseable, writable, validUsers,
                    "755", "root", "root");
            });
        })
        .fail(function() {
            // If we can't read smb.conf, show modal with defaults so user can still edit
            _showEditModal(defaultPath, "no", "yes", "yes", "", "755", "root", "root");
        });
}

function saveEditShare() {
    var name       = document.getElementById("edit-share-name").value.trim();
    var path       = document.getElementById("edit-share-path").value.trim();
    var access     = document.getElementById("edit-share-access").value;
    var browseable = document.getElementById("edit-share-browseable").value;
    var writable   = document.getElementById("edit-share-writable").value;
    var chmod      = document.getElementById("edit-share-chmod").value;
    var owner      = document.getElementById("edit-share-owner").value;
    var group      = document.getElementById("edit-share-group").value;
    var guestOk    = access === "public" ? "yes" : "no";

    var checkedUsers = document.querySelectorAll("#edit-share-users input:checked");
    var validUsers   = Array.from(checkedUsers).map(function(cb) { return cb.value; }).join(" ");
    var validLine    = validUsers ? "\nvalid users = " + validUsers : "";

    // Build the new section as a shell variable to avoid quoting issues
    var cmd = "sed -i '/^\\[" + name + "\\]/,/^\\[/{/^\\[" + name + "\\]/d;/^\\[/!d}' /etc/samba/smb.conf" +
        " && printf '\\n[" + name + "]\\npath = " + path +
        "\\nbrowseable = " + browseable +
        "\\nwritable = " + writable +
        "\\nguest ok = " + guestOk +
        (validUsers ? "\\nvalid users = " + validUsers : "") +
        "\\n' >> /etc/samba/smb.conf" +
        " && mkdir -p " + path +
        " && chmod " + chmod + " " + path +
        " && chown " + owner + ":" + group + " " + path +
        " && systemctl restart smbd";

    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() {
            closeModal("edit-share-modal");
            loadShares();
        })
        .fail(function(err) { alert("Ошибка сохранения: " + err); });
}
function addShare() {
    var name   = document.getElementById("share-name").value.trim();
    var access = document.getElementById("share-access").value;
    var chmod  = document.getElementById("share-chmod").value;
    var shareVolumeEl = document.getElementById("share-volume");
    var volume = shareVolumeEl.value;
    if (!name)   { alert("Введите имя шары"); return; }
    if (!volume) { alert("Выберите том"); return; }

    var opt      = shareVolumeEl.options[shareVolumeEl.selectedIndex];
    var isSubvol = opt && opt.dataset.isSubvol === "true";
    var path     = isSubvol ? volume : (volume.replace(/\/$/, "") + "/" + name);
    var guestOk = access === "public" ? "Yes" : "No";
    // Remove existing section first (idempotent), then append clean block
    var cmd = "mkdir -p " + path +
        " && chmod " + chmod + " " + path +
        " && sed -i '/^\\[" + name + "\\]/,/^\\[/{/^\\[" + name + "\\]/d;/^\\[/!d}' /etc/samba/smb.conf" +
        " && printf '\\n[" + name + "]\\npath = " + path +
        "\\nbrowseable = yes\\nwritable = yes\\nguest ok = " + guestOk +
        "\\n' >> /etc/samba/smb.conf && systemctl restart smbd";

    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() {
            closeModal("add-share-modal");
            document.getElementById("share-name").value = "";
            loadShares();
        })
        .fail(function(err) { alert("Ошибка: " + err); });
}

function deleteShare(name) {
    if (!confirm("Удалить шару " + name + "?")) return;
    // sed: delete from [name] line up to (not including) the next [ section or EOF
    var cmd = "sed -i '/^\\[" + name + "\\]/,/^\\[/{/^\\[" + name + "\\]/d;/^\\[/!d}' /etc/samba/smb.conf" +
        " && systemctl restart smbd";
    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() { loadShares(); })
        .fail(function(err) { alert("Ошибка: " + err); });
}

// ─── NFS Shares ──────────────────────────────────────────────────────────────

function loadNFS() {
    var tbody = document.getElementById("nfs-body");
    tbody.innerHTML = "<tr><td colspan='5'>Загрузка...</td></tr>";

    cockpit.spawn(
        ["bash", "-c", "cat /etc/exports 2>/dev/null | grep -v '^#' | grep -v '^[[:space:]]*$' || true"],
        {superuser: "require", err: "message"}
    )
    .done(function(output) {
        var lines = output.trim().split("\n").filter(Boolean);
        if (lines.length === 0) {
            tbody.innerHTML = "<tr><td colspan='5'>Нет NFS экспортов</td></tr>";
            return;
        }
        tbody.innerHTML = lines.map(function(line) {
            var parts   = line.trim().split(/\s+/);
            var path    = parts[0];
            var clients = parts.slice(1).map(function(p) { return p.split("(")[0]; }).join(", ");
            var options = parts.slice(1).map(function(p) {
                var m = p.match(/\(([^)]+)\)/);
                return m ? m[1] : "";
            }).join("; ");
            return "<tr>" +
                "<td>" + path + "</td>" +
                "<td>" + (clients || "*") + "</td>" +
                "<td><small>" + (options || "—") + "</small></td>" +
                "<td class='status-active'>Активна</td>" +
                "<td>" +
                  "<button class='btn btn-secondary btn-sm edit-nfs' data-path='" + path + "' data-line='" + encodeURIComponent(line.trim()) + "'>Изменить</button> " +
                  "<button class='btn btn-danger btn-sm delete-nfs' data-path='" + path + "'>Удалить</button>" +
                "</td>" +
                "</tr>";
        }).join("");
        document.querySelectorAll(".delete-nfs").forEach(function(btn) {
            btn.addEventListener("click", function() { deleteNFS(this.dataset.path); });
        });
        document.querySelectorAll(".edit-nfs").forEach(function(btn) {
            btn.addEventListener("click", function() {
                openEditNFS(this.dataset.path, decodeURIComponent(this.dataset.line));
            });
        });
    })
    .fail(function(err) {
        tbody.innerHTML = "<tr><td colspan='5'>Ошибка: " + err + "</td></tr>";
    });
}

function openEditNFS(path, line) {
    var parts      = line.trim().split(/\s+/);
    var clientPart = parts[1] || "*(rw,sync,no_subtree_check,no_root_squash,insecure)";
    var client     = clientPart.split("(")[0] || "*";
    var optsMatch  = clientPart.match(/\(([^)]+)\)/);
    var opts       = optsMatch ? optsMatch[1].split(",") : [];
    var access     = opts.indexOf("ro") !== -1 ? "ro" : "rw";
    var squash     = (opts.indexOf("root_squash") !== -1 && opts.indexOf("no_root_squash") === -1)
        ? "root_squash" : "no_root_squash";

    document.getElementById("edit-nfs-path").value    = path;
    document.getElementById("edit-nfs-clients").value = client;
    document.getElementById("edit-nfs-access").value  = access;
    document.getElementById("edit-nfs-squash").value  = squash;

    // Get current chmod/owner
    cockpit.spawn(["bash", "-c",
        "stat -c '%a %U %G' " + path + " 2>/dev/null || echo '755 root root'"
    ])
    .done(function(statOut) {
        var parts  = (statOut || "755 root root").trim().split(" ");
        var chmod  = parts[0] || "755";
        var owner  = parts[1] || "root";
        var group  = parts[2] || "root";
        document.getElementById("edit-nfs-chmod").value = chmod;
        populateOwnerSelects("edit-nfs-owner", "edit-nfs-group", owner, group);
        showModal("edit-nfs-modal");
    });
}

function saveEditNFS() {
    var path    = document.getElementById("edit-nfs-path").value.trim();
    var clients = document.getElementById("edit-nfs-clients").value.trim() || "*";
    var access  = document.getElementById("edit-nfs-access").value;
    var squash  = document.getElementById("edit-nfs-squash").value;
    var chmod   = document.getElementById("edit-nfs-chmod").value;
    var owner   = document.getElementById("edit-nfs-owner").value;
    var group   = document.getElementById("edit-nfs-group").value;

    var opts    = access + ",sync,no_subtree_check," + squash + ",insecure";
    var newLine = path + " " + clients + "(" + opts + ")";

    var cmd = "sed -i '\\|^" + path + " |d' /etc/exports" +
        " && echo '" + newLine + "' >> /etc/exports" +
        " && chmod " + chmod + " " + path +
        " && chown " + owner + ":" + group + " " + path +
        " && exportfs -ra";

    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() {
            closeModal("edit-nfs-modal");
            loadNFS();
        })
        .fail(function(err) { alert("Ошибка сохранения: " + err); });
}

function addNFS() {
    var name    = document.getElementById("nfs-name").value.trim();
    var clients = document.getElementById("nfs-clients").value.trim() || "*";
    var access  = document.getElementById("nfs-access").value;
    var squash  = document.getElementById("nfs-squash").value;
    var chmod   = document.getElementById("nfs-chmod").value;

    if (!name) { alert("Введите имя директории"); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        alert("Имя может содержать только буквы, цифры, - и _");
        return;
    }

    var volume     = document.getElementById("nfs-volume").value;
    if (!volume) { alert("Выберите том"); return; }
    var path       = volume.replace(/\/$/, "") + "/" + name;
    var opts       = access + ",sync,no_subtree_check," + squash + ",insecure";
    var exportLine = path + " " + clients + "(" + opts + ")";

    // Remove existing entry first (idempotent), then append
    var cmd = "mkdir -p " + path +
        " && chmod " + chmod + " " + path +
        " && sed -i '\\|^" + path + " |d' /etc/exports" +
        " && echo '" + exportLine + "' >> /etc/exports" +
        " && exportfs -ra" +
        " && systemctl enable --now nfs-server 2>/dev/null || true";

    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() {
            closeModal("add-nfs-modal");
            document.getElementById("nfs-name").value = "";
            document.getElementById("nfs-clients").value = "*";
            loadNFS();
        })
        .fail(function(err) { alert("Ошибка: " + err); });
}

function deleteNFS(path) {
    if (!confirm("Удалить NFS экспорт " + path + "?")) return;
    var cmd = "sed -i '\\|^" + path + " |d' /etc/exports && exportfs -ra";
    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() { loadNFS(); })
        .fail(function(err) { alert("Ошибка: " + err); });
}

// ─── iSCSI Targets ───────────────────────────────────────────────────────────

function loadISCSI() {
    var tbody = document.getElementById("iscsi-body");
    tbody.innerHTML = "<tr><td colspan='5'>Загрузка...</td></tr>";
    cockpit.spawn(["bash", "-c", "sudo targetcli ls /iscsi 2>&1 | grep 'iqn' | awk '{print $2}'"])
    .done(function(output) {
        var targets = output.trim().split("\n").filter(Boolean);
        if (targets.length === 0) {
            tbody.innerHTML = "<tr><td colspan='5'>Нет targets</td></tr>";
            return;
        }
        tbody.innerHTML = targets.map(function(iqn) {
            return "<tr>" +
                "<td>" + iqn + "</td>" +
                "<td>LUN 0</td>" +
                "<td>-</td>" +
                "<td class='status-active'>Активен</td>" +
                "<td><button class='btn btn-danger btn-sm delete-iscsi' data-iqn='" + iqn + "'>Удалить</button></td>" +
                "</tr>";
        }).join("");
        document.querySelectorAll(".delete-iscsi").forEach(function(btn) {
            btn.addEventListener("click", function() { deleteISCSI(this.dataset.iqn); });
        });
    })
    .fail(function(err) {
        tbody.innerHTML = "<tr><td colspan='5'>Ошибка: " + err + "</td></tr>";
    });
}

function addISCSI() {
    var name = document.getElementById("iscsi-name").value.trim();
    var size = document.getElementById("iscsi-size").value;
    if (!name) { alert("Введите имя"); return; }

    var iqn = "iqn.2026-03.com.rusnas:" + name;
    var cmd = "mkdir -p /mnt/data/iscsi && " +
        "sudo targetcli /backstores/fileio create " + name + " /mnt/data/iscsi/" + name + ".img " + size + "G && " +
        "sudo targetcli /iscsi create " + iqn + " && " +
        "sudo targetcli /iscsi/" + iqn + "/tpg1/luns create /backstores/fileio/" + name + " && " +
        "sudo targetcli /iscsi/" + iqn + "/tpg1 set attribute authentication=0 && " +
        "sudo targetcli saveconfig";

    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() {
            closeModal("add-iscsi-modal");
            document.getElementById("iscsi-name").value = "";
            loadISCSI();
        })
        .fail(function(err) { alert("Ошибка: " + err); });
}

function deleteISCSI(iqn) {
    if (!confirm("Удалить target " + iqn + "?")) return;
    cockpit.spawn(["bash", "-c", "sudo targetcli /iscsi delete " + iqn + " && sudo targetcli saveconfig"], {superuser: "require"})
    .done(function() { loadISCSI(); })
    .fail(function(err) { alert("Ошибка: " + err); });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function() {
    // SMB
    document.getElementById("btn-add-share").addEventListener("click", function() { loadVolumeSelects(); showModal("add-share-modal"); });
    document.getElementById("share-volume").addEventListener("change", function() {
        var opt = this.options[this.selectedIndex];
        var isSubvol = opt && opt.dataset.isSubvol === "true";
        var nameInput = document.getElementById("share-name");
        var hint = document.getElementById("share-path-hint");
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
    document.getElementById("share-name").addEventListener("input", function() {
        this.dataset.autoFilled = "";
    });
    document.getElementById("btn-share-create").addEventListener("click", addShare);
    document.getElementById("btn-share-cancel").addEventListener("click", function() { closeModal("add-share-modal"); });
    document.getElementById("btn-share-save").addEventListener("click", saveEditShare);
    document.getElementById("btn-share-edit-cancel").addEventListener("click", function() { closeModal("edit-share-modal"); });

    // NFS
    document.getElementById("btn-add-nfs").addEventListener("click", function() { loadVolumeSelects(); showModal("add-nfs-modal"); });
    document.getElementById("btn-nfs-create").addEventListener("click", addNFS);
    document.getElementById("btn-nfs-cancel").addEventListener("click", function() { closeModal("add-nfs-modal"); });
    document.getElementById("btn-nfs-save").addEventListener("click", saveEditNFS);
    document.getElementById("btn-nfs-edit-cancel").addEventListener("click", function() { closeModal("edit-nfs-modal"); });

    // iSCSI
    document.getElementById("btn-add-iscsi").addEventListener("click", function() { showModal("add-iscsi-modal"); });
    document.getElementById("btn-iscsi-create").addEventListener("click", addISCSI);
    document.getElementById("btn-iscsi-cancel").addEventListener("click", function() { closeModal("add-iscsi-modal"); });

    loadShares();
    loadNFS();
    loadISCSI();

    // WORM
    loadWorm();
    document.getElementById("btn-worm-refresh").addEventListener("click", loadWormStatus);
    document.getElementById("btn-add-worm").addEventListener("click", openAddWormModal);
    document.getElementById("btn-worm-add-confirm").addEventListener("click", confirmAddWorm);
    document.getElementById("btn-worm-add-cancel").addEventListener("click", function() { closeModal("add-worm-modal"); });
    document.getElementById("worm-grace-select").addEventListener("change", function() {
        document.getElementById("worm-grace-custom-wrap").classList.toggle("hidden", this.value !== "custom");
    });
    document.getElementById("worm-path-input").addEventListener("input", function() {
        checkWormSambaMatch(this.value.trim());
    });

    // FTP
    loadFtp();
    document.getElementById("btn-ftp-start").addEventListener("click", function() {
        cockpit.spawn(["bash", "-c", "sudo systemctl start vsftpd"], {superuser: "require", err: "message"})
            .done(function() { loadFtp(); });
    });
    document.getElementById("btn-ftp-stop").addEventListener("click", function() {
        cockpit.spawn(["bash", "-c", "sudo systemctl stop vsftpd"], {superuser: "require", err: "message"})
            .done(function() { loadFtp(); });
    });
    document.getElementById("btn-ftp-save").addEventListener("click", saveFtp);

    // WebDAV
    loadWebdav();
    document.getElementById("btn-webdav-start").addEventListener("click", function() {
        cockpit.spawn(["bash", "-c", "sudo systemctl start apache2"], {superuser: "require", err: "message"})
            .done(function() { loadWebdav(); });
    });
    document.getElementById("btn-webdav-stop").addEventListener("click", function() {
        cockpit.spawn(["bash", "-c", "sudo systemctl stop apache2"], {superuser: "require", err: "message"})
            .done(function() { loadWebdav(); });
    });
    document.getElementById("btn-webdav-save").addEventListener("click", saveWebdav);
    document.getElementById("btn-webdav-add-user").addEventListener("click", addWebdavUser);
});

// ─── FTP (vsftpd) ─────────────────────────────────────────────────────────────

function loadFtp() {
    cockpit.spawn(["bash", "-c",
        "systemctl is-active vsftpd 2>/dev/null || true; echo '---'; " +
        "cat /etc/vsftpd.conf 2>/dev/null | grep -E '^(anonymous_enable|write_enable|chroot_local_user|pasv_min_port|pasv_max_port)\\s*=' || true; echo '---'; " +
        "cat /proc/net/tcp6 /proc/net/tcp 2>/dev/null | grep -c ' 00000000:7530 ' || echo 0"
    ], {superuser: "require", err: "message"})
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
        document.getElementById("ftp-write").checked = cfg.write_enable !== "NO";
        document.getElementById("ftp-chroot").checked = cfg.chroot_local_user === "YES";
        document.getElementById("ftp-pasv-min").value = cfg.pasv_min_port || "30000";
        document.getElementById("ftp-pasv-max").value = cfg.pasv_max_port || "30100";

        var conns = parseInt((parts[2] || "").trim()) || 0;
        document.getElementById("ftp-connections").textContent =
            conns > 0 ? conns + " активных соединений" : "Нет активных соединений";
    });
}

function saveFtp() {
    var anon  = document.getElementById("ftp-anonymous").checked ? "YES" : "NO";
    var write = document.getElementById("ftp-write").checked      ? "YES" : "NO";
    var chroot = document.getElementById("ftp-chroot").checked    ? "YES" : "NO";
    var pasvMin = document.getElementById("ftp-pasv-min").value || "30000";
    var pasvMax = document.getElementById("ftp-pasv-max").value || "30100";

    var script = [
        "python3 -c \"",
        "import re",
        "f = open('/etc/vsftpd.conf', 'r'); c = f.read(); f.close()",
        "opts = {'anonymous_enable':'" + anon + "','write_enable':'" + write + "',",
        "'chroot_local_user':'" + chroot + "','pasv_min_port':'" + pasvMin + "',",
        "'pasv_max_port':'" + pasvMax + "','allow_writeable_chroot':'" + chroot + "'}",
        "for k,v in opts.items():",
        "    if re.search(r'^'+k+r'\\\\s*=',c,re.M): c=re.sub(r'^'+k+r'\\\\s*=.*$',k+'='+v,c,flags=re.M)",
        "    else: c += k+'='+v+'\\\\n'",
        "open('/etc/vsftpd.conf','w').write(c)",
        "\"",
        "&& systemctl restart vsftpd"
    ].join("; ");

    cockpit.spawn(["bash", "-c",
        "python3 << 'PYEOF'\n" +
        "import re\n" +
        "f = open('/etc/vsftpd.conf'); c = f.read(); f.close()\n" +
        "opts = {'anonymous_enable':'" + anon + "','write_enable':'" + write + "',\n" +
        "        'chroot_local_user':'" + chroot + "','allow_writeable_chroot':'" + chroot + "',\n" +
        "        'pasv_min_port':'" + pasvMin + "','pasv_max_port':'" + pasvMax + "'}\n" +
        "for k,v in opts.items():\n" +
        "    import re\n" +
        "    if re.search(r'^' + k + r'\\s*=', c, re.M): c = re.sub(r'^' + k + r'\\s*=.*$', k+'='+v, c, flags=re.M)\n" +
        "    else: c += k+'='+v+'\\n'\n" +
        "open('/etc/vsftpd.conf','w').write(c)\n" +
        "PYEOF\n" +
        "systemctl restart vsftpd"
    ], {superuser: "require", err: "message"})
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
    ], {superuser: "require", err: "message"})
    .done(function(out) {
        var parts = out.split("---\n");
        var active = (parts[0] || "").trim() === "active";
        var badge = document.getElementById("webdav-status-badge");
        badge.className = "badge " + (active ? "badge-success" : "badge-danger");
        badge.textContent = active ? "✅ Активен" : "🔴 Остановлен";

        var conf = parts[1] || "";
        var aliasM = conf.match(/^Alias\s+(\S+)/m);
        var dirM   = conf.match(/<Directory\s+(\S+)/m);
        document.getElementById("webdav-alias").value = aliasM ? aliasM[1] : "/webdav";
        document.getElementById("webdav-path").value  = dirM   ? dirM[1]   : "";

        var users = (parts[2] || "").trim().split("\n").filter(Boolean);
        var listEl = document.getElementById("webdav-users-list");
        if (!users.length) {
            listEl.innerHTML = '<span class="text-muted">Пользователей нет</span>';
        } else {
            listEl.innerHTML = users.map(function(u) {
                return '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;">' +
                    '<span>' + u + '</span>' +
                    '<button class="btn btn-danger btn-sm" onclick="removeWebdavUser(\'' + u.replace(/'/g,"") + '\')">✕</button>' +
                    '</div>';
            }).join("");
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
    ], {superuser: "require", err: "message"})
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
    ], {superuser: "require", err: "message"})
    .done(function() {
        document.getElementById("webdav-new-user").value = "";
        document.getElementById("webdav-new-pass").value = "";
        loadWebdav();
    })
    .fail(function() {
        // htdigest doesn't support -b on all versions, try python fallback
        cockpit.spawn(["python3", "-c",
            "import hashlib, os\n" +
            "realm='WebDAV'\n" +
            "user='" + user.replace(/'/g,"") + "'\n" +
            "pw='" + pass.replace(/'/g,"") + "'\n" +
            "h=hashlib.md5((user+':'+realm+':'+pw).encode()).hexdigest()\n" +
            "line=user+':'+realm+':'+h+'\\n'\n" +
            "f='" + WEBDAV_PASS + "'\n" +
            "lines=[l for l in (open(f).readlines() if os.path.exists(f) else []) if not l.startswith(user+':')]\n" +
            "lines.append(line)\n" +
            "open(f,'w').writelines(lines)\n"
        ], {superuser: "require", err: "message"})
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
    ], {superuser: "require", err: "message"})
    .done(function() { loadWebdav(); });
}

// ─── WriteOnce / WORM ─────────────────────────────────────────────────────────

var WORM_CONFIG = "/etc/rusnas/worm.json";
var WORM_BIN    = "/usr/local/bin/rusnas-worm";
var _wormConfig = { paths: [] };   // cached config
var _wormStatus = {};              // cached status: path -> {locked, total, pending}

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
    // Remove Samba vfs_worm if it was enabled
    if (p.samba_vfs) {
        removeSambaWorm(p.path);
    }
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

    // Populate path suggestions from mounts
    var sugg = document.getElementById("worm-path-suggestions");
    sugg.innerHTML = "";
    cockpit.spawn(["bash", "-c",
        "findmnt --real -o TARGET,FSTYPE --noheadings 2>/dev/null | grep -v '^\/ \\|/boot\\|/efi\\|tmpfs\\|swap'; true"
    ], {err: "message"})
    .done(function(out) {
        out.trim().split("\n").filter(Boolean).forEach(function(line) {
            var p = line.trim().split(/\s+/);
            var target = p[0];
            if (!target) return;
            var chip = document.createElement("button");
            chip.className = "btn btn-secondary btn-sm";
            chip.style.cssText = "font-size:11px;padding:2px 8px;";
            chip.textContent = target + " (" + (p[1] || "") + ")";
            chip.addEventListener("click", function() {
                document.getElementById("worm-path-input").value = target;
                checkWormSambaMatch(target);
            });
            sugg.appendChild(chip);
        });
    });

    showModal("add-worm-modal");
}

function checkWormSambaMatch(path) {
    // Check if this path (or a parent) is an SMB share path
    cockpit.spawn(["bash", "-c",
        "grep -r 'path\\s*=\\s*" + path.replace(/\//g, "\\/") + "' /etc/samba/smb.conf 2>/dev/null | head -1; true"
    ], {err: "message"})
    .done(function(out) {
        var opt = document.getElementById("worm-samba-option");
        opt.style.display = out.trim() ? "block" : "none";
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
    // Check duplicate
    if ((_wormConfig.paths || []).some(function(p){ return p.path === path; })) {
        errEl.textContent = "Этот путь уже добавлен";
        errEl.classList.remove("hidden");
        return;
    }

    var mode       = document.querySelector("input[name='worm-mode']:checked").value;
    var graceSec   = getWormGraceSeconds();
    var sambaVfs   = document.getElementById("worm-samba-vfs").checked &&
                     document.getElementById("worm-samba-option").style.display !== "none";

    var entry = {
        path:         path,
        enabled:      true,
        grace_period: graceSec,
        mode:         mode,
        samba_vfs:    sambaVfs,
    };

    _wormConfig.paths = _wormConfig.paths || [];
    _wormConfig.paths.push(entry);

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
    // Find share name by path in smb.conf, inject vfs_worm settings
    var script =
        "python3 << 'PYEOF'\n" +
        "import re, subprocess\n" +
        "path = '" + sharePath.replace(/'/g,"") + "'\n" +
        "grace = " + gracePeriod + "\n" +
        "with open('/etc/samba/smb.conf') as f: conf = f.read()\n" +
        // Find the share section containing this path
        "sections = re.split(r'(^\\[)', conf, flags=re.M)\n" +
        "# Use sed instead: find section with path= and inject\n" +
        "result = subprocess.run(['testparm','-s','--section-name=global','2>/dev/null'],capture_output=True)\n" +
        "# Simple approach: find [sectionname] blocks, check for path =\n" +
        "pattern = r'(\\[(?!global\\]|homes\\]|printers\\])\\w[^\\]]*\\].*?path\\s*=\\s*" +
        sharePath.replace(/\//g, "\\/").replace(/'/g,"") + "\\s*$)'\n" +
        "# Inject after path line\n" +
        "conf2 = re.sub(\n" +
        "    r'(path\\s*=\\s*" + sharePath.replace(/\//g, "\\/").replace(/'/g,"") + "\\s*\\n)',\n" +
        "    r'\\1    vfs objects = worm\\n    worm:grace_period = " + gracePeriod + "\\n',\n" +
        "    conf, flags=re.M\n" +
        ")\n" +
        "if conf2 != conf:\n" +
        "    with open('/etc/samba/smb.conf', 'w') as f: f.write(conf2)\n" +
        "    print('patched')\n" +
        "else:\n" +
        "    print('not_found')\n" +
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
