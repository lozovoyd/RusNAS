// rusNAS Brand Script — runs in Cockpit Shell context
// 1. Reads rusnas_theme and sets data-rusnas-theme on <html>
// 2. Injects a theme switcher pill into the shell sidebar (always visible)

(function () {
    "use strict";

    var THEME_KEY = "rusnas_theme";
    var ICONS  = { light: "☀", dark: "🌙", experimental: "⚡" };
    var LABELS = { light: "Светлая", dark: "Тёмная", experimental: "Экспер." };

    // ── Core ──────────────────────────────────────────────────────────────

    function getTheme() {
        var t = localStorage.getItem(THEME_KEY);
        if (t === "experimental" || t === "dark" || t === "light") return t;
        var s = localStorage.getItem("shell:style");
        if (s === "dark") return "dark";
        if (s === "light") return "light";
        return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute("data-rusnas-theme", theme);
        updateUI(theme);
    }

    function setTheme(theme) {
        localStorage.setItem(THEME_KEY, theme);
        applyTheme(theme);
        // Notify plugin iframes via storage event
        var event = new StorageEvent("storage", { key: THEME_KEY, newValue: theme });
        window.dispatchEvent(event);
    }

    applyTheme(getTheme());

    window.addEventListener("storage", function (e) {
        if (e.key === THEME_KEY || e.key === "shell:style") applyTheme(getTheme());
    });

    // ── UI injection ──────────────────────────────────────────────────────

    var menuOpen = false;

    function updateUI(theme) {
        var btn = document.getElementById("rn-shell-theme-btn");
        if (!btn) return;
        btn.textContent = ICONS[theme] || "🌙";
        btn.title = "Тема: " + (LABELS[theme] || theme);
        document.querySelectorAll(".rn-shell-opt").forEach(function (el) {
            el.classList.toggle("rn-active", el.dataset.t === theme);
        });
    }

    function buildShellSwitcher() {
        if (document.getElementById("rn-shell-theme-switcher")) return;

        // Inject CSS
        var style = document.createElement("style");
        style.textContent = [
            "#rn-shell-theme-switcher{",
              "position:fixed;bottom:16px;left:12px;z-index:9999;",
            "}",
            "#rn-shell-theme-btn{",
              "width:32px;height:32px;border-radius:50%;",
              "border:1px solid rgba(91,141,245,0.25);",
              "background:rgba(13,15,29,0.9);color:#8b9cc8;",
              "font-size:14px;cursor:pointer;",
              "display:flex;align-items:center;justify-content:center;",
              "transition:all 140ms;backdrop-filter:blur(8px);",
              "box-shadow:0 2px 8px rgba(0,0,0,0.4);",
              "padding:0;line-height:1;",
            "}",
            "#rn-shell-theme-btn:hover{",
              "border-color:rgba(91,141,245,0.5);color:#c8ccde;",
              "box-shadow:0 3px 12px rgba(0,0,0,0.5);",
            "}",
            "#rn-shell-theme-menu{",
              "display:none;position:absolute;bottom:38px;left:0;",
              "min-width:168px;",
              "background:#1b1e33;border:1px solid rgba(91,141,245,0.15);",
              "border-radius:8px;",
              "box-shadow:0 8px 32px rgba(0,0,0,0.55),0 0 0 1px rgba(91,141,245,0.08);",
              "overflow:hidden;",
              "animation:rn-menu-in 130ms ease;",
            "}",
            "@keyframes rn-menu-in{",
              "from{opacity:0;transform:translateY(6px) scale(0.97)}",
              "to{opacity:1;transform:none}",
            "}",
            ".rn-shell-menu-hdr{",
              "padding:7px 10px 5px;",
              "font-size:9px;font-weight:700;letter-spacing:0.1em;",
              "text-transform:uppercase;color:#4a5280;",
              "border-bottom:1px solid rgba(91,141,245,0.1);",
            "}",
            ".rn-shell-opt{",
              "width:100%;display:flex;align-items:center;gap:8px;",
              "padding:8px 10px;border:none;background:none;",
              "cursor:pointer;font-size:12px;color:#8b9cc8;",
              "transition:background 100ms;text-align:left;",
            "}",
            ".rn-shell-opt:hover{background:rgba(91,141,245,0.08);color:#c8ccde;}",
            ".rn-shell-opt.rn-active{color:#5b8df5;font-weight:600;}",
            ".rn-shell-opt-ico{font-size:13px;width:16px;text-align:center;flex-shrink:0;}",
            ".rn-shell-opt-lbl{flex:1;}",
            ".rn-shell-opt-chk{font-size:10px;color:#5b8df5;opacity:0;}",
            ".rn-shell-opt.rn-active .rn-shell-opt-chk{opacity:1;}",
        ].join("");
        document.head.appendChild(style);

        // Build widget
        var sw = document.createElement("div");
        sw.id = "rn-shell-theme-switcher";

        var btn = document.createElement("button");
        btn.id = "rn-shell-theme-btn";
        btn.title = "Тема интерфейса";
        sw.appendChild(btn);

        var menu = document.createElement("div");
        menu.id = "rn-shell-theme-menu";

        var hdr = document.createElement("div");
        hdr.className = "rn-shell-menu-hdr";
        hdr.textContent = "Тема интерфейса";
        menu.appendChild(hdr);

        ["light", "dark", "experimental"].forEach(function (t) {
            var opt = document.createElement("button");
            opt.className = "rn-shell-opt";
            opt.dataset.t = t;
            opt.innerHTML =
                '<span class="rn-shell-opt-ico">' + ICONS[t] + "</span>" +
                '<span class="rn-shell-opt-lbl">' +
                    (t === "light" ? "Светлая" : t === "dark" ? "Тёмная" : "Экспериментальная") +
                "</span>" +
                '<span class="rn-shell-opt-chk">✓</span>';
            opt.addEventListener("click", function () {
                setTheme(t);
                menu.style.display = "none";
                menuOpen = false;
            });
            menu.appendChild(opt);
        });
        sw.appendChild(menu);
        document.body.appendChild(sw);

        btn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (menuOpen) {
                menu.style.display = "none";
                menuOpen = false;
            } else {
                menu.style.display = "block";
                menuOpen = true;
            }
        });
        document.addEventListener("click", function (e) {
            if (menuOpen && !sw.contains(e.target)) {
                menu.style.display = "none";
                menuOpen = false;
            }
        });

        updateUI(getTheme());
    }

    // Wait for DOM
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", buildShellSwitcher);
    } else {
        buildShellSwitcher();
    }

}());

// ══════════════════════════════════════════════════════════════════════════════
// rusNAS Sidebar Nav Groups — Tatlin-style collapsible sections
// Runs in Cockpit Shell context, reorganises flat nav items into logical groups
// ══════════════════════════════════════════════════════════════════════════════
(function () {
    "use strict";

    var STORAGE_KEY = "rusnas_nav_collapsed";

    // ── Group definitions: id → { label, hrefs (startsWith match) } ──────
    // Items not matching any group remain standalone (Dashboard, License)
    var GROUPS = [
        { id: "storage",  label: "Хранилище",      hrefs: ["/rusnas","/rusnas/disks","/rusnas/containers"] },
        { id: "protect",  label: "Защита данных",   hrefs: ["/rusnas/guard","/rusnas/snapshots","/rusnas/dedup"] },
        { id: "infra",    label: "Инфраструктура",  hrefs: ["/rusnas/network","/rusnas/ups","/rusnas/users"] },
        { id: "monitor",  label: "Мониторинг",      hrefs: ["/rusnas/storage-analyzer","/rusnas/performance","/rusnas/ai"] }
    ];

    // ── Persistence ──────────────────────────────────────────────────────
    function getCollapsed() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) { return {}; }
    }
    function setCollapsed(state) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    // ── Find which group an href belongs to ──────────────────────────────
    function findGroup(href) {
        for (var i = 0; i < GROUPS.length; i++) {
            for (var j = 0; j < GROUPS[i].hrefs.length; j++) {
                if (href === GROUPS[i].hrefs[j]) return GROUPS[i];
            }
        }
        return null;
    }

    // ── Chevron SVG ──────────────────────────────────────────────────────
    var CHEVRON = '<svg class="rn-grp-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

    // ── Inject CSS ───────────────────────────────────────────────────────
    function injectCSS() {
        var s = document.createElement("style");
        s.textContent = [
            "/* ── Nav group headers ─────────────────── */",
            ".rn-nav-group-hdr{",
              "display:flex !important;align-items:center !important;",
              "padding:5px 12px 5px 12px !important;margin:8px 8px 2px !important;",
              "border:none !important;background:none !important;",
              "cursor:pointer !important;width:calc(100% - 16px) !important;",
              "font-size:10px !important;font-weight:700 !important;",
              "letter-spacing:0.07em !important;text-transform:uppercase !important;",
              "color:#4a5878 !important;border-radius:4px !important;",
              "transition:color 0.15s,background 0.15s !important;",
              "list-style:none !important;",
            "}",
            ".rn-nav-group-hdr:hover{color:#8ba0c0 !important;background:rgba(255,255,255,0.03) !important;}",
            ".rn-nav-group-hdr .rn-grp-chev{",
              "margin-right:8px;flex-shrink:0;",
              "transition:transform 0.2s ease;",
              "opacity:0.5;",
            "}",
            ".rn-nav-group-hdr.rn-expanded .rn-grp-chev{transform:rotate(90deg);}",
            ".rn-nav-group-hdr .rn-grp-label{flex:1;}",
            ".rn-nav-group-hdr .rn-grp-count{",
              "font-size:9px;font-weight:500;color:#3d5068;",
              "background:rgba(255,255,255,0.05);",
              "padding:1px 5px;border-radius:8px;",
              "margin-left:auto;",
            "}",
            "/* ── Collapsed children ─────────────────── */",
            ".rn-nav-child{transition:max-height 0.2s ease,opacity 0.15s ease;}",
            ".rn-nav-child.rn-collapsed{max-height:0 !important;overflow:hidden !important;opacity:0 !important;padding:0 !important;margin:0 !important;border:none !important;}",
            ".rn-nav-child:not(.rn-collapsed){max-height:44px;opacity:1;}",
            /* Indent children slightly */
            ".rn-nav-child > a.pf-v6-c-nav__link::before{margin-left:4px !important;}",
            /* Group separator */
            ".rn-nav-group-hdr:first-of-type{margin-top:2px !important;}",
            /* Light theme overrides */
            "html:not(.pf-v6-theme-dark) .rn-nav-group-hdr{color:#8895a7 !important;}",
            "html:not(.pf-v6-theme-dark) .rn-nav-group-hdr:hover{color:#475569 !important;background:rgba(0,0,0,0.03) !important;}",
            "html:not(.pf-v6-theme-dark) .rn-nav-group-hdr .rn-grp-count{background:rgba(0,0,0,0.05);color:#94a3b8;}",
        ].join("\n");
        document.head.appendChild(s);
    }

    // ── Main builder ─────────────────────────────────────────────────────
    function buildNavGroups() {
        // Find the "Система" section's <ul>
        var sections = document.querySelectorAll(".pf-v6-c-nav__section");
        var ul = null;
        for (var i = 0; i < sections.length; i++) {
            var t = sections[i].querySelector(".pf-v6-c-nav__section-title");
            if (t && /систем/i.test(t.textContent)) {
                ul = sections[i].querySelector(".pf-v6-c-nav__list");
                break;
            }
        }
        if (!ul) return;

        // Already processed?
        if (ul.dataset.rnGrouped) return;
        ul.dataset.rnGrouped = "1";

        injectCSS();

        var collapsed = getCollapsed();
        var items = Array.prototype.slice.call(ul.children);
        var processedGroups = {};

        items.forEach(function (li) {
            var a = li.querySelector("a");
            if (!a) return;
            var href = a.getAttribute("href") || "";
            var group = findGroup(href);
            if (!group) return; // standalone item — leave as-is

            // If we haven't inserted this group header yet, do it now
            if (!processedGroups[group.id]) {
                var hdr = document.createElement("li");
                hdr.className = "rn-nav-group-hdr";
                hdr.dataset.groupId = group.id;

                var isActive = false;
                // Check if any child in this group is active
                group.hrefs.forEach(function(h) {
                    var child = ul.querySelector('a[href="' + h + '"]');
                    if (child && (child.classList.contains("pf-m-current") || child.getAttribute("aria-current") === "page")) {
                        isActive = true;
                    }
                });

                var isCollapsed = collapsed[group.id] === true && !isActive;
                if (!isCollapsed) hdr.classList.add("rn-expanded");

                hdr.innerHTML = CHEVRON +
                    '<span class="rn-grp-label">' + group.label + '</span>' +
                    '<span class="rn-grp-count">' + group.hrefs.length + '</span>';

                // Insert header before the first item of this group
                ul.insertBefore(hdr, li);

                // Click handler
                hdr.addEventListener("click", function () {
                    var isExp = hdr.classList.contains("rn-expanded");
                    hdr.classList.toggle("rn-expanded", !isExp);
                    // Toggle children
                    var children = ul.querySelectorAll('[data-rn-group="' + group.id + '"]');
                    children.forEach(function (c) {
                        c.classList.toggle("rn-collapsed", isExp);
                    });
                    // Persist
                    var state = getCollapsed();
                    state[group.id] = isExp;
                    setCollapsed(state);
                });

                processedGroups[group.id] = { hdr: hdr, collapsed: isCollapsed };
            }

            // Mark this li as a child of the group
            li.dataset.rnGroup = group.id;
            li.classList.add("rn-nav-child");
            if (processedGroups[group.id].collapsed) {
                li.classList.add("rn-collapsed");
            }
        });
    }

    // ── Init: wait for nav to be rendered ────────────────────────────────
    // Cockpit shell renders nav asynchronously; retry a few times
    var attempts = 0;
    function tryBuild() {
        attempts++;
        var nav = document.querySelector(".pf-v6-c-nav__list");
        if (nav && nav.children.length > 5) {
            buildNavGroups();
        } else if (attempts < 20) {
            setTimeout(tryBuild, 200);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function() { setTimeout(tryBuild, 300); });
    } else {
        setTimeout(tryBuild, 300);
    }

    // Also rebuild on navigation (Cockpit uses pushState)
    var _origPush = history.pushState;
    history.pushState = function () {
        _origPush.apply(this, arguments);
        setTimeout(buildNavGroups, 300);
    };
}());
