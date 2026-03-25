"""
rusNAS UI cohesion test — all 12 plugin pages
Runs against Cockpit at https://10.10.10.72:9090
"""
import os, time
from playwright.sync_api import sync_playwright

COCKPIT_URL  = "https://10.10.10.72:9090"
USERNAME     = "rusnas"
PASSWORD     = "kl4389qd"
SCREENSHOTS  = "/tmp/rusnas_ui_test2"

PAGES = [
    ("dashboard",        "dashboard.html",        "Dashboard"),
    ("storage",          "index.html",             "Хранилище"),
    ("disks",            "disks.html",             "Диски"),
    ("users",            "users.html",             "Пользователи"),
    ("guard",            "guard.html",             "Guard"),
    ("snapshots",        "snapshots.html",         "Снапшоты"),
    ("dedup",            "dedup.html",             "Дедупликация"),
    ("ups",              "ups.html",               "ИБП"),
    ("storage-analyzer", "storage-analyzer.html",  "Анализ пространства"),
    ("network",          "network.html",           "Сеть"),
    ("ai",               "ai.html",                "AI"),
    ("performance",      "performance.html",       "Performance"),
]

os.makedirs(SCREENSHOTS, exist_ok=True)

def cockpit_login(page):
    """Login to Cockpit and wait for the shell to load."""
    page.goto(COCKPIT_URL + "/", wait_until="domcontentloaded")
    page.wait_for_timeout(1000)

    # Fill login form
    page.fill("#login-user-input", USERNAME)
    page.fill("#login-password-input", PASSWORD)
    page.click("#login-button")

    # Wait for login to complete — URL should change away from /cockpit/login
    page.wait_for_url(lambda url: "login" not in url, timeout=15000)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    print(f"  Logged in, current URL: {page.url}")

def navigate_to_plugin(page, filename):
    """Navigate to a rusNAS plugin page inside Cockpit's shell iframe."""
    # Use Cockpit's hash-based navigation to load plugin pages
    plugin_url = f"{COCKPIT_URL}/cockpit/@localhost/rusnas/{filename}"
    page.goto(plugin_url, wait_until="domcontentloaded", timeout=20000)
    page.wait_for_timeout(3000)

results = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    context = browser.new_context(
        viewport={"width": 1280, "height": 900},
        ignore_https_errors=True,
        locale="ru-RU"
    )

    page = context.new_page()
    console_errors = []
    page.on("console", lambda msg: console_errors.append(f"{msg.type}: {msg.text}") if msg.type in ("error","warning") else None)

    print("\n" + "="*60)
    print("rusNAS UI Cohesion Test")
    print("="*60)

    # Step 1: Login
    print("\n[LOGIN] Authenticating with Cockpit...")
    cockpit_login(page)

    # Step 2: Take a post-login screenshot
    page.screenshot(path=f"{SCREENSHOTS}/_login_state.png")

    # Step 3: Test each page
    print(f"\n[PAGES] Testing {len(PAGES)} plugin pages...\n")
    passed = failed = 0

    for slug, filename, name in PAGES:
        try:
            navigate_to_plugin(page, filename)

            shot = f"{SCREENSHOTS}/{slug}.png"
            page.screenshot(path=shot, full_page=True)

            # Checks
            title = page.title()
            body  = page.inner_text("body")
            has_content = len(body.strip()) > 100

            # Check data-theme
            theme = page.evaluate("document.documentElement.getAttribute('data-theme')")

            # Check h1
            h1s = page.locator("h1").all_text_contents()

            # Check no Forbidden/Error page
            is_forbidden = "Forbidden" in title or "Error" in title or (len(body.strip()) < 200 and "Forbidden" in body)

            # Check tabs render as buttons (not ul/li)
            bad_tabs = page.locator("ul.nav.nav-tabs").count()

            ok = has_content and not is_forbidden and bad_tabs == 0
            symbol = "✅" if ok else "❌"
            print(f"  {symbol} {name:28s} theme={theme or 'none':5s}  title='{title}'  h1={h1s[:1]}")

            if not ok:
                if is_forbidden:  print(f"     ⚠ Forbidden/error page")
                if not has_content: print(f"     ⚠ Low content ({len(body.strip())} chars)")
                if bad_tabs:       print(f"     ⚠ Bootstrap nav-tabs found (should use advisor-tabs)")
                failed += 1
            else:
                passed += 1

            results.append((slug, name, ok, title, theme, shot))

        except Exception as e:
            print(f"  ❌ {name:28s} ERROR: {e}")
            results.append((slug, name, False, "ERROR", None, ""))
            failed += 1

    # Step 4: Mobile responsiveness spot check
    print(f"\n[MOBILE] Viewport 390px — checking 4 key pages...")
    mobile_ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        ignore_https_errors=True,
        locale="ru-RU"
    )
    mpage = mobile_ctx.new_page()
    cockpit_login(mpage)

    for slug, filename, name in [PAGES[0], PAGES[1], PAGES[2], PAGES[5]]:
        try:
            navigate_to_plugin(mpage, filename)
            shot = f"{SCREENSHOTS}/{slug}_mobile.png"
            mpage.screenshot(path=shot, full_page=True)
            overflow = mpage.evaluate("document.body.scrollWidth > document.body.clientWidth + 2")
            sw = mpage.evaluate("document.body.scrollWidth")
            cw = mpage.evaluate("document.body.clientWidth")
            sym = "⚠" if overflow else "✅"
            print(f"  {sym} {name:28s} scroll={sw}px client={cw}px overflow={'YES' if overflow else 'no'}")
        except Exception as e:
            print(f"  ❌ {name}: {e}")

    mobile_ctx.close()

    # Step 5: Summary
    print(f"\n{'='*60}")
    print(f"RESULTS: {passed} passed / {failed} failed / {len(PAGES)} total")
    print(f"Screenshots: {SCREENSHOTS}/")

    relevant_errors = [e for e in console_errors if "google" not in e.lower() and "fonts" not in e.lower()]
    if relevant_errors:
        print(f"\nConsole issues ({len(relevant_errors)}):")
        for e in relevant_errors[:20]:
            print(f"  • {e}")

    browser.close()
