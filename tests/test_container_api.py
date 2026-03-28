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

def test_catalog_index_has_10_apps():
    import os, json
    idx = os.path.join(os.path.dirname(__file__),
                       '../cockpit/rusnas/catalog/index.json')
    with open(idx) as f:
        data = json.load(f)
    assert len(data['apps']) == 10

def test_catalog_nextcloud_manifest():
    import os, json
    p = os.path.join(os.path.dirname(__file__),
                     '../cockpit/rusnas/catalog/nextcloud/rusnas-app.json')
    with open(p) as f:
        data = json.load(f)
    required = ['id','name','description','category','icon','default_port',
                'nginx_path','min_ram_mb','version']
    for key in required:
        assert key in data, f"Missing key: {key}"
    compose = os.path.join(os.path.dirname(p), 'docker-compose.yml')
    assert os.path.exists(compose), "docker-compose.yml missing for nextcloud"
