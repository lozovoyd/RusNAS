"""Test Container Manager UI."""
from playwright.sync_api import sync_playwright
import time, json

URL = "https://10.10.10.72:9090"
PLUGIN_URL = URL + "/cockpit/@localhost/rusnas/containers.html"


def login(page):
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    if page.locator("#login-user-input").count() > 0:
        page.fill("#login-user-input", "rusnas")
        page.fill("#login-password-input", "kl4389qd")
        page.locator("#login-button").click()
        page.wait_for_load_state("networkidle")
        time.sleep(2)


def navigate_to_containers(page):
    """Navigate directly to containers.html plugin and return page."""
    page.goto(PLUGIN_URL, wait_until="domcontentloaded")
    time.sleep(4)
    return page


def test_containers_page_loads():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        navigate_to_containers(page)
        page.screenshot(path="/tmp/containers_01_page.png")
        assert page.locator(".advisor-tabs").count() > 0, "No .advisor-tabs found on page"
        browser.close()


def test_catalog_tab_shows_apps():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        navigate_to_containers(page)
        cards = page.locator(".app-card")
        page.screenshot(path="/tmp/containers_02_catalog.png")
        assert cards.count() > 0, "No app cards in catalog"
        browser.close()


def test_category_filter_works():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        navigate_to_containers(page)
        cloud_btn = page.locator(".cat-filter-btn[data-cat='cloud']")
        cloud_btn.click()
        time.sleep(0.5)
        page.screenshot(path="/tmp/containers_03_cloud_filter.png")
        assert cloud_btn.get_attribute("class").find("btn-primary") >= 0
        browser.close()


def test_install_modal_opens():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        navigate_to_containers(page)
        # Click install on first app
        install_btn = page.locator(".app-card .btn-primary").first
        if install_btn.count() > 0:
            install_btn.click()
            time.sleep(0.5)
            page.screenshot(path="/tmp/containers_04_install_modal.png")
            assert page.locator("#install-modal").count() > 0
            modal_hidden = "hidden" in (page.locator("#install-modal").get_attribute("class") or "")
            assert not modal_hidden, "Install modal did not open"
        browser.close()


def test_installed_tab_loads():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        login(page)
        navigate_to_containers(page)
        page.locator(".advisor-tab-btn[data-tab='installed']").click()
        time.sleep(2)
        page.screenshot(path="/tmp/containers_05_installed.png")
        # Either empty state or installed list should be present
        assert (page.locator("#installed-empty").count() > 0 or
                page.locator(".installed-app-row").count() > 0), \
            "Neither #installed-empty nor .installed-app-row found"
        browser.close()
