# Documentation Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize RusNAS documentation into a clean `docs/` hub with specs, ADR, plans, designs; add ROADMAP/BACKLOG/CHANGELOG; slim CLAUDE.md from 70K to ~25K chars.

**Architecture:** Move 18 spec files from root to `docs/specs/`, move plans/designs from `docs/superpowers/` to `docs/plans/` and `docs/designs/`, create 4 new root files (ROADMAP, BACKLOG, CHANGELOG) and 7 ADR docs, rewrite CLAUDE.md as compact navigator.

**Tech Stack:** git mv for history-preserving moves, markdown files

---

## File Map

### Create
- `docs/specs/` (directory)
- `docs/adr/` (directory)
- `docs/plans/` (directory)
- `docs/designs/` (directory)
- `docs/adr/001-btrfs-over-zfs.md`
- `docs/adr/002-podman-over-docker.md`
- `docs/adr/003-dm-cache-over-bcache.md`
- `docs/adr/004-ifupdown-over-networkmanager.md`
- `docs/adr/005-cockpit-over-custom-webui.md`
- `docs/adr/006-mdadm-raid-f1.md`
- `docs/adr/007-nut-over-apcupsd.md`
- `ROADMAP.md`
- `BACKLOG.md`
- `CHANGELOG.md`

### Move (git mv)
- 18 root spec files → `docs/specs/<short-name>.md`
- `btrfs-problems.md` → `docs/specs/btrfs-problems.md`
- `pentest-report-2026-03-31.md` → `docs/specs/pentest-report.md`
- 8 files from `docs/superpowers/plans/` → `docs/plans/`
- 4 files from `docs/superpowers/specs/` → `docs/designs/`

### Modify
- `CLAUDE.md` — full rewrite (~25K target)
- `docs/build-docs.sh` — update spec source paths
- `docs/mkdocs.yml` — update nav spec paths

### Delete
- `docs/superpowers/` (empty after moves)
- `roadmap.md` (replaced by ROADMAP.md)

---

### Task 1: Create directories and move spec files

**Files:**
- Create: `docs/specs/`, `docs/adr/`, `docs/plans/`, `docs/designs/`
- Move: 20 root files → `docs/specs/`

- [ ] **Step 1: Create target directories**

```bash
mkdir -p docs/specs docs/adr docs/plans docs/designs
```

- [ ] **Step 2: git mv all spec/task files from root to docs/specs/**

```bash
git mv rusnas-guard-task.md docs/specs/guard.md
git mv rusnas-snapshots-spec.md docs/specs/snapshots.md
git mv rusnas-RAIDmanager.md docs/specs/raid-manager.md
git mv rusnas-dedup-spec.md docs/specs/dedup.md
git mv rusnas-ups-nut_spec.md docs/specs/ups.md
git mv rusnas-storage-analyzer-task.md docs/specs/storage-analyzer.md
git mv rusnas-storage-task.md docs/specs/storage-redesign.md
git mv rusnas-ssd-tier-task.md docs/specs/ssd-cache.md
git mv rusnas-network-task.md docs/specs/network.md
git mv rusnas-filebrowser-task.md docs/specs/filebrowser.md
git mv rusnas-container-manager-spec.md docs/specs/containers.md
git mv rusnas_mcp_ai.MD docs/specs/mcp-ai.md
git mv rusnas-performance-tuning-spec.md docs/specs/performance.md
git mv rusnas-license-server-task.md docs/specs/license-server.md
git mv rusnas-dashboard-spec.md docs/specs/dashboard.md
git mv rusnas-domain-task.md docs/specs/domain.md
git mv rusnas-storage-agent-task.md docs/specs/storage-agent.md
git mv rusnas-mcp-ai-impl.md docs/specs/mcp-ai-impl.md
git mv btrfs-problems.md docs/specs/btrfs-problems.md
git mv pentest-report-2026-03-31.md docs/specs/pentest-report.md
```

- [ ] **Step 3: Verify all 20 files moved**

```bash
ls docs/specs/ | wc -l
# Expected: 20
ls docs/specs/
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: move 20 spec/task files from root to docs/specs/"
```

---

### Task 2: Move superpowers plans and designs

**Files:**
- Move: `docs/superpowers/plans/*.md` → `docs/plans/`
- Move: `docs/superpowers/specs/*.md` → `docs/designs/`
- Delete: `docs/superpowers/` (empty)

- [ ] **Step 1: git mv plan files**

```bash
git mv docs/superpowers/plans/2026-03-26-bootstrap-installer.md docs/plans/
git mv docs/superpowers/plans/2026-03-26-build-pipeline.md docs/plans/
git mv docs/superpowers/plans/2026-03-26-cockpit-license-page.md docs/plans/
git mv docs/superpowers/plans/2026-03-26-license-server.md docs/plans/
git mv docs/superpowers/plans/2026-03-28-container-manager.md docs/plans/
git mv docs/superpowers/plans/2026-03-28-raid-backup-mode.md docs/plans/
git mv docs/superpowers/plans/2026-04-03-demo-release.md docs/plans/
git mv docs/superpowers/plans/2026-04-04-notification-system.md docs/plans/
```

- [ ] **Step 2: git mv design spec files**

```bash
git mv docs/superpowers/specs/2026-03-26-distribution-licensing-design.md docs/designs/
git mv docs/superpowers/specs/2026-04-03-demo-release-design.md docs/designs/
git mv docs/superpowers/specs/2026-04-04-notification-system-design.md docs/designs/
git mv docs/superpowers/specs/2026-04-05-documentation-restructure-design.md docs/designs/
```

- [ ] **Step 3: Remove empty superpowers directory**

```bash
rmdir docs/superpowers/specs docs/superpowers/plans docs/superpowers
```

- [ ] **Step 4: Also move THIS plan file to new location**

```bash
git mv docs/superpowers/plans/2026-04-05-documentation-restructure.md docs/plans/ 2>/dev/null || true
```

Note: This file was already moved in step 1 above.

- [ ] **Step 5: Verify**

```bash
ls docs/plans/ | wc -l   # Expected: 9 (8 old + this plan)
ls docs/designs/ | wc -l  # Expected: 4
test -d docs/superpowers && echo "FAIL: superpowers still exists" || echo "OK: superpowers removed"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: move plans and designs from superpowers/ to docs/plans/ and docs/designs/"
```

---

### Task 3: Create ROADMAP.md

**Files:**
- Create: `ROADMAP.md`
- Delete: `roadmap.md` (content migrated)

- [ ] **Step 1: Read current roadmap.md to extract data**

Read `roadmap.md` to get the list of completed features with dates and branches.

- [ ] **Step 2: Create ROADMAP.md with prioritized structure**

Create `ROADMAP.md` with:
- Priority legend (P0-P3)
- ✅ Выполнено table (data from roadmap.md + CLAUDE.md roadmap table)
- 🔧 В работе table (currently active features)
- 📋 Планируется table (future features from roadmap.md)

- [ ] **Step 3: git rm old roadmap.md**

```bash
git rm roadmap.md
```

- [ ] **Step 4: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: replace roadmap.md with prioritized ROADMAP.md"
```

---

### Task 4: Create CHANGELOG.md

**Files:**
- Create: `CHANGELOG.md`

- [ ] **Step 1: Read project_history.md for version data**

Read `project_history.md` to extract session dates and changes for grouping into versions.

- [ ] **Step 2: Create CHANGELOG.md in Keep a Changelog format**

Group changes from project_history.md into logical versions:
- [Unreleased] section for current work
- [0.9.0] - 2026-03-31: Security, Perf Charts, Sidebar
- [0.8.0] - 2026-03-28: Containers, RAID Backup Mode
- [0.7.0] - 2026-03-26: License Server, Bootstrap, UI Cohesion
- [0.6.0] - 2026-03-24/25: Performance Tuner, Night Report, Regression Testing
- [0.5.0] - 2026-03-22/23: Network, MCP AI, Snapshots Replication
- [0.4.0] - 2026-03-19/21: Storage Redesign, FileBrowser, SSD Cache
- [0.3.0] - 2026-03-15/17: Dashboard, Dedup, UPS, SSD Tier
- [0.2.0] - 2026-03-14: RAID lifecycle, Guard, Snapshots
- [0.1.0] - 2026-03-13: Initial Cockpit plugin, basic pages

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG.md with retrospective version history"
```

---

### Task 5: Create BACKLOG.md

**Files:**
- Create: `BACKLOG.md`

- [ ] **Step 1: Create BACKLOG.md with initial ideas and tech debt**

Seed from unimplemented items in roadmap.md + known improvement areas:

Ideas:
- HA / Clustering
- S3-compatible storage (MinIO)
- LDAP / FreeIPA
- Mobile app
- Grafana dashboards integration
- Automated backup verification
- Two-factor auth for Cockpit

Tech debt:
- Refactor app.js (2000+ lines)
- E2E Playwright tests for all pages
- Python type hints for all backends
- Unified error handling across JS modules
- cockpit.spawn Promise wrapper utility

- [ ] **Step 2: Commit**

```bash
git add BACKLOG.md
git commit -m "docs: add BACKLOG.md with feature wishlist and tech debt"
```

---

### Task 6: Create ADR documents

**Files:**
- Create: 7 files in `docs/adr/`

- [ ] **Step 1: Create all 7 ADR files**

Each ADR follows MADR format: Status, Context, Decision, Consequences.

Files:
- `docs/adr/001-btrfs-over-zfs.md` — ZFS lacks online RAID migration
- `docs/adr/002-podman-over-docker.md` — Rootless, no daemon SPOF, Debian 13 native
- `docs/adr/003-dm-cache-over-bcache.md` — bcache unsafe with Btrfs writeback
- `docs/adr/004-ifupdown-over-networkmanager.md` — Predictable on servers, no D-Bus dependency
- `docs/adr/005-cockpit-over-custom-webui.md` — Existing ecosystem, iframe plugins, SSH transport
- `docs/adr/006-mdadm-raid-f1.md` — Near-line parity for backup HDDs
- `docs/adr/007-nut-over-apcupsd.md` — Broader UPS model support, network mode

- [ ] **Step 2: Commit**

```bash
git add docs/adr/
git commit -m "docs: add 7 architecture decision records (ADR)"
```

---

### Task 7: Add Implementation Notes to spec files

**Files:**
- Modify: 12 files in `docs/specs/`

- [ ] **Step 1: Read CLAUDE.md inline module documentation**

Extract Implementation Notes content for each module from CLAUDE.md:
- Guard, Snapshots, Dedup, UPS, Storage Analyzer, Performance, Dashboard, Containers, Notifications, RAID Backup Mode, FTP/WebDAV, Guard event log

- [ ] **Step 2: Append Implementation Notes section to each spec file**

For each of the 12 spec files that have inline docs in CLAUDE.md:
- Add `## Implementation Notes` section at end
- Add `## Known Issues` section if module-specific bugs exist
- Content is copied verbatim from CLAUDE.md (proven accurate)

- [ ] **Step 3: Create docs/specs/notifications.md (new file)**

This module had no separate spec file — create one from CLAUDE.md inline docs.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/
git commit -m "docs: add Implementation Notes sections to all spec files from CLAUDE.md"
```

---

### Task 8: Rewrite CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read current CLAUDE.md fully**

Read the entire file to identify all sections and their content.

- [ ] **Step 2: Write new CLAUDE.md (~25K chars)**

Structure:
1. Header with navigation links (updated paths)
2. Правила размещения документов (NEW — for skills)
3. Правила обновления файлов (updated table)
4. Обязательное обновление после merge (updated, CHANGELOG first)
5. Project Overview + Technical Stack
6. Development Environment
7. Deploy/Update Workflow
8. Project Structure (tree only, no descriptions)
9. Модули quick-reference (NEW — table with links + main trap)
10. Cockpit Plugin Rules
11. Development Rules
12. Development Patterns
13. Known Bugs (CUT to 15 most dangerous)
14. Mobile/Responsive CSS Rules
15. Distribution Infrastructure
16. Git Workflow (3 lines + link)
17. Documentation build (shortened)
18. Roadmap (compact status table)

ALL module inline docs REMOVED (already in docs/specs/).

- [ ] **Step 3: Verify size**

```bash
wc -c CLAUDE.md
# Target: ≤ 30,000 characters
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: rewrite CLAUDE.md as compact navigator (~25K chars, was 70K)"
```

---

### Task 9: Update build system

**Files:**
- Modify: `docs/build-docs.sh`
- Modify: `docs/mkdocs.yml`

- [ ] **Step 1: Read current build-docs.sh**

Identify step [2/5] that copies specs from root.

- [ ] **Step 2: Update build-docs.sh spec copy paths**

Change source from root `rusnas-*-task.md` / `rusnas-*-spec.md` to `docs/specs/*.md`.

- [ ] **Step 3: Read and update docs/mkdocs.yml**

Update nav section paths for Module Specifications to reference new docs/specs/ location.

- [ ] **Step 4: Commit**

```bash
git add docs/build-docs.sh docs/mkdocs.yml
git commit -m "docs: update build system for new docs/specs/ paths"
```

---

### Task 10: Final verification and cleanup

- [ ] **Step 1: Verify no spec files remain in root**

```bash
ls rusnas-*-task.md rusnas-*-spec.md rusnas_*.MD btrfs-problems.md pentest-report-*.md 2>/dev/null
# Expected: No such file or directory (all moved)
```

- [ ] **Step 2: Verify superpowers directory removed**

```bash
test -d docs/superpowers && echo "FAIL" || echo "OK"
# Expected: OK
```

- [ ] **Step 3: Verify no stale references**

```bash
git grep 'docs/superpowers' -- '*.md' | grep -v CHANGELOG | grep -v project_history | head -20
# Expected: 0 results (or only in history files)

git grep 'rusnas-guard-task\|rusnas-dedup-spec\|rusnas-ups-nut_spec' -- CLAUDE.md
# Expected: 0 results
```

- [ ] **Step 4: Check CLAUDE.md size**

```bash
wc -c CLAUDE.md
# Expected: ≤ 30,000
```

- [ ] **Step 5: Verify all new files exist**

```bash
ls ROADMAP.md BACKLOG.md CHANGELOG.md
ls docs/specs/ | wc -l     # Expected: 21 (20 moved + 1 new notifications.md)
ls docs/adr/ | wc -l       # Expected: 7
ls docs/plans/ | wc -l     # Expected: 9
ls docs/designs/ | wc -l   # Expected: 4
```

- [ ] **Step 6: Verify all links in CLAUDE.md resolve**

```bash
grep -oP '\./docs/specs/[a-z-]+\.md' CLAUDE.md | while read f; do
  test -f "$f" && echo "OK: $f" || echo "BROKEN: $f"
done
```

- [ ] **Step 7: Final commit if any cleanup needed**

```bash
git status
# If clean: done
# If changes: git add -A && git commit -m "docs: final cleanup after restructure"
```
