# rusNAS — Система снапшотов: полная спецификация для реализации

> **Целевая аудитория:** Claude Code  
> **Платформа:** Debian 13 (Trixie), Btrfs поверх mdadm, Cockpit UI  
> **Стиль:** Все команды запускаются через `cockpit.spawn()` с `sudo`, демон работает как systemd unit под `root`

---

## 1. Обзор архитектуры

### 1.1 Компоненты системы

```
┌─────────────────────────────────────────────────────────┐
│           Cockpit UI  (snapshots.html + snapshots.js)   │
└─────────────────────────────┬───────────────────────────┘
                              │ cockpit.spawn() / cockpit.file()
┌─────────────────────────────▼───────────────────────────┐
│         rusnas-snap CLI  (/usr/local/bin/rusnas-snap)   │
│         (Python 3, единая точка входа для всех ops)     │
└──────┬──────────────────────┬──────────────────────────┘
       │                      │
┌──────▼──────┐    ┌──────────▼──────────────────────────┐
│  SQLite DB  │    │   Btrfs snapshot engine              │
│  /var/lib/  │    │   btrfs subvolume snapshot/delete    │
│  rusnas/    │    │   btrfs send/receive                 │
│  snaps.db   │    └─────────────────────────────────────┘
└─────────────┘
┌─────────────────────────────────────────────────────────┐
│       rusnas-snapd  (systemd timer, каждый час)         │
│       вызывает rusnas-snap scheduled-run                │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Принципы

- **Единая точка входа:** всё через `/usr/local/bin/rusnas-snap`. UI вызывает CLI, CLI вызывает Btrfs. Так же можно использовать из терминала и Ansible.
- **SQLite как источник истины:** все метаданные снапшотов хранятся в БД. Имя файла на диске вторично.
- **Идемпотентность:** повторный запуск любой команды не ломает систему.
- **Защита locked снапшотов:** снапшоты с флагом `locked=1` никогда не удаляются автоматически.
- **Атомарный restore:** восстановление через `mv` + rename, не через перезапись файлов.

---

## 2. Структура файловой системы

### 2.1 Layout на диске

```
/mnt/md0/                          ← корень Btrfs тома
  shares/
    documents/                     ← Btrfs subvolume (шара)
    backups/                       ← Btrfs subvolume (шара)
    projects/                      ← Btrfs subvolume (шара)
  iscsi/
    lun0.img                       ← файл LUN (весь subvolume снапшотится)
  .snapshots/                      ← директория снапшотов (скрытая)
    shares__documents/             ← снапшоты шары documents
      @2026-03-13_14-30-00_manual/
      @2026-03-13_00-00-00_scheduled/
      @2026-03-12_00-00-00_scheduled/
    shares__backups/
      @2026-03-13_00-00-00_scheduled/
    iscsi/
      @2026-03-13_00-00-00_scheduled/
```

**Правила именования:**
- Снапшот: `@{YYYY-MM-DD}_{HH-MM-SS}_{type}`
- `type` = `manual` | `scheduled` | `pre_update`
- Путь к `.snapshots` всегда относительно корня Btrfs тома
- Разделитель `/` в пути объекта заменяется на `__` в имени директории снапшотов

### 2.2 Определение "объекта снапшота"

Объект снапшота — это Btrfs subvolume. Поддерживаемые типы:

| Тип | Путь subvolume | Пример |
|-----|---------------|--------|
| SMB шара | `/mnt/<vol>/shares/<name>` | `/mnt/md0/shares/documents` |
| iSCSI LUN | `/mnt/<vol>/iscsi` | `/mnt/md0/iscsi` |
| Весь том | `/mnt/<vol>` | `/mnt/md0` |

---

## 3. База данных SQLite

### 3.1 Расположение

```
/var/lib/rusnas/snaps.db
```

### 3.2 Схема

```sql
CREATE TABLE snapshots (
    id          TEXT PRIMARY KEY,       -- UUID v4
    subvol_path TEXT NOT NULL,          -- /mnt/md0/shares/documents
    snap_path   TEXT NOT NULL UNIQUE,   -- /mnt/md0/.snapshots/shares__documents/@2026-03-13_...
    snap_name   TEXT NOT NULL,          -- @2026-03-13_14-30-00_manual
    snap_type   TEXT NOT NULL,          -- manual | scheduled | pre_update
    label       TEXT DEFAULT '',        -- пользовательская метка
    created_at  TEXT NOT NULL,          -- ISO8601: 2026-03-13T14:30:00+03:00
    size_bytes  INTEGER DEFAULT 0,      -- размер снапшота (exclusive)
    locked      INTEGER DEFAULT 0,      -- 1 = защищён от retention cleanup
    valid       INTEGER DEFAULT 1       -- 0 = снапшот удалён с диска
);

CREATE TABLE schedules (
    id              TEXT PRIMARY KEY,   -- UUID v4
    subvol_path     TEXT NOT NULL UNIQUE,
    enabled         INTEGER DEFAULT 1,
    cron_expr       TEXT DEFAULT '0 0 * * *',  -- cron выражение
    retention_last  INTEGER DEFAULT 10,  -- последние N снапшотов
    retention_hourly INTEGER DEFAULT 24, -- 1/час за N часов
    retention_daily  INTEGER DEFAULT 14, -- 1/день за N дней
    retention_weekly INTEGER DEFAULT 8,  -- 1/неделю за N недель
    retention_monthly INTEGER DEFAULT 6, -- 1/месяц за N месяцев
    notify_email    INTEGER DEFAULT 1,
    notify_telegram INTEGER DEFAULT 1,
    updated_at      TEXT NOT NULL
);

CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,   -- created | deleted | restored | error
    snap_id     TEXT,
    subvol_path TEXT,
    message     TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX idx_snapshots_subvol ON snapshots(subvol_path);
CREATE INDEX idx_snapshots_created ON snapshots(created_at);
CREATE INDEX idx_events_created ON events(created_at);
```

---

## 4. CLI: rusnas-snap

### 4.1 Расположение и установка

```
/usr/local/bin/rusnas-snap
```

Исполняемый Python скрипт (`#!/usr/bin/env python3`), `chmod +x`.

### 4.2 Команды

```bash
# Создать снапшот вручную
rusnas-snap create <subvol_path> [--label "text"] [--type manual|pre_update]

# Список снапшотов
rusnas-snap list [<subvol_path>] [--json]

# Удалить снапшот
rusnas-snap delete <snap_id> [--force]   # --force обходит locked

# Применить retention policy
rusnas-snap retention <subvol_path>

# Восстановить весь объект из снапшота
rusnas-snap restore <snap_id>

# Восстановить отдельный файл
rusnas-snap restore-file <snap_id> <relative_path> <dest_path>

# Смонтировать снапшот для просмотра (read-only bind mount)
rusnas-snap browse <snap_id>             # возвращает путь монтирования
rusnas-snap browse-umount <snap_id>

# Запустить плановые снапшоты для всех расписаний
rusnas-snap scheduled-run

# Управление расписаниями
rusnas-snap schedule set <subvol_path> --cron "0 0 * * *" \
    --retention-last 10 --retention-daily 14 ...
rusnas-snap schedule get <subvol_path> [--json]
rusnas-snap schedule list [--json]

# Установить/снять защиту
rusnas-snap lock <snap_id>
rusnas-snap unlock <snap_id>

# Установить метку
rusnas-snap label <snap_id> "текст метки"

# Обновить размеры всех снапшотов в БД (фоново)
rusnas-snap update-sizes <subvol_path>

# Инициализация БД (вызывается при установке)
rusnas-snap init-db
```

### 4.3 Формат вывода

Все команды с `--json` возвращают JSON. Без флага — человекочитаемый текст. Exit code 0 = успех, 1 = ошибка (stderr содержит описание).

Пример `rusnas-snap list /mnt/md0/shares/documents --json`:

```json
{
  "subvol_path": "/mnt/md0/shares/documents",
  "snapshots": [
    {
      "id": "a1b2c3d4-...",
      "snap_name": "@2026-03-13_14-30-00_manual",
      "snap_path": "/mnt/md0/.snapshots/shares__documents/@2026-03-13_14-30-00_manual",
      "snap_type": "manual",
      "label": "before cleanup Q1",
      "created_at": "2026-03-13T14:30:00+03:00",
      "size_bytes": 148897792,
      "size_human": "142 МБ",
      "locked": true,
      "valid": true
    }
  ],
  "total_count": 14,
  "total_size_bytes": 2478882816,
  "total_size_human": "2.3 ГБ"
}
```

### 4.4 Реализация create

```python
def cmd_create(subvol_path, label="", snap_type="manual"):
    # 1. Проверить что subvol_path — валидный Btrfs subvolume
    result = subprocess.run(
        ["btrfs", "subvolume", "show", subvol_path],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        fatal(f"Не является Btrfs subvolume: {subvol_path}")

    # 2. Вычислить путь к директории снапшотов
    vol_root = get_btrfs_root(subvol_path)   # /mnt/md0
    rel_path = os.path.relpath(subvol_path, vol_root)  # shares/documents
    snap_dir_name = rel_path.replace("/", "__")  # shares__documents
    snaps_dir = os.path.join(vol_root, ".snapshots", snap_dir_name)
    os.makedirs(snaps_dir, exist_ok=True)

    # 3. Сформировать имя снапшота
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    snap_name = f"@{ts}_{snap_type}"
    snap_path = os.path.join(snaps_dir, snap_name)

    # 4. Создать read-only снапшот
    subprocess.run(
        ["btrfs", "subvolume", "snapshot", "-r", subvol_path, snap_path],
        check=True
    )

    # 5. Записать в БД
    snap_id = str(uuid.uuid4())
    db_exec("""
        INSERT INTO snapshots (id, subvol_path, snap_path, snap_name, snap_type,
                               label, created_at, locked, valid)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)
    """, (snap_id, subvol_path, snap_path, snap_name, snap_type,
          label, datetime.now().isoformat()))

    db_exec("""
        INSERT INTO events (event_type, snap_id, subvol_path, message, created_at)
        VALUES ('created', ?, ?, ?, ?)
    """, (snap_id, subvol_path, f"Создан снапшот {snap_name}", datetime.now().isoformat()))

    print(json.dumps({"id": snap_id, "snap_path": snap_path, "snap_name": snap_name}))
```

### 4.5 Реализация retention

```python
def cmd_retention(subvol_path):
    """Smart Retention: убирает снапшоты, не попавшие ни в одно окно хранения."""
    schedule = db_get_schedule(subvol_path)
    if not schedule:
        return  # нет расписания — ничего не делаем

    snaps = db_get_snapshots(subvol_path)  # sorted by created_at DESC
    keep_ids = set()

    # Защищённые всегда
    for s in snaps:
        if s["locked"] or s["snap_type"] in ("manual",):
            keep_ids.add(s["id"])

    # Последние N (retention_last)
    for s in snaps[:schedule["retention_last"]]:
        keep_ids.add(s["id"])

    # Помощник: выбрать 1 снапшот на каждый период
    def pick_one_per_period(snaps, period_seconds, count):
        picked = {}
        cutoff = datetime.now() - timedelta(seconds=period_seconds * count)
        for s in snaps:
            dt = datetime.fromisoformat(s["created_at"])
            if dt < cutoff:
                continue
            # Ключ периода = номер периода от эпохи
            period_key = int(dt.timestamp() // period_seconds)
            if period_key not in picked:
                picked[period_key] = s["id"]
        return set(picked.values())

    HOUR  = 3600
    DAY   = 86400
    WEEK  = 604800
    MONTH = 2592000  # 30 дней

    keep_ids |= pick_one_per_period(snaps, HOUR,  schedule["retention_hourly"])
    keep_ids |= pick_one_per_period(snaps, DAY,   schedule["retention_daily"])
    keep_ids |= pick_one_per_period(snaps, WEEK,  schedule["retention_weekly"])
    keep_ids |= pick_one_per_period(snaps, MONTH, schedule["retention_monthly"])

    # Удалить всё что не в keep_ids
    deleted = []
    for s in snaps:
        if s["id"] not in keep_ids and s["valid"]:
            try:
                subprocess.run(
                    ["btrfs", "subvolume", "delete", s["snap_path"]],
                    check=True
                )
                db_exec("UPDATE snapshots SET valid=0 WHERE id=?", (s["id"],))
                db_exec("""INSERT INTO events (event_type, snap_id, subvol_path, message, created_at)
                           VALUES ('deleted', ?, ?, ?, ?)""",
                        (s["id"], subvol_path,
                         f"Retention cleanup: {s['snap_name']}",
                         datetime.now().isoformat()))
                deleted.append(s["snap_name"])
            except subprocess.CalledProcessError as e:
                log_error(f"Не удалось удалить снапшот {s['snap_path']}: {e}")

    if deleted and schedule["notify_email"]:
        notify(subvol_path, f"Retention cleanup: удалено {len(deleted)} снапшотов")
```

### 4.6 Реализация restore (весь объект)

```python
def cmd_restore(snap_id):
    """Атомарное восстановление через переименование."""
    snap = db_get_snapshot(snap_id)
    if not snap or not snap["valid"]:
        fatal("Снапшот не найден или недействителен")

    subvol_path = snap["subvol_path"]   # /mnt/md0/shares/documents
    backup_path = subvol_path + ".restore_backup_" + datetime.now().strftime("%Y%m%d%H%M%S")

    # 1. Создать writable snapshot из snap_path во временное место
    tmp_path = subvol_path + ".restore_tmp"
    subprocess.run(
        ["btrfs", "subvolume", "snapshot", snap["snap_path"], tmp_path],
        check=True
    )

    # 2. Переместить текущий subvolume в backup
    os.rename(subvol_path, backup_path)

    # 3. Переместить tmp на место текущего
    os.rename(tmp_path, subvol_path)

    # 4. Удалить backup (старый subvolume)
    subprocess.run(["btrfs", "subvolume", "delete", backup_path], check=True)

    db_exec("""INSERT INTO events (event_type, snap_id, subvol_path, message, created_at)
               VALUES ('restored', ?, ?, ?, ?)""",
            (snap_id, subvol_path,
             f"Восстановлено из {snap['snap_name']}",
             datetime.now().isoformat()))
```

### 4.7 Реализация browse (просмотр снапшота)

```python
BROWSE_BASE = "/tmp/rusnas-snap-browse"

def cmd_browse(snap_id):
    """Монтирует снапшот read-only для просмотра. Возвращает путь."""
    snap = db_get_snapshot(snap_id)
    if not snap or not snap["valid"]:
        fatal("Снапшот не найден")

    mount_point = os.path.join(BROWSE_BASE, snap_id)
    os.makedirs(mount_point, exist_ok=True)

    # bind mount снапшота
    subprocess.run(
        ["mount", "--bind", "-o", "ro", snap["snap_path"], mount_point],
        check=True
    )

    # Запланировать автоматическое размонтирование через 30 минут
    # (через systemd-run --on-active=1800 rusnas-snap browse-umount <snap_id>)
    subprocess.run([
        "systemd-run", "--on-active=1800",
        "/usr/local/bin/rusnas-snap", "browse-umount", snap_id
    ])

    print(json.dumps({"mount_path": mount_point}))

def cmd_browse_umount(snap_id):
    mount_point = os.path.join(BROWSE_BASE, snap_id)
    if os.path.ismount(mount_point):
        subprocess.run(["umount", mount_point])
    if os.path.isdir(mount_point):
        os.rmdir(mount_point)
```

---

## 5. Демон rusnas-snapd

### 5.1 Systemd timer (предпочтительно вместо cron)

**`/etc/systemd/system/rusnas-snapd.service`:**
```ini
[Unit]
Description=rusNAS Snapshot Scheduler
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/rusnas-snap scheduled-run
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/rusnas-snapd.timer`:**
```ini
[Unit]
Description=rusNAS Snapshot Scheduler Timer
Requires=rusnas-snapd.service

[Timer]
OnCalendar=*:0/5
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
```

Таймер срабатывает каждые 5 минут. `scheduled-run` сам решает что делать (проверяет cron выражения расписаний).

### 5.2 scheduled-run логика

```python
def cmd_scheduled_run():
    """Вызывается каждые 5 минут. Проверяет все расписания."""
    schedules = db_get_all_schedules(enabled_only=True)
    now = datetime.now()

    for schedule in schedules:
        try:
            # Проверить cron выражение
            if not cron_matches(schedule["cron_expr"], now):
                continue

            # Проверить что за последний cron-период снапшот не создавался
            last_snap = db_get_last_snapshot(schedule["subvol_path"])
            if last_snap:
                last_dt = datetime.fromisoformat(last_snap["created_at"])
                period_seconds = cron_period_seconds(schedule["cron_expr"])
                if (now - last_dt).total_seconds() < period_seconds * 0.9:
                    continue  # уже создали в этом периоде

            # Создать снапшот
            cmd_create(schedule["subvol_path"], snap_type="scheduled")

            # Применить retention
            cmd_retention(schedule["subvol_path"])

        except Exception as e:
            log_error(f"scheduled-run ошибка для {schedule['subvol_path']}: {e}")
            notify_error(schedule["subvol_path"], str(e))
```

### 5.3 Проверка cron выражений

Использовать библиотеку `python-crontab` или `croniter` (установить через pip или apt). Если недоступна — реализовать простой парсер для стандартных выражений `M H dom mon dow`.

```python
# Установка: apt install python3-croniter  или  pip3 install croniter
from croniter import croniter

def cron_matches(cron_expr, dt):
    """Возвращает True если cron_expr должен был сработать в течение последних 5 минут."""
    cron = croniter(cron_expr, dt - timedelta(minutes=5))
    next_run = cron.get_next(datetime)
    return next_run <= dt
```

---

## 6. Pre-update снапшоты

### 6.1 Systemd hook перед apt upgrade

**`/etc/apt/apt.conf.d/99rusnas-snapshot`:**
```
DPkg::Pre-Invoke { "/usr/local/bin/rusnas-snap pre-update-all 2>/dev/null || true"; };
```

### 6.2 pre-update-all команда

```python
def cmd_pre_update_all():
    """Создаёт снапшоты всех subvolumes с расписаниями перед обновлением."""
    schedules = db_get_all_schedules(enabled_only=True)
    for schedule in schedules:
        try:
            # Получить версию пакета rusnas для метки
            result = subprocess.run(
                ["dpkg-query", "-W", "-f=${Version}", "rusnas"],
                capture_output=True, text=True
            )
            version = result.stdout.strip() or "unknown"
            cmd_create(
                schedule["subvol_path"],
                label=f"pre-update {version}",
                snap_type="pre_update"
            )
        except Exception as e:
            log_error(f"pre-update snapshot failed for {schedule['subvol_path']}: {e}")
```

---

## 7. Cockpit UI: snapshots.html + snapshots.js

### 7.1 Место в плагине

```
/usr/share/cockpit/rusnas/
  snapshots.html
  js/
    snapshots.js
```

Добавить в `manifest.json` новый пункт навигации:

```json
{
  "snapshots": {
    "label": "Снапшоты",
    "order": 4,
    "path": "snapshots.html"
  }
}
```

### 7.2 HTML структура (snapshots.html)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Снапшоты — rusNAS</title>
  <link rel="stylesheet" href="../base1/cockpit.css">
  <script src="../base1/cockpit.js"></script>
  <script src="js/snapshots.js"></script>
</head>
<body>
  <!-- Заголовок и кнопка создания -->
  <div class="ct-page-row">
    <h2>Снапшоты</h2>
    <button id="btn-create-snap" class="btn btn-primary">+ Создать снапшот</button>
  </div>

  <!-- Вкладки -->
  <ul class="nav nav-tabs" id="snap-tabs">
    <li class="active"><a data-tab="snapshots">Снапшоты</a></li>
    <li><a data-tab="schedule">Расписание</a></li>
    <li><a data-tab="retention">Retention</a></li>
    <li><a data-tab="restore">Восстановление</a></li>
  </ul>

  <!-- Таб: Снапшоты -->
  <div id="tab-snapshots" class="tab-content">
    <!-- Выбор объекта -->
    <div class="ct-form-row">
      <label>Объект</label>
      <select id="snap-object-select"></select>
    </div>

    <!-- Сводка -->
    <div id="snap-summary" class="metrics-row">
      <!-- Заполняется JS -->
    </div>

    <!-- Таблица снапшотов -->
    <table class="table table-hover" id="snap-table">
      <thead>
        <tr>
          <th>Имя / Метка</th>
          <th>Тип</th>
          <th>Создан</th>
          <th>Размер</th>
          <th>Действия</th>
        </tr>
      </thead>
      <tbody id="snap-tbody">
        <!-- Заполняется JS -->
      </tbody>
    </table>
  </div>

  <!-- Таб: Расписание -->
  <div id="tab-schedule" class="tab-content" style="display:none">
    <div id="schedule-content"><!-- Заполняется JS --></div>
  </div>

  <!-- Таб: Retention -->
  <div id="tab-retention" class="tab-content" style="display:none">
    <div id="retention-content"><!-- Заполняется JS --></div>
  </div>

  <!-- Таб: Восстановление (лог событий) -->
  <div id="tab-restore" class="tab-content" style="display:none">
    <div id="restore-log"><!-- Заполняется JS --></div>
  </div>

  <!-- Модальные окна (создание, подтверждение restore, label) -->
  <div id="modal-create-snap" class="modal" style="display:none">
    <!-- Форма создания снапшота -->
    <div class="modal-dialog">
      <div class="modal-header"><h3>Создать снапшот</h3></div>
      <div class="modal-body">
        <label>Объект</label>
        <select id="modal-snap-subvol"></select>
        <label>Метка (необязательно)</label>
        <input type="text" id="modal-snap-label" placeholder="Например: before big cleanup">
      </div>
      <div class="modal-footer">
        <button id="modal-snap-confirm" class="btn btn-primary">Создать</button>
        <button id="modal-snap-cancel" class="btn btn-default">Отмена</button>
      </div>
    </div>
  </div>

  <div id="modal-restore-confirm" class="modal" style="display:none">
    <div class="modal-dialog">
      <div class="modal-header"><h3>Подтверждение восстановления</h3></div>
      <div class="modal-body">
        <p class="alert alert-warning">
          Внимание: текущее состояние <strong id="restore-subvol-name"></strong> 
          будет заменено снапшотом <strong id="restore-snap-name"></strong>.
          Убедитесь что никто не работает с этим ресурсом.
        </p>
      </div>
      <div class="modal-footer">
        <button id="modal-restore-confirm-btn" class="btn btn-danger">Восстановить</button>
        <button id="modal-restore-cancel" class="btn btn-default">Отмена</button>
      </div>
    </div>
  </div>
</body>
</html>
```

### 7.3 JavaScript (snapshots.js) — полная реализация

```javascript
// snapshots.js — полная логика управления снапшотами

(function() {
  "use strict";

  // ─── State ───────────────────────────────────────────────────────────────
  let currentSubvol = null;
  let snapshotsData = [];
  let schedulesData = [];
  let subvolList = [];
  let activeTab = "snapshots";
  let pendingRestoreId = null;

  // ─── Init ─────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function() {
    setupTabs();
    setupButtons();
    loadSubvols().then(() => {
      loadSnapshots();
      loadSchedules();
    });
    // Авто-обновление каждые 30 секунд
    setInterval(() => {
      if (activeTab === "snapshots") loadSnapshots();
    }, 30000);
  });

  // ─── Tabs ─────────────────────────────────────────────────────────────────
  function setupTabs() {
    document.querySelectorAll("#snap-tabs a").forEach(link => {
      link.addEventListener("click", function(e) {
        e.preventDefault();
        const tab = this.dataset.tab;
        activeTab = tab;
        document.querySelectorAll("#snap-tabs li").forEach(li => li.classList.remove("active"));
        this.parentElement.classList.add("active");
        document.querySelectorAll(".tab-content").forEach(div => div.style.display = "none");
        document.getElementById("tab-" + tab).style.display = "block";
        if (tab === "schedule") renderSchedules();
        if (tab === "retention") renderRetentionForms();
        if (tab === "restore") loadEvents();
      });
    });
  }

  // ─── Субволюмы ────────────────────────────────────────────────────────────
  function loadSubvols() {
    return runCmd(["rusnas-snap", "schedule", "list", "--json"])
      .then(out => {
        const data = JSON.parse(out);
        subvolList = data.schedules.map(s => s.subvol_path);
        // Fallback: если расписаний нет, получить список шар
        if (subvolList.length === 0) {
          return getShareSubvols();
        }
        populateSubvolSelects();
      })
      .catch(() => getShareSubvols().then(populateSubvolSelects));
  }

  function getShareSubvols() {
    return runCmd(["findmnt", "--real", "--noheadings", "-o", "TARGET",
                   "--list", "-t", "btrfs"])
      .then(out => {
        subvolList = out.trim().split("\n").filter(Boolean);
        return subvolList;
      });
  }

  function populateSubvolSelects() {
    const selects = ["snap-object-select", "modal-snap-subvol", "modal-restore-subvol"];
    selects.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = "";
      subvolList.forEach(sv => {
        const opt = document.createElement("option");
        opt.value = sv;
        opt.textContent = formatSubvolLabel(sv);
        el.appendChild(opt);
      });
    });
    if (subvolList.length > 0) {
      currentSubvol = subvolList[0];
      loadSnapshots();
    }
    const mainSel = document.getElementById("snap-object-select");
    if (mainSel) {
      mainSel.addEventListener("change", function() {
        currentSubvol = this.value;
        loadSnapshots();
      });
    }
  }

  function formatSubvolLabel(path) {
    const parts = path.split("/");
    const name = parts[parts.length - 1];
    if (path.includes("/shares/")) return "📁 SMB: " + name + "  (" + path + ")";
    if (path.includes("/iscsi"))   return "💾 iSCSI: " + name;
    return "🗄 Volume: " + path;
  }

  // ─── Снапшоты: загрузка и рендеринг ──────────────────────────────────────
  function loadSnapshots() {
    if (!currentSubvol) return;
    runCmd(["rusnas-snap", "list", currentSubvol, "--json"])
      .then(out => {
        const data = JSON.parse(out);
        snapshotsData = data.snapshots || [];
        renderSummary(data);
        renderSnapshotsTable(snapshotsData);
      })
      .catch(err => showError("Ошибка загрузки снапшотов: " + err));
  }

  function renderSummary(data) {
    const el = document.getElementById("snap-summary");
    el.innerHTML = `
      <div class="metric-card">
        <div class="metric-label">Всего снапшотов</div>
        <div class="metric-value">${data.total_count || 0}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Занято места</div>
        <div class="metric-value">${data.total_size_human || "—"}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Последний</div>
        <div class="metric-value">${data.snapshots && data.snapshots[0] ? formatAge(data.snapshots[0].created_at) : "—"}</div>
      </div>
    `;
  }

  function renderSnapshotsTable(snaps) {
    const tbody = document.getElementById("snap-tbody");
    if (snaps.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888">Снапшотов нет</td></tr>';
      return;
    }
    tbody.innerHTML = snaps.map(s => `
      <tr>
        <td>
          <div class="snap-name">${s.snap_name}</div>
          ${s.label ? `<div class="snap-label">${escHtml(s.label)}</div>` : ""}
        </td>
        <td>
          <span class="badge badge-${s.snap_type}">${s.snap_type}</span>
          ${s.locked ? '<span class="badge badge-locked">locked</span>' : ""}
        </td>
        <td>${formatDate(s.created_at)}</td>
        <td>${s.size_human || "—"}</td>
        <td class="snap-actions">
          <button class="btn btn-sm btn-default" onclick="browsSnap('${s.id}')">Просмотр</button>
          <button class="btn btn-sm btn-default" onclick="restoreSnap('${s.id}', '${escHtml(s.snap_name)}')">Восстановить</button>
          <button class="btn btn-sm btn-default" onclick="setLabel('${s.id}')">Метка</button>
          <button class="btn btn-sm ${s.locked ? "btn-warning" : "btn-default"}" 
                  onclick="toggleLock('${s.id}', ${s.locked})">
            ${s.locked ? "Разблокировать" : "Заблокировать"}
          </button>
          <button class="btn btn-sm btn-danger" onclick="deleteSnap('${s.id}', '${escHtml(s.snap_name)}')">Удалить</button>
        </td>
      </tr>
    `).join("");
  }

  // ─── Действия со снапшотами ───────────────────────────────────────────────
  window.browsSnap = function(snapId) {
    runCmd(["rusnas-snap", "browse", snapId, "--json"])
      .then(out => {
        const data = JSON.parse(out);
        alert("Снапшот доступен по пути:\n" + data.mount_path + "\n\nАвтоматически размонтируется через 30 минут.");
      })
      .catch(err => showError("Ошибка монтирования: " + err));
  };

  window.restoreSnap = function(snapId, snapName) {
    pendingRestoreId = snapId;
    document.getElementById("restore-snap-name").textContent = snapName;
    document.getElementById("restore-subvol-name").textContent = currentSubvol;
    document.getElementById("modal-restore-confirm").style.display = "flex";
  };

  window.deleteSnap = function(snapId, snapName) {
    if (!confirm("Удалить снапшот " + snapName + "?\n\nЭто действие необратимо.")) return;
    runCmd(["rusnas-snap", "delete", snapId])
      .then(() => { showSuccess("Снапшот удалён"); loadSnapshots(); })
      .catch(err => showError("Ошибка удаления: " + err));
  };

  window.toggleLock = function(snapId, isLocked) {
    const cmd = isLocked ? "unlock" : "lock";
    runCmd(["rusnas-snap", cmd, snapId])
      .then(() => loadSnapshots())
      .catch(err => showError("Ошибка: " + err));
  };

  window.setLabel = function(snapId) {
    const label = prompt("Введите метку для снапшота:");
    if (label === null) return;
    runCmd(["rusnas-snap", "label", snapId, label])
      .then(() => loadSnapshots())
      .catch(err => showError("Ошибка: " + err));
  };

  // ─── Создание снапшота ────────────────────────────────────────────────────
  function setupButtons() {
    document.getElementById("btn-create-snap").addEventListener("click", () => {
      document.getElementById("modal-create-snap").style.display = "flex";
      // Предвыбрать текущий объект
      const sel = document.getElementById("modal-snap-subvol");
      if (sel && currentSubvol) sel.value = currentSubvol;
    });

    document.getElementById("modal-snap-cancel").addEventListener("click", () => {
      document.getElementById("modal-create-snap").style.display = "none";
    });

    document.getElementById("modal-snap-confirm").addEventListener("click", () => {
      const subvol = document.getElementById("modal-snap-subvol").value;
      const label = document.getElementById("modal-snap-label").value.trim();
      const args = ["rusnas-snap", "create", subvol];
      if (label) { args.push("--label"); args.push(label); }
      runCmd(args)
        .then(() => {
          document.getElementById("modal-create-snap").style.display = "none";
          document.getElementById("modal-snap-label").value = "";
          showSuccess("Снапшот создан");
          loadSnapshots();
        })
        .catch(err => showError("Ошибка создания снапшота: " + err));
    });

    document.getElementById("modal-restore-confirm-btn").addEventListener("click", () => {
      if (!pendingRestoreId) return;
      document.getElementById("modal-restore-confirm").style.display = "none";
      runCmd(["rusnas-snap", "restore", pendingRestoreId])
        .then(() => { showSuccess("Восстановление завершено успешно"); loadSnapshots(); })
        .catch(err => showError("Ошибка восстановления: " + err));
      pendingRestoreId = null;
    });

    document.getElementById("modal-restore-cancel").addEventListener("click", () => {
      document.getElementById("modal-restore-confirm").style.display = "none";
      pendingRestoreId = null;
    });
  }

  // ─── Расписание ───────────────────────────────────────────────────────────
  function loadSchedules() {
    runCmd(["rusnas-snap", "schedule", "list", "--json"])
      .then(out => { schedulesData = JSON.parse(out).schedules || []; })
      .catch(() => {});
  }

  function renderSchedules() {
    const el = document.getElementById("schedule-content");
    if (schedulesData.length === 0) {
      el.innerHTML = '<p>Расписания не настроены. Добавьте расписание для нужного объекта.</p>';
    }
    el.innerHTML = schedulesData.map(s => `
      <div class="schedule-card">
        <h4>${formatSubvolLabel(s.subvol_path)}</h4>
        <table class="table table-condensed">
          <tr><td>Расписание</td><td>${cronToHuman(s.cron_expr)}</td></tr>
          <tr><td>Активно</td><td>${s.enabled ? "✅ Да" : "❌ Нет"}</td></tr>
        </table>
        <button class="btn btn-sm btn-default" onclick="editSchedule('${s.subvol_path}')">Изменить</button>
        <button class="btn btn-sm ${s.enabled ? "btn-warning" : "btn-success"}" 
                onclick="toggleSchedule('${s.subvol_path}', ${s.enabled})">
          ${s.enabled ? "Отключить" : "Включить"}
        </button>
      </div>
    `).join("") + `
      <button class="btn btn-primary" onclick="addSchedule()">+ Добавить расписание</button>
    `;
  }

  function renderRetentionForms() {
    const el = document.getElementById("retention-content");
    if (!currentSubvol) { el.innerHTML = "<p>Выберите объект.</p>"; return; }
    const sched = schedulesData.find(s => s.subvol_path === currentSubvol);
    if (!sched) { el.innerHTML = "<p>Расписание не настроено.</p>"; return; }

    el.innerHTML = `
      <h4>Retention для: ${formatSubvolLabel(currentSubvol)}</h4>
      <form id="retention-form">
        <div class="ct-form-row">
          <label>Последние снапшоты (шт.)</label>
          <input type="number" name="retention_last" value="${sched.retention_last}" min="1" max="100">
        </div>
        <div class="ct-form-row">
          <label>Hourly (часов)</label>
          <input type="number" name="retention_hourly" value="${sched.retention_hourly}" min="0" max="168">
        </div>
        <div class="ct-form-row">
          <label>Daily (дней)</label>
          <input type="number" name="retention_daily" value="${sched.retention_daily}" min="0" max="365">
        </div>
        <div class="ct-form-row">
          <label>Weekly (недель)</label>
          <input type="number" name="retention_weekly" value="${sched.retention_weekly}" min="0" max="52">
        </div>
        <div class="ct-form-row">
          <label>Monthly (месяцев)</label>
          <input type="number" name="retention_monthly" value="${sched.retention_monthly}" min="0" max="36">
        </div>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </form>
    `;

    document.getElementById("retention-form").addEventListener("submit", function(e) {
      e.preventDefault();
      const fd = new FormData(this);
      const args = [
        "rusnas-snap", "schedule", "set", currentSubvol,
        "--cron", sched.cron_expr,
        "--retention-last",    fd.get("retention_last"),
        "--retention-hourly",  fd.get("retention_hourly"),
        "--retention-daily",   fd.get("retention_daily"),
        "--retention-weekly",  fd.get("retention_weekly"),
        "--retention-monthly", fd.get("retention_monthly"),
      ];
      runCmd(args)
        .then(() => { showSuccess("Retention сохранён"); loadSchedules(); })
        .catch(err => showError("Ошибка: " + err));
    });
  }

  // ─── Лог событий ─────────────────────────────────────────────────────────
  function loadEvents() {
    runCmd(["rusnas-snap", "events", "--json", "--limit", "50"])
      .then(out => {
        const data = JSON.parse(out);
        const el = document.getElementById("restore-log");
        if (!data.events || data.events.length === 0) {
          el.innerHTML = "<p>Событий нет.</p>"; return;
        }
        el.innerHTML = `
          <table class="table table-condensed">
            <thead><tr><th>Время</th><th>Тип</th><th>Объект</th><th>Сообщение</th></tr></thead>
            <tbody>
              ${data.events.map(ev => `
                <tr>
                  <td>${formatDate(ev.created_at)}</td>
                  <td><span class="badge badge-${ev.event_type}">${ev.event_type}</span></td>
                  <td>${ev.subvol_path || "—"}</td>
                  <td>${escHtml(ev.message || "")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `;
      })
      .catch(err => showError("Ошибка загрузки событий: " + err));
  }

  // ─── Утилиты ──────────────────────────────────────────────────────────────
  function runCmd(args) {
    return new Promise((resolve, reject) => {
      const proc = cockpit.spawn(["sudo"].concat(args), { err: "out" });
      let output = "";
      proc.stream(data => { output += data; });
      proc.then(() => resolve(output)).catch(err => reject(err));
    });
  }

  function formatDate(isoStr) {
    if (!isoStr) return "—";
    const d = new Date(isoStr);
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "short", year: "numeric",
                                        hour: "2-digit", minute: "2-digit" });
  }

  function formatAge(isoStr) {
    if (!isoStr) return "—";
    const diff = Date.now() - new Date(isoStr).getTime();
    const h = Math.floor(diff / 3600000);
    if (h < 1) return "только что";
    if (h < 24) return h + "ч назад";
    return Math.floor(h / 24) + "д назад";
  }

  function cronToHuman(expr) {
    if (expr === "0 * * * *")   return "Каждый час";
    if (expr === "0 0 * * *")   return "Каждый день в 00:00";
    if (expr === "0 0 * * 0")   return "Каждую неделю (вс 00:00)";
    if (expr === "0 0 1 * *")   return "Каждый месяц (1-е число)";
    return expr;
  }

  function escHtml(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function showSuccess(msg) {
    // Использует стандартный cockpit notifications если доступен
    if (cockpit.notify) { cockpit.notify(msg, { type: "success" }); return; }
    alert("✅ " + msg);
  }

  function showError(msg) {
    if (cockpit.notify) { cockpit.notify(msg, { type: "danger" }); return; }
    alert("❌ " + msg);
  }

})();
```

---

## 8. Ansible роль: rusnas_snapshots

### 8.1 Структура роли

```
roles/rusnas_snapshots/
  tasks/
    main.yml
  files/
    rusnas-snap          ← Python скрипт (CLI)
    rusnas-snapd.service
    rusnas-snapd.timer
    99rusnas-snapshot    ← apt hook
  templates/
    default-schedule.json.j2
  defaults/
    main.yml
```

### 8.2 defaults/main.yml

```yaml
rusnas_snapshots_volumes:
  - subvol_path: "/mnt/md0/shares/documents"
    cron: "0 0 * * *"
    retention_last: 10
    retention_hourly: 24
    retention_daily: 14
    retention_weekly: 8
    retention_monthly: 6
    notify_email: true
    notify_telegram: true

rusnas_snapshot_db_path: "/var/lib/rusnas/snaps.db"
```

### 8.3 tasks/main.yml

```yaml
---
- name: Install dependencies
  apt:
    name:
      - python3
      - python3-croniter
      - btrfs-progs
    state: present

- name: Create /var/lib/rusnas directory
  file:
    path: /var/lib/rusnas
    state: directory
    owner: root
    group: root
    mode: "0750"

- name: Deploy rusnas-snap CLI
  copy:
    src: rusnas-snap
    dest: /usr/local/bin/rusnas-snap
    owner: root
    group: root
    mode: "0755"

- name: Deploy systemd service and timer
  copy:
    src: "{{ item }}"
    dest: "/etc/systemd/system/{{ item }}"
  loop:
    - rusnas-snapd.service
    - rusnas-snapd.timer
  notify: systemd reload

- name: Deploy apt pre-update hook
  copy:
    src: 99rusnas-snapshot
    dest: /etc/apt/apt.conf.d/99rusnas-snapshot
    mode: "0644"

- name: Initialize snapshot database
  command: /usr/local/bin/rusnas-snap init-db
  args:
    creates: "{{ rusnas_snapshot_db_path }}"

- name: Configure schedules for each volume
  command: >
    rusnas-snap schedule set {{ item.subvol_path }}
    --cron "{{ item.cron }}"
    --retention-last {{ item.retention_last }}
    --retention-hourly {{ item.retention_hourly }}
    --retention-daily {{ item.retention_daily }}
    --retention-weekly {{ item.retention_weekly }}
    --retention-monthly {{ item.retention_monthly }}
  loop: "{{ rusnas_snapshots_volumes }}"

- name: Enable and start rusnas-snapd timer
  systemd:
    name: rusnas-snapd.timer
    enabled: true
    state: started
    daemon_reload: true

- name: Deploy Cockpit UI files
  copy:
    src: "{{ item.src }}"
    dest: "{{ item.dest }}"
    mode: "0644"
  loop:
    - { src: "snapshots.html", dest: "/usr/share/cockpit/rusnas/snapshots.html" }
    - { src: "snapshots.js",   dest: "/usr/share/cockpit/rusnas/js/snapshots.js" }

- name: Add Snapshots to Cockpit manifest
  # Обновить manifest.json: добавить раздел snapshots
  # Использовать jq или Python для патчинга JSON
  command: >
    python3 -c "
    import json, sys
    with open('/usr/share/cockpit/rusnas/manifest.json') as f:
        m = json.load(f)
    m['pages']['snapshots'] = {'label': 'Снапшоты', 'order': 4, 'path': 'snapshots.html'}
    with open('/usr/share/cockpit/rusnas/manifest.json', 'w') as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    "
  args:
    creates: /tmp/.snap-manifest-patched  # не идемпотентно, нужен check
```

### 8.4 Handlers

```yaml
# roles/rusnas_snapshots/handlers/main.yml
---
- name: systemd reload
  systemd:
    daemon_reload: true
```

---

## 9. Sudo права (sudoers)

Cockpit запускает команды от имени пользователя `rusnas`. Нужно разрешить `rusnas-snap` без пароля:

**`/etc/sudoers.d/rusnas-snap`:**
```
rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-snap
```

---

## 10. Порядок реализации (рекомендуемый)

### Этап 1: Основа (MVP)
1. Написать `rusnas-snap` Python скрипт с командами: `init-db`, `create`, `list`, `delete`
2. Протестировать на VM: создать subvolume, сделать снапшот, убедиться что появился в `.snapshots/`
3. Проверить запись в SQLite

### Этап 2: Retention и расписание
4. Добавить команды: `schedule set`, `schedule list`, `scheduled-run`, `retention`
5. Развернуть systemd timer
6. Проверить что снапшоты создаются по расписанию и удаляются по retention

### Этап 3: Restore и browse
7. Добавить команды: `restore`, `restore-file`, `browse`, `browse-umount`
8. Протестировать restore: изменить файл, восстановить, убедиться что файл вернулся
9. Протестировать browse: смонтировать снапшот, прочитать файл

### Этап 4: Cockpit UI
10. Создать `snapshots.html` + `snapshots.js`
11. Добавить в `manifest.json`
12. Протестировать в браузере: создание, просмотр списка, удаление, restore через UI

### Этап 5: Ansible и CI
13. Упаковать в роль `rusnas_snapshots`
14. Протестировать полный деплой на чистую VM через Ansible
15. Добавить pre-update hook

---

## 11. Тесты (checklist для ручной проверки)

```bash
# 1. Создание снапшота вручную
rusnas-snap create /mnt/md0/shares/documents --label "test snap"
# Ожидаем: JSON с id и snap_path, директория создана на диске

# 2. Список снапшотов
rusnas-snap list /mnt/md0/shares/documents --json | python3 -m json.tool
# Ожидаем: массив snapshots, total_count > 0

# 3. Retention — создать 20 снапшотов, настроить keep_last=5, запустить retention
for i in $(seq 1 20); do rusnas-snap create /mnt/md0/shares/documents; sleep 1; done
rusnas-snap schedule set /mnt/md0/shares/documents --cron "0 * * * *" --retention-last 5 \
  --retention-hourly 0 --retention-daily 0 --retention-weekly 0 --retention-monthly 0
rusnas-snap retention /mnt/md0/shares/documents
rusnas-snap list /mnt/md0/shares/documents --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['total_count'])"
# Ожидаем: 5

# 4. Lock защищает от retention
rusnas-snap lock <snap_id>
rusnas-snap retention /mnt/md0/shares/documents
# Locked снапшот должен остаться

# 5. Browse
rusnas-snap browse <snap_id> --json
# Ожидаем: {"mount_path": "/tmp/rusnas-snap-browse/<snap_id>"}
ls /tmp/rusnas-snap-browse/<snap_id>/   # должны быть файлы из снапшота

# 6. Restore
echo "original" > /mnt/md0/shares/documents/testfile.txt
rusnas-snap create /mnt/md0/shares/documents --label "before change"
SNAP_ID=$(rusnas-snap list /mnt/md0/shares/documents --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['snapshots'][0]['id'])")
echo "changed" > /mnt/md0/shares/documents/testfile.txt
rusnas-snap restore $SNAP_ID
cat /mnt/md0/shares/documents/testfile.txt
# Ожидаем: "original"

# 7. Pre-update hook
apt-get --simulate upgrade
# В логах должно быть: rusnas-snap pre-update-all
```

---

## 12. Обработка ошибок и edge cases

| Ситуация | Поведение |
|---------|-----------|
| subvol_path не является Btrfs subvolume | `create` завершается с ошибкой, сообщение в stderr |
| Нет места на диске | `create` завершается с ошибкой, запись в events с type=error, уведомление |
| Снапшот уже смонтирован | `browse` возвращает существующий mount_path |
| Объект занят при restore | Предупреждение, но restore продолжается (admin responsibility) |
| SQLite заблокирован | Retry 3 раза с задержкой 100ms, затем ошибка |
| btrfs subvolume delete зависает | Timeout 60s, запись ошибки, продолжение retention для следующих снапшотов |
| Снапшот есть в БД но нет на диске | `list` помечает как `valid=0`, UI показывает (orphan) |

---

## 13. Конфигурационный файл (опционально)

**`/etc/rusnas/snapshots.conf`** (INI):
```ini
[general]
db_path = /var/lib/rusnas/snaps.db
browse_base = /tmp/rusnas-snap-browse
browse_ttl = 1800
log_level = INFO

[notifications]
email_command = /usr/local/bin/rusnas-notify email
telegram_command = /usr/local/bin/rusnas-notify telegram
```

---

## Итог

Данный документ описывает полную реализацию системы снапшотов для rusNAS:

- **`rusnas-snap`** — единый CLI для всех операций (Python 3, ~400 строк)
- **`rusnas-snapd.timer`** — systemd timer, запуск каждые 5 минут
- **SQLite** — хранение метаданных, лог событий, расписания
- **Cockpit UI** — `snapshots.html` + `snapshots.js`, интеграция через `cockpit.spawn()`
- **Ansible роль** — полный деплой на чистую VM
- **Smart Retention** — алгоритм с 5 окнами хранения, защита locked снапшотов
- **Pre-update hook** — автоснапшот перед каждым `apt upgrade`

## Implementation Notes

<!-- ОБНОВЛЯЕТСЯ Claude Code при каждом изменении модуля -->

### Key Architecture Notes

- CLI: `/usr/local/bin/rusnas-snap` — Python 3, all output as JSON to stdout, log to stderr
- DB: `/var/lib/rusnas/snaps.db` — SQLite WAL, tables: `snapshots`, `schedules`, `events`
- Timer: `rusnas-snapd.timer` (every 5 min) -> `rusnas-snap scheduled-run`
- Apt hook: `/etc/apt/apt.conf.d/99rusnas-snapshot` — `pre-update-all` before `apt upgrade`
- Snapshot layout: `/mnt/btrfspool/.snapshots/shares__public/@2026-03-14_03-03-40_manual`
- Sudoers: `rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-snap`
- Btrfs on test VM: loop image at `/var/lib/rusnas/btrfs-pool.img` mounted at `/mnt/btrfspool`

### Critical snapshots.js Notes

- `schedule list` / `events` do NOT accept `--json` flag (always output JSON) — omit it
- `cockpit.spawn` uses `err: "message"` to keep stderr separate from JSON stdout
- `loadSubvols()` uses `schedule list` paths directly — skips `findBtrfsSubvols()` (bash not in sudoers NOPASSWD)
- `safeJson()` does `JSON.parse(str)` directly on clean stdout
- `replication list` returns `{tasks:[...], ok:true}` — parse as `data.tasks`
- Replication tab: infographic HTML is STATIC (before `#replication-content`); no JS rendering for it

### Replication Architecture (2026-03-23)

- CLI: `rusnas-snap replication set/list/delete/run/check-ssh` (DB table: `replication_tasks`)
- Transport: `btrfs send [-p <parent>] | ssh user@host btrfs receive /path`
- First run: full transfer; subsequent: incremental (`-p <last_sent_snap>`)
- Scheduled via `rusnas-snapd.service` second `ExecStart=/usr/local/bin/rusnas-snap replication run-all`
- SSH keys must be pre-configured by admin; UI only takes host/user/path
