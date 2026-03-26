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
    pub_path = os.getenv("PUBLIC_KEY_PATH", "./operator_public.pem")
    if os.path.exists(pub_path):
        PUBLIC_KEY = crypto.load_public_key(pub_path)

@app.get("/apt-check")
async def apt_check(request: Request):
    auth = request.headers.get("Authorization", "")
    uri  = request.headers.get("X-Original-URI", "")
    component = "security" if "/security/" in uri else "main"

    serial, token = _parse_basic_auth(auth)
    if not serial or not token:
        return Response(status_code=401)

    try:
        payload = crypto.verify_and_decode(PUBLIC_KEY, token)
    except (InvalidSignature, ValueError, Exception):
        return Response(status_code=403)

    if payload.get("serial") != serial:
        return Response(status_code=403)

    token_type = payload.get("type", "activation")

    if token_type == "install":
        install_at = payload.get("install_at")
        if install_at is None:
            return Response(status_code=403)
    else:
        # For activation tokens: look up first_install_at from DB
        row = await db.get_serial(serial)
        if not row:
            return Response(status_code=403)
        install_at = row["first_install_at"]
        if install_at is None:
            return Response(status_code=403)

    now = time.time()
    if now < install_at + GRACE:
        return Response(status_code=200)  # still in grace period

    # Grace expired — check license
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
        return serial.strip(), token.strip()
    except Exception:
        return None, None

def _has_active_feature(license: dict, feature: str) -> bool:
    features = license.get("features", {})
    if feature not in features:
        return False
    f = features[feature]
    ftype = f.get("type", "")
    if ftype in ("base", "addon_perpetual"):
        return True
    if ftype == "addon_timed":
        exp = f.get("expires_at")
        return exp is None or exp > time.time()
    return False
