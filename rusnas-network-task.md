# ТЗ: rusNAS Network — Управление сетью

**Версия:** 1.0
**Статус:** Готово к реализации
**Кодовое название:** `network`
**Место в навигации:** Cockpit sidebar → «🌐 Сеть»

---

## 1. Контекст и назначение

### Проблема

На Debian 13 Trixie основной сетевой интерфейс (ens3/eth0) управляется **ifupdown** (`/etc/network/interfaces`). NetworkManager при этом отмечает интерфейс как **unmanaged** — штатная страница Cockpit `/network` отображает его только в режиме чтения и не позволяет вносить изменения.

Результат: администратор не может сменить IP, DNS, шлюз, добавить статический маршрут или диагностировать сеть — без SSH в консоль.

### Решение

Создать кастомную страницу `network.html` в Cockpit-плагине rusNAS, которая управляет сетью **напрямую через конфигурационные файлы ifupdown** (`/etc/network/interfaces`, `/etc/resolv.conf`, `/etc/hosts`, `ip route`). Страница не зависит от NetworkManager.

### Целевая аудитория

SMB-администратор: управляет 1–3 интерфейсами, хочет сменить IP или добавить маршрут без знания синтаксиса ifupdown и без SSH. Нет DevOps-экспертизы — нужен GUI уровня Synology DSM.

### Что лучше Synology DSM

| Функция | Synology DSM | rusNAS Network |
|---------|-------------|----------------|
| Статические маршруты | ❌ только SSH | ✅ GUI полный |
| Traceroute | ❌ только ping | ✅ traceroute + MTR |
| DNS lookup | ❌ нет | ✅ dig / nslookup |
| Проверка порта | ❌ нет | ✅ nc / telnet check |
| Применение без перезагрузки | ⚠️ иногда нужен reboot | ✅ всегда live (ifup/down + ip) |
| IPv6 | ⚠️ минимально | ✅ полный dual-stack |
| Wake-on-LAN | ❌ нет | ✅ отправка WoL пакета |

---

## 2. Архитектура

### 2.1 Структура URL / навигация

```
Cockpit-плагин rusNAS
├── dashboard.html         (главная)
├── network.html           ← НОВЫЙ ФАЙЛ
│   ├── Вкладка: Интерфейсы
│   ├── Вкладка: DNS и хосты
│   ├── Вкладка: Маршруты
│   └── Вкладка: Диагностика
└── ...
```

**manifest.json** — добавить пункт меню:
```json
{
  "network": {
    "label": "Сеть",
    "order": 35,
    "docs": []
  }
}
```

### 2.2 Технический стек

- **Фронтенд:** Vanilla JS + Cockpit API (без фреймворков, как весь плагин)
- **Чтение конфигов:** `cockpit.file()` + `cockpit.spawn(["ip", ...])` + `cockpit.spawn(["cat", "/etc/network/interfaces"])`
- **Запись конфигов:** `cockpit.file(path, {superuser:"require"}).replace(content)`
- **Применение настроек:** `cockpit.spawn(["sudo", "ifdown", iface])` → `cockpit.spawn(["sudo", "ifup", iface])`
- **Диагностика:** `cockpit.spawn(["sudo", "ping", ...])` / `traceroute` / `dig` — с live stdout streaming
- **Live мониторинг:** polling каждые 3 сек через `cockpit.spawn(["ip", "-j", "addr"])` + `ip -j route`
- **Бэкенд-скрипт:** `/usr/share/cockpit/rusnas/scripts/network-api.py` — чтение/запись interfaces, resolv.conf, hosts, маршруты

### 2.3 Судоерс

```
/etc/sudoers.d/rusnas-network:
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/ifup, /usr/sbin/ifdown
rusnas ALL=(ALL) NOPASSWD: /sbin/ip
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/network-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/traceroute, /usr/bin/mtr-packet, /usr/bin/dig, /usr/bin/ncat
rusnas ALL=(ALL) NOPASSWD: /usr/bin/etherwake, /usr/sbin/arp-scan
```

### 2.4 Конфигурационные файлы

| Файл | Назначение |
|------|-----------|
| `/etc/network/interfaces` | IP, шлюз, VLAN, bonding |
| `/etc/resolv.conf` | DNS серверы, search domain |
| `/etc/hosts` | Локальные DNS-записи |
| `/proc/net/dev` | Статистика трафика (live) |

---

## 3. Экраны и компоненты

### 3.1 Header страницы

```
┌──────────────────────────────────────────────────────────────────┐
│  🌐 Сеть                                       [Применить изменения]│
│  Интерфейсы: ens3 ● UP  lo ● UP                                   │
└──────────────────────────────────────────────────────────────────┘
```

- Глобальная кнопка «Применить изменения» — активна только если есть несохранённые правки
- Статус-строка с индикаторами всех интерфейсов (зелёный/красный)
- Предупреждение при наличии unsaved changes: «⚠ Есть несохранённые изменения»

---

### 3.2 Вкладка 1: Интерфейсы

#### Карточка интерфейса

```
┌─────────────────────────────────────────────────────────────────┐
│  ens3                                             ● Подключён    │
│  ──────────────────────────────────────────────────────────────  │
│  IPv4:   192.168.1.100 / 24       [Изменить]                     │
│  Шлюз:   192.168.1.1                                             │
│  IPv6:   fe80::...                                               │
│  MAC:    52:54:00:ab:cd:ef                                       │
│  MTU:    1500                                                    │
│  Скорость: 1 Гбит/с                                              │
│                                                                  │
│  ▼ Трафик (последние 60 сек)                                     │
│  ↓ 2.3 МБ/с  [▁▂▃▅▄▆██▆▅▄]   ↑ 0.8 МБ/с  [▁▁▁▂▁▁▂▃▂▁]         │
│                                                                  │
│  [Откл. интерфейс]  [Переподключить]                             │
└─────────────────────────────────────────────────────────────────┘
```

#### Модал редактирования интерфейса

Поля:
- **Режим:** DHCP / Статический (radio)
- **IP-адрес** (только при статическом)
- **Маска подсети** (CIDR или /24 формат)
- **Шлюз по умолчанию**
- **MTU** (по умолчанию 1500)
- **Режим IPv6:** Выкл / Auto (SLAAC) / DHCPv6 / Статический
- **IPv6-адрес** + **Длина префикса** (если статический)

**Предупреждение при смене IP:**
```
⚠ Изменение IP-адреса прервёт текущее подключение к Cockpit.
Сессия автоматически восстановится через новый адрес.
[Всё равно применить]  [Отмена]
```

После применения — страница показывает счётчик «Переподключение через 5...4...3...» и делает `window.location.replace()` на новый IP.

#### VLAN

- Кнопка «+ Добавить VLAN» под списком интерфейсов
- Поля: Родительский интерфейс, VLAN ID (1–4094), IP/Маска (или DHCP)
- Запись в `/etc/network/interfaces` как `ens3.100 inet static ...`
- Удалить VLAN: кнопка в карточке + `ifdown` + удаление из interfaces

#### Bonding (агрегация каналов)

- Кнопка «+ Создать Bond» (если ≥2 физических интерфейса)
- Поля: Имя (bond0), Режим (LACP/Active-backup/Round-robin), Ведомые интерфейсы (checkbox)
- Требует `ifenslave` — при отсутствии показывает инструкцию

---

### 3.3 Вкладка 2: DNS и хосты

#### Секция DNS-серверов

```
┌─────────────────────────────────────────────────────────────────┐
│  DNS серверы                                    [Изменить]       │
│  Основной:     8.8.8.8                                           │
│  Вторичный:    8.8.4.4                                           │
│  Домен поиска: office.local                                      │
└─────────────────────────────────────────────────────────────────┘
```

- Читается из `/etc/resolv.conf`
- **⚠ Внимание:** если `/etc/resolv.conf` — симлинк на `systemd-resolved` или `resolvconf` — показывать предупреждение «Управляется resolvconf — изменения могут быть перезаписаны» + кнопка «Отключить resolvconf»

#### Кнопка «Проверить DNS»

Inline-тест прямо в секции:
```
[Проверить DNS]
→ google.com → 142.250.185.78 (23 мс) ✅
→ 8.8.8.8 → доступен (12 мс) ✅
```

#### Секция «Локальные хосты» (/etc/hosts)

Таблица записей из `/etc/hosts` (без системных 127.0.0.1):

| IP | Имя хоста | Псевдонимы | |
|----|-----------|-----------|---|
| 192.168.1.50 | nas-backup | nas-bak | ✏ 🗑 |
| 10.0.0.1 | router | gw | ✏ 🗑 |

- Кнопка «+ Добавить запись»
- Inline-редактирование (клик по строке)
- Изменения пишутся через `cockpit.file("/etc/hosts", {superuser:"require"}).replace()`

---

### 3.4 Вкладка 3: Маршруты

```
┌─────────────────────────────────────────────────────────────────┐
│  Статические маршруты                         [+ Добавить]       │
├──────────────┬───────────────┬────────────┬──────────────────────┤
│  Сеть        │  Шлюз         │  Интерф.   │                      │
├──────────────┼───────────────┼────────────┼──────────────────────┤
│  0.0.0.0/0   │  192.168.1.1  │  ens3      │ (шлюз по умолчанию) │
│  10.0.0.0/8  │  192.168.1.254│  ens3      │  ✏ 🗑               │
│  172.16.0.0/12│ 192.168.1.253│  ens3      │  ✏ 🗑               │
└──────────────┴───────────────┴────────────┴──────────────────────┘
```

- Данные из `ip -j route` + `/etc/network/interfaces` (post-up ip route add)
- Маршрут по умолчанию (0.0.0.0/0) — показывается но не удаляется отдельно (он часть настроек интерфейса)
- **Постоянные маршруты** — пишутся в `/etc/network/interfaces` как `post-up ip route add ...`
- **Временные маршруты** (runtime) — только через `ip route add` без сохранения

Модал добавления маршрута:
- Сеть назначения (CIDR): `10.0.0.0/8`
- Шлюз: `192.168.1.254`
- Интерфейс: select из доступных
- Метрика: число (необязательно)
- ☑ Сохранить постоянно (в `/etc/network/interfaces`)

---

### 3.5 Вкладка 4: Диагностика

#### Инструменты (toolbar — выбор инструмента)

```
[Ping]  [Traceroute]  [DNS lookup]  [Порт]  [WoL]
```

**Ping:**
- Хост/IP, количество пакетов (4/10/непрерывно), размер пакета
- Live вывод в textarea с цветом: успех зелёный, потеря красная
- Итог: Отправлено / Получено / Потеряно (%) / Avg RTT

**Traceroute:**
- Хост/IP
- Вывод hop-by-hop в таблицу: `# | IP | Hostname | RTT`
- Timeout per hop: 2 сек

**DNS lookup:**
- Хост для прямого lookup / IP для обратного
- Тип записи: A / AAAA / MX / NS / TXT / ANY
- DNS-сервер: авто (из /etc/resolv.conf) или кастомный
- Результат в таблице

**Проверка порта:**
- Хост:порт
- Протокол: TCP / UDP
- Timeout: 3 сек
- Результат: ✅ Открыт / ❌ Закрыт / ⏳ Timeout

**Wake-on-LAN:**
- MAC-адрес (с историей последних 5)
- Интерфейс отправки
- Кнопка «Отправить магический пакет»
- Подтверждение: «Пакет отправлен»
- Требует: `etherwake` или `wol`

---

## 4. Backend API (`network-api.py`)

Скрипт `/usr/share/cockpit/rusnas/scripts/network-api.py`, вызывается через:
```javascript
cockpit.spawn(['sudo', '-n', 'python3', SCRIPT, mode, ...], { err: 'message' })
```

### Команды

| Команда | Описание | Аргументы |
|---------|---------|-----------|
| `get-interfaces` | JSON всех интерфейсов (ip -j addr + ip -j route) | — |
| `get-dns` | Содержимое /etc/resolv.conf parsed | — |
| `get-hosts` | Записи /etc/hosts (без системных) | — |
| `get-routes` | Статические маршруты из ip route | — |
| `set-interface` | Перезаписать секцию в /etc/network/interfaces | iface json_config |
| `set-dns` | Перезаписать /etc/resolv.conf | nameservers search_domain |
| `set-hosts` | Перезаписать /etc/hosts | json_array |
| `add-route` | Добавить маршрут (temporary + optional persist) | network gw iface metric persist |
| `del-route` | Удалить маршрут | network gw |
| `ifup` | sudo ifdown $iface && sudo ifup $iface | iface |
| `ifdown` | sudo ifdown $iface | iface |

### Формат ответа

Все команды выводят JSON в stdout:
```json
{ "ok": true, "data": {...} }
// или
{ "ok": false, "error": "описание ошибки" }
```

### Парсинг `/etc/network/interfaces`

```python
def parse_interfaces(path="/etc/network/interfaces"):
    """
    Returns list of interface blocks:
    [
      {
        "name": "lo",
        "mode": "loopback",
        "stanzas": ["auto lo", "iface lo inet loopback"]
      },
      {
        "name": "ens3",
        "auto": True,
        "mode": "static",   # or "dhcp"
        "address": "192.168.1.100",
        "netmask": "255.255.255.0",
        "gateway": "192.168.1.1",
        "dns_nameservers": ["8.8.8.8"],
        "post_up": ["ip route add 10.0.0.0/8 via 192.168.1.254"]
      }
    ]
    """
```

### Запись изменений

```python
def write_interface_block(name, config):
    """
    1. Читает текущий /etc/network/interfaces
    2. Заменяет блок `iface <name> inet ...` и `auto <name>`
    3. Атомарная запись через tempfile + os.rename
    4. Вызывает: subprocess.run(["ifdown", name], ...) + ["ifup", name], ...)
    5. Возвращает {"ok": True} или {"ok": False, "error": ...}
    """
```

---

## 5. Frontend (`network.js`)

### Ключевые функции

```javascript
// Загрузка данных
function loadInterfaces()          // ip -j addr + ip -j route → renderInterfaceCards()
function loadDns()                 // get-dns → renderDnsSection()
function loadHosts()               // get-hosts → renderHostsTable()
function loadRoutes()              // get-routes → renderRoutesTable()

// Редактирование интерфейса
function openIfaceModal(ifaceName) // Заполнить форму + show modal
function saveIfaceModal()          // Валидация → set-interface → ifup → reload

// DNS
function saveDns()                 // Валидация → set-dns → reload

// Хосты
function saveHost(ip, hostname, aliases) // set-hosts (full rewrite)
function deleteHost(ip)

// Маршруты
function addRoute(network, gw, iface, metric, persist) // add-route
function deleteRoute(network, gw)                      // del-route

// Диагностика — с live output
function runPing(host, count, size)        // cockpit.spawn + stream stdout
function runTraceroute(host)               // cockpit.spawn + stream stdout → parse hops
function runDnsLookup(host, type, server)  // cockpit.spawn dig
function runPortCheck(host, port, proto)   // cockpit.spawn nc/timeout
function sendWol(mac, iface)               // cockpit.spawn etherwake

// Live трафик
function startTrafficPoll()               // setInterval 1s → /proc/net/dev delta → sparklines
function stopTrafficPoll()
```

### Глобальный стейт

```javascript
var _netInterfaces = [];         // Array of interface objects
var _netRoutes = [];             // Array of route objects
var _netHosts = [];              // Array of host entries
var _trafficPrev = {};           // prev bytes for delta calc: {iface: {rx, tx}}
var _diagRunning = false;        // true when a diag command is running
var _unsavedChanges = false;     // true if any pending changes
```

### Утилиты

```javascript
function netApi(args)            // cockpit.spawn(['sudo','-n','python3',SCRIPT, ...args])
                                 // → Promise<{ok, data, error}>
function validateCidr(str)       // returns {valid, ip, prefix} or {valid: false}
function validateIp(str)         // basic IPv4/IPv6 check
function formatSpeed(bps)        // "1.23 МБ/с" / "456 КБ/с" / "89 Б/с"
function formatBytes(bytes)      // "1.23 ГБ" / "456 МБ" / "123 КБ"
```

---

## 6. HTML (`network.html`)

### Структура

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <!-- theme, cockpit.css, style.css, network.css -->
</head>
<body>
  <!-- Page Header -->
  <div class="net-header">
    <h2>🌐 Сеть</h2>
    <div id="ifaceStatusBar">...</div>
    <button id="btnApply" class="btn btn-primary" disabled>Применить изменения</button>
  </div>

  <!-- Tabs -->
  <ul class="nav nav-tabs" id="netTabs">
    <li class="active"><a data-tab="interfaces">Интерфейсы</a></li>
    <li><a data-tab="dns">DNS и хосты</a></li>
    <li><a data-tab="routes">Маршруты</a></li>
    <li><a data-tab="diag">Диагностика</a></li>
  </ul>

  <!-- Tab: Interfaces -->
  <div id="tab-interfaces" class="net-tab-content">
    <div id="ifaceCards">...</div>
    <button id="btnAddVlan">+ VLAN</button>
    <button id="btnAddBond">+ Bond</button>
  </div>

  <!-- Tab: DNS & Hosts -->
  <div id="tab-dns" class="net-tab-content" style="display:none">
    <div id="dnsSection">...</div>
    <div id="hostsSection">...</div>
  </div>

  <!-- Tab: Routes -->
  <div id="tab-routes" class="net-tab-content" style="display:none">
    <table id="routesTable">...</table>
    <button id="btnAddRoute">+ Добавить</button>
  </div>

  <!-- Tab: Diagnostics -->
  <div id="tab-diag" class="net-tab-content" style="display:none">
    <div class="diag-toolbar">
      <!-- tool selector buttons -->
    </div>
    <div id="diagForm">...</div>
    <div id="diagOutput" class="net-diag-output">...</div>
  </div>

  <!-- Modals -->
  <div class="modal-overlay" id="ifaceModal" style="display:none">...</div>
  <div class="modal-overlay" id="routeModal" style="display:none">...</div>
  <div class="modal-overlay" id="vlanModal" style="display:none">...</div>
  <div class="modal-overlay" id="hostModal" style="display:none">...</div>
  <div class="modal-overlay" id="ipChangeWarnModal" style="display:none">
    <!-- reconnect countdown -->
  </div>

  <script src="js/network.js"></script>
</body>
</html>
```

---

## 7. CSS (`network.css`)

Новый файл `cockpit/rusnas/css/network.css`:

```css
/* Interface cards */
.net-iface-card { ... }
.net-iface-status-up   { color: var(--color-success); }
.net-iface-status-down { color: var(--color-danger); }

/* Traffic sparklines */
.net-sparkline { display: inline-block; width: 80px; height: 24px; }

/* Diagnostics output terminal */
.net-diag-output {
  font-family: monospace;
  background: var(--bg-th);
  border-radius: 6px;
  padding: 12px;
  min-height: 200px;
  max-height: 400px;
  overflow-y: auto;
  white-space: pre-wrap;
}
.net-diag-ok  { color: #4caf50; }
.net-diag-err { color: #f44336; }
.net-diag-hop { color: var(--color-muted); }

/* Toolbar — diag tool selector */
.net-tool-btn.active { background: var(--color-accent); color: #fff; }
```

---

## 8. Установочный скрипт (`install-network.sh`)

```bash
#!/usr/bin/env bash
# install-network.sh — Deploy rusNAS Network module to VM

VM="rusnas@10.10.10.72"
PASS="kl4389qd"
SSH="sshpass -p '$PASS' ssh -o StrictHostKeyChecking=no ..."

# 1. Copy frontend files
scp cockpit/rusnas/network.html        $VM:/tmp/rusnas-net/
scp cockpit/rusnas/js/network.js       $VM:/tmp/rusnas-net/
scp cockpit/rusnas/css/network.css     $VM:/tmp/rusnas-net/
scp cockpit/rusnas/scripts/network-api.py $VM:/tmp/rusnas-net/

# 2. Install files
$SSH "sudo cp /tmp/rusnas-net/network.html    /usr/share/cockpit/rusnas/"
$SSH "sudo cp /tmp/rusnas-net/network.js      /usr/share/cockpit/rusnas/js/"
$SSH "sudo cp /tmp/rusnas-net/network.css     /usr/share/cockpit/rusnas/css/"
$SSH "sudo cp /tmp/rusnas-net/network-api.py  /usr/share/cockpit/rusnas/scripts/"

# 3. Sudoers
$SSH "echo 'rusnas ALL=(ALL) NOPASSWD: /usr/sbin/ifup, /usr/sbin/ifdown' | sudo tee /etc/sudoers.d/rusnas-network"
$SSH "echo 'rusnas ALL=(ALL) NOPASSWD: /sbin/ip' >> /etc/sudoers.d/rusnas-network"
$SSH "echo 'rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/network-api.py *' >> /etc/sudoers.d/rusnas-network"
$SSH "echo 'rusnas ALL=(ALL) NOPASSWD: /usr/bin/traceroute, /usr/bin/dig, /usr/bin/ncat, /usr/bin/etherwake' >> /etc/sudoers.d/rusnas-network"
$SSH "sudo chmod 440 /etc/sudoers.d/rusnas-network"

# 4. Packages
$SSH "sudo apt-get install -y traceroute dnsutils netcat-openbsd etherwake"

# 5. Permissions
$SSH "sudo chmod 644 /usr/share/cockpit/rusnas/network.html"
$SSH "sudo chmod 644 /usr/share/cockpit/rusnas/js/network.js"
$SSH "sudo chmod 644 /usr/share/cockpit/rusnas/css/network.css"
$SSH "sudo chmod 755 /usr/share/cockpit/rusnas/scripts/network-api.py"

echo "✅  Network module deployed: https://10.10.10.72:9090/cockpit/@localhost/rusnas/network.html"
```

---

## 9. Порядок реализации

### Шаг 1 — manifest.json + HTML скелет
- Добавить `"network"` в manifest.json
- Создать `network.html` с 4 вкладками (пустые div)
- Проверить: вкладка появилась в sidebar

### Шаг 2 — Backend `network-api.py`
- `get-interfaces`: `ip -j addr` + `ip -j route` → JSON
- `get-dns`: `/etc/resolv.conf` → parsed JSON
- `get-hosts`: `/etc/hosts` → JSON (без системных)
- `get-routes`: `ip -j route` → JSON
- Тест на VM: `python3 network-api.py get-interfaces`

### Шаг 3 — Вкладка «Интерфейсы» (read-only)
- `loadInterfaces()` → карточки с IP, MAC, MTU
- Live трафик sparklines (polling /proc/net/dev)
- Статус-бар в хедере

### Шаг 4 — Редактирование интерфейса
- `set-interface` + `ifup` + `ifdown` в backend
- Модал + валидация IP/CIDR
- Предупреждение при смене IP + reconnect countdown

### Шаг 5 — Вкладка «DNS и хосты»
- `loadDns()` + `saveDns()`
- `loadHosts()` + CRUD хостов

### Шаг 6 — Вкладка «Маршруты»
- `loadRoutes()` + `addRoute()` + `deleteRoute()`
- Постоянные маршруты через post-up в interfaces

### Шаг 7 — Вкладка «Диагностика»
- Ping с live output
- Traceroute с hop-таблицей
- DNS lookup
- Проверка порта
- Wake-on-LAN

### Шаг 8 — VLAN / Bonding (если время позволяет)
- Отдельные модалы
- Запись в /etc/network/interfaces

### Шаг 9 — Полное тестирование + деплой
- Проверить смену IP (reconnect)
- Проверить добавление/удаление маршрутов
- Проверить все диагностические инструменты
- `./deploy.sh` + `./install-network.sh`

---

## 10. Безопасность

- **Пишем только в known файлы**: `/etc/network/interfaces`, `/etc/resolv.conf`, `/etc/hosts`
- **Атомарная запись**: tempfile + `os.rename()` — никогда прямо в конечный файл
- **Валидация IP**: перед записью, отклонять невалидные адреса
- **Не exec shell** в network-api.py — только `subprocess.run(["cmd", "arg"], ...)` без `shell=True`
- **Диагностика**: команды с hardcoded path (`/usr/bin/ping`), не принимать имя команды от пользователя

---

## 11. Известные ограничения

| Ограничение | Причина | Workaround |
|------------|---------|-----------|
| Нет поддержки multiple IPs на интерфейсе (IP aliases `ens3:1`) | Редко нужно в SMB | Добавить в v2 |
| Bonding требует `ifenslave` | Пакет не всегда установлен | Проверять + показывать инструкцию установки |
| `resolv.conf` может управляться resolvconf/systemd-resolved | На Debian 13 часто symlink | Детектировать + предупреждать |
| WoL работает только в локальной сети | Физическое ограничение L2 | Сообщать в UI |
| Смена IP рвёт Cockpit-сессию | Архитектурное ограничение | Reconnect countdown + auto-redirect |

---

## 12. Интеграция с Dashboard

После реализации — добавить в `dashboard.html`:

**Сетевая карточка** (уже есть `#card-net`) — добавить кнопку «⚙ Настройки сети» → `network.html`:
```javascript
// В dashboard.js, network modal или click handler:
document.getElementById('btnNetSettings').addEventListener('click', () => {
    cockpit.jump('/cockpit/@localhost/rusnas/network.html');
});
```

---

## 13. Обновление CLAUDE.md

После реализации добавить в CLAUDE.md секцию `## rusNAS Network`:

```markdown
## rusNAS Network

Управление сетью напрямую через ifupdown (не NetworkManager).

**Deploy:**
./install-network.sh

**Ключевые факты:**
- Читает/пишет /etc/network/interfaces атомарно (tempfile + rename)
- ifup/ifdown через sudoers (не через NM)
- Reconnect countdown при смене IP: 5 сек + window.location.replace()
- Диагностика: ping/traceroute/dig/ncat — live stdout через cockpit.spawn stream
- resolv.conf: детектирует symlink → предупреждение если управляется resolvconf
```
