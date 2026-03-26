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
        enhanceSidebar(t);
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
    enhanceSidebar(theme);
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

// ── Sidebar enhancement for experimental theme ────────────────────────────

var RN_NAV = [
    { href: "/rusnas/dashboard",        label: "Dashboard",      section: "СИСТЕМА",
      svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='22 12 18 12 15 21 9 3 6 12 2 12'/></svg>" },
    { href: "/rusnas",                   label: "Хранилище",      svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='22' y1='12' x2='2' y2='12'/><path d='M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'/></svg>" },
    { href: "/rusnas/disks",             label: "Диски и RAID",   svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><ellipse cx='12' cy='5' rx='9' ry='3'/><path d='M21 12c0 1.66-4 3-9 3s-9-1.34-9-3'/><path d='M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5'/></svg>" },
    { href: "/rusnas/users",             label: "Пользователи",   svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M23 21v-2a4 4 0 0 0-3-3.87'/><path d='M16 3.13a4 4 0 0 1 0 7.75'/></svg>" },
    { href: "/rusnas/guard",             label: "Guard",          svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'/></svg>" },
    { href: "/rusnas/snapshots",         label: "Снапшоты",       svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z'/><circle cx='12' cy='13' r='4'/></svg>" },
    { href: "/rusnas/dedup",             label: "Дедупликация",   svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='13' height='13' rx='2' ry='2'/><path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'/></svg>" },
    { href: "/rusnas/ups",               label: "ИБП",            svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%23f0a030' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='2' y='7' width='16' height='10' rx='1'/><line x1='22' y1='11' x2='22' y2='13'/><line x1='7' y1='11' x2='7' y2='13'/><line x1='11' y1='9' x2='11' y2='15'/></svg>" },
    { href: "/rusnas/storage-analyzer",  label: "Анализ",         svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='18' y1='20' x2='18' y2='10'/><line x1='12' y1='20' x2='12' y2='4'/><line x1='6' y1='20' x2='6' y2='14'/></svg>" },
    { href: "/rusnas/network",           label: "Сеть",           section: "ИНСТРУМЕНТЫ",
      svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><line x1='2' y1='12' x2='22' y2='12'/><path d='M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'/></svg>" },
    { href: "/rusnas/ai",                label: "AI Ассистент",   svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='2' y='3' width='20' height='14' rx='2'/><path d='M8 21h8'/><path d='M12 17v4'/><path d='M7 8l3 3-3 3'/><line x1='13' y1='11' x2='16' y2='11'/></svg>" },
    { href: "/rusnas/performance",       label: "Performance",    svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 22C6.48 22 2 17.52 2 12S6.48 2 12 2s10 4.48 10 10'/><path d='M12 6v6l4 2'/><path d='m16 16 4 4'/><path d='M20 16h4v4'/></svg>" },
    { href: "/rusnas/license",           label: "Лицензия",       svg: "<svg viewBox='0 0 24 24' fill='none' stroke='%235b8df5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4'/></svg>" }
];

var RN_SECTION_STYLE = "display:block;padding:6px 10px 4px;font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#3a4268;font-family:system-ui,sans-serif;pointer-events:none;user-select:none;margin-top:8px;";
var RN_ICON_STYLE = "display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex-shrink:0;margin-right:1px;vertical-align:middle;";

function enhanceSidebar(theme) {
    try {
        var pd = window.parent.document;
        if (!pd) return;

        // Remove previous injections
        pd.querySelectorAll(".rn-exp-section, .rn-exp-icon").forEach(function(el) { el.remove(); });
        // Restore original link content
        pd.querySelectorAll("a[data-rn-orig]").forEach(function(link) {
            link.textContent = link.getAttribute("data-rn-orig");
            link.removeAttribute("data-rn-orig");
            link.style.removeProperty("display");
            link.style.removeProperty("align-items");
            link.style.removeProperty("gap");
        });

        if (theme !== "experimental") return;

        // Find nav links and enhance
        var navLinks = pd.querySelectorAll("nav a, a.pf-v6-c-nav__link");
        navLinks.forEach(function(link) {
            var href = link.getAttribute("href") || "";
            for (var i = 0; i < RN_NAV.length; i++) {
                var item = RN_NAV[i];
                // Match exact href or href with hash/trailing content
                var isMatch = href === item.href ||
                    href.startsWith(item.href + "#") ||
                    href.startsWith(item.href + "/");
                // Exact match for /rusnas (storage) to avoid matching /rusnas/xxx
                if (item.href === "/rusnas") isMatch = (href === "/rusnas" || href === "/rusnas#/");
                if (!isMatch) continue;

                // Inject section header before this nav item's parent li
                if (item.section) {
                    var li = link.closest("li") || link.parentElement;
                    if (li && li.parentElement) {
                        var sec = pd.createElement("div");
                        sec.className = "rn-exp-section";
                        sec.textContent = item.section;
                        sec.style.cssText = RN_SECTION_STYLE;
                        li.parentElement.insertBefore(sec, li);
                    }
                }

                // Save original text
                var origText = link.textContent.trim();
                link.setAttribute("data-rn-orig", origText);

                // Clean text: remove emoji and leading/trailing spaces
                var cleanText = origText
                    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")
                    .replace(/[\u2600-\u27BF]/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
                if (!cleanText) cleanText = item.label;

                // Rebuild link content: icon + text
                var iconEl = pd.createElement("span");
                iconEl.className = "rn-exp-icon";
                iconEl.style.cssText = RN_ICON_STYLE;
                iconEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" ' + item.svg.substring(4);

                var textEl = pd.createElement("span");
                textEl.textContent = cleanText;
                textEl.style.cssText = "flex:1;";

                link.innerHTML = "";
                link.appendChild(iconEl);
                link.appendChild(textEl);
                link.style.display = "flex";
                link.style.alignItems = "center";
                link.style.gap = "9px";

                break;
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

    // Apply sidebar on initial load
    setTimeout(function() { enhanceSidebar(resolveTheme()); }, 100);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function() {
        setTimeout(buildShellSwitcher, 500);
    });
} else {
    setTimeout(buildShellSwitcher, 500);
}

}());
