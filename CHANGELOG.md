# Changelog

All notable changes to RusNAS are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

## [Unreleased]

### Added
- Demo release `.deb` installer (`build-deb.sh`, `demo-install.sh`) for clean Debian 13 deployment
- User documentation site (MkDocs Material, 32 pages, 36 screenshots) served at `/help/`
- Favicon and SVG logo added to all 14 Cockpit HTML pages and landing page
- Landing page offline mode (self-hosted Manrope fonts, zero external CDN dependencies)
- Build guide (`docs/build-guide.md`) with full build and install instructions
- Notification system daemon (`rusnas-notify`) with Email, Telegram, MAX, SNMP, and Webhook channels
- RAM Monitor Modal on dashboard with memory breakdown, `/proc/meminfo` stats, and top 15 processes by RSS

### Changed
- Dashboard performance charts now show full history instead of last 15 minutes (`_perfAutoFitted` auto-detection)
- Chart.js `GAP_MS` increased from 30s to 600s to prevent line breaks on downsampled data
- Removed hard `y.max=100` on CPU/RAM charts; Chart.js auto-scales Y axis

### Fixed
- Dashboard perf charts: low CPU/RAM values (2-5%) were invisible due to fixed Y-axis max
- RAM info button on dashboard opened CPU modal instead of dedicated RAM modal

## [0.9.0] - 2026-03-31

### Added
- Security Self-Test module (`rusnas-sectest/`) with 9 OWASP Top 10 check modules and 47+ automated checks
- Security Self-Test orchestrator (`sectest.py`) with quick/full modes, JSON output, and scoring (0-100, Grade A-F)
- Monthly security scan timer (`rusnas-sectest.timer`, 1st of month at 04:00)
- Security card on dashboard with alert banner integration
- Manual penetration test report (`pentest-report-2026-03-31.md`)
- `install-sectest.sh` deploy script for pentest tools on VM
- Sidebar navigation redesign with 22 monochrome Heroicons (SVG via CSS `mask-image`)
- Collapsible navigation groups (4 groups: Storage, Data Protection, Infrastructure, Monitoring) in `eye.js`
- Real-time alert badges on nav groups (RAID degraded, Guard events, UPS on battery) polling every 30s
- Dashboard performance charts using Chart.js 4.x (CPU%, RAM%, Network, Disk I/O, IOPS, Latency)
- Period selector for dashboard charts (5 MIN / 15 MIN / 30 MIN / 1 HOUR / 24H)
- Detail and expand (full-screen) modals for dashboard chart cards
- Backend performance collector daemon (`perf-collector.py`) with 10-second sampling interval
- Performance history file (`/var/lib/rusnas/perf-history.json`) with 24h retention and automatic downsampling
- `install-perf-collector.sh` deploy script

### Changed
- Removed emoji icons from `manifest.json` navigation labels
- Dashboard sparkline cards replaced with Chart.js time-series graphs
- Established architecture rule: Cockpit = display only, never data collection (all metrics via backend daemons)

### Fixed
- ESC key now closes all modals (global handler in `eye.js`)
- Donut chart alignment in Storage Analyzer
- Radio button alignment in Disks page

## [0.8.0] - 2026-03-28

### Added
- Container Manager module (`containers.html`, `containers.js`, `container_api.py`) with 3-tab page (Catalog / Installed / Custom)
- 10-app catalog: Nextcloud, Immich, Jellyfin, Vaultwarden, Home Assistant, Pi-hole, WireGuard, Mailcow, OnlyOffice, Rocket.Chat
- Container Manager CGI backend with 16 commands including `check_ports` and `get_resources`
- Port conflict detection before container install with live availability indicator
- Resource preflight checks (RAM/disk) with soft blocking and force-install option
- Rocket.Chat 3-block nginx configuration for sub-path routing (API rewrite + WebSocket + SPA)
- Container dashboard widget showing running container count
- Container metrics in Prometheus endpoint (count by status, CPU/RAM per container)
- `install-containers.sh` deploy script and 68 comprehensive tests (17 CGI + 45 UI + 6 edge cases)
- RAID Backup Mode / HDD Spindown daemon (`rusnas-spind/`) with state machine (active/flushing/standby/waking)
- Spindown CGI interface (`spindown_ctl.py`) with 5 commands
- Backup Mode UI panel per RAID array in Disks page with sleep/wake controls
- `_warnIfSleeping()` guard blocking destructive operations on sleeping arrays
- 5 Prometheus metrics for spindown monitoring
- `install-spindown.sh` deploy script and 15 Playwright UI tests
- Storage Analyzer UI redesign: macOS-inspired window chrome with traffic lights, underline tabs, fill bar, squarified treemap
- Container Manager marketing section on landing page with architecture diagram and app catalog grid
- nginx as primary web server (:80/:443) replacing Apache on public ports
- `install-nginx-primary.sh` migration script
- `webservice.md` as authoritative web services architecture document

### Changed
- Apache moved to internal-only 127.0.0.1:8091 (WebDAV only)
- Container nginx proxy configs now in `/etc/nginx/conf.d/rusnas-apps/` (was `/var/lib/rusnas-containers/nginx-apps/`)
- Container image storage moved to `/mnt/data/containers/storage` (was on root disk)
- Podman runs as root (rootless had D-Bus/aardvark-dns issues on Debian 13/QEMU)

### Fixed
- `get_catalog` API now merges individual app manifests from `rusnas-app.json` (was returning only index.json fields)
- Rocket.Chat: upgraded to MongoDB 8.0+ (was incompatible with MongoDB 6.x)
- Rocket.Chat: `network_mode: host` workaround for aardvark-dns single-bridge limitation
- Rocket.Chat: Site_Url in MongoDB now updated alongside ROOT_URL env var
- Container uninstall now runs `podman image prune -af` to reclaim disk space
- `escHtml` not defined in storage-analyzer.js scope due to Cockpit iframe sandbox isolation (BUG-31)
- `podman-compose logs --no-color` crash (flag not supported in this version)

## [0.7.0] - 2026-03-26

### Added
- License Server (`rusnas-license-server/`) with FastAPI, Ed25519 cryptography, and 22 passing tests
- Bootstrap installer (`bootstrap.sh`) for one-command rusNAS installation
- Cockpit License Page (`license.html`) with Ed25519 WebCrypto offline activation
- Apt-auth service (port 8766) with 180-day grace period
- VPS nginx configuration (`vps-setup/nginx-rusnas.conf`)
- Web admin UI for license management (Jinja2 server-rendered, 6 templates)
- Customer activation portal (`static/activate.html`)
- CLI operator tool (`admin.py`) for serial/license management
- Ghost Pill sidebar navigation (Linear/Vercel/shadcn style) replacing flat rectangular blocks
- Unified UI components in `style.css`: toast notifications, skeleton loading, live dots, stagger animations, status cards
- Page entry animation (body > * page-in keyframe)
- Light theme enterprise redesign: deeper background, stronger borders, section blue accent bars

### Changed
- Sidebar nav uses `[aria-current="page"]` selector instead of `[aria-current]` to fix PF6 cascade bug
- Storage Analyzer tabs changed from Bootstrap `nav-tabs` to `advisor-tabs` pattern (required for Cockpit v300+)
- Section headings now uppercase with letter-spacing for enterprise appearance

### Fixed
- CSS cascade bug: `--pf-v6-c-nav__link--m-current--BackgroundColor` was cascading to all nav items via CSS inheritance
- Orange link color leaking from login branding into Cockpit shell sidebar
- Missing `<meta name="color-scheme">` in network.html and storage-analyzer.html
- Broken `cockpit.css` imports removed from network.html and storage-analyzer.html
- Mobile 480px breakpoint added to `ai.css`

## [0.6.0] - 2026-03-24

### Added
- Performance Tuner page (`performance.html`) with 12 optimization levels (vm.*, I/O scheduler, read-ahead, mdadm stripe_cache, Btrfs mount options, network sysctl, NIC ethtool, Samba, NFS threads, CPU governor, IRQ balancing, TuneD)
- Night Report dashboard widget showing 8-hour infrastructure summary with Health Score (0-100)
- Night Report: 5 stat cards (incidents, snapshots, CPU peak, network, SMART) and 3 detail columns
- `btrfs-problems.md` documenting 15 known Btrfs+mdadm issues with solutions
- Full regression test suite (9/9 pages pass)

### Changed
- Dashboard `tickFast()` optimized: 4 separate `cockpit.spawn()` calls batched into 1 bash spawn with `===M===` separator
- `visibilitychange` listener pauses all polling when browser tab is hidden
- Performance Tuner writes via `cockpit.file(path, {superuser:"require"}).replace()` instead of `sysctl -w` (no sudoers needed)

### Fixed
- `sysctl -w` via `sudo -n` failed (not in NOPASSWD sudoers) — replaced with `writeSysFile()` (BUG-18)
- `escHtml(null)` caused TypeError — now uses `String(s || "").replace(...)` (BUG-19)
- Race condition: multiple `setInterval` when opening CPU modal rapidly — `clearInterval` before new interval (BUG-20)
- vnstat data fetched on every modal open — added 60s cache (BUG-21)
- `setInterval` without saving ID caused timer leaks (BUG-22)
- Performance Tuner apply button did not work — switched to `sysctlPath()` + `writeSysFile()` (BUG-23)

## [0.5.0] - 2026-03-22

### Added
- Network module page (`network.html`) with 6 tabs: Interfaces, DNS & Hosts, Routes, Diagnostics, Certificates, Domain
- Network backend (`network-api.py`) for `/etc/network/interfaces` management
- Certificates backend (`certs-api.py`) with Let's Encrypt, self-signed, and imported certificate support
- Daily certificate auto-renewal check (`rusnas-certcheck.timer`)
- Domain Services tab with Active Directory member mode (realm join/leave) and Domain Controller mode (Samba AD DC)
- Domain backend (`domain-api.py`) with 35 commands for both AD modes
- Network auto-revert safety mechanism (90-second commit-to-revert pattern for IP/gateway changes)
- Safety modal for critical network changes (DHCP/Static mode, IP, gateway)
- MCP AI Server (`mcp-api.py`) with 11 NAS management commands
- AI Assistant page (`ai.html`) with multi-provider support (YandexGPT + Anthropic Claude)
- AI tool calling loop with parallel execution via `Promise.all()`
- openEYE Agent (`eye.js`) for automatic page analysis via AI sidebar panel
- SMART data display via proper sudoers NOPASSWD for `smartctl`
- Snapshot replication infographic in Replication tab with flow diagram and quick-start guide
- Snapshot replication scheduled via `rusnas-snapd.service` second ExecStart
- iSCSI architectural redesign: separate LUN Manager and Target Manager (Synology DSM style)
- iSCSI reads from structured `saveconfig.json` instead of text-parsing `targetcli ls /`
- Button to find unregistered `.img` files for iSCSI backstores
- RAID 1-to-5 upgrade support in addition to existing 5-to-6
- Array dependency scanning before RAID deletion (cleans SMB/NFS shares and snapshot schedules)
- Stale share indicators in Storage page (red path, opacity reduction for missing directories)
- Offline subvolume warnings in Snapshots page

### Changed
- All AI API calls routed through `mcp-api.py` on VM to bypass browser CORS restrictions
- Dashboard SMB card checks both `smbd` and `samba-ad-dc` services for correct DC mode status
- Guard auto-starts detector on daemon launch (`auto_start: true` default)

### Fixed
- Guard daemon crash: `get_iops()` method did not exist on Detector object
- Guard daemon crash: `InotifyTrees` threw FileNotFoundError on non-existent paths
- TX speed always showed 0 B/s — `/proc/net/dev` regex captured wrong column (RX_multicast instead of TX_bytes)
- Snapshot widget showed inflated count from stale test paths — cross-referenced with schedule list
- Network monitor vnstat JSON keys were wrong (`traffic.days` should be `traffic.day`)
- DC mode: missing `dc-stop`/`dc-start`/`dc-deprovision` commands in `domain-api.py`
- DC mode: smb.conf corrupted after provision — added `smb.conf.pre-dc` backup/restore
- `allow-hotplug` duplication in `/etc/network/interfaces` caused VM to become unreachable
- iSCSI `saveconfig.json` path was `/etc/rtslib-fb-target/` not `/etc/target/`
- Storage Analyzer `classify_ext` import from nonexistent module — moved inline
- Storage Analyzer `cmd_files` timeout on large directories with `du -sb` — switched to `os.walk` for filtered views

## [0.4.0] - 2026-03-19

### Added
- Storage page redesign with 4 tabs: Shares, iSCSI, WORM, Services (Synology DSM-inspired)
- Unified Share Modal (`#share-modal`) with internal tabs (Basic / SMB / NFS) replacing 4 separate modals
- Service status bar (SMB/NFS active indicators) above shares table
- Merged SMB + NFS shares into single table by path with protocol badges
- FileBrowser Quantum integration (v2.31.2) at `/files/` via Apache proxy
- FileBrowser user sync from Cockpit Users page (fire-and-forget pattern)
- FileBrowser dashboard widget and deep-links from Storage Analyzer
- FileBrowser deploy script (`install-filebrowser.sh`)
- SSD caching via LVM dm-cache in Disks page with add/change-mode/remove modals
- SSD tier status display with cache hit rate, usage progress bars, and mode badges
- `install-ssd-tier.sh` deploy script
- Guard: SMB bait file hiding (`hide files = /!~rng_*/` in smb.conf global section)
- UI redesign: new color system (Slate-based light + deep navy dark), pill-style tabs, card hover effects, modal animations
- CPU Monitor Modal on dashboard with per-core bars, memory bars, load grid, and top-12 processes
- Network Monitor Modal with vnstat integration (7-day and 24-hour bar charts, monthly stats)
- Landing page with marketing sections (features, specs, comparison with Synology/QNAP/TrueNAS)
- Cockpit login branding (dark theme with rusNAS logo)
- Storage Analyzer page (`storage-analyzer.html`) with 5 tabs: Overview, Shares, Files, Users, File Types
- Squarified treemap, donut chart, SVG fill chart, and sparkline algorithms in JS
- Storage backend collector (`storage-collector.py`) with hourly systemd timer
- Storage API (`storage-analyzer-api.py`) with 7 commands
- `install-storage-analyzer.sh` deploy script
- Full `ui.md` design system documentation

### Changed
- `app.js` refactored: separate parse functions (`parseSmbConf`, `parseNfsExports`) returning Promises
- `loadVolumeSelects()` now accepts `targetId` parameter instead of hardcoded element IDs
- Lazy loading for WORM and Services tabs (`_tabsLoaded` guards)
- Dashboard Storage card click navigates to Storage Analyzer (was Disks)

### Fixed
- Dashboard variables (`prevCpu`, `prevNet`, `prevDisk`, `smartCache`, timing constants) were deleted in previous refactor — restored
- Dark mode CSS variables in dashboard (used nonexistent variable names with light fallbacks)
- Light theme: card shadows and row hover barely visible — strengthened shadows and contrast

## [0.3.0] - 2026-03-15

### Added
- Dashboard page (`dashboard.html`) with Identity Bar, Storage/RAID/Disks/Shares cards, CPU/RAM/Net sparklines, Disk I/O, Events, Snapshots, Guard widget
- Metrics Server (`metrics_server.py`) on port 9100 with Prometheus and JSON endpoints
- `rusnas-metrics-install.sh` deploy script
- Deduplication page (`dedup.html`) with status cards, SVG infographic, 7-day history chart, FAQ accordion
- Dedup settings: schedule (time + days), volume config, SMB vfs_btrfs per-share toggle, advanced duperemove params
- Dedup backend (`rusnas-dedup-run.sh`) wrapping duperemove with state and history JSON files
- `install-dedup.sh` deploy script
- UPS/NUT page (`ups.html`) with 4 tabs: Status, Configuration, Protection, Journal
- UPS dashboard widget in grid-4 with charge progress bar and status indicators
- `install-ups.sh` deploy script with NUT 2.8.1 and sudoers
- UPS notify script (`rusnas-ups-notify.sh`) for Telegram + email + syslog
- FTP settings section on Storage page (vsftpd config management)
- WebDAV settings section on Storage page (Apache config + htdigest user management)
- Guard page restructured into 3 tabs: Overview, Event Log, Settings
- Guard event log: filters (type, status, date range), pagination (25/page), CSV export, clear journal
- Guard path discovery modal (shows available Btrfs volumes and SMB shares)
- Snapshot sidebar UX redesign with global statistics strip and left panel navigation
- Snapshot tree view for nested subvolumes with expand/collapse
- Snapshot offline volume detection and grouping
- Snapshot `storage-info` CLI command for aggregated statistics
- Snapshot replication feature: CLI commands (`replication set/list/delete/run/check-ssh`), UI tab, btrfs send/receive over SSH
- Dark mode fix for Dashboard CSS variables
- Mobile responsive CSS for all pages (viewport meta, breakpoints at 768px and 480px)
- MCP/AI technical specification (`rusnas_mcp_ai.MD`)

### Changed
- Guard polling interval reduced from 5s to 10s with `_statusPending` lock to prevent parallel requests
- Guard `get_events` now sequential (after status response)
- Guard pauses timers on hidden browser tab (`visibilitychange`)
- `loadShares()` now uses `python3` + `testparm -s` for accurate SMB path parsing (BUG-05)
- Dashboard grid updated from 3 to 4 columns in bottom section (added UPS card)

### Fixed
- Guard daemon IOPS counter always showed 0 — `_root_path()` normalizes subdirectory to root path from config
- Guard socket permissions: changed from 0o660 to 0o666, `RuntimeDirectoryMode` from 0750 to 0755
- Guard `/etc/rusnas-guard/` permissions: changed from 700 to 755 for Cockpit bridge access
- Guard daemon crash: `get_iops()` method didn't exist, `InotifyTrees` FileNotFoundError on missing paths
- Guard PIN reset (`--reset-pin`) was missing from deployed daemon on VM (BUG-03)
- Dashboard `card-snaps` null reference TypeError (BUG-13)
- Dashboard Disks block not rendering (ls exit code 1 when no nvme devices)
- NFS empty file grep exit code 1 caused error display (BUG-04)
- SMB share paths were hardcoded instead of read from smb.conf (BUG-05)
- WebDAV path showed trailing `>` from Apache config regex
- Snapshot schedule modal not pre-filling currentSubvol
- Snapshot events tab not filtering by currentSubvol
- Browse modal click-through overlay activating buttons underneath (BUG-06)
- SMB large file upload from macOS: added `vfs objects = catia fruit streams_xattr` for correct free space reporting
- duperemove v0.11.2: removed unsupported `--min-size` and `--hash` flags
- Dedup status stuck on "Running" after completion
- WORM "Select" button had no event listener registered

## [0.2.0] - 2026-03-14

### Added
- RAID Full Lifecycle UI: Create (2-step wizard), Delete (with disk list confirmation), Mount, Unmount, Btrfs Subvolumes
- Mount status display on RAID array cards
- RAID level upgrade support (RAID 5 to 6) with free disk selector and reshape warning
- Guard daemon (`rusnas-guard/`) with 4 detection methods: Honeypot, Entropy, IOPS anomaly, Extensions
- Guard 3 response modes: Monitor, Active (snapshot + block IP + disable SMB), Super-Safe (snapshot all + shutdown)
- Guard PIN authentication (bcrypt hash, independent of Cockpit admin password)
- Guard PIN reset via `rusnas-guard --reset-pin` (root/SSH only)
- Snapshots system: CLI (`rusnas-snap`) with SQLite DB, Smart Retention (5 windows), systemd timer (5 min)
- Snapshots Cockpit UI with 3 tabs: Snapshots / Schedule / Event Log
- Snapshot browse: read-only bind mount + temporary SMB share with Windows/macOS path display
- Btrfs subvolume integration in share creation dropdown (optgroup with subvolumes)
- Snapshot sizes computed at creation time via `du -sb`
- Apt hook for automatic pre-upgrade snapshots

### Changed
- `cockpit.spawn().then()` wrapped in `new Promise()` for `Promise.all()` compatibility
- Subvolume discovery via `btrfs subvolume list` instead of bash (bash not in NOPASSWD sudoers)

### Fixed
- smb.conf editing: Python regex replaced with reliable `sed` range pattern
- NFS entry duplication: `sed` delete before append in `/etc/exports`
- iSCSI targetcli not executing: added explicit `sudo` in `cockpit.spawn()`
- Subvolume list showed snapshots: added `.snapshots` path filtering
- Delete subvolume button not working: replaced `data-subvol` (special chars) with `data-idx` (array index)
- Snapshot `cmd_create` returned `size_bytes = 0`: added `get_snap_size()` call after creation

## [0.1.0] - 2026-03-13

### Added
- Cockpit plugin `rusnas` with `manifest.json` and CSP configuration
- Storage page (`index.html`, `app.js`): SMB share management (create/edit/delete), NFS exports, iSCSI targets via targetcli
- Disks and RAID page (`disks.html`, `disks.js`): `/proc/mdstat` parser with active/degraded/inactive/resyncing/reshaping states, SMART info via smartctl, safe disk removal with serial number confirmation
- Users page (`users.html`, `users.js`): user and group management
- Deploy script (`deploy.sh`): scp + sudo cp + chmod workflow
- Dark mode support with CSS custom properties and `@media (prefers-color-scheme: dark)`
- `ui.md` design guidelines document
- Volume path dropdown via `findmnt --real` (no hardcoded paths)
- Git repository initialization with proper project structure

### Fixed
- Incorrect path to `cockpit.js` (must be `../base1/cockpit.js`)
- CSP blocking JS execution: added `unsafe-inline` and `unsafe-eval` to `manifest.json`
- Inline event handlers forbidden by CSP: migrated all to `addEventListener`
- Users page hung on "Loading": missing `DOMContentLoaded` listener, undefined `showModal`/`closeModal`, no `.fail()` on spawn calls
