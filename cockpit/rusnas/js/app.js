// ─── Modal helpers ───────────────────────────────────────────────────────────

function showModal(id) {
    document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
}

// ─── Volumes (mounted non-system) ────────────────────────────────────────────

function loadVolumeSelects(callback) {
    // Get mounted filesystems excluding system ones
    var cmd = "findmnt -rno TARGET,SOURCE,FSTYPE,SIZE " +
        "| grep -v '^/ \\|^/boot\\|^/sys\\|^/proc\\|^/dev\\|^/run\\|^/snap\\|^/efi' " +
        "| grep -v 'tmpfs\\|devtmpfs\\|sysfs\\|proc\\|cgroup\\|pstore\\|efivarfs\\|hugetlbfs\\|mqueue\\|debugfs\\|tracefs\\|configfs\\|fusectl\\|bpf'";

    cockpit.spawn(["bash", "-c", cmd])
        .done(function(out) {
            var lines = out.trim().split("\n").filter(Boolean);
            var options = lines.map(function(line) {
                var parts = line.trim().split(/\s+/);
                var mount  = parts[0];
                var source = parts[1] || "";
                var size   = parts[3] || "";
                return "<option value='" + mount + "'>" + mount + " (" + source + ", " + size + ")</option>";
            });
            if (options.length === 0) {
                options = ["<option value=''>— нет смонтированных томов —</option>"];
            }
            // Update all volume selects on the page
            ["share-volume", "nfs-volume"].forEach(function(id) {
                var sel = document.getElementById(id);
                if (sel) sel.innerHTML = options.join("");
            });
            if (callback) callback(lines.length > 0 ? lines[0].trim().split(/\s+/)[0] : "");
        })
        .fail(function() {
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
    cockpit.spawn(
        ["bash", "-c", "testparm -s 2>/dev/null | grep '^\\[' | grep -v 'global\\|homes\\|printers\\|print'"],
        
    )
    .done(function(output) {
        var shares = output.trim().split("\n").filter(Boolean);
        if (shares.length === 0) {
            tbody.innerHTML = "<tr><td colspan='5'>Нет шар</td></tr>";
            return;
        }
        tbody.innerHTML = shares.map(function(s) {
            var name = s.replace(/[\[\]]/g, "").trim();
            return "<tr>" +
                "<td>" + name + "</td>" +
                "<td>/mnt/data/shares/" + name + "</td>" +
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
    var path = "/mnt/data/shares/" + name;
    var cmd = "python3 -c \"\nimport configparser\nc = configparser.ConfigParser(strict=False)\nc.read('/etc/samba/smb.conf')\nif '" + name + "' in c:\n    s = c['" + name + "']\n    print(s.get('path', '" + path + "'))\n    print(s.get('guest ok', 'no').strip().lower())\n    print(s.get('browseable', 'yes').strip().lower())\n    print(s.get('writable', 'yes').strip().lower())\n    print(s.get('valid users', ''))\nelse:\n    print('" + path + "')\n    print('no')\n    print('yes')\n    print('yes')\n    print('')\n\"";

    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function(output) {
            var lines = (output || "").trim().split("\n");
            var sharePath    = lines[0] || path;
            var guestOk      = lines[1] || "no";
            var browseable   = lines[2] || "yes";
            var writable     = lines[3] || "yes";
            var validUsers   = lines[4] || "";

            document.getElementById("edit-share-name").value = name;
            document.getElementById("edit-share-path").value = sharePath;
            document.getElementById("edit-share-access").value = (guestOk === "yes") ? "public" : "private";
            document.getElementById("edit-share-browseable").value = (browseable === "no") ? "no" : "yes";
            document.getElementById("edit-share-writable").value = (writable === "no") ? "no" : "yes";

            // Get current chmod and owner
            cockpit.spawn(["bash", "-c",
                "stat -c '%a %U %G' " + sharePath + " 2>/dev/null || echo '755 root root'"
            ])
            .done(function(statOut) {
                var parts = (statOut || "755 root root").trim().split(" ");
                var chmod = parts[0] || "755";
                var owner = parts[1] || "root";
                var group = parts[2] || "root";

                document.getElementById("edit-share-chmod").value = chmod;
                populateOwnerSelects("edit-share-owner", "edit-share-group", owner, group);
                populateUserCheckboxes("edit-share-users",
                    validUsers ? validUsers.trim().split(/[\s,]+/).filter(Boolean) : []);
                showModal("edit-share-modal");
            });
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
    var volume = document.getElementById("share-volume").value;
    if (!name)   { alert("Введите имя шары"); return; }
    if (!volume) { alert("Выберите том"); return; }

    var path    = volume.replace(/\/$/, "") + "/" + name;
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
        ["bash", "-c", "cat /etc/exports 2>/dev/null | grep -v '^#' | grep -v '^[[:space:]]*$'"],
        
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
});
