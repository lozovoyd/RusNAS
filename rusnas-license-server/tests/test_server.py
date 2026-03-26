import pytest, time, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from httpx import AsyncClient, ASGITransport
import db, crypto

@pytest.fixture(autouse=True)
async def setup_db(tmp_path):
    await db.init_db(str(tmp_path / "test.db"))

@pytest.fixture
def app(keypair, monkeypatch):
    import server
    monkeypatch.setattr(server, "PRIVATE_KEY", keypair[0])
    monkeypatch.setattr(server, "PUBLIC_KEY",  keypair[1])
    return server.app

@pytest.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c

@pytest.mark.asyncio
async def test_activate_valid(client, keypair):
    serial = "RUSNAS-BCDF-BCDF-BCDF-BCDF"
    await db.issue_serial(serial)
    await db.create_license(serial, "standard", None,
        {"guard": {"type": "addon_perpetual"}}, "Test Co", 4, "test")
    r = await client.post("/api/activate", json={"serial": serial})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["activation_code"].startswith("RNAC-")
    # verify the code is valid
    raw = crypto.normalize_activation_code(body["activation_code"])
    payload = crypto.verify_and_decode(keypair[1], raw)
    assert payload["serial"] == serial

@pytest.mark.asyncio
async def test_activate_serial_not_found(client):
    # Use a valid-format serial that just isn't in the DB
    r = await client.post("/api/activate", json={"serial": "RUSNAS-BCDF-GHJK-LMNP-QRST"})
    assert r.json()["error"] == "serial_not_found"

@pytest.mark.asyncio
async def test_activate_no_license(client):
    serial = "RUSNAS-BCDF-GHJK-LMNP-QRST"
    await db.issue_serial(serial)
    r = await client.post("/api/activate", json={"serial": serial})
    assert r.json()["error"] == "no_license"

@pytest.mark.asyncio
async def test_status_endpoint(client):
    serial = "RUSNAS-BCDF-BCDF-GHJK-LMNP"
    await db.issue_serial(serial)
    await db.create_license(serial, "standard", None, {}, "Co", 4, "t")
    r = await client.get(f"/api/status/{serial}")
    assert r.status_code == 200
    assert r.json()["has_license"] is True

@pytest.mark.asyncio
async def test_install_token_new_serial(client, keypair):
    serial = "RUSNAS-VWXZ-2345-679B-BCDF"
    await db.issue_serial(serial)
    r = await client.get(f"/api/install-token?serial={serial}")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["token"] is not None
    # verify it's a valid signed token
    from crypto import verify_and_decode
    import server
    payload = verify_and_decode(server.PUBLIC_KEY, body["token"])
    assert payload["type"] == "install"
    assert payload["serial"] == serial
    assert payload["install_at"] == body["install_at"]

@pytest.mark.asyncio
async def test_install_token_idempotent(client, keypair):
    serial = "RUSNAS-GHJK-GHJK-GHJK-GHJK"
    await db.issue_serial(serial)
    r1 = await client.get(f"/api/install-token?serial={serial}")
    r2 = await client.get(f"/api/install-token?serial={serial}")
    # install_at must be same both times (idempotent)
    assert r1.json()["install_at"] == r2.json()["install_at"]
