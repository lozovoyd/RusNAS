import pytest
import asyncio, time
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import db

@pytest.fixture
async def database(tmp_path):
    path = str(tmp_path / "test.db")
    await db.init_db(path)
    db._DB_PATH = path
    yield path

@pytest.mark.asyncio
async def test_issue_serial(database):
    ok = await db.issue_serial("RUSNAS-TEST-0001-0001-0001", batch="b1")
    assert ok is True
    dup = await db.issue_serial("RUSNAS-TEST-0001-0001-0001")
    assert dup is False

@pytest.mark.asyncio
async def test_serial_exists(database):
    await db.issue_serial("RUSNAS-TEST-0002-0002-0002")
    assert await db.serial_exists("RUSNAS-TEST-0002-0002-0002") is True
    assert await db.serial_exists("RUSNAS-NONE-NONE-NONE-NONE") is False

@pytest.mark.asyncio
async def test_create_and_get_license(database):
    serial = "RUSNAS-TEST-0003-0003-0003"
    await db.issue_serial(serial)
    lid = await db.create_license(
        serial=serial, license_type="standard",
        expires_at=int(time.time()) + 86400,
        features={"guard": {"type": "addon_perpetual"}},
        customer="Test Co", max_volumes=4, created_by="pytest"
    )
    assert lid > 0
    lic = await db.get_active_license(serial)
    assert lic["license_type"] == "standard"
    assert lic["customer"] == "Test Co"

@pytest.mark.asyncio
async def test_revoke_license(database):
    serial = "RUSNAS-TEST-0004-0004-0004"
    await db.issue_serial(serial)
    lid = await db.create_license(serial, "standard", None, {}, "X", 4, "pytest")
    await db.revoke_license(lid, "test revoke")
    lic = await db.get_active_license(serial)
    assert lic is None

@pytest.mark.asyncio
async def test_set_first_install_at(database):
    serial = "RUSNAS-TEST-0005-0005-0005"
    await db.issue_serial(serial)
    row = await db.get_serial(serial)
    assert row["first_install_at"] is None
    await db.set_first_install_at(serial, 1740000000)
    row = await db.get_serial(serial)
    assert row["first_install_at"] == 1740000000
    # idempotent: second call does NOT overwrite
    await db.set_first_install_at(serial, 9999999999)
    row = await db.get_serial(serial)
    assert row["first_install_at"] == 1740000000
