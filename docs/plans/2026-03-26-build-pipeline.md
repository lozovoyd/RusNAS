# Build Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a repeatable one-command build pipeline that packages the rusNAS Cockpit plugin into a signed `.deb` file and publishes it to the apt repository with a single `./release.sh [main|security] <version>` call.

**Architecture:** `build-deb.sh` uses globs (no hardcoded file lists) — new JS/Python/HTML files in the right folders are auto-included. JS minified via `terser`, Python compiled to `.pyc` (no sources in package). `release.sh` wraps build → GPG sign → scp → reprepro publish.

**Tech Stack:** bash, dpkg-deb, terser (npm), python3 compileall, gpg, reprepro (on VPS), scp

**Spec:** `docs/superpowers/specs/2026-03-26-distribution-licensing-design.md` §8, §9

> **VPS конфигурация:** `RUSNAS_VPS_SSH` (SSH-алиас), `RUSNAS_REPREPRO_BASE`, `RUSNAS_VPS_HOST` — в `CLAUDE.md` → **Distribution Infrastructure**. `release.sh` использует `rusnas-vps` как SSH-алиас.

---

## File Map

```
RusNAS/
├── VERSION                    Single source of version truth (e.g. "1.0.0")
├── build-deb.sh               Build .deb from cockpit/ sources
├── release.sh                 Build + sign + publish to reprepro on VPS
├── pkg/
│   ├── DEBIAN/
│   │   ├── control            Package metadata + Depends
│   │   ├── postinst           Post-install: enable services, mkdir /etc/rusnas, copy pubkey
│   │   ├── prerm              Pre-remove: stop services
│   │   └── conffiles          /etc/rusnas/* preserved on upgrade
│   ├── etc/
│   │   └── rusnas/
│   │       └── operator_public.pem   (placeholder, replaced by build-deb.sh)
│   └── usr/
│       ├── share/cockpit/rusnas/     (populated by build-deb.sh from cockpit/)
│       └── lib/rusnas/
│           ├── license.py            (copied as-is — internal daemon)
│           └── rusnas-license.service
```

---

## Task 1: VERSION file + pkg/DEBIAN skeleton

**Files:**
- Create: `VERSION`
- Create: `pkg/DEBIAN/control`
- Create: `pkg/DEBIAN/postinst`
- Create: `pkg/DEBIAN/prerm`
- Create: `pkg/DEBIAN/conffiles`

- [ ] **Step 1: Create VERSION**

```bash
echo "1.0.0" > VERSION
```

- [ ] **Step 2: Create pkg/DEBIAN/control**

```bash
mkdir -p pkg/DEBIAN pkg/etc/rusnas pkg/usr/share/cockpit/rusnas/js/scripts pkg/usr/share/cockpit/rusnas/css pkg/usr/lib/rusnas
```

`pkg/DEBIAN/control`:
```
Package: rusnas-system
Version: 1.0.0
Architecture: amd64
Maintainer: rusNAS <support@rusnas.ru>
Depends: cockpit, python3, samba, nfs-kernel-server, mdadm, btrfs-progs, targetcli-fb, vsftpd, apache2, nut
Description: rusNAS NAS Management System
 Cockpit plugin providing full NAS management: RAID, Btrfs snapshots,
 Guard ransomware protection, deduplication, UPS, network, and more.
```

- [ ] **Step 3: Create pkg/DEBIAN/postinst**

`pkg/DEBIAN/postinst`:
```bash
#!/bin/bash
set -e
mkdir -p /etc/rusnas
# operator_public.pem already in /etc/rusnas/ from package
systemctl daemon-reload
for svc in rusnas-guard rusnas-metrics rusnas-snapd.timer cockpit.socket rusnas-license; do
    systemctl enable "$svc" 2>/dev/null || true
done
exit 0
```

```bash
chmod 755 pkg/DEBIAN/postinst
```

- [ ] **Step 4: Create pkg/DEBIAN/prerm**

`pkg/DEBIAN/prerm`:
```bash
#!/bin/bash
set -e
for svc in rusnas-guard rusnas-metrics rusnas-snapd.timer; do
    systemctl stop "$svc" 2>/dev/null || true
done
exit 0
```

```bash
chmod 755 pkg/DEBIAN/prerm
```

- [ ] **Step 5: Create pkg/DEBIAN/conffiles**

`pkg/DEBIAN/conffiles`:
```
/etc/rusnas/operator_public.pem
```

- [ ] **Step 6: Commit**

```bash
git add VERSION pkg/
git commit -m "feat: deb package skeleton (DEBIAN/ control files)"
```

---

## Task 2: build-deb.sh

**Files:**
- Create: `build-deb.sh`

Prerequisites on Mac: `npm install -g terser` (one-time setup)

- [ ] **Step 1: Install terser if not present**

```bash
which terser || npm install -g terser
terser --version
```
Expected: version string like `5.x.x`

- [ ] **Step 2: Write build-deb.sh**

`build-deb.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

VERSION=$(cat VERSION)
PKG_DIR="$(pwd)/pkg"
COCKPIT_SRC="$(pwd)/cockpit/rusnas"
OUTPUT="rusnas-system_${VERSION}_amd64.deb"

echo "Building rusnas-system ${VERSION}..."

# ── Clean previous build output inside pkg ────────────────────────────────────
COCKPIT_DEST="${PKG_DIR}/usr/share/cockpit/rusnas"
rm -rf "${COCKPIT_DEST}"
mkdir -p "${COCKPIT_DEST}/js/scripts" "${COCKPIT_DEST}/css"

# ── JS: minify all *.js → *.min.js ───────────────────────────────────────────
for f in "${COCKPIT_SRC}"/js/*.js; do
    base=$(basename "$f" .js)
    terser "$f" --compress --mangle \
        --output "${COCKPIT_DEST}/js/${base}.min.js" \
        2>/dev/null || { echo "terser failed on $f"; exit 1; }
done
echo "  JS minified: $(ls "${COCKPIT_DEST}/js/"*.min.js | wc -l) files"

# ── Python: compile *.py → *.pyc, copy pyc only ──────────────────────────────
python3 -m compileall -b -q "${COCKPIT_SRC}/js/scripts/"
for pyc in "${COCKPIT_SRC}"/js/scripts/*.pyc; do
    [ -f "$pyc" ] && cp "$pyc" "${COCKPIT_DEST}/js/scripts/"
done
echo "  Python compiled: $(ls "${COCKPIT_DEST}/js/scripts/"*.pyc 2>/dev/null | wc -l) files"

# ── HTML: copy + rewrite .js refs to .min.js ─────────────────────────────────
for f in "${COCKPIT_SRC}"/*.html; do
    dest="${COCKPIT_DEST}/$(basename "$f")"
    sed 's/\.js"/\.min\.js"/g; s/\.js'"'"'/\.min\.js'"'"'/g' "$f" > "$dest"
done
echo "  HTML: $(ls "${COCKPIT_DEST}"/*.html | wc -l) files"

# ── Static: manifest.json, CSS ───────────────────────────────────────────────
cp "${COCKPIT_SRC}/manifest.json" "${COCKPIT_DEST}/"
cp "${COCKPIT_SRC}"/css/*.css "${COCKPIT_DEST}/css/" 2>/dev/null || true

# ── operator_public.pem (from license server dir if present) ─────────────────
PUB_KEY="rusnas-license-server/operator_public.pem"
if [ -f "$PUB_KEY" ]; then
    cp "$PUB_KEY" "${PKG_DIR}/etc/rusnas/operator_public.pem"
    echo "  Embedded operator_public.pem"
else
    echo "  WARNING: operator_public.pem not found at ${PUB_KEY} — using placeholder"
    echo "PLACEHOLDER - run keygen.py first" > "${PKG_DIR}/etc/rusnas/operator_public.pem"
fi

# ── Internal rusnas-license daemon (plain Python, not minified) ───────────────
mkdir -p "${PKG_DIR}/usr/lib/rusnas"
[ -f rusnas-license-server/license.py ] && cp rusnas-license-server/license.py "${PKG_DIR}/usr/lib/rusnas/"
[ -f rusnas-license-server/rusnas-license.service ] && cp rusnas-license-server/rusnas-license.service "${PKG_DIR}/usr/lib/rusnas/"

# ── Update version in DEBIAN/control ─────────────────────────────────────────
sed -i.bak "s/^Version:.*/Version: ${VERSION}/" "${PKG_DIR}/DEBIAN/control"
rm -f "${PKG_DIR}/DEBIAN/control.bak"

# ── Build .deb ────────────────────────────────────────────────────────────────
rm -f "${OUTPUT}"
dpkg-deb --build "${PKG_DIR}" "${OUTPUT}"
echo "Built: ${OUTPUT} ($(du -sh "${OUTPUT}" | cut -f1))"
```

```bash
chmod +x build-deb.sh
```

- [ ] **Step 3: Test build**

```bash
./build-deb.sh
```
Expected output:
```
Building rusnas-system 1.0.0...
  JS minified: N files
  Python compiled: N files
  HTML: N files
  Built: rusnas-system_1.0.0_amd64.deb (XXk)
```

Inspect the deb:
```bash
dpkg-deb --contents rusnas-system_1.0.0_amd64.deb | head -30
```
Verify: `.min.js` files present, NO `.js` sources, `.pyc` files present, NO `.py` sources.

- [ ] **Step 4: Add .deb to .gitignore**

```bash
echo "*.deb" >> .gitignore
echo "pkg/usr/share/cockpit/rusnas/" >> .gitignore
```

- [ ] **Step 5: Commit**

```bash
git add build-deb.sh .gitignore
git commit -m "feat: build-deb.sh — glob-based .deb builder with JS minify + Python .pyc"
```

---

## Task 3: release.sh

**Files:**
- Create: `release.sh`

Prerequisites:
- GPG key for signing (generate once: `gpg --gen-key`, note the key ID)
- VPS accessible via `ssh rusnas-vps` (add to `~/.ssh/config` with key auth)
- reprepro installed on VPS: `apt install reprepro`

- [ ] **Step 1: Set up reprepro on VPS (one-time, manual)**

```bash
ssh rusnas-vps
sudo mkdir -p /var/lib/reprepro/conf /var/lib/reprepro/public
```

`/var/lib/reprepro/conf/distributions`:
```
Origin: rusNAS
Label: rusNAS
Codename: trixie
Architectures: amd64 source
Components: main security
Description: rusNAS System Packages
SignWith: <YOUR_GPG_KEY_ID>
```

```bash
# Export GPG public key for devices
gpg --export --armor <YOUR_GPG_KEY_ID> > /tmp/rusnas.gpg
# Download to Mac: scp rusnas-vps:/tmp/rusnas.gpg .
```

- [ ] **Step 2: Write release.sh**

`release.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

COMPONENT=${1:-}
VERSION=${2:-}
VPS="rusnas-vps"                    # must be in ~/.ssh/config
REPREPRO_BASE="/var/lib/reprepro"

if [[ -z "$COMPONENT" || -z "$VERSION" ]]; then
    echo "Usage: ./release.sh [main|security] <version>"
    echo "  main:     feature release (requires updates_features license)"
    echo "  security: patch release (all active licenses)"
    exit 1
fi

if [[ "$COMPONENT" != "main" && "$COMPONENT" != "security" ]]; then
    echo "Error: component must be 'main' or 'security'"
    exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: version must be X.Y.Z (e.g. 1.0.1)"
    exit 1
fi

echo "Releasing rusnas-system ${VERSION} → ${COMPONENT}"
echo ""

# ── Bump VERSION ─────────────────────────────────────────────────────────────
echo "$VERSION" > VERSION

# ── Build ─────────────────────────────────────────────────────────────────────
./build-deb.sh

DEB="rusnas-system_${VERSION}_amd64.deb"

# ── GPG sign ──────────────────────────────────────────────────────────────────
echo "Signing..."
gpg --batch --yes --detach-sign "${DEB}"
echo "  Signed: ${DEB}.sig"

# ── Upload to VPS ─────────────────────────────────────────────────────────────
echo "Uploading to VPS..."
scp "${DEB}" "${DEB}.sig" "${VPS}:/tmp/"

# ── reprepro publish ──────────────────────────────────────────────────────────
echo "Publishing to reprepro (${COMPONENT})..."
ssh "${VPS}" "reprepro -b ${REPREPRO_BASE} includedeb trixie ${COMPONENT} /tmp/${DEB} && rm /tmp/${DEB} /tmp/${DEB}.sig"

# ── Git tag + commit ─────────────────────────────────────────────────────────
git add VERSION
git commit -m "chore: bump version to ${VERSION}" 2>/dev/null || true
git tag "v${VERSION}-${COMPONENT}"

echo ""
echo "✅ Released: rusnas-system ${VERSION} → ${COMPONENT}"
echo "   Devices will receive it on next: apt update && apt upgrade"
```

```bash
chmod +x release.sh
```

- [ ] **Step 3: Smoke test (dry run)**

```bash
# Test arg validation without actually releasing
bash -n release.sh  # syntax check
./release.sh        # no args → should print usage and exit 1
./release.sh main   # missing version → usage + exit 1
./release.sh bad 1.0.0  # bad component → error + exit 1
```
Expected: correct error messages each time.

- [ ] **Step 4: Commit**

```bash
git add release.sh
git commit -m "feat: release.sh — one-command build + sign + publish to reprepro"
```

---

## Task 4: Verify full round-trip on VM

- [ ] **Step 1: Add rusnas.gpg to VM apt keyrings**

```bash
sshpass -p 'kl4389qd' scp -o StrictHostKeyChecking=no rusnas.gpg rusnas@10.10.10.72:/tmp/
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no rusnas@10.10.10.72 \
  "sudo mkdir -p /etc/apt/keyrings && sudo cp /tmp/rusnas.gpg /etc/apt/keyrings/rusnas.gpg"
```

- [ ] **Step 2: Add sources.list entry on VM**

```bash
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no rusnas@10.10.10.72 \
  "echo 'deb [signed-by=/etc/apt/keyrings/rusnas.gpg] https://activate.rusnas.ru/apt/ trixie main security' | sudo tee /etc/apt/sources.list.d/rusnas.list"
```

- [ ] **Step 3: Do a real release**

```bash
./release.sh security 1.0.0
```

- [ ] **Step 4: Verify on VM**

```bash
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no rusnas@10.10.10.72 \
  "sudo apt update && apt list --upgradable 2>/dev/null | grep rusnas"
```
Expected: `rusnas-system/trixie 1.0.0 amd64`

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "feat: build pipeline verified — release.sh end-to-end working"
```
