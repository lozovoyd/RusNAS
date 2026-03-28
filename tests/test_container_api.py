# tests/test_container_api.py
import subprocess, json, os, sys
CGI = os.path.join(os.path.dirname(__file__), '../cockpit/rusnas/cgi/container_api.py')

def call_cgi(*args):
    r = subprocess.run(['python3', CGI] + list(args), capture_output=True, text=True)
    return json.loads(r.stdout)

def test_list_installed_empty():
    r = call_cgi('list_installed')
    assert r.get('ok') is True
    assert 'apps' in r

def test_get_catalog_index():
    r = call_cgi('get_catalog')
    assert r.get('ok') is True
    assert 'apps' in r

def test_unknown_command_returns_error():
    r = call_cgi('nonexistent_cmd')
    assert r.get('ok') is False
    assert 'error' in r

def test_get_logs_missing_app():
    r = call_cgi('get_logs', 'nonexistent-app')
    assert r.get('ok') is False

def test_install_missing_app():
    r = call_cgi('install', 'nonexistent-app-xyz')
    assert r.get('ok') is False
    assert 'error' in r

def test_uninstall_missing_app():
    r = call_cgi('uninstall', 'nonexistent-app')
    assert r.get('ok') is False

def test_start_missing_app():
    r = call_cgi('start', 'nonexistent-app')
    assert r.get('ok') is False

def test_stop_missing_app():
    r = call_cgi('stop', 'nonexistent-app')
    assert r.get('ok') is False

def test_restart_missing_app():
    r = call_cgi('restart', 'nonexistent-app')
    assert r.get('ok') is False

def test_update_images_missing_app():
    r = call_cgi('update_images', 'nonexistent-app')
    assert r.get('ok') is False
