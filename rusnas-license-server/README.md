# rusNAS License Server

FastAPI-based license server for rusNAS commercial distribution.

## Architecture

- **Port 8765** — License server: `/api/activate`, `/api/status/{serial}`, `/api/install-token`, `/admin/*`
- **Port 8766** — apt-auth: nginx `auth_request` handler with 180-day grace period
- **SQLite** — `rusnas_licenses.db` (WAL mode via aiosqlite)
- **Ed25519** — offline activation codes signed by `operator_private.pem`

## Initial Setup (VPS)

```bash
# 1. Create user and directory
useradd -r -s /bin/false -d /opt/rusnas-license-server rusnas-license
mkdir -p /opt/rusnas-license-server
cp -r . /opt/rusnas-license-server/
chown -R rusnas-license:rusnas-license /opt/rusnas-license-server

# 2. Python environment
cd /opt/rusnas-license-server
python3 -m venv venv
venv/bin/pip install -r requirements.txt

# 3. Generate keypair (once — keep private key safe!)
venv/bin/python3 keygen.py

# 4. Configure
cp .env.example .env
# Edit .env: set ADMIN_TOKEN to a random string

# 5. Install and start services
cp rusnas-license.service /etc/systemd/system/
cp rusnas-apt-auth.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rusnas-license rusnas-apt-auth
```

## Admin CLI

```bash
cd /opt/rusnas-license-server

# Register serial numbers
venv/bin/python3 admin.py serial add RUSNAS-XXXX-XXXX-XXXX-XXXX --note "Customer name"

# Create license
venv/bin/python3 admin.py license create \
  --serial RUSNAS-XXXX-XXXX-XXXX-XXXX \
  --type standard \
  --customer "Company Name" \
  --features guard,snapshots,updates_features \
  --no-expiry

# Generate activation code (customer pastes this into Cockpit)
venv/bin/python3 admin.py gen-code RUSNAS-XXXX-XXXX-XXXX-XXXX

# Summary report
venv/bin/python3 admin.py report
```

## Admin Web UI

Available at `https://activate.rusnas.ru/admin/` with `Authorization: Bearer <ADMIN_TOKEN>`.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check (unauthenticated) |
| `POST /api/activate` | Get signed RNAC activation code |
| `GET /api/status/{serial}` | Check license status |
| `GET /api/install-token?serial=...` | Bootstrap installer token |
| `GET /apt-check` (port 8766) | nginx auth_request handler |

## Tests

```bash
venv/bin/pytest tests/ -v
```
