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
