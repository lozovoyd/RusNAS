# Documentation Restructure — "docs/ hub" Design

## Context

RusNAS documentation has grown organically over 30+ development sessions into a scattered collection of 34+ root-level .md files. CLAUDE.md has ballooned to 70K chars (175% of its stated 40K target) by inlining module documentation that belongs in separate files. There is no proper roadmap with priorities, no backlog for future ideas, no versioned changelog, and no architecture decision records. Skills (brainstorming, writing-plans) default to `docs/superpowers/specs/` and `docs/superpowers/plans/` which doesn't match the desired hierarchy.

**Problem statement:** Documentation is hard to maintain, prone to going stale, and lacks several essential categories (roadmap, backlog, changelog, ADR). Every new module makes CLAUDE.md larger without improving discoverability.

**Intended outcome:** A clean, taxonomized `docs/` hub where every document type has a defined home, CLAUDE.md is a compact navigator (~25K chars) with rules and traps, and governance rules ensure docs stay current after every merge.

## Architecture: New File Layout

```
RusNAS/
├── CLAUDE.md               # ~25K: rules, patterns, traps, links (compact navigator)
├── README.md               # Unchanged
├── ROADMAP.md              # NEW: prioritized roadmap (P0-P3)
├── BACKLOG.md              # NEW: wishlist / someday ideas
├── CHANGELOG.md            # NEW: versioned changelog (Keep a Changelog)
├── project_history.md      # Unchanged (append-only session log)
├── bugs.md                 # Unchanged (full BUG-NN history)
├── git-workflow.md         # Unchanged
├── ui.md                   # Unchanged
├── webservice.md           # Unchanged
│
├── docs/
│   ├── specs/              # MOVED: all module specs (from root rusnas-*-task/spec.md)
│   │   ├── guard.md
│   │   ├── snapshots.md
│   │   ├── raid-manager.md
│   │   ├── dedup.md
│   │   ├── ups.md
│   │   ├── storage-analyzer.md
│   │   ├── storage-redesign.md
│   │   ├── ssd-cache.md
│   │   ├── network.md
│   │   ├── filebrowser.md
│   │   ├── containers.md
│   │   ├── mcp-ai.md
│   │   ├── performance.md
│   │   ├── license-server.md
│   │   ├── dashboard.md
│   │   ├── domain.md
│   │   ├── storage-agent.md
│   │   ├── notifications.md
│   │   ├── btrfs-problems.md
│   │   ├── mcp-ai-impl.md
│   │   └── pentest-report.md
│   │
│   ├── adr/                # NEW: Architecture Decision Records
│   │   ├── 001-btrfs-over-zfs.md
│   │   ├── 002-podman-over-docker.md
│   │   ├── 003-dm-cache-over-bcache.md
│   │   ├── 004-ifupdown-over-networkmanager.md
│   │   ├── 005-cockpit-over-custom-webui.md
│   │   ├── 006-mdadm-raid-f1.md
│   │   └── 007-nut-over-apcupsd.md
│   │
│   ├── plans/              # MOVED from docs/superpowers/plans/
│   │   ├── 2026-03-26-bootstrap-installer.md
│   │   ├── 2026-03-26-build-pipeline.md
│   │   ├── 2026-03-26-cockpit-license-page.md
│   │   ├── 2026-03-26-license-server.md
│   │   ├── 2026-03-28-container-manager.md
│   │   ├── 2026-03-28-raid-backup-mode.md
│   │   ├── 2026-04-03-demo-release.md
│   │   └── 2026-04-04-notification-system.md
│   │
│   ├── designs/            # MOVED from docs/superpowers/specs/
│   │   ├── 2026-03-26-distribution-licensing-design.md
│   │   ├── 2026-04-03-demo-release-design.md
│   │   ├── 2026-04-04-notification-system-design.md
│   │   └── 2026-04-05-documentation-restructure-design.md
│   │
│   ├── src/                # Unchanged — MkDocs dev-docs source pages
│   ├── mkdocs.yml          # Unchanged — MkDocs config
│   │
│   ├── build-docs.sh       # Updated paths (spec source dir changed)
│   ├── build-guide.md
│   ├── jsdoc.json
│   ├── release-file-map.md
│   └── requirements-docs.txt
│
├── user-docs/              # Unchanged
├── cockpit/                # Unchanged
└── ...
```

### Files that stay in root (and why)

| File | Reason |
|------|--------|
| `CLAUDE.md` | AI assistant entry point — must be at root |
| `README.md` | Standard project readme |
| `ROADMAP.md` | High visibility — first thing contributors see |
| `BACKLOG.md` | High visibility |
| `CHANGELOG.md` | Standard location per convention |
| `project_history.md` | Append-only session log, referenced by CLAUDE.md |
| `bugs.md` | Referenced by CLAUDE.md, needs fast access |
| `git-workflow.md` | Operational guide, referenced by CLAUDE.md |
| `ui.md` | Must-read for UI work, referenced by CLAUDE.md |
| `webservice.md` | Must-read for web work, referenced by CLAUDE.md |

### Files that move

20 spec files (`rusnas-*-task.md`, `rusnas-*-spec.md`, `btrfs-problems.md`, `pentest-report-*.md`) move from root to `docs/specs/` with short names.

8 plan files move from `docs/superpowers/plans/` to `docs/plans/`.

3 design files move from `docs/superpowers/specs/` to `docs/designs/`.

`docs/superpowers/` is removed entirely.

## New File Formats

### ROADMAP.md

```markdown
# RusNAS Roadmap

## Приоритеты
| Символ | Описание |
|--------|----------|
| 🔴 P0 | Критично — блокирует релиз |
| 🟠 P1 | Важно — следующий спринт |
| 🟡 P2 | Средне — в планах |
| ⚪ P3 | Низкий — когда будет время |

## ✅ Выполнено
| Модуль | Дата | Ветка | Описание |
|--------|------|-------|----------|
| Dashboard | 2026-03-15 | main | Метрики, Guard/RAID/Disk статус, Night Report |
| ... | | | |

## 🔧 В работе
| Модуль | Приоритет | Ветка | Описание | Spec |
|--------|-----------|-------|----------|------|
| ... | 🟠 P1 | feat/... | ... | [docs/specs/...](docs/specs/...) |

## 📋 Планируется
| Модуль | Приоритет | Описание | Spec |
|--------|-----------|----------|------|
| MCP Session 2 | 🟠 P1 | SSE transport, Ollama local | [docs/specs/mcp-ai.md](docs/specs/mcp-ai.md) |
```

Data migrated from current `roadmap.md`. Old `roadmap.md` deleted after migration.

### BACKLOG.md

```markdown
# RusNAS Backlog / Wishlist

Идеи без приоритета и сроков. Перемещаются в ROADMAP.md когда становятся актуальными.

## Идеи
- [ ] Кластеризация / HA (active-passive failover)
- [ ] S3-compatible object storage (MinIO)
- [ ] ...

## Технический долг
- [ ] Рефакторинг app.js (2000+ строк)
- [ ] E2E тесты Playwright для всех страниц
- [ ] ...
```

### CHANGELOG.md

[Keep a Changelog](https://keepachangelog.com/) format. Versions created retrospectively from `project_history.md`:

```markdown
# Changelog

All notable changes to RusNAS are documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

## [Unreleased]

## [0.9.0] - 2026-03-31
### Added
- Security Self-Test: 9 OWASP modules, 47+ checks, dashboard widget
- Dashboard perf charts: Chart.js 4.x + perf-collector daemon
- Sidebar redesign: Heroicons, collapsible groups, alert badges
### Fixed
- BUG-35: perf charts show full history
- BUG-36: RAM modal container

## [0.8.0] - 2026-03-28
### Added
- Container Manager: 10 app catalog, Podman integration
- RAID Backup Mode: HDD spindown, CGI control
...
```

`project_history.md` continues as append-only session log (detailed). CHANGELOG is the public-facing summary by version.

### docs/adr/NNN-title.md

[MADR](https://adr.github.io/madr/) format:

```markdown
# ADR-NNN: <Title>

## Статус
Принято / Отменено / Заменено ADR-XXX

## Контекст
What problem or question prompted this decision?

## Решение
What was decided and why.

## Последствия
- ✅ Positive consequence
- ⚠️ Trade-off
- ❌ Negative consequence (accepted)
```

Initial ADRs (7):
1. Btrfs + mdadm instead of ZFS (online RAID migration requirement)
2. Podman over Docker (rootless, no daemon SPOF)
3. dm-cache over bcache (unsafe with Btrfs writeback)
4. ifupdown over NetworkManager (predictability on server)
5. Cockpit over custom WebUI (existing ecosystem, iframe plugins)
6. mdadm RAID F1 support (near-line parity for backup disks)
7. NUT over apcupsd (broader UPS model support, network mode)

### docs/specs/<module>.md template

All migrated specs gain a unified header and `## Implementation Notes` section:

```markdown
# <Module Name>

> Статус: ✅ Реализован / 🔧 В работе / 📋 Планируется
> Ветка: main / feat/<name>
> Deploy: `./install-<module>.sh`

## Описание
(original spec content — 2-3 sentences)

## Архитектура
(original spec content — components, files, protocols)

## Ключевые решения
(why this approach, links to ADR)

## Implementation Notes
<!-- ОБНОВЛЯЕТСЯ Claude Code при каждом изменении модуля -->
(migrated from CLAUDE.md inline docs: config paths, sudoers, code patterns, JS notes)

## Known Issues
(module-specific bugs, migrated from CLAUDE.md inline notes)
```

## CLAUDE.md Restructure

### New size target: ≤ 25,000 characters (~350 lines)

### Sections that STAY (slimmed):

1. **Header links** — updated paths to `docs/specs/`, `docs/adr/`
2. **Правила размещения документов** — NEW table for skills/Claude Code (where to put plans, specs, ADR, etc.)
3. **Правила обновления файлов** — updated (CHANGELOG first in order)
4. **Обязательное обновление после merge** — updated table
5. **Project Overview** — keep as-is
6. **Technical Stack** — keep table
7. **Development Environment** — keep (VM addresses, deploy)
8. **Deploy/Update Workflow** — keep
9. **Project Structure** — SHORTENED to tree only (no file descriptions)
10. **Cockpit Plugin Rules** — keep (CSP, spawn, superuser)
11. **Development Rules** — keep (3 rules: Notify, Docs, certification)
12. **Development Patterns** — keep (Cockpit = display only, iterate, scp)
13. **Known Bugs** — CUT from 45 → 15 most dangerous traps
14. **Module quick-reference** — NEW: 2-line per module (link + main trap)
15. **Git Workflow** — 3 lines + link
16. **Distribution Infrastructure** — keep table
17. **Roadmap** — compact status table
18. **Documentation build** — shortened

### Sections that MOVE OUT:

All module inline documentation → `docs/specs/<module>.md` Implementation Notes:
- Guard (socket, PIN, daemon lifecycle, guard.js notes)
- Snapshots (CLI, DB, timer, replication)
- Dedup (config, dedup.js notes)
- UPS (NUT config, status flags, ups.js notes)
- Storage Analyzer (5 tabs, API, squarify)
- Performance Tuner (12 levels, writeSysFile)
- Dashboard (RAM Modal, Night Report)
- Container Manager (CGI, Podman, Rocket.Chat)
- Notification System (daemon, CLI, channels)
- RAID Backup Mode (spindown, CGI)
- FTP/WebDAV settings
- Guard page structure / event log

### New "Правила размещения документов" section:

```markdown
## Правила размещения документов (для Claude Code и skills)

| Тип документа | Путь | Формат имени |
|---------------|------|--------------|
| Спецификация модуля | `docs/specs/<module>.md` | Короткое имя: guard.md |
| Design spec (brainstorming) | `docs/designs/YYYY-MM-DD-<topic>.md` | С датой |
| Implementation plan | `docs/plans/YYYY-MM-DD-<topic>.md` | С датой |
| ADR | `docs/adr/NNN-<title>.md` | С номером |
| Новая фича в roadmap | `ROADMAP.md` | Строка в таблицу |
| Идея / wishlist | `BACKLOG.md` | Чекбокс в секцию |
| Новая версия | `CHANGELOG.md` | Keep a Changelog |
| Баг | `bugs.md` | BUG-NN секция |
| Сессионный лог | `project_history.md` | APPEND в конец |

> ⚠️ НЕ создавать файлы в docs/superpowers/ — deprecated
> ⚠️ НЕ создавать rusnas-*-task.md в корне — все спеки в docs/specs/
```

### New "Module quick-reference" section:

```markdown
## Модули (quick-reference)

> 🔍 Перед работой с модулем — ПРОЧИТАЙ его spec в docs/specs/<module>.md

| Модуль | Spec | Deploy | ⚠️ Главная ловушка |
|--------|------|--------|--------------------|
| Guard | [docs/specs/guard.md] | install-guard.sh | Socket 0o666, superuser НЕ в spawn |
| Snapshots | [docs/specs/snapshots.md] | install-snapshots.sh | schedule list НЕ принимает --json |
| Dedup | [docs/specs/dedup.md] | install-dedup.sh | duperemove v0.11.2 нет --min-size |
| UPS | [docs/specs/ups.md] | install-ups.sh | superuser НЕ в spawn — polkit timeout |
| Storage Analyzer | [docs/specs/storage-analyzer.md] | install-storage-analyzer.sh | classify_ext() инлайн в api |
| Performance | [docs/specs/performance.md] | deploy.sh | writeSysFile — без sudoers |
| Dashboard | [docs/specs/dashboard.md] | deploy.sh | tickFast batch spawn, ===M=== |
| Containers | [docs/specs/containers.md] | install-containers.sh | Podman root, aardvark-dns |
| Notifications | [docs/specs/notifications.md] | install-notify.sh | Socket 0o666, SQLite WAL |
| ... | | | |
```

## Build System Updates

### docs/build-docs.sh changes:
- Step [2/5] "Copy specification files": update source paths from root to `docs/specs/`
- Step [3/5] "Copy operational guides": unchanged (ui.md, bugs.md still in root)
- Remove any references to `docs/superpowers/`

### docs/mkdocs.yml changes:
- Update nav section "Module Specifications" to point to new paths
- No fundamental changes needed — build-docs.sh copies to `docs/src/specs/` at build time

## Governance: Post-Merge Update Rules

After every merge to `main`, update in this order:

| # | File | What to update |
|---|------|----------------|
| 1 | `CHANGELOG.md` | Added/Changed/Fixed under current version |
| 2 | `ROADMAP.md` | Move completed → ✅, add new → 📋 |
| 3 | `project_history.md` | APPEND session to end |
| 4 | `CLAUDE.md` | Only traps/links, NOT inline module docs |
| 5 | `docs/specs/<module>.md` | Update Implementation Notes if architecture changed |
| 6 | `bugs.md` | BUG-NN section for each new bug/fix |
| 7 | `ui.md` | If CSS/design system changed |

**Rule:** Don't ask user — just update. If changes were made, records must be written.

## Migration Safety

- All file moves use `git mv` to preserve history
- No content is deleted — only reorganized
- Old `roadmap.md` content split between ROADMAP.md (status tables) and CHANGELOG.md (version history)
- Broken link scan after migration: `git grep 'rusnas-.*-task\|rusnas-.*-spec\|docs/superpowers'`
- CLAUDE.md internal links all updated to new paths

## Verification Plan

1. `wc -c CLAUDE.md` ≤ 30,000 chars
2. All links in CLAUDE.md resolve (`docs/specs/*.md` exist)
3. `npm run docs` builds successfully
4. `ls docs/specs/` shows all 20 migrated spec files
5. `ls docs/adr/` shows 7 ADR files
6. `ls docs/plans/` shows 8 plan files (moved from superpowers)
7. `ls docs/designs/` shows 4 design files (moved from superpowers)
8. ROADMAP.md, BACKLOG.md, CHANGELOG.md exist and are populated
9. No `rusnas-*-task.md` or `rusnas-*-spec.md` in project root
10. `docs/superpowers/` directory does not exist
11. `git grep 'docs/superpowers'` returns 0 matches
12. `git grep 'rusnas-guard-task\|rusnas-dedup-spec'` in CLAUDE.md returns 0 (old refs gone)
