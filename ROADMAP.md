# RusNAS Roadmap

> Приоритезированный план разработки. Архитектурные ТЗ -- в `rusnas-*-task.md` и `rusnas-*-spec.md` файлах.
> Обновлять при завершении фичи или добавлении новой задачи.

---

## Приоритеты

| Символ | Описание |
|--------|----------|
| P0 | Критично -- блокирует релиз |
| P1 | Важно -- следующий спринт |
| P2 | Средне -- в планах |
| P3 | Низкий -- когда будет время |

---

## Выполнено

| Модуль | Дата | Ветка | Описание |
|--------|------|-------|----------|
| Dashboard | 2026-03-15 | feature/dashboard | Полный дашборд: метрики, sparklines, SMART cache, Guard/UPS/Network виджеты, Prometheus metrics server |
| Дедупликация | 2026-03-15 | feature/dedup | duperemove + reflinks + SMB vfs_btrfs, расписание cron, метрики shared extents, история 7 дней |
| SSD-кеширование | 2026-03-17 | -- | LVM dm-cache (writethrough/writeback), конфиг `/etc/rusnas/ssd-tiers.json`, VG `rusnas_vg<N>` |
| FileBrowser Quantum | 2026-03-19 | feature/filebrowser | Go-бинарник v2.31.2, Apache proxy `/files/`, user management через CLI |
| Network + Certs + Domain | 2026-03-21/22 | feature/network | 6 вкладок (интерфейсы, DNS, маршруты, диагностика, сертификаты certbot 4.0, домен Samba AD DC), Auto-Revert |
| MCP Server + AI Agent (Session 1) | 2026-03-22/23 | feature/mcp-ai | mcp-api.py (11 команд + ai-chat proxy), ai.html multi-provider (YandexGPT 5 Pro + Anthropic), openEYE Agent |
| Снапшоты: репликация | 2026-03-23 | feature/mcp-ai | btrfs send/receive по SSH, инкрементальная передача, CLI replication set/list/delete/run + Cockpit UI + systemd timer |
| Performance Tuner | 2026-03-24 | feature/mcp-ai | Авто-оптимизатор 12 уровней (vm.*, I/O scheduler, read-ahead, mdadm, Btrfs, сеть, NIC, Samba, NFS, CPU governor, IRQ, TuneD), SMART self-test modal, Guard watchdog |
| Night Report | 2026-03-25 | testing/full-regression | Виджет ночного отчета на дашборде: Health Score, 5 stat-карточек, 3 колонки (Guard/SMART/Dedup+Snap) |
| Regression Testing + CPU opt | 2026-03-25 | testing/full-regression | Playwright 9/9 PASS, tickFast batch optimization (4 spawns -> 1), visibilitychange pause, 13 багов (BUG-18..30) |
| UI Cohesion + Ghost Pill Sidebar | 2026-03-26 | -- | Единый дизайн-язык, Ghost Pill навигация, дизайн-токены |
| Bootstrap Installer + License Server | 2026-03-26 | feat/bootstrap-installer-spec | FastAPI license server (Ed25519 + Base62), apt-auth service, bootstrap.sh, admin web UI, 22 теста |
| Cockpit License Page | 2026-03-26 | feat/bootstrap-installer-spec | license.html + js/license.js, активация лицензий через Cockpit UI |
| RAID Backup Mode (HDD Spindown) | 2026-03-28 | feat/raid-backup-mode | Daemon rusnas-spind (state machine active/flushing/standby/waking), CGI backend, 5 Prometheus метрик, 15 Playwright тестов |
| Container Manager | 2026-03-28 | feat/container-manager | Магазин приложений (10 apps: Nextcloud, Immich, Jellyfin, Vaultwarden, Home Assistant, Pi-hole, WireGuard, Mailcow, OnlyOffice, Rocket.Chat), Podman + compose, nginx proxy, preflight checks, 19 тестов |
| Sidebar Redesign + Nav Groups | 2026-03-31 | -- | 22 Heroicons (mask-image), 4 collapsible nav groups, alert badges (RAID/Guard/UPS), DOM reordering |
| Dashboard Perf Charts + Collector | 2026-03-31 | -- | Chart.js 4.x (6 графиков: CPU/RAM/Net/IO/IOPS/Latency), perf-collector.py daemon (10s interval, 24h retention, downsampling) |
| Security Self-Test (Pentest) | 2026-03-31 | -- | 9 OWASP modules, 47+ checks, dashboard widget, monthly systemd timer |
| Notification System (rusnas-notify) | 2026-04-04 | -- | Daemon notifyd.py, CLI rusnas-notify, 5 каналов (Email/Telegram/MAX/SNMP/Webhook), Log Watcher, checker timer |
| Process CPU History | 2026-04-05 | -- | Top-5 процессов в perf-collector.py (каждые 10с), tooltip + click-panel на CPU графике дашборда |

---

## В работе

| Модуль | Приоритет | Ветка | Описание | Spec |
|--------|-----------|-------|----------|------|
| -- | -- | -- | Нет активных задач в работе | -- |

---

## Планируется

| Модуль | Приоритет | Описание | Spec |
|--------|-----------|----------|------|
| VPS деплой (License Server) | P0 | Деплой apt-repo (reprepro) + systemd юниты license server + apt-auth на реальный VPS, TLS-сертификат | [rusnas-license-server-task.md](./rusnas-license-server-task.md) |
| Пакет `rusnas-system` (deb) | P0 | apt-пакет, устанавливает Cockpit плагин + все backend-компоненты одной командой | -- |
| Ansible role для License Server | P1 | Автоматизация раскатки license server на VPS через Ansible | [rusnas-license-server-task.md](./rusnas-license-server-task.md) |
| MCP Session 2 (SSE/Ollama) | P1 | HTTP SSE транспорт (порт 8765) для Claude Desktop / Cursor, `pip install mcp` SDK, Ollama локальный LLM | [rusnas_mcp_ai.MD](./rusnas_mcp_ai.MD) |
| Снапшоты: snap_dir per-schedule | P2 | Кастомная директория снапшотов для каждого расписания (вместо единого `.snapshots/`) | [rusnas-snapshots-spec.md](./rusnas-snapshots-spec.md) |
| Снапшоты: S3/rclone репликация | P3 | Репликация снапшотов в S3-совместимое облачное хранилище через rclone | [rusnas-snapshots-spec.md](./rusnas-snapshots-spec.md) |
