# Task: rusNAS License Server

## Статус реализации: ✅ Реализовано 2026-03-26

**Ветка:** `feat/bootstrap-installer-spec` (не смержена в `main` на 2026-03-26)
**Тесты:** 22/22 pass (pytest + pytest-asyncio)
**Cockpit страница:** задеплоена на тестовый VM (10.10.10.72)

### Реальная структура проекта (после реализации)

```
rusnas-license-server/
├── server.py               # FastAPI app (port 8765) — API + activation page
├── models.py               # Pydantic v2 models + SERIAL_PATTERN + ALL_FEATURES
├── crypto.py               # Ed25519 sign/verify, Base62 encode/decode, RNAC format
├── db.py                   # aiosqlite CRUD + set_first_install_at + get_activation_count
├── admin.py                # CLI: serial add/import/list, license create/show/revoke, gen-code, report
├── admin_web.py            # Jinja2 web admin UI (router /admin, Bearer auth)
├── apt_auth.py             # FastAPI app (port 8766) — nginx auth_request subrequest handler
├── keygen.py               # Ed25519 keypair generator
├── static/
│   ├── activate.html       # Customer activation portal (input mask, copy button)
│   └── admin/
│       ├── base.html       # Jinja2 base layout with nav
│       ├── dashboard.html  # Stats overview
│       ├── serials.html    # Serial list
│       ├── licenses.html   # License list
│       ├── license_new.html # Create license form
│       └── license_detail.html # License details + revoke
├── tests/
│   ├── conftest.py         # session-scoped keypair fixture
│   ├── test_crypto.py      # 6 tests: keypair, sign/verify, tamper, base62, leading zeros, format
│   ├── test_db.py          # 5 async tests: CRUD operations
│   ├── test_server.py      # 6 async tests: activate, status, install-token
│   └── test_apt_auth.py    # 5 async tests: grace period, license gating, token tamper
├── requirements.txt        # fastapi, uvicorn, aiosqlite, cryptography, pydantic, python-dotenv, slowapi, jinja2, python-multipart
├── pytest.ini              # asyncio_mode = auto (REQUIRED for pytest-asyncio ≥1.3)
├── rusnas-license.service  # systemd unit (user: rusnas-license, port 8765)
├── rusnas-apt-auth.service # systemd unit (port 8766, localhost only)
├── .env.example            # PRIVATE_KEY_PATH, PUBLIC_KEY_PATH, DB_PATH, HOST, PORT, ADMIN_TOKEN
└── README.md               # VPS setup + CLI usage + API docs

bootstrap.sh               # One-command installer (at repo root)
vps-setup/
├── nginx-rusnas.conf       # nginx virtual host for activate.rusnas.ru
└── README.md               # Deploy instructions

cockpit/rusnas/
├── license.html            # Cockpit plugin page (13th page, order:13)
├── js/license.js           # Ed25519 verify (WebCrypto) + write license.json + apt conf
└── manifest.json           # Added "license" menu entry
```

### Оператор ключевая пара (тестовая)

**Публичный ключ (raw base64, вшит в license.js):**
```
1d6UQHGzNP3wZPQVFpXUkc5qF+5UAyQlrUMSQAffdA0=
```
> ⚠️ При деплое на prod — `python3 keygen.py` → новая пара → обновить `OPERATOR_PUBLIC_KEY_B64` в `license.js`

### Известные gotchas (при доработке)

| Проблема | Решение |
|---------|---------|
| `pytest-asyncio` ≥1.3 STRICT mode | `pytest.ini` с `asyncio_mode = auto` — обязательно |
| `python-multipart` отсутствует | FastAPI Form() требует его — добавлен в requirements.txt |
| Starlette 1.0 TemplateResponse | `request` — первый позиционный аргумент, НЕ в context dict |
| `@app.on_event("startup")` deprecated | DeprecationWarning — нефатально, тесты проходят; при рефакторе заменить на `lifespan` handler |
| Тестовый серийник с `8` в charset | `8` не в алфавите `[BCDFGHJKLMNPQRSTVWXYZ2345679]`; в тестах использовать только валидные символы |
| `XXXX` в тестовом серийнике | `X` не в charset — тесты падают; использовать символы из алфавита |
| `form-control` на `<textarea>` в Cockpit | PatternFly/Bootstrap `.form-control` переопределяет dark mode — убрать класс, оставить `.form-group textarea` |

### Pending (не реализовано)

- [ ] VPS деплой: systemd юниты, apt репозиторий (reprepro), nginx конфиг
- [ ] Ansible role для раскатки license server
- [ ] Пакет `rusnas-system` (deb пакет, installs Cockpit plugin)
- [ ] Реальная сборка и подписание deb пакетов через reprepro
- [ ] Тест bootstrap.sh на реальной Debian 13 VM (требует VPS)
- [ ] Apt-auth integration test (requires reprepro + nginx)

---

## Overview

Серверная часть системы лицензирования rusNAS. Развёртывается оператором на отдельном VPS (не на устройстве клиента). Отвечает за:

- Хранение базы серийных номеров и лицензий
- Генерацию криптографически подписанных кодов активации
- Веб-страницу активации для клиентов
- CLI-инструмент управления лицензиями для оператора

Устройства rusNAS **никогда не обращаются к этому серверу напрямую** — активация происходит через пользователя (copy-paste кода активации).

---

## Структура проекта

```
rusnas-license-server/
├── server.py               # FastAPI приложение (HTTP API + статика)
├── models.py               # Pydantic-модели запросов и ответов
├── crypto.py               # Ed25519 подписи, кодирование Activation Code
├── db.py                   # SQLite: инициализация схемы, CRUD-операции
├── admin.py                # CLI для управления лицензиями (argparse)
├── keygen.py               # Генерация ключевой пары оператора
├── static/
│   └── activate.html       # Страница активации (встроенный CSS, без JS-фреймворков)
├── requirements.txt
├── rusnas-license.service  # systemd unit для VPS
├── .env.example            # Пример переменных окружения
└── README.md               # Инструкция по развёртыванию
```

---

## Зависимости (`requirements.txt`)

```
fastapi>=0.110
uvicorn[standard]>=0.29
aiosqlite>=0.20
cryptography>=42.0
pydantic>=2.0
python-dotenv>=1.0
slowapi>=0.1.9
```

---

## Конфигурация (`.env`)

```ini
# Путь к приватному ключу оператора (Ed25519, PEM)
PRIVATE_KEY_PATH=./operator_private.pem

# Путь к базе данных
DB_PATH=./rusnas_licenses.db

# Хост и порт для uvicorn
HOST=127.0.0.1
PORT=8765

# Токен для защиты admin API (если понадобится HTTP admin endpoint в будущем)
ADMIN_TOKEN=change_me_to_random_string
```

`.env.example` — копия без реальных значений, добавить в `.gitignore`: `operator_private.pem`, `.env`, `rusnas_licenses.db`.

---

## Часть 1: Криптография (`crypto.py`)

### Ключевая пара

Используется **Ed25519** из библиотеки `cryptography`.

```python
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey, Ed25519PublicKey
)
from cryptography.hazmat.primitives.serialization import (
    Encoding, PrivateFormat, PublicFormat, NoEncryption,
    load_pem_private_key, load_pem_public_key
)
```

**Функции модуля:**

```python
def generate_keypair() -> tuple[bytes, bytes]:
    """
    Генерирует новую ключевую пару Ed25519.
    Возвращает (private_pem_bytes, public_pem_bytes).
    """

def load_private_key(path: str) -> Ed25519PrivateKey:
    """Загружает приватный ключ из PEM-файла."""

def load_public_key(path: str) -> Ed25519PublicKey:
    """Загружает публичный ключ из PEM-файла."""

def sign_payload(private_key: Ed25519PrivateKey, payload: dict) -> str:
    """
    Подписывает payload (dict → JSON bytes → Ed25519 signature).
    
    Алгоритм:
      1. payload_bytes = json.dumps(payload, sort_keys=True, separators=(',',':')).encode('utf-8')
      2. signature = private_key.sign(payload_bytes)   # 64 bytes
      3. blob = signature + payload_bytes               # signature prepended
      4. return base62_encode(blob)
    
    Возвращает строку Base62 — это и есть Activation Code.
    """

def verify_and_decode(public_key: Ed25519PublicKey, activation_code: str) -> dict:
    """
    Верифицирует Activation Code и возвращает payload.
    
    Алгоритм:
      1. blob = base62_decode(activation_code)
      2. signature = blob[:64]
      3. payload_bytes = blob[64:]
      4. public_key.verify(signature, payload_bytes)   # raises InvalidSignature если неверно
      5. return json.loads(payload_bytes)
    
    Raises: ValueError если код не декодируется
            cryptography.exceptions.InvalidSignature если подпись неверна
    """
```

### Base62

**Алфавит:** `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz` (ровно 62 символа, в этом порядке).

```python
BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

def base62_encode(data: bytes) -> str:
    """Кодирует bytes в Base62 строку."""
    # Стандартный алгоритм: число → остатки от деления на 62
    # Сохранять leading zeros: считать ведущие нулевые байты отдельно

def base62_decode(s: str) -> bytes:
    """Декодирует Base62 строку в bytes."""
```

### Формат Activation Code (финальный вид для пользователя)

Сырой Base62 (~300–380 символов) форматируется для отображения блоками по 5 символов, группами по 8 блоков в строке:

```
RNAC-
Ak3fP 2XqmB 9zK4L wN7Pq Hj2Xm Bv5Kq 9mKzP QwR3n
...
```

Префикс `RNAC-` для визуальной идентификации. При вводе в Cockpit UI — нормализация: убрать все пробелы, переносы строк, префикс `RNAC-`.

**Функции форматирования:**

```python
def format_activation_code(raw_base62: str) -> str:
    """Добавляет префикс RNAC- и форматирует блоками для отображения."""

def normalize_activation_code(formatted: str) -> str:
    """Убирает форматирование, возвращает чистый Base62."""
```

---

## Часть 2: База данных (`db.py`)

SQLite, синхронный интерфейс (aiosqlite для FastAPI async endpoints).

### Схема

```sql
-- Выпущенные серийные номера
CREATE TABLE IF NOT EXISTS serials (
    serial      TEXT PRIMARY KEY,
    issued_at   INTEGER NOT NULL,
    batch       TEXT,
    note        TEXT
);

-- Лицензии
CREATE TABLE IF NOT EXISTS licenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    serial       TEXT NOT NULL REFERENCES serials(serial),
    license_type TEXT NOT NULL,     -- 'standard' | 'enterprise' | 'perpetual' | 'oem'
    expires_at   INTEGER,           -- UNIX timestamp, NULL = бессрочная
    features_json TEXT NOT NULL,    -- JSON-объект features (см. формат ниже)
    customer     TEXT,              -- название клиента (свободная строка)
    max_volumes  INTEGER DEFAULT 4,
    created_at   INTEGER NOT NULL,
    created_by   TEXT,              -- имя оператора / сотрудника
    revoked      INTEGER DEFAULT 0, -- 0 | 1
    revoke_reason TEXT
);

-- Лог выдачи кодов активации
CREATE TABLE IF NOT EXISTS activations (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    serial               TEXT NOT NULL,
    license_id           INTEGER REFERENCES licenses(id),
    requested_at         INTEGER NOT NULL,
    ip                   TEXT,
    activation_code_hash TEXT    -- SHA256(raw_base62) для аудита без хранения кода
);

-- Аудит лог всех операций
CREATE TABLE IF NOT EXISTS audit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    action  TEXT NOT NULL,   -- 'issue_serial' | 'create_license' | 'activate' | 'revoke' | ...
    serial  TEXT,
    ip      TEXT,
    details TEXT             -- JSON или свободный текст
);
```

### Функции `db.py`

```python
async def init_db(db_path: str) -> None:
    """Создаёт таблицы если не существуют."""

async def issue_serial(serial: str, batch: str = None, note: str = None) -> bool:
    """Добавляет серийник в таблицу serials. False если уже существует."""

async def serial_exists(serial: str) -> bool:

async def get_active_license(serial: str) -> dict | None:
    """
    Возвращает активную лицензию для серийника или None.
    Активная = не revoked И (expires_at IS NULL ИЛИ expires_at > now()).
    """

async def create_license(serial: str, license_type: str, expires_at: int | None,
                          features: dict, customer: str, max_volumes: int,
                          created_by: str) -> int:
    """Создаёт лицензию, возвращает id."""

async def revoke_license(license_id: int, reason: str) -> bool:

async def extend_license(license_id: int, new_expires_at: int) -> bool:

async def log_activation(serial: str, license_id: int, ip: str, code_hash: str) -> None:

async def audit(action: str, serial: str = None, ip: str = None, details: str = None) -> None:

async def list_licenses(expired: bool = False, active: bool = True) -> list[dict]:

async def get_license_by_id(license_id: int) -> dict | None:

async def get_all_serials() -> list[dict]:
```

---

## Часть 3: Модели (`models.py`)

```python
from pydantic import BaseModel, field_validator
import re

class ActivateRequest(BaseModel):
    serial: str

    @field_validator('serial')
    @classmethod
    def validate_serial(cls, v: str) -> str:
        # Формат: RUSNAS-XXXX-XXXX-XXXX-XXXX (X из алфавита без похожих символов)
        # Принимаем с префиксом RUSNAS- или без (для удобства)
        v = v.strip().upper()
        pattern = r'^(?:RUSNAS-)?[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}$'
        # Нормализуем: добавляем RUSNAS- если нет
        clean = v if v.startswith("RUSNAS-") else "RUSNAS-" + v
        if not re.match(r'^RUSNAS-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}(-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}){3}$', clean):
            raise ValueError("Неверный формат серийного номера")
        return clean

class ActivateResponse(BaseModel):
    ok: bool
    activation_code: str | None = None   # форматированный с RNAC- и пробелами
    customer: str | None = None
    license_type: str | None = None
    expires_at: int | None = None         # UNIX timestamp или None
    features_summary: list[str] | None = None
    error: str | None = None              # код ошибки
    message: str | None = None            # человекочитаемое сообщение

class StatusResponse(BaseModel):
    ok: bool
    serial: str
    has_license: bool
    license_type: str | None = None
    expires_at: int | None = None
    customer: str | None = None
    activation_count: int = 0
    message: str | None = None
```

---

## Часть 4: Формат `features` в лицензии

JSON-объект, хранящийся в `licenses.features_json`. При генерации Activation Code вставляется в payload as-is.

### Допустимые типы фич

| Тип | Описание |
|-----|----------|
| `"base"` | Базовая функция, работает при любой активной лицензии |
| `"addon_perpetual"` | Куплено навсегда, не имеет expires_at |
| `"addon_timed"` | Подписка, имеет `expires_at` |
| `"trial"` | Пробный период (обрабатывается локально на устройстве, в код активации не включается) |

### Полный список фич rusNAS

```python
# Эталонный список — используется в admin.py для валидации и автодополнения
ALL_FEATURES = {
    "core":              "Базовые функции NAS",
    "guard":             "rusNAS Guard (защита от шифровальщиков)",
    "snapshots":         "Снапшоты Btrfs",
    "ssd_tier":          "SSD-уровень (dm-cache)",
    "storage_analyzer":  "Storage Analyzer",
    "dedup":             "Дедупликация (dm-vdo)",
    "updates_security":  "Критические обновления безопасности",
    "updates_features":  "Обновления функций",
    "ha_cluster":        "HA Кластер (DRBD + Pacemaker)",
    "fleet_mgmt":        "Fleet Management",
}
```

### Пример `features_json` в базе

```json
{
  "core":             {"type": "base"},
  "updates_security": {"type": "base"},
  "guard":            {"type": "addon_perpetual"},
  "snapshots":        {"type": "addon_perpetual"},
  "updates_features": {"type": "addon_timed", "expires_at": 1771536000},
  "storage_analyzer": {"type": "addon_timed", "expires_at": 1771536000}
}
```

**Правило:** `core` и `updates_security` всегда включаются автоматически при создании лицензии (если не указаны явно). Не нужно передавать их вручную в CLI.

---

## Часть 5: Payload Activation Code

JSON, который подписывается и кодируется в Activation Code:

```json
{
  "ver": 1,
  "serial": "RUSNAS-A3F7-KM9P-2BXQ-HJ4N",
  "issued_at": 1740000000,
  "license_type": "standard",
  "expires_at": 1771536000,
  "customer": "ООО Ромашка",
  "max_volumes": 8,
  "features": {
    "core":             {"type": "base"},
    "updates_security": {"type": "base"},
    "guard":            {"type": "addon_perpetual"},
    "snapshots":        {"type": "addon_perpetual"},
    "updates_features": {"type": "addon_timed", "expires_at": 1771536000}
  }
}
```

**Важно:**
- `issued_at` — момент выдачи кода активации (не создания лицензии)
- `expires_at` — берётся из лицензии (может быть `null` для бессрочных)
- `serial` — верифицируется устройством: если не совпадает с `/etc/rusnas/serial`, активация отклоняется
- Поля сериализуются с `sort_keys=True` для детерминированности

---

## Часть 6: FastAPI сервер (`server.py`)

```python
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from slowapi import Limiter
from slowapi.util import get_remote_address

app = FastAPI(title="rusNAS License Server", docs_url=None, redoc_url=None)
limiter = Limiter(key_func=get_remote_address)
```

### Эндпоинты

#### `GET /`
Возвращает `static/activate.html` как `HTMLResponse`.

#### `POST /api/activate`

**Rate limit:** 5 запросов в минуту с одного IP.

**Логика:**
1. Валидация формата серийника через Pydantic (автоматически)
2. `serial_exists()` → если нет: `error="serial_not_found"`
3. `get_active_license()` → если нет: `error="no_license"`, message: "Лицензия не найдена. Обратитесь к поставщику."
4. Если `license.expires_at` не None и `expires_at < now()`: `error="license_expired"`
5. Если `license.revoked`: `error="license_revoked"`
6. Строим payload (см. формат выше)
7. `sign_payload(private_key, payload)` → raw Base62
8. `format_activation_code(raw_base62)` → форматированный код
9. `log_activation(serial, license_id, ip, sha256(raw_base62))`
10. `audit("activate", serial, ip)`
11. Возвращаем `ActivateResponse(ok=True, activation_code=..., ...)`

**Features summary** — список человекочитаемых названий включённых addon-функций:
```python
def build_features_summary(features: dict) -> list[str]:
    result = []
    for feat_id, feat_data in features.items():
        if feat_id in ("core", "updates_security"):
            continue
        name = ALL_FEATURES.get(feat_id, feat_id)
        if feat_data["type"] == "addon_perpetual":
            result.append(f"{name} (бессрочно)")
        elif feat_data["type"] == "addon_timed":
            exp = feat_data.get("expires_at")
            if exp:
                date_str = datetime.fromtimestamp(exp).strftime("%d.%m.%Y")
                result.append(f"{name} (до {date_str})")
    return result
```

#### `GET /api/status/{serial}`

Публичный эндпоинт для поддержки. Возвращает:
```json
{
  "ok": true,
  "serial": "RUSNAS-A3F7-KM9P-2BXQ-HJ4N",
  "has_license": true,
  "license_type": "standard",
  "expires_at": 1771536000,
  "customer": "ООО Ромашка",
  "activation_count": 3
}
```

Не возвращает features_json и другие детали лицензии.

#### Обработка ошибок

Все HTTP-ошибки возвращают JSON:
```json
{"ok": false, "error": "rate_limit_exceeded", "message": "Слишком много запросов. Попробуйте через минуту."}
```

HTTP статусы:
- `200` — успех и бизнес-ошибки (serial_not_found, no_license и т.д.) — всегда 200, ошибка в теле
- `422` — ошибка валидации Pydantic
- `429` — rate limit
- `500` — внутренняя ошибка

---

## Часть 7: Страница активации (`static/activate.html`)

Одностраничный HTML, встроенный CSS (никаких CDN, полностью автономный). На русском языке.

### Внешний вид

```
┌──────────────────────────────────────────────────┐
│  [Логотип rusNAS]  Активация лицензии            │
│                                                   │
│  Введите серийный номер устройства:               │
│  ┌────────────────────────────────────────────┐  │
│  │ RUSNAS- ____ - ____ - ____ - ____          │  │
│  └────────────────────────────────────────────┘  │
│                                                   │
│  [  Получить код активации  ]                     │
│                                                   │
│  ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──    │
│                                                   │
│  ✅ Лицензия найдена                             │
│  Клиент: ООО Ромашка                             │
│  Тип: Standard • Действует до: 01.03.2027        │
│  Включено: rusNAS Guard, Снапшоты, Обновления    │
│                                                   │
│  Ваш код активации:                               │
│  ┌────────────────────────────────────────────┐  │
│  │ RNAC-                                      │  │
│  │ Ak3fP 2XqmB 9zK4L wN7Pq Hj2Xm Bv5K        │  │
│  │ q9mKz PQwR3 nF7xT 4LpNm ...               │  │
│  │                                            │  │
│  │                     [📋 Скопировать код]   │  │
│  └────────────────────────────────────────────┘  │
│                                                   │
│  ⚠ Скопируйте весь код целиком.                  │
│  Затем откройте rusNAS → Настройки → Лицензия    │
│  и вставьте код в поле активации.                 │
└──────────────────────────────────────────────────┘
```

### Требования к странице

- Поле ввода: маска `RUSNAS-____-____-____-____`, автоматически вставляет дефисы при наборе
- При вводе — uppercase автоматически
- Кнопка "Скопировать" использует `navigator.clipboard.writeText()`, при успехе меняет текст на "✅ Скопировано!"
- Код активации отображается в `<textarea readonly>` с моноширинным шрифтом
- Адаптивный (мобильные браузеры)
- Цветовая схема rusNAS: тёмно-синий (#1a2332) фон header, белый контент, акцент #0099ff
- Никаких JS-фреймворков, только ванильный JS

---

## Часть 8: CLI (`admin.py`)

Утилита командной строки для оператора. Работает напрямую с SQLite (не через HTTP).

### Команды

```bash
# ── Серийные номера ──────────────────────────────────────────

# Добавить серийник в базу (без создания лицензии)
python3 admin.py serial add RUSNAS-A3F7-KM9P-2BXQ-HJ4N [--batch batch-2026-03] [--note "описание"]

# Массовое добавление из файла (один серийник на строку)
python3 admin.py serial import serials.txt [--batch batch-2026-03]

# Показать статус серийника
python3 admin.py serial show RUSNAS-A3F7-KM9P-2BXQ-HJ4N

# Список всех серийников
python3 admin.py serial list [--batch batch-2026-03]


# ── Лицензии ─────────────────────────────────────────────────

# Создать лицензию
python3 admin.py license create \
    --serial RUSNAS-A3F7-KM9P-2BXQ-HJ4N \
    --type standard \
    --expires 2027-03-01 \
    --customer "ООО Ромашка" \
    --features guard,snapshots,updates_features \
    --max-volumes 8 \
    [--operator "Иван Петров"]

# Типы лицензий (--type):
#   standard    — стандартная, требует --expires
#   enterprise  — корпоративная, может быть бессрочной (--no-expiry)
#   perpetual   — бессрочная без ограничений
#   oem         — OEM, привязана к серийнику железа (флаг для документации)

# Создать бессрочную лицензию
python3 admin.py license create \
    --serial RUSNAS-XXXX-XXXX-XXXX-XXXX \
    --type perpetual \
    --no-expiry \
    --customer "Крупный клиент ООО" \
    --features all

# Показать лицензию
python3 admin.py license show RUSNAS-A3F7-KM9P-2BXQ-HJ4N

# Продлить лицензию
python3 admin.py license extend RUSNAS-A3F7-KM9P-2BXQ-HJ4N --expires 2028-03-01

# Добавить фичу к существующей лицензии
python3 admin.py license add-feature RUSNAS-A3F7-KM9P-2BXQ-HJ4N \
    --feature ssd_tier \
    --expires 2027-03-01

# Отозвать лицензию
python3 admin.py license revoke RUSNAS-A3F7-KM9P-2BXQ-HJ4N --reason "chargeback"

# Список лицензий
python3 admin.py license list [--active] [--expired] [--revoked]


# ── Активации ────────────────────────────────────────────────

# История активаций для серийника
python3 admin.py activations RUSNAS-A3F7-KM9P-2BXQ-HJ4N

# Сгенерировать код активации вручную (без HTTP запроса — для оффлайн выдачи)
python3 admin.py gen-code RUSNAS-A3F7-KM9P-2BXQ-HJ4N


# ── Ключи ────────────────────────────────────────────────────

# Сгенерировать новую ключевую пару оператора
python3 admin.py keygen [--out-dir ./]
# Создаёт operator_private.pem и operator_public.pem

# Показать публичный ключ (для вшивания в образ)
python3 admin.py pubkey [--key-path ./operator_private.pem]


# ── Отчёты ───────────────────────────────────────────────────

# Общий отчёт
python3 admin.py report

# Экспорт публичного ключа в формате для вшивания в Ansible
python3 admin.py export-pubkey [--format ansible]
```

### Вывод `admin.py license show`

```
Serial:       RUSNAS-A3F7-KM9P-2BXQ-HJ4N
Customer:     ООО Ромашка
License type: standard
Created:      01.03.2026 14:32 (by Иван Петров)
Expires:      01.03.2027 (через 345 дней)
Max volumes:  8
Status:       ACTIVE

Features:
  core                      [base]
  updates_security          [base]
  guard                     [addon_perpetual]  бессрочно
  snapshots                 [addon_perpetual]  бессрочно
  updates_features          [addon_timed]      до 01.03.2027

Activations: 2
  2026-03-05 10:12  IP: 91.192.x.x
  2026-03-15 09:44  IP: 91.192.x.x
```

### Вывод `admin.py report`

```
rusNAS License Server Report
Generated: 21.03.2026 12:00

Serials:
  Total issued:    1247
  With license:    1198
  Without license: 49

Licenses:
  Active:          1156
  Expired:         38
  Revoked:         4

Expiring soon (30 days): 12
  RUSNAS-XXXX-... ООО Альфа       expires 15.04.2026
  ...

Feature distribution:
  guard             982 licenses
  snapshots         1102 licenses
  updates_features  876 licenses
  ssd_tier          234 licenses
  dedup             89 licenses
```

---

## Часть 9: `keygen.py`

```python
#!/usr/bin/env python3
"""
Генерация ключевой пары оператора rusNAS.
Запускается один раз при развёртывании сервера.
"""

def main():
    # Генерирует operator_private.pem и operator_public.pem в текущей директории
    # Выводит предупреждение: "Храните operator_private.pem в безопасном месте!"
    # Выводит публичный ключ в base64 для вшивания в образ
    # chmod 600 для private key
```

---

## Часть 10: Systemd unit (`rusnas-license.service`)

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
# Защита
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/rusnas-license-server

[Install]
WantedBy=multi-user.target
```

---

## Часть 11: `README.md`

Инструкция по развёртыванию на VPS:

```markdown
# rusNAS License Server

## Установка на VPS (Debian/Ubuntu)

### 1. Создать пользователя и директорию
sudo useradd -r -s /bin/false rusnas-license
sudo mkdir -p /opt/rusnas-license-server
sudo chown rusnas-license: /opt/rusnas-license-server

### 2. Установить зависимости
sudo apt install python3 python3-venv python3-pip
cd /opt/rusnas-license-server
python3 -m venv venv
venv/bin/pip install -r requirements.txt

### 3. Сгенерировать ключевую пару
python3 admin.py keygen
# ВАЖНО: operator_private.pem — храните в тайне, делайте резервные копии!
# operator_public.pem — вшивается в образ rusNAS при сборке

### 4. Настроить окружение
cp .env.example .env
nano .env   # указать пути к ключу и базе

### 5. Инициализировать базу
python3 admin.py serial add RUSNAS-TEST-0000-0000-0001 --note "test"

### 6. Запустить сервис
sudo cp rusnas-license.service /etc/systemd/system/
sudo systemctl enable --now rusnas-license

### 7. Настроить nginx reverse proxy (рекомендуется)
# Пример конфига nginx:
# server {
#     listen 443 ssl;
#     server_name activate.rusnas.ru;
#     location / {
#         proxy_pass http://127.0.0.1:8765;
#     }
# }

## Вшивание публичного ключа в образ rusNAS

python3 admin.py pubkey
# Скопируйте содержимое operator_public.pem в:
# ansible/roles/base/files/operator_public.pem
# Ansible разложит его на устройства как /etc/rusnas/operator_public.pem

## Резервное копирование

Обязательно делайте backup:
- operator_private.pem  — потеря = невозможность выдавать новые коды
- rusnas_licenses.db    — потеря = потеря всей базы лицензий
```

---

## Тест-матрица

| Сценарий | Ожидаемый результат |
|---------|---------------------|
| `POST /api/activate` с валидным серийником | `ok=true`, код активации |
| `POST /api/activate` с несуществующим серийником | `ok=false`, `error=serial_not_found` |
| `POST /api/activate` с серийником без лицензии | `ok=false`, `error=no_license` |
| `POST /api/activate` с отозванной лицензией | `ok=false`, `error=license_revoked` |
| `POST /api/activate` с истёкшей лицензией | `ok=false`, `error=license_expired` |
| `POST /api/activate` 6 раз с одного IP за минуту | 429 rate limit на 6-й |
| Код активации можно верифицировать через `verify_and_decode` | Payload соответствует лицензии |
| Код для одного серийника, проверка с другим серийником в payload | Поле `serial` в payload не совпадает |
| `admin.py license create` + `admin.py gen-code` | Код генерируется без HTTP |
| `admin.py license revoke` + `POST /api/activate` | `error=license_revoked` |
| `admin.py report` | Корректная статистика |
| Ручное изменение `rusnas_licenses.db` (simulate tamper) | Не влияет на уже выданные коды (они самодостаточны) |

---

## Важные замечания для реализации

1. **Приватный ключ загружается один раз при старте** FastAPI-приложения, хранится в памяти как атрибут `app.state.private_key`. Не перечитывается на каждый запрос.

2. **База данных** — один SQLite файл. Для VPS с 1000+ устройствами это достаточно (активаций будет немного — клиент активирует устройство редко). Не нужен PostgreSQL.

3. **`activate.html` — полностью встроенный**, никаких внешних запросов (шрифты, CDN). Страница должна работать если у клиента нет доступа к CDN.

4. **Activation Code содержит серийник** устройства в payload. Устройство при активации сравнивает `payload.serial` со своим `/etc/rusnas/serial`. Это реализуется в daemon (отдельное ТЗ), но сервер должен корректно записывать серийник в payload.

5. **Лицензию можно переактивировать** — если клиент потерял код, он может зайти на сайт и получить новый. Каждый вызов `/api/activate` генерирует новый код с актуальным `issued_at`. Это логируется в `activations`.

6. **`features_json` в базе** — только addon-функции, которые оператор явно купил. `core` и `updates_security` добавляются автоматически при построении payload в `server.py`, их не нужно хранить в каждой записи лицензии.

---

## Часть 12: Cockpit License Page (`license.html` + `js/license.js`)

Страница активации в Cockpit плагине — 13-я страница (`"license"` в `manifest.json`, order: 13).

### Архитектура (offline-first)

Устройство **никогда не обращается к license server напрямую**. Весь процесс:
1. Пользователь открывает `https://activate.rusnas.ru/` в браузере, вводит серийник
2. Сервер генерирует RNAC-код (подписанный Ed25519)
3. Пользователь копирует код, вставляет в Cockpit → Лицензия
4. JavaScript в license.js верифицирует подпись через **WebCrypto API** (browser-side)
5. При успехе — записывает `license.json` и apt credentials через Cockpit file API

### Ключевые функции `license.js`

```javascript
// Константы
const OPERATOR_PUBLIC_KEY_B64 = "1d6UQHGzNP3wZPQVFpXUkc5qF+5UAyQlrUMSQAffdA0="; // raw Ed25519 32 bytes
const APT_HOST = "activate.rusnas.ru/apt/";

// Декодирование Base62 (BigInt arithmetic, leading-zeros preserving)
function base62Decode(s) { ... }

// Нормализация: убрать "RNAC-", пробелы, переносы строк
function normalizeActivationCode(input) { ... }

// WebCrypto Ed25519 verify: importKey("raw",...) → subtle.verify("Ed25519",...)
async function verifyAndDecode(rawBase62) { ... }

// Cockpit file read/write (wrapped in Promise from cockpit.file().done().fail())
function readFile(path) { ... }
function writeFile(path, content, superuser) { ... }  // superuser=true → {superuser:"require"}

// Загрузка статуса из /etc/rusnas/license.json
async function loadLicenseStatus() { ... }

// Активация: verify → check serial → write /etc/rusnas/license.json → write apt conf
async function activateLicense() { ... }
```

### Что записывается при активации

| Файл | Содержимое | Права |
|------|-----------|-------|
| `/etc/rusnas/license.json` | Payload из RNAC-кода (JSON) | superuser write |
| `/etc/apt/auth.conf.d/rusnas.conf` | `machine ... login ... password <rawBase62>` | superuser write |

**Apt credentials:** `login = serial`, `password = rawBase62` (сам код активации служит apt-токеном).

### Critical notes для `license.js`

- **WebCrypto Ed25519:** `crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"])` — работает в современных браузерах (Chrome 113+, Firefox 119+)
- **Подпись:** первые 64 байта blob = signature, остальные = payload JSON bytes
- **Серийник:** `payload.serial` в коде должен точно совпадать с `/etc/rusnas/serial` — иначе ошибка
- **`form-control` класс:** НЕ использовать на `<textarea>` — PatternFly CSS переопределяет dark mode. Достаточно `.form-group textarea` из style.css
- **`cockpit.file().read()`** — не требует superuser для чтения `/etc/rusnas/serial` и `license.json` (если файлы 644)
- **`cockpit.file(..., {superuser:"require"}).replace()`** — для записи в `/etc/rusnas/` и `/etc/apt/auth.conf.d/`
