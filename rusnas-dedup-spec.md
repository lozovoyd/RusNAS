# rusNAS — Cockpit Plugin: Страница «Дедупликация»

**Файл задачи для Claude Code**
Статус: **✅ РЕАЛИЗОВАН** (ветка `feature/dedup`, слита в `main` 2026-03-15)
Версия: v1.0
Зависимости: `duperemove` (v0.11.2 на Debian 13), `btrfs-progs`, Samba с поддержкой `vfs objects = btrfs`

---

## Статус реализации

| Компонент | Статус | Файл |
|-----------|--------|------|
| Cockpit UI (Как работает + Настройки) | ✅ | `cockpit/rusnas/dedup.html` |
| JavaScript логика | ✅ | `cockpit/rusnas/js/dedup.js` |
| Backend wrapper script | ✅ | `rusnas-dedup/rusnas-dedup-run.sh` |
| systemd сервис | ✅ | `rusnas-dedup/rusnas-dedup.service` |
| Deploy скрипт | ✅ | `install-dedup.sh` |
| Запись в manifest.json (order 7) | ✅ | `cockpit/rusnas/manifest.json` |

## Важные факты реализации

### duperemove v0.11.2 (Debian 13 Trixie)
Версия в репозитории Debian 13 — **v0.11.2**. НЕ поддерживает:
- `--min-size=N` (добавлено в v0.12+)
- `--hash=ALGO` (добавлено в v0.12+)

Поддерживаемые опции v0.11.2:
- `-r` — рекурсивный обход
- `-d` — де-дупликация
- `-h` `FILE` — файл хэшей (hashfile)
- `--dedupe-options=block|partial|same`
- `-A` — open files read-only mode

Конфиг должен содержать только валидные v0.11 аргументы: `--dedupe-options=block`

### Метрика экономии
НЕ использовать duperemove output для подсчёта экономии — он показывает только delta текущего прогона.
Использовать: `btrfs filesystem du -s $VOL | tail -1 | awk '{print $3}'` — **total shared extents** тома (суммирует reflinks + snapshots + duperemove).

### Парсинг smb.conf
`configparser` Python падает на inline-комментариях в smb.conf (`path = /data ; comment`).
Решение: писать Python regex-скрипт в `/tmp/rusnas_parse_smb.py` через `cockpit.file().replace()`, затем выполнять через `cockpit.spawn(["python3", "/tmp/..."])`.

### systemctl start для oneshot-сервиса
`systemctl start rusnas-dedup.service` **блокирует** до завершения сервиса (Type=oneshot).
В cockpit.spawn `.done()` срабатывает ПОСЛЕ того как dedup уже завершился. Поэтому:
1. Polling (5s interval) сразу находит сервис inactive
2. 800ms задержка перед `loadLastRun()` для надёжности
3. `setRunningState(false)` сразу очищает "Выполняется" → "—"

### Запись конфига
Всегда через `cockpit.file(path, {superuser:"require"}).replace(content)`.
НЕ через `echo "..." | sudo tee` — экранирование newlines ломает JSON.

---

## 1. Общая архитектура страницы

### 1.1 Место в меню Cockpit

Добавить новый пункт в `manifest.json`:

```json
{
  "label": "Дедупликация",
  "path": "dedup.html",
  "order": 4
}
```

Порядок меню после добавления:
1. Storage (order 1)
2. Disks & RAID (order 2)
3. Users (order 3)
4. **Дедупликация (order 4)** ← новый

### 1.2 Структура файлов

```
/usr/share/cockpit/rusnas/
├── dedup.html        ← новый
└── js/
    └── dedup.js      ← новый
```

### 1.3 Структура страницы

Страница состоит из трёх зон:

```
┌─────────────────────────────────────────┐
│  СТАТУС-БАР  (всегда виден)             │
│  Последний прогон · Экономия · Кнопка   │
├─────────────────────────────────────────┤
│  [Как работает] [Настройки]  ← вкладки  │
├─────────────────────────────────────────┤
│  КОНТЕНТ ВКЛАДКИ                        │
└─────────────────────────────────────────┘
```

---

## 2. Статус-бар (общий, над вкладками)

Всегда отображается вне зависимости от активной вкладки.

### 2.1 Карточки статуса

Четыре карточки в ряд (аналогично Dashboard):

| Карточка | Значение | Источник |
|----------|----------|----------|
| **Последний прогон** | дата + время (`14 мар, 03:15`) или «Ещё не запускался» | `/var/lib/rusnas/dedup-last.json` |
| **Сэкономлено** | человекочитаемый объём (`42.3 ГБ`) | из того же JSON |
| **Обработано файлов** | число (`18 420`) | из того же JSON |
| **Статус** | `Выполнен` / `Выполняется` / `Ошибка` / `Не настроен` | systemd unit + JSON |

Карточка «Статус»:
- `Выполнен` → зелёный индикатор
- `Выполняется` → оранжевый пульсирующий (анимация через CSS класс `pulsing`)
- `Ошибка` → красный, при клике — раскрывается лог ошибки
- `Не настроен` → серый, подсказка «Перейдите в Настройки»

### 2.2 Кнопки управления

Справа от карточек:

```
[▶ Запустить сейчас]  [⏸ Остановить]  [📋 Лог]
```

- **Запустить сейчас**: `systemctl start rusnas-dedup.service`; кнопка блокируется во время выполнения, появляется спиннер; по завершении карточки обновляются
- **Остановить**: `systemctl stop rusnas-dedup.service`; активна только во время `Выполняется`
- **Лог**: открывает модальное окно с последними 200 строками из `/var/log/rusnas/dedup.log` (прокручиваемый `<pre>`)

### 2.3 JSON-файл состояния

`/var/lib/rusnas/dedup-last.json` — создаётся/обновляется wrapper-скриптом (см. раздел 5):

```json
{
  "last_run_ts": 1741914900,
  "status": "success",
  "duration_sec": 1842,
  "files_scanned": 18420,
  "extents_merged": 3241,
  "saved_bytes": 45432897536,
  "error_msg": ""
}
```

---

## 3. Вкладка «Как работает»

### 3.1 Назначение

Объяснить пользователю (не разработчику) что такое дедупликация и как она работает в rusNAS. Без технических терминов типа «extents» или «COW». Страница должна выглядеть как информационная инфографика, а не лог.

### 3.2 Структура контента вкладки

#### Блок А — Инфографика «Три уровня дедупликации»

SVG-инфографика, встроенная в HTML (не внешний файл). Три колонки, каждая — отдельный уровень:

**Колонка 1 — «Умные копии» (Reflinks)**
- Иконка: два файла, соединённые пунктирной линией вместо стрелки
- Заголовок: «Умные копии»
- Подзаголовок: «Мгновенно · 0 байт»
- Описание: «Когда пользователь копирует файл внутри шары, на диске данные не дублируются — оба файла ссылаются на одни и те же блоки»

**Колонка 2 — «Сервер сам находит дубли» (duperemove)**
- Иконка: три одинаковых файла, стрелки сходятся к одному блоку на диске
- Заголовок: «Ночная дедупликация»
- Подзаголовок: «Автоматически · Каждую ночь»
- Описание: «Каждую ночь rusNAS сканирует все файлы и объединяет одинаковые блоки данных. Файлы остаются независимыми, но место освобождается»

**Колонка 3 — «При копировании через сеть» (vfs_btrfs)**
- Иконка: ноутбук → сервер, файл появляется без дублирования
- Заголовок: «Сетевые копии»
- Подзаголовок: «SMB · Без лишнего трафика»
- Описание: «При копировании файлов между папками через SMB-шару сервер выполняет операцию сам, без повторной передачи данных по сети»

Реализация SVG-инфографики:
- Ширина: 100%, viewBox 0 0 680 200
- Три равные колонки по 220px
- Разделители между колонками: вертикальная пунктирная линия
- Цветовая схема: колонка 1 — `c-purple`, колонка 2 — `c-teal`, колонка 3 — `c-blue`
- Иконки — простые SVG-path из 3–5 примитивов, не эмодзи
- Все тексты через классы `th` / `ts`

#### Блок Б — Временная шкала «Что происходит за сутки»

Горизонтальная шкала 24 часа (0:00 → 23:59). На ней отмечены события:

```
[0:00 ──────── 3:00 ──── 5:00 ──────────────────── 23:59]
               ↑          ↑
         Старт скана   Скан завершён
         duperemove    (+сохранён отчёт)
```

Реализация:
- SVG, viewBox 0 0 680 80
- Горизонтальная линия с делениями каждые 3 часа
- Время старта берётся из настроек (cron), по умолчанию 3:00
- Продолжительность из `dedup-last.json` → `duration_sec`
- Если дедуп не запускался — шкала пустая, надпись «Нет данных о прогонах»

#### Блок В — Текущая экономия (повтор из статус-бара, но визуально)

Два числа крупным шрифтом:
```
42.3 ГБ сэкономлено        18 420 файлов обработано
на этом устройстве
```

Под ними — простой bar chart (SVG, встроенный):
- История последних 7 прогонов (накопленная экономия по датам)
- Данные из `/var/lib/rusnas/dedup-history.json` (массив из 7 записей, ротируется wrapper-скриптом)
- Если меньше 7 прогонов — показываются доступные

`/var/lib/rusnas/dedup-history.json` формат:
```json
[
  { "date": "2026-03-14", "saved_bytes": 45432897536 },
  { "date": "2026-03-13", "saved_bytes": 43100000000 }
]
```

#### Блок Г — FAQ (раскрывающийся аккордеон)

Три вопроса, реализованные через `<details>/<summary>` (нативный HTML, без JS):

**«Безопасна ли дедупликация?»**  
Да. rusNAS использует только проверенные методы: данные никогда не удаляются — объединяются только указатели на одинаковые блоки. Если что-то пойдёт не так, файловая система Btrfs автоматически вернёт оригинальные данные.

**«Влияет ли это на скорость работы?»**  
Нет — для пользователей. Ночная дедупликация (duperemove) запускается в 3:00 и использует минимальные ресурсы. Умные копии (reflinks) работают мгновенно. Сетевая дедупликация ускоряет копирование, а не замедляет.

**«Можно ли отключить дедупликацию для конкретной папки?»**  
Да. На вкладке «Настройки» можно выбрать, для каких томов и шар включена дедупликация.

---

## 4. Вкладка «Настройки»

### 4.1 Секция: Расписание (duperemove cron)

Блок с заголовком «Ночная дедупликация (расписание)».

**Поля:**

| Поле | Тип | По умолчанию | Действие |
|------|-----|-------------|---------|
| Включена | toggle | выкл | Создаёт/удаляет `/etc/cron.d/rusnas-dedup` |
| Время запуска | `<select>` (00:00 … 06:00, шаг 30 мин) | 03:00 | Перезаписывает cron-файл |
| Дни недели | checkboxes (Пн…Вс) | Пн-Пт | Перезаписывает cron-файл |

Cron-файл `/etc/cron.d/rusnas-dedup`:
```
# rusNAS deduplication schedule — managed by Cockpit plugin, do not edit manually
0 3 * * 1-5 root /usr/local/bin/rusnas-dedup-run.sh >> /var/log/rusnas/dedup.log 2>&1
```

Сохранение: кнопка «Сохранить расписание» → `cockpit.spawn(['tee', '/etc/cron.d/rusnas-dedup'], { superuser: 'require' })` с содержимым файла.

Чтение текущего расписания при загрузке страницы: парсинг `/etc/cron.d/rusnas-dedup` если файл существует.

### 4.2 Секция: Тома для дедупликации

Заголовок: «На каких томах запускать дедупликацию»

Таблица смонтированных Btrfs-томов (получать через `findmnt -t btrfs -o TARGET,SOURCE --real -n`):

| Том | Путь | Включить |
|-----|------|---------|
| /mnt/data | /dev/md0 | ☑ |
| /mnt/backup | /dev/md1 | ☐ |

- Checkboxes состояние хранится в `/etc/rusnas/dedup-config.json`
- Wrapper-скрипт читает этот файл и итерируется только по включённым томам

`/etc/rusnas/dedup-config.json` формат:
```json
{
  "volumes": ["/mnt/data"],
  "samba_vfs_btrfs": true,
  "duperemove_args": "--dedupe-options=block",
  "schedule_enabled": true,
  "schedule_cron": "0 3 * * 1-5"
}
```

Кнопка «Сохранить» внизу секции.

### 4.3 Секция: SMB-дедупликация (vfs_btrfs)

Заголовок: «Дедупликация при копировании через SMB»

Описание (курсивом, небольшой шрифт): «При включённой опции копирование файлов между папками в SMB-шарах выполняется сервером без передачи данных по сети и без дублирования на диске.»

**Таблица шар** (получать из `smb.conf` — список секций кроме [global]):

| Шара | Путь | vfs_btrfs включён |
|------|------|------------------|
| documents | /mnt/data/documents | ☑ |
| backup | /mnt/data/backup | ☐ |

При включении для шары: добавить в секцию шары в `/etc/samba/smb.conf`:
```ini
vfs objects = btrfs
```
При выключении: удалить строку `vfs objects = btrfs` из секции.

Редактирование `smb.conf` — строго через `sed`, аналогично существующей логике в `storage.js`:
```bash
# Включить:
sed -i '/^\[sharename\]/,/^\[/{/vfs objects/d}' /etc/samba/smb.conf
sed -i '/^\[sharename\]/a\   vfs objects = btrfs' /etc/samba/smb.conf
# Выключить:
sed -i '/^\[sharename\]/,/^\[/{/vfs objects = btrfs/d}' /etc/samba/smb.conf
```
После изменений: `systemctl reload smbd`.

**Глобальный toggle** «Включить для всех шар» — применяет действие ко всем строкам таблицы сразу.

### 4.4 Секция: Дополнительные параметры duperemove

Заголовок: «Параметры duperemove (для опытных пользователей)»

Свёрнут по умолчанию (`<details>` без `open`).

| Параметр | Тип | По умолчанию | Описание |
|----------|-----|-------------|---------|
| Минимальный размер файла | number + select (КБ/МБ) | 128 КБ | `--min-size=N` |
| Hash алгоритм | select: xxhash / sha256 / sha1 | xxhash | `--hash=xxhash` |
| База данных хэшей | text (путь) | `/var/lib/rusnas/dedup.db` | `-h /path/to.db` |
| Использовать hash DB | toggle | вкл | Добавляет `-h` в команду |
| Дополнительные аргументы | text | пусто | Добавляются в конец команды |

Значения хранятся в `/etc/rusnas/dedup-config.json` → поле `duperemove_args` (собирается из параметров при сохранении).

Кнопка «Сохранить параметры».

---

## 5. Backend: wrapper-скрипт и systemd unit

### 5.1 Wrapper-скрипт `/usr/local/bin/rusnas-dedup-run.sh`

Должен быть создан Ansible-ролью (не Cockpit-плагином) и помещён на устройство при провизионинге. Cockpit только вызывает его.

```bash
#!/bin/bash
# rusNAS deduplication wrapper
# Управляется через Cockpit — не редактировать вручную

CONFIG="/etc/rusnas/dedup-config.json"
STATE_DIR="/var/lib/rusnas"
LOG="/var/log/rusnas/dedup.log"

mkdir -p "$STATE_DIR" "$(dirname "$LOG")"

# Читаем конфиг
VOLUMES=$(python3 -c "import json,sys; c=json.load(open('$CONFIG')); print(' '.join(c.get('volumes',[])))")
DEDUP_ARGS=$(python3 -c "import json,sys; c=json.load(open('$CONFIG')); print(c.get('duperemove_args','--dedupe-options=block'))")

if [ -z "$VOLUMES" ]; then
    echo "[$(date)] No volumes configured, exiting." >> "$LOG"
    exit 0
fi

START_TS=$(date +%s)
TOTAL_SAVED=0
TOTAL_FILES=0
STATUS="success"
ERROR_MSG=""

for VOL in $VOLUMES; do
    echo "[$(date)] Starting duperemove on $VOL" >> "$LOG"
    
    DB_PATH="$STATE_DIR/dedup-${VOL//\//-}.db"
    
    OUTPUT=$(duperemove -r -d -h "$DB_PATH" $DEDUP_ARGS "$VOL" 2>&1)
    EXIT_CODE=$?
    
    echo "$OUTPUT" >> "$LOG"
    
    if [ $EXIT_CODE -ne 0 ]; then
        STATUS="error"
        ERROR_MSG="duperemove exited with code $EXIT_CODE on $VOL"
    fi
    
    # Парсим сохранённое место из вывода duperemove
    SAVED=$(echo "$OUTPUT" | grep -oP 'Total bytes deduped: \K[0-9]+' || echo 0)
    FILES=$(echo "$OUTPUT" | grep -oP 'Files scanned: \K[0-9]+' || echo 0)
    TOTAL_SAVED=$((TOTAL_SAVED + SAVED))
    TOTAL_FILES=$((TOTAL_FILES + FILES))
done

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

# Пишем состояние
python3 - <<EOF
import json, time
state = {
    "last_run_ts": $END_TS,
    "status": "$STATUS",
    "duration_sec": $DURATION,
    "files_scanned": $TOTAL_FILES,
    "extents_merged": 0,
    "saved_bytes": $TOTAL_SAVED,
    "error_msg": "$ERROR_MSG"
}
with open("$STATE_DIR/dedup-last.json", "w") as f:
    json.dump(state, f)

# Обновляем историю (7 записей)
history_path = "$STATE_DIR/dedup-history.json"
try:
    history = json.load(open(history_path))
except:
    history = []

today = time.strftime("%Y-%m-%d")
existing = next((i for i,e in enumerate(history) if e["date"] == today), None)
entry = {"date": today, "saved_bytes": $TOTAL_SAVED}
if existing is not None:
    history[existing] = entry
else:
    history.insert(0, entry)
history = history[:7]

with open(history_path, "w") as f:
    json.dump(history, f)
EOF

echo "[$(date)] Deduplication complete. Saved: $TOTAL_SAVED bytes, Files: $TOTAL_FILES, Duration: ${DURATION}s" >> "$LOG"
```

### 5.2 Systemd service `/etc/systemd/system/rusnas-dedup.service`

```ini
[Unit]
Description=rusNAS Deduplication (duperemove)
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/rusnas-dedup-run.sh
StandardOutput=append:/var/log/rusnas/dedup.log
StandardError=append:/var/log/rusnas/dedup.log
Nice=19
IOSchedulingClass=idle

[Install]
WantedBy=multi-user.target
```

`Nice=19` и `IOSchedulingClass=idle` — критично, чтобы дедуп не мешал пользователям при ручном запуске днём.

---

## 6. Cockpit: считывание данных

### 6.1 При загрузке страницы (`dedup.js`)

```javascript
// 1. Загрузить статус последнего прогона
cockpit.spawn(['cat', '/var/lib/rusnas/dedup-last.json'])
    .then(data => renderStatusCards(JSON.parse(data)))
    .catch(() => renderStatusCards(null));  // файл не существует → «Ещё не запускался»

// 2. Загрузить историю для графика
cockpit.spawn(['cat', '/var/lib/rusnas/dedup-history.json'])
    .then(data => renderHistoryChart(JSON.parse(data)))
    .catch(() => renderHistoryChart([]));

// 3. Загрузить конфиг
cockpit.spawn(['cat', '/etc/rusnas/dedup-config.json'], { superuser: 'try' })
    .then(data => populateSettings(JSON.parse(data)))
    .catch(() => populateSettings({}));

// 4. Узнать статус systemd unit (Выполняется?)
cockpit.spawn(['systemctl', 'is-active', 'rusnas-dedup.service'])
    .then(status => updateRunningState(status.trim() === 'active'));

// 5. Список Btrfs томов для таблицы
cockpit.spawn(['findmnt', '-t', 'btrfs', '-o', 'TARGET,SOURCE', '--real', '-n'])
    .then(data => renderVolumeTable(data));

// 6. Список SMB шар из smb.conf
cockpit.spawn(['python3', '-c', `
import configparser, sys
c = configparser.ConfigParser()
c.read('/etc/samba/smb.conf')
shares = [s for s in c.sections() if s != 'global']
for s in shares:
    vfs = c.get(s, 'vfs objects', fallback='')
    path = c.get(s, 'path', fallback='')
    print(f"{s}|{path}|{'btrfs' in vfs}")
`], { superuser: 'try' })
    .then(data => renderSambaTable(data));
```

### 6.2 Polling во время выполнения

Пока `systemctl is-active rusnas-dedup.service` возвращает `active`:
- опрос каждые 5 секунд
- обновлять карточку «Статус» (анимация пульсации)
- кнопка «Запустить сейчас» → disabled, показывает спиннер
- кнопка «Остановить» → active

По завершении (статус != `active`):
- перечитать `dedup-last.json` и обновить все карточки
- убрать пульсацию

---

## 7. Файл `dedup.html` — структура разметки

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Дедупликация — rusNAS</title>
  <link rel="stylesheet" href="../base1/cockpit.css">
  <style>
    /* Карточки статуса */
    .status-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .status-card { background: var(--ct-color-white); border: 1px solid var(--ct-color-border); border-radius: 6px; padding: 16px; }
    .status-card .value { font-size: 24px; font-weight: 600; color: var(--ct-color-black); margin: 4px 0; }
    .status-card .label { font-size: 12px; color: var(--ct-color-subtle-text); }
    .status-ok { color: #3e8635; }
    .status-error { color: #c9190b; }
    .status-running { color: #f0ab00; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .pulsing { animation: pulse 1.5s ease-in-out infinite; }

    /* Вкладки */
    .tab-bar { display: flex; border-bottom: 1px solid var(--ct-color-border); margin-bottom: 20px; }
    .tab-btn { padding: 10px 20px; border: none; background: none; cursor: pointer; font-size: 14px; color: var(--ct-color-subtle-text); border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .tab-btn.active { color: var(--ct-color-black); border-bottom-color: var(--ct-color-action-primary); }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Таблицы настроек */
    .settings-section { background: var(--ct-color-white); border: 1px solid var(--ct-color-border); border-radius: 6px; padding: 20px; margin-bottom: 16px; }
    .settings-section h3 { margin: 0 0 16px; font-size: 16px; }
    .settings-table { width: 100%; border-collapse: collapse; }
    .settings-table th { text-align: left; font-weight: 500; font-size: 13px; color: var(--ct-color-subtle-text); padding: 8px 12px; border-bottom: 1px solid var(--ct-color-border); }
    .settings-table td { padding: 10px 12px; border-bottom: 1px solid var(--ct-color-border); font-size: 14px; }
    .settings-table tr:last-child td { border-bottom: none; }

    /* FAQ */
    .faq-item { border: 1px solid var(--ct-color-border); border-radius: 6px; margin-bottom: 8px; overflow: hidden; }
    .faq-item summary { padding: 14px 16px; cursor: pointer; font-weight: 500; font-size: 14px; list-style: none; display: flex; justify-content: space-between; align-items: center; }
    .faq-item summary::after { content: "+"; font-size: 18px; color: var(--ct-color-subtle-text); }
    .faq-item[open] summary::after { content: "−"; }
    .faq-item p { padding: 0 16px 14px; margin: 0; font-size: 14px; color: var(--ct-color-subtle-text); line-height: 1.6; }

    /* Bar chart история */
    .history-chart-bar { fill: var(--ct-color-action-primary); opacity: 0.7; }
    .history-chart-bar:hover { opacity: 1; }

    /* Кнопки управления */
    .action-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 20px; }
  </style>
</head>
<body>
<div id="app" style="padding: 20px; max-width: 1100px;">

  <!-- Статус-бар -->
  <div class="status-cards">
    <div class="status-card">
      <div class="label">Последний прогон</div>
      <div class="value" id="stat-last-run">—</div>
    </div>
    <div class="status-card">
      <div class="label">Сэкономлено</div>
      <div class="value" id="stat-saved">—</div>
    </div>
    <div class="status-card">
      <div class="label">Обработано файлов</div>
      <div class="value" id="stat-files">—</div>
    </div>
    <div class="status-card">
      <div class="label">Статус</div>
      <div class="value" id="stat-status">Не настроен</div>
    </div>
  </div>

  <!-- Кнопки управления -->
  <div class="action-bar">
    <button class="btn btn-primary" id="btn-run" onclick="runDedup()">▶ Запустить сейчас</button>
    <button class="btn btn-default" id="btn-stop" onclick="stopDedup()" disabled>⏸ Остановить</button>
    <button class="btn btn-default" onclick="showLog()">📋 Лог</button>
  </div>

  <!-- Вкладки -->
  <div class="tab-bar">
    <button class="tab-btn active" onclick="switchTab('tab-how')">Как работает</button>
    <button class="tab-btn" onclick="switchTab('tab-settings')">Настройки</button>
  </div>

  <!-- Вкладка: Как работает -->
  <div id="tab-how" class="tab-content active">

    <!-- Инфографика -->
    <div class="settings-section">
      <h3>Три уровня дедупликации в rusNAS</h3>
      <svg id="dedup-infographic" width="100%" viewBox="0 0 680 200">
        <!-- Реализуется в dedup.js через renderInfographic() -->
        <!-- Три колонки: reflinks / duperemove / vfs_btrfs -->
      </svg>
    </div>

    <!-- Временная шкала -->
    <div class="settings-section">
      <h3>Что происходит за сутки</h3>
      <svg id="timeline-chart" width="100%" viewBox="0 0 680 80">
        <!-- Реализуется в dedup.js через renderTimeline() -->
      </svg>
    </div>

    <!-- Статистика + история -->
    <div class="settings-section">
      <h3>Экономия за последние 7 дней</h3>
      <div style="display: flex; gap: 40px; margin-bottom: 20px; align-items: baseline;">
        <div>
          <div style="font-size: 36px; font-weight: 600;" id="big-saved">—</div>
          <div style="font-size: 13px; color: var(--ct-color-subtle-text);">сэкономлено</div>
        </div>
        <div>
          <div style="font-size: 36px; font-weight: 600;" id="big-files">—</div>
          <div style="font-size: 13px; color: var(--ct-color-subtle-text);">файлов обработано</div>
        </div>
      </div>
      <svg id="history-chart" width="100%" viewBox="0 0 680 120">
        <!-- Реализуется в dedup.js через renderHistoryChart() -->
      </svg>
    </div>

    <!-- FAQ -->
    <div class="settings-section">
      <h3>Частые вопросы</h3>
      <details class="faq-item">
        <summary>Безопасна ли дедупликация?</summary>
        <p>Да. rusNAS использует только проверенные методы: данные никогда не удаляются — объединяются только указатели на одинаковые блоки. Файловая система Btrfs автоматически защищает данные на каждом шаге.</p>
      </details>
      <details class="faq-item">
        <summary>Влияет ли это на скорость работы?</summary>
        <p>Нет. Ночная дедупликация запускается в 3:00 с минимальным приоритетом и не мешает работе пользователей. Умные копии работают мгновенно. Сетевая дедупликация ускоряет копирование.</p>
      </details>
      <details class="faq-item">
        <summary>Можно ли отключить дедупликацию для конкретной папки?</summary>
        <p>Да. На вкладке «Настройки» можно выбрать, для каких томов и шар включена дедупликация.</p>
      </details>
    </div>

  </div><!-- /tab-how -->

  <!-- Вкладка: Настройки -->
  <div id="tab-settings" class="tab-content">

    <!-- Расписание -->
    <div class="settings-section">
      <h3>Ночная дедупликация (расписание)</h3>
      <div style="display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap;">
        <label style="display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="sched-enabled"> Включена
        </label>
        <label>Время запуска:
          <select id="sched-time" style="margin-left: 8px;">
            <!-- 00:00 … 06:00 шаг 30 мин, генерируется JS -->
          </select>
        </label>
        <fieldset style="border: none; padding: 0; margin: 0;">
          <legend style="font-size: 13px; margin-bottom: 4px;">Дни:</legend>
          <div id="sched-days" style="display: flex; gap: 8px;">
            <!-- Пн…Вс checkboxes, генерируются JS -->
          </div>
        </fieldset>
      </div>
      <div style="margin-top: 16px;">
        <button class="btn btn-primary" onclick="saveSchedule()">Сохранить расписание</button>
      </div>
    </div>

    <!-- Тома -->
    <div class="settings-section">
      <h3>На каких томах запускать дедупликацию</h3>
      <table class="settings-table">
        <thead><tr><th>Путь</th><th>Устройство</th><th>Включить</th></tr></thead>
        <tbody id="volumes-table-body">
          <tr><td colspan="3" style="color: var(--ct-color-subtle-text);">Загрузка...</td></tr>
        </tbody>
      </table>
      <div style="margin-top: 16px;">
        <button class="btn btn-primary" onclick="saveVolumeConfig()">Сохранить</button>
      </div>
    </div>

    <!-- SMB шары -->
    <div class="settings-section">
      <h3>Дедупликация при копировании через SMB</h3>
      <p style="font-size: 13px; color: var(--ct-color-subtle-text); font-style: italic; margin-bottom: 16px;">
        При включённой опции копирование файлов между папками выполняется сервером без передачи данных по сети.
      </p>
      <div style="margin-bottom: 12px;">
        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
          <input type="checkbox" id="smb-all" onchange="toggleAllSmb(this.checked)"> Включить для всех шар
        </label>
      </div>
      <table class="settings-table">
        <thead><tr><th>Шара</th><th>Путь</th><th>vfs_btrfs</th></tr></thead>
        <tbody id="samba-table-body">
          <tr><td colspan="3" style="color: var(--ct-color-subtle-text);">Загрузка...</td></tr>
        </tbody>
      </table>
      <div style="margin-top: 16px;">
        <button class="btn btn-primary" onclick="saveSambaConfig()">Сохранить</button>
      </div>
    </div>

    <!-- Расширенные параметры -->
    <details class="settings-section" style="padding: 0;">
      <summary style="padding: 20px; cursor: pointer; font-size: 16px; font-weight: 500; list-style: none; display: flex; justify-content: space-between;">
        Параметры duperemove (для опытных пользователей)
        <span style="color: var(--ct-color-subtle-text); font-size: 13px; font-weight: 400;">▼</span>
      </summary>
      <div style="padding: 0 20px 20px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; width: 220px; font-size: 14px; color: var(--ct-color-subtle-text);">Минимальный размер файла</td>
            <td><input type="number" id="min-size-val" value="128" style="width: 80px; margin-right: 8px;">
                <select id="min-size-unit"><option>КБ</option><option>МБ</option></select></td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-size: 14px; color: var(--ct-color-subtle-text);">Hash алгоритм</td>
            <td><select id="hash-algo"><option value="xxhash">xxhash (быстрее)</option><option value="sha256">sha256 (надёжнее)</option></select></td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-size: 14px; color: var(--ct-color-subtle-text);">База хэшей</td>
            <td>
              <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                <input type="checkbox" id="use-hashdb" checked> Использовать базу хэшей
              </label>
              <input type="text" id="hashdb-path" value="/var/lib/rusnas/dedup.db" style="width: 100%; max-width: 400px; font-family: monospace; font-size: 13px;">
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-size: 14px; color: var(--ct-color-subtle-text);">Доп. аргументы</td>
            <td><input type="text" id="extra-args" placeholder="--dedupe-options=block" style="width: 100%; max-width: 400px; font-family: monospace; font-size: 13px;"></td>
          </tr>
        </table>
        <div style="margin-top: 16px;">
          <button class="btn btn-primary" onclick="saveAdvancedConfig()">Сохранить параметры</button>
        </div>
      </div>
    </details>

  </div><!-- /tab-settings -->

</div><!-- /app -->

<!-- Модальное окно: лог -->
<div id="log-modal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:1000; align-items:center; justify-content:center;">
  <div style="background:white; border-radius:8px; padding:24px; width:80%; max-width:800px; max-height:80vh; display:flex; flex-direction:column;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
      <h3 style="margin:0;">Лог дедупликации</h3>
      <button class="btn btn-default" onclick="document.getElementById('log-modal').style.display='none'">✕ Закрыть</button>
    </div>
    <pre id="log-content" style="flex:1; overflow:auto; background:#1a1a1a; color:#d4d4d4; padding:16px; border-radius:4px; font-size:12px; margin:0;"></pre>
  </div>
</div>

<script src="../base1/cockpit.js"></script>
<script src="js/dedup.js"></script>
</body>
</html>
```

---

## 8. Ansible-роль: `roles/dedup`

Роль создаётся в монорепо при провизионинге.

### 8.1 `roles/dedup/tasks/main.yml`

```yaml
- name: Install duperemove
  apt:
    name: duperemove
    state: present

- name: Create rusNAS directories
  file:
    path: "{{ item }}"
    state: directory
    mode: '0755'
  loop:
    - /etc/rusnas
    - /var/lib/rusnas
    - /var/log/rusnas

- name: Deploy dedup wrapper script
  copy:
    src: rusnas-dedup-run.sh
    dest: /usr/local/bin/rusnas-dedup-run.sh
    mode: '0755'

- name: Deploy systemd service
  copy:
    src: rusnas-dedup.service
    dest: /etc/systemd/system/rusnas-dedup.service
  notify: reload systemd

- name: Deploy default dedup config
  copy:
    content: |
      {
        "volumes": [],
        "samba_vfs_btrfs": false,
        "duperemove_args": "--dedupe-options=block",
        "schedule_enabled": false,
        "schedule_cron": "0 3 * * 1-5"
      }
    dest: /etc/rusnas/dedup-config.json
    force: no  # не перезаписывать если уже есть

- name: Add dedup page to Cockpit plugin
  # Копирует dedup.html и js/dedup.js в /usr/share/cockpit/rusnas/
  copy:
    src: "{{ item.src }}"
    dest: "{{ item.dest }}"
  loop:
    - { src: dedup.html, dest: /usr/share/cockpit/rusnas/dedup.html }
    - { src: dedup.js,   dest: /usr/share/cockpit/rusnas/js/dedup.js }

- name: Update manifest.json to add Deduplication menu item
  # Используем Python для безопасного редактирования JSON
  shell: |
    python3 -c "
    import json
    path = '/usr/share/cockpit/rusnas/manifest.json'
    m = json.load(open(path))
    entries = m.get('menu', m.get('dashboard', {}))
    entries['dedup'] = {'label': 'Дедупликация', 'path': 'dedup.html', 'order': 4}
    json.dump(m, open(path, 'w'), ensure_ascii=False, indent=2)
    "
  notify: restart cockpit
```

---

## 9. Проверочный чеклист для Claude Code

После реализации убедиться:

- [ ] Страница открывается без JS-ошибок в консоли браузера
- [ ] При отсутствии `dedup-last.json` карточки показывают «—» (не крашатся)
- [ ] При отсутствии `dedup-config.json` настройки отображают дефолты
- [ ] Кнопка «Запустить сейчас» блокируется во время выполнения
- [ ] Polling обновляет статус без перезагрузки страницы
- [ ] Переключение вкладок работает без перезагрузки
- [ ] SVG-инфографика корректно рендерится в тёмной теме Cockpit
- [ ] Сохранение расписания создаёт корректный `/etc/cron.d/rusnas-dedup`
- [ ] Включение vfs_btrfs для шары корректно модифицирует smb.conf (без дублирования)
- [ ] Отключение vfs_btrfs для шары корректно удаляет строку из smb.conf
- [ ] `smbd reload` вызывается после изменений smb.conf
- [ ] Лог-модальное окно показывает последние строки файла (не весь файл)
- [ ] Нет `inline` event handlers — только `addEventListener` или именованные функции
- [ ] `superuser: 'require'` в `manifest.json` или явно в spawn-вызовах для привилегированных операций

---

## 10. Зависимости

| Пакет | Версия | Источник |
|-------|--------|---------|
| `duperemove` | ≥ 0.13 | apt |
| `btrfs-progs` | уже установлен | apt |
| `python3` | уже установлен | apt |
| Samba с `vfs_btrfs` | `samba` ≥ 4.17 — уже установлен | apt |

`vfs_btrfs` входит в стандартный пакет `samba` в Debian 13 — дополнительных пакетов не требуется.

---

*Файл создан Claude.ai. Следующий шаг: передать в Claude Code для реализации.*
