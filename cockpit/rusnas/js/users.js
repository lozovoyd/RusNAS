// ─── Modal helpers ────────────────────────────────────────────────────────────

function showModal(id)  { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

// ─── Users ────────────────────────────────────────────────────────────────────

function loadUsers() {
    var tbody = document.getElementById("users-body");
    tbody.innerHTML = "<tr><td colspan='5'>Загрузка...</td></tr>";

    // Get local users with UID >= 1000, excluding nobody
    cockpit.spawn(
        ["bash", "-c", "awk -F: '$3>=1000 && $1!=\"nobody\" {print $1}' /etc/passwd"],
        
    )
    .done(function(output) {
        var users = output.trim().split("\n").filter(Boolean);
        if (users.length === 0) {
            tbody.innerHTML = "<tr><td colspan='5'>Нет пользователей</td></tr>";
            return;
        }

        // For each user get their groups and samba status
        var rows = [];
        var pending = users.length;

        users.forEach(function(user, idx) {
            rows[idx] = { name: user, groups: "", samba: false };

            cockpit.spawn(["bash", "-c",
                "groups " + user + " 2>/dev/null | cut -d: -f2 | tr -s ' ' | sed 's/^ //' && " +
                "pdbedit -L 2>/dev/null | grep -q '^" + user + ":' && echo 'samba_yes' || echo 'samba_no'"
            ])
            .done(function(output) {
                var lines = (output || "").trim().split("\n");
                rows[idx].groups = lines[0] || "";
                rows[idx].samba  = lines[1] === "samba_yes";
                pending--;
                if (pending === 0) renderUsers(rows);
            })
            .fail(function() {
                pending--;
                if (pending === 0) renderUsers(rows);
            });
        });
    })
    .fail(function(err) {
        tbody.innerHTML = "<tr><td colspan='5'>Ошибка: " + err + "</td></tr>";
    });
}

function renderUsers(rows) {
    var tbody = document.getElementById("users-body");
    if (rows.length === 0) {
        tbody.innerHTML = "<tr><td colspan='5'>Нет пользователей</td></tr>";
        return;
    }
    tbody.innerHTML = rows.map(function(u) {
        var sambaLabel = u.samba
            ? "<span class='status-active'>Да</span>"
            : "<span class='status-inactive'>Нет</span>";
        return "<tr>" +
            "<td>" + u.name + "</td>" +
            "<td><small>" + (u.groups || "—") + "</small></td>" +
            "<td>" + sambaLabel + "</td>" +
            "<td>" +
              "<button class='btn btn-secondary btn-sm edit-user' data-name='" + u.name + "'>Изменить</button> " +
              "<button class='btn btn-danger btn-sm delete-user' data-name='" + u.name + "'>Удалить</button>" +
            "</td>" +
            "</tr>";
    }).join("");

    document.querySelectorAll(".delete-user").forEach(function(btn) {
        btn.addEventListener("click", function() { deleteUser(this.dataset.name); });
    });
    document.querySelectorAll(".edit-user").forEach(function(btn) {
        btn.addEventListener("click", function() { openEditUser(this.dataset.name); });
    });
}

function addUser() {
    var name     = document.getElementById("user-name").value.trim();
    var password = document.getElementById("user-password").value;
    var samba    = document.getElementById("user-samba").checked;
    var group    = document.getElementById("user-group-select").value;

    if (!name)     { alert("Введите имя пользователя"); return; }
    if (!password) { alert("Введите пароль"); return; }
    if (!/^[a-z_][a-z0-9_-]*$/.test(name)) {
        alert("Имя: только строчные буквы, цифры, _ и - (начинается с буквы/_)");
        return;
    }

    var cmd = "useradd -m -s /bin/bash " + name +
        " && echo '" + name + ":" + password.replace(/'/g, "'\\''") + "' | chpasswd";

    if (group) {
        cmd += " && usermod -aG " + group + " " + name;
    }
    if (samba) {
        cmd += " && (echo '" + password.replace(/'/g, "'\\''") + "'; echo '" + password.replace(/'/g, "'\\''") + "') | smbpasswd -a -s " + name;
    }

    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() {
            closeModal("add-user-modal");
            // Синхронизируем нового пользователя с FileBrowser (fire-and-forget)
            cockpit.spawn(
                ["sudo", "-n", "python3",
                 "/usr/share/cockpit/rusnas/scripts/fb-sync-user.py",
                 "create", name, password],
                { err: "message" }
            );
            document.getElementById("user-name").value = "";
            document.getElementById("user-password").value = "";
            document.getElementById("user-samba").checked = true;
            loadUsers();
        })
        .fail(function(err) { alert("Ошибка: " + err); });
}

function openEditUser(name) {
    document.getElementById("edit-user-name").value = name;
    document.getElementById("edit-user-password").value = "";

    // Get current groups
    cockpit.spawn(["bash", "-c",
        "groups " + name + " 2>/dev/null | cut -d: -f2 | tr -s ' ' | sed 's/^ //' && " +
        "pdbedit -L 2>/dev/null | grep -q '^" + name + ":' && echo 'samba_yes' || echo 'samba_no'"
    ])
    .done(function(output) {
        var lines = (output || "").trim().split("\n");
        var currentGroups = (lines[0] || "").split(" ").filter(Boolean);
        var hasSamba = lines[1] === "samba_yes";

        document.getElementById("edit-user-samba").checked = hasSamba;

        // Populate group checkboxes
        loadGroupCheckboxes("edit-user-groups", currentGroups);
        showModal("edit-user-modal");
    });
}

function saveEditUser() {
    var name     = document.getElementById("edit-user-name").value.trim();
    var password = document.getElementById("edit-user-password").value;
    var samba    = document.getElementById("edit-user-samba").checked;

    // Collect selected groups
    var checked = document.querySelectorAll("#edit-user-groups input:checked");
    var groups  = Array.from(checked).map(function(cb) { return cb.value; });

    var cmd = "";

    if (password) {
        cmd += "echo '" + name + ":" + password.replace(/'/g, "'\\''") + "' | chpasswd";
        if (samba) {
            cmd += " && (echo '" + password.replace(/'/g, "'\\''") + "'; echo '" + password.replace(/'/g, "'\\''") + "') | smbpasswd -s " + name;
        }
    }

    // Reset supplementary groups then assign selected
    var groupStr = groups.length > 0 ? groups.join(",") : "";
    var groupCmd = groupStr
        ? "usermod -G " + groupStr + " " + name
        : "usermod -G '' " + name + " 2>/dev/null || true";

    cmd = cmd ? cmd + " && " + groupCmd : groupCmd;

    // Samba enable/disable
    if (samba) {
        if (password) {
            // already set above
        } else {
            cmd += " && smbpasswd -e " + name + " 2>/dev/null || true";
        }
    } else {
        cmd += " && smbpasswd -x " + name + " 2>/dev/null || true";
    }

    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() {
            closeModal("edit-user-modal");
            // Синхронизируем изменения в FileBrowser (fire-and-forget)
            cockpit.spawn(
                ["sudo", "-n", "python3",
                 "/usr/share/cockpit/rusnas/scripts/fb-sync-user.py",
                 "update", name, password || ""],
                { err: "message" }
            );
            loadUsers();
        })
        .fail(function(err) { alert("Ошибка: " + err); });
}

function deleteUser(name) {
    if (!confirm("Удалить пользователя " + name + "?\nДомашняя директория будет сохранена.")) return;
    var cmd = "smbpasswd -x " + name + " 2>/dev/null || true; userdel " + name;
    cockpit.spawn(["bash", "-c", cmd], {superuser: "require"})
        .done(function() {
            // Удаляем пользователя из FileBrowser (fire-and-forget)
            cockpit.spawn(
                ["sudo", "-n", "python3",
                 "/usr/share/cockpit/rusnas/scripts/fb-sync-user.py",
                 "delete", name],
                { err: "message" }
            );
            loadUsers();
        })
        .fail(function(err) { alert("Ошибка: " + err); });
}

// ─── Groups ───────────────────────────────────────────────────────────────────

function loadGroups() {
    var tbody = document.getElementById("groups-body");
    tbody.innerHTML = "<tr><td colspan='3'>Загрузка...</td></tr>";

    cockpit.spawn(
        ["bash", "-c", "awk -F: '$3>=1000 {print $1\"|\"$4}' /etc/group"],
        
    )
    .done(function(output) {
        var lines = output.trim().split("\n").filter(Boolean);
        if (lines.length === 0) {
            tbody.innerHTML = "<tr><td colspan='3'>Нет групп</td></tr>";
            return;
        }
        tbody.innerHTML = lines.map(function(line) {
            var parts = line.split("|");
            var gname   = parts[0];
            var members = parts[1] || "—";
            return "<tr>" +
                "<td>" + gname + "</td>" +
                "<td><small>" + members + "</small></td>" +
                "<td><button class='btn btn-danger btn-sm delete-group' data-name='" + gname + "'>Удалить</button></td>" +
                "</tr>";
        }).join("");
        document.querySelectorAll(".delete-group").forEach(function(btn) {
            btn.addEventListener("click", function() { deleteGroup(this.dataset.name); });
        });

        // Also refresh group dropdowns/checkboxes used in user modals
        refreshGroupSelects();
    })
    .fail(function(err) {
        tbody.innerHTML = "<tr><td colspan='3'>Ошибка: " + err + "</td></tr>";
    });
}

function addGroup() {
    var name = document.getElementById("group-name").value.trim();
    if (!name) { alert("Введите имя группы"); return; }
    if (!/^[a-z_][a-z0-9_-]*$/.test(name)) {
        alert("Имя: только строчные буквы, цифры, _ и -");
        return;
    }
    cockpit.spawn(["bash", "-c", "groupadd " + name], {superuser: "require"})
        .done(function() {
            closeModal("add-group-modal");
            document.getElementById("group-name").value = "";
            loadGroups();
        })
        .fail(function(err) { alert("Ошибка: " + err); });
}

function deleteGroup(name) {
    if (!confirm("Удалить группу " + name + "?")) return;
    cockpit.spawn(["bash", "-c", "groupdel " + name], {superuser: "require"})
        .done(function() { loadGroups(); })
        .fail(function(err) { alert("Ошибка: " + err); });
}

// ─── Group select helpers ─────────────────────────────────────────────────────

function refreshGroupSelects() {
    cockpit.spawn(
        ["bash", "-c", "awk -F: '$3>=1000 {print $1}' /etc/group"],
        
    )
    .done(function(output) {
        var groups = output.trim().split("\n").filter(Boolean);
        var sel = document.getElementById("user-group-select");
        if (sel) {
            sel.innerHTML = "<option value=''>— без группы —</option>" +
                groups.map(function(g) { return "<option value='" + g + "'>" + g + "</option>"; }).join("");
        }
    });
}

function loadGroupCheckboxes(containerId, selected) {
    cockpit.spawn(
        ["bash", "-c", "awk -F: '$3>=1000 {print $1}' /etc/group"],
        
    )
    .done(function(output) {
        var groups = output.trim().split("\n").filter(Boolean);
        var container = document.getElementById(containerId);
        if (!container) return;
        if (groups.length === 0) {
            container.innerHTML = "<small>Нет групп</small>";
            return;
        }
        container.innerHTML = groups.map(function(g) {
            var checked = selected && selected.indexOf(g) !== -1 ? "checked" : "";
            return "<label class='checkbox-label'>" +
                "<input type='checkbox' value='" + g + "' " + checked + "> " + g +
                "</label>";
        }).join("");
    });
}

// ─── Users init ───────────────────────────────────────────────────────────────

function initUsers() {
    document.getElementById("btn-add-user").addEventListener("click", function() {
        refreshGroupSelects();
        showModal("add-user-modal");
    });
    document.getElementById("btn-user-create").addEventListener("click", addUser);
    document.getElementById("btn-user-cancel").addEventListener("click", function() { closeModal("add-user-modal"); });
    document.getElementById("btn-user-save").addEventListener("click", saveEditUser);
    document.getElementById("btn-user-edit-cancel").addEventListener("click", function() { closeModal("edit-user-modal"); });

    document.getElementById("btn-add-group").addEventListener("click", function() { showModal("add-group-modal"); });
    document.getElementById("btn-group-create").addEventListener("click", addGroup);
    document.getElementById("btn-group-cancel").addEventListener("click", function() { closeModal("add-group-modal"); });

    loadUsers();
    loadGroups();
}

document.addEventListener("DOMContentLoaded", initUsers);
