import pytest, time, base64, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from httpx import AsyncClient, ASGITransport
import db, crypto

GRACE = 180 * 86400

def make_basic(login, password):
    creds = base64.b64encode(f"{login}:{password}".encode()).decode()
    return {"Authorization": f"Basic {creds}"}

@pytest.fixture(autouse=True)
async def setup_db(tmp_path):
    await db.init_db(str(tmp_path / "test.db"))

@pytest.fixture
def app(keypair, monkeypatch):
    import apt_auth
    monkeypatch.setattr(apt_auth, "PUBLIC_KEY", keypair[1])
    return apt_auth.app

@pytest.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c

async def make_install_token(keypair, serial, install_at):
    priv, pub = keypair
    payload = {"ver": 1, "type": "install", "serial": serial, "install_at": install_at}
    return crypto.sign_payload(priv, payload)

@pytest.mark.asyncio
async def test_grace_period_allows_main(client, keypair):
    serial = "RUSNAS-BCDF-BCDF-BCDF-BCDF"
    await db.issue_serial(serial)
    install_at = int(time.time()) - 86400  # 1 day ago → still in grace
    await db.set_first_install_at(serial, install_at)
    token = await make_install_token(keypair, serial, install_at)
    r = await client.get("/apt-check",
        headers={**make_basic(serial, token), "X-Original-URI": "/apt/dists/trixie/main/"})
    assert r.status_code == 200

@pytest.mark.asyncio
async def test_grace_period_expired_no_license_denies_main(client, keypair):
    serial = "RUSNAS-GHJK-GHJK-GHJK-GHJK"
    await db.issue_serial(serial)
    install_at = int(time.time()) - GRACE - 86400  # expired
    await db.set_first_install_at(serial, install_at)
    token = await make_install_token(keypair, serial, install_at)
    r = await client.get("/apt-check",
        headers={**make_basic(serial, token), "X-Original-URI": "/apt/dists/trixie/main/"})
    assert r.status_code == 403

@pytest.mark.asyncio
async def test_grace_period_expired_with_license_allows_security(client, keypair):
    serial = "RUSNAS-LMNP-LMNP-LMNP-LMNP"
    await db.issue_serial(serial)
    install_at = int(time.time()) - GRACE - 86400
    await db.set_first_install_at(serial, install_at)
    await db.create_license(serial, "standard", None, {}, "Co", 4, "t")
    token = await make_install_token(keypair, serial, install_at)
    r = await client.get("/apt-check",
        headers={**make_basic(serial, token), "X-Original-URI": "/apt/dists/trixie/security/"})
    assert r.status_code == 200

@pytest.mark.asyncio
async def test_null_first_install_at_denies(client, keypair):
    serial = "RUSNAS-QRST-QRST-QRST-QRST"
    await db.issue_serial(serial)
    # No set_first_install_at → first_install_at IS NULL in DB
    # Use an activation-type token (not install-type), so the code falls through to DB lookup
    priv, pub = keypair
    payload = {"ver": 1, "type": "activation", "serial": serial, "issued_at": int(time.time())}
    token = crypto.sign_payload(priv, payload)
    r = await client.get("/apt-check",
        headers={**make_basic(serial, token), "X-Original-URI": "/apt/dists/trixie/main/"})
    assert r.status_code == 403

@pytest.mark.asyncio
async def test_tampered_token_denied(client, keypair):
    serial = "RUSNAS-VWXZ-VWXZ-VWXZ-VWXZ"
    await db.issue_serial(serial)
    await db.set_first_install_at(serial, int(time.time()))
    r = await client.get("/apt-check",
        headers={**make_basic(serial, "notavalidtoken"), "X-Original-URI": "/apt/dists/trixie/main/"})
    assert r.status_code == 403
