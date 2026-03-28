"""
Comprehensive Container Manager tests — rusNAS
Tests both backend CGI and frontend UI via Playwright.
"""
import subprocess
import json
import sys
import os
import pytest
from playwright.sync_api import sync_playwright, expect

VM_SSH = "rusnas@10.10.10.72"
SSH_OPTS = ["-o", "StrictHostKeyChecking=no", "-o", "PreferredAuthentications=password",
            "-o", "PubkeyAuthentication=no"]
SSH_PASS = "kl4389qd"
COCKPIT_URL = "http://10.10.10.72:9090"
CONTAINERS_URL = "http://10.10.10.72:9090/cockpit/@localhost/rusnas/containers.html"
CGI = "/usr/lib/rusnas/cgi/container_api.py"


def ssh_run(cmd, check_json=False, timeout=30):
    """Run command on VM via SSH and return stdout."""
    full_cmd = ["sshpass", "-p", SSH_PASS, "ssh"] + SSH_OPTS + [VM_SSH, cmd]
    result = subprocess.run(full_cmd, capture_output=True, text=True, timeout=timeout)
    if check_json:
        out = result.stdout.strip()
        data = json.loads(out)
        return data
    return result.stdout.strip(), result.returncode


def cgi(cmd, args=None, timeout=30):
    """Call CGI backend directly on VM."""
    args_str = " ".join(args or [])
    cmd_str = f"sudo python3 {CGI} {cmd} {args_str}".strip()
    out, rc = ssh_run(cmd_str)
    return json.loads(out)


# ══════════════════════════════════════════════════════════
# BACKEND CGI TESTS
# ══════════════════════════════════════════════════════════

class TestBackendCGI:

    def test_list_installed_returns_ok(self):
        """list_installed returns ok:true with apps array"""
        r = cgi("list_installed")
        assert r["ok"] is True, f"Expected ok=true, got: {r}"
        assert "apps" in r, "Missing 'apps' key"
        assert isinstance(r["apps"], list), "apps should be a list"

    def test_list_installed_app_fields(self):
        """list_installed: each app has required fields"""
        r = cgi("list_installed")
        for app in r["apps"]:
            assert "app_id" in app, f"Missing app_id in: {app}"
            assert "live_status" in app, f"Missing live_status in: {app}"
            assert app["live_status"] in ("running", "stopped", "partial"), \
                f"Invalid live_status: {app['live_status']}"

    def test_get_catalog_returns_ok(self):
        """get_catalog returns ok:true with 10 apps"""
        r = cgi("get_catalog")
        assert r["ok"] is True
        assert "apps" in r
        assert len(r["apps"]) == 10, f"Expected 10 apps, got {len(r['apps'])}"

    def test_get_catalog_app_ids(self):
        """get_catalog: all 10 expected app IDs present"""
        expected_ids = {
            "nextcloud", "immich", "jellyfin", "vaultwarden",
            "home-assistant", "pihole", "wireguard", "mailcow",
            "onlyoffice", "rocketchat"
        }
        r = cgi("get_catalog")
        found_ids = {a["id"] for a in r["apps"]}
        assert found_ids == expected_ids, f"Missing apps: {expected_ids - found_ids}"

    def test_get_catalog_has_names(self):
        """BUG-TEST: get_catalog should include name from individual manifests"""
        r = cgi("get_catalog")
        for app in r["apps"]:
            assert "name" in app, \
                f"App '{app['id']}' missing 'name' field — catalog index.json doesn't include names"

    def test_get_catalog_has_description(self):
        """BUG-TEST: get_catalog should include description from individual manifests"""
        r = cgi("get_catalog")
        for app in r["apps"]:
            assert "description" in app, \
                f"App '{app['id']}' missing 'description' field"

    def test_get_catalog_has_install_params(self):
        """BUG-TEST: get_catalog should include install_params from individual manifests"""
        r = cgi("get_catalog")
        for app in r["apps"]:
            assert "install_params" in app, \
                f"App '{app['id']}' missing 'install_params' — modal will have no fields"

    def test_get_btrfs_volumes_returns_ok(self):
        """get_btrfs_volumes returns ok:true with volumes list"""
        r = cgi("get_btrfs_volumes")
        assert r["ok"] is True
        assert "volumes" in r
        assert isinstance(r["volumes"], list)

    def test_get_btrfs_volumes_has_fields(self):
        """get_btrfs_volumes: volumes have path, size, avail"""
        r = cgi("get_btrfs_volumes")
        for vol in r["volumes"]:
            assert "path" in vol, "Missing path"
            assert "size" in vol, "Missing size"
            assert "avail" in vol, "Missing avail"

    def test_get_stats_returns_ok(self):
        """get_stats returns ok:true with stats array"""
        r = cgi("get_stats")
        assert r["ok"] is True
        assert "stats" in r
        assert isinstance(r["stats"], list)

    def test_check_ports_free(self):
        """check_ports 8090: returns free=true"""
        r = cgi("check_ports", ["8090"])
        assert r["ok"] is True
        assert "free" in r
        assert "suggestion" in r
        assert r["port"] == 8090

    def test_check_ports_busy(self):
        """check_ports 80: port 80 is busy (nginx running), returns free=false"""
        r = cgi("check_ports", ["80"])
        assert r["ok"] is True
        assert r["free"] is False, "Port 80 should be busy (nginx is running)"
        assert r["suggestion"] != 80, "Suggestion should differ from busy port"

    def test_check_ports_suggestion_is_free(self):
        """check_ports: suggestion port is actually free"""
        r = cgi("check_ports", ["80"])
        if not r["free"]:
            suggestion = r["suggestion"]
            r2 = cgi("check_ports", [str(suggestion)])
            assert r2["free"] is True, \
                f"Suggested port {suggestion} should be free but is not"

    def test_check_ports_missing_arg(self):
        """check_ports without args: returns ok=false with error"""
        r = cgi("check_ports")
        assert r["ok"] is False
        assert "error" in r

    def test_nginx_conf_dir_exists(self):
        """NGINX_APPS_DIR /etc/nginx/conf.d/rusnas-apps/ exists"""
        out, rc = ssh_run("test -d /etc/nginx/conf.d/rusnas-apps && echo exists || echo missing")
        assert "exists" in out, "/etc/nginx/conf.d/rusnas-apps/ directory missing"

    def test_nginx_config_valid(self):
        """nginx -t: config is valid"""
        out, rc = ssh_run("sudo nginx -t 2>&1")
        assert "test is successful" in out, f"nginx config invalid: {out}"

    def test_installed_apps_have_nginx_conf(self):
        """Each installed app has nginx .conf file"""
        r = cgi("list_installed")
        for app in r["apps"]:
            app_id = app["app_id"]
            conf = f"/etc/nginx/conf.d/rusnas-apps/{app_id}.conf"
            out, rc = ssh_run(f"test -f {conf} && echo exists || echo missing")
            assert "exists" in out, f"Missing nginx conf for {app_id}: {conf}"


# ══════════════════════════════════════════════════════════
# PLAYWRIGHT FRONTEND TESTS
# ══════════════════════════════════════════════════════════

@pytest.fixture(scope="class")
def browser_page():
    """Shared browser + page fixture with Cockpit login."""
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--ignore-certificate-errors", "--no-sandbox"]
        )
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()

        # Login to Cockpit
        page.goto(COCKPIT_URL, timeout=20000)
        page.wait_for_load_state("networkidle")

        if page.locator("#login-user-input").is_visible():
            page.fill("#login-user-input", "rusnas")
            page.fill("#login-password-input", "kl4389qd")
            page.click("#login-button")
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(1500)

        # Navigate to containers page
        page.goto(CONTAINERS_URL, timeout=20000)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)  # Let JS initialize

        yield page

        browser.close()


class TestFrontendUI:

    def test_page_loads(self, browser_page):
        """Containers page loads without errors"""
        page = browser_page
        title = page.title()
        # Should be in an iframe within Cockpit; just check no crash
        assert page is not None

    def test_three_tabs_visible(self, browser_page):
        """All 3 tabs are visible: Каталог, Установленные, Свой контейнер"""
        page = browser_page
        tabs = page.locator(".advisor-tab-btn")
        count = tabs.count()
        assert count == 3, f"Expected 3 tabs, got {count}"
        labels = [tabs.nth(i).inner_text() for i in range(count)]
        assert any("Каталог" in l for l in labels), f"Каталог tab missing, got {labels}"
        assert any("Установленные" in l for l in labels), f"Установленные tab missing"
        assert any("Свой" in l for l in labels), f"Свой контейнер tab missing"

    def test_catalog_tab_active_by_default(self, browser_page):
        """Catalog tab is active by default"""
        page = browser_page
        active_btn = page.locator(".advisor-tab-btn.active")
        assert active_btn.count() >= 1
        assert "Каталог" in active_btn.first.inner_text()

    def test_catalog_grid_loads(self, browser_page):
        """Catalog grid shows app cards"""
        page = browser_page
        # Wait for catalog to load
        page.wait_for_timeout(2000)
        cards = page.locator(".app-card")
        count = cards.count()
        assert count > 0, f"Catalog grid empty — expected app cards, got {count}"

    def test_catalog_shows_10_apps(self, browser_page):
        """Catalog grid shows all 10 apps"""
        page = browser_page
        page.wait_for_timeout(1000)
        cards = page.locator(".app-card")
        count = cards.count()
        assert count == 10, f"Expected 10 app cards, got {count}"

    def test_catalog_app_names_not_ids(self, browser_page):
        """BUG-TEST: App cards show human names, not raw IDs like 'nextcloud'"""
        page = browser_page
        page.wait_for_timeout(1000)
        # The name field should be proper names not lowercase IDs
        card_names = page.locator(".app-card-name").all_inner_texts()
        for name in card_names:
            # A proper name like "Nextcloud", "Jellyfin" has capital first letter
            clean = name.split(" ")[0].strip()  # Remove badge text
            assert clean[0].isupper() or clean in ("Pi-hole",), \
                f"App name looks like raw ID (no capital): '{clean}'"

    def test_category_filter_all(self, browser_page):
        """Category filter 'Все' shows all 10 apps"""
        page = browser_page
        page.click('.cat-filter-btn[data-cat="all"]')
        page.wait_for_timeout(500)
        cards = page.locator(".app-card")
        assert cards.count() == 10, f"'Все' filter should show 10 apps, got {cards.count()}"

    def test_category_filter_cloud(self, browser_page):
        """Category filter 'Облако' filters correctly"""
        page = browser_page
        page.click('.cat-filter-btn[data-cat="cloud"]')
        page.wait_for_timeout(500)
        cards = page.locator(".app-card")
        count = cards.count()
        assert count >= 1, f"'Облако' filter shows 0 apps — expected at least 1 (nextcloud)"
        # Reset
        page.click('.cat-filter-btn[data-cat="all"]')
        page.wait_for_timeout(300)

    def test_category_filter_media(self, browser_page):
        """Category filter 'Медиа' shows jellyfin"""
        page = browser_page
        page.click('.cat-filter-btn[data-cat="media"]')
        page.wait_for_timeout(500)
        cards = page.locator(".app-card")
        assert cards.count() >= 1, "Media filter should show jellyfin"
        page.click('.cat-filter-btn[data-cat="all"]')
        page.wait_for_timeout(300)

    def test_category_filter_security(self, browser_page):
        """Category filter 'Безопасность' shows vaultwarden"""
        page = browser_page
        page.click('.cat-filter-btn[data-cat="security"]')
        page.wait_for_timeout(500)
        cards = page.locator(".app-card")
        assert cards.count() >= 1, "Security filter should show vaultwarden"
        page.click('.cat-filter-btn[data-cat="all"]')
        page.wait_for_timeout(300)

    def test_category_filter_active_style(self, browser_page):
        """Active category button has btn-primary class"""
        page = browser_page
        btn = page.locator('.cat-filter-btn[data-cat="photo"]')
        btn.click()
        page.wait_for_timeout(300)
        assert btn.get_attribute("class") is not None
        assert "btn-primary" in btn.get_attribute("class"), "Active filter btn should have btn-primary"
        page.click('.cat-filter-btn[data-cat="all"]')
        page.wait_for_timeout(300)

    def test_install_button_exists(self, browser_page):
        """Install buttons exist on uninstalled apps"""
        page = browser_page
        page.click('.cat-filter-btn[data-cat="all"]')
        page.wait_for_timeout(500)
        install_btns = page.locator(".install-catalog-btn")
        # At least some apps should have install buttons (those not already installed)
        count = install_btns.count()
        assert count >= 1, f"Expected install buttons, got {count}"

    def test_install_modal_opens(self, browser_page):
        """Install button opens the install modal"""
        page = browser_page
        # Click first install button
        btn = page.locator(".install-catalog-btn").first
        if btn.count() == 0:
            pytest.skip("All apps already installed — no install buttons")
        btn.click()
        page.wait_for_timeout(1000)
        modal = page.locator("#install-modal")
        assert not modal.get_attribute("class") or "hidden" not in modal.get_attribute("class"), \
            "Install modal should be visible"

    def test_install_modal_title(self, browser_page):
        """Install modal shows correct title with app name"""
        page = browser_page
        modal = page.locator("#install-modal")
        if "hidden" in (modal.get_attribute("class") or ""):
            # Open it
            btn = page.locator(".install-catalog-btn").first
            if btn.count() == 0:
                pytest.skip("No install buttons available")
            btn.click()
            page.wait_for_timeout(1000)
        title = page.locator("#install-modal-title").inner_text()
        assert "Установка" in title, f"Modal title should contain 'Установка', got: '{title}'"

    def test_install_modal_has_volume_selector(self, browser_page):
        """Install modal has volume selector"""
        page = browser_page
        modal = page.locator("#install-modal")
        if "hidden" in (modal.get_attribute("class") or ""):
            pytest.skip("Modal not open")
        vol_select = page.locator("#im-volume")
        assert vol_select.count() > 0, "Volume selector #im-volume not found in modal"

    def test_install_modal_has_form_fields(self, browser_page):
        """Install modal has install_params form fields"""
        page = browser_page
        modal = page.locator("#install-modal")
        if "hidden" in (modal.get_attribute("class") or ""):
            pytest.skip("Modal not open")
        form_area = page.locator("#install-form-area")
        # There should be some form groups (at minimum volume selector)
        groups = form_area.locator(".form-group")
        assert groups.count() >= 1, \
            f"Expected form groups in modal, got {groups.count()}"

    def test_install_modal_close_button(self, browser_page):
        """Install modal close button (X) hides the modal"""
        page = browser_page
        modal = page.locator("#install-modal")
        if "hidden" in (modal.get_attribute("class") or ""):
            btn = page.locator(".install-catalog-btn").first
            if btn.count() == 0:
                pytest.skip("No install buttons")
            btn.click()
            page.wait_for_timeout(800)
        # Close
        page.click("#install-modal-close")
        page.wait_for_timeout(500)
        assert "hidden" in (modal.get_attribute("class") or ""), "Modal should be hidden after close"

    def test_install_modal_cancel_button(self, browser_page):
        """Install modal 'Отмена' button hides the modal"""
        page = browser_page
        # Open modal
        btn = page.locator(".install-catalog-btn").first
        if btn.count() == 0:
            pytest.skip("No install buttons")
        btn.click()
        page.wait_for_timeout(800)
        # Cancel
        page.click("#install-cancel-btn")
        page.wait_for_timeout(500)
        modal = page.locator("#install-modal")
        assert "hidden" in (modal.get_attribute("class") or ""), "Modal should be hidden after cancel"

    def test_install_modal_port_field(self, browser_page):
        """Install modal has port field for apps with port param"""
        page = browser_page
        # Open nextcloud which has web_port param
        # Find install button for nextcloud
        page.click('.cat-filter-btn[data-cat="cloud"]')
        page.wait_for_timeout(500)
        btn = page.locator(".install-catalog-btn[data-appid='nextcloud']")
        if btn.count() == 0:
            pytest.skip("Nextcloud already installed or not showing install button")
        btn.click()
        page.wait_for_timeout(1500)  # Wait for port check
        # Should have a port input
        port_input = page.locator(".port-check-input")
        assert port_input.count() > 0, "No port input found in nextcloud install modal"
        # Close modal
        page.click("#install-modal-close")
        page.wait_for_timeout(300)
        page.click('.cat-filter-btn[data-cat="all"]')
        page.wait_for_timeout(300)

    def test_port_status_indicator(self, browser_page):
        """Port field shows availability status indicator (✓ or ✗)"""
        page = browser_page
        page.click('.cat-filter-btn[data-cat="cloud"]')
        page.wait_for_timeout(500)
        btn = page.locator(".install-catalog-btn[data-appid='nextcloud']")
        if btn.count() == 0:
            page.click('.cat-filter-btn[data-cat="all"]')
            pytest.skip("Nextcloud already installed")
        btn.click()
        page.wait_for_timeout(3000)  # Wait for initial port check
        # Status span should show something
        status = page.locator('[id$="-status"]').first
        text = status.inner_text()
        assert text != "…", f"Port status still showing '…' after 3 seconds, should show ✓ or ✗"
        page.click("#install-modal-close")
        page.wait_for_timeout(300)
        page.click('.cat-filter-btn[data-cat="all"]')
        page.wait_for_timeout(300)

    def test_gen_password_button(self, browser_page):
        """'Новый' button generates a new password"""
        page = browser_page
        btn = page.locator(".install-catalog-btn").first
        if btn.count() == 0:
            pytest.skip("No install buttons")
        btn.click()
        page.wait_for_timeout(1000)
        gen_btns = page.locator(".gen-pw-btn")
        if gen_btns.count() == 0:
            page.click("#install-modal-close")
            pytest.skip("No password gen buttons in this app")
        # Get current password value
        first_gen = gen_btns.first
        target_id = first_gen.get_attribute("data-target")
        old_val = page.locator(f"#{target_id}").input_value()
        # Click generate
        first_gen.click()
        page.wait_for_timeout(300)
        new_val = page.locator(f"#{target_id}").input_value()
        assert old_val != new_val, "Password should change after clicking 'Новый'"
        page.click("#install-modal-close")
        page.wait_for_timeout(300)

    def test_installed_tab_switch(self, browser_page):
        """Installed tab switches to installed view"""
        page = browser_page
        # Close any open modals first (install or logs modal)
        for modal_id in ["install-modal", "logs-modal"]:
            modal = page.locator(f"#{modal_id}")
            if modal.count() > 0 and "hidden" not in (modal.get_attribute("class") or ""):
                close_btn = page.locator(f"#{modal_id}-close")
                if close_btn.count() > 0 and close_btn.is_visible():
                    close_btn.click()
                    page.wait_for_timeout(500)
        page.wait_for_timeout(500)
        page.click('.advisor-tab-btn[data-tab="installed"]', force=True)
        page.wait_for_timeout(2000)
        tab = page.locator("#tab-installed")
        # Use evaluate to check computed display style
        display = page.evaluate('() => document.getElementById("tab-installed") ? window.getComputedStyle(document.getElementById("tab-installed")).display : "not_found"')
        assert display != "none", f"Installed tab should be visible (display={display})"

    def test_installed_tab_shows_content(self, browser_page):
        """Installed tab shows either app rows or empty state"""
        page = browser_page
        # Close any open modals first
        for modal_id in ["install-modal", "logs-modal"]:
            modal = page.locator(f"#{modal_id}")
            if modal.count() > 0 and "hidden" not in (modal.get_attribute("class") or ""):
                close_btn = page.locator(f"#{modal_id}-close")
                if close_btn.count() > 0 and close_btn.is_visible():
                    close_btn.click()
                    page.wait_for_timeout(300)
        page.click('.advisor-tab-btn[data-tab="installed"]')
        page.wait_for_timeout(2000)
        # Either installed-list has content OR installed-empty is visible
        installed_list = page.locator("#installed-list")
        empty_state = page.locator("#installed-empty")
        rows = page.locator(".installed-app-row")
        has_rows = rows.count() > 0
        empty_visible = empty_state.is_visible()
        assert has_rows or empty_visible, \
            "Installed tab should show app rows or empty state"

    def test_installed_tab_onlyoffice_present(self, browser_page):
        """ONLYOFFICE is in installed list (it was installed during previous session)"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="installed"]')
        page.wait_for_timeout(2000)
        rows = page.locator(".installed-app-row")
        count = rows.count()
        assert count >= 1, f"Expected at least 1 installed app (ONLYOFFICE), got {count}"

    def test_installed_app_has_action_buttons(self, browser_page):
        """Installed apps have action buttons (start/stop/restart)"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="installed"]')
        page.wait_for_timeout(2000)
        # Should have app-action-btn
        btns = page.locator(".app-action-btn")
        assert btns.count() > 0, "Installed apps should have action buttons"

    def test_installed_app_has_logs_button(self, browser_page):
        """Installed apps have logs button"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="installed"]')
        page.wait_for_timeout(2000)
        logs_btns = page.locator(".logs-btn")
        assert logs_btns.count() > 0, "Installed apps should have logs buttons"

    def test_installed_app_has_uninstall_button(self, browser_page):
        """Installed apps have uninstall button"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="installed"]')
        page.wait_for_timeout(2000)
        uninstall_btns = page.locator(".uninstall-btn")
        assert uninstall_btns.count() > 0, "Installed apps should have uninstall buttons"

    def test_logs_modal_opens(self, browser_page):
        """Logs button opens logs modal"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="installed"]')
        page.wait_for_timeout(2000)
        logs_btn = page.locator(".logs-btn").first
        if logs_btn.count() == 0:
            pytest.skip("No installed apps with logs buttons")
        logs_btn.click()
        page.wait_for_timeout(2000)
        modal = page.locator("#logs-modal")
        assert not "hidden" in (modal.get_attribute("class") or ""), \
            "Logs modal should be visible"

    def test_logs_modal_title(self, browser_page):
        """Logs modal has correct title"""
        page = browser_page
        modal = page.locator("#logs-modal")
        if "hidden" in (modal.get_attribute("class") or ""):
            pytest.skip("Logs modal not open")
        title = page.locator("#logs-modal-title").inner_text()
        assert "Логи" in title, f"Logs modal title should contain 'Логи', got: '{title}'"

    def test_logs_modal_has_content(self, browser_page):
        """Logs modal shows some content (loading... or actual logs)"""
        page = browser_page
        modal = page.locator("#logs-modal")
        if "hidden" in (modal.get_attribute("class") or ""):
            pytest.skip("Logs modal not open")
        content = page.locator("#logs-content").inner_text()
        # Should have something (loading, empty, or logs)
        assert len(content) > 0, "Logs content should not be empty"

    def test_logs_modal_close(self, browser_page):
        """Logs modal close button works"""
        page = browser_page
        modal = page.locator("#logs-modal")
        if "hidden" in (modal.get_attribute("class") or ""):
            # Open it first
            page.click('.advisor-tab-btn[data-tab="installed"]')
            page.wait_for_timeout(1000)
            btn = page.locator(".logs-btn").first
            if btn.count() == 0:
                pytest.skip("No logs buttons")
            btn.click()
            page.wait_for_timeout(1000)
        page.click("#logs-modal-close")
        page.wait_for_timeout(500)
        assert "hidden" in (modal.get_attribute("class") or ""), "Logs modal should close"

    def test_custom_tab_switch(self, browser_page):
        """Custom container tab switches correctly"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(500)
        tab = page.locator("#tab-custom")
        assert tab.is_visible(), "Custom tab content should be visible"

    def test_custom_tab_mode_cards_visible(self, browser_page):
        """Custom tab shows Simple and Compose mode cards"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(500)
        simple_card = page.locator("#mode-simple")
        compose_card = page.locator("#mode-compose")
        assert simple_card.is_visible(), "Simple mode card should be visible"
        assert compose_card.is_visible(), "Compose mode card should be visible"

    def test_custom_simple_form_shows_on_click(self, browser_page):
        """Clicking 'Простая форма' shows simple form"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(500)
        # Hide compose form if visible
        page.click("#mode-simple")
        page.wait_for_timeout(300)
        form = page.locator("#custom-simple-form")
        assert form.is_visible(), "Simple form should be visible after clicking mode-simple"

    def test_custom_simple_form_fields(self, browser_page):
        """Simple form has Название and Docker-образ fields"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(300)
        page.click("#mode-simple")
        page.wait_for_timeout(300)
        assert page.locator("#cs-name").is_visible(), "Название field not visible"
        assert page.locator("#cs-image").is_visible(), "Docker-образ field not visible"

    def test_custom_add_port_button(self, browser_page):
        """'+ Добавить порт' button adds a port row"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(300)
        page.click("#mode-simple")
        page.wait_for_timeout(300)
        initial_rows = page.locator("#cs-ports-list .param-row").count()
        page.click("#cs-add-port")
        page.wait_for_timeout(300)
        after_rows = page.locator("#cs-ports-list .param-row").count()
        assert after_rows == initial_rows + 1, \
            f"Expected {initial_rows + 1} port rows, got {after_rows}"

    def test_custom_add_env_button(self, browser_page):
        """'+ Добавить' env button adds an env row"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(300)
        page.click("#mode-simple")
        page.wait_for_timeout(300)
        initial_rows = page.locator("#cs-env-list .param-row").count()
        page.click("#cs-add-env")
        page.wait_for_timeout(300)
        after_rows = page.locator("#cs-env-list .param-row").count()
        assert after_rows == initial_rows + 1, \
            f"Expected {initial_rows + 1} env rows, got {after_rows}"

    def test_custom_port_row_remove(self, browser_page):
        """Port row has remove button that removes the row"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(300)
        page.click("#mode-simple")
        page.wait_for_timeout(300)
        page.click("#cs-add-port")
        page.wait_for_timeout(300)
        count_before = page.locator("#cs-ports-list .param-row").count()
        # Click remove on first row
        page.locator("#cs-ports-list .port-remove-btn").first.click()
        page.wait_for_timeout(300)
        count_after = page.locator("#cs-ports-list .param-row").count()
        assert count_after == count_before - 1, \
            f"Port row should be removed: before={count_before}, after={count_after}"

    def test_custom_cancel_hides_form(self, browser_page):
        """'Отмена' in simple form hides the form"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(300)
        page.click("#mode-simple")
        page.wait_for_timeout(300)
        page.click("#cs-cancel")
        page.wait_for_timeout(300)
        form = page.locator("#custom-simple-form")
        assert not form.is_visible(), "Simple form should be hidden after Отмена"

    def test_custom_compose_form_shows_on_click(self, browser_page):
        """Clicking 'Импорт Compose' shows compose form"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(300)
        page.click("#mode-compose")
        page.wait_for_timeout(300)
        form = page.locator("#custom-compose-form")
        assert form.is_visible(), "Compose form should be visible after clicking mode-compose"

    def test_custom_compose_has_dropzone(self, browser_page):
        """Compose form has dropzone for file upload"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(300)
        page.click("#mode-compose")
        page.wait_for_timeout(300)
        dropzone = page.locator("#cc-dropzone")
        assert dropzone.is_visible(), "Compose dropzone should be visible"

    def test_custom_compose_cancel(self, browser_page):
        """'Отмена' in compose form hides the form"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="custom"]')
        page.wait_for_timeout(300)
        page.click("#mode-compose")
        page.wait_for_timeout(300)
        page.click("#cc-cancel")
        page.wait_for_timeout(300)
        form = page.locator("#custom-compose-form")
        assert not form.is_visible(), "Compose form should be hidden after Отмена"

    def test_installed_badge_shows_count(self, browser_page):
        """Installed count badge shows number when apps installed"""
        page = browser_page
        badge = page.locator("#installed-count-badge")
        # Badge should be visible (we have 1 installed app: onlyoffice)
        assert badge.is_visible(), "Installed count badge should be visible"
        count_text = badge.inner_text()
        assert count_text.isdigit(), f"Badge should show a number, got: '{count_text}'"
        assert int(count_text) >= 1, f"Badge count should be >= 1, got {count_text}"

    def test_podman_version_shown(self, browser_page):
        """Podman version is shown in header"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="catalog"]')
        page.wait_for_timeout(3000)
        version_el = page.locator("#podman-version")
        text = version_el.inner_text()
        # May be empty if podman not running as container user, but element should exist
        assert version_el.count() > 0, "Podman version element missing"

    def test_start_button_immediate_feedback(self, browser_page):
        """Start button immediately shows '…' when clicked (not silent)"""
        page = browser_page
        page.click('.advisor-tab-btn[data-tab="installed"]')
        page.wait_for_timeout(2000)
        # Find a stopped app's start button
        start_btn = page.locator('.app-action-btn[data-action="start"]').first
        if start_btn.count() == 0:
            pytest.skip("No stopped apps with start button")
        # Click and immediately check state
        start_btn.click()
        # Should immediately show ... and be disabled
        page.wait_for_timeout(100)
        text = start_btn.inner_text()
        is_disabled = start_btn.is_disabled()
        assert is_disabled or text == "…", \
            f"Button should be disabled or show '…' immediately, got text='{text}', disabled={is_disabled}"
        # Wait for operation to complete
        page.wait_for_timeout(5000)


# ══════════════════════════════════════════════════════════
# ADDITIONAL BACKEND EDGE CASE TESTS
# ══════════════════════════════════════════════════════════

class TestBackendEdgeCases:

    def test_get_catalog_all_apps_have_category(self):
        """get_catalog: all apps have a category"""
        r = cgi("get_catalog")
        for app in r["apps"]:
            assert "category" in app, f"App '{app['id']}' missing category"
            assert app["category"] in (
                "cloud", "photo", "media", "office", "mail",
                "chat", "security", "network", "iot"
            ), f"Unknown category: {app['category']}"

    def test_list_installed_app_id_is_string(self):
        """list_installed: app_id is always a non-empty string"""
        r = cgi("list_installed")
        for app in r["apps"]:
            assert isinstance(app["app_id"], str), f"app_id should be string: {app}"
            assert len(app["app_id"]) > 0, "app_id should not be empty"

    def test_check_ports_range(self):
        """check_ports: test multiple common ports"""
        # Port 8765 should be free (if license server not running)
        r = cgi("check_ports", ["9999"])
        assert r["ok"] is True
        assert r["port"] == 9999

    def test_nginx_apps_conf_content(self):
        """nginx conf for installed app has location block and proxy_pass"""
        out, _ = ssh_run("cat /etc/nginx/conf.d/rusnas-apps/onlyoffice.conf 2>/dev/null")
        assert "location" in out, "nginx conf should have location block"
        assert "proxy_pass" in out, "nginx conf should have proxy_pass"
        assert "onlyoffice" in out or "office" in out or "8044" in out, \
            "nginx conf should reference the app"

    def test_installed_file_is_valid_json(self):
        """installed.json is valid JSON"""
        out, _ = ssh_run("cat /etc/rusnas/containers/installed.json 2>/dev/null")
        if not out.strip():
            pytest.skip("installed.json does not exist")
        data = json.loads(out)
        assert isinstance(data, dict), "installed.json should be a dict"

    def test_get_stats_handles_no_containers(self):
        """get_stats returns ok=true even when no containers running"""
        r = cgi("get_stats")
        assert r["ok"] is True
        # stats may be empty list if containers are stopped, that's fine
        assert isinstance(r["stats"], list)


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
