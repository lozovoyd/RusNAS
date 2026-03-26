import os, time, hashlib
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from dotenv import load_dotenv

load_dotenv()

import db, crypto
from models import ActivateRequest, ActivateResponse, StatusResponse, InstallTokenResponse, ALL_FEATURES

app = FastAPI(title="rusNAS License Server", docs_url=None, redoc_url=None)
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

from admin_web import router as admin_router
app.include_router(admin_router)

PRIVATE_KEY_PATH = os.getenv("PRIVATE_KEY_PATH", "./operator_private.pem")
PUBLIC_KEY_PATH  = os.getenv("PUBLIC_KEY_PATH",  "./operator_public.pem")

# Loaded once at startup
PRIVATE_KEY = None
PUBLIC_KEY  = None

@app.on_event("startup")
async def startup():
    global PRIVATE_KEY, PUBLIC_KEY
    await db.init_db(os.getenv("DB_PATH", "./rusnas_licenses.db"))
    if os.path.exists(PRIVATE_KEY_PATH) and os.path.exists(PUBLIC_KEY_PATH):
        PRIVATE_KEY = crypto.load_private_key(PRIVATE_KEY_PATH)
        PUBLIC_KEY  = crypto.load_public_key(PUBLIC_KEY_PATH)

@app.get("/", response_class=HTMLResponse)
async def index():
    path = os.path.join(os.path.dirname(__file__), "static", "activate.html")
    if os.path.exists(path):
        return HTMLResponse(open(path).read())
    return HTMLResponse("<h1>rusNAS License Server</h1>")

@app.get("/health")
async def health():
    return {"ok": True}

@app.post("/api/activate", response_model=ActivateResponse)
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
        if fdata["type"] == "base" or fdata["type"] == "addon_perpetual":
            result.append(f"{name} (бессрочно)")
        elif fdata["type"] == "addon_timed":
            exp = fdata.get("expires_at")
            if exp:
                from datetime import datetime
                result.append(f"{name} (до {datetime.fromtimestamp(exp).strftime('%d.%m.%Y')})")
    return result
