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
