/* rusNAS Container Manager — containers.js */
"use strict";

const CONTAINER_CGI = "/usr/lib/rusnas/cgi/container_api.py";

/* ── helpers ───────────────────────────────────────────────── */
function _esc(s) {
    return String(s || "")
        .replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function cgiCall(cmd, args) {
    args = args || [];
    return new Promise(function(resolve, reject) {
        var out = "";
        cockpit.spawn(
            ["sudo", "-n", "python3", CONTAINER_CGI, cmd].concat(args),
            { err: "message", superuser: "try" }
        ).stream(function(d){ out += d; })
         .done(function(){
             try { resolve(JSON.parse(out)); }
             catch(e) { reject(new Error("JSON parse error: " + out.substring(0,200))); }
         })
         .fail(function(e){ reject(e); });
    });
}

/* App icon SVG by category */
function _appIconSvg(category) {
    var icons = {
        cloud: '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"/>',
        photo: '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/>',
        media: '<path stroke-linecap="round" stroke-linejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75.125v-16.5C2.25 1.5 2.75 1.5 3.375 1.5h17.25c.621 0 1.125.504 1.125 1.125V18.375c0 .621-.504 1.125-1.125 1.125M3.375 19.5H18.75m-15.375 0V18.375m0 0h16.5"/>',
        security: '<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/>',
        iot: '<path stroke-linecap="round" stroke-linejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"/>',
        network: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"/>',
        mail: '<path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"/>',
        chat: '<path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"/>',
        office: '<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>',
    };
    var path = icons[category] || icons.cloud;
    return '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' + path + '</svg>';
}

/* ── state ─────────────────────────────────────────────────── */
var _catalogApps = [];
var _installedApps = {};
var _currentCat = "all";
var _statsTimer = null;
var _installAppId = null;
var _volumes = [];
var _installForce = false;

/* ── tab switching ─────────────────────────────────────────── */
function switchTab(tabName) {
    document.querySelectorAll(".tab-content").forEach(function(el) {
        el.style.display = "none";
    });
    document.querySelectorAll("#containers-tabs .advisor-tab-btn").forEach(function(btn) {
        btn.classList.remove("active");
    });
    var c = document.getElementById("tab-" + tabName);
    if (c) c.style.display = "";
    var b = document.querySelector('#containers-tabs .advisor-tab-btn[data-tab="' + tabName + '"]');
    if (b) b.classList.add("active");

    if (tabName === "installed") loadInstalled();
}

document.querySelectorAll("#containers-tabs .advisor-tab-btn[data-tab]").forEach(function(btn) {
    btn.addEventListener("click", function() { switchTab(btn.dataset.tab); });
});

/* ── catalog ───────────────────────────────────────────────── */
function loadCatalog() {
    return new Promise(function(resolve, reject) {
        Promise.all([
            cgiCall("get_catalog"),
            cgiCall("list_installed")
        ]).then(function(results) {
            var catResult = results[0];
            var insResult = results[1];

            _installedApps = {};
            (insResult.apps || []).forEach(function(a) {
                _installedApps[a.app_id] = a;
            });

            _catalogApps = catResult.apps || [];
            renderCatalog(_currentCat);
            updateInstalledBadge();
            resolve();
        }).catch(reject);
    });
}

function renderCatalog(cat) {
    _currentCat = cat;
    var grid = document.getElementById("catalog-grid");
    var apps = cat === "all"
        ? _catalogApps
        : _catalogApps.filter(function(a) { return a.category === cat; });

    if (!apps.length) {
        grid.innerHTML = '<p style="color:var(--color-muted);padding:24px">Нет приложений в этой категории.</p>';
        return;
    }

    grid.innerHTML = apps.map(function(app) {
        var isInstalled = !!_installedApps[app.id];
        var name = typeof app.name === "object" ? (app.name.ru || app.name.en) : (app.id);
        var desc = typeof app.description === "object"
            ? (app.description.ru || app.description.en || "")
            : "";
        var installBtn = isInstalled
            ? '<span class="badge badge-success">Установлено</span>'
            : '<button class="btn btn-primary btn-sm install-catalog-btn" data-appid="' + _esc(app.id) + '">Установить</button>';
        return '<div class="app-card">' +
            '<div class="app-card-header">' +
                '<div class="app-card-icon">' + _appIconSvg(app.category) + '</div>' +
                '<div class="app-card-meta">' +
                    '<div class="app-card-name">' + _esc(name) +
                        (app.featured ? ' <span class="app-featured-badge">Хит</span>' : '') +
                    '</div>' +
                    '<div class="app-card-desc">' + _esc(desc) + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="app-card-stats">' +
                '<span>' + _esc(app.category) + '</span>' +
                (app.min_ram_mb ? '<span>RAM: ' + _esc(String(app.min_ram_mb)) + ' MB</span>' : '') +
                (app.containers ? '<span>' + _esc(String(app.containers)) + ' контейнер(а)</span>' : '') +
            '</div>' +
            '<div class="app-card-actions">' + installBtn + '</div>' +
        '</div>';
    }).join("");

    // Attach event listeners to install buttons (avoid inline onclick for CSP)
    document.querySelectorAll(".install-catalog-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            openInstallModal(btn.dataset.appid);
        });
    });
}

/* Category filter */
document.querySelectorAll(".cat-filter-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
        document.querySelectorAll(".cat-filter-btn").forEach(function(b) {
            b.classList.remove("btn-primary");
            b.classList.add("btn-secondary");
        });
        btn.classList.add("btn-primary");
        btn.classList.remove("btn-secondary");
        renderCatalog(btn.dataset.cat);
    });
});

/* ── install modal ─────────────────────────────────────────── */
function openInstallModal(appId) {
    _installAppId = appId;
    var app = _catalogApps.find(function(a) { return a.id === appId; });
    if (!app) return;

    var name = typeof app.name === "object" ? (app.name.ru || appId) : appId;
    document.getElementById("install-modal-title").textContent = "Установка: " + name;
    document.getElementById("install-progress-area").style.display = "none";
    document.getElementById("install-result-area").style.display = "";
    document.getElementById("install-result-area").innerHTML = "";
    document.getElementById("install-form-area").style.display = "";
    document.getElementById("install-modal-footer").style.display = "";

    var params = app.install_params || [];
    var passwordVal = _generatePassword();

    var html = '<div>';

    // Volume selector
    html += '<div class="form-group"><label>Том для данных *</label>' +
            '<select id="im-volume" class="form-control">';
    (_volumes || []).forEach(function(v) {
        html += '<option value="' + _esc(v.path) + '">' +
                _esc(v.path) + ' (' + _esc(v.avail) + ' свободно)</option>';
    });
    if (!_volumes.length) {
        html += '<option value="/mnt/data">/mnt/data (по умолчанию)</option>';
    }
    html += '</select></div>';

    params.forEach(function(p) {
        if (p.type === "password" || p.generate) {
            var val = p.key === "admin_password" ? passwordVal : _generatePassword();
            html += '<div class="form-group"><label>' + _esc(p.label) + '</label>' +
                    '<div style="display:flex;gap:8px">' +
                    '<input type="text" id="im-' + _esc(p.key) + '" class="form-control" value="' + _esc(val) + '">' +
                    '<button class="btn btn-secondary btn-sm gen-pw-btn" data-target="im-' + _esc(p.key) + '">Новый</button>' +
                    '</div></div>';
        } else if (p.type === "port") {
            html += '<div class="form-group"><label>' + _esc(p.label) + '</label>' +
                    '<div style="display:flex;gap:8px;align-items:center">' +
                    '<input type="number" id="im-' + _esc(p.key) + '" class="form-control port-check-input"' +
                    ' value="' + _esc(p.default || "8090") + '" min="1024" max="65535">' +
                    '<span id="im-' + _esc(p.key) + '-status" style="font-size:12px;white-space:nowrap;color:var(--color-muted)">…</span>' +
                    '</div></div>';
        } else {
            html += '<div class="form-group"><label>' + _esc(p.label) + '</label>' +
                    '<input type="text" id="im-' + _esc(p.key) + '" class="form-control" value="' + _esc(p.default || "") + '">' +
                    '</div>';
        }
    });

    // Preflight resource check placeholder (populated after modal open)
    html += '<div id="install-preflight" style="margin-bottom:4px"></div>';

    html += '</div>';
    document.getElementById("install-form-area").innerHTML = html;

    // Attach generate password buttons
    document.querySelectorAll(".gen-pw-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var target = document.getElementById(btn.dataset.target);
            if (target) target.value = _generatePassword();
        });
    });

    // Attach port-check listeners
    document.querySelectorAll(".port-check-input").forEach(function(input) {
        var statusEl = document.getElementById(input.id + "-status");
        var timer = null;
        function checkPort() {
            var port = parseInt(input.value, 10);
            if (!port || port < 1024 || port > 65535) return;
            if (statusEl) statusEl.textContent = "Проверка…";
            cgiCall("check_ports", [String(port)]).then(function(r) {
                if (!statusEl) return;
                if (r.free) {
                    statusEl.textContent = "✓ Свободен";
                    statusEl.style.color = "var(--success)";
                } else {
                    statusEl.textContent = "✗ Занят — предлагаем " + (r.suggestion || "");
                    statusEl.style.color = "var(--warning)";
                    if (r.suggestion && r.suggestion !== port) {
                        // Auto-fill suggested port after brief pause
                        setTimeout(function() {
                            if (parseInt(input.value, 10) === port) {
                                input.value = r.suggestion;
                                statusEl.textContent = "✓ Свободен (" + r.suggestion + ")";
                                statusEl.style.color = "var(--success)";
                            }
                        }, 1500);
                    }
                }
            }).catch(function() {
                if (statusEl) { statusEl.textContent = ""; statusEl.style.color = ""; }
            });
        }
        input.addEventListener("input", function() {
            clearTimeout(timer);
            timer = setTimeout(checkPort, 600);
        });
        // Run initial check
        checkPort();
    });

    document.getElementById("install-modal").classList.remove("hidden");

    // Fetch live resource info for preflight display
    _installForce = false;
    var prefEl = document.getElementById("install-preflight");
    if (prefEl && (app.min_ram_mb || app.disk_gb)) {
        prefEl.innerHTML = '<span style="color:var(--color-muted);font-size:12px">Проверка ресурсов…</span>';
        var volEl2 = document.getElementById("im-volume");
        var volPath = volEl2 ? volEl2.value : "/mnt/data";
        cgiCall("get_resources", [volPath]).then(function(res) {
            if (!prefEl || !res.ok) return;
            var ramOk = !app.min_ram_mb || res.avail_ram_mb >= Math.round(app.min_ram_mb * 0.8);
            var diskOk = !app.disk_gb || res.free_disk_gb >= app.disk_gb * 0.9;
            var ramClass = ramOk ? "success" :
                (res.avail_ram_mb >= Math.round(app.min_ram_mb * 0.5) ? "warning" : "danger");
            var diskClass = diskOk ? "success" : "warning";
            var html2 = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">';
            if (app.min_ram_mb) {
                html2 += '<span class="badge badge-' + ramClass + '">RAM: ' + res.avail_ram_mb +
                    ' MB доступно / нужно ~' + app.min_ram_mb + ' MB</span>';
            }
            if (app.disk_gb) {
                html2 += '<span class="badge badge-' + diskClass + '">Диск: ' + res.free_disk_gb +
                    ' GB свободно / нужно ~' + app.disk_gb + ' GB</span>';
            }
            html2 += '</div>';
            if (ramClass === "danger") {
                html2 += '<div class="alert alert-danger" style="font-size:12px;margin-bottom:6px">' +
                    'Недостаточно оперативной памяти. Система может быть нестабильна.' +
                    ' Установка будет выполнена принудительно.</div>';
                _installForce = true;
            }
            prefEl.innerHTML = html2;
        }).catch(function() {
            if (prefEl) prefEl.innerHTML = '';
        });
    }
}

function _generatePassword() {
    var chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    var result = "";
    for (var i = 0; i < 16; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

document.getElementById("install-modal-close").addEventListener("click", function() {
    document.getElementById("install-modal").classList.add("hidden");
});
document.getElementById("install-cancel-btn").addEventListener("click", function() {
    document.getElementById("install-modal").classList.add("hidden");
});

document.getElementById("install-confirm-btn").addEventListener("click", function() {
    doInstall();
});

function doInstall() {
    var app = _catalogApps.find(function(a) { return a.id === _installAppId; });
    if (!app) return;

    var volEl = document.getElementById("im-volume");
    var volumePath = volEl ? volEl.value : "/mnt/data";

    var args = ["volume_path=" + volumePath];
    (app.install_params || []).forEach(function(p) {
        var el = document.getElementById("im-" + p.key);
        if (el) args.push(p.key + "=" + el.value);
    });
    if (_installForce) args.push("force=true");

    // Switch to progress view
    document.getElementById("install-form-area").style.display = "none";
    document.getElementById("install-modal-footer").style.display = "none";
    document.getElementById("install-progress-area").style.display = "";

    var steps = [
        "Создание директорий...",
        "Загрузка образов контейнеров...",
        "Запуск контейнеров...",
        "Настройка reverse proxy...",
        "Сохранение конфигурации...",
    ];
    var stepHtml = steps.map(function(s, i) {
        return '<div class="install-step" id="istep-' + i + '">' +
               '<span class="install-step-icon">&#9723;</span>' +
               '<span>' + _esc(s) + '</span></div>';
    }).join("") +
    '<div id="install-wait-notice" style="display:none;font-size:12px;color:var(--color-muted);' +
    'margin-top:10px;text-align:center">&#9203; Скачиваются образы контейнеров — это может занять 2–10 минут при первой установке...</div>';
    document.getElementById("install-steps-list").innerHTML = stepHtml;

    // Animate first (steps.length - 1) steps with timer; last step completes only when backend responds
    var ANIM_STEPS = steps.length - 1;
    var stepIdx = 0;
    var stepTimer = setInterval(function() {
        if (stepIdx < ANIM_STEPS) {
            if (stepIdx > 0) {
                var prev = document.getElementById("istep-" + (stepIdx - 1));
                if (prev) prev.querySelector(".install-step-icon").textContent = "\u2705";
            }
            var curr = document.getElementById("istep-" + stepIdx);
            if (curr) curr.querySelector(".install-step-icon").textContent = "\u23F3";
            // Cap progress at 80% — last 20% reserved for real completion
            var pct = Math.round(((stepIdx + 1) / steps.length) * 80);
            document.getElementById("install-progress-bar").style.width = pct + "%";
            document.getElementById("install-progress-pct").textContent = pct + "%";
            stepIdx++;
        } else {
            // Animation finished but backend still working — keep last step spinning
            var lastAnimStep = document.getElementById("istep-" + (ANIM_STEPS - 1));
            if (lastAnimStep) lastAnimStep.querySelector(".install-step-icon").textContent = "\u2705";
            var pendingStep = document.getElementById("istep-" + ANIM_STEPS);
            if (pendingStep) pendingStep.querySelector(".install-step-icon").textContent = "\u23F3";
            // Show "taking long" notice
            var notice = document.getElementById("install-wait-notice");
            if (notice) notice.style.display = "";
            clearInterval(stepTimer); // Stop repeating — UI is in "waiting" state
        }
    }, 2000);

    cgiCall("install", [_installAppId].concat(args)).then(function(r) {
        clearInterval(stepTimer);
        // Complete all steps and reach 100% only now (real completion)
        for (var i = 0; i < steps.length; i++) {
            var s = document.getElementById("istep-" + i);
            if (s) s.querySelector(".install-step-icon").textContent = "\u2705";
        }
        document.getElementById("install-progress-bar").style.width = "100%";
        document.getElementById("install-progress-pct").textContent = "100%";
        var notice = document.getElementById("install-wait-notice");
        if (notice) notice.style.display = "none";

        if (r.ok) {
            setTimeout(function() {
                showInstallResult(app, r);
            }, 500);
        } else {
            document.getElementById("install-progress-area").style.display = "none";
            document.getElementById("install-result-area").style.display = "";
            document.getElementById("install-result-area").innerHTML =
                '<div class="alert alert-danger">Ошибка установки: ' + _esc(r.error) + '</div>' +
                '<button class="btn btn-secondary" id="close-err-btn">Закрыть</button>';
            document.getElementById("close-err-btn").addEventListener("click", function() {
                document.getElementById("install-modal").classList.add("hidden");
            });
        }
        loadCatalog();
    }).catch(function(e) {
        clearInterval(stepTimer);
        var notice = document.getElementById("install-wait-notice");
        if (notice) notice.style.display = "none";
        document.getElementById("install-progress-area").style.display = "none";
        document.getElementById("install-result-area").style.display = "";
        document.getElementById("install-result-area").innerHTML =
            '<div class="alert alert-danger">Ошибка: ' + _esc(String(e)) + '</div>' +
            '<button class="btn btn-secondary" id="close-err-btn2">Закрыть</button>';
        document.getElementById("close-err-btn2").addEventListener("click", function() {
            document.getElementById("install-modal").classList.add("hidden");
        });
    });
}

function showInstallResult(app, result) {
    var name = typeof app.name === "object" ? (app.name.ru || app.id) : app.id;
    document.getElementById("install-progress-area").style.display = "none";
    document.getElementById("install-result-area").style.display = "";

    // Build URL using browser hostname (not server hostname)
    var appUrl = result.nginx_path
        ? ("http://" + window.location.hostname + result.nginx_path)
        : "";

    var copyBtnHtml = result.admin_password
        ? '<button class="btn btn-secondary btn-sm" id="copy-pw-btn">Скопировать</button>'
        : '';

    document.getElementById("install-result-area").innerHTML =
        '<div style="text-align:center;padding:8px 0 16px">' +
            '<div style="font-size:32px;margin-bottom:8px">\u2705</div>' +
            '<h4 style="margin:0 0 16px">' + _esc(name) + ' установлен</h4>' +
        '</div>' +
        (appUrl ? '<div class="form-group"><label>Адрес</label>' +
            '<a href="' + _esc(appUrl) + '" target="_blank" style="color:var(--color-link)">' + _esc(appUrl) + '</a>' +
            '</div>' : '') +
        (result.admin_password ? '<div class="form-group"><label>Пароль администратора</label>' +
            '<div style="display:flex;gap:8px">' +
            '<input type="text" class="form-control" value="' + _esc(result.admin_password) + '" readonly id="inst-pw-field">' +
            copyBtnHtml +
            '</div>' +
            '<small class="text-muted">Сохраните пароль — он больше не будет показан.</small>' +
            '</div>' : '') +
        '<div class="alert alert-info" style="font-size:12px;margin-top:8px">' +
            '&#9203; Первый запуск занимает 1–2 минуты пока контейнер инициализируется. ' +
            'Если страница недоступна — подождите и обновите браузер.' +
        '</div>' +
        '<div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px" id="result-actions">' +
        '</div>';

    if (result.admin_password) {
        var copyBtn = document.getElementById("copy-pw-btn");
        if (copyBtn) {
            copyBtn.addEventListener("click", function() {
                var pwField = document.getElementById("inst-pw-field");
                if (pwField) navigator.clipboard.writeText(pwField.value);
            });
        }
    }

    var actionsDiv = document.getElementById("result-actions");
    if (actionsDiv) {
        if (appUrl) {
            var openBtn = document.createElement("a");
            openBtn.href = appUrl;
            openBtn.target = "_blank";
            openBtn.className = "btn btn-primary btn-sm";
            openBtn.textContent = "Открыть";
            actionsDiv.appendChild(openBtn);
        }
        var closeBtn = document.createElement("button");
        closeBtn.className = "btn btn-secondary";
        closeBtn.textContent = "Закрыть";
        closeBtn.addEventListener("click", function() {
            document.getElementById("install-modal").classList.add("hidden");
        });
        actionsDiv.appendChild(closeBtn);
    }
}

/* ── installed ─────────────────────────────────────────────── */
function loadInstalled() {
    cgiCall("list_installed").then(function(r) {
        _installedApps = {};
        (r.apps || []).forEach(function(a) {
            _installedApps[a.app_id] = a;
        });
        renderInstalled(r.apps || []);
        updateInstalledBadge();
    }).catch(function(e) {
        console.error("loadInstalled error:", e);
    });
}

function renderInstalled(apps) {
    var list = document.getElementById("installed-list");
    var empty = document.getElementById("installed-empty");

    if (!apps.length) {
        list.innerHTML = "";
        empty.style.display = "";
        return;
    }
    empty.style.display = "none";

    list.innerHTML = apps.map(function(app) {
        var name = typeof app.name === "object" ? (app.name.ru || app.app_id) : app.app_id;
        var status = app.live_status || "stopped";
        var dotClass = status === "running" ? "db-dot-green"
                    : status === "partial" ? "db-dot-orange"
                    : "db-dot-gray";
        var statusLabel = status === "running" ? "Работает"
                       : status === "partial" ? "Частично"
                       : "Остановлен";

        var category = app.category || "cloud";
        var url = app.nginx_path
            ? ("http://" + window.location.hostname + app.nginx_path)
            : (app.host_ports && Object.values(app.host_ports)[0]
               ? ("http://" + window.location.hostname + ":" + Object.values(app.host_ports)[0])
               : "");

        var ctrlBtns = status === "running"
            ? '<button class="btn btn-sm btn-secondary app-action-btn" data-action="restart" data-appid="' + _esc(app.app_id) + '">Перезапуск</button>' +
              '<button class="btn btn-sm btn-secondary app-action-btn" data-action="stop" data-appid="' + _esc(app.app_id) + '">Стоп</button>'
            : '<button class="btn btn-sm btn-primary app-action-btn" data-action="start" data-appid="' + _esc(app.app_id) + '">Запустить</button>';

        return '<div class="installed-app-row" id="irow-' + _esc(app.app_id) + '">' +
            '<div class="installed-app-row-icon">' + _appIconSvg(category) + '</div>' +
            '<div class="installed-app-info">' +
                '<div class="installed-app-name">' +
                    _esc(name) +
                    '<span class="db-status-dot ' + dotClass + '" style="margin-left:4px"></span>' +
                    '<span style="font-size:12px;font-weight:400;color:var(--color-muted)">' + statusLabel + '</span>' +
                '</div>' +
                (url ? '<div class="installed-app-url"><a href="' + _esc(url) + '" target="_blank">' + _esc(url) + '</a></div>' : '') +
                '<div class="installed-app-stats" id="stats-' + _esc(app.app_id) + '">' +
                    '<span>Uptime: \u2014</span><span>CPU: \u2014</span><span>RAM: \u2014</span>' +
                '</div>' +
            '</div>' +
            '<div class="installed-app-actions">' +
                (url ? '<a href="' + _esc(url) + '" target="_blank" class="btn btn-sm btn-secondary">Открыть</a>' : '') +
                ctrlBtns +
                '<button class="btn btn-sm btn-secondary logs-btn" data-appid="' + _esc(app.app_id) + '" title="Логи">' +
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z"/></svg>' +
                '</button>' +
                '<button class="btn btn-sm btn-danger uninstall-btn" data-appid="' + _esc(app.app_id) + '" data-appname="' + _esc(name) + '" title="Удалить">\u2715</button>' +
            '</div>' +
        '</div>';
    }).join("");

    // Attach event listeners
    document.querySelectorAll(".app-action-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            appAction(btn.dataset.action, btn.dataset.appid);
        });
    });
    document.querySelectorAll(".logs-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            openLogs(btn.dataset.appid);
        });
    });
    document.querySelectorAll(".uninstall-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            confirmUninstall(btn.dataset.appid, btn.dataset.appname);
        });
    });
}

function updateInstalledBadge() {
    var count = Object.keys(_installedApps).length;
    var badge = document.getElementById("installed-count-badge");
    if (!badge) return;
    if (count > 0) {
        badge.style.display = "";
        badge.textContent = count;
    } else {
        badge.style.display = "none";
    }
}

function _actionLabel(action) {
    return action === "start" ? "Запустить" : action === "stop" ? "Стоп" : "Перезапуск";
}

function showToast(msg, type) {
    var t = document.createElement("div");
    t.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:9999;padding:10px 16px;" +
        "border-radius:var(--radius-sm);font-size:13px;color:#fff;max-width:320px;" +
        "background:" + (type === "success" ? "var(--success)" : type === "danger" ? "var(--danger)" : "var(--primary)") + ";";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() { t.remove(); }, 3500);
}

function appAction(action, appId) {
    // Disable button immediately for feedback
    var btn = document.querySelector('.app-action-btn[data-action="' + action + '"][data-appid="' + appId + '"]');
    if (btn) { btn.disabled = true; btn.textContent = "\u2026"; }

    cgiCall(action, [appId]).then(function(r) {
        if (r.ok) {
            showToast(_actionLabel(action) + ": готово", "success");
            loadInstalled();
        } else {
            showToast("Ошибка: " + (r.error || "неизвестно"), "danger");
            if (btn) { btn.disabled = false; btn.textContent = _actionLabel(action); }
        }
    }).catch(function(e) {
        showToast("Ошибка: " + String(e), "danger");
        if (btn) { btn.disabled = false; btn.textContent = _actionLabel(action); }
    });
}

function confirmUninstall(appId, name) {
    if (!confirm("Удалить " + name + "?\n\nОстановить контейнеры и удалить конфигурацию?")) return;
    var keepData = confirm("Сохранить данные приложения на диске?");
    var args = [appId];
    if (keepData) args.push("--keep-data");
    cgiCall("uninstall", args).then(function(r) {
        if (r.ok) {
            loadInstalled();
            loadCatalog();
        } else {
            alert("Ошибка удаления: " + (r.error || ""));
        }
    }).catch(function(e) { alert("Ошибка: " + e); });
}

/* Stats polling */
function startStatsPolling() {
    if (_statsTimer) clearInterval(_statsTimer);
    _statsTimer = setInterval(function() {
        var tab = document.getElementById("tab-installed");
        if (!tab || tab.style.display === "none") return;
        cgiCall("get_stats").then(function(r) {
            (r.stats || []).forEach(function(s) {
                Object.keys(_installedApps).forEach(function(appId) {
                    if ((s.Name || "").includes(appId)) {
                        var el = document.getElementById("stats-" + appId);
                        if (el) {
                            el.innerHTML =
                                '<span>CPU: ' + _esc(String(s.CPUPerc || s.cpu_percent || "\u2014")) + '</span>' +
                                '<span>RAM: ' + _esc(String(s.MemUsage || s.mem_usage || "\u2014")) + '</span>';
                        }
                    }
                });
            });
        }).catch(function(){});
    }, 5000);
}

/* Logs modal */
function openLogs(appId) {
    var name = (_installedApps[appId] || {}).name;
    if (typeof name === "object") name = name.ru || appId;
    document.getElementById("logs-modal-title").textContent = "Логи: " + (name || appId);
    document.getElementById("logs-content").textContent = "Загрузка\u2026";
    document.getElementById("logs-modal").classList.remove("hidden");
    cgiCall("get_logs", [appId, "200"]).then(function(r) {
        document.getElementById("logs-content").textContent = r.logs || "(пусто)";
    }).catch(function(e) {
        document.getElementById("logs-content").textContent = "Ошибка: " + e;
    });
}

document.getElementById("logs-modal-close").addEventListener("click", function() {
    document.getElementById("logs-modal").classList.add("hidden");
});

/* ── custom container tab ──────────────────────────────────── */
document.getElementById("mode-simple").addEventListener("click", function() {
    document.getElementById("custom-simple-form").style.display = "";
    document.getElementById("custom-compose-form").style.display = "none";
});

document.getElementById("mode-compose").addEventListener("click", function() {
    document.getElementById("custom-compose-form").style.display = "";
    document.getElementById("custom-simple-form").style.display = "none";
});

document.getElementById("cs-cancel").addEventListener("click", function() {
    document.getElementById("custom-simple-form").style.display = "none";
});
document.getElementById("cc-cancel").addEventListener("click", function() {
    document.getElementById("custom-compose-form").style.display = "none";
});

/* Port/env dynamic rows */
var _portCount = 0;
var _envCount = 0;

document.getElementById("cs-add-port").addEventListener("click", function() {
    var idx = _portCount++;
    var row = document.createElement("div");
    row.className = "param-row";
    row.id = "port-row-" + idx;
    row.innerHTML = '<input type="number" class="form-control" placeholder="9090" id="port-host-' + idx + '" style="max-width:100px">' +
        '<span>:</span>' +
        '<input type="number" class="form-control" placeholder="80" id="port-cont-' + idx + '" style="max-width:100px">' +
        '<button class="remove-btn port-remove-btn" data-rowid="port-row-' + idx + '">\u2715</button>';
    document.getElementById("cs-ports-list").appendChild(row);
    row.querySelector(".port-remove-btn").addEventListener("click", function(e) {
        document.getElementById(e.target.dataset.rowid).remove();
    });
});

document.getElementById("cs-add-env").addEventListener("click", function() {
    var idx = _envCount++;
    var row = document.createElement("div");
    row.className = "param-row";
    row.id = "env-row-" + idx;
    row.innerHTML = '<input type="text" class="form-control" placeholder="KEY" id="env-key-' + idx + '">' +
        '<span>=</span>' +
        '<input type="text" class="form-control" placeholder="value" id="env-val-' + idx + '">' +
        '<button class="remove-btn env-remove-btn" data-rowid="env-row-' + idx + '">\u2715</button>';
    document.getElementById("cs-env-list").appendChild(row);
    row.querySelector(".env-remove-btn").addEventListener("click", function(e) {
        document.getElementById(e.target.dataset.rowid).remove();
    });
});

document.getElementById("cs-submit").addEventListener("click", function() {
    var name = (document.getElementById("cs-name").value || "").trim();
    var image = (document.getElementById("cs-image").value || "").trim();
    if (!name || !image) { alert("Укажите название и образ"); return; }

    var args = [name, image];

    document.querySelectorAll("#cs-ports-list .param-row").forEach(function(row) {
        var idx = row.id.replace("port-row-", "");
        var h = document.getElementById("port-host-" + idx);
        var c = document.getElementById("port-cont-" + idx);
        if (h && c && h.value && c.value) {
            args.push("port_" + h.value + "=" + c.value);
        }
    });

    document.querySelectorAll("#cs-env-list .param-row").forEach(function(row) {
        var idx = row.id.replace("env-row-", "");
        var k = document.getElementById("env-key-" + idx);
        var v = document.getElementById("env-val-" + idx);
        if (k && v && k.value) {
            args.push("env_" + k.value + "=" + v.value);
        }
    });

    args.push("restart=" + document.getElementById("cs-restart").value);

    cgiCall("install_custom", args).then(function(r) {
        if (r.ok) {
            document.getElementById("custom-simple-form").style.display = "none";
            switchTab("installed");
        } else {
            alert("Ошибка: " + (r.error || ""));
        }
    }).catch(function(e) { alert("Ошибка: " + e); });
});

/* Compose file drag-drop */
var dropzone = document.getElementById("cc-dropzone");
var fileInput = document.getElementById("cc-file-input");

dropzone.addEventListener("click", function() { fileInput.click(); });
dropzone.addEventListener("dragover", function(e) { e.preventDefault(); dropzone.classList.add("drag-over"); });
dropzone.addEventListener("dragleave", function() { dropzone.classList.remove("drag-over"); });
dropzone.addEventListener("drop", function(e) {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    var file = e.dataTransfer.files[0];
    if (file) readComposeFile(file);
});
fileInput.addEventListener("change", function() {
    if (fileInput.files[0]) readComposeFile(fileInput.files[0]);
});

function readComposeFile(file) {
    var reader = new FileReader();
    reader.onload = function(e) {
        var content = e.target.result;
        var preview = document.getElementById("cc-preview");
        preview.textContent = content.substring(0, 2000) + (content.length > 2000 ? "\n..." : "");
        preview.style.display = "";
        preview._content = content;
    };
    reader.readAsText(file);
}

document.getElementById("cc-submit").addEventListener("click", function() {
    var name = (document.getElementById("cc-name").value || "").trim();
    var preview = document.getElementById("cc-preview");
    if (!name) { alert("Укажите название проекта"); return; }
    if (!preview._content) { alert("Выберите docker-compose.yml"); return; }

    var tmpPath = "/tmp/rusnas-compose-import.yml";
    cockpit.file(tmpPath, { superuser: "try" }).replace(preview._content).then(function() {
        cgiCall("import_compose", [name, tmpPath]).then(function(r) {
            if (r.ok) {
                document.getElementById("custom-compose-form").style.display = "none";
                switchTab("installed");
            } else {
                alert("Ошибка: " + (r.error || ""));
            }
        }).catch(function(e) { alert("Ошибка: " + e); });
    }).catch(function(e) { alert("Ошибка записи файла: " + e); });
});

/* ── init ──────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", function() {
    cgiCall("get_btrfs_volumes").then(function(r) {
        _volumes = r.volumes || [];
    }).catch(function(){});

    cockpit.spawn(["sudo", "-u", "rusnas-containers", "podman", "--version"],
                  { err: "message" })
        .done(function(out) {
            var versionEl = document.getElementById("podman-version");
            if (versionEl) versionEl.textContent = out.trim();
        });

    loadCatalog();
    startStatsPolling();
});
