#!/usr/bin/env bash
# build-deb.sh — Build rusnas-system .deb package from source
# Usage: ./build-deb.sh
# Prerequisites: terser (npm install -g terser), dpkg-deb (brew install dpkg)
set -euo pipefail

export PATH="/usr/local/bin:$PATH"

VERSION=$(cat VERSION | tr -d '\n')
PKG="$(pwd)/pkg"
SRC="$(pwd)/cockpit/rusnas"
DEB="rusnas-system_${VERSION}_amd64.deb"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  rusNAS Build System v${VERSION}              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Prerequisites ────────────────────────────────────────────────────────────
for cmd in terser python3 sed; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found. Install it first."; exit 1; }
done
# Build always happens on Linux host via BUILD_HOST (Cython + dpkg-deb)

# ── Python stripping helper ──────────────────────────────────────────────────
PYSTRIP="$(pwd)/tools/pystrip.py"
strip_py() {
    # Strip docstrings/comments from all .py files in a directory
    local dir="$1"
    if [ -f "$PYSTRIP" ]; then
        find "$dir" -name '*.py' -exec python3 "$PYSTRIP" {} {} \; 2>/dev/null
    fi
}

# ── Clean previous build ────────────────────────────────────────────────────
echo "Cleaning previous build..."
rm -rf "${PKG}/usr" "${PKG}/etc" "${PKG}/lib" "${PKG}/var"

# ── Cockpit plugin ──────────────────────────────────────────────────────────
DEST="${PKG}/usr/share/cockpit/rusnas"
mkdir -p "${DEST}/js" "${DEST}/css" "${DEST}/scripts" "${DEST}/cgi" "${DEST}/catalog"

# JS: minify our *.js → *.min.js, copy vendor *.min.js as-is
echo "Minifying JavaScript..."
JS_COUNT=0
VENDOR_COUNT=0
for f in "${SRC}"/js/*.js; do
    fname=$(basename "$f")
    if [[ "$fname" == *.min.js ]]; then
        # Already minified (vendor file) — copy as-is
        cp "$f" "${DEST}/js/"
        VENDOR_COUNT=$((VENDOR_COUNT + 1))
    else
        base=$(basename "$f" .js)
        terser "$f" --compress --mangle \
            --output "${DEST}/js/${base}.min.js" 2>/dev/null \
            || { echo "  ERROR: terser failed on ${fname}"; exit 1; }
        JS_COUNT=$((JS_COUNT + 1))
    fi
done
echo "  ✓ ${JS_COUNT} JS files minified, ${VENDOR_COUNT} vendor files copied"

# HTML: copy + rewrite our .js refs → .min.js (skip already-minified and external)
echo "Processing HTML..."
HTML_COUNT=0
for f in "${SRC}"/*.html; do
    # Only rewrite js/XXX.js → js/XXX.min.js (our plugin scripts)
    # Don't touch: cockpit.js (external), *.min.js (already minified), CDN URLs
    # Two-pass: first protect .min.js with placeholder, then rewrite, then restore
    sed -E \
        -e 's|\.min\.js"|.MINJS_PLACEHOLDER"|g' \
        -e 's|src="js/([^"]+)\.js"|src="js/\1.min.js"|g' \
        -e 's|\.MINJS_PLACEHOLDER"|.min.js"|g' \
        "$f" > "${DEST}/$(basename "$f")"
    HTML_COUNT=$((HTML_COUNT + 1))
done
echo "  ✓ ${HTML_COUNT} HTML files processed"

# CSS: copy as-is
cp "${SRC}"/css/*.css "${DEST}/css/"
echo "  ✓ $(ls "${DEST}/css/"*.css | wc -l | tr -d ' ') CSS files copied"

# manifest.json: copy as-is (no JS refs in manifest that need rewriting)
cp "${SRC}/manifest.json" "${DEST}/manifest.json"
echo "  ✓ manifest.json"

# Python scripts: copy + strip docstrings/comments
cp "${SRC}"/scripts/*.py "${DEST}/scripts/" 2>/dev/null || true
cp "${SRC}"/scripts/*.sh "${DEST}/scripts/" 2>/dev/null || true
strip_py "${DEST}/scripts"
echo "  ✓ scripts/ copied + stripped"

# CGI scripts: copy + strip
cp "${SRC}"/cgi/*.py "${DEST}/cgi/" 2>/dev/null || true
strip_py "${DEST}/cgi"
echo "  ✓ cgi/ copied + stripped"

# Container catalog: copy entire tree
cp -r "${SRC}"/catalog/* "${DEST}/catalog/" 2>/dev/null || true
echo "  ✓ catalog/ copied ($(ls -d "${DEST}"/catalog/*/rusnas-app.json 2>/dev/null | wc -l | tr -d ' ') apps)"

# Assets (favicon, logo)
if [ -d "${SRC}/assets" ]; then
    mkdir -p "${DEST}/assets"
    cp "${SRC}"/assets/* "${DEST}/assets/" 2>/dev/null || true
    echo "  ✓ assets/ copied (favicon, logo)"
fi

# ── Branding ────────────────────────────────────────────────────────────────
if [ -d cockpit-branding ]; then
    BRAND="${PKG}/usr/share/cockpit/branding/debian"
    mkdir -p "$BRAND"
    cp cockpit-branding/branding.css "$BRAND/" 2>/dev/null || true
    cp cockpit-branding/brand.js "$BRAND/" 2>/dev/null || true
    echo "  ✓ branding copied"
fi

# ── Guard daemon ────────────────────────────────────────────────────────────
echo "Packaging Guard daemon..."
GUARD="${PKG}/usr/lib/rusnas-guard"
mkdir -p "$GUARD"
cp rusnas-guard/daemon/*.py "$GUARD/"
strip_py "$GUARD"
mkdir -p "${PKG}/etc/rusnas-guard"
cp rusnas-guard/config/config.json "${PKG}/etc/rusnas-guard/"
cp rusnas-guard/config/ransom_extensions.txt "${PKG}/etc/rusnas-guard/"
mkdir -p "${PKG}/lib/systemd/system"
cp rusnas-guard/service/rusnas-guard.service "${PKG}/lib/systemd/system/"
echo "  ✓ Guard daemon (6 py + config + service)"

# ── Spindown daemon ─────────────────────────────────────────────────────────
echo "Packaging Spindown daemon..."
SPIND="${PKG}/usr/lib/rusnas/spind"
mkdir -p "$SPIND"
cp rusnas-spind/*.py "$SPIND/"
strip_py "$SPIND"
cp rusnas-spind/rusnas-spind.service "${PKG}/lib/systemd/system/"
echo "  ✓ Spindown daemon"

# ── CGI backend (container_api, spindown_ctl → /usr/lib/rusnas/cgi/) ───────
echo "Packaging CGI backend..."
CGI="${PKG}/usr/lib/rusnas/cgi"
mkdir -p "$CGI"
cp "${SRC}/cgi/container_api.py" "$CGI/" 2>/dev/null || true
cp "${SRC}/cgi/spindown_ctl.py" "$CGI/" 2>/dev/null || true
strip_py "$CGI"
echo "  ✓ CGI backend (stripped)"

# ── Metrics server ──────────────────────────────────────────────────────────
echo "Packaging Metrics server..."
METRICS="${PKG}/usr/local/lib/rusnas"
mkdir -p "$METRICS"
cp rusnas-metrics/metrics_server.py "$METRICS/"
strip_py "$METRICS"
cp rusnas-metrics/rusnas-metrics.service "${PKG}/lib/systemd/system/"
echo "  ✓ Metrics server"

# ── Security self-test ──────────────────────────────────────────────────────
echo "Packaging Security self-test..."
SEC="${PKG}/usr/lib/rusnas/sectest"
mkdir -p "${SEC}/checks" "${SEC}/wordlists"
cp rusnas-sectest/sectest.py "$SEC/"
cp rusnas-sectest/checks/*.py "${SEC}/checks/"
strip_py "$SEC"
cp rusnas-sectest/wordlists/*.txt "${SEC}/wordlists/"
cp rusnas-sectest/rusnas-sectest.service "${PKG}/lib/systemd/system/"
cp rusnas-sectest/rusnas-sectest.timer "${PKG}/lib/systemd/system/"
echo "  ✓ Security self-test ($(ls "${SEC}/checks/"*.py | wc -l | tr -d ' ') check modules)"

# ── Snapshots ───────────────────────────────────────────────────────────────
echo "Packaging Snapshots..."
mkdir -p "${PKG}/usr/local/bin"
cp rusnas-snap/rusnas-snap "${PKG}/usr/local/bin/"
cp rusnas-snap/rusnas-snapd.service "${PKG}/lib/systemd/system/"
cp rusnas-snap/rusnas-snapd.timer "${PKG}/lib/systemd/system/"
if [ -f rusnas-snap/99rusnas-snapshot ]; then
    mkdir -p "${PKG}/etc/apt/apt.conf.d"
    cp rusnas-snap/99rusnas-snapshot "${PKG}/etc/apt/apt.conf.d/"
fi
echo "  ✓ Snapshots (CLI + service + timer)"

# ── Dedup ───────────────────────────────────────────────────────────────────
echo "Packaging Dedup..."
cp rusnas-dedup/rusnas-dedup-run.sh "${PKG}/usr/local/bin/"
cp rusnas-dedup/rusnas-dedup.service "${PKG}/lib/systemd/system/"
echo "  ✓ Dedup"

# ── WORM ────────────────────────────────────────────────────────────────────
echo "Packaging WORM..."
cp rusnas-worm/rusnas-worm.py "${PKG}/usr/local/bin/rusnas-worm"
cp rusnas-worm/rusnas-worm.service "${PKG}/lib/systemd/system/"
cp rusnas-worm/rusnas-worm.timer "${PKG}/lib/systemd/system/"
echo "  ✓ WORM"

# ── Storage Analyzer ────────────────────────────────────────────────────────
echo "Packaging Storage Analyzer..."
cp rusnas-storage-analyzer/storage-collector.py "${DEST}/scripts/" 2>/dev/null || true
cp rusnas-storage-analyzer/storage-analyzer-api.py "${DEST}/scripts/" 2>/dev/null || true
cp rusnas-storage-analyzer/rusnas-storage-collector.service "${PKG}/lib/systemd/system/"
cp rusnas-storage-analyzer/rusnas-storage-collector.timer "${PKG}/lib/systemd/system/"
echo "  ✓ Storage Analyzer"

# ── UPS notify ──────────────────────────────────────────────────────────────
echo "Packaging UPS..."
if [ -f rusnas-ups/rusnas-ups-notify.sh ]; then
    cp rusnas-ups/rusnas-ups-notify.sh "${PKG}/usr/local/bin/rusnas-ups-notify"
    echo "  ✓ UPS notify script"
fi

# ── Certcheck timers ────────────────────────────────────────────────────────
if [ -d rusnas-certcheck ]; then
    cp rusnas-certcheck/*.service "${PKG}/lib/systemd/system/" 2>/dev/null || true
    cp rusnas-certcheck/*.timer "${PKG}/lib/systemd/system/" 2>/dev/null || true
    echo "  ✓ Certcheck timers"
fi

# ── Perf collector service (generated — no standalone file in repo) ─────────
echo "Generating Perf Collector service unit..."
cat > "${PKG}/lib/systemd/system/rusnas-perf-collector.service" << 'SVCEOF'
[Unit]
Description=rusNAS Performance Metrics Collector
After=local-fs.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/share/cockpit/rusnas/scripts/perf-collector.py
Restart=always
RestartSec=5
Nice=19
IOSchedulingClass=idle
MemoryMax=32M

[Install]
WantedBy=multi-user.target
SVCEOF
echo "  ✓ Perf Collector service unit"

# ── Consolidated sudoers ────────────────────────────────────────────────────
echo "Generating consolidated sudoers..."
mkdir -p "${PKG}/etc/sudoers.d"
cat > "${PKG}/etc/sudoers.d/rusnas" << 'SUDOEOF'
# rusNAS consolidated sudoers — auto-generated by build-deb.sh
# Do not edit manually.

# Snapshots
rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-snap

# Dedup
rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-dedup-run.sh
rusnas ALL=(ALL) NOPASSWD: /usr/bin/systemctl start rusnas-dedup.service
rusnas ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop rusnas-dedup.service
rusnas ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/rusnas/dedup-config.json
rusnas ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/cron.d/rusnas-dedup
rusnas ALL=(ALL) NOPASSWD: /usr/bin/rm /etc/cron.d/rusnas-dedup

# Containers
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/cgi/container_api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/podman *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/podman-compose *

# Network
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/ifup
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/ifdown
rusnas ALL=(ALL) NOPASSWD: /sbin/ip
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/network-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/certs-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/etherwake
rusnas ALL=(ALL) NOPASSWD: /bin/rm -f /etc/resolv.conf
rusnas ALL=(ALL) NOPASSWD: /usr/bin/certbot
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/certbot
rusnas ALL=(ALL) NOPASSWD: /usr/bin/openssl
rusnas ALL=(ALL) NOPASSWD: /bin/mkdir -p /etc/rusnas/certs/*
rusnas ALL=(ALL) NOPASSWD: /bin/chmod * /etc/rusnas/certs/*

# Domain
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/domain-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/realm
rusnas ALL=(ALL) NOPASSWD: /usr/bin/net
rusnas ALL=(ALL) NOPASSWD: /usr/bin/wbinfo
rusnas ALL=(ALL) NOPASSWD: /usr/bin/samba-tool
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart winbind
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart smbd
rusnas ALL=(ALL) NOPASSWD: /usr/bin/kinit

# Spindown
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/cgi/spindown_ctl.py *

# Storage Analyzer
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/storage-collector.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/storage-analyzer-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/du -sb --apparent-size *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/find * -type f *

# UPS / NUT
rusnas ALL=(ALL) NOPASSWD: /usr/bin/upsc
rusnas ALL=(ALL) NOPASSWD: /usr/bin/nut-scanner
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl start nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl stop nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl status nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart nut-server
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart nut-monitor
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/upsdrvctl
rusnas ALL=(ALL) NOPASSWD: /usr/bin/journalctl
rusnas ALL=(ALL) NOPASSWD: /usr/bin/apt-get install -y nut

# SSD Tiering (LVM)
rusnas ALL=(ALL) NOPASSWD: /sbin/pvcreate, /sbin/pvremove, /sbin/pvs
rusnas ALL=(ALL) NOPASSWD: /sbin/vgcreate, /sbin/vgremove, /sbin/vgs
rusnas ALL=(ALL) NOPASSWD: /sbin/lvcreate, /sbin/lvremove, /sbin/lvs
rusnas ALL=(ALL) NOPASSWD: /sbin/lvconvert, /sbin/lvchange, /sbin/lvdisplay
rusnas ALL=(ALL) NOPASSWD: /sbin/dmsetup
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/pvcreate, /usr/sbin/pvremove, /usr/sbin/pvs
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/vgcreate, /usr/sbin/vgremove, /usr/sbin/vgs
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/lvcreate, /usr/sbin/lvremove, /usr/sbin/lvs
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/lvconvert, /usr/sbin/lvchange, /usr/sbin/lvdisplay
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/dmsetup
rusnas ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/rusnas/ssd-tiers.json

# Security Self-Test
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/sectest/sectest.py
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/sectest/sectest.py *

# FileBrowser
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/cgi/fb-users-list.py
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/cgi/fb-set-user-access.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/fb-sync-user.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/fb-sync-all-users.py
rusnas ALL=(ALL) NOPASSWD: /usr/bin/systemctl start rusnas-filebrowser
rusnas ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop rusnas-filebrowser
rusnas ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-active rusnas-filebrowser

# MCP API
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/mcp-api.py *

# WORM
rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-worm

# Nginx
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart nginx
SUDOEOF
chmod 440 "${PKG}/etc/sudoers.d/rusnas"
echo "  ✓ Consolidated sudoers"

# ── Landing page + fonts + favicon ──────────────────────────────────────────
if [ -f landing/index.html ]; then
    LAND="${PKG}/var/www/rusnas-landing"
    mkdir -p "${LAND}/fonts"
    cp landing/index.html "${LAND}/"
    cp landing/favicon.svg "${LAND}/" 2>/dev/null || true
    cp landing/fonts/*.ttf "${LAND}/fonts/" 2>/dev/null || true
    echo "  ✓ Landing page + fonts ($(ls "${LAND}/fonts/"*.ttf 2>/dev/null | wc -l | tr -d ' ') font files)"
fi

# ── User documentation (MkDocs built site) ─────────────────────────────────
if [ -d user-docs/site ]; then
    HELP="${PKG}/usr/share/rusnas-help"
    mkdir -p "$HELP"
    cp -r user-docs/site/* "$HELP/"
    echo "  ✓ User docs ($(du -sh "$HELP" | cut -f1))"
else
    echo "  ⚠ user-docs/site/ not found — run 'cd user-docs && mkdocs build' first"
fi

# ── Update version in DEBIAN/control ────────────────────────────────────────
sed -i.bak "s/^Version:.*/Version: ${VERSION}/" "${PKG}/DEBIAN/control"
rm -f "${PKG}/DEBIAN/control.bak"

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Remote build on Linux host
# Cython compilation + dpkg-deb MUST run on Linux x86_64.
# ══════════════════════════════════════════════════════════════════════════════
echo ""
BUILD_HOST="${BUILD_HOST:-}"
BUILD_USER="${BUILD_USER:-root}"
BUILD_PASS="${BUILD_PASS:-}"

if [ -z "$BUILD_HOST" ]; then
    echo "  ╔══════════════════════════════════════════════════════════════╗"
    echo "  ║  BUILD_HOST required (Cython + dpkg-deb need Linux x86_64) ║"
    echo "  ║                                                              ║"
    echo "  ║  BUILD_HOST=10.10.10.31 BUILD_USER=dvl92 \\                 ║"
    echo "  ║  BUILD_PASS=password ./build-deb.sh                          ║"
    echo "  ║                                                              ║"
    echo "  ║  Build host needs: cython3 python3-dev gcc dpkg-deb          ║"
    echo "  ╚══════════════════════════════════════════════════════════════╝"
    exit 1
fi

# SSH/SCP
SSH_OPTS="-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
if [ -n "$BUILD_PASS" ] && command -v sshpass >/dev/null 2>&1; then
    SSH_CMD="sshpass -p '${BUILD_PASS}' ssh ${SSH_OPTS}"
    SCP_CMD="sshpass -p '${BUILD_PASS}' scp ${SSH_OPTS}"
else
    SSH_CMD="ssh"
    SCP_CMD="scp"
fi

# Pack (no macOS metadata)
export COPYFILE_DISABLE=1
TARBALL="rusnas-pkg.tar.gz"
find "${PKG}" -name '._*' -delete 2>/dev/null || true
tar --no-mac-metadata --no-xattrs -czf "${TARBALL}" -C "${PKG}" . 2>/dev/null \
    || COPYFILE_DISABLE=1 tar -czf "${TARBALL}" -C "${PKG}" .
echo "Uploading to ${BUILD_HOST}..."
eval ${SCP_CMD} "${TARBALL}" "tools/cython-build.sh" "${BUILD_USER}@${BUILD_HOST}:/tmp/"

# Remote: unpack → Cython → dpkg-deb → cleanup
echo "Building on ${BUILD_HOST} (Cython + dpkg-deb)..."
eval ${SSH_CMD} "${BUILD_USER}@${BUILD_HOST}" "'
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    rm -rf /tmp/rusnas-pkg && mkdir -p /tmp/rusnas-pkg
    cd /tmp/rusnas-pkg && tar xzf /tmp/${TARBALL}

    # Cython: compile ALL Python → native code
    echo \"  Compiling Python...\"
    for d in usr/lib/rusnas-guard usr/lib/rusnas/spind usr/lib/rusnas/cgi \
             usr/lib/rusnas/sectest usr/lib/rusnas/sectest/checks \
             usr/local/lib/rusnas usr/share/cockpit/rusnas/scripts \
             usr/share/cockpit/rusnas/cgi usr/local/bin; do
        [ -d \"/tmp/rusnas-pkg/\$d\" ] && bash /tmp/cython-build.sh \"/tmp/rusnas-pkg/\$d\" 2>/dev/null
    done

    PY_LEFT=\$(find /tmp/rusnas-pkg/usr -name \"*.py\" -not -name \"__init__.py\" 2>/dev/null | wc -l)
    if [ \"\$PY_LEFT\" -gt 0 ]; then
        echo \"  ⚠ \${PY_LEFT} .py files not compiled:\"
        find /tmp/rusnas-pkg/usr -name \"*.py\" -not -name \"__init__.py\" 2>/dev/null
    else
        echo \"  ✓ Zero .py files — all compiled to native code\"
    fi

    echo kl4389qd | su -c \"dpkg-deb --root-owner-group --build /tmp/rusnas-pkg /tmp/${DEB}\" root 2>/dev/null \
        || dpkg-deb --root-owner-group --build /tmp/rusnas-pkg /tmp/${DEB}
    rm -rf /tmp/rusnas-pkg /tmp/${TARBALL} /tmp/cython-build.sh
'"

# Download
echo "Downloading ${DEB}..."
eval ${SCP_CMD} "${BUILD_USER}@${BUILD_HOST}:/tmp/${DEB}" "./${DEB}"
eval ${SSH_CMD} "${BUILD_USER}@${BUILD_HOST}" "rm -f /tmp/${DEB}" 2>/dev/null || true
rm -f "${TARBALL}"

if [ -f "${DEB}" ]; then
    SIZE=$(du -sh "${DEB}" | cut -f1)
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  ✓ Build complete                               ║"
    echo "║  Package: ${DEB}"
    echo "║  Size:    ${SIZE}"
    echo "║  Python:  compiled to native code (zero .py)    ║"
    echo "║  JS:      minified via terser                   ║"
    echo "╚══════════════════════════════════════════════════╝"
fi
