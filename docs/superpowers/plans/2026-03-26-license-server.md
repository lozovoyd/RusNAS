# License Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the rusNAS license server — FastAPI app that issues signed activation codes, validates serials, stores licenses in SQLite, and gates apt repository access per device.

**Architecture:** Ed25519-signed offline activation (copy-paste RNAC code), per-device apt token derived from serial + signed install-token, SQLite for all state. A separate `apt-auth.py` process (port 8766) handles nginx `auth_request` calls with 6-month grace period enforced server-side.

**Tech Stack:** Python 3.11+, FastAPI, uvicorn, aiosqlite, cryptography (Ed25519), pydantic v2, slowapi, Jinja2, pytest, pytest-asyncio, httpx (test client)

**Spec:** `docs/superpowers/specs/2026-03-26-distribution-licensing-design.md` + `rusnas-license-server-task.md`

---

## File Map

```
rusnas-license-server/
├── crypto.py              Ed25519 sign/verify, Base62 encode/decode, code formatting
├── db.py                  SQLite schema + async CRUD (aiosqlite)
├── models.py              Pydantic request/response models
├── server.py              FastAPI app: /api/activate, /api/status, /api/install-token
├── admin_web.py           FastAPI router: /admin/* (Jinja2 server-rendered)
├── apt_auth.py            Separate FastAPI app (port 8766): nginx auth_request handler
├── admin.py               CLI tool (argparse): serial/license/keygen/report commands
├── keygen.py              One-time keypair generator
├── static/
│   ├── activate.html      Customer activation page (vanilla JS, no CDN)
│   └── admin/
│       ├── base.html      Jinja2 base template
│       ├── dashboard.html Admin home
│       ├── serials.html   Serial list + batch import
│       ├── licenses.html  License list + filters
│       ├── license_new.html   Create license form
│       ├── license_detail.html  Detail + history + extend/revoke
│       └── report.html    Stats report
├── requirements.txt
├── requirements-dev.txt   pytest, pytest-asyncio, httpx
├── rusnas-license.service systemd unit (port 8765)
├── rusnas-apt-auth.service systemd unit (port 8766)
├── .env.example
├── tests/
│   ├── conftest.py        shared fixtures: test DB, test keys, test client
│   ├── test_crypto.py     sign/verify, base62, format/normalize
│   ├── test_db.py         CRUD operations, schema integrity
│   ├── test_server.py     /api/activate, /api/status, /api/install-token endpoints
│   └── test_apt_auth.py   grace period, token types, component gating
└── README.md
```

---

## Task 1: Project scaffold + crypto module

**Files:**
- Create: `rusnas-license-server/requirements.txt`
- Create: `rusnas-license-server/requirements-dev.txt`
- Create: `rusnas-license-server/tests/conftest.py`
- Create: `rusnas-license-server/tests/test_crypto.py`
- Create: `rusnas-license-server/crypto.py`

- [ ] **Step 1: Create directory and requirements**

```bash
mkdir -p rusnas-license-server/tests rusnas-license-server/static/admin
touch rusnas-license-server/__init__.py rusnas-license-server/tests/__init__.py
```

`rusnas-license-server/requirements.txt`:
```
fastapi>=0.110
uvicorn[standard]>=0.29
aiosqlite>=0.20
cryptography>=42.0
pydantic>=2.0
python-dotenv>=1.0
slowapi>=0.1.9
jinja2>=3.1
```

`rusnas-license-server/requirements-dev.txt`:
```
pytest>=8.0
pytest-asyncio>=0.23
httpx>=0.27
```

Install:
```bash
cd rusnas-license-server
python3 -m venv venv
venv/bin/pip install -r requirements.txt -r requirements-dev.txt
```

- [ ] **Step 2: Write failing crypto tests**

`rusnas-license-server/tests/conftest.py`:
```python
import pytest
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from crypto import generate_keypair, load_private_key_pem, load_public_key_pem

@pytest.fixture(scope="session")
def keypair(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("keys")
    priv_pem, pub_pem = generate_keypair()
    priv_path = tmp / "private.pem"
    pub_path  = tmp / "public.pem"
    priv_path.write_bytes(priv_pem)
    pub_path.write_bytes(pub_pem)
    return (
        load_private_key_pem(priv_pem),
        load_public_key_pem(pub_pem),
    )
```

`rusnas-license-server/tests/test_crypto.py`:
```python
import pytest
from crypto import (
    generate_keypair, load_private_key_pem, load_public_key_pem,
    sign_payload, verify_and_decode,
    base62_encode, base62_decode,
    format_activation_code, normalize_activation_code,
)
from cryptography.exceptions import InvalidSignature

def test_keypair_generation():
    priv, pub = generate_keypair()
    assert priv.startswith(b"-----BEGIN PRIVATE KEY-----")
    assert pub.startswith(b"-----BEGIN PUBLIC KEY-----")

def test_sign_and_verify_roundtrip(keypair):
    priv, pub = keypair
    payload = {"ver": 1, "serial": "RUSNAS-TEST-0000-0000-0001", "license_type": "standard"}
    code = sign_payload(priv, payload)
    result = verify_and_decode(pub, code)
    assert result["serial"] == "RUSNAS-TEST-0000-0000-0001"
    assert result["license_type"] == "standard"

def test_tampered_code_rejected(keypair):
    priv, pub = keypair
    code = sign_payload(priv, {"ver": 1, "serial": "X"})
    tampered = code[:-4] + "ZZZZ"
    with pytest.raises((InvalidSignature, ValueError)):
        verify_and_decode(pub, tampered)

def test_base62_roundtrip():
    data = b"\x00\x01\x02\xff\xfe" * 20
    assert base62_decode(base62_encode(data)) == data

def test_base62_leading_zeros():
    data = b"\x00\x00\x00abc"
    assert base62_decode(base62_encode(data)) == data

def test_format_normalize_roundtrip(keypair):
    priv, pub = keypair
    raw = sign_payload(priv, {"ver": 1, "x": "y"})
    formatted = format_activation_code(raw)
    assert formatted.startswith("RNAC-")
    assert normalize_activation_code(formatted) == raw
```

- [ ] **Step 3: Run tests — expect ImportError/FAIL**

```bash
cd rusnas-license-server
venv/bin/pytest tests/test_crypto.py -v 2>&1 | head -20
```
Expected: `ImportError: No module named 'crypto'`

- [ ] **Step 4: Implement crypto.py**

`rusnas-license-server/crypto.py`:
```python
import json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import (
    Encoding, PrivateFormat, PublicFormat, NoEncryption,
    load_pem_private_key, load_pem_public_key,
)
from cryptography.exceptions import InvalidSignature

BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

def generate_keypair() -> tuple[bytes, bytes]:
    key = Ed25519PrivateKey.generate()
    priv = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    pub  = key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    return priv, pub

def load_private_key_pem(pem: bytes) -> Ed25519PrivateKey:
    return load_pem_private_key(pem, password=None)

def load_public_key_pem(pem: bytes) -> Ed25519PublicKey:
    return load_pem_public_key(pem)

def load_private_key(path: str) -> Ed25519PrivateKey:
    return load_private_key_pem(open(path, "rb").read())

def load_public_key(path: str) -> Ed25519PublicKey:
    return load_public_key_pem(open(path, "rb").read())

def base62_encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    if n == 0:
        return BASE62_ALPHABET[0] * len(data)
    leading = len(data) - len(data.lstrip(b"\x00"))
    result = []
    while n:
        n, r = divmod(n, 62)
        result.append(BASE62_ALPHABET[r])
    return BASE62_ALPHABET[0] * leading + "".join(reversed(result))

def base62_decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 62 + BASE62_ALPHABET.index(c)
    leading = len(s) - len(s.lstrip(BASE62_ALPHABET[0]))
    if n == 0:
        return b"\x00" * len(s)
    result = []
    while n:
        n, r = divmod(n, 256)
        result.append(r)
    return b"\x00" * leading + bytes(reversed(result))

def sign_payload(private_key: Ed25519PrivateKey, payload: dict) -> str:
    payload_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    signature = private_key.sign(payload_bytes)
    blob = signature + payload_bytes
    return base62_encode(blob)

def verify_and_decode(public_key: Ed25519PublicKey, activation_code: str) -> dict:
    try:
        blob = base62_decode(activation_code)
    except (ValueError, IndexError) as e:
        raise ValueError(f"Cannot decode activation code: {e}")
    if len(blob) < 64:
        raise ValueError("Activation code too short")
    signature     = blob[:64]
    payload_bytes = blob[64:]
    public_key.verify(signature, payload_bytes)   # raises InvalidSignature if wrong
    return json.loads(payload_bytes)

def format_activation_code(raw_base62: str) -> str:
    blocks = [raw_base62[i:i+5] for i in range(0, len(raw_base62), 5)]
    lines  = [" ".join(blocks[i:i+8]) for i in range(0, len(blocks), 8)]
    return "RNAC-\n" + "\n".join(lines)

def normalize_activation_code(formatted: str) -> str:
    s = formatted.strip()
    if s.upper().startswith("RNAC-"):
        s = s[5:]
    return s.replace(" ", "").replace("\n", "").replace("\r", "").replace("-", "")
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd rusnas-license-server
venv/bin/pytest tests/test_crypto.py -v
```
Expected: all 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add rusnas-license-server/
git commit -m "feat: rusnas-license-server crypto module + tests"
```

---

## Task 2: Database module

**Files:**
- Create: `rusnas-license-server/tests/test_db.py`
- Create: `rusnas-license-server/db.py`

- [ ] **Step 1: Write failing DB tests**

`rusnas-license-server/tests/test_db.py`:
```python
import pytest
import asyncio, time
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
```

- [ ] **Step 2: Run — expect FAIL (no db module)**

```bash
cd rusnas-license-server
venv/bin/pytest tests/test_db.py -v 2>&1 | head -5
```

- [ ] **Step 3: Implement db.py**

`rusnas-license-server/db.py`:
```python
import aiosqlite, time, json
from typing import Optional

_DB_PATH: str = "./rusnas_licenses.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS serials (
    serial          TEXT PRIMARY KEY,
    issued_at       INTEGER NOT NULL,
    first_install_at INTEGER,
    batch           TEXT,
    note            TEXT
);
CREATE TABLE IF NOT EXISTS licenses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    serial        TEXT NOT NULL REFERENCES serials(serial),
    license_type  TEXT NOT NULL,
    expires_at    INTEGER,
    features_json TEXT NOT NULL,
    customer      TEXT,
    max_volumes   INTEGER DEFAULT 4,
    created_at    INTEGER NOT NULL,
    created_by    TEXT,
    revoked       INTEGER DEFAULT 0,
    revoke_reason TEXT
);
CREATE TABLE IF NOT EXISTS activations (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    serial               TEXT NOT NULL,
    license_id           INTEGER REFERENCES licenses(id),
    requested_at         INTEGER NOT NULL,
    ip                   TEXT,
    activation_code_hash TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    action  TEXT NOT NULL,
    serial  TEXT,
    ip      TEXT,
    details TEXT
);
"""

async def init_db(path: str = None) -> None:
    global _DB_PATH
    if path:
        _DB_PATH = path
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(SCHEMA)
        await db.commit()

async def issue_serial(serial: str, batch: str = None, note: str = None) -> bool:
    try:
        async with aiosqlite.connect(_DB_PATH) as db:
            await db.execute(
                "INSERT INTO serials (serial, issued_at, batch, note) VALUES (?,?,?,?)",
                (serial, int(time.time()), batch, note)
            )
            await db.commit()
        return True
    except aiosqlite.IntegrityError:
        return False

async def serial_exists(serial: str) -> bool:
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT 1 FROM serials WHERE serial=?", (serial,))
        return await cur.fetchone() is not None

async def get_serial(serial: str) -> Optional[dict]:
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM serials WHERE serial=?", (serial,))
        row = await cur.fetchone()
        return dict(row) if row else None

async def set_first_install_at(serial: str, ts: int) -> None:
    """Set first_install_at only if currently NULL (idempotent)."""
    async with aiosqlite.connect(_DB_PATH) as db:
        await db.execute(
            "UPDATE serials SET first_install_at=? WHERE serial=? AND first_install_at IS NULL",
            (ts, serial)
        )
        await db.commit()

async def get_active_license(serial: str) -> Optional[dict]:
    now = int(time.time())
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """SELECT * FROM licenses WHERE serial=? AND revoked=0
               AND (expires_at IS NULL OR expires_at > ?)
               ORDER BY created_at DESC LIMIT 1""",
            (serial, now)
        )
        row = await cur.fetchone()
        if not row:
            return None
        d = dict(row)
        d["features"] = json.loads(d.pop("features_json"))
        return d

async def create_license(serial, license_type, expires_at, features, customer, max_volumes, created_by) -> int:
    async with aiosqlite.connect(_DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO licenses (serial,license_type,expires_at,features_json,customer,
               max_volumes,created_at,created_by) VALUES (?,?,?,?,?,?,?,?)""",
            (serial, license_type, expires_at, json.dumps(features),
             customer, max_volumes, int(time.time()), created_by)
        )
        await db.commit()
        return cur.lastrowid

async def revoke_license(license_id: int, reason: str) -> bool:
    async with aiosqlite.connect(_DB_PATH) as db:
        cur = await db.execute(
            "UPDATE licenses SET revoked=1, revoke_reason=? WHERE id=?",
            (reason, license_id)
        )
        await db.commit()
        return cur.rowcount > 0

async def extend_license(license_id: int, new_expires_at: int) -> bool:
    async with aiosqlite.connect(_DB_PATH) as db:
        cur = await db.execute(
            "UPDATE licenses SET expires_at=? WHERE id=?", (new_expires_at, license_id)
        )
        await db.commit()
        return cur.rowcount > 0

async def log_activation(serial, license_id, ip, code_hash) -> None:
    async with aiosqlite.connect(_DB_PATH) as db:
        await db.execute(
            "INSERT INTO activations (serial,license_id,requested_at,ip,activation_code_hash) VALUES (?,?,?,?,?)",
            (serial, license_id, int(time.time()), ip, code_hash)
        )
        await db.commit()

async def audit(action, serial=None, ip=None, details=None) -> None:
    async with aiosqlite.connect(_DB_PATH) as db:
        await db.execute(
            "INSERT INTO audit_log (ts,action,serial,ip,details) VALUES (?,?,?,?,?)",
            (int(time.time()), action, serial, ip, details)
        )
        await db.commit()

async def list_licenses(active_only=False, expired=False, revoked=False) -> list:
    now = int(time.time())
    conditions, params = [], []
    if active_only:
        conditions.append("revoked=0 AND (expires_at IS NULL OR expires_at > ?)")
        params.append(now)
    if expired:
        conditions.append("expires_at IS NOT NULL AND expires_at <= ?")
        params.append(now)
    if revoked:
        conditions.append("revoked=1")
    where = ("WHERE " + " OR ".join(f"({c})" for c in conditions)) if conditions else ""
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(f"SELECT * FROM licenses {where} ORDER BY created_at DESC", params)
        rows = await cur.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["features"] = json.loads(d.pop("features_json"))
            result.append(d)
        return result

async def get_license_by_id(license_id: int) -> Optional[dict]:
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM licenses WHERE id=?", (license_id,))
        row = await cur.fetchone()
        if not row:
            return None
        d = dict(row)
        d["features"] = json.loads(d.pop("features_json"))
        return d

async def get_all_serials() -> list:
    async with aiosqlite.connect(_DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM serials ORDER BY issued_at DESC")
        return [dict(r) for r in await cur.fetchall()]

async def get_activation_count(serial: str) -> int:
    async with aiosqlite.connect(_DB_PATH) as db:
        cur = await db.execute("SELECT COUNT(*) FROM activations WHERE serial=?", (serial,))
        row = await cur.fetchone()
        return row[0]
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd rusnas-license-server
venv/bin/pytest tests/test_db.py -v
```
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add rusnas-license-server/db.py rusnas-license-server/tests/test_db.py
git commit -m "feat: license server database module + tests"
```

---

## Task 3: Pydantic models + server endpoints

**Files:**
- Create: `rusnas-license-server/models.py`
- Create: `rusnas-license-server/tests/test_server.py`
- Create: `rusnas-license-server/server.py`

- [ ] **Step 1: Create models.py**

`rusnas-license-server/models.py`:
```python
from pydantic import BaseModel, field_validator
import re

SERIAL_PATTERN = re.compile(
    r'^RUSNAS-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}(-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}){3}$'
)

def validate_serial_str(v: str) -> str:
    v = v.strip().upper()
    if not v.startswith("RUSNAS-"):
        v = "RUSNAS-" + v
    if not SERIAL_PATTERN.match(v):
        raise ValueError("Неверный формат серийного номера")
    return v

class ActivateRequest(BaseModel):
    serial: str

    @field_validator("serial")
    @classmethod
    def check_serial(cls, v):
        return validate_serial_str(v)

class ActivateResponse(BaseModel):
    ok: bool
    activation_code: str | None = None
    customer: str | None = None
    license_type: str | None = None
    expires_at: int | None = None
    features_summary: list[str] | None = None
    error: str | None = None
    message: str | None = None

class StatusResponse(BaseModel):
    ok: bool
    serial: str
    has_license: bool
    license_type: str | None = None
    expires_at: int | None = None
    customer: str | None = None
    activation_count: int = 0
    message: str | None = None

class InstallTokenResponse(BaseModel):
    ok: bool
    token: str | None = None
    install_at: int | None = None
    error: str | None = None

ALL_FEATURES = {
    "core":             "Базовые функции NAS",
    "guard":            "rusNAS Guard",
    "snapshots":        "Снапшоты Btrfs",
    "ssd_tier":         "SSD-уровень (dm-cache)",
    "storage_analyzer": "Storage Analyzer",
    "dedup":            "Дедупликация",
    "updates_security": "Критические обновления безопасности",
    "updates_features": "Обновления функций",
    "ha_cluster":       "HA Кластер",
    "fleet_mgmt":       "Fleet Management",
}
```

- [ ] **Step 2: Write failing server tests**

`rusnas-license-server/tests/test_server.py`:
```python
import pytest, time, json
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
    r = await client.post("/api/activate", json={"serial": "RUSNAS-XXXX-XXXX-XXXX-XXXX"})
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
async def test_install_token_new_serial(client):
    serial = "RUSNAS-VWXZ-2345-6789-BCDF"
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
async def test_install_token_idempotent(client):
    serial = "RUSNAS-GHJK-GHJK-GHJK-GHJK"
    await db.issue_serial(serial)
    r1 = await client.get(f"/api/install-token?serial={serial}")
    r2 = await client.get(f"/api/install-token?serial={serial}")
    # install_at must be same both times (idempotent)
    assert r1.json()["install_at"] == r2.json()["install_at"]
```

- [ ] **Step 3: Implement server.py**

`rusnas-license-server/server.py`:
```python
import os, time, hashlib
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from slowapi import Limiter
from slowapi.util import get_remote_address
from dotenv import load_dotenv

load_dotenv()

import db, crypto
from models import ActivateRequest, ActivateResponse, StatusResponse, InstallTokenResponse, ALL_FEATURES

app = FastAPI(title="rusNAS License Server", docs_url=None, redoc_url=None)
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

PRIVATE_KEY_PATH = os.getenv("PRIVATE_KEY_PATH", "./operator_private.pem")
PUBLIC_KEY_PATH  = os.getenv("PUBLIC_KEY_PATH",  "./operator_public.pem")

# Loaded once at startup
PRIVATE_KEY = None
PUBLIC_KEY  = None

@app.on_event("startup")
async def startup():
    global PRIVATE_KEY, PUBLIC_KEY
    await db.init_db(os.getenv("DB_PATH", "./rusnas_licenses.db"))
    PRIVATE_KEY = crypto.load_private_key(PRIVATE_KEY_PATH)
    PUBLIC_KEY  = crypto.load_public_key(PUBLIC_KEY_PATH)

@app.get("/", response_class=HTMLResponse)
async def index():
    path = os.path.join(os.path.dirname(__file__), "static", "activate.html")
    return HTMLResponse(open(path).read())

@app.get("/health")
async def health():
    return {"ok": True}

@app.post("/api/activate", response_model=ActivateResponse)
@limiter.limit("5/minute")
async def activate(request: Request, body: ActivateRequest):
    serial = body.serial
    if not await db.serial_exists(serial):
        return ActivateResponse(ok=False, error="serial_not_found",
            message="Серийный номер не найден.")
    license = await db.get_active_license(serial)
    if not license:
        return ActivateResponse(ok=False, error="no_license",
            message="Лицензия не найдена. Обратитесь к поставщику.")
    features = license["features"]
    # Always include core + updates_security in payload
    payload_features = {"core": {"type": "base"}, "updates_security": {"type": "base"}}
    payload_features.update(features)
    payload = {
        "ver": 1,
        "type": "activation",
        "serial": serial,
        "issued_at": int(time.time()),
        "license_type": license["license_type"],
        "expires_at": license["expires_at"],
        "customer": license["customer"] or "",
        "max_volumes": license["max_volumes"],
        "features": payload_features,
    }
    raw = crypto.sign_payload(PRIVATE_KEY, payload)
    formatted = crypto.format_activation_code(raw)
    code_hash = hashlib.sha256(raw.encode()).hexdigest()
    ip = request.client.host if request.client else "unknown"
    await db.log_activation(serial, license["id"], ip, code_hash)
    await db.audit("activate", serial, ip)
    summary = _features_summary(payload_features)
    return ActivateResponse(ok=True, activation_code=formatted,
        customer=license["customer"], license_type=license["license_type"],
        expires_at=license["expires_at"], features_summary=summary)

@app.get("/api/status/{serial}", response_model=StatusResponse)
async def status(serial: str):
    from models import validate_serial_str
    try:
        serial = validate_serial_str(serial)
    except ValueError:
        raise HTTPException(422, "Invalid serial format")
    if not await db.serial_exists(serial):
        return StatusResponse(ok=False, serial=serial, has_license=False,
            message="Серийный номер не найден.")
    license = await db.get_active_license(serial)
    count = await db.get_activation_count(serial)
    if not license:
        return StatusResponse(ok=True, serial=serial, has_license=False, activation_count=count)
    return StatusResponse(ok=True, serial=serial, has_license=True,
        license_type=license["license_type"], expires_at=license["expires_at"],
        customer=license["customer"], activation_count=count)

@app.get("/api/install-token", response_model=InstallTokenResponse)
@limiter.limit("10/hour")
async def install_token(request: Request, serial: str):
    from models import validate_serial_str
    try:
        serial = validate_serial_str(serial)
    except ValueError:
        return InstallTokenResponse(ok=False, error="invalid_serial")
    if not await db.serial_exists(serial):
        return InstallTokenResponse(ok=False, error="serial_not_found")
    row = await db.get_serial(serial)
    install_at = row["first_install_at"]
    if install_at is None:
        install_at = int(time.time())
        await db.set_first_install_at(serial, install_at)
    payload = {"ver": 1, "type": "install", "serial": serial, "install_at": install_at}
    token = crypto.sign_payload(PRIVATE_KEY, payload)
    ip = request.client.host if request.client else "unknown"
    await db.audit("install_token_issued", serial, ip)
    return InstallTokenResponse(ok=True, token=token, install_at=install_at)

def _features_summary(features: dict) -> list[str]:
    result = []
    for fid, fdata in features.items():
        if fid in ("core", "updates_security"):
            continue
        name = ALL_FEATURES.get(fid, fid)
        if fdata["type"] == "addon_perpetual":
            result.append(f"{name} (бессрочно)")
        elif fdata["type"] == "addon_timed":
            exp = fdata.get("expires_at")
            if exp:
                from datetime import datetime
                result.append(f"{name} (до {datetime.fromtimestamp(exp).strftime('%d.%m.%Y')})")
    return result
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd rusnas-license-server
venv/bin/pytest tests/test_server.py -v
```
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add rusnas-license-server/models.py rusnas-license-server/server.py rusnas-license-server/tests/test_server.py
git commit -m "feat: license server API endpoints + models"
```

---

## Task 4: apt-auth service

**Files:**
- Create: `rusnas-license-server/tests/test_apt_auth.py`
- Create: `rusnas-license-server/apt_auth.py`

- [ ] **Step 1: Write failing apt-auth tests**

`rusnas-license-server/tests/test_apt_auth.py`:
```python
import pytest, time, base64
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

async def make_activation_token(keypair, serial, features=None):
    priv, pub = keypair
    features = features or {"updates_features": {"type": "addon_timed", "expires_at": int(time.time()) + 86400*365}}
    payload = {"ver": 1, "type": "activation", "serial": serial,
               "issued_at": int(time.time()), "license_type": "standard",
               "expires_at": None, "customer": "Test", "max_volumes": 4, "features": features}
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
    # No set_first_install_at → first_install_at IS NULL
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
```

- [ ] **Step 2: Run — expect FAIL**

```bash
venv/bin/pytest tests/test_apt_auth.py -v 2>&1 | head -5
```

- [ ] **Step 3: Implement apt_auth.py**

`rusnas-license-server/apt_auth.py`:
```python
import os, time, base64
from fastapi import FastAPI, Request, Response
from dotenv import load_dotenv
import db, crypto
from cryptography.exceptions import InvalidSignature

load_dotenv()
app = FastAPI(docs_url=None)
GRACE = 180 * 86400
PUBLIC_KEY = None

@app.on_event("startup")
async def startup():
    global PUBLIC_KEY
    await db.init_db(os.getenv("DB_PATH", "./rusnas_licenses.db"))
    PUBLIC_KEY = crypto.load_public_key(os.getenv("PUBLIC_KEY_PATH", "./operator_public.pem"))

@app.get("/apt-check")
async def apt_check(request: Request):
    auth = request.headers.get("Authorization", "")
    uri  = request.headers.get("X-Original-URI", "")
    component = "main" if "/main/" in uri else "security"

    serial, token = _parse_basic_auth(auth)
    if not serial or not token:
        return Response(status_code=401)

    try:
        payload = crypto.verify_and_decode(PUBLIC_KEY, token)
    except (InvalidSignature, ValueError):
        return Response(status_code=403)

    if payload.get("serial") != serial:
        return Response(status_code=403)

    token_type = payload.get("type", "activation")

    if token_type == "install":
        install_at = payload.get("install_at")
        if install_at is None:
            return Response(status_code=403)
    else:
        row = await db.get_serial(serial)
        if not row:
            return Response(status_code=403)
        install_at = row["first_install_at"]
        if install_at is None:
            return Response(status_code=403)  # DB inconsistency — deny

    now = time.time()
    if now < install_at + GRACE:
        return Response(status_code=200)  # grace period

    license = await db.get_active_license(serial)
    if component == "security":
        if license and not license.get("revoked"):
            return Response(status_code=200)
        return Response(status_code=403)
    else:  # main
        if license and _has_active_feature(license, "updates_features"):
            return Response(status_code=200)
        return Response(status_code=403)

def _parse_basic_auth(header: str):
    if not header.startswith("Basic "):
        return None, None
    try:
        decoded = base64.b64decode(header[6:]).decode()
        serial, token = decoded.split(":", 1)
        return serial, token
    except Exception:
        return None, None

def _has_active_feature(license: dict, feature: str) -> bool:
    features = license.get("features", {})
    if feature not in features:
        return False
    f = features[feature]
    if f["type"] == "base" or f["type"] == "addon_perpetual":
        return True
    if f["type"] == "addon_timed":
        exp = f.get("expires_at")
        return exp is None or exp > time.time()
    return False
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
venv/bin/pytest tests/test_apt_auth.py -v
```
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add rusnas-license-server/apt_auth.py rusnas-license-server/tests/test_apt_auth.py
git commit -m "feat: apt-auth service with grace period + license gating"
```

---

## Task 5: Admin CLI (admin.py + keygen.py)

**Files:**
- Create: `rusnas-license-server/admin.py`
- Create: `rusnas-license-server/keygen.py`

(CLI tools — no automated tests; verify manually)

- [ ] **Step 1: Implement keygen.py**

`rusnas-license-server/keygen.py`:
```python
#!/usr/bin/env python3
"""Generate operator Ed25519 keypair. Run once at VPS setup."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from crypto import generate_keypair

def main():
    priv, pub = generate_keypair()
    priv_path, pub_path = "operator_private.pem", "operator_public.pem"
    with open(priv_path, "wb") as f: f.write(priv)
    with open(pub_path,  "wb") as f: f.write(pub)
    os.chmod(priv_path, 0o600)
    print(f"Generated {priv_path} (600) and {pub_path}")
    print("\n⚠️  ВАЖНО: operator_private.pem — храните в тайне, делайте резервные копии!")
    print("\nPublic key (вшейте в образ rusNAS):")
    print(pub.decode())

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Implement admin.py** (core commands — serial/license/report)

`rusnas-license-server/admin.py`:
```python
#!/usr/bin/env python3
import argparse, asyncio, time, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import db, crypto
from datetime import datetime

def ts(dt_str):
    return int(datetime.strptime(dt_str, "%Y-%m-%d").timestamp())

def fmt_ts(ts):
    if ts is None: return "бессрочно"
    return datetime.fromtimestamp(ts).strftime("%d.%m.%Y")

async def cmd_serial_add(args):
    ok = await db.issue_serial(args.serial, batch=args.batch, note=args.note)
    print("Added" if ok else "Already exists")

async def cmd_serial_import(args):
    serials = [l.strip() for l in open(args.file) if l.strip()]
    for s in serials:
        ok = await db.issue_serial(s, batch=args.batch)
        print(f"{'OK' if ok else 'DUP'} {s}")

async def cmd_serial_list(args):
    rows = await db.get_all_serials()
    for r in rows:
        print(f"{r['serial']}  batch={r['batch']}  install={fmt_ts(r['first_install_at'])}")

async def cmd_license_create(args):
    features = {}
    feat_list = args.features.split(",") if args.features != "all" else list(__import__("models").ALL_FEATURES.keys())
    for f in feat_list:
        f = f.strip()
        features[f] = {"type": "addon_perpetual"}
    expires = None if args.no_expiry else ts(args.expires)
    lid = await db.create_license(args.serial, args.type, expires,
        features, args.customer, args.max_volumes, args.operator or "admin")
    print(f"License #{lid} created for {args.serial}")

async def cmd_license_show(args):
    lic = await db.get_active_license(args.serial)
    if not lic:
        print("No active license")
        return
    print(f"Serial:      {args.serial}")
    print(f"Customer:    {lic['customer']}")
    print(f"Type:        {lic['license_type']}")
    print(f"Expires:     {fmt_ts(lic['expires_at'])}")
    print(f"Max volumes: {lic['max_volumes']}")
    print(f"Status:      {'REVOKED' if lic['revoked'] else 'ACTIVE'}")
    count = await db.get_activation_count(args.serial)
    print(f"Activations: {count}")

async def cmd_license_revoke(args):
    lic = await db.get_active_license(args.serial)
    if not lic:
        print("No active license")
        return
    await db.revoke_license(lic["id"], args.reason)
    print(f"License #{lic['id']} revoked")

async def cmd_gen_code(args):
    priv = crypto.load_private_key(os.getenv("PRIVATE_KEY_PATH", "./operator_private.pem"))
    lic = await db.get_active_license(args.serial)
    if not lic:
        print("No active license"); return
    features = {"core": {"type": "base"}, "updates_security": {"type": "base"}}
    features.update(lic["features"])
    payload = {"ver": 1, "type": "activation", "serial": args.serial,
               "issued_at": int(time.time()), "license_type": lic["license_type"],
               "expires_at": lic["expires_at"], "customer": lic["customer"] or "",
               "max_volumes": lic["max_volumes"], "features": features}
    raw = crypto.sign_payload(priv, payload)
    print(crypto.format_activation_code(raw))

async def cmd_report(args):
    serials = await db.get_all_serials()
    active  = await db.list_licenses(active_only=True)
    expired = await db.list_licenses(expired=True)
    revoked = await db.list_licenses(revoked=True)
    print(f"Serials: {len(serials)} total")
    print(f"Licenses: {len(active)} active, {len(expired)} expired, {len(revoked)} revoked")

def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd")

    # serial
    ps = sub.add_parser("serial"); ss = ps.add_subparsers(dest="sub")
    a = ss.add_parser("add"); a.add_argument("serial"); a.add_argument("--batch"); a.add_argument("--note")
    a = ss.add_parser("import"); a.add_argument("file"); a.add_argument("--batch")
    ss.add_parser("list")

    # license
    pl = sub.add_parser("license"); ls = pl.add_subparsers(dest="sub")
    a = ls.add_parser("create")
    a.add_argument("--serial", required=True); a.add_argument("--type", default="standard")
    a.add_argument("--expires"); a.add_argument("--no-expiry", action="store_true")
    a.add_argument("--customer", default=""); a.add_argument("--features", default="core")
    a.add_argument("--max-volumes", type=int, default=4); a.add_argument("--operator")
    a = ls.add_parser("show"); a.add_argument("serial")
    a = ls.add_parser("revoke"); a.add_argument("serial"); a.add_argument("--reason", default="")

    # gen-code / report / keygen
    a = sub.add_parser("gen-code"); a.add_argument("serial")
    sub.add_parser("report")
    sub.add_parser("keygen")

    args = p.parse_args()
    asyncio.run(db.init_db())

    dispatch = {
        ("serial", "add"):         cmd_serial_add,
        ("serial", "import"):      cmd_serial_import,
        ("serial", "list"):        cmd_serial_list,
        ("license", "create"):     cmd_license_create,
        ("license", "show"):       cmd_license_show,
        ("license", "revoke"):     cmd_license_revoke,
        "gen-code":                cmd_gen_code,
        "report":                  cmd_report,
    }
    key = (args.cmd, getattr(args, "sub", None)) if args.cmd in ("serial", "license") else args.cmd
    fn = dispatch.get(key)
    if fn:
        asyncio.run(fn(args))
    else:
        p.print_help()

if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Smoke test CLI manually**

```bash
cd rusnas-license-server
python3 keygen.py
# Expected: operator_private.pem + operator_public.pem created
python3 admin.py serial add RUSNAS-TEST-BCDF-GHJK-LMNP --note "test"
python3 admin.py serial list
python3 admin.py license create --serial RUSNAS-TEST-BCDF-GHJK-LMNP --type standard --expires 2027-01-01 --customer "Test Co" --features guard,snapshots
python3 admin.py license show RUSNAS-TEST-BCDF-GHJK-LMNP
python3 admin.py gen-code RUSNAS-TEST-BCDF-GHJK-LMNP
```

- [ ] **Step 4: Commit**

```bash
git add rusnas-license-server/admin.py rusnas-license-server/keygen.py
git commit -m "feat: admin CLI + keygen for license server"
```

---

## Task 6: Admin Web UI + activate.html

**Files:**
- Create: `rusnas-license-server/admin_web.py`
- Create: `rusnas-license-server/static/activate.html`
- Create: `rusnas-license-server/static/admin/*.html` (6 templates)
- Modify: `rusnas-license-server/server.py` (mount admin router)

- [ ] **Step 1: Implement activate.html**

`rusnas-license-server/static/activate.html` — self-contained HTML with:
- Input mask `RUSNAS-____-____-____-____` (JS auto-insert dashes, uppercase)
- POST to `/api/activate` via fetch
- Show `activation_code` in `<textarea readonly>` with copy button
- Dark theme: `#1a2332` header, `#fff` content, accent `#0099ff`
- No external dependencies

Key JS snippet:
```html
<script>
const inp = document.getElementById('serial');
inp.addEventListener('input', e => {
  let v = e.target.value.replace(/[^BCDFGHJKLMNPQRSTVWXYZ2345679]/gi,'').toUpperCase();
  let parts = [v.slice(0,4), v.slice(4,8), v.slice(8,12), v.slice(12,16)].filter(Boolean);
  e.target.value = parts.length ? 'RUSNAS-' + parts.join('-') : '';
});
document.getElementById('btn').addEventListener('click', async () => {
  const r = await fetch('/api/activate', {method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({serial: inp.value})});
  const d = await r.json();
  if (d.ok) { document.getElementById('result').value = d.activation_code; }
  else { document.getElementById('error').textContent = d.message; }
});
document.getElementById('copy').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('result').value);
});
</script>
```

- [ ] **Step 2: Implement admin_web.py with Jinja2 templates**

`rusnas-license-server/admin_web.py`:
```python
from fastapi import APIRouter, Request, Form, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
import os, time, db
from datetime import datetime

router = APIRouter(prefix="/admin")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "static/admin"))
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "changeme")

def require_auth(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") or auth[7:] != ADMIN_TOKEN:
        raise HTTPException(401, headers={"WWW-Authenticate": "Bearer"})

@router.get("/", response_class=HTMLResponse)
async def admin_home(request: Request, _=Depends(require_auth)):
    serials  = await db.get_all_serials()
    active   = await db.list_licenses(active_only=True)
    now = int(time.time())
    expiring = [l for l in active if l["expires_at"] and l["expires_at"] - now < 30*86400]
    return templates.TemplateResponse("dashboard.html",
        {"request": request, "total_serials": len(serials),
         "active_licenses": len(active), "expiring_soon": expiring})

@router.get("/serials", response_class=HTMLResponse)
async def admin_serials(request: Request, _=Depends(require_auth)):
    rows = await db.get_all_serials()
    return templates.TemplateResponse("serials.html", {"request": request, "serials": rows})

@router.post("/serials/import")
async def import_serials(request: Request, serials_text: str = Form(...), _=Depends(require_auth)):
    for line in serials_text.strip().splitlines():
        s = line.strip()
        if s: await db.issue_serial(s)
    return RedirectResponse("/admin/serials", status_code=302)

@router.get("/licenses", response_class=HTMLResponse)
async def admin_licenses(request: Request, filter: str = "active", _=Depends(require_auth)):
    if filter == "expired":
        rows = await db.list_licenses(expired=True)
    elif filter == "revoked":
        rows = await db.list_licenses(revoked=True)
    else:
        rows = await db.list_licenses(active_only=True)
    return templates.TemplateResponse("licenses.html",
        {"request": request, "licenses": rows, "filter": filter})

@router.get("/license/new", response_class=HTMLResponse)
async def new_license_form(request: Request, _=Depends(require_auth)):
    from models import ALL_FEATURES
    return templates.TemplateResponse("license_new.html",
        {"request": request, "all_features": ALL_FEATURES})

@router.post("/license/new")
async def create_license(request: Request,
    serial: str = Form(...), license_type: str = Form(...),
    customer: str = Form(""), expires: str = Form(""),
    features: list[str] = Form(...), max_volumes: int = Form(4),
    _=Depends(require_auth)):
    feat = {f: {"type": "addon_perpetual"} for f in features}
    exp = None
    if expires:
        exp = int(datetime.strptime(expires, "%Y-%m-%d").timestamp())
    await db.create_license(serial, license_type, exp, feat, customer, max_volumes, "admin-web")
    return RedirectResponse("/admin/licenses", status_code=302)

@router.get("/license/{lid}", response_class=HTMLResponse)
async def license_detail(request: Request, lid: int, _=Depends(require_auth)):
    lic = await db.get_license_by_id(lid)
    if not lic: raise HTTPException(404)
    return templates.TemplateResponse("license_detail.html", {"request": request, "license": lic})

@router.post("/license/{lid}/revoke")
async def revoke(lid: int, reason: str = Form(""), _=Depends(require_auth)):
    await db.revoke_license(lid, reason)
    return RedirectResponse("/admin/licenses", status_code=302)
```

- [ ] **Step 3: Create minimal Jinja2 templates** (6 files in `static/admin/`)

Each template extends `base.html`. Base has rusNAS dark theme nav. Create minimal but functional HTML for each route. Keep CSS inline, no CDN.

`static/admin/base.html`:
```html
<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>rusNAS Admin</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui; background: #0f1923; color: #e0e6f0; min-height: 100vh; }
nav { background: #1a2332; padding: 12px 24px; display: flex; gap: 16px; align-items: center; }
nav a { color: #7eb3e8; text-decoration: none; font-size: 14px; }
nav a:hover { color: #fff; }
.container { max-width: 1100px; margin: 32px auto; padding: 0 16px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { padding: 10px 12px; border-bottom: 1px solid #1e2d3d; text-align: left; }
th { background: #1a2332; }
.btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
.btn-primary { background: #0099ff; color: #fff; }
.btn-danger { background: #e74c3c; color: #fff; }
input, select, textarea { background: #1a2332; color: #e0e6f0; border: 1px solid #2d3f52; padding: 8px; border-radius: 4px; width: 100%; }
.badge-active { color: #2ecc71; } .badge-expired { color: #e74c3c; } .badge-revoked { color: #95a5a6; }
</style></head><body>
<nav><strong style="color:#fff">rusNAS Admin</strong>
<a href="/admin/">Dashboard</a><a href="/admin/serials">Серийники</a>
<a href="/admin/licenses">Лицензии</a><a href="/admin/report">Отчёт</a></nav>
<div class="container">{% block content %}{% endblock %}</div>
</body></html>
```

Create remaining 5 templates with `{% extends "base.html" %}` and `{% block content %}` showing the relevant data from context variables.

- [ ] **Step 4: Mount admin router in server.py**

Add to `server.py`:
```python
from admin_web import router as admin_router
app.include_router(admin_router)
```

- [ ] **Step 5: Manual smoke test**

```bash
cd rusnas-license-server
python3 keygen.py  # if not already done
PRIVATE_KEY_PATH=./operator_private.pem PUBLIC_KEY_PATH=./operator_public.pem DB_PATH=./test.db ADMIN_TOKEN=testtoken venv/bin/uvicorn server:app --reload
```

Open `http://localhost:8000/` — verify activate.html renders.
Open `http://localhost:8000/admin/` with `Authorization: Bearer testtoken` — verify dashboard.

- [ ] **Step 6: Commit**

```bash
git add rusnas-license-server/
git commit -m "feat: admin web UI + activate.html"
```

---

## Task 7: systemd units + .env + README

**Files:**
- Create: `rusnas-license-server/rusnas-license.service`
- Create: `rusnas-license-server/rusnas-apt-auth.service`
- Create: `rusnas-license-server/.env.example`
- Create: `rusnas-license-server/README.md`

- [ ] **Step 1: Create service files and env example**

`rusnas-license-server/rusnas-license.service`:
```ini
[Unit]
Description=rusNAS License Server
After=network.target

[Service]
Type=simple
User=rusnas-license
WorkingDirectory=/opt/rusnas-license-server
EnvironmentFile=/opt/rusnas-license-server/.env
ExecStart=/opt/rusnas-license-server/venv/bin/uvicorn server:app --host ${HOST} --port ${PORT}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/rusnas-license-server

[Install]
WantedBy=multi-user.target
```

`rusnas-license-server/rusnas-apt-auth.service`:
```ini
[Unit]
Description=rusNAS apt-auth Service
After=network.target

[Service]
Type=simple
User=rusnas-license
WorkingDirectory=/opt/rusnas-license-server
EnvironmentFile=/opt/rusnas-license-server/.env
ExecStart=/opt/rusnas-license-server/venv/bin/uvicorn apt_auth:app --host 127.0.0.1 --port 8766
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`rusnas-license-server/.env.example`:
```ini
PRIVATE_KEY_PATH=./operator_private.pem
PUBLIC_KEY_PATH=./operator_public.pem
DB_PATH=./rusnas_licenses.db
HOST=127.0.0.1
PORT=8765
ADMIN_TOKEN=change_me_to_random_string
```

- [ ] **Step 2: Run full test suite**

```bash
cd rusnas-license-server
venv/bin/pytest tests/ -v
```
Expected: all tests PASS (crypto: 7, db: 5, server: 6, apt_auth: 5 = 23 total)

- [ ] **Step 3: Commit**

```bash
git add rusnas-license-server/
git commit -m "feat: license server complete — systemd units, env, all tests passing"
```
