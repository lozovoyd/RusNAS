#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  rusNAS Demo Installer                                       ║
# ║  Usage: sudo bash demo-install.sh                            ║
# ║  Installs rusNAS on a clean Debian 13 (Trixie) system.      ║
# ║  No license server or internet required for the .deb.       ║
# ╚══════════════════════════════════════════════════════════════╝
set -euo pipefail

# Ensure sbin paths are available (needed when called via su -c)
export PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH"

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}  →${NC} $*"; }
ok()    { echo -e "${GREEN}  ✓${NC} $*"; }
warn()  { echo -e "${YELLOW}  ⚠${NC} $*"; }
fail()  { echo -e "${RED}  ✗ $*${NC}"; exit 1; }

echo ""
echo -e "${BOLD}"
cat << 'BANNER'
    ╔══════════════════════════════════════════════════════════════╗
    ║                                                              ║
    ║    ██████╗ ██╗   ██╗███████╗███╗   ██╗ █████╗ ███████╗      ║
    ║    ██╔══██╗██║   ██║██╔════╝████╗  ██║██╔══██╗██╔════╝      ║
    ║    ██████╔╝██║   ██║███████╗██╔██╗ ██║███████║███████╗      ║
    ║    ██╔══██╗██║   ██║╚════██║██║╚██╗██║██╔══██║╚════██║      ║
    ║    ██║  ██║╚██████╔╝███████║██║ ╚████║██║  ██║███████║      ║
    ║    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝      ║
    ║                                                              ║
    ║              Enterprise NAS Platform                         ║
    ║              Demo Installer v1.0                             ║
    ║                                                              ║
    ╚══════════════════════════════════════════════════════════════╝
BANNER
echo -e "${NC}"

# ── 1. PREFLIGHT ─────────────────────────────────────────────────────────────
echo -e "${BOLD}[1/8] Preflight checks${NC}"

# Root
[ "$(id -u)" -eq 0 ] || fail "Must run as root (use: sudo bash demo-install.sh)"
ok "Running as root"

# Debian 13
if command -v lsb_release &>/dev/null; then
    CODENAME=$(lsb_release -cs 2>/dev/null || echo "unknown")
else
    CODENAME=$(grep VERSION_CODENAME /etc/os-release 2>/dev/null | cut -d= -f2 || echo "unknown")
fi
[ "$CODENAME" = "trixie" ] || fail "rusNAS requires Debian 13 (trixie). Detected: ${CODENAME}"
ok "Debian 13 (trixie)"

# Find .deb in current directory
DEB=$(ls -1 rusnas-system_*.deb 2>/dev/null | head -1)
[ -n "$DEB" ] || fail "No rusnas-system_*.deb found in current directory. Place the .deb file next to this script."
ok "Package found: ${DEB}"

# ── Network detection ────────────────────────────────────────────────────────
echo ""
info "Network configuration:"
IP=$(ip -4 route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1); exit}')
[ -z "$IP" ] && IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$IP" ] && IP="unknown"

IFACE=$(ip -4 route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="dev") print $(i+1); exit}')
[ -z "$IFACE" ] && IFACE="unknown"

GW=$(ip -4 route get 1 2>/dev/null | awk '{print $3; exit}')
[ -z "$GW" ] && GW="unknown"

if [ -f /etc/network/interfaces ]; then
    if grep -q "iface.*dhcp" /etc/network/interfaces 2>/dev/null; then
        NET_MODE="DHCP"
    else
        NET_MODE="Static"
    fi
else
    NET_MODE="NetworkManager"
fi

echo -e "    Interface: ${BOLD}${IFACE}${NC}"
echo -e "    IP:        ${BOLD}${IP}${NC} (${NET_MODE})"
echo -e "    Gateway:   ${BOLD}${GW}${NC}"

# ── Port checks ──────────────────────────────────────────────────────────────
echo ""
info "Port availability:"
PORT_WARN=0
check_port() {
    local port=$1 name=$2
    local proc=$(ss -tlnp 2>/dev/null | grep ":${port} " | awk '{print $NF}' | sed 's/.*"\(.*\)".*/\1/' | head -1)
    if [ -n "$proc" ]; then
        warn "Port ${port} (${name}) occupied by: ${proc}"
        PORT_WARN=1
    else
        ok "Port ${port} (${name}) is free"
    fi
}
check_port 80   "HTTP / Landing page"
check_port 9090 "Cockpit Web UI"
check_port 8091 "Apache WebDAV"

# ── Existing installation check ──────────────────────────────────────────────
if dpkg -l cockpit 2>/dev/null | grep -q '^ii'; then
    warn "Cockpit is already installed — will be reconfigured"
fi
if dpkg -l rusnas-system 2>/dev/null | grep -q '^ii'; then
    warn "rusnas-system is already installed — will be upgraded"
fi

# ── Confirmation ─────────────────────────────────────────────────────────────
echo ""
if [ "$PORT_WARN" -eq 1 ]; then
    warn "Some ports are occupied. Services on those ports will be reconfigured."
fi
echo -e "${BOLD}  rusNAS will be installed to this system.${NC}"
echo ""
read -p "  Continue with installation? [Y/n] " REPLY
REPLY=${REPLY:-Y}
case "$REPLY" in
    [yYдД]*) ok "Starting installation..." ;;
    *) echo "  Installation cancelled."; exit 0 ;;
esac

# ── 2. SYSTEM DEPENDENCIES ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[2/8] Installing system dependencies${NC}"
info "This may take several minutes on a fresh system..."

export DEBIAN_FRONTEND=noninteractive

apt-get update -qq 2>/dev/null

# Core dependencies
info "Installing core packages..."
apt-get install -y -qq \
    sudo \
    cockpit cockpit-storaged \
    python3 python3-bcrypt python3-croniter \
    samba nfs-kernel-server \
    mdadm btrfs-progs smartmontools \
    targetcli-fb hdparm \
    nginx vsftpd apache2 \
    lvm2 thin-provisioning-tools \
    traceroute dnsutils netcat-openbsd certbot \
    nmap smbclient \
    2>/dev/null || warn "Some packages failed (non-critical)"
ok "Core packages installed"

# UPS support
info "Installing UPS support..."
apt-get install -y -qq nut 2>/dev/null && ok "NUT (UPS) installed" || warn "NUT not available"

# Container support
info "Installing container support..."
apt-get install -y -qq \
    podman podman-compose slirp4netns fuse-overlayfs crun uidmap \
    2>/dev/null && ok "Podman installed" || warn "Podman not available — container manager limited"

# Domain support (optional)
apt-get install -y -qq \
    realmd adcli winbind libnss-winbind libpam-winbind krb5-user samba-common-bin \
    2>/dev/null || true

# ── 3. INSTALL .DEB PACKAGE ─────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[3/8] Installing rusNAS package${NC}"

dpkg --force-overwrite -i "${DEB}" 2>/dev/null || true
apt-get install -f -y -qq 2>/dev/null  # fix any missing deps
ok "rusnas-system package installed"

# ── 4. USER & PERMISSIONS ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[4/8] Configuring user & permissions${NC}"

RUSNAS_PASS="rusnas"
if ! id rusnas &>/dev/null; then
    useradd -m -s /bin/bash -G sudo rusnas
    echo "rusnas:${RUSNAS_PASS}" | chpasswd
    ok "User 'rusnas' created (password: ${RUSNAS_PASS})"
else
    usermod -aG sudo rusnas 2>/dev/null || true
    ok "User 'rusnas' already exists (added to sudo group)"
fi

# Ensure /var/lib/rusnas is traversable
chmod o+x /var/lib/rusnas 2>/dev/null || true

# ── 5. DEMO LICENSE ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[5/8] Setting up demo license${NC}"

mkdir -p /etc/rusnas
echo "RUSNAS-DEMO-INTE-RNAL-ONLY" > /etc/rusnas/serial

cat > /etc/rusnas/license.json << 'LICEOF'
{
  "ver": 1,
  "type": "demo",
  "serial": "RUSNAS-DEMO-INTE-RNAL-ONLY",
  "license_type": "enterprise",
  "customer": "Internal Demo",
  "expires_at": null,
  "features": {
    "core": true,
    "guard": true,
    "snapshots": true,
    "ssd_tier": true,
    "storage_analyzer": true,
    "dedup": true,
    "updates_security": true,
    "updates_features": true,
    "ha_cluster": true,
    "fleet_mgmt": true
  },
  "max_volumes": 16
}
LICEOF

ok "Demo license: Enterprise (all features, no expiry)"

# ── 6. SERVICES CONFIGURATION ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}[6/8] Configuring services${NC}"

# Cockpit
mkdir -p /etc/cockpit
cat > /etc/cockpit/cockpit.conf << 'CCEOF'
[WebService]
AllowUnencrypted = true
LoginTitle = rusNAS
MaxStartups = 10

[Session]
IdleTimeout = 60
CCEOF
ok "Cockpit configured"

# Move Apache to port 8091 (WebDAV only)
if [ -f /etc/apache2/ports.conf ]; then
    sed -i 's/Listen 80$/Listen 8091/' /etc/apache2/ports.conf 2>/dev/null || true
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8091>/' /etc/apache2/sites-available/000-default.conf 2>/dev/null || true
    systemctl restart apache2 2>/dev/null || true
    ok "Apache moved to port 8091 (WebDAV)"
fi

# Nginx as primary web server
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

cat > /etc/nginx/sites-available/rusnas.conf << 'NGEOF'
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 0;

    # Landing page
    root /var/www/rusnas-landing;
    index index.html;

    # Cockpit reverse proxy
    location /cockpit/ {
        proxy_pass https://127.0.0.1:9090/cockpit/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
    }

    # User documentation
    location /help/ {
        alias /usr/share/rusnas-help/;
        index index.html;
    }

    # Container apps includes
    include /etc/nginx/conf.d/rusnas-apps/*.conf;

    # Fallback to landing
    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGEOF

ln -sf /etc/nginx/sites-available/rusnas.conf /etc/nginx/sites-enabled/rusnas.conf
nginx -t 2>/dev/null && ok "nginx configured" || warn "nginx config test failed"

# ── 7. DOCUMENTATION ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[7/8] Documentation${NC}"

if [ -d /usr/share/rusnas-help ] && [ -f /usr/share/rusnas-help/index.html ]; then
    ok "User documentation available at http://${IP}/help/"
else
    warn "User documentation not included in this build"
fi

# ── 8. START SERVICES ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[8/8] Starting services${NC}"

systemctl daemon-reload

# Core services
systemctl enable --now cockpit.socket 2>/dev/null && ok "Cockpit" || warn "Cockpit failed"
systemctl enable --now nginx 2>/dev/null && ok "nginx" || warn "nginx failed"
systemctl enable --now rusnas-guard 2>/dev/null && ok "Guard daemon" || warn "Guard daemon failed"
systemctl enable --now rusnas-metrics 2>/dev/null && ok "Metrics server" || warn "Metrics failed"
systemctl enable --now rusnas-perf-collector 2>/dev/null && ok "Perf collector" || warn "Perf collector failed"

# Timers
systemctl enable rusnas-snapd.timer 2>/dev/null && ok "Snapshot timer" || true
systemctl enable rusnas-storage-collector.timer 2>/dev/null && ok "Storage collector" || true
systemctl enable rusnas-sectest.timer 2>/dev/null && ok "Security test timer" || true
systemctl enable rusnas-certcheck.timer 2>/dev/null || true
systemctl enable rusnas-worm.timer 2>/dev/null || true

# ── DONE ─────────────────────────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}${BOLD}"
cat << DONE
    ╔══════════════════════════════════════════════════════════════╗
    ║                                                              ║
    ║   rusNAS Demo установлен успешно!                            ║
    ║                                                              ║
    ╠══════════════════════════════════════════════════════════════╣
    ║                                                              ║
    ║   Web UI (Cockpit):  https://${IP}:9090                ║
    ║   Landing page:      http://${IP}                           ║
    ║   Documentation:     http://${IP}/help/                     ║
    ║                                                              ║
    ║   Логин:    rusnas                                           ║
    ║   Пароль:   rusnas                                           ║
    ║                                                              ║
    ║   Лицензия: Demo Enterprise (все функции активны)            ║
    ║   Serial:   RUSNAS-DEMO-INTE-RNAL-ONLY                      ║
    ║                                                              ║
    ╠══════════════════════════════════════════════════════════════╣
    ║                                                              ║
    ║   Первые шаги:                                               ║
    ║   1. Откройте https://${IP}:9090 в браузере            ║
    ║   2. Войдите как rusnas / rusnas                             ║
    ║   3. Включите 'Administrative access' (замок вверху)         ║
    ║   4. Перейдите в 'Диски и RAID' для настройки массивов       ║
    ║                                                              ║
    ╚══════════════════════════════════════════════════════════════╝
DONE
echo -e "${NC}"
