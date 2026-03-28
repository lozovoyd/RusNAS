# rusNAS Roadmap

> Детальные технические заметки по реализованным и планируемым фичам.
> Архитектурные ТЗ — в `rusnas-*-task.md` файлах.
> Обновлять при завершении фичи (✅) или добавлении новой задачи.

---

## ✅ Dashboard (реализован 2026-03-15, ветка feature/dashboard)

- `dashboard.html` + `css/dashboard.css` + `js/dashboard.js` — полный дашборд
- `rusnas-metrics/metrics_server.py` — Prometheus + JSON API на порту 9100
- `rusnas-metrics.service` — задеплоен и работает на VM

**Ключевые факты:**
- Интервалы: `TICK_FAST=1000` (CPU/Net/IO), `TICK_STORAGE=10000`, `TICK_SMART=300000`, `TICK_GUARD=5000`, `TICK_UPS=10000`
- Sparklines — чистый SVG, без внешних библиотек
- SMART cache TTL 5мин (`smartCache[device].time`)
- Guard state из `/run/rusnas-guard/state.json`
- UPS widget: `loadUpsStatus()` → `upsc -j` → `renderDashUps()` / `renderUpsNoDevice()`; карточка в grid-4 нижней секции
- Dark mode: dashboard.css использует `--bg-th`/`--bg-card`/`--color-muted` (не `--color-bg-secondary`)
- Metrics server: warmup 1 сек перед первым delta-расчётом
- Metrics endpoint: `http://<IP>:9100/metrics` (Prometheus) + `/metrics.json` (JSON)
- **Network Modal (2026-03-21):** клик на `#card-net` → `#net-modal`; vnstat JSON — ключи `traffic.day/hour/month` (не plural!); today = `day[day.length-1]`
- **TX bug fix (2026-03-21):** `/proc/net/dev` regex — 7 skip-групп (не 6) для TX_bytes
- **Snapshot widget (2026-03-21):** cross-reference `storage-info` с `schedule list`
- **Guard auto_start (2026-03-21):** `guard.py` вызывает `start_guard()` если `config["auto_start"] == True`

---

## ✅ Дедупликация (реализована 2026-03-15, ветка feature/dedup)

- `dedup.html` + `js/dedup.js` — полная страница управления
- `rusnas-dedup/rusnas-dedup-run.sh` — backend: duperemove + state JSON
- `rusnas-dedup/rusnas-dedup.service` — systemd oneshot, Nice=19, IOSchedulingClass=idle
- Функции: запуск/стоп, лог, расписание (cron), тома, SMB vfs_btrfs per-шара, продвинутые параметры
- Метрики: shared extents через `btrfs filesystem du -s`, история 7 дней

---

## ✅ Снапшоты: репликация (реализовано 2026-03-23, ветка feature/mcp-ai)

**Суть:** вынос снапшотов за пределы NAS через `btrfs send/receive` по SSH.

### Реализовано

**CLI (`rusnas-snap`):**
- `replication set <subvol_path> --host HOST --user USER --path PATH --cron "0 1 * * *" [--disabled]`
- `replication list` — возвращает `{tasks:[...], ok:true}`
- `replication delete <subvol_path>`
- `replication run <subvol_path>` — немедленный запуск одной задачи
- `replication run-all` — все включённые задачи (с учётом cron-расписания)
- `replication check-ssh <subvol_path>` — тест SSH-подключения

**DB (SQLite `replication_tasks`):**
`id, subvol_path, remote_user, remote_host, remote_path, cron_expr, enabled, last_sent_snap, last_run_at, last_status, last_error, created_at, updated_at`

**Transport:**
```bash
# Первая передача (полная):
btrfs send /mnt/data/.snapshots/docs/@snap | ssh user@host btrfs receive /backup/docs/
# Инкрементальная:
btrfs send -p /mnt/data/.snapshots/docs/@prev @curr | ssh user@host btrfs receive /backup/docs/
```

**Cockpit UI (`snapshots.html` + `snapshots.js`):**
- Вкладка "Репликация" со статической инфографикой: flow-диаграмма NAS→SSH→Remote, сравнение полной/инкрементальной, 3 сценария, quick start
- Динамический список задач: статус (✅/❌/⏳/⬜), хост, расписание, последний запуск
- Модал добавления/редактирования с SSH-тестом
- Кнопки: ▶ Запустить, ⏸/▶ Включить/Отключить, 🗑 Удалить

**Systemd (`rusnas-snapd.service`):**
- Добавлен второй `ExecStart=/usr/local/bin/rusnas-snap replication run-all`
- Таймер каждые 5 минут запускает и `scheduled-run`, и репликацию

**Ключевые факты:**
- SSH ключи — преднастраиваются вручную (`ssh-copy-id`); UI только host/user/path
- Таймаут передачи: 2 часа (на крупные датасеты)
- Удалённый хост обязан иметь Btrfs-субволюм для `btrfs receive`
- Что НЕ использовать: rsync (теряет read-only subvol структуру), SMB/FTP (медленно)

### Не реализовано (📋 следующая сессия)

- Уровень 1: `snap_dir` per-schedule (кастомная директория снапшотов)
- Уровень 3: S3/rclone (низкий приоритет)

---

## ✅ SSD-кеширование (реализовано 2026-03-17)

Полное ТЗ: [rusnas-ssd-tier-task.md](./rusnas-ssd-tier-task.md)

- Технология: LVM dm-cache — НЕ bcache (опасен с Btrfs в writeback)
- `install-ssd-tier.sh` + секция "⚡ SSD-кеширование" в `disks.html` + ~350 строк JS
- Конфиг: `/etc/rusnas/ssd-tiers.json` (chmod 644)
- Судоерс: `/etc/sudoers.d/rusnas-ssd-tier`
- VG именование: `rusnas_vg<N>`; откат при ошибке: `vgremove -f <vgName>`
- Режимы: writethrough (по умолчанию) / writeback (предупреждение про ИБП)
- Stack: `Btrfs → /dev/rusnas_vgN/data_lv (dm-cache) → /dev/mdX + /dev/sdY`

---

## ✅ FileBrowser Quantum (реализовано 2026-03-19, ветка feature/filebrowser)

Полное ТЗ: [rusnas-filebrowser-task.md](./rusnas-filebrowser-task.md)

- Бинарник: `/usr/local/bin/filebrowser` (v2.31.2, Go)
- URL: `http://<IP>/files/` через Apache proxy
- Конфиг: `/etc/rusnas/filebrowser/settings.json` (port 8088, baseURL="/files")
- Сервис: `rusnas-filebrowser.service` (user: rusnas-fb)
- Admin pass: `rusnas_admin_2026`

**Критические заметки:**
- API POST `/api/users` → "invalid data type" (баг v2.31.2) — только GET работает
- Все write-операции через CLI: `systemctl stop → filebrowser users add/update/rm → start`
- API URL prefix: `http://127.0.0.1:8088/files/api/...` (не `/api/...`)

---

## ✅ Network + Certs + Domain + Auto-Revert (реализовано 2026-03-21/22, ветка feature/network)

Полное ТЗ: [rusnas-network-task.md](./rusnas-network-task.md), [rusnas-domain-task.md](./rusnas-domain-task.md)

- Backend: `network-api.py` (ifupdown), `certs-api.py` (13 команд), `domain-api.py` (35+ команд)
- 6 вкладок: Интерфейсы, DNS, Маршруты, Диагностика, Сертификаты, 🏢 Домен
- Auto-Revert: backup → `ifup` → `systemd-run --on-active=90s` таймер → подтверждение или откат
- certbot 4.0.0, webroot `/var/www/rusnas-landing`
- DC режим: `samba-ad-dc` конфликтует с `smbd` — `dc-provision` делает backup `smb.conf.pre-dc`
- `allow-hotplug` = `auto` (VM использует `allow-hotplug enp0s1`)
- Port check: `/bin/nc` (netcat-openbsd), НЕ `/usr/bin/ncat`

---

## ✅ MCP Server + AI Agent Session 1 (реализовано 2026-03-22/23, ветка feature/mcp-ai)

Полное ТЗ: [rusnas_mcp_ai.MD](./rusnas_mcp_ai.MD)

- `mcp-api.py` — 11 команд + ai-chat proxy (CORS bypass через Python)
- `ai.html` + `ai.js` — multi-provider: YandexGPT 5 Pro (default) + Anthropic
- `eye.js` + `eye.css` — openEYE Agent (автоанализ страниц, FAB + compact card)
- Payload via tempfile: `cockpit.file("/tmp/rusnas-ai-req.json").replace()` (stdin не работает в Cockpit 337)
- localStorage ключи: `rusnas_ai_provider`, `rusnas_yandex_key`, `rusnas_yandex_folder`, `rusnas_yandex_model`, `rusnas_claude_key`
- Судоерс: `/etc/sudoers.d/rusnas-mcp`, `/etc/sudoers.d/rusnas-smart`

### mcp-api.py команды

| Команда | Что делает |
|---------|-----------|
| `get-status` | uptime, loadavg, meminfo, df |
| `list-shares` | testparm -s + /etc/exports |
| `list-disks` | lsblk -J + /proc/mdstat |
| `list-raid` | mdadm --detail /dev/md* |
| `list-snapshots <subvol>` | rusnas-snap list |
| `create-snapshot <subvol> <label>` | rusnas-snap create (+ log) |
| `delete-snapshot <subvol> <name>` | rusnas-snap delete (+ log) |
| `list-users` | getent passwd uid 1000–60000 |
| `get-events [limit]` | tail events.jsonl |
| `run-smart-test <dev>` | smartctl -t short (+ log) |
| `get-smart <dev>` | smartctl -a |
| `ai-chat` | proxy Yandex/Anthropic API |

---

## 📋 MCP Session 2 (следующая сессия)

- HTTP SSE транспорт (порт 8765) для Claude Desktop / Cursor
- `pip install mcp` SDK
- Ollama локальный LLM

---

## ✅ Performance Tuner + SMART modal + Guard watchdog (реализовано 2026-03-24, ветка feature/mcp-ai)

Полное ТЗ: [rusnas-performance-tuning-spec.md](./rusnas-performance-tuning-spec.md)

- `performance.html` + `js/performance.js` — авто-оптимизатор 12 уровней
- Детект системы: RAM, CPU cores, диски (HDD/SSD/NVMe), RAID, NIC, tuned
- Параметры: vm.swappiness, vm.dirty_ratio, I/O scheduler, read-ahead, stripe_cache_size, Btrfs noatime, сеть rmem/wmem/BBR, Samba sendfile/aio, NFS nfsd threads, CPU governor
- Чтение через `cat /proc/sys/...`, запись через `cockpit.file(path, {superuser:"require"}).replace()`
- SMART self-test modal: история тестов (таблица), polling прогресса, расписание через smartd
- Guard socket watchdog в `dashboard.js`: авто-переподключение при обрыве сокета

---

## ✅ Regression Testing + CPU optimization + Night Report (реализовано 2026-03-25, ветка testing/full-regression)

- **Regression testing** всех 9 страниц плагина — Playwright, 9/9 PASS
- **CPU optimization:** `tickFast` 4 spawns → 1 batch с `===M===`, таймеры 2×–6× медленнее, `visibilitychange` pause
- **Night Report widget** — ночной отчёт на дашборде (Health Score, 3 колонки, 5 stat-карточек)
- **BUG-18..30:** 13 багов задокументированы и исправлены (см. [bugs.MD](./bugs.MD))
- **btrfs-problems.md:** 15 известных проблем Btrfs+mdadm с решениями и условиями возникновения
- Новые антипаттерны в CLAUDE.md: Promise.all .catch(), results[idx], loadData().then(), worstStatus priority, /var/lib/rusnas traverse bit

---

## ✅ RAID Backup Mode — HDD Spindown (реализовано 2026-03-28, ветка feat/raid-backup-mode)

Полное ТЗ: `docs/superpowers/specs/` (RAID Backup Mode spec)

**Концепция:** Автоматическое отключение шпинделей (spindown) RAID-массива после заданного периода простоя — для использования в роли резервного NAS с редкими обращениями.

**Daemon rusnas-spind (`rusnas-spind/`):**
- `monitor.py` — SpindownMonitor: читает `/proc/diskstats`, state machine: `active → flushing → standby → waking → active`
- `controller.py` — SpinController: оборачивает `hdparm -y` / `hdparm -C` (dry_run mock для QEMU)
- `btrfs_helper.py` — BtrfsFlusher: `commit_min=0` + `sync` + restore_commit перед spindown
- `mdadm_helper.py` — `suppress_check` (записывает `idle` в sync_action + `sync_min=0`) / `restore_check`, `get_member_disks`, `get_mountpoint`
- `state_writer.py` — атомарные записи JSON: `.tmp` → `os.replace()`, persistence `wakeup_count_total` через `spindown_totals.json`
- `spind.py` — основной демон: `do_spindown`, `do_wakeup`, адаптивный polling 15s/3s, `SIGHUP`/`SIGTERM`
- Systemd unit: `rusnas-spind.service` (WorkingDirectory=/usr/lib/rusnas/spind, `--dry-run` на тест-VM)

**CGI бэкенд:**
- `cockpit/rusnas/cgi/spindown_ctl.py` — 5 команд: `get_state`, `get_config`, `set_config`, `wake_up`, `spindown_now`
- Путь на VM: `/usr/lib/rusnas/cgi/spindown_ctl.py`
- Sudoers: `/etc/sudoers.d/rusnas-spindown`

**UI (disks.js):**
- Кнопка «💾 Backup Mode» + панель на каждую RAID-карточку
- `_warnIfSleeping(arrayName, actionLabel)` — перехват опасных операций (expand/replace/unmount/subvol) если массив спит
- Адаптивный polling badge (15s нормальный, 3s при flushing/waking)
- Idle timeout: 1–1440 мин, SSD warning при наличии dm-cache

**Dashboard (dashboard.js):**
- Sub-line под каждым RAID-массивом: 💤 Спит / ⏳ Засыпает… / 🔆 Просыпается… / 💾 Бэкап активен

**Prometheus метрики (metrics_server.py):**
- `rusnas_spindown_state{array}` (0=active,1=flushing,2=standby,3=waking)
- `rusnas_spindown_wakeup_count_total{array}`
- `rusnas_spindown_idle_timeout_minutes{array}`
- `rusnas_spindown_backup_mode_enabled{array}`
- `rusnas_spindown_last_standby_seconds{array}`

**Deploy:** `./install-spindown.sh`

**Тесты:** `tests/test_backup_mode_ui.py` — 15 Playwright тестов, 15/15 PASS на live VM

---

## ✅ Container Manager (реализовано 2026-03-28, ветка feat/container-manager)

**Концепция:** Встроенный магазин приложений для rusNAS — позволяет устанавливать и управлять контейнеризированными приложениями (Nextcloud, Immich, Jellyfin и др.) через каталог-UI без знания Docker/Podman.

**Архитектура:**
- CGI бэкенд: `cockpit/rusnas/cgi/container_api.py` — 14 команд через argv
- Rootless Podman от пользователя `rusnas-containers` (subuid/subgid 100000:65536)
- Compose-шаблоны с `{{VAR:-default}}` подстановкой; DNS через имена сервисов
- nginx location блоки автогенерируются: `/var/lib/rusnas-containers/nginx-apps/<appid>.conf`
- State: `/etc/rusnas/containers/installed.json`

**Каталог (10 приложений):**

| App | Категория | Порт |
|-----|-----------|------|
| Nextcloud | cloud | 8080 |
| Immich | photo | 2283 |
| Jellyfin | media | 8096 |
| Vaultwarden | security | 8090 |
| Home Assistant | iot | 8123 |
| Pi-hole | network | 8053 |
| WireGuard | network | 51820 |
| Mailcow | mail | 8025 |
| OnlyOffice | office | 8085 |
| Rocket.Chat | chat | 3000 |

**UI (3 вкладки):**
- **Каталог** — карточки приложений с категорией/описанием/иконкой, фильтры по категориям, модал установки с параметрами (включая авто-генерацию паролей)
- **Установленные** — список с live-статусом, CPU/RAM метрики, кнопки Start/Stop/Restart/Logs/Uninstall
- **Своё приложение** — форма ручной установки (имя/образ/порт/том) или drag-drop docker-compose.yml

**Dashboard widget:** карточка `ПРИЛОЖЕНИЯ` в нижнем grid, показывает count running/total, переход на страницу.

**Prometheus метрики (metrics_server.py):**
- `rusnas_container_count{status="running|stopped|error"}`
- `rusnas_container_cpu_percent{name="rusnas-*"}`
- `rusnas_container_memory_bytes{name="rusnas-*"}`

**Deploy:** `./install-containers.sh`

**Тесты:** 14 unit (test_container_api.py + test_container_metrics.py) + 5 Playwright UI тестов — 19/19 PASS
