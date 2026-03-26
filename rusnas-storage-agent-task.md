lf# rusNAS Storage Engineer Agent — ТЗ на реализацию MVP

> Статус: **к реализации**
> Приоритет: **высокий** — первый AI-агент, фундамент для OpsCopilot
> Зависимости: dashboard.js (метрики), disks.js (SMART/RAID), rusnas-snap (снапшоты), metrics_server.py
> Расположение в UI: новый раздел **«AI»** в Cockpit, страница `ai.html`

---

## 1. Цель MVP

Реализовать **проактивного** Storage Engineer Agent, который:
1. Предсказывает отказ дисков по трендам SMART (за 1–4 недели)
2. Прогнозирует заполнение томов (горизонт 7/30/90 дней)
3. Даёт архитектурные рекомендации по RAID при создании/расширении
4. Подбирает оптимальное время для scrub
5. Аудитирует текущую конфигурацию хранилища
6. Отображает всё это в Cockpit UI с карточками рекомендаций

**Без LLM.** Только rule-based + линейная регрессия. CPU only, ~30 MB RAM.

---

## 2. Архитектура

```
┌──────────────────────────────────────────────────────────┐
│ Cockpit UI: ai.html + js/ai.js                          │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ Health Score ██████████░░ 78/100                     │ │
│ │ Рекомендации (карточки с действиями)                 │ │
│ │ Агенты (статус, последний запуск)                    │ │
│ └──────────────────────────────────────────────────────┘ │
└─────────────────────────┬────────────────────────────────┘
                          │ cockpit.spawn(["sudo", "rusnas-agent", ...])
┌─────────────────────────▼────────────────────────────────┐
│ /usr/local/bin/rusnas-agent  (Python 3, CLI)             │
│                                                          │
│ Подкоманды:                                              │
│   storage analyze        — полный анализ (все проверки)  │
│   storage smart-check    — только SMART                  │
│   storage capacity       — только прогноз ёмкости        │
│   storage raid-check     — только RAID-рекомендации      │
│   storage scrub-check    — только scrub                  │
│   storage audit          — аудит конфигурации            │
│   health                 — агрегированный Health Score    │
│   recommendations        — список активных рекомендаций  │
│   history                — история проверок              │
└──────────┬───────────────────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────────────────┐
│ SQLite: /var/lib/rusnas/agent.db                         │
│                                                          │
│ Таблицы:                                                 │
│   smart_history     — исторические значения SMART-атрибутов │
│   capacity_history  — исторические значения ёмкости      │
│   recommendations   — активные рекомендации              │
│   check_runs        — лог запусков проверок              │
└──────────────────────────────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────────────────┐
│ systemd timer: rusnas-agent.timer (каждые 6 часов)       │
│ ExecStart: /usr/local/bin/rusnas-agent storage analyze   │
└──────────────────────────────────────────────────────────┘
```

---

## 3. База данных

### 3.1 Файл: `/var/lib/rusnas/agent.db`

```sql
-- История SMART-атрибутов (для trend analysis)
CREATE TABLE IF NOT EXISTS smart_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device      TEXT NOT NULL,          -- sdb, nvme0n1
    attr_id     INTEGER NOT NULL,       -- SMART attribute ID (5, 187, 197, 198...)
    attr_name   TEXT NOT NULL,          -- Reallocated_Sector_Ct, Reported_Uncorrect...
    raw_value   INTEGER NOT NULL,       -- raw value
    collected_at TEXT NOT NULL           -- ISO8601
);
CREATE INDEX IF NOT EXISTS idx_smart_dev_attr ON smart_history(device, attr_id, collected_at);

-- История ёмкости томов (для capacity forecast)
CREATE TABLE IF NOT EXISTS capacity_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mount_point TEXT NOT NULL,           -- /mnt/md0
    total_bytes INTEGER NOT NULL,
    used_bytes  INTEGER NOT NULL,
    collected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cap_mount ON capacity_history(mount_point, collected_at);

-- Активные рекомендации
CREATE TABLE IF NOT EXISTS recommendations (
    id          TEXT PRIMARY KEY,        -- rec_sea_001_sdb
    agent       TEXT NOT NULL DEFAULT 'sea',
    category    TEXT NOT NULL,           -- smart, capacity, raid, scrub, audit
    severity    TEXT NOT NULL,           -- critical, high, medium, low, info
    title       TEXT NOT NULL,
    message     TEXT NOT NULL,
    details     TEXT DEFAULT '{}',       -- JSON: device, volume, metrics, etc.
    action_type TEXT DEFAULT '',         -- link, command, info
    action_data TEXT DEFAULT '',         -- URL или команда
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    dismissed   INTEGER DEFAULT 0,       -- 1 = пользователь скрыл
    resolved    INTEGER DEFAULT 0        -- 1 = проблема устранена
);

-- Лог запусков проверок
CREATE TABLE IF NOT EXISTS check_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    check_type  TEXT NOT NULL,           -- smart, capacity, raid, scrub, audit, full
    status      TEXT NOT NULL,           -- ok, warning, error
    summary     TEXT NOT NULL,           -- краткий результат
    duration_ms INTEGER,
    run_at      TEXT NOT NULL
);
```

---

## 4. SMART Predictive Analysis

### 4.1 Сбор данных

Каждые 6 часов (`rusnas-agent storage smart-check`):

```bash
# Для каждого физического диска:
sudo smartctl -A /dev/sdX        # атрибуты
sudo smartctl -H /dev/sdX        # overall health
sudo smartctl -l error /dev/sdX  # error log count
```

### 4.2 Критические SMART-атрибуты

| ID | Имя | Порог warning | Порог critical | Описание |
|----|-----|---------------|----------------|----------|
| 5 | Reallocated_Sector_Ct | > 0 | > 50 | Переназначенные сектора |
| 10 | Spin_Retry_Count | > 0 | > 5 | Попытки раскрутки |
| 187 | Reported_Uncorrect | > 0 | > 10 | Некорректируемые ошибки |
| 188 | Command_Timeout | > 0 | > 50 | Таймауты команд |
| 196 | Reallocated_Event_Count | > 0 | > 10 | События переназначения |
| 197 | Current_Pending_Sector | > 0 | > 5 | Ожидающие переназначения |
| 198 | Offline_Uncorrectable | > 0 | > 5 | Некорректируемые оффлайн |
| 199 | UDMA_CRC_Error_Count | > 50 | > 200 | Ошибки кабеля/контроллера |

Для NVMe (через `smartctl -A`):
| Поле | Порог warning | Порог critical |
|------|---------------|----------------|
| Media_and_Data_Integrity_Errors | > 0 | > 10 |
| Percentage Used | > 80% | > 95% |
| Available Spare | < 20% | < 5% |

### 4.3 Trend Analysis (предсказание отказа)

```python
def predict_disk_failure(device: str, history: list[dict]) -> dict:
    """
    Анализирует тренд SMART-атрибутов за последние 30 дней.
    Возвращает предсказание.
    
    history: [{attr_id, raw_value, collected_at}, ...]
    """
    # Для каждого критического атрибута:
    for attr_id in CRITICAL_ATTRS:
        values = [h for h in history if h['attr_id'] == attr_id]
        if len(values) < 4:  # минимум 4 точки для тренда (24 часа)
            continue
        
        # Линейная регрессия: y = mx + b
        # x = hours_since_first, y = raw_value
        x = [(parse_time(v['collected_at']) - t0).total_seconds() / 3600 for v in values]
        y = [v['raw_value'] for v in values]
        m, b = linear_regression(x, y)
        
        current = y[-1]
        trend_per_month = m * 24 * 30  # экстраполяция на месяц
        
        if current > 0 and trend_per_month > 0:
            # Оценка: при текущем тренде через сколько дней дойдёт до critical
            critical_threshold = CRITICAL_THRESHOLDS[attr_id]
            if current >= critical_threshold:
                return {
                    "status": "critical",
                    "prediction": f"Диск {device} требует немедленной замены",
                    "confidence": 0.95,
                    "days_remaining": 0,
                    "attr": ATTR_NAMES[attr_id],
                    "current": current,
                    "trend": trend_per_month,
                }
            days_to_critical = (critical_threshold - current) / (m * 24) if m > 0 else None
            if days_to_critical and days_to_critical < 30:
                return {
                    "status": "warning",
                    "prediction": f"Отказ через ~{int(days_to_critical)} дней",
                    "confidence": min(0.5 + len(values) * 0.02, 0.9),
                    "days_remaining": int(days_to_critical),
                    "attr": ATTR_NAMES[attr_id],
                    "current": current,
                    "trend": round(trend_per_month, 1),
                }
    
    return {"status": "ok", "prediction": "Диск в норме", "confidence": 0.8}
```

### 4.4 Генерация рекомендаций

При обнаружении деградации:

```python
# severity: critical
{
    "id": "rec_sea_smart_sdb",
    "category": "smart",
    "severity": "critical",
    "title": "Диск sdb: прогноз отказа через ~14 дней",
    "message": "Атрибут Reallocated_Sector_Ct растёт со скоростью +12/месяц. "
               "Текущее значение: 48. Критический порог: 50. "
               "Рекомендация: подготовить замену (модель: WDC WD40EFRX, S/N: WD-WCC4N).",
    "details": {
        "device": "sdb",
        "model": "WDC WD40EFRX",
        "serial": "WD-WCC4N5HN7XJP",
        "attr_id": 5,
        "attr_name": "Reallocated_Sector_Ct",
        "current_value": 48,
        "trend_per_month": 12,
        "days_remaining": 14,
        "in_array": "md0",
        "array_level": "raid5",
        "backup_status": "ok"  # проверить наличие свежего снапшота
    },
    "action_type": "link",
    "action_data": "/rusnas/#/disks"  # ссылка на страницу Диски
}
```

---

## 5. Capacity Forecast

### 5.1 Сбор данных

Каждые 6 часов записывать в `capacity_history`:

```python
def collect_capacity():
    """Собрать текущую ёмкость всех Btrfs-томов."""
    result = subprocess.run(
        ["findmnt", "--real", "-rno", "TARGET,FSTYPE,SIZE,USED"],
        capture_output=True, text=True
    )
    for line in result.stdout.strip().splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[1] == "btrfs":
            mount = parts[0]
            # btrfs filesystem usage (более точно)
            usage = subprocess.run(
                ["btrfs", "filesystem", "usage", "-b", mount],
                capture_output=True, text=True
            )
            total, used = parse_btrfs_usage(usage.stdout)
            # Записать в БД
            insert_capacity(mount, total, used)
```

### 5.2 Прогнозирование

```python
def forecast_capacity(mount_point: str, horizon_days: int = 90) -> dict:
    """
    Линейная регрессия по history за последние 30 дней.
    Прогноз: через сколько дней том заполнится.
    """
    history = query_capacity_history(mount_point, days=30)
    if len(history) < 4:
        return {"status": "insufficient_data", "message": "Недостаточно данных (нужно минимум 24 часа)"}
    
    x = [hours_since_first(h) for h in history]
    y = [h['used_bytes'] for h in history]
    m, b = linear_regression(x, y)
    
    total = history[-1]['total_bytes']
    current_used = history[-1]['used_bytes']
    current_pct = current_used / total * 100
    
    # Тренд: байт в день
    trend_bytes_per_day = m * 24
    trend_gb_per_day = trend_bytes_per_day / (1024**3)
    
    # Дней до заполнения (95% — оставляем 5% резерв)
    free = total * 0.95 - current_used
    days_remaining = free / trend_bytes_per_day if trend_bytes_per_day > 0 else None
    
    # Severity
    if days_remaining is None or days_remaining > 180:
        severity = "ok"
    elif days_remaining > 90:
        severity = "info"
    elif days_remaining > 30:
        severity = "medium"
    elif days_remaining > 7:
        severity = "high"
    else:
        severity = "critical"
    
    return {
        "mount_point": mount_point,
        "total_bytes": total,
        "used_bytes": current_used,
        "used_pct": round(current_pct, 1),
        "trend_gb_per_day": round(trend_gb_per_day, 2),
        "days_remaining": int(days_remaining) if days_remaining else None,
        "severity": severity,
        "forecast": {
            "7d": round(current_pct + trend_bytes_per_day * 7 / total * 100, 1),
            "30d": round(current_pct + trend_bytes_per_day * 30 / total * 100, 1),
            "90d": round(current_pct + trend_bytes_per_day * 90 / total * 100, 1),
        },
    }
```

### 5.3 Рекомендации

```python
# severity: high
{
    "id": "rec_sea_cap_md0",
    "category": "capacity",
    "severity": "high",
    "title": "Том /mnt/md0 заполнится через 47 дней",
    "message": "Текущее заполнение: 76%. Рост: +2.3 ГБ/день. "
               "Через 7 дней: 79%. Через 30 дней: 89%.\n"
               "Рекомендации:\n"
               "1. Проверить крупные файлы (Storage Analyzer)\n"
               "2. Очистить старые снапшоты\n"
               "3. Настроить квоты\n"
               "4. Расширить массив (добавить диск)",
    "details": {
        "mount_point": "/mnt/md0",
        "used_pct": 76.2,
        "trend_gb_per_day": 2.3,
        "days_remaining": 47,
        "forecast_7d": 79.1,
        "forecast_30d": 88.9,
        "snapshot_usage_pct": 12.3
    },
    "action_type": "link",
    "action_data": "/rusnas/#/storage-analyzer"
}
```

---

## 6. RAID Advisory

### 6.1 Проверки при каждом запуске

```python
def check_raid() -> list[dict]:
    """Анализ RAID-массивов, генерация рекомендаций."""
    recommendations = []
    
    mdstat = parse_mdstat(read_file("/proc/mdstat"))
    
    for array in mdstat:
        # 1. RAID5 + большие диски = долгий rebuild → рекомендовать RAID6
        if array['level'] == 'raid5' and array['total_devices'] >= 4:
            # Оценка времени rebuild
            disk_size = get_disk_size(array['devices'][0])  # bytes
            rebuild_hours = estimate_rebuild_time(disk_size, array['total_devices'])
            
            if rebuild_hours > 8:
                recommendations.append({
                    "id": f"rec_sea_raid_{array['name']}",
                    "category": "raid",
                    "severity": "medium",
                    "title": f"Массив {array['name']}: рекомендуется миграция на RAID6",
                    "message": f"RAID5 с {array['total_devices']} дисками по "
                               f"{human_bytes(disk_size)}. Ребилд при отказе: ~{rebuild_hours}ч. "
                               f"Во время ребилда данные не защищены от второго отказа.\n"
                               f"RAID6 обеспечивает защиту от двойного отказа.",
                    "details": {
                        "array": array['name'],
                        "level": "raid5",
                        "devices": array['total_devices'],
                        "disk_size": disk_size,
                        "rebuild_hours": rebuild_hours,
                        "recommended_level": "raid6",
                    },
                })
        
        # 2. Degraded массив
        if array['status'] == 'degraded':
            recommendations.append({
                "id": f"rec_sea_degraded_{array['name']}",
                "category": "raid",
                "severity": "critical",
                "title": f"Массив {array['name']} деградирован!",
                "message": f"Активных дисков: {array['active_devices']}/{array['total_devices']}. "
                           f"Данные под угрозой. Немедленно замените отказавший диск.",
                "action_type": "link",
                "action_data": "/rusnas/#/disks",
            })
        
        # 3. Массив без горячей замены (no hot-spare)
        # Проверить: есть ли свободные диски не в массиве?
        
        # 4. RAID0 / JBOD — предупреждение о потере данных
        if array['level'] in ('raid0', 'linear'):
            recommendations.append({
                "id": f"rec_sea_raid0_{array['name']}",
                "category": "raid",
                "severity": "high",
                "title": f"Массив {array['name']} ({array['level'].upper()}) без избыточности",
                "message": "При отказе любого диска ВСЕ данные будут потеряны. "
                           "Убедитесь, что настроена репликация на внешнее хранилище.",
            })
    
    return recommendations


def estimate_rebuild_time(disk_size_bytes: int, num_devices: int) -> int:
    """Оценка времени ребилда в часах.
    Средняя скорость ребилда: ~100 MB/s для HDD, ~400 MB/s для SSD.
    При нагрузке скорость падает до ~50 MB/s.
    """
    # Pessimistic: 50 MB/s на HDD под нагрузкой
    speed_bytes_per_sec = 50 * 1024 * 1024
    data_to_rebuild = disk_size_bytes  # для RAID5/6 ~ 1 disk capacity
    seconds = data_to_rebuild / speed_bytes_per_sec
    return int(seconds / 3600) + 1
```

---

## 7. Scrub Scheduling

### 7.1 Проверка

```python
def check_scrub() -> list[dict]:
    """Проверить, когда последний раз запускался scrub."""
    recommendations = []
    
    mounts = get_btrfs_mounts()
    for mount in mounts:
        result = subprocess.run(
            ["btrfs", "scrub", "status", mount],
            capture_output=True, text=True
        )
        
        # Парсинг: "Scrub started:    Thu Mar 20 03:00:00 2026"
        # Парсинг: "Status:           finished"
        last_scrub_date = parse_scrub_date(result.stdout)
        days_since_scrub = (datetime.now() - last_scrub_date).days if last_scrub_date else None
        
        if days_since_scrub is None or days_since_scrub > 30:
            # Анализ нагрузки: подобрать оптимальное время
            # По /proc/diskstats за последние 24h найти окно минимальной нагрузки
            optimal_window = find_low_load_window()
            
            recommendations.append({
                "id": f"rec_sea_scrub_{mount.replace('/', '_')}",
                "category": "scrub",
                "severity": "medium",
                "title": f"Scrub не запускался {days_since_scrub or '?'} дней для {mount}",
                "message": f"Btrfs scrub проверяет целостность данных и исправляет ошибки. "
                           f"Рекомендуется запускать каждые 2–4 недели.\n"
                           f"Оптимальное время: {optimal_window} (минимальная нагрузка на диски).",
                "details": {
                    "mount_point": mount,
                    "days_since_scrub": days_since_scrub,
                    "optimal_window": optimal_window,
                },
                "action_type": "command",
                "action_data": f"btrfs scrub start {mount}",
            })
    
    return recommendations
```

---

## 8. Storage Configuration Audit

### 8.1 Правила аудита (YAML)

Файл: `/etc/rusnas/agent-rules.d/storage-audit.yaml`

```yaml
rules:
  - id: AUD-001
    name: "Снапшоты не настроены"
    severity: high
    check: |
      # Для каждого Btrfs-тома проверить наличие расписания в rusnas-snap
      rusnas-snap schedule list 2>/dev/null | python3 -c "
      import sys, json
      data = json.load(sys.stdin)
      mounts = set()
      for s in data:
          mounts.add(s.get('subvol_path','').split('/')[0:3])
      # Если том не имеет ни одного расписания
      "
    recommendation: "Настройте автоматические снапшоты для защиты данных"
    action_type: link
    action_data: "/rusnas/#/snapshots"

  - id: AUD-002
    name: "Нет offsite-репликации"
    severity: high
    check_command: "rusnas-snap replication list"
    condition: "result == '[]' or len(json.loads(result)) == 0"
    recommendation: "Данные хранятся только на одном устройстве. Настройте репликацию на внешний NAS."
    action_type: link
    action_data: "/rusnas/#/snapshots"

  - id: AUD-003
    name: "SSD-тир не подключён"
    severity: info
    check_command: "lvs --noheadings -o lv_attr 2>/dev/null | grep -c 'C' || echo 0"
    condition: "int(result.strip()) == 0"
    recommendation: "Подключение SSD в качестве кэш-уровня может ускорить работу на 30–50%"

  - id: AUD-004
    name: "RAID без hot-spare"
    severity: low
    check: "Проверить наличие свободных дисков не в массиве"
    recommendation: "Добавьте hot-spare диск для автоматического ребилда при отказе"

  - id: AUD-005
    name: "Btrfs quota не включены"
    severity: info
    check_command: "btrfs qgroup show {mount} 2>/dev/null"
    condition: "returncode != 0"
    recommendation: "Включите Btrfs qgroups для мониторинга использования по субволюмам"
```

---

## 9. Health Score

### 9.1 Алгоритм

```python
def calculate_health_score() -> dict:
    """Агрегированный Health Score 0–100."""
    
    score = 100
    details = {}
    
    # --- Storage (30 баллов) ---
    storage_score = 30
    recs = get_active_recommendations(category="smart")
    for r in recs:
        if r['severity'] == 'critical': storage_score -= 20
        elif r['severity'] == 'high': storage_score -= 10
        elif r['severity'] == 'medium': storage_score -= 5
    
    recs = get_active_recommendations(category="raid")
    for r in recs:
        if r['severity'] == 'critical': storage_score -= 20
        elif r['severity'] == 'high': storage_score -= 8
    
    recs = get_active_recommendations(category="capacity")
    for r in recs:
        if r['severity'] == 'critical': storage_score -= 15
        elif r['severity'] == 'high': storage_score -= 8
    
    recs = get_active_recommendations(category="scrub")
    for r in recs:
        storage_score -= 3
    
    storage_score = max(0, storage_score)
    details['storage'] = {"score": storage_score, "max": 30}
    
    # --- Backup (25 баллов) ---
    backup_score = 25
    recs = get_active_recommendations(category="audit")
    for r in recs:
        if 'снапшот' in r['title'].lower(): backup_score -= 10
        if 'реплика' in r['title'].lower(): backup_score -= 10
    backup_score = max(0, backup_score)
    details['backup'] = {"score": backup_score, "max": 25}
    
    total = storage_score + backup_score
    # Остальные категории (security, system, network) = +45 заглушка на MVP
    total += 45  # TODO: реализовать при добавлении агентов
    
    return {
        "score": min(100, max(0, total)),
        "details": details,
        "recommendations_count": {
            "critical": count_by_severity("critical"),
            "high": count_by_severity("high"),
            "medium": count_by_severity("medium"),
            "info": count_by_severity("info"),
        },
        "last_check": get_last_check_time(),
    }
```

---

## 10. CLI: rusnas-agent

### 10.1 Файл: `/usr/local/bin/rusnas-agent`

Python 3, `chmod +x`, shebang `#!/usr/bin/env python3`.

### 10.2 Формат вывода

Все подкоманды возвращают JSON на stdout. Ошибки — в stderr.

```bash
# Полный анализ (вызывается таймером каждые 6 часов)
sudo rusnas-agent storage analyze
# → {"ok": true, "checks": {"smart": {...}, "capacity": {...}, "raid": {...}, "scrub": {...}}, "new_recommendations": 3}

# Только SMART
sudo rusnas-agent storage smart-check
# → {"ok": true, "disks": [{"device": "sdb", "status": "warning", "prediction": "...", ...}]}

# Health Score
sudo rusnas-agent health
# → {"score": 78, "details": {...}, "recommendations_count": {...}}

# Активные рекомендации
sudo rusnas-agent recommendations
# → {"recommendations": [...], "total": 5}

# Отклонить рекомендацию
sudo rusnas-agent dismiss <rec_id>

# История проверок
sudo rusnas-agent history [--limit 20]
# → {"runs": [...]}
```

---

## 11. systemd

### 11.1 Timer

Файл: `/etc/systemd/system/rusnas-agent.timer`

```ini
[Unit]
Description=rusNAS Agent periodic analysis

[Timer]
OnCalendar=*-*-* 00/6:00:00
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
```

### 11.2 Service

Файл: `/etc/systemd/system/rusnas-agent.service`

```ini
[Unit]
Description=rusNAS Agent storage analysis
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/rusnas-agent storage analyze
Nice=19
IOSchedulingClass=idle
User=root
```

### 11.3 Sudoers

Файл: `/etc/sudoers.d/rusnas-agent`

```
rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-agent
```

---

## 12. Cockpit UI: страница AI

### 12.1 Файлы

```
cockpit/rusnas/
├── ai.html
├── js/ai.js
└── manifest.json  ← добавить страницу "ai" (order: 0, label: "🤖 AI")
```

### 12.2 Layout: ai.html

```
┌────────────────────────────────────────────────────────────┐
│ 🤖 AI Помощник                                [↻ Обновить]│
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌── Health Score ───────────────────────────────────────┐ │
│  │                                                       │ │
│  │  ██████████████████░░░░░ 78 / 100                    │ │
│  │                                                       │ │
│  │  🖴 Storage: 24/30  🛡 Security: —  💾 Backup: 18/25 │ │
│  │  ⚙ System: —      🌐 Network: —                     │ │
│  │                                                       │ │
│  │  Последняя проверка: 2 часа назад                    │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌── Рекомендации (5) ───────────────────────────────────┐ │
│  │                                                        │ │
│  │  ⛔ CRITICAL  Диск sdb: прогноз отказа через 14 дней  │ │
│  │     Reallocated_Sector_Ct: 48, тренд +12/мес          │ │
│  │     [Открыть Диски]  [Принято]                        │ │
│  │                                                        │ │
│  │  ⚠ HIGH  Том /mnt/md0 заполнится через 47 дней       │ │
│  │     76% занято, рост +2.3 ГБ/день                     │ │
│  │     [Storage Analyzer]  [Принято]                      │ │
│  │                                                        │ │
│  │  ⚠ HIGH  Нет offsite-репликации                       │ │
│  │     Данные хранятся только на одном устройстве        │ │
│  │     [Настроить]  [Принято]                             │ │
│  │                                                        │ │
│  │  ℹ MEDIUM  Scrub не запускался 32 дня                 │ │
│  │     Оптимальное время: суббота, 3:00                   │ │
│  │     [Запустить сейчас]  [Принято]                      │ │
│  │                                                        │ │
│  │  ℹ INFO  SSD-тир не подключён                         │ │
│  │     Ускорение на 30–50% при подключении NVMe           │ │
│  │     [Подробнее]  [Скрыть]                              │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌── Storage Engineer Agent ─────────────────────────────┐ │
│  │  Статус: ● активен  │  Последний запуск: 2ч назад    │ │
│  │  Проверок за 24ч: 4  │  Рекомендаций: 5               │ │
│  │                                                        │ │
│  │  Диски:     sda ✅  sdb ⚠  sdc ✅  nvme0n1 ✅        │ │
│  │  RAID:      md0 (RAID5) ✅ active                     │ │
│  │  Ёмкость:   /mnt/md0  76% [▓▓▓▓▓▓▓▓░░] → 95% к маю  │ │
│  │  Scrub:     32 дня назад ⚠                            │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌── История проверок ───────────────────────────────────┐ │
│  │  14:00  storage analyze  ✅ ok  (142ms)  3 рекомендации│ │
│  │  08:00  storage analyze  ✅ ok  (138ms)  3 рекомендации│ │
│  │  02:00  storage analyze  ✅ ok  (145ms)  2 рекомендации│ │
│  └────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

### 12.3 JavaScript: ai.js

```javascript
// Основные функции:

function loadHealthScore() {
    cockpit.spawn(["sudo", "rusnas-agent", "health"], {err: "message"})
        .done(function(out) {
            var data = JSON.parse(out);
            renderHealthScore(data);
        });
}

function loadRecommendations() {
    cockpit.spawn(["sudo", "rusnas-agent", "recommendations"], {err: "message"})
        .done(function(out) {
            var data = JSON.parse(out);
            renderRecommendations(data.recommendations);
        });
}

function dismissRecommendation(recId) {
    cockpit.spawn(["sudo", "rusnas-agent", "dismiss", recId], {err: "message"})
        .done(function() { loadRecommendations(); loadHealthScore(); });
}

function runAnalysis() {
    // Показать спиннер
    cockpit.spawn(["sudo", "rusnas-agent", "storage", "analyze"], {err: "message"})
        .done(function() {
            loadHealthScore();
            loadRecommendations();
            loadHistory();
        });
}

// Авто-обновление каждые 5 минут
setInterval(function() {
    loadHealthScore();
    loadRecommendations();
}, 300000);
```

---

## 13. manifest.json — добавить страницу AI

```json
{
    "ai": {
        "label": "🤖 AI",
        "order": 0,
        "path": "ai.html"
    }
}
```

> **Примечание:** order: 0 ставит AI первым в навигации. Если нужно после Dashboard — поставить order между dashboard и storage.

---

## 14. Ansible роль

### 14.1 Файл: `roles/rusnas-agent/tasks/main.yml`

```yaml
- name: Install rusnas-agent CLI
  copy:
    src: rusnas-agent
    dest: /usr/local/bin/rusnas-agent
    mode: '0755'

- name: Create agent data directory
  file:
    path: /var/lib/rusnas
    state: directory
    mode: '0755'

- name: Create agent rules directory
  file:
    path: /etc/rusnas/agent-rules.d
    state: directory
    mode: '0755'

- name: Deploy storage audit rules
  copy:
    src: storage-audit.yaml
    dest: /etc/rusnas/agent-rules.d/storage-audit.yaml

- name: Deploy sudoers
  copy:
    content: "rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-agent\n"
    dest: /etc/sudoers.d/rusnas-agent
    mode: '0440'

- name: Deploy systemd timer
  copy:
    src: "{{ item }}"
    dest: "/etc/systemd/system/{{ item }}"
  loop:
    - rusnas-agent.timer
    - rusnas-agent.service

- name: Enable and start timer
  systemd:
    name: rusnas-agent.timer
    enabled: yes
    state: started
    daemon_reload: yes

- name: Initialize agent database
  command: /usr/local/bin/rusnas-agent init-db
  changed_when: false
```

---

## 15. Линейная регрессия (pure Python, без numpy)

```python
def linear_regression(x: list[float], y: list[float]) -> tuple[float, float]:
    """Simple linear regression. Returns (slope, intercept)."""
    n = len(x)
    if n < 2:
        return (0.0, y[0] if y else 0.0)
    sum_x = sum(x)
    sum_y = sum(y)
    sum_xy = sum(xi * yi for xi, yi in zip(x, y))
    sum_x2 = sum(xi * xi for xi in x)
    denom = n * sum_x2 - sum_x * sum_x
    if denom == 0:
        return (0.0, sum_y / n)
    m = (n * sum_xy - sum_x * sum_y) / denom
    b = (sum_y - m * sum_x) / n
    return (m, b)
```

---

## 16. Чеклист реализации

- [ ] `rusnas-agent` CLI (Python 3, ~600–800 строк)
  - [ ] `init-db` — создание таблиц
  - [ ] `storage smart-check` — сбор SMART + trend analysis + рекомендации
  - [ ] `storage capacity` — сбор ёмкости + прогноз + рекомендации
  - [ ] `storage raid-check` — анализ RAID-массивов + рекомендации
  - [ ] `storage scrub-check` — проверка scrub schedule + рекомендации
  - [ ] `storage audit` — аудит конфигурации по правилам
  - [ ] `storage analyze` — вызов всех проверок
  - [ ] `health` — расчёт Health Score
  - [ ] `recommendations` — список активных рекомендаций
  - [ ] `dismiss` — скрыть рекомендацию
  - [ ] `history` — лог проверок
- [ ] SQLite schema (agent.db)
- [ ] systemd timer + service
- [ ] sudoers
- [ ] `ai.html` — разметка страницы AI
- [ ] `js/ai.js` — логика UI
  - [ ] Health Score bar + breakdown
  - [ ] Recommendation cards (severity-colored, action buttons)
  - [ ] Agent status panel
  - [ ] History table
  - [ ] Auto-refresh (5 min)
- [ ] manifest.json — добавить страницу AI
- [ ] Ansible роль `rusnas-agent`
- [ ] storage-audit.yaml — правила аудита
- [ ] `linear_regression()` — pure Python, без numpy
- [ ] Тестирование на VM (loop Btrfs image)

---

## 17. Тестирование

```bash
# 1. Инициализация
sudo rusnas-agent init-db

# 2. Первый запуск (заполняет историю)
sudo rusnas-agent storage analyze

# 3. Проверка Health Score
sudo rusnas-agent health

# 4. Список рекомендаций
sudo rusnas-agent recommendations

# 5. Имитация деградации: вручную вставить fake SMART history
# (для тестирования trend analysis без ожидания 24ч)

# 6. Проверка UI: открыть https://10.10.10.72:9090/rusnas/#/ai
```

---

*Данное ТЗ — полная спецификация для Claude Code. Все решения приняты, формат вывода определён, SQL-схема готова. Можно начинать реализацию.*
