# rusNAS Demo Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a monolithic `.deb` package + `demo-install.sh` that installs the complete rusNAS system on a clean Debian 13 machine with one command — no license server, no VPS, no internet required for the .deb itself.

**Architecture:** `build-deb.sh` collects all Cockpit plugin files (JS minified via terser), backend daemons, CGI scripts, systemd units, sudoers, and config defaults into a single `pkg/` tree, then runs `dpkg-deb --build`. `demo-install.sh` installs apt dependencies, runs `dpkg -i`, creates the rusnas user, sets up demo license, configures nginx + landing page, and starts all services.

**Tech Stack:** bash, dpkg-deb, terser (npm), python3, sed

**Spec:** `docs/superpowers/specs/2026-04-03-demo-release-design.md`

---

## File Map

```
RusNAS/
├── VERSION                                    # NEW — "1.0.0-demo"
├── build-deb.sh                               # NEW — build script (runs on Mac)
├── demo-install.sh                            # NEW — installer (runs on target Debian 13)
├── pkg/
│   └── DEBIAN/
│       ├── control                            # NEW — package metadata
│       ├── postinst                           # NEW — post-install setup
│       ├── prerm                              # NEW — pre-remove cleanup
│       └── conffiles                          # NEW — protected config paths
└── .gitignore                                 # MODIFY — add pkg build artifacts + *.deb
```

`build-deb.sh` populates `pkg/` with files from existing source dirs (cockpit/, rusnas-guard/, rusnas-spind/, etc.) at build time. The `pkg/` directory is ephemeral except for `DEBIAN/`.

---

## Task 1: VERSION + pkg/DEBIAN skeleton

**Files:**
- Create: `VERSION`
- Create: `pkg/DEBIAN/control`
- Create: `pkg/DEBIAN/postinst`
- Create: `pkg/DEBIAN/prerm`
- Create: `pkg/DEBIAN/conffiles`
- Modify: `.gitignore`

- [ ] **Step 1: Create VERSION file**

```bash
echo "1.0.0-demo" > VERSION
```

- [ ] **Step 2: Create directory structure**

```bash
mkdir -p pkg/DEBIAN
```

- [ ] **Step 3: Create pkg/DEBIAN/control**

Write `pkg/DEBIAN/control`:
```
Package: rusnas-system
Version: 1.0.0-demo
Architecture: amd64
Maintainer: rusNAS <support@rusnas.ru>
Depends: cockpit (>= 300), python3 (>= 3.11), samba, nfs-kernel-server, mdadm, btrfs-progs, smartmontools, targetcli-fb, hdparm, nginx
Recommends: podman, podman-compose, nut, vsftpd, apache2, lvm2, thin-provisioning-tools, certbot, nmap, python3-bcrypt, python3-croniter
Description: rusNAS NAS Management System (Demo)
 Enterprise-grade NAS management platform. Cockpit-based web UI with
 RAID management, Btrfs snapshots, ransomware protection (Guard),
 deduplication, UPS monitoring, container apps, network management,
 performance tuning, security self-test, and more.
 .
 This is a demo build for internal evaluation.
```

- [ ] **Step 4: Create pkg/DEBIAN/postinst**

Write `pkg/DEBIAN/postinst`:
```bash
#!/bin/bash
set -e

# ── Directories ──────────────────────────────────────────────────────────────
mkdir -p /var/lib/rusnas /var/log/rusnas /var/log/rusnas-guard
mkdir -p /etc/rusnas /etc/rusnas-guard /etc/rusnas/containers /etc/rusnas/certs
mkdir -p /var/lib/rusnas-containers/compose /var/lib/rusnas-containers/catalog
mkdir -p /etc/nginx/conf.d/rusnas-apps
mkdir -p /var/www/rusnas-landing

# ── Permissions ──────────────────────────────────────────────────────────────
chmod 755 /etc/rusnas-guard
chmod 755 /var/lib/rusnas
chmod 755 /var/log/rusnas-guard

# ── Guard daemon symlink ─────────────────────────────────────────────────────
ln -sf /usr/lib/rusnas-guard/guard.py /usr/local/sbin/rusnas-guard

# ── Executable permissions ───────────────────────────────────────────────────
chmod 755 /usr/lib/rusnas-guard/guard.py 2>/dev/null || true
chmod 755 /usr/local/bin/rusnas-snap 2>/dev/null || true
chmod 755 /usr/local/bin/rusnas-dedup-run.sh 2>/dev/null || true
chmod 755 /usr/local/bin/rusnas-worm 2>/dev/null || true
chmod 755 /usr/local/bin/rusnas-ups-notify 2>/dev/null || true
chmod 755 /usr/lib/rusnas/spind/spind.py 2>/dev/null || true
chmod 755 /usr/lib/rusnas/sectest/sectest.py 2>/dev/null || true
find /usr/lib/rusnas/cgi/ -name '*.py' -exec chmod 755 {} + 2>/dev/null || true
find /usr/share/cockpit/rusnas/scripts/ -name '*.py' -exec chmod 755 {} + 2>/dev/null || true
find /usr/share/cockpit/rusnas/scripts/ -name '*.sh' -exec chmod 755 {} + 2>/dev/null || true

# ── Config defaults (don't overwrite existing) ───────────────────────────────
[ -f /etc/rusnas/spindown.json ] || echo '{"version":1,"arrays":{}}' > /etc/rusnas/spindown.json
[ -f /etc/rusnas/dedup-config.json ] || echo '{"volumes":[],"schedule_enabled":false}' > /etc/rusnas/dedup-config.json
[ -f /etc/rusnas/ssd-tiers.json ] || echo '{"tiers":[]}' > /etc/rusnas/ssd-tiers.json
[ -f /etc/rusnas/worm.json ] || echo '{"paths":[]}' > /etc/rusnas/worm.json
[ -f /etc/rusnas/containers/installed.json ] || echo '{}' > /etc/rusnas/containers/installed.json

# ── State files ──────────────────────────────────────────────────────────────
touch /var/lib/rusnas/perf-history.json
chmod 666 /var/lib/rusnas/perf-history.json

# ── Sudoers validation ───────────────────────────────────────────────────────
if [ -f /etc/sudoers.d/rusnas ]; then
    visudo -cf /etc/sudoers.d/rusnas || echo "WARNING: sudoers syntax error in /etc/sudoers.d/rusnas"
fi

# ── Reload systemd ───────────────────────────────────────────────────────────
systemctl daemon-reload

# ── Enable core services (don't start yet — demo-install.sh handles that) ──
systemctl enable cockpit.socket 2>/dev/null || true
systemctl enable rusnas-guard 2>/dev/null || true
systemctl enable rusnas-snapd.timer 2>/dev/null || true
systemctl enable rusnas-metrics 2>/dev/null || true

exit 0
```

Then `chmod 755 pkg/DEBIAN/postinst`.

- [ ] **Step 5: Create pkg/DEBIAN/prerm**

Write `pkg/DEBIAN/prerm`:
```bash
#!/bin/bash
set -e
for svc in rusnas-guard rusnas-metrics rusnas-perf-collector rusnas-spind; do
    systemctl stop "$svc" 2>/dev/null || true
done
for tmr in rusnas-snapd.timer rusnas-sectest.timer rusnas-storage-collector.timer rusnas-worm.timer rusnas-certcheck.timer; do
    systemctl stop "$tmr" 2>/dev/null || true
done
exit 0
```

Then `chmod 755 pkg/DEBIAN/prerm`.

- [ ] **Step 6: Create pkg/DEBIAN/conffiles**

Write `pkg/DEBIAN/conffiles`:
```
/etc/rusnas-guard/config.json
/etc/rusnas-guard/ransom_extensions.txt
```

- [ ] **Step 7: Update .gitignore**

Append to `.gitignore`:
```
# Demo release build artifacts
*.deb
pkg/etc/
pkg/lib/
pkg/usr/
pkg/var/
```

- [ ] **Step 8: Commit**

```bash
git add VERSION pkg/DEBIAN/ .gitignore
git commit -m "feat: deb package skeleton — VERSION, DEBIAN/control, postinst, prerm, conffiles

Authored-By: Dmitrii V. Lozovoi (lozovoyd@gmail.com)
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: build-deb.sh

**Files:**
- Create: `build-deb.sh`

**Prerequisites on Mac:** `npm install -g terser` and `brew install dpkg` (one-time setup)

- [ ] **Step 1: Verify terser and dpkg-deb are available**

```bash
which terser || npm install -g terser
which dpkg-deb || brew install dpkg
terser --version
dpkg-deb --version
```

- [ ] **Step 2: Write build-deb.sh**

Create `build-deb.sh` (chmod 755):

```bash
#!/usr/bin/env bash
# build-deb.sh — Build rusnas-system .deb package from source
# Usage: ./build-deb.sh
set -euo pipefail

VERSION=$(cat VERSION)
PKG="$(pwd)/pkg"
SRC="$(pwd)/cockpit/rusnas"
DEB="rusnas-system_${VERSION}_amd64.deb"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  rusNAS Build System v${VERSION}                ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Prerequisites ────────────────────────────────────────────────────────────
for cmd in terser dpkg-deb python3 sed; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found. Install it first."; exit 1; }
done

# ── Clean previous build ────────────────────────────────────────────────────
echo "Cleaning previous build..."
rm -rf "${PKG}/usr" "${PKG}/etc" "${PKG}/lib" "${PKG}/var"

# ── Cockpit plugin ──────────────────────────────────────────────────────────
DEST="${PKG}/usr/share/cockpit/rusnas"
mkdir -p "${DEST}/js" "${DEST}/css" "${DEST}/scripts" "${DEST}/cgi" "${DEST}/catalog"

# JS: minify all *.js → *.min.js
echo "Minifying JavaScript..."
JS_COUNT=0
for f in "${SRC}"/js/*.js; do
    base=$(basename "$f" .js)
    terser "$f" --compress --mangle \
        --output "${DEST}/js/${base}.min.js" 2>/dev/null \
        || { echo "  ERROR: terser failed on $(basename "$f")"; exit 1; }
    JS_COUNT=$((JS_COUNT + 1))
done
echo "  ✓ ${JS_COUNT} JS files minified"

# HTML: copy + rewrite .js refs → .min.js
echo "Processing HTML..."
HTML_COUNT=0
for f in "${SRC}"/*.html; do
    sed 's/\.js"/\.min.js"/g; s/\.js'"'"'/\.min.js'"'"'/g' "$f" > "${DEST}/$(basename "$f")"
    HTML_COUNT=$((HTML_COUNT + 1))
done
echo "  ✓ ${HTML_COUNT} HTML files processed"

# CSS: copy as-is
cp "${SRC}"/css/*.css "${DEST}/css/"
echo "  ✓ $(ls "${DEST}/css/"*.css | wc -l | tr -d ' ') CSS files copied"

# manifest.json: copy + rewrite .js refs → .min.js
sed 's/\.js"/\.min.js"/g' "${SRC}/manifest.json" > "${DEST}/manifest.json"
echo "  ✓ manifest.json"

# Python scripts: copy as-is (protection via pyarmor is a production task)
cp "${SRC}"/scripts/*.py "${DEST}/scripts/" 2>/dev/null || true
cp "${SRC}"/scripts/*.sh "${DEST}/scripts/" 2>/dev/null || true
echo "  ✓ scripts/ copied"

# CGI scripts: copy as-is
cp "${SRC}"/cgi/*.py "${DEST}/cgi/" 2>/dev/null || true
echo "  ✓ cgi/ copied"

# Container catalog: copy entire tree
cp -r "${SRC}"/catalog/* "${DEST}/catalog/" 2>/dev/null || true
echo "  ✓ catalog/ copied ($(ls -d "${DEST}"/catalog/*/rusnas-app.json 2>/dev/null | wc -l | tr -d ' ') apps)"

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
cp rusnas-spind/rusnas-spind.service "${PKG}/lib/systemd/system/"
echo "  ✓ Spindown daemon"

# ── CGI backend (container_api, spindown_ctl) ───────────────────────────────
echo "Packaging CGI backend..."
CGI="${PKG}/usr/lib/rusnas/cgi"
mkdir -p "$CGI"
# These go to /usr/lib/rusnas/cgi/ (NOT cockpit dir) per install scripts
cp "${SRC}/cgi/container_api.py" "$CGI/" 2>/dev/null || true
cp "${SRC}/cgi/spindown_ctl.py" "$CGI/" 2>/dev/null || true
echo "  ✓ CGI backend"

# ── Metrics server ──────────────────────────────────────────────────────────
echo "Packaging Metrics server..."
METRICS="${PKG}/usr/local/lib/rusnas"
mkdir -p "$METRICS"
cp rusnas-metrics/metrics_server.py "$METRICS/"
cp rusnas-metrics/rusnas-metrics.service "${PKG}/lib/systemd/system/"
echo "  ✓ Metrics server"

# ── Security self-test ──────────────────────────────────────────────────────
echo "Packaging Security self-test..."
SEC="${PKG}/usr/lib/rusnas/sectest"
mkdir -p "${SEC}/checks" "${SEC}/wordlists"
cp rusnas-sectest/sectest.py "$SEC/"
cp rusnas-sectest/checks/*.py "${SEC}/checks/"
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

# ── Perf collector service (generated inline, no source file) ───────────────
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

# ── Landing page ────────────────────────────────────────────────────────────
if [ -f landing/index.html ]; then
    mkdir -p "${PKG}/var/www/rusnas-landing"
    cp landing/index.html "${PKG}/var/www/rusnas-landing/"
    echo "  ✓ Landing page"
fi

# ── Update version in DEBIAN/control ────────────────────────────────────────
sed -i.bak "s/^Version:.*/Version: ${VERSION}/" "${PKG}/DEBIAN/control"
rm -f "${PKG}/DEBIAN/control.bak"

# ── Build .deb ──────────────────────────────────────────────────────────────
echo ""
echo "Building ${DEB}..."
rm -f "${DEB}"
dpkg-deb --root-owner-group --build "${PKG}" "${DEB}"

SIZE=$(du -sh "${DEB}" | cut -f1)
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  ✓ Build complete                               ║"
echo "║  Package: ${DEB}"
echo "║  Size: ${SIZE}"
echo "╚══════════════════════════════════════════════════╝"
```

- [ ] **Step 3: Make executable**

```bash
chmod +x build-deb.sh
```

- [ ] **Step 4: Test build**

```bash
./build-deb.sh
```

Expected output: package built with all components listed, no errors.

- [ ] **Step 5: Inspect the built .deb**

```bash
dpkg-deb --contents rusnas-system_1.0.0-demo_amd64.deb | head -50
```

Verify: `.min.js` files present in `usr/share/cockpit/rusnas/js/`, NO `.js` sources there. HTML, CSS, Python scripts present. Systemd units in `lib/systemd/system/`. Sudoers in `etc/sudoers.d/rusnas`.

- [ ] **Step 6: Commit**

```bash
git add build-deb.sh
git commit -m "feat: build-deb.sh — monolithic .deb builder with JS minification

Authored-By: Dmitrii V. Lozovoi (lozovoyd@gmail.com)
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: demo-install.sh

**Files:**
- Create: `demo-install.sh`

- [ ] **Step 1: Write demo-install.sh**

Create `demo-install.sh` (chmod 755):

```bash
#!/usr/bin/env bash
# rusNAS Demo Installer
# Usage: sudo bash demo-install.sh
# Installs rusNAS on a clean Debian 13 (Trixie) system.
# No license server or internet required for the .deb itself.
set -euo pipefail

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
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                                                              ║"
echo "║              rusNAS Demo Installer                           ║"
echo "║              Enterprise NAS Platform                         ║"
echo "║                                                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. PREFLIGHT ─────────────────────────────────────────────────────────────
info "Running preflight checks..."

# Root
[ "$(id -u)" -eq 0 ] || fail "Must run as root (use: sudo bash demo-install.sh)"

# Debian 13
if command -v lsb_release &>/dev/null; then
    CODENAME=$(lsb_release -cs 2>/dev/null || echo "unknown")
else
    CODENAME=$(grep VERSION_CODENAME /etc/os-release 2>/dev/null | cut -d= -f2 || echo "unknown")
fi
[ "$CODENAME" = "trixie" ] || fail "rusNAS requires Debian 13 (trixie). Detected: ${CODENAME}"

# Find .deb in current directory
DEB=$(ls -1 rusnas-system_*.deb 2>/dev/null | head -1)
[ -n "$DEB" ] || fail "No rusnas-system_*.deb found in current directory"

ok "Preflight passed (Debian 13 trixie, package: ${DEB})"

# ── 2. SYSTEM DEPENDENCIES ──────────────────────────────────────────────────
echo ""
info "Installing system dependencies (this may take a few minutes)..."

export DEBIAN_FRONTEND=noninteractive

apt-get update -qq

# Core dependencies (from DEBIAN/control Depends + Recommends)
apt-get install -y -qq \
    cockpit cockpit-storaged \
    python3 python3-bcrypt python3-croniter \
    samba nfs-kernel-server \
    mdadm btrfs-progs smartmontools \
    targetcli-fb hdparm \
    nginx vsftpd apache2 \
    lvm2 thin-provisioning-tools \
    nut \
    traceroute dnsutils netcat-openbsd etherwake certbot \
    nmap \
    2>/dev/null || warn "Some optional packages failed to install (non-critical)"

# Podman (container manager) — may not be available on all mirrors
apt-get install -y -qq \
    podman podman-compose slirp4netns fuse-overlayfs crun uidmap \
    2>/dev/null || warn "Podman packages not available — container manager will be limited"

ok "Dependencies installed"

# ── 3. INSTALL .DEB ──────────────────────────────────────────────────────────
echo ""
info "Installing rusnas-system package..."

dpkg -i "${DEB}" 2>/dev/null || true
apt-get install -f -y -qq  # fix any missing deps

ok "Package installed"

# ── 4. CREATE RUSNAS USER ────────────────────────────────────────────────────
info "Configuring rusnas user..."

if ! id rusnas &>/dev/null; then
    useradd -m -s /bin/bash -G sudo rusnas
    echo "rusnas:rusnas" | chpasswd
    ok "User 'rusnas' created (password: rusnas)"
else
    # Ensure user is in sudo group
    usermod -aG sudo rusnas 2>/dev/null || true
    ok "User 'rusnas' already exists"
fi

# ── 5. DEMO LICENSE ──────────────────────────────────────────────────────────
info "Setting up demo license..."

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

ok "Demo license installed (Enterprise, all features, no expiry)"

# ── 6. COCKPIT CONFIGURATION ────────────────────────────────────────────────
info "Configuring Cockpit..."

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

# ── 7. NGINX PRIMARY SERVER ─────────────────────────────────────────────────
info "Configuring nginx..."

# Disable default site
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

# Move Apache to port 8091 (WebDAV only) if it's on 80
if [ -f /etc/apache2/ports.conf ]; then
    sed -i 's/Listen 80/Listen 8091/' /etc/apache2/ports.conf 2>/dev/null || true
    systemctl restart apache2 2>/dev/null || true
fi

cat > /etc/nginx/sites-available/rusnas.conf << 'NGEOF'
server {
    listen 80 default_server;
    server_name _;

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

    # Container apps includes
    include /etc/nginx/conf.d/rusnas-apps/*.conf;

    # Fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGEOF

ln -sf /etc/nginx/sites-available/rusnas.conf /etc/nginx/sites-enabled/rusnas.conf
nginx -t 2>/dev/null && systemctl reload nginx

ok "nginx configured (landing on :80)"

# ── 8. START SERVICES ────────────────────────────────────────────────────────
echo ""
info "Starting services..."

systemctl daemon-reload

# Core
systemctl enable --now cockpit.socket
ok "Cockpit started"

systemctl enable --now rusnas-guard 2>/dev/null && ok "Guard daemon started" || warn "Guard daemon failed to start"
systemctl enable --now rusnas-metrics 2>/dev/null && ok "Metrics server started" || warn "Metrics server failed to start"
systemctl enable --now rusnas-perf-collector 2>/dev/null && ok "Perf collector started" || warn "Perf collector failed to start"

# Timers
systemctl enable rusnas-snapd.timer 2>/dev/null && ok "Snapshot timer enabled" || true
systemctl enable rusnas-storage-collector.timer 2>/dev/null && ok "Storage collector timer enabled" || true
systemctl enable rusnas-sectest.timer 2>/dev/null && ok "Security test timer enabled" || true

# Nginx
systemctl enable --now nginx 2>/dev/null && ok "nginx started" || warn "nginx failed to start"

# ── 9. FINAL OUTPUT ──────────────────────────────────────────────────────────
IP=$(hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}${BOLD}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                                                              ║"
echo "║   rusNAS Demo установлен успешно!                            ║"
echo "║                                                              ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║                                                              ║"
echo "║   Cockpit:    https://${IP}:9090                     ║"
echo "║   Landing:    http://${IP}                                ║"
echo "║   Логин:      rusnas / rusnas                                ║"
echo "║                                                              ║"
echo "║   Лицензия:   Demo Enterprise (все функции)                  ║"
echo "║   Serial:     RUSNAS-DEMO-INTE-RNAL-ONLY                     ║"
echo "║                                                              ║"
echo "║   Первый шаг: Включите 'Administrative access'              ║"
echo "║   в Cockpit для работы с дисками и RAID                      ║"
echo "║                                                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x demo-install.sh
```

- [ ] **Step 3: Commit**

```bash
git add demo-install.sh
git commit -m "feat: demo-install.sh — one-command installer for clean Debian 13

Authored-By: Dmitrii V. Lozovoi (lozovoyd@gmail.com)
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Build and verify locally

- [ ] **Step 1: Run the build**

```bash
./build-deb.sh
```

Expected: `rusnas-system_1.0.0-demo_amd64.deb` created successfully.

- [ ] **Step 2: Verify package contents**

```bash
dpkg-deb --contents rusnas-system_1.0.0-demo_amd64.deb | grep -E '\.(min\.js|py|service|timer|css|html)' | head -40
```

Verify checklist:
- `usr/share/cockpit/rusnas/js/*.min.js` — minified JS (no plain .js)
- `usr/share/cockpit/rusnas/*.html` — all 14 pages
- `usr/share/cockpit/rusnas/css/*.css` — all 7 CSS files
- `lib/systemd/system/rusnas-*.service` — all services
- `lib/systemd/system/rusnas-*.timer` — all timers
- `etc/sudoers.d/rusnas` — consolidated sudoers
- `etc/rusnas-guard/config.json` — Guard config
- `usr/lib/rusnas-guard/*.py` — Guard daemon
- `usr/lib/rusnas/spind/*.py` — Spindown daemon
- `usr/lib/rusnas/sectest/*.py` — Security self-test
- `var/www/rusnas-landing/index.html` — Landing page

- [ ] **Step 3: Verify no .js source files leaked**

```bash
dpkg-deb --contents rusnas-system_1.0.0-demo_amd64.deb | grep 'rusnas/js/' | grep -v '.min.js'
```

Expected: NO output (only .min.js files should be present).

- [ ] **Step 4: Verify HTML references rewritten**

```bash
dpkg-deb --fsys-tarfile rusnas-system_1.0.0-demo_amd64.deb | tar xf - --to-stdout ./usr/share/cockpit/rusnas/dashboard.html 2>/dev/null | grep -o 'src="[^"]*"' | head -5
```

Expected: all `src="js/xxx.min.js"` (no plain `.js` references).

- [ ] **Step 5: Commit verification notes**

```bash
git add -A
git commit -m "chore: build pipeline verified — .deb builds clean with all components

Authored-By: Dmitrii V. Lozovoi (lozovoyd@gmail.com)
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Test installation on VM

This task tests the full install on the existing VM (10.10.10.72) which already has Debian 13.

- [ ] **Step 1: Copy files to VM**

```bash
sshpass -p 'kl4389qd' scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  rusnas-system_1.0.0-demo_amd64.deb demo-install.sh \
  rusnas@10.10.10.72:/tmp/
```

- [ ] **Step 2: Run installer on VM**

```bash
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  rusnas@10.10.10.72 "cd /tmp && echo 'kl4389qd' | sudo -S bash demo-install.sh"
```

Expected: installer completes with the success banner showing IP and credentials.

- [ ] **Step 3: Verify Cockpit loads**

Open `https://10.10.10.72:9090` in browser. Login as `rusnas`. Verify:
- All 14 pages appear in sidebar
- Dashboard loads with metrics
- License page shows "Demo Enterprise"

- [ ] **Step 4: Verify services running**

```bash
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  rusnas@10.10.10.72 "systemctl is-active rusnas-guard rusnas-metrics rusnas-perf-collector cockpit.socket nginx"
```

Expected: all `active`.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: demo release pipeline complete — build + install verified on VM

Authored-By: Dmitrii V. Lozovoi (lozovoyd@gmail.com)
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
