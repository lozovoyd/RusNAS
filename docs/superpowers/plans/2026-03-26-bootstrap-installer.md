# Bootstrap Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a single-command bootstrap installer that turns a clean Debian 13 machine into a rusNAS device — writes the serial, fetches an install-token from the license server, configures the apt repo, and installs the `rusnas-system` package.

**Architecture:** Single bash script served at `https://activate.rusnas.ru/install`. Idempotent. Validates serial format before contacting the server. Skips apt token update if device is already activated (license.json present).

**Tech Stack:** bash, curl, jq, dpkg, apt, systemd

**Spec:** `docs/superpowers/specs/2026-03-26-distribution-licensing-design.md` §7

**Dependency:** License server must be deployed and `/api/install-token` endpoint live before testing Step 4+.

---

## File Map

```
RusNAS/
└── bootstrap.sh      The installer script (scp'd to VPS at /var/www/rusnas-install/bootstrap.sh)
```

---

## Task 1: Write bootstrap.sh

**Files:**
- Create: `bootstrap.sh`

- [ ] **Step 1: Write the script**

`bootstrap.sh`:
```bash
#!/usr/bin/env bash
# rusNAS Bootstrap Installer
# Usage: curl -fsSL https://activate.rusnas.ru/install | bash -s -- RUSNAS-XXXX-XXXX-XXXX-XXXX
set -euo pipefail

SERIAL="${1:-}"
ACTIVATE_HOST="https://activate.rusnas.ru"
RUSNAS_GPG_URL="${ACTIVATE_HOST}/apt/rusnas.gpg"
RUSNAS_APT_URL="${ACTIVATE_HOST}/apt/"
SERIAL_PATH="/etc/rusnas/serial"
LICENSE_PATH="/etc/rusnas/license.json"
AUTH_CONF="/etc/apt/auth.conf.d/rusnas.conf"
SOURCES_LIST="/etc/apt/sources.list.d/rusnas.list"
GPG_KEYRING="/etc/apt/keyrings/rusnas.gpg"
SERIAL_RE='^RUSNAS-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}(-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}){3}$'

# ── helpers ───────────────────────────────────────────────────────────────────
red()   { echo -e "\033[31m$*\033[0m"; }
green() { echo -e "\033[32m$*\033[0m"; }
info()  { echo "  → $*"; }

# ── 1. PREFLIGHT ──────────────────────────────────────────────────────────────
echo ""
echo "rusNAS Bootstrap Installer"
echo "=========================="

# Root check
if [ "$(id -u)" -ne 0 ]; then
    red "Error: must run as root (use sudo)"
    exit 1
fi

# Debian 13 check
if ! command -v lsb_release &>/dev/null || [ "$(lsb_release -cs 2>/dev/null)" != "trixie" ]; then
    red "Error: rusNAS requires Debian 13 (trixie). Detected: $(lsb_release -cs 2>/dev/null || echo unknown)"
    exit 1
fi

# Serial argument
if [ -z "$SERIAL" ]; then
    red "Error: serial number required"
    echo "Usage: curl -fsSL ${ACTIVATE_HOST}/install | bash -s -- RUSNAS-XXXX-XXXX-XXXX-XXXX"
    exit 1
fi

SERIAL="${SERIAL^^}"  # uppercase
if ! echo "$SERIAL" | grep -qP "$SERIAL_RE"; then
    red "Error: invalid serial format. Expected: RUSNAS-XXXX-XXXX-XXXX-XXXX"
    exit 1
fi

# Internet check
info "Checking connectivity..."
if ! curl -sf --max-time 10 "${ACTIVATE_HOST}/health" >/dev/null; then
    red "Error: cannot reach ${ACTIVATE_HOST}. Check internet connection."
    exit 1
fi

# jq dependency
if ! command -v jq &>/dev/null; then
    info "Installing jq..."
    apt-get install -y -qq jq
fi

green "✓ Preflight passed"

# ── 2. SERIAL ─────────────────────────────────────────────────────────────────
info "Writing serial number..."
mkdir -p /etc/rusnas
echo "$SERIAL" > "$SERIAL_PATH"
green "✓ Serial: ${SERIAL}"

# ── 3. INSTALL TOKEN ──────────────────────────────────────────────────────────
if [ -f "$LICENSE_PATH" ]; then
    info "License already active — skipping install token (keeping existing apt credentials)"
    green "✓ Existing license preserved"
else
    info "Fetching install token from license server..."
    RESP=$(curl -sf --max-time 15 "${ACTIVATE_HOST}/api/install-token?serial=${SERIAL}" || true)
    if [ -z "$RESP" ]; then
        red "Error: no response from license server"
        exit 1
    fi

    OK=$(echo "$RESP" | jq -r '.ok')
    if [ "$OK" != "true" ]; then
        ERR=$(echo "$RESP" | jq -r '.error // "unknown"')
        red "Error: license server rejected serial (${ERR})"
        echo "Make sure the serial is registered with your rusNAS vendor."
        exit 1
    fi

    TOKEN=$(echo "$RESP" | jq -r '.token')
    mkdir -p /etc/apt/auth.conf.d
    chmod 700 /etc/apt/auth.conf.d
    cat > "$AUTH_CONF" <<EOF
machine ${ACTIVATE_HOST#https://}/apt/
login ${SERIAL}
password ${TOKEN}
EOF
    chmod 600 "$AUTH_CONF"
    green "✓ Install token obtained and saved"
fi

# ── 4. APT REPO ───────────────────────────────────────────────────────────────
info "Configuring apt repository..."
mkdir -p /etc/apt/keyrings
curl -fsSL --max-time 15 "${RUSNAS_GPG_URL}" -o "$GPG_KEYRING"
chmod 644 "$GPG_KEYRING"

cat > "$SOURCES_LIST" <<EOF
deb [signed-by=${GPG_KEYRING}] ${RUSNAS_APT_URL} trixie main security
EOF

info "Running apt update..."
apt-get update -qq
green "✓ apt repository configured"

# ── 5. INSTALL ────────────────────────────────────────────────────────────────
info "Installing rusnas-system..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rusnas-system
green "✓ rusnas-system installed"

# ── 6. DONE ───────────────────────────────────────────────────────────────────
# Get the machine's primary IP
IP=$(hostname -I | awk '{print $1}')
echo ""
green "╔══════════════════════════════════════════════════════╗"
green "║  rusNAS успешно установлен!                          ║"
green "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Откройте Cockpit: https://${IP}:9090"
echo "  Войдите как: rusnas"
echo ""
echo "  Активируйте лицензию:"
echo "  1. Перейдите на ${ACTIVATE_HOST}/"
echo "  2. Введите серийный номер: ${SERIAL}"
echo "  3. Скопируйте RNAC-код"
echo "  4. В Cockpit: Настройки → Лицензия → Вставьте код"
echo ""
```

```bash
chmod +x bootstrap.sh
```

- [ ] **Step 2: Syntax check**

```bash
bash -n bootstrap.sh
```
Expected: no output (no syntax errors)

- [ ] **Step 3: Unit test individual validation functions**

Extract and test the regex validation:
```bash
# Test serial validation (simulate the grep check)
SERIAL_RE='^RUSNAS-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}(-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}){3}$'

# Should accept valid serials
echo "RUSNAS-BCDF-GHJK-LMNP-QRST" | grep -qP "$SERIAL_RE" && echo "OK valid"
echo "RUSNAS-2345-6789-BCDF-GHJK" | grep -qP "$SERIAL_RE" && echo "OK valid"

# Should reject invalid serials
echo "RUSNAS-AAAA-BBBB-CCCC-DDDD" | grep -qP "$SERIAL_RE" || echo "OK rejected (vowels)"
echo "RUSNAS-1234-5678-9012-3456" | grep -qP "$SERIAL_RE" || echo "OK rejected (0,1)"
echo "ABCD-EFGH-IJKL-MNOP-QRST"  | grep -qP "$SERIAL_RE" || echo "OK rejected (no prefix)"
echo "RUSNAS-BCDF-GHJK-LMNP"     | grep -qP "$SERIAL_RE" || echo "OK rejected (short)"
```
Expected: all 6 checks print "OK"

- [ ] **Step 4: Commit**

```bash
git add bootstrap.sh
git commit -m "feat: bootstrap.sh — one-command rusNAS installer for Debian 13"
```

---

## Task 2: VPS nginx config for /install endpoint

**Files:**
- Create: `vps-setup/nginx-rusnas.conf` (reference config for VPS)

- [ ] **Step 1: Create nginx config**

`vps-setup/nginx-rusnas.conf`:
```nginx
server {
    listen 443 ssl http2;
    server_name activate.rusnas.ru;

    ssl_certificate     /etc/letsencrypt/live/activate.rusnas.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/activate.rusnas.ru/privkey.pem;

    # Bootstrap script
    location = /install {
        alias /var/www/rusnas-install/bootstrap.sh;
        add_header Content-Type text/plain;
    }

    # GPG key for apt
    location = /apt/rusnas.gpg {
        alias /var/www/rusnas-install/rusnas.gpg;
    }

    # apt repository (reprepro)
    location /apt/ {
        auth_request /apt-auth-internal;
        error_page 401 403 = @apt_denied;
        alias /var/lib/reprepro/public/;
        autoindex off;
    }

    location = /apt-auth-internal {
        internal;
        proxy_pass http://127.0.0.1:8766;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Original-URI $request_uri;
        proxy_cache_valid 200 60s;
    }

    location @apt_denied {
        return 403 '{"ok":false,"error":"license_required"}';
        add_header Content-Type application/json;
    }

    # License server API + admin + activation page
    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name activate.rusnas.ru;
    return 301 https://$host$request_uri;
}
```

- [ ] **Step 2: Deploy bootstrap.sh to VPS**

```bash
mkdir -p vps-setup
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no rusnas@10.10.10.72 \
  "sudo mkdir -p /var/www/rusnas-install"
scp bootstrap.sh rusnas@10.10.10.72:/tmp/
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no rusnas@10.10.10.72 \
  "sudo cp /tmp/bootstrap.sh /var/www/rusnas-install/bootstrap.sh && sudo chmod 644 /var/www/rusnas-install/bootstrap.sh"
```

- [ ] **Step 3: Integration test on VM**

**Prerequisite:** Register the test serial on the VPS first (license server must be deployed):
```bash
ssh rusnas-vps "cd /opt/rusnas-license-server && python3 admin.py serial add RUSNAS-TEST-BCDF-GHJK-LMNP --note 'integration test'"
```

On the VM, simulate running bootstrap (with license server already deployed):
```bash
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no rusnas@10.10.10.72 \
  "curl -fsSL https://activate.rusnas.ru/install | sudo bash -s -- RUSNAS-TEST-BCDF-GHJK-LMNP"
```
Expected:
- Preflight passes
- Serial written to `/etc/rusnas/serial`
- Install token fetched and saved to `/etc/apt/auth.conf.d/rusnas.conf`
- apt repo configured
- `rusnas-system` installed

Verify:
```bash
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no rusnas@10.10.10.72 \
  "cat /etc/rusnas/serial && dpkg -l rusnas-system"
```

- [ ] **Step 4: Test idempotency (run again — should not overwrite license.json)**

```bash
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no rusnas@10.10.10.72 \
  "echo '{}' | sudo tee /etc/rusnas/license.json && \
   curl -fsSL https://activate.rusnas.ru/install | sudo bash -s -- RUSNAS-TEST-BCDF-GHJK-LMNP"
```
Expected: "License already active — skipping install token" message, license.json unchanged.

- [ ] **Step 5: Commit**

```bash
git add bootstrap.sh vps-setup/nginx-rusnas.conf
git commit -m "feat: bootstrap installer + VPS nginx config"
```
