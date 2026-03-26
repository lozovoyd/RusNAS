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
    async with aiosqlite.connect(_DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.executescript(SCHEMA)
        await conn.commit()

async def issue_serial(serial: str, batch: str = None, note: str = None) -> bool:
    try:
        async with aiosqlite.connect(_DB_PATH) as conn:
            await conn.execute(
                "INSERT INTO serials (serial, issued_at, batch, note) VALUES (?,?,?,?)",
                (serial, int(time.time()), batch, note)
            )
            await conn.commit()
        return True
    except aiosqlite.IntegrityError:
        return False

async def serial_exists(serial: str) -> bool:
    async with aiosqlite.connect(_DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("SELECT 1 FROM serials WHERE serial=?", (serial,))
        return await cur.fetchone() is not None

async def get_serial(serial: str) -> Optional[dict]:
    async with aiosqlite.connect(_DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("SELECT * FROM serials WHERE serial=?", (serial,))
        row = await cur.fetchone()
        return dict(row) if row else None

async def set_first_install_at(serial: str, ts: int) -> None:
    """Set first_install_at only if currently NULL (idempotent)."""
    async with aiosqlite.connect(_DB_PATH) as conn:
        await conn.execute(
            "UPDATE serials SET first_install_at=? WHERE serial=? AND first_install_at IS NULL",
            (ts, serial)
        )
        await conn.commit()

async def get_active_license(serial: str) -> Optional[dict]:
    now = int(time.time())
    async with aiosqlite.connect(_DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute(
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
    async with aiosqlite.connect(_DB_PATH) as conn:
        cur = await conn.execute(
            """INSERT INTO licenses (serial,license_type,expires_at,features_json,customer,
               max_volumes,created_at,created_by) VALUES (?,?,?,?,?,?,?,?)""",
            (serial, license_type, expires_at, json.dumps(features),
             customer, max_volumes, int(time.time()), created_by)
        )
        await conn.commit()
        return cur.lastrowid

async def revoke_license(license_id: int, reason: str) -> bool:
    async with aiosqlite.connect(_DB_PATH) as conn:
        cur = await conn.execute(
            "UPDATE licenses SET revoked=1, revoke_reason=? WHERE id=?",
            (reason, license_id)
        )
        await conn.commit()
        return cur.rowcount > 0

async def extend_license(license_id: int, new_expires_at: int) -> bool:
    async with aiosqlite.connect(_DB_PATH) as conn:
        cur = await conn.execute(
            "UPDATE licenses SET expires_at=? WHERE id=?", (new_expires_at, license_id)
        )
        await conn.commit()
        return cur.rowcount > 0

async def log_activation(serial, license_id, ip, code_hash) -> None:
    async with aiosqlite.connect(_DB_PATH) as conn:
        await conn.execute(
            "INSERT INTO activations (serial,license_id,requested_at,ip,activation_code_hash) VALUES (?,?,?,?,?)",
            (serial, license_id, int(time.time()), ip, code_hash)
        )
        await conn.commit()

async def audit(action, serial=None, ip=None, details=None) -> None:
    async with aiosqlite.connect(_DB_PATH) as conn:
        await conn.execute(
            "INSERT INTO audit_log (ts,action,serial,ip,details) VALUES (?,?,?,?,?)",
            (int(time.time()), action, serial, ip, details)
        )
        await conn.commit()

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
    async with aiosqlite.connect(_DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute(f"SELECT * FROM licenses {where} ORDER BY created_at DESC", params)
        rows = await cur.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["features"] = json.loads(d.pop("features_json"))
            result.append(d)
        return result

async def get_license_by_id(license_id: int) -> Optional[dict]:
    async with aiosqlite.connect(_DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("SELECT * FROM licenses WHERE id=?", (license_id,))
        row = await cur.fetchone()
        if not row:
            return None
        d = dict(row)
        d["features"] = json.loads(d.pop("features_json"))
        return d

async def get_all_serials() -> list:
    async with aiosqlite.connect(_DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("SELECT * FROM serials ORDER BY issued_at DESC")
        return [dict(r) for r in await cur.fetchall()]
