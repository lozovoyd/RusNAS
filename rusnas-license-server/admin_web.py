from fastapi import APIRouter, Request, Form, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
import os, time, db
from datetime import datetime
from typing import List, Optional

router = APIRouter(prefix="/admin")
_tmpl_dir = os.path.join(os.path.dirname(__file__), "static/admin")
templates = Jinja2Templates(directory=_tmpl_dir)
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "changeme")

def require_auth(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") or auth[7:] != ADMIN_TOKEN:
        raise HTTPException(401, headers={"WWW-Authenticate": "Bearer"})

@router.get("/", response_class=HTMLResponse)
async def admin_home(request: Request, _=Depends(require_auth)):
    serials = await db.get_all_serials()
    active  = await db.list_licenses(active_only=True)
    now = int(time.time())
    expiring = [l for l in active if l["expires_at"] and l["expires_at"] - now < 30*86400]
    return templates.TemplateResponse(request, "dashboard.html", {
        "total_serials": len(serials),
        "active_licenses": len(active), "expiring_soon": expiring
    })

@router.get("/serials", response_class=HTMLResponse)
async def admin_serials(request: Request, _=Depends(require_auth)):
    rows = await db.get_all_serials()
    return templates.TemplateResponse(request, "serials.html", {"serials": rows})

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
    return templates.TemplateResponse(request, "licenses.html",
        {"licenses": rows, "filter": filter})

@router.get("/license/new", response_class=HTMLResponse)
async def new_license_form(request: Request, _=Depends(require_auth)):
    from models import ALL_FEATURES
    return templates.TemplateResponse(request, "license_new.html",
        {"all_features": ALL_FEATURES})

@router.post("/license/new")
async def create_license_form(request: Request,
    serial: str = Form(...), license_type: str = Form(...),
    customer: str = Form(""), expires: str = Form(""),
    features: List[str] = Form(default=[]),
    max_volumes: int = Form(4), _=Depends(require_auth)):
    feat = {f: {"type": "addon_perpetual"} for f in features}
    # Always include base features
    feat.setdefault("core", {"type": "base"})
    feat.setdefault("updates_security", {"type": "base"})
    exp = None
    if expires:
        exp = int(datetime.strptime(expires, "%Y-%m-%d").timestamp())
    await db.create_license(serial, license_type, exp, feat, customer, max_volumes, "admin-web")
    return RedirectResponse("/admin/licenses", status_code=302)

@router.get("/license/{lid}", response_class=HTMLResponse)
async def license_detail(request: Request, lid: int, _=Depends(require_auth)):
    lic = await db.get_license_by_id(lid)
    if not lic: raise HTTPException(404)
    return templates.TemplateResponse(request, "license_detail.html", {"license": lic})

@router.post("/license/{lid}/revoke")
async def revoke(request: Request, lid: int, reason: str = Form(""), _=Depends(require_auth)):
    await db.revoke_license(lid, reason)
    return RedirectResponse("/admin/licenses", status_code=302)
