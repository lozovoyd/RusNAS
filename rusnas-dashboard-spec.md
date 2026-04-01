# rusNAS Dashboard — Техническое задание

**Версия:** 1.0  
**Компонент:** `/usr/share/cockpit/rusnas/dashboard.html` + `js/dashboard.js`  
**Контекст:** Cockpit-плагин rusNAS, Debian 13, Btrfs+mdadm стек  
**Цель:** Главная страница плагина — первое, что видит администратор при открытии rusNAS

---

## 1. Место в архитектуре

Файлы:
```
/usr/share/cockpit/rusnas/
  manifest.json          ← добавить Dashboard как order: 1
  dashboard.html
  js/dashboard.js
  (существующие: storage.html, disks.html, users.html)
```

В `manifest.json` добавить:
```json
"dashboard": {
  "label": "Dashboard",
  "order": 1,
  "path": "dashboard.html"
}
```

---

## 2. Визуальная концепция

**Стиль:** Тёмная тема, соответствующая Cockpit (переменные `--pf-*`). Карточки с тонкими цветными акцентами по статусу. Никаких таблиц без необходимости — упор на крупные цифры + spark-графики + цветовые индикаторы.

**Layout:** CSS Grid, 12-колоночная сетка. Адаптивный (минимум 1280px для SMB-серверных интерфейсов).

**Цветовая семантика:**
- 🟢 `--pf-color-green` — OK / здоров
- 🟡 `--pf-color-yellow` — предупреждение
- 🔴 `--pf-color-red` — критично / деградация
- 🔵 `--pf-color-blue` — информация / активность

**Шрифт:** системный PatternFly/Cockpit stack. Крупные метрики — 2rem bold.

---

## 3. Структура страницы

### 3.1 Верхняя строка — System Identity Bar

Горизонтальная полоса во всю ширину:

```
[🖥 Hostname]  [IP: 192.168.1.10]  [Uptime: 14d 3h 22m]  [DSM rusNAS 1.0]  [Дата/время (обновляется каждую секунду)]
```

Реализация:
- `hostname` — `/proc/sys/kernel/hostname`
- IP — `ip route get 1.1.1.1` или `/proc/net/fib_trie`
- Uptime — `/proc/uptime`
- Время — `new Date()` в JS, обновление каждую секунду

---

### 3.2 Секция A — Storage Overview (верхний ряд карточек)

**4 карточки в ряд:**

#### A1. Storage Health (крупная)
```
┌─────────────────────────┐
│  💾 STORAGE             │
│                         │
│  ████████░░  78%        │
│  3.8 TB used / 4.9 TB   │
│                         │
│  md0 ✅  md1 ✅         │
└─────────────────────────┘
```
- Суммарное использование всех смонтированных btrfs/ext4 томов (`df -h`)
- Список RAID-массивов с иконкой статуса (парсинг `/proc/mdstat`)
- Клик → переход на вкладку Disks

#### A2. RAID Status
```
┌─────────────────────────┐
│  🔧 RAID                │
│                         │
│  md0  RAID5  ✅ Active  │
│  3 дисков, sync 100%    │
│                         │
│  md1  RAID1  ⚠ Degraded│
│  1/2 дисков             │
└─────────────────────────┘
```
- Каждый массив: имя, уровень, статус, количество дисков
- Цвет карточки = наихудший статус среди массивов
- Если идёт resync — показать прогресс-бар с % и скоростью

#### A3. Disk Health
```
┌─────────────────────────┐
│  💿 ДИСКИ               │
│                         │
│  6 дисков: 5 ✅ 1 ⚠    │
│                         │
│  sda ✅  sdb ✅  sdc ✅  │
│  sdd ✅  sde ✅  sdf ⚠  │
└─────────────────────────┘
```
- `smartctl -H /dev/sdX` для каждого диска (кэшировать, не дёргать на каждый рефреш)
- SMART-кэш: обновление раз в 5 минут
- Клик → Disks

#### A4. Shares & Protocols
```
┌─────────────────────────┐
│  📁 ОБЩИЙ ДОСТУП        │
│                         │
│  SMB   ✅  4 шары       │
│  NFS   ✅  2 шары       │
│  FTP   🔴 Остановлен   │
│  iSCSI ✅  1 таргет     │
└─────────────────────────┘
```
- Статус сервисов через `systemctl is-active`: smbd, nfs-server, vsftpd, tgt/targetcli
- Количество шар: парсинг `smb.conf`, `/etc/exports`, `/etc/vsftpd.conf`

---

### 3.3 Секция B — Performance Metrics (средний ряд)

**3 карточки с live-графиками (sparkline, последние 60 точек = 60 секунд):**

#### B1. CPU
```
┌──────────────────────────────────┐
│  ⚡ CPU                     34%  │
│  ▁▂▃▄▅▄▃▅▆▄▃▂▁▂▃▄▅▆▇▆▅▄▃▂     │
│  4 ядра  |  Load: 0.42 0.38 0.31 │
│  Temp: 48°C                      │
└──────────────────────────────────┘
```
- CPU %: `/proc/stat` — считать delta между двумя замерами
- Load average: `/proc/loadavg`
- Температура: `sensors` или `/sys/class/thermal/thermal_zone*/temp`
- Sparkline: SVG, последние 60 значений, обновление раз в секунду

#### B2. Memory
```
┌──────────────────────────────────┐
│  🧠 RAM                     62%  │
│  ▂▂▃▃▃▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▃▃  │
│  3.9 GB used / 6.3 GB            │
│  Swap: 0 MB / 2 GB               │
└──────────────────────────────────┘
```
- `/proc/meminfo`: MemTotal, MemAvailable, SwapTotal, SwapFree
- Sparkline аналогично CPU

#### B3. Network
```
┌──────────────────────────────────┐
│  🌐 СЕТЬ              eth0       │
│  ↑ 12.4 MB/s  ↓ 8.7 MB/s        │
│  ▁▂▄▆▇▆▄▂▁▁▂▃▄▅▄▃▂▁▂▃▄▅▆▇▅▄▃  │
│  eth1: 1 Гбит  Connected         │
└──────────────────────────────────┘
```
- `/proc/net/dev`: считать delta bytes между замерами
- Показывать все активные сетевые интерфейсы (кроме lo)
- Скорость в KB/s, MB/s автоматически

---

### 3.4 Секция C — Storage I/O (широкая карточка)

```
┌──────────────────────────────────────────────────────────────────────┐
│  📊 ДИСКОВЫЙ I/O                                                     │
│                                                                      │
│  Чтение:  ████████░░░░░░░░  45 MB/s    [sparkline 60s]              │
│  Запись:  ██████░░░░░░░░░░  32 MB/s    [sparkline 60s]              │
│                                                                      │
│  sda: R 12MB/s  W 8MB/s  |  sdb: R 11MB/s  W 7MB/s  | ...         │
└──────────────────────────────────────────────────────────────────────┘
```
- `/proc/diskstats` — считать delta секторов × 512 / delta_time
- Агрегированный суммарный I/O + breakdown по дискам
- Обновление раз в секунду

---

### 3.5 Секция D — Recent Events (нижняя панель, 2 колонки)

#### D1. Системный журнал (последние 10 событий)
```
┌──────────────────────────────────────┐
│  📋 СОБЫТИЯ                          │
│  ─────────────────────────────────   │
│  14:32  ✅ md0 resync completed      │
│  14:15  ⚠  sdf SMART warning        │
│  13:55  ℹ  SMB: user "ivan" login   │
│  13:40  ✅ System updated            │
│  ...                                 │
└──────────────────────────────────────┘
```
- `journalctl -n 20 --no-pager -o json` фильтр по unit: smbd, mdadm, kernel
- Цветовая маркировка по severity

#### D2. Snapshot Status
```
┌──────────────────────────────────────┐
│  📸 СНАПШОТЫ                         │
│  ─────────────────────────────────   │
│  /vol1  Последний: 2ч назад  ✅      │
│  /vol2  Последний: 1д назад  ⚠      │
│  /vol3  Нет снапшотов        🔴     │
│                                      │
│  Всего снапшотов: 14                 │
└──────────────────────────────────────┘
```
- `btrfs subvolume list /mountpoint`
- Парсинг имён снапшотов с временными метками (формат: `.snap_YYYYMMDD_HHMMSS`)
- Если снапшотов нет совсем — предупреждение

---

### 3.6 Секция E — Ransomware Protection (rusNAS Guard)

Отдельная карточка во всю ширину нижней зоны (или рядом с D1/D2 как третья колонка). Это **продающая фича** — видна сразу при открытии дашборда.

#### E1. Статусная карточка Guard

```
┌──────────────────────────────────────────────────────────────────────┐
│  🛡 RUSNAS GUARD — ЗАЩИТА ОТ ШИФРОВАЛЬЩИКОВ                         │
│                                                                      │
│  ●  АКТИВЕН  [Monitor]         Работает 14д 3ч                      │
│                                                                      │
│  За последние 24 часа:                                               │
│  ✅ 0 угроз обнаружено   |  📊 847 операций проверено               │
│                                                                      │
│  Последнее событие: нет                                              │
│  Последний снапшот Guard: сегодня 03:00  ✅                          │
│                                                                      │
│  [Настройки Guard →]                                                 │
└──────────────────────────────────────────────────────────────────────┘
```

**Состояния карточки:**

| Состояние daemon | Цвет | Текст статуса |
|---|---|---|
| Не установлен | серый | "Guard не установлен" |
| Установлен, не запущен | серый | "Guard отключён" |
| Monitor mode | синий ● | "Мониторинг (без блокировки)" |
| Protect mode | зелёный ● | "Активная защита" |
| Super-Safe mode | фиолетовый ● | "Максимальная защита" |
| Атака обнаружена (активная) | красный мигающий ● | "⚠ АТАКА ОБНАРУЖЕНА — действие выполнено" |
| Post-attack режим | оранжевый ● | "⚠ Запущен после инцидента — требует подтверждения" |

#### E2. Три режима работы (из соседнего чата)

**Monitor** — наблюдение без вмешательства:
- Считает события, пишет в лог, отправляет уведомления
- Не блокирует, не делает снапшоты принудительно
- Подходит для первичной настройки и наблюдения за базовой активностью

**Protect** — активная защита:
- При обнаружении аномалии → немедленный Btrfs-снапшот затронутых томов
- Уведомление (Telegram + Email) с деталями: кто, что, сколько файлов
- Продолжает работу, не останавливает SMB

**Super-Safe** — максимальная защита:
- При обнаружении аномалии → снапшот + отключение SMB-шары (`smbcontrol smbd close-share <share>`)
- При критическом уровне → снапшот + `shutdown -h now`
- После shutdown при следующем старте daemon поднимается в post-attack Monitor-only режиме
- Требует PIN-подтверждения администратора для смены режима

#### E3. Метрики обнаружения (что показывать в дашборде)

Данные берутся из `/var/lib/rusnas-guard/stats.json` (файл обновляется daemon каждую минуту):

```json
{
  "mode": "protect",
  "running": true,
  "uptime_seconds": 1235187,
  "post_attack": false,
  "stats_24h": {
    "operations_checked": 847,
    "threats_detected": 0,
    "snapshots_taken": 0,
    "shares_blocked": 0
  },
  "stats_total": {
    "operations_checked": 94821,
    "threats_detected": 2,
    "snapshots_taken": 2,
    "shares_blocked": 1
  },
  "last_threat": null,
  "last_snapshot": "2026-03-12T03:00:00Z",
  "entropy_baseline": {
    "/volume1": 4.2,
    "/volume2": 3.8
  },
  "current_entropy": {
    "/volume1": 4.3,
    "/volume2": 3.9
  },
  "monitored_shares": ["homes", "docs", "archive"],
  "watchdog_ok": true
}
```

Чтение: `cockpit.file('/var/lib/rusnas-guard/stats.json').read()` — без sudo (файл доступен на чтение).

#### E4. Индикаторы в карточке (детали)

**Строка статистики за 24ч:**
```
📊 847 операций  |  🔴 0 угроз  |  📸 0 снапшотов Guard  |  🚫 0 шар заблокировано
```

**Энтропия томов** (мини-виджет, опционально):
```
Энтропия: /volume1 ████░░  4.3  (норма: 4.2)  ✅
           /volume2 ████░░  3.9  (норма: 3.8)  ✅
```
Цвет полосы: зелёный если delta < 0.5, жёлтый 0.5–1.0, красный > 1.0

**При активной атаке** — карточка разворачивается на всю ширину и показывает:
```
┌──────────────────────────────────────────────────────────────────────┐
│  🔴 ⚠ АКТИВНАЯ УГРОЗА ОБНАРУЖЕНА  14:32:07                          │
│                                                                      │
│  Источник: 192.168.1.55 (user: ivan)                                 │
│  Затронутая шара: /homes/ivan                                        │
│  Изменено файлов: 847 за 2 мин (порог: 100/мин)                     │
│  Энтропия: 7.8 (норма: 4.2)                                         │
│  Паттерны: .encrypted, .locked, README_DECRYPT.txt                  │
│                                                                      │
│  Действие: снапшот создан ✅  |  SMB-шара отключена ✅               │
│                                                                      │
│  [Посмотреть снапшот]  [Разблокировать шару ↗]  [Полный отчёт ↗]   │
└──────────────────────────────────────────────────────────────────────┘
```

**Post-attack предупреждение:**
```
┌──────────────────────────────────────────────────────────────────────┐
│  🟠 Guard запущен в безопасном режиме после инцидента                │
│  Активная защита приостановлена до подтверждения администратора      │
│  [Просмотреть инцидент]  [Подтвердить и вернуть защиту (PIN)]       │
└──────────────────────────────────────────────────────────────────────┘
```

#### E5. Технические детали источников данных

**Что детектирует daemon (не реализуется в дашборде, но важно для понимания метрик):**

- `fanotify` / `inotify` на смонтированных Btrfs-томах → счётчик операций записи/удаления в единицу времени
- Samba `vfs objects = full_audit` → лог SMB-операций с IP и username источника
- Расчёт энтропии Шеннона на случайной выборке изменённых файлов (скользящее среднее за 5 мин)
- Детектирование known-bad имён файлов: `*.encrypted`, `*.locked`, `DECRYPT_*`, `README_*`, `HOW_TO_RECOVER*`
- Порог операций: настраиваемый (default: 200 изменений/мин на том → warning, 500/мин → action)

**Файлы daemon:**
```
/var/lib/rusnas-guard/stats.json        ← читается дашбордом
/var/lib/rusnas-guard/events.log        ← для журнала событий D1
/etc/rusnas-guard/config.yaml           ← конфигурация
/etc/rusnas-guard/post_attack           ← флаг post-attack режима (присутствие = режим активен)
/run/rusnas-guard/rusnas-guard.pid      ← PID файл
```

**Определение режима daemon для UI:**
```javascript
// Читаем stats.json
const stats = JSON.parse(await cockpit.file('/var/lib/rusnas-guard/stats.json').read());
const mode = stats.running ? stats.mode : 'stopped';   // 'monitor'|'protect'|'super-safe'|'stopped'
const postAttack = stats.post_attack;                   // boolean
const threats24h = stats.stats_24h.threats_detected;
```

Если `/var/lib/rusnas-guard/stats.json` не существует — Guard не установлен, показываем серую карточку с кнопкой "Установить Guard".

#### E6. Ссылка на полный интерфейс Guard

Кнопка "Настройки Guard →" открывает отдельную Cockpit-страницу `guard.html` (будет реализована отдельным ТЗ), где:
- Переключение режимов (Monitor / Protect / Super-Safe) с PIN-подтверждением
- История угроз и инцидентов
- Настройка порогов и исключений
- Управление снапшотами Guard
- Настройка уведомлений

---

## 4. Механика обновления данных

```javascript
// Интервалы обновления
const REFRESH_INTERVALS = {
  identity:    1000,   // hostname, uptime, время
  performance: 1000,   // CPU, RAM, Network, I/O
  storage:    10000,   // df, mdstat
  smart:     300000,   // smartctl (5 минут)
  services:   10000,   // systemctl status
  events:     15000,   // journalctl
  snapshots:  60000,   // btrfs subvolume list
  guard:       5000,   // /var/lib/rusnas-guard/stats.json (учащается до 1s при активной атаке)
};
```

Все данные через `cockpit.spawn()` / `cockpit.file().read()`. Не использовать `setInterval` для тяжёлых команд (smartctl) — только лёгкие команды в быстрые интервалы.

Паттерн для метрик требующих delta (CPU, Network, I/O):
```javascript
let prevStats = null;
function calcDelta(current, prev, interval) { ... }
```

---

## 5. Metrics API — эндпоинт для внешнего мониторинга

**Это ключевая фича для интеграции с Zabbix, Prometheus, Grafana.**

### 5.1 Nginx endpoint (устанавливается Ansible-ролью)

Файл: `/etc/nginx/sites-available/rusnas-metrics` (отдельный от основного конфига)

```
GET http://<NAS_IP>:9100/metrics
```

Порт 9100 — стандартный порт `node_exporter`. Если node_exporter уже установлен, использовать его. Если нет — rusNAS предоставляет собственный скрипт.

### 5.2 Формат ответа — Prometheus text format

```
# HELP rusnas_cpu_usage_percent CPU usage percent
# TYPE rusnas_cpu_usage_percent gauge
rusnas_cpu_usage_percent 34.2

# HELP rusnas_memory_used_bytes Memory used in bytes
# TYPE rusnas_memory_used_bytes gauge
rusnas_memory_used_bytes 4189405184

# HELP rusnas_memory_total_bytes Total memory in bytes
# TYPE rusnas_memory_total_bytes gauge
rusnas_memory_total_bytes 6761299968

# HELP rusnas_disk_read_bytes_per_second Disk read speed
# TYPE rusnas_disk_read_bytes_per_second gauge
rusnas_disk_read_bytes_per_second{device="sda"} 12582912
rusnas_disk_read_bytes_per_second{device="sdb"} 11534336

# HELP rusnas_disk_write_bytes_per_second Disk write speed
# TYPE rusnas_disk_write_bytes_per_second gauge
rusnas_disk_write_bytes_per_second{device="sda"} 8388608

# HELP rusnas_disk_smart_health SMART health: 1=PASSED, 0=FAILED
# TYPE rusnas_disk_smart_health gauge
rusnas_disk_smart_health{device="sda",serial="WD-WCC4N5HN7XJP"} 1
rusnas_disk_smart_health{device="sdb",serial="ST2000DM008-2FR1"} 1

# HELP rusnas_raid_status RAID status: 1=active, 0=degraded/failed
# TYPE rusnas_raid_status gauge
rusnas_raid_status{name="md0",level="raid5",devices="3"} 1
rusnas_raid_status{name="md1",level="raid1",devices="2"} 0

# HELP rusnas_raid_sync_percent RAID sync progress percent
# TYPE rusnas_raid_sync_percent gauge
rusnas_raid_sync_percent{name="md1"} 67.3

# HELP rusnas_volume_used_bytes Volume used bytes
# TYPE rusnas_volume_used_bytes gauge
rusnas_volume_used_bytes{mountpoint="/volume1",fstype="btrfs"} 4080218931200

# HELP rusnas_volume_total_bytes Volume total bytes
# TYPE rusnas_volume_total_bytes gauge
rusnas_volume_total_bytes{mountpoint="/volume1",fstype="btrfs"} 5368709120000

# HELP rusnas_service_status Service status: 1=active, 0=inactive
# TYPE rusnas_service_status gauge
rusnas_service_status{service="smbd"} 1
rusnas_service_status{service="nfs-server"} 1
rusnas_service_status{service="vsftpd"} 0
rusnas_service_status{service="tgt"} 1

# HELP rusnas_network_receive_bytes_per_second Network receive speed
# TYPE rusnas_network_receive_bytes_per_second gauge
rusnas_network_receive_bytes_per_second{interface="eth0"} 9126277

# HELP rusnas_network_transmit_bytes_per_second Network transmit speed
# TYPE rusnas_network_transmit_bytes_per_second gauge
rusnas_network_transmit_bytes_per_second{interface="eth0"} 13004390

# HELP rusnas_uptime_seconds System uptime in seconds
# TYPE rusnas_uptime_seconds counter
rusnas_uptime_seconds 1235187

# HELP rusnas_cpu_temp_celsius CPU temperature
# TYPE rusnas_cpu_temp_celsius gauge
rusnas_cpu_temp_celsius 48.0

# HELP rusnas_guard_running Guard daemon running status: 1=running, 0=stopped
# TYPE rusnas_guard_running gauge
rusnas_guard_running 1

# HELP rusnas_guard_mode Guard mode: 0=stopped, 1=monitor, 2=protect, 3=super-safe
# TYPE rusnas_guard_mode gauge
rusnas_guard_mode 2

# HELP rusnas_guard_threats_24h Threats detected in last 24 hours
# TYPE rusnas_guard_threats_24h gauge
rusnas_guard_threats_24h 0

# HELP rusnas_guard_operations_24h File operations checked in last 24 hours
# TYPE rusnas_guard_operations_24h gauge
rusnas_guard_operations_24h 847

# HELP rusnas_guard_entropy_current Current filesystem entropy by volume
# TYPE rusnas_guard_entropy_current gauge
rusnas_guard_entropy_current{volume="/volume1"} 4.3
rusnas_guard_entropy_current{volume="/volume2"} 3.9

# HELP rusnas_guard_entropy_baseline Baseline filesystem entropy by volume
# TYPE rusnas_guard_entropy_baseline gauge
rusnas_guard_entropy_baseline{volume="/volume1"} 4.2
rusnas_guard_entropy_baseline{volume="/volume2"} 3.8

# HELP rusnas_guard_post_attack Post-attack mode: 1=active (requires admin ack)
# TYPE rusnas_guard_post_attack gauge
rusnas_guard_post_attack 0
```

### 5.3 Реализация скрипта метрик

Файл: `/usr/local/bin/rusnas-metrics`  
Тип: bash-скрипт, вызывается как CGI или через простой Python HTTP сервер

```bash
#!/bin/bash
# rusnas-metrics — генерирует метрики в Prometheus text format
# Вызывается: /usr/local/bin/rusnas-metrics > output.txt
```

Сервис: `systemd` unit `/etc/systemd/system/rusnas-metrics.service` — простой Python `http.server` на порту 9100, обслуживающий CGI-скрипт.

Альтернатива (если установлен `prometheus-node-exporter`): Ansible-роль устанавливает node_exporter, rusNAS не создаёт дублирующий сервис, но добавляет кастомные метрики через `node_exporter` textfile collector (`/var/lib/node_exporter/textfile_collector/*.prom`).

### 5.4 UI-элемент в Dashboard

В нижнем правом углу страницы — блок "Интеграция с мониторингом":

```
┌────────────────────────────────────────────────────────┐
│  🔗 ВНЕШНИЙ МОНИТОРИНГ                                 │
│                                                        │
│  Prometheus / Zabbix endpoint:                         │
│  http://192.168.1.10:9100/metrics  [📋 Копировать]    │
│                                                        │
│  JSON API:                                             │
│  http://192.168.1.10:9100/metrics.json  [📋 Копировать]│
│                                                        │
│  Для Zabbix: HTTP Agent → URL выше                     │
│  Для Prometheus: scrape_configs target                 │
└────────────────────────────────────────────────────────┘
```

Кнопка "Копировать" использует `navigator.clipboard.writeText()`.

IP определяется автоматически из текущего URL страницы (`window.location.hostname`).

### 5.5 JSON API (дополнительный формат)

```
GET http://<NAS_IP>:9100/metrics.json
```

Ответ: структурированный JSON, удобный для Zabbix HTTP-agent с JSONPath preprocessing:

```json
{
  "timestamp": 1710000000,
  "hostname": "rusnas-01",
  "cpu": {
    "usage_percent": 34.2,
    "load_avg": [0.42, 0.38, 0.31],
    "temp_celsius": 48.0
  },
  "memory": {
    "total_bytes": 6761299968,
    "used_bytes": 4189405184,
    "available_bytes": 2571894784,
    "swap_total_bytes": 2147483648,
    "swap_used_bytes": 0
  },
  "network": {
    "eth0": {
      "rx_bytes_per_sec": 9126277,
      "tx_bytes_per_sec": 13004390,
      "speed_mbps": 1000,
      "link": true
    }
  },
  "disks": {
    "sda": {
      "smart_health": "PASSED",
      "read_bytes_per_sec": 12582912,
      "write_bytes_per_sec": 8388608,
      "model": "WDC WD40EFRX",
      "serial": "WD-WCC4N5HN7XJP"
    }
  },
  "raid": {
    "md0": {
      "level": "raid5",
      "status": "active",
      "devices_active": 3,
      "devices_total": 3,
      "sync_percent": null
    },
    "md1": {
      "level": "raid1",
      "status": "degraded",
      "devices_active": 1,
      "devices_total": 2,
      "sync_percent": 67.3
    }
  },
  "volumes": {
    "/volume1": {
      "fstype": "btrfs",
      "total_bytes": 5368709120000,
      "used_bytes": 4080218931200,
      "free_bytes": 1288490188800
    }
  },
  "services": {
    "smbd": "active",
    "nfs-server": "active",
    "vsftpd": "inactive",
    "tgt": "active"
  }
}
```

---

## 6. Детали реализации

### 6.1 Cockpit-специфика

```javascript
// Обязательный импорт
import cockpit from '../base1/cockpit.js';

// Запуск команд с правами
cockpit.spawn(["cat", "/proc/stat"])
  .then(output => parseCpuStats(output))
  .catch(err => console.error(err));

// Для smartctl нужен sudo
cockpit.spawn(["sudo", "smartctl", "-H", "/dev/sda"])
  .then(output => parseSmartHealth(output));
```

CSP в manifest.json должен включать:
```json
"content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';"
```

### 6.2 Sparkline реализация

Чистый SVG, без внешних библиотек (Chart.js и т.п.):

```javascript
function renderSparkline(containerId, values, color = '#4CAF50') {
  const svg = document.getElementById(containerId);
  const w = svg.clientWidth, h = svg.clientHeight;
  const max = Math.max(...values, 1);
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - (v / max) * h;
    return `${x},${y}`;
  }).join(' ');
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
}
```

### 6.3 Парсинг mdstat

Использовать существующий парсер из `disks.js` (вынести в shared utility или продублировать).

### 6.4 Кэширование SMART

```javascript
const smartCache = {};
const SMART_TTL = 300000; // 5 минут

async function getSmartHealth(device) {
  const now = Date.now();
  if (smartCache[device] && (now - smartCache[device].time) < SMART_TTL) {
    return smartCache[device].value;
  }
  const result = await cockpit.spawn(["sudo", "smartctl", "-H", `/dev/${device}`]);
  smartCache[device] = { time: now, value: parseSmartHealth(result) };
  return smartCache[device].value;
}
```

### 6.5 Структура файлов

```
dashboard.html          — разметка (только структура, без inline-стилей)
js/dashboard.js         — вся логика, ~500-700 строк
css/dashboard.css       — стили дашборда (если не хватает inline)
```

---

## 7. Системный сервис метрик (для Ansible-роли)

Файл: `/etc/systemd/system/rusnas-metrics.service`

```ini
[Unit]
Description=rusNAS Metrics Endpoint
After=network.target

[Service]
Type=simple
User=www-data
ExecStart=/usr/bin/python3 /usr/local/lib/rusnas/metrics_server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Файл: `/usr/local/lib/rusnas/metrics_server.py`

```python
#!/usr/bin/env python3
"""
rusNAS Metrics Server
Порт 9100, два эндпоинта:
  /metrics       — Prometheus text format
  /metrics.json  — JSON format
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import subprocess, json, time, re

PORT = 9100

class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/metrics':
            data = collect_metrics()
            body = format_prometheus(data).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; version=0.0.4')
            self.end_headers()
            self.wfile.write(body)
        elif self.path == '/metrics.json':
            data = collect_metrics()
            body = json.dumps(data, indent=2).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # подавить стандартный лог

def collect_metrics():
    # ... сбор данных из /proc и вызов команд
    pass

def format_prometheus(data):
    # ... форматирование в text format
    pass

if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', PORT), MetricsHandler)
    server.serve_forever()
```

**Примечание:** Полная реализация `collect_metrics()` и `format_prometheus()` — задача Claude Code при выполнении ТЗ. Выше — архитектура и интерфейс.

---

## 8. Чеклист для Claude Code

- [ ] `dashboard.html` — разметка всех секций A, B, C, D, E + блок мониторинга
- [ ] `js/dashboard.js` — вся логика сбора и отображения метрик
- [ ] Sparkline-рендеринг через SVG (без внешних зависимостей)
- [ ] Кэширование SMART (TTL 5 мин)
- [ ] Delta-расчёт для CPU, Network, I/O
- [ ] Авто-обновление по расписанию (разные интервалы)
- [ ] Цветовые статусы (green/yellow/red) по порогам
- [ ] manifest.json — Dashboard как order:1
- [ ] `/usr/local/lib/rusnas/metrics_server.py` — полная реализация
- [ ] `/etc/systemd/system/rusnas-metrics.service`
- [ ] `/usr/local/bin/rusnas-metrics-install.sh` — скрипт установки сервиса
- [ ] UI-блок с копируемыми ссылками на эндпоинты
- [ ] **Guard секция E:** чтение `/var/lib/rusnas-guard/stats.json`
- [ ] **Guard секция E:** отображение режима (stopped/monitor/protect/super-safe) с цветовым статусом
- [ ] **Guard секция E:** статистика 24ч (операции/угрозы/снапшоты/заблокированные шары)
- [ ] **Guard секция E:** мини-виджет энтропии томов с цветовыми порогами
- [ ] **Guard секция E:** alert-banner при активной атаке (threats_detected > 0 за последние 5 мин)
- [ ] **Guard секция E:** post-attack предупреждение при `post_attack: true`
- [ ] **Guard секция E:** graceful fallback если файл stats.json не существует (Guard не установлен)
- [ ] **Guard секция E:** кнопка "Настройки Guard →" → линк на `guard.html` (страница будет реализована отдельно)

---

## 9. Пороговые значения для цветовой индикации

| Метрика | 🟡 Warning | 🔴 Critical |
|---------|-----------|-------------|
| CPU % | > 80% | > 95% |
| RAM % | > 85% | > 95% |
| Disk usage % | > 80% | > 90% |
| CPU temp | > 65°C | > 80°C |
| SMART | любой != PASSED | — |
| RAID status | degraded | failed/inactive |
| Disk в массиве | removed | — |
| Guard: энтропия delta | > 0.5 | > 1.0 |
| Guard: угрозы за 24ч | > 0 | — (любая угроза = красный) |
| Guard: режим | monitor (синий) | stopped (серый) |

---

## 11. Реализованные дополнения (2026-03-21)

### Network Monitor Modal
- Клик по карточке `#card-net` → модал `#net-modal`
- Live RX/TX скорости (копируются с основной карточки, 1 сек интервал)
- vnstat интеграция: `cockpit.spawn(["vnstat", "--json"])` — ключи `traffic.day/hour/month` (не plural)
- SVG бар-чарты: 7-дневный + 24-часовой (попарные столбики RX/TX)
- Таблица помесячной статистики (до 12 месяцев, newest first)
- CSS `.nm-*` namespace

### TX Speed Bug Fix
- Регекс `/proc/net/dev` захватывал `RX_multicast` (≈0) вместо `TX_bytes`
- Формат файла: `iface: RX_bytes pkt errs drop fifo frame compressed multicast TX_bytes ...`
- Правильный regex: 7 skip-групп между RX_bytes и TX_bytes
- Исправляет как спарклайн на карточке, так и модал

### Snapshot Widget Fix
- `storage-info` возвращал все субволюмы из БД (включая старые тестовые пути) → завышенное число
- Теперь: cross-reference с `schedule list`, показываются субволюмы с расписанием ИЛИ с ненулевым count
- Суммирование пересчитывается по отфильтрованному списку, используется `fmtBytes()` для размера

---

## 10. Примечания по деплою

1. После создания файлов — `systemctl restart cockpit` для перезагрузки плагина
2. `rusnas-metrics.service` — включить через `systemctl enable --now rusnas-metrics`
3. Firewall: открыть порт 9100 для сетей мониторинга (добавить в Ansible firewall-роль)
4. Для Zabbix: добавить хост, HTTP Agent item с URL `http://<NAS_IP>:9100/metrics.json`, JSONPath preprocessing для каждой метрики
5. Для Prometheus: добавить в `scrape_configs`:
   ```yaml
   - job_name: 'rusnas'
     static_configs:
       - targets: ['<NAS_IP>:9100']
   ```

## Performance Charts (Chart.js 4.x) — added 2026-03-31

### Architecture
- **Backend:** `perf-collector.py` systemd daemon — собирает CPU/RAM/Net/Disk каждые 10 сек
- **Storage:** `/var/lib/rusnas/perf-history.json` (~200-300 KB, 24h retention, auto-downsampling)
- **Frontend:** `dashboard.js` читает JSON через `cockpit.file().read()`, рисует Chart.js
- **Правило:** Cockpit = только отображение. Сбор данных ТОЛЬКО в backend daemon.

### 6 графиков (2×3 grid)
| График | Серии | Источник |
|--------|-------|----------|
| CPU % | CPU (blue, filled) | /proc/stat delta |
| RAM % | RAM (purple, filled) | /proc/meminfo |
| Сеть КБ/с | RX↓ (green), TX↑ (orange) | /proc/net/dev delta |
| Дисковый I/O МБ/с | Чтение (blue), Запись (green) | /proc/diskstats sectors×512 |
| IOPS | Чтение (blue), Запись (green) | /proc/diskstats ios delta |
| Время отклика мс | Чтение, Запись, Среднее | Вычисляется из IOPS |

### Переключатель периода
Кнопки: 5 МИН / 15 МИН / 30 МИН / 1 ЧАС / 24 Ч
X-axis: `scales.x.min = now - period`, `scales.x.max = now` — фиксированное окно сдвигается вправо

### Downsampling (perf-collector.py)
| Возраст | Разрешение | Точек/24ч |
|---------|-----------|-----------|
| < 15 мин | 10 сек raw | 90 |
| 15мин – 2ч | 30 сек avg | 210 |
| > 2ч | 120 сек avg | 660 |
| **Итого** | | **~960** |

### Конфигурация Chart.js
- Локальные файлы: `js/chart.umd.min.js`, `js/chartjs-adapter-date-fns.bundle.min.js`
- `animation: false`, `parsing: false`, `normalized: true` — оптимизация производительности
- `spanGaps: false` + null gap insertion при разрыве >30 сек
- `decimation: { enabled: true, algorithm: 'lttb', samples: 200 }`
- Canvas в карточках фиксированной высоты (240px), absolute positioning

### Кнопки (i) и (⤢)
- **(i)** на CPU/RAM/Сеть → открывает детальную модалку (CPU monitor / vnstat)
- **(⤢)** → разворачивает график на весь экран с отдельным переключателем периода
