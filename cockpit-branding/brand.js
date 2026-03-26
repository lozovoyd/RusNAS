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
