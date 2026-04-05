 # ТЗ: rusNAS Storage Analyzer — Анализатор использования дискового пространства

**Версия:** 1.0  
**Статус:** Готово к реализации  
**Кодовое название:** `storage-analyzer`  
**Место в навигации:** Дашборд → клик на блок Storage → вкладка "Анализ пространства"

---

## 1. Контекст и назначение

### Проблема
Сейчас клик на блок Storage в дашборде ведёт на страницу управления RAID-массивом. Это нелогично: пользователь ожидает увидеть **куда уходит место**, а не технические параметры массива.

### Решение
Создать отдельную страницу `storage-analyzer.html` в Cockpit-плагине rusNAS с полным анализом использования дискового пространства. Клик на Storage-блок дашборда ведёт именно сюда.

### Целевая аудитория
SMB-администратор: 1–50 пользователей, 1–20 расшаренных папок, нет времени на консоль. Ему нужен **ответ на вопрос «почему место заканчивается и что с этим делать»** — за 30 секунд, без SSH.

---

## 2. Архитектура страницы

### 2.1 Структура URL / навигация

```
Cockpit-плагин rusNAS
├── dashboard.html          (главная)
│   └── клик Storage card → storage-analyzer.html
├── storage-analyzer.html   ← НОВЫЙ ФАЙЛ
│   ├── Вкладка: Обзор
│   ├── Вкладка: Шары
│   ├── Вкладка: Папки и файлы
│   ├── Вкладка: Пользователи
│   └── Вкладка: Типы файлов
├── storage.html            (управление RAID — остаётся)
└── ...
```

### 2.2 Технический стек

- **Фронтенд:** Vanilla JS + Cockpit API (без сторонних фреймворков) — как весь остальной плагин
- **Бэкенд:** Python CGI-скрипты в `/usr/share/cockpit/rusnas/cgi/` (аналогично текущим скриптам метрик)
- **Данные в реальном времени:** через `cockpit.spawn()` и `cockpit.file()`
- **Исторические данные:** SQLite база `/var/lib/rusnas/storage_history.db`
- **Фоновый сборщик:** systemd-таймер `rusnas-storage-collector.timer` (раз в час)
- **Визуализация:** SVG-графики без внешних библиотек (как sparklines в дашборде)
- **Treemap/sunburst:** реализовать через SVG или Canvas нативно

---

## 3. Экраны и компоненты

### 3.1 Заголовок страницы (Header Bar)

```
┌─────────────────────────────────────────────────────────────────┐
│  💾 Анализ пространства          [Сканировать сейчас] [⚙ Настройки]│
│  Последнее сканирование: сегодня 03:15  •  Время сканирования: 42с │
└─────────────────────────────────────────────────────────────────┘
```

**Элементы:**
- Кнопка «Сканировать сейчас» — запускает `rusnas-storage-scan` вручную, показывает прогресс-бар
- Индикатор времени последнего сканирования (данные свежие / устаревшие > 24ч — жёлтый/красный)
- Настройки: расписание сканирования (ежечасно / ежедневно / вручную), глубина сканирования, исключения

---

### 3.2 Вкладка 1: Обзор (Overview)

#### Блок A — Summary Cards (верхняя строка, 4 карточки)

```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  Всего       │ │  Занято      │ │  Свободно    │ │  Осталось ~  │
│  14.5 TB     │ │  11.2 TB     │ │  3.3 TB      │ │  47 дней     │
│              │ │  ████░ 77%   │ │  ░░░░█ 23%   │ │  по тренду 7д│
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

**Цветовая схема прогресс-бара:**
- 0–70% → зелёный  
- 70–85% → жёлтый  
- 85–95% → оранжевый  
- >95% → красный + мигающий

**Карточка «Осталось»:**
- Показывает три строки: `по тренду 24ч`, `по тренду 7д`, `по тренду 30д`
- Если тренд нет данных — «нет данных»
- Если место растёт (освобождается) — «↑ место освобождается»
- Жёлтый цвет: < 30 дней; красный: < 7 дней

#### Блок B — Карта томов (Volume Map)

```
┌─────────────────────────────────────────────────────────────────┐
│  Тома и массивы                                                  │
│  ┌─────────────────────────┐  ┌──────────────┐                  │
│  │  /volume1 (md0 + LVM)   │  │  /volume2    │                  │
│  │  10 TB  ████████░ 78%   │  │  4.5 TB ░ 5% │                  │
│  │  RAID6 • Btrfs          │  │  RAID1 • Ext4│                  │
│  └─────────────────────────┘  └──────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
```

Клик на том → фильтрует все нижние вкладки по этому тому.

#### Блок C — График заполнения (30 дней)

SVG-линейный график: ось X = дни, ось Y = % заполнения.  
Две линии: фактическое заполнение (синяя) + прогноз (пунктирная оранжевая).  
Маркер «Полный» на 95%.

```
100% ┤                                            ·····
 95% ┤─────────── критично ─────────────────────╌╌╌╌╌╌
 80% ┤                              ╭────────────
 60% ┤               ╭──────────────╯
 40% ┤   ╭───────────╯
     └──────────────────────────────────────────────
     -30д           -15д           сегодня     +14д
```

**Переключатель периода:** 7д / 30д / 90д / 180д

#### Блок D — Топ-5 «пожирателей» (Quick Wins)

Список с иконками и кнопками действий:

| # | Категория | Объём | Действие |
|---|-----------|-------|----------|
| 1 | 🎬 Видео в /shares/media | 2.1 TB | [Открыть в FileBrowser] |
| 2 | 💾 Резервные копии >6мес | 890 GB | [Показать файлы] |
| 3 | 📦 Дубликаты файлов | 340 GB | [Показать дубликаты] |
| 4 | 👤 Папки пользователя admin | 220 GB | [Показать] |
| 5 | 🗑 Корзины Samba (.recycle) | 45 GB | [Очистить] |

---

### 3.3 Вкладка 2: Шары (Shares)

#### Таблица шар с историей

| Шара | Путь | Занято | % от тома | Изменение 7д | Скорость роста |
|------|------|--------|-----------|--------------|----------------|
| backup | /volume1/backup | 4.2 TB | 42% | +180 GB ↑ | ~25 GB/день |
| media | /volume1/media | 2.8 TB | 28% | +5 GB → | ~700 MB/день |
| docs | /volume1/docs | 890 GB | 9% | -2 GB ↓ | освобождается |

**Клик на строку** → разворачивает inline-блок:

```
▼ backup  /volume1/backup
  ┌────────────────────────────────────────────┐
  │  📈 Динамика заполнения (30 дней)          │
  │  [SVG sparkline детализированный]          │
  │                                            │
  │  Прогноз: хватит ещё ~18 дней             │
  │  при текущей скорости роста +25 GB/день    │
  │                                            │
  │  [Открыть в FileBrowser] [Настроить квоту] │
  └────────────────────────────────────────────┘
```

#### Строка быстрого прогноза

Под таблицей — информационный блок:

```
⚠️  /volume1/backup заполнится через ~18 дней (≈ 4 апреля)
    при текущей скорости +25 GB/день
    [Установить уведомление] [Посмотреть крупные файлы]
```

---

### 3.4 Вкладка 3: Папки и файлы (File Explorer)

#### 3.4.1 Treemap-визуализация

Интерактивная treemap из прямоугольников. Размер прямоугольника = размер папки/файла.  
Цвет = тип файла (видео, документы, архивы, системные, прочее).

```
┌─────────────────────────────────────────────────────────────────┐
│  /volume1  [10 TB]       Навигация: volume1 > backup > 2024     │
│ ┌─────────────────────┬──────────────┬──────────┬──────────────┐│
│ │                     │              │          │  docs/       ││
│ │   backup/           │  media/      │ projects/│  890 GB      ││
│ │   4.2 TB            │  2.8 TB      │  1.1 TB  │              ││
│ │                     │              │          ├──────────────┤│
│ │                     ├──────────────┤          │  homes/      ││
│ │                     │  photos/     │          │  320 GB      ││
│ │                     │  600 GB      │          │              ││
│ └─────────────────────┴──────────────┴──────────┴──────────────┘│
│  [🎬 Видео] [📷 Фото] [📄 Документы] [📦 Архивы] [❓ Прочее]    │
└─────────────────────────────────────────────────────────────────┘
```

**Интерактивность:**
- Клик на прямоугольник → «провалиться» внутрь папки (drill-down)
- Breadcrumb-навигация сверху
- Hover → тултип с размером, количеством файлов, датой последнего изменения
- Кнопка «Открыть в FileBrowser» появляется при hover

#### 3.4.2 Список крупных файлов / папок

Переключатель: [Папки] / [Файлы]

**Режим «Папки»:**

| Папка | Размер | Файлов | Последнее изм. | Действие |
|-------|--------|--------|----------------|----------|
| /backup/2023 | 2.1 TB | 1,847 | 8 мес. назад | [Показать] |
| /media/raw_video | 1.4 TB | 234 | 2 года назад | [Открыть] |

**Режим «Файлы» — топ крупных файлов:**

| Файл | Размер | Путь | Дата изм. | Действие |
|------|--------|------|-----------|----------|
| backup_full.img | 890 GB | /backup/2023/ | 8 мес. назад | [Открыть папку] |
| project.vmdk | 240 GB | /projects/ | 1 год назад | [Открыть папку] |

**Фильтры:**
- По тому/шаре (dropdown)
- По типу файла (мультиселект)
- «Не изменялись > N месяцев» (ползунок: 3/6/12/24 мес.)
- «Размер > N GB» (input)

#### 3.4.3 Поиск дубликатов

Отдельная кнопка «Найти дубликаты» (ресурсоёмкая операция, запускается отдельно).  
Сравнение: по хэшу SHA256 + размеру файла.

Результат:

```
Найдено 847 групп дубликатов • Потенциальная экономия: 340 GB
┌──────────────────────────────────────────────────────────────┐
│  photo_vacation.jpg (3.2 MB) × 4 копии — потенциал: 9.6 MB  │
│  /homes/user1/photos/   /homes/user2/backup/   +2 ещё        │
│  [Показать все] [Оставить оригинал] [Оставить новейший]      │
└──────────────────────────────────────────────────────────────┘
```

---

### 3.5 Вкладка 4: Пользователи (Users)

#### Таблица использования по пользователям

| Пользователь | Занято | % от квоты | Квота | Изм. 7д | Топ-папка |
|-------------|--------|-----------|-------|---------|-----------|
| admin | 220 GB | нет квоты | — | +15 GB | /homes/admin |
| user1 | 45 GB | 45% | 100 GB | +2 GB | /homes/user1 |
| user2 | 98 GB | 98% | 100 GB ⚠️ | +8 GB | /homes/user2 |

**Строка с превышением выделяется красным.**

**Клик на пользователя** → inline-раскрытие:
- Breakdown по папкам этого пользователя
- Топ-5 файлов по размеру
- Кнопка «Установить/изменить квоту»

#### Блок квот

```
Квоты Btrfs qgroups
──────────────────────────────────────────────────
  user1    45 GB / 100 GB  ████░░░░░  45%
  user2    98 GB / 100 GB  █████████  98% ⚠️  [Расширить квоту]
  user3    12 GB / 50 GB   ██░░░░░░░  24%
```

Кнопка «Добавить квоту» → модальное окно с выбором пользователя и лимита.

> **Примечание реализации:** Используются Btrfs qgroups через `btrfs qgroup show` и `btrfs quota enable`. Mapping пользователей через `stat -c %u` + `/etc/passwd`.

---

### 3.6 Вкладка 5: Типы файлов (File Types)

#### Кольцевая диаграмма (Donut Chart)

SVG-диаграмма с легендой:

```
           ┌───────────────────────────────────┐
           │    ╭──────────────╮               │
           │   ╱   🎬 Видео    ╲              │
           │  │    4.2 TB 37%   │  📷 Фото     │
           │  │                 │  2.1 TB 19%  │
           │   ╲               ╱               │
           │    ╰──────────────╯  📄 Документы │
           │                      890 GB 8%    │
           │                      📦 Архивы    │
           │                      760 GB 7%    │
           │                      💾 Бэкапы   │
           │                      1.8 TB 16%   │
           │                      ❓ Прочее    │
           │                      1.3 TB 12%   │
           └───────────────────────────────────┘
```

**Категории файлов (настраиваемые):**

| Категория | Расширения по умолчанию |
|-----------|------------------------|
| Видео | mp4, mkv, avi, mov, wmv, ts, m2ts |
| Фото | jpg, jpeg, png, raw, cr2, nef, heic |
| Документы | pdf, doc, docx, xls, xlsx, odt |
| Архивы | zip, tar, gz, 7z, rar, iso |
| Бэкапы | img, bak, bkp, backup |
| Код | py, js, ts, go, rs, java, c, cpp, h |
| Прочее | всё остальное |

**Под диаграммой — детальная таблица:**

| Тип | Кол-во файлов | Объём | % | Изм. 7д |
|-----|--------------|-------|---|---------|
| Видео | 4,230 | 4.2 TB | 37% | +120 GB |
| Фото | 84,500 | 2.1 TB | 19% | +15 GB |

Клик на строку → переходит на вкладку «Папки и файлы» с фильтром по этому типу.

---

## 4. Бэкенд: сборщик данных

### 4.1 Системный сервис

**Файл:** `/etc/systemd/system/rusnas-storage-collector.timer`

```ini
[Unit]
Description=rusNAS Storage Analyzer — hourly collector

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

**Файл:** `/etc/systemd/system/rusnas-storage-collector.service`

```ini
[Unit]
Description=rusNAS Storage Analyzer Collector

[Service]
Type=oneshot
ExecStart=/usr/share/cockpit/rusnas/scripts/storage-collector.py
User=root
```

### 4.2 База данных SQLite

**Путь:** `/var/lib/rusnas/storage_history.db`

```sql
CREATE TABLE volume_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,             -- unix timestamp
    volume_path TEXT NOT NULL,       -- /volume1
    total_bytes INTEGER NOT NULL,
    used_bytes INTEGER NOT NULL,
    free_bytes INTEGER NOT NULL
);

CREATE TABLE share_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    share_name TEXT NOT NULL,
    path TEXT NOT NULL,
    used_bytes INTEGER NOT NULL,
    file_count INTEGER NOT NULL
);

CREATE TABLE user_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    username TEXT NOT NULL,
    uid INTEGER NOT NULL,
    used_bytes INTEGER NOT NULL
);

CREATE TABLE file_type_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    volume_path TEXT NOT NULL,
    file_type TEXT NOT NULL,   -- video/photo/docs/archive/backup/other
    used_bytes INTEGER NOT NULL,
    file_count INTEGER NOT NULL
);

-- Индексы для производительности
CREATE INDEX idx_volume_ts ON volume_snapshots(volume_path, ts);
CREATE INDEX idx_share_ts ON share_snapshots(share_name, ts);
CREATE INDEX idx_user_ts ON user_snapshots(username, ts);
```

### 4.3 Скрипт коллектора

**Файл:** `/usr/share/cockpit/rusnas/scripts/storage-collector.py`

Алгоритм:
1. Получить список томов через `df -B1 --output=source,size,used,avail,target`
2. Для каждой Samba-шары из `smb.conf` → `du -sb <path>` + `find <path> -type f | wc -l`
3. Пользователи → итерировать `/home/*` + настроенные home-папки, `du -sb`
4. Типы файлов → `find <volume> -type f` + классификация по расширению
5. Записать всё в SQLite
6. Обновить файл последнего сканирования: `/var/lib/rusnas/last_storage_scan`

**Оптимизации производительности:**
- `ionice -c3` для фоновой работы без влияния на I/O
- `nice -n 19` для CPU
- Для больших томов (>5 TB) использовать `btrfs subvolume list` + `btrfs filesystem du` вместо `find` — в 10–100 раз быстрее на Btrfs
- Кэш результатов в `/var/lib/rusnas/storage_cache.json` — отдаётся немедленно, пока идёт сканирование

### 4.4 CGI API-эндпоинты

Все эндпоинты: `/usr/share/cockpit/rusnas/cgi/storage-analyzer.py`

**GET /api/storage/overview**
```json
{
  "volumes": [{"path": "/volume1", "total": 10000000000, "used": 7800000000, "free": 2200000000, "raid": "RAID6", "fs": "btrfs"}],
  "forecast": {"days_24h": 47, "days_7d": 51, "days_30d": 43},
  "top_consumers": [{"type": "video", "path": "/shares/media", "bytes": 2100000000}],
  "last_scan": 1742150400,
  "scan_duration_seconds": 42
}
```

**GET /api/storage/shares?period=7d**
```json
{
  "shares": [
    {
      "name": "backup",
      "path": "/volume1/backup",
      "used_bytes": 4200000000,
      "file_count": 1847,
      "history": [{"ts": 1741545600, "bytes": 4020000000}, ...],
      "growth_rate_bytes_per_day": 25000000000,
      "forecast_days": 18
    }
  ]
}
```

**GET /api/storage/files?path=/volume1&sort=size&type=all&older_than=0**
```json
{
  "path": "/volume1",
  "entries": [
    {"name": "backup", "type": "dir", "bytes": 4200000000, "mtime": 1741545600, "files": 1847},
    {"name": "large_file.img", "type": "file", "bytes": 890000000000, "mtime": 1730000000}
  ]
}
```

**GET /api/storage/users**
```json
{
  "users": [
    {"username": "admin", "uid": 1000, "used_bytes": 220000000, "quota_bytes": null, "top_path": "/homes/admin", "history": [...]}
  ]
}
```

**GET /api/storage/filetypes**
```json
{
  "breakdown": [
    {"type": "video", "label": "Видео", "bytes": 4200000000, "count": 4230, "change_7d": 120000000}
  ]
}
```

**POST /api/storage/scan** — запустить сканирование вручную  
**GET /api/storage/scan/status** — статус сканирования (`idle` / `running` / `error`)  
**POST /api/storage/duplicates** — запустить поиск дубликатов (тяжёлая операция)

---

## 5. Алгоритм прогнозирования

### 5.1 Метод линейной регрессии (простой, надёжный)

```python
def forecast_days_remaining(history_points, free_bytes):
    """
    history_points: список (timestamp, used_bytes) за последние N дней
    free_bytes: текущее свободное место в байтах
    Возвращает: дней до заполнения (None если нет тренда или место убывает)
    """
    if len(history_points) < 2:
        return None
    
    # Линейная регрессия по МНК
    n = len(history_points)
    ts_list = [p[0] for p in history_points]
    bytes_list = [p[1] for p in history_points]
    
    # Нормализуем timestamps
    t0 = ts_list[0]
    xs = [(t - t0) / 86400 for t in ts_list]  # в днях
    
    # Коэффициенты прямой y = k*x + b
    mean_x = sum(xs) / n
    mean_y = sum(bytes_list) / n
    k = sum((xs[i] - mean_x) * (bytes_list[i] - mean_y) for i in range(n)) / \
        sum((xs[i] - mean_x) ** 2 for i in range(n))
    
    if k <= 0:  # место не растёт — прогноз не нужен
        return None
    
    # Через сколько дней заполнится
    days = free_bytes / k
    return round(days)
```

### 5.2 Три горизонта прогноза

- **24ч тренд:** данные за последние 24 часа (24 точки при ежечасном сборе)
- **7д тренд:** данные за 7 дней (168 точек)
- **30д тренд:** данные за 30 дней (720 точек) — наиболее стабильный

Отображать все три, выделять 7д-тренд как рекомендуемый.

### 5.3 Аномалии

Если скорость роста за последние 24ч > 3× обычной 7д-скорости — показывать предупреждение:

```
⚠️  Аномально высокий рост сегодня: +45 GB за 24ч
    (обычно: ~5 GB/день за последние 7 дней)
    Возможно: активная запись бэкапа, входящий трафик?
```

---

## 6. Реализация Treemap

### 6.1 Алгоритм Squarified Treemap

Реализовать алгоритм `squarify` в vanilla JS (~80 строк). Это стандартный алгоритм для создания красивых прямоугольных treemap.

```javascript
// Упрощённая реализация squarify
function squarify(items, x, y, w, h) {
    // items: [{label, value, color}]
    // Рекурсивно разбивает прямоугольник на вложенные
    // Возвращает: [{label, value, x, y, w, h}]
}
```

### 6.2 SVG-рендеринг

```javascript
function renderTreemap(containerId, data, width, height) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    
    const rects = squarify(data, 0, 0, width, height);
    rects.forEach(rect => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.style.cursor = 'pointer';
        
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', rect.x + 1);
        r.setAttribute('y', rect.y + 1);
        r.setAttribute('width', rect.w - 2);
        r.setAttribute('height', rect.h - 2);
        r.setAttribute('fill', rect.color);
        r.setAttribute('rx', '3');
        
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        // Показывать текст только если прямоугольник достаточно большой
        if (rect.w > 80 && rect.h > 40) {
            text.textContent = `${rect.label}\n${formatBytes(rect.value)}`;
        }
        
        g.addEventListener('click', () => drillDown(rect));
        g.addEventListener('mouseenter', () => showTooltip(rect));
        g.addEventListener('mouseleave', hideTooltip);
        
        g.appendChild(r);
        g.appendChild(text);
        svg.appendChild(g);
    });
    
    document.getElementById(containerId).appendChild(svg);
}
```

---

## 7. Настройки и уведомления

### 7.1 Страница настроек (модальное окно)

```
Настройки анализатора
─────────────────────────────────────────────
Расписание сканирования:
  ○ Каждый час
  ● Каждые 6 часов
  ○ Ежедневно в [03:00 ▼]
  ○ Только вручную

Глубина сканирования файлов:
  [●●●●○] Стандартная (без рекурсии в >5 уровней)

Исключить из сканирования:
  /volume1/.snapshots       [×]
  /volume1/tmp              [×]
  [+ Добавить путь]

Уведомления (Telegram / email — если настроены):
  ✅ Уведомлять при заполнении > [85]%
  ✅ Уведомлять при прогнозе < [14] дней
  ✅ Аномальный рост > [3×] обычной скорости
```

### 7.2 Интеграция с rusNAS-Guard

Если Guard активен и есть снапшоты — в Обзоре показывать блок:

```
🛡 Снапшоты Guard занимают: 450 GB (4.1% тома)
   Последний: сегодня 03:00  •  Хранится: 14 снапшотов
   [Управление снапшотами]
```

---

## 8. Файловая структура реализации

```
/usr/share/cockpit/rusnas/
├── storage-analyzer.html          # Главная страница модуля
├── storage-analyzer.js            # Логика фронтенда (~800 строк)
├── storage-analyzer.css           # Стили (treemap, donut, таблицы)
├── scripts/
│   ├── storage-collector.py       # Фоновый коллектор (запускается systemd)
│   └── storage-scan-on-demand.py  # Скрипт для ручного запуска
└── cgi/
    └── storage-analyzer.py        # CGI API handler

/etc/systemd/system/
├── rusnas-storage-collector.service
└── rusnas-storage-collector.timer

/var/lib/rusnas/
├── storage_history.db             # SQLite история
├── storage_cache.json             # Кэш последнего сканирования
└── last_storage_scan              # Timestamp последнего сканирования

/usr/share/cockpit/rusnas/manifest.json  # ДОПОЛНИТЬ: новая страница
```

### Обновление manifest.json

Добавить в `menu`:
```json
{
  "storage-analyzer": {
    "label": "Анализ пространства",
    "order": 15,
    "path": "storage-analyzer.html"
  }
}
```

Обновить дашборд: в функции клика на Storage-карточку заменить навигацию с `storage.html` на `storage-analyzer.html`.

---

## 9. Ansible роль

Создать роль `roles/storage-analyzer/`:

```yaml
# tasks/main.yml
- name: Install storage-analyzer files
  copy: src={{ item.src }} dest={{ item.dest }} mode={{ item.mode }}
  loop:
    - {src: storage-analyzer.html, dest: /usr/share/cockpit/rusnas/, mode: '0644'}
    - {src: storage-analyzer.js, dest: /usr/share/cockpit/rusnas/, mode: '0644'}
    - {src: storage-analyzer.css, dest: /usr/share/cockpit/rusnas/, mode: '0644'}
    - {src: storage-collector.py, dest: /usr/share/cockpit/rusnas/scripts/, mode: '0755'}
    - {src: storage-analyzer-cgi.py, dest: /usr/share/cockpit/rusnas/cgi/, mode: '0755'}

- name: Install systemd units
  copy: src={{ item }} dest=/etc/systemd/system/ mode='0644'
  loop: [rusnas-storage-collector.service, rusnas-storage-collector.timer]

- name: Create data directory
  file: path=/var/lib/rusnas state=directory mode='0750'

- name: Initialize SQLite database
  command: python3 /usr/share/cockpit/rusnas/scripts/storage-collector.py --init-db
  creates: /var/lib/rusnas/storage_history.db

- name: Enable and start timer
  systemd: name=rusnas-storage-collector.timer enabled=yes state=started daemon_reload=yes

- name: Run initial scan
  command: python3 /usr/share/cockpit/rusnas/scripts/storage-collector.py
  async: 300
  poll: 0
```

---

## 10. Сценарии использования

### Сценарий 1: «Дискозаканчивайка» (критичная ситуация)

**Контекст:** Утром приходит уведомление «место < 10%». Админ открывает Cockpit.

1. Главный дашборд → красная карточка Storage «2.1 TB / 23%»
2. Клик → Storage Analyzer, вкладка Обзор
3. Видит: «Осталось ~3 дня»
4. Блок «Топ пожирателей»: #1 — Резервные копии >6мес в /backup/2023, 2.1 TB
5. Клик [Показать файлы] → переход на вкладку «Папки», фильтр по /backup/2023 + дата >6мес
6. Видит список архивных бэкапов с датами
7. Клик [Открыть в FileBrowser] → удаляет ненужные файлы
8. Вернулся: Обзор показывает «Осталось ~47 дней»

**Время до решения: 5–7 минут без SSH.**

---

### Сценарий 2: «Кто съел место» (плановый мониторинг)

**Контекст:** Место уменьшается быстрее обычного, нужно понять причину.

1. Storage Analyzer → Вкладка «Шары»
2. Сортировка по «Изменение 7д» — первая строка: `projects`: +890 GB за неделю
3. Клик на строку → раскрывается график: резкий рост 3 дня назад
4. Вкладка «Папки», путь `/shares/projects` → treemap
5. Самый большой прямоугольник: `user3/renders/` — 750 GB
6. Вкладка «Пользователи» → user3: 780 GB без квоты
7. Устанавливает квоту 500 GB через [Установить квоту]
8. Уведомление пользователю через Samba (настраивается отдельно)

---

### Сценарий 3: «Оптимизация» (ежемесячная чистка)

**Контекст:** Плановая оптимизация — найти что можно удалить.

1. Вкладка «Типы файлов»
2. Видит: Видео 37% (4.2 TB), много — смотрит детали
3. Клик на «Видео» → переход на вкладку Папки с фильтром по видео
4. Фильтр «Не изменялись > 12 месяцев» → 1.8 TB видео-файлов без активности
5. Кнопка «Найти дубликаты» → 340 GB дубликатов во всех типах файлов
6. Экономия потенциальная: 2.1 TB
7. Открывает FileBrowser, удаляет по списку

---

### Сценарий 4: «Планирование расширения» (для руководителя)

**Контекст:** Нужно решить когда покупать новые диски.

1. Вкладка Обзор → График заполнения с прогнозом
2. Переключает на 90 дней
3. Видит: при текущем темпе место закончится через 73 дня
4. Смотрит по шарам: backup растёт +25 GB/день, media стабильна
5. Принимает решение: добавить 8 TB через 60 дней
6. Экспорт данных (CSV) для отчёта руководству

---

## 11. Приоритеты реализации

### Фаза 1 (MVP, ~1 неделя)
- [ ] Коллектор томов и шар (без файлов и пользователей) — быстрый
- [ ] SQLite история
- [ ] Вкладка «Обзор»: карточки + график заполнения
- [ ] Вкладка «Шары»: таблица с историей
- [ ] Прогнозирование (линейная регрессия)
- [ ] Связь с дашбордом (клик → переход)

### Фаза 2 (~1 неделя)
- [ ] Коллектор файлов (медленный, нужен ionice)
- [ ] Вкладка «Папки и файлы»: список топ-файлов + фильтры
- [ ] Treemap-визуализация
- [ ] Вкладка «Типы файлов»: donut chart

### Фаза 3 (~3–4 дня)
- [ ] Вкладка «Пользователи»
- [ ] Поиск дубликатов (тяжёлая операция, отдельный процесс)
- [ ] Настройки: расписание, исключения
- [ ] Интеграция уведомлений (Telegram/email — если настроены)
- [ ] Экспорт CSV

---

## 12. Особые требования и ограничения

### Производительность
- Страница должна открываться **мгновенно** — отдавать кэш, сканировать в фоне
- Скан тома 10 TB должен завершаться **< 5 минут** (использовать `btrfs filesystem du` на Btrfs)
- `find` использовать только если `btrfs fi du` недоступен

### Btrfs-специфика
- `du` на Btrfs может показывать некорректные данные с дедупликацией — использовать `btrfs filesystem du --summarize` для правильных размеров
- Снапшоты в `.snapshots` **исключить по умолчанию** из подсчёта пользовательских данных (они будут в отдельном блоке)
- Для qgroup-квот пользователей — `btrfs qgroup show <volume>` с привязкой к subvolume

### Безопасность
- CGI-скрипты выполняются от root (как и остальные в плагине)
- Cockpit-плагин ограничивает доступ своей авторизацией
- Путь к файлам в API валидировать: запрещать `../`, проверять на абсолютный путь внутри смонтированных томов

### Консистентность UI
- Цветовая схема: как в остальных страницах плагина (CSS-переменные Cockpit)
- Шрифты, отступы, кнопки — аналогичны storage.html и dashboard.html
- Таблицы — Bootstrap-стиль как везде в плагине

---

## Приложение A: Команды для сбора данных

```bash
# Объём томов
df -B1 --output=source,size,used,avail,target | grep -E '/volume|/mnt'

# Объём Btrfs (правильно, учитывает CoW)
btrfs filesystem du --summarize /volume1

# Размер шары (быстро)
du -sb --apparent-size /shares/backup

# Топ-10 папок по размеру
du -sh /volume1/* | sort -rh | head -10

# Размер по пользователям
find /homes -maxdepth 1 -mindepth 1 -type d -exec du -sb {} \;

# Типы файлов (статистика по расширениям)
find /volume1 -type f -name '*.*' | \
  awk -F. '{print $NF}' | \
  tr '[:upper:]' '[:lower:]' | \
  sort | uniq -c | sort -rn | head -20

# Старые файлы (не изменялись > 180 дней)
find /shares -type f -mtime +180 -ls | \
  awk '{sum+=$7; count++} END {print count, sum}'

# Дубликаты (через fdupes, если установлен)
fdupes -r -S /volume1 2>/dev/null | head -1000

# Альтернатива дубликатам без fdupes — через хэши
find /volume1 -type f -size +10M -exec md5sum {} \; | \
  sort | awk 'seen[$1]++ {print $2}'

# Btrfs qgroups (квоты пользователей)
btrfs qgroup show -reF /volume1

# Снапшоты Guard
btrfs subvolume list /volume1 | grep -i snapshot
```

---

## Приложение B: Цветовая схема типов файлов

| Тип | HEX | Описание |
|-----|-----|----------|
| Видео | `#E53935` | Красный |
| Фото | `#FB8C00` | Оранжевый |
| Документы | `#1E88E5` | Синий |
| Архивы | `#8E24AA` | Фиолетовый |
| Бэкапы | `#00897B` | Бирюзовый |
| Код | `#43A047` | Зелёный |
| Прочее | `#757575` | Серый |

---

*Документ подготовлен: март 2026*
*Следующий шаг: реализация Фазы 1 в Claude Code*

## Implementation Notes

<!-- ОБНОВЛЯЕТСЯ Claude Code при каждом изменении модуля -->

### Key Architecture Notes

- Navigation: Dashboard Storage card -> `storage-analyzer.html` (updated from `/rusnas/disks`)
- Backend collector: `/usr/share/cockpit/rusnas/scripts/storage-collector.py` — hourly systemd timer
- API script: `/usr/share/cockpit/rusnas/scripts/storage-analyzer-api.py` — 7 commands via argv
- DB: `/var/lib/rusnas/storage_history.db` — SQLite, 4 tables: volume_snapshots, share_snapshots, user_snapshots, file_type_snapshots
- Cache: `/var/lib/rusnas/storage_cache.json` — fast load, avoids re-scan on page open
- Sudoers: `/etc/sudoers.d/rusnas-storage` — NOPASSWD for both python3 scripts + du
- Timer: `rusnas-storage-collector.timer` (hourly, RandomizedDelaySec=300)
- API call pattern: `cockpit.spawn(['sudo', '-n', 'python3', SA_API, cmd, ...], { err: 'message', superuser: 'try' })`

### 5 Tabs

1. **Overview** — cards (total/used/free/forecast), volume map, fill chart (SVG), top consumers
2. **Shares** — shares table with inline expand + sparkline + forecast
3. **Files and Folders** — interactive treemap (squarified algo) + list view + filters
4. **Users** — usage by UID 1000-60000 with quota display
5. **File Types** — donut chart + table; click row -> jumps to Files tab with type filter

### Forecast Algorithm

Linear regression (least squares) over history points; `forecast_days(history_points, free_bytes)` in API script. Needs >=2 scan points to show forecast.

### Critical storage-analyzer.js Notes

- `saApi(args)` wraps cockpit.spawn in a Promise; streams stdout into `out` string, parses JSON on done
- `squarify()` + `squarifyRow()` implement squarified treemap recursively; `worstRatio()` decides when to start a new row
- `renderDonut()` draws SVG arc paths with gap between segments for donut chart
- Treemap navigation: `navigateTo(path)` updates `filePath` global and reloads files view
- `guessColor(entry)` classifies files by extension client-side for treemap coloring

### Critical storage-analyzer-api.py Notes

- `classify_ext()` and extension constants are defined INLINE in the api file (not imported from storage_collector_lib — module does not exist)
- `cmd_files(path, sort, ftype, older_than)`: when `ftype != "all"` — recursive `os.walk`, directories are skipped (avoids timeout from `du -sb`); files shown with rel-path from root
- When `ftype == "all"` — flat `os.listdir` with `du -sb` for directories (as before)
