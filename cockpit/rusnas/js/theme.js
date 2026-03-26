// rusNAS Theme Manager
// - Applies data-theme to plugin page <html>
// - Injects persistent theme switcher into parent Cockpit shell using inline styles
//   (avoids CSP issues with injected <style> tags)

(function () {
"use strict";

var THEME_KEY = "rusnas_theme";
var ICONS  = { light: "☀", dark: "🌙", experimental: "⚡" };
var LABELS = { light: "Светлая", dark: "Тёмная", experimental: "Экспериментальная" };

// ── Core ──────────────────────────────────────────────────────────────────────

function resolveTheme() {
    var rt = localStorage.getItem(THEME_KEY);
    if (rt === "experimental" || rt === "dark" || rt === "light") return rt;
    var s = localStorage.getItem("shell:style");
    if (s === "light") return "light";
    if (s === "dark") return "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyToPage(theme) {
    document.documentElement.setAttribute("data-theme", theme);
}

applyToPage(resolveTheme());

window.addEventListener("storage", function (e) {
    if (e.key === THEME_KEY || e.key === "shell:style") {
        var t = resolveTheme();
        applyToPage(t);
        updateShellUI(t);
    }
});

// ── Shell injection — all styles inline (no <style> tag, CSP-safe) ─────────────

var SHELL_ID = "rn-shell-theme-switcher";
var _menuOpen = false;

// Inline style strings for each element
var S = {
    wrap:   "position:fixed;bottom:16px;left:12px;z-index:99999;",
    fab:    "width:32px;height:32px;border-radius:50%;" +
            "border:1px solid rgba(91,141,245,0.3);" +
            "background:rgba(14,16,29,0.92);color:#8b9cc8;" +
            "font-size:14px;cursor:pointer;padding:0;line-height:1;" +
            "display:flex;align-items:center;justify-content:center;" +
            "box-shadow:0 2px 10px rgba(0,0,0,0.45);" +
            "backdrop-filter:blur(8px);transition:border-color 140ms;",
    menu:   "display:none;position:absolute;bottom:38px;left:0;" +
            "min-width:174px;" +
            "background:#1b1e33;border:1px solid rgba(91,141,245,0.15);" +
            "border-radius:8px;overflow:hidden;" +
            "box-shadow:0 10px 36px rgba(0,0,0,0.6);",
    hdr:    "padding:7px 10px 5px;font-size:9px;font-weight:700;" +
            "letter-spacing:0.1em;text-transform:uppercase;color:#4a5280;" +
            "border-bottom:1px solid rgba(91,141,245,0.08);" +
            "font-family:system-ui,sans-serif;",
    opt:    "width:100%;display:flex;align-items:center;gap:8px;" +
            "padding:8px 10px;border:none;background:none;cursor:pointer;" +
            "font-size:12px;font-family:system-ui,sans-serif;" +
            "color:#7b87b0;text-align:left;",
    ico:    "font-size:13px;width:16px;text-align:center;flex-shrink:0;",
    lbl:    "flex:1;",
    chk:    "font-size:10px;color:#5b8df5;"
};

function optActiveStyle(active) {
    return S.opt + (active ? "color:#5b8df5;font-weight:600;" : "");
}

function setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    applyToPage(theme);
    updateShellUI(theme);
    closeMenu();
    try {
        var ev = new StorageEvent("storage", { key: THEME_KEY, newValue: theme });
        window.dispatchEvent(ev);
    } catch(e) {}
}

function openMenu() {
    var menu = getShellEl("rn-shell-menu");
    if (menu) { menu.style.display = "block"; _menuOpen = true; }
}

function closeMenu() {
    var menu = getShellEl("rn-shell-menu");
    if (menu) { menu.style.display = "none"; _menuOpen = false; }
}

function getShellEl(id) {
    try { return window.parent.document.getElementById(id); } catch(e) { return null; }
}

function updateShellUI(theme) {
    try {
        var pd = window.parent.document;
        if (!pd) return;
        var fab = pd.getElementById("rn-shell-fab");
        if (fab) fab.textContent = ICONS[theme] || "🌙";
        ["light","dark","experimental"].forEach(function(t) {
            var opt = pd.getElementById("rn-opt-" + t);
            if (opt) {
                var active = (t === theme);
                opt.style.cssText = optActiveStyle(active);
                var chk = opt.querySelector(".rn-chk");
                if (chk) chk.style.display = active ? "inline" : "none";
            }
        });
    } catch(e) {}
}

function buildShellSwitcher() {
    if (window.parent === window) return;
    try {
        var pd = window.parent.document;
        if (!pd || pd.getElementById(SHELL_ID)) return;

        var wrap = pd.createElement("div");
        wrap.id = SHELL_ID;
        wrap.style.cssText = S.wrap;

        // FAB
        var fab = pd.createElement("button");
        fab.id = "rn-shell-fab";
        fab.style.cssText = S.fab;
        fab.title = "Тема интерфейса";
        fab.textContent = ICONS[resolveTheme()] || "🌙";
        wrap.appendChild(fab);

        // Menu
        var menu = pd.createElement("div");
        menu.id = "rn-shell-menu";
        menu.style.cssText = S.menu;

        var hdr = pd.createElement("div");
        hdr.style.cssText = S.hdr;
        hdr.textContent = "Тема интерфейса";
        menu.appendChild(hdr);

        ["light","dark","experimental"].forEach(function(t) {
            var opt = pd.createElement("button");
            opt.id = "rn-opt-" + t;
            var active = (t === resolveTheme());
            opt.style.cssText = optActiveStyle(active);

            var ico = pd.createElement("span");
            ico.style.cssText = S.ico;
            ico.textContent = ICONS[t];

            var lbl = pd.createElement("span");
            lbl.style.cssText = S.lbl;
            lbl.textContent = LABELS[t];

            var chk = pd.createElement("span");
            chk.className = "rn-chk";
            chk.style.cssText = S.chk;
            chk.style.display = active ? "inline" : "none";
            chk.textContent = "✓";

            opt.appendChild(ico);
            opt.appendChild(lbl);
            opt.appendChild(chk);

            (function(theme) {
                opt.addEventListener("click", function() { setTheme(theme); });
            })(t);
            menu.appendChild(opt);
        });

        wrap.appendChild(menu);
        pd.body.appendChild(wrap);

        fab.addEventListener("click", function(e) {
            e.stopPropagation();
            _menuOpen ? closeMenu() : openMenu();
        });

        pd.addEventListener("click", function(e) {
            if (_menuOpen) {
                try {
                    if (!wrap.contains(e.target)) closeMenu();
                } catch(ex) {}
            }
        });

    } catch(e) { /* cross-origin, skip */ }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function() {
        setTimeout(buildShellSwitcher, 500);
    });
} else {
    setTimeout(buildShellSwitcher, 500);
}

}());
