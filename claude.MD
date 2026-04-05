# CLAUDE.md

> 📖 **Документация:** `npm run docs` -- dev-docs, `npm run docs:serve` -- :8000
> 📚 **User docs:** `user-docs/` -- руководство пользователя, доступно на `/help/`
> 📋 **Roadmap:** [ROADMAP.md](./ROADMAP.md) -- приоритеты и статусы
> 💡 **Backlog:** [BACKLOG.md](./BACKLOG.md) -- идеи и wishlist
> 📝 **Changelog:** [CHANGELOG.md](./CHANGELOG.md) -- история версий
> 🐛 **Баги:** [bugs.md](./bugs.md) -- полная история BUG-01..N
> 📜 **Git:** [git-workflow.md](./git-workflow.md) -- правила веток и коммитов
> 🎨 **UI:** [ui.md](./ui.md) -- дизайн-система, CSS, branding (ЧИТАТЬ перед UI работой)
> 🌐 **Web:** [webservice.md](./webservice.md) -- nginx/Apache/FileBrowser/WebDAV (ЧИТАТЬ перед web работой)
> 📖 **Сессии:** [project_history.md](./project_history.md) -- хронология всех сессий (APPEND only)
> 🏗️ **ADR:** [docs/adr/](./docs/adr/) -- архитектурные решения (Btrfs, Podman, dm-cache...)

This file provides guidance to Claude Code when working with code in this repository.

> ⚠️ **project_history.md -- только ДОПОЛНЯТЬ, никогда не перезаписывать целиком!**

> 🔍 **Перед работой с модулем -- ПРОЧИТАЙ его spec:** `docs/specs/<module>.md`
> Там ТЗ + Implementation Notes + Known Issues. CLAUDE.md содержит только ссылки и ловушки.

## Правила размещения документов (для Claude Code и skills)

| Тип документа | Путь | Формат имени |
|---------------|------|--------------|
| Спецификация модуля | `docs/specs/<module>.md` | Короткое имя: `guard.md`, `snapshots.md` |
| Design spec (brainstorming) | `docs/designs/YYYY-MM-DD-<topic>.md` | С датой |
| Implementation plan | `docs/plans/YYYY-MM-DD-<topic>.md` | С датой |
| ADR | `docs/adr/NNN-<title>.md` | С номером: `001-btrfs-over-zfs.md` |
| Новая фича в roadmap | `ROADMAP.md` | Строка в нужную таблицу |
| Идея / wishlist | `BACKLOG.md` | Чекбокс `- [ ]` в секцию |
| Новая версия | `CHANGELOG.md` | Keep a Changelog формат |
| Баг | `bugs.md` | BUG-NN секция |
| Сессионный лог | `project_history.md` | APPEND в конец |

> ⚠️ **НЕ создавать файлы в `docs/superpowers/`** -- deprecated, удалена
> ⚠️ **НЕ создавать `rusnas-*-task.md` в корне** -- все спеки в `docs/specs/`

## Правила обновления внешних файлов

CLAUDE.md -- компактный навигатор. Детальный контент хранится в отдельных файлах:

| Файл | Когда обновлять |
|------|----------------|
| `project_history.md` | После каждой сессии -- APPEND в конец |
| `CHANGELOG.md` | После каждого merge -- Added/Changed/Fixed |
| `ROADMAP.md` | При завершении фичи (✅) или добавлении новой (📋) |
| `bugs.md` | При каждом баге/фиксе -- BUG-NN секция |
| `docs/specs/<module>.md` | При изменении архитектуры модуля -- обновить Implementation Notes |
| `ui.md` | При изменении дизайн-системы, CSS-компонентов |
| `git-workflow.md` | При изменении стратегии веток |

**Принцип:** Если секция в CLAUDE.md > 1,500 символов -- вынести. CLAUDE.md должен оставаться < 30,000 символов.

## ⚠️ Обязательное обновление после merge в main

| # | Файл | Что записать |
|---|------|-------------|
| 1 | `CHANGELOG.md` | Added/Changed/Fixed под текущую версию |
| 2 | `ROADMAP.md` | Переместить завершённое -> ✅, добавить новое -> 📋 |
| 3 | `project_history.md` | APPEND сессию в конец |
| 4 | `CLAUDE.md` | Только ловушки и ссылки, НЕ inline docs |
| 5 | `docs/specs/<module>.md` | Implementation Notes если архитектура изменилась |
| 6 | `bugs.md` | BUG-NN для каждого бага/фикса |
| 7 | `ui.md` | Если менялись CSS/дизайн-система |

**Правило:** Не спрашивать пользователя -- просто обновить.

## Project Overview

**RusNAS** -- коммерческая NAS-платформа, альтернатива Synology DSM для SMB (1000+ устройств). Debian 13 Trixie, Btrfs + mdadm.

**Ключевое решение:** Btrfs + mdadm вместо ZFS -- ZFS не поддерживает online RAID level migration (см. [ADR-001](./docs/adr/001-btrfs-over-zfs.md)).

## Technical Stack

| Layer | Component |
|-------|-----------|
| OS | Debian 13 Trixie |
| RAID | mdadm (Basic, JBOD, RAID 0/1/5/6/10, RAID F1) |
| Filesystem | Btrfs (snapshots, online resize, reflinks) |
| SMB | Samba |
| NFS | knfsd + mountd (port 20048) |
| FTP | vsftpd (passive 30000-30100) |
| WebDAV | Apache digest auth |
| iSCSI | targetcli-fb (LIO) |
| UPS | NUT 2.8.1 |
| Web UI | Cockpit + rusnas plugin (12 pages) |
| Containers | Podman + podman-compose (10 apps catalog) |
| Updates | deb repo (reprepro + nginx) |
| Firewall | nftables |

## Development Environment

- **Host:** Intel Mac + UTM (QEMU)
- **VM 10.10.10.72** -- dev/test, user: `rusnas` (root SSH disabled)
- **VM 10.10.10.31** -- build/package
- **File transfer:** `scp` (не terminal paste -- обрезает длинные команды)

## Deploy / Update Workflow

```bash
./deploy.sh                    # Deploy Cockpit plugin
scp -r cockpit/rusnas/* rusnas@10.10.10.72:/tmp/rusnas-plugin/
ssh rusnas@10.10.10.72 "sudo cp -r /tmp/rusnas-plugin/* /usr/share/cockpit/rusnas/"
```

Cockpit auto-reloads on refresh. Файлы: `644`, директории: `755`.

## Project Structure

```
RusNAS/
├── cockpit/rusnas/           # Cockpit plugin (12 pages)
│   ├── manifest.json
│   ├── *.html                # dashboard, index, disks, users, guard, snapshots,
│   │                         # dedup, ups, storage-analyzer, network, ai, performance,
│   │                         # containers, license, notifications
│   ├── css/                  # style.css, dashboard.css, ai.css, containers.css, ...
│   ├── js/                   # app.js, dashboard.js, disks.js, guard.js, ...
│   └── scripts/              # Python backends (mcp-api.py, storage-*.py, ...)
├── docs/
│   ├── specs/                # Спецификации модулей (20+ файлов)
│   ├── adr/                  # Architecture Decision Records (7 файлов)
│   ├── plans/                # Implementation plans
│   ├── designs/              # Design specs
│   ├── src/                  # MkDocs dev-docs source
│   └── mkdocs.yml
├── user-docs/                # Руководство пользователя (MkDocs)
├── rusnas-guard/             # Guard daemon source
├── rusnas-dedup/             # Dedup backend
├── rusnas-metrics/           # Prometheus metrics server
├── rusnas-sectest/           # Security Self-Test
├── rusnas-perf-collector/    # Performance collector daemon
├── rusnas-license-server/    # License server (FastAPI)
├── landing/                  # Marketing landing page
├── ansible/                  # Provisioning roles
├── *.sh                      # Deploy/install scripts
├── ROADMAP.md, BACKLOG.md, CHANGELOG.md
├── ui.md, webservice.md, bugs.md, git-workflow.md
└── CLAUDE.md
```

## Модули (quick-reference)

> 🔍 **Перед работой с модулем -- ПРОЧИТАЙ его spec:** `docs/specs/<module>.md`

| Модуль | Spec | Deploy | ⚠️ Главная ловушка |
|--------|------|--------|--------------------|
| Guard | [guard.md](./docs/specs/guard.md) | install-guard.sh | Socket 0o666, superuser НЕ в spawn |
| Snapshots | [snapshots.md](./docs/specs/snapshots.md) | install-snapshots.sh | `schedule list` НЕ принимает `--json` |
| Dedup | [dedup.md](./docs/specs/dedup.md) | install-dedup.sh | duperemove v0.11.2 -- нет `--min-size` |
| UPS | [ups.md](./docs/specs/ups.md) | install-ups.sh | superuser НЕ в spawn -- polkit timeout |
| Storage Analyzer | [storage-analyzer.md](./docs/specs/storage-analyzer.md) | install-storage-analyzer.sh | `classify_ext()` инлайн в api |
| Performance | [performance.md](./docs/specs/performance.md) | deploy.sh | `writeSysFile` без sudoers |
| Dashboard | [dashboard.md](./docs/specs/dashboard.md) | deploy.sh | tickFast batch spawn `===M===` |
| Containers | [containers.md](./docs/specs/containers.md) | install-containers.sh | Podman root, aardvark-dns |
| Notifications | [notifications.md](./docs/specs/notifications.md) | install-notify.sh | Socket 0o666, SQLite WAL |
| Storage (shares) | [storage-redesign.md](./docs/specs/storage-redesign.md) | deploy.sh | SMB sed pattern, NFS dedup |
| RAID / Disks | [raid-manager.md](./docs/specs/raid-manager.md) | -- | mdstat: resync И reshape |
| Network | [network.md](./docs/specs/network.md) | install-network.sh | ifupdown, НЕ NetworkManager |
| SSD Cache | [ssd-cache.md](./docs/specs/ssd-cache.md) | install-ssd-tier.sh | dm-cache, НЕ bcache |
| FileBrowser | [filebrowser.md](./docs/specs/filebrowser.md) | install-filebrowser.sh | `/var/lib/rusnas` chmod o+x |
| MCP AI | [mcp-ai.md](./docs/specs/mcp-ai.md) | install-mcp.sh | CORS proxy |
| License Server | [license-server.md](./docs/specs/license-server.md) | -- | Ed25519 + Base62 |
| Security Test | [rusnas-sectest/](./rusnas-sectest/) | install-sectest.sh | Monthly timer |
| Btrfs проблемы | [btrfs-problems.md](./docs/specs/btrfs-problems.md) | -- | 15 known issues |

## Cockpit Plugin Rules

```javascript
<script src="../base1/cockpit.js"></script>
// CSP: 'unsafe-inline' 'unsafe-eval' в manifest.json
// Inline onclick= ЗАПРЕЩЁН -- только addEventListener
// targetcli: cockpit.spawn(["sudo", "targetcli", ...])
```

## Development Rules

1. **Dashboard -> Notify:** Любой виджет ДОЛЖЕН иметь интеграцию с rusnas-notify
2. **Docs обязательны:** При изменении модуля -- обновить `docs/specs/<module>.md`, `docs/src/`, `user-docs/`, `landing/`
3. **Certification:** При подготовке к сертификации -- `certification-docs/`

## Development Patterns

- Iterate and verify -- проверять каждый шаг на VM
- Transfer via `scp`, не terminal paste
- Test on real VM, not theory

> **⚠️ КРИТИЧЕСКОЕ ПРАВИЛО: Cockpit = ТОЛЬКО отображение, НИКОГДА сбор/обработка данных!**
> - Cockpit plugin -- **только визуализация**. Сбор метрик -- **всегда в backend** (Python + systemd)
> - `cockpit.spawn()` / `cockpit.file()` -- только для ЧТЕНИЯ готовых данных
> - Паттерн: backend daemon -> JSON/SQLite -> Cockpit JS читает и рисует

## Known Bugs (активные ловушки)

> Полная история: [bugs.md](./bugs.md). Ниже -- 15 самых опасных паттернов.

| Bug | Fix |
|-----|-----|
| `bash -c "sudo cmd"` не работает | `cockpit.spawn(["sudo", "-n", cmd], {err:"message"})` |
| `cockpit.spawn().then()` не Promise | Оборачивать: `new Promise(function(r,j){ spawn().done(r).fail(j) })` |
| `superuser:"require"` в iframe -> timeout | sudoers NOPASSWD вместо superuser |
| smb.conf inline comments ломают configparser | python regex парсер в tmpfile |
| duperemove v0.11.2 -- нет `--min-size`/`--hash` | Debian 13 = v0.11.2; флаги с v0.12+ |
| NFS entries дублируются | `sed -i '\|^/path |d'` перед append |
| iSCSI saveconfig.json путь | `/etc/rtslib-fb-target/saveconfig.json` НЕ `/etc/target/` |
| `schedule list --json` | Команда НЕ принимает `--json` -- убрать флаг |
| `sysctl -w` через `sudo -n` | `writeSysFile("/proc/sys/...", val)` через cockpit.file |
| `escHtml(null)` -> TypeError | `String(s \|\| "").replace(...)` |
| `setInterval` без ID = утечка | `var _timer = setInterval(...)` + clearInterval |
| tickFast N spawns/2сек | Батчить в один spawn с `===M===` |
| `Promise.all().then()` без `.catch()` | Всегда `.catch(fn)` |
| `results.push()` в параллельных callbacks | `results[idx] = ...` с индексом |
| `branding.css [aria-current]` | Использовать `[aria-current="page"]` НЕ `[aria-current]` |

## Mobile / Responsive CSS

Все HTML: `<meta name="viewport" content="width=device-width, initial-scale=1">`
Breakpoints: `768px` (таблицы), `480px` (кнопки full-width, iOS zoom fix `font-size:16px`)

## Distribution Infrastructure

| Параметр | Значение |
|----------|----------|
| `RUSNAS_VPS_HOST` | `activate.rusnas.ru` |
| `RUSNAS_APT_URL` | `https://activate.rusnas.ru/apt/` |
| `RUSNAS_LICENSE_PORT` | `8765` |
| `RUSNAS_APT_AUTH_PORT` | `8766` |

Подробнее: [docs/specs/license-server.md](./docs/specs/license-server.md)

## Git Workflow

> Полные правила: [git-workflow.md](./git-workflow.md)

Feature Branch Flow. `main` = deployed. `feat:|fix:|docs:|refactor:` + Author.

## Landing Page

`landing/index.html` -> `./deploy-landing.sh` -> `http://10.10.10.72/`
Обновлять при добавлении/изменении фич. Тёмная тема, Manrope, оранжевый акцент.

## Documentation (auto-docs)

**Dev-docs:** MkDocs Material + jsdoc2md + mkdocstrings. `npm run docs` -> `docs-site/`
**User-docs:** `user-docs/` -> `/help/` на VM. `cd user-docs && bash build-user-docs.sh`
**JSDoc:** `/** @param {string} x */ function f(x) {}`
**Python:** Google-style docstrings

## Roadmap

> Полный roadmap: [ROADMAP.md](./ROADMAP.md)

| Модуль | Статус |
|--------|--------|
| Dashboard | ✅ 2026-03-15 |
| Dedup | ✅ 2026-03-15 |
| SSD Cache | ✅ 2026-03-17 |
| FileBrowser | ✅ 2026-03-19 |
| Network | ✅ 2026-03-22 |
| MCP AI | ✅ 2026-03-23 |
| Performance | ✅ 2026-03-24 |
| Night Report | ✅ 2026-03-25 |
| UI Cohesion | ✅ 2026-03-26 |
| License Server | ✅ 2026-03-26 |
| RAID Backup | ✅ 2026-03-28 |
| Containers | ✅ 2026-03-28 |
| Sidebar | ✅ 2026-03-31 |
| Perf Charts | ✅ 2026-03-31 |
| SecTest | ✅ 2026-03-31 |
| Notifications | ✅ 2026-04-04 |
| MCP Session 2 | 📋 planned |
