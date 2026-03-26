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
