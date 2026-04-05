xt# rusNAS — Cockpit Plugin: Страница «ИБП / UPS»

**Файл задачи для Claude Code**
Статус: **✅ РЕАЛИЗОВАН** (ветка `main`, задеплоен 2026-03-16)
Версия: v1.0
Зависимости: `nut` (nut-server + nut-client + nut-scanner, Debian 13 Trixie)

---

## Статус реализации

| Компонент | Статус | Файл |
|-----------|--------|------|
| Cockpit UI | ✅ | `cockpit/rusnas/ups.html` |
| JavaScript логика | ✅ | `cockpit/rusnas/js/ups.js` |
| Уведомления (email/Telegram hook) | ✅ | `rusnas-ups/rusnas-ups-notify.sh` |
| Deploy скрипт | ✅ | `install-ups.sh` |
| Запись в manifest.json (order 8) | ✅ | `cockpit/rusnas/manifest.json` |

---

## 1. Цель и концепция

Управление источниками бесперебойного питания (ИБП/UPS) на уровне Synology DSM — полный контроль из Cockpit без SSH.

**Целевые пользователи:** SMB-администраторы с APC, Eaton, CyberPower, Powercom или любым SNMP/USB UPS.

**Аналог Synology DSM:** DSM > Control Panel > Hardware & Power > UPS
- Статус питания и заряда батареи в реальном времени
- Настройка порога времени на батарее и процента заряда для безопасного выключения
- Режим сетевого UPS-сервера (несколько NAS-устройств от одного ИБП)
- Уведомления при переходе на батарею / низком заряде

---

## 2. Технический стек

### NUT (Network UPS Tools)

| Компонент | Роль |
|-----------|------|
| `nut-driver` / `upsdrvctl` | Драйвер — опрашивает UPS по USB/SNMP/сети |
| `upsd` | Демон данных — порт 3493, принимает запросы |
| `upsmon` | Монитор — отслеживает события, запускает shutdown |
| `upsc` | CLI-клиент — разовый опрос переменных |
| `nut-scanner` | Сканер — обнаружение подключённых UPS |

### Пакеты Debian 13

```bash
apt install nut
# Включает: nut-server, nut-client, nut-scanner, upsc, upscmd
```

### Конфигурационные файлы

| Файл | Назначение |
|------|-----------|
| `/etc/nut/nut.conf` | Режим работы: `none` / `standalone` / `netserver` / `netclient` |
| `/etc/nut/ups.conf` | Описание UPS-устройств: драйвер, порт, параметры |
| `/etc/nut/upsd.conf` | Адреса прослушивания upsd |
| `/etc/nut/upsd.users` | Пользователи для аутентификации upsd |
| `/etc/nut/upsmon.conf` | Логика мониторинга и shutdown |

---

## 3. Режимы работы NUT

### standalone (USB UPS, только этот хост)
```ini
# /etc/nut/nut.conf
MODE=standalone
```

### netserver (этот хост + другие NAS/серверы в сети)
```ini
MODE=netserver
# upsd.conf: LISTEN 0.0.0.0 3493
```

### netclient (UPS подключён к другому хосту)
```ini
MODE=netclient
# upsmon.conf: MONITOR ups@192.168.1.10 1 monuser pass secondary
```

---

## 4. Архитектура страницы UPS

### 4.1 Структура файлов

```
cockpit/rusnas/
├── ups.html              ← новая страница
└── js/
    └── ups.js            ← логика UI

rusnas-ups/
└── rusnas-ups-notify.sh  ← скрипт уведомлений (NOTIFYCMD)

install-ups.sh            ← деплой на VM
```

### 4.2 Разделы страницы

#### Блок 1 — Статус ИБП (верхний)
- Большой статус-бейдж: `🟢 Питание от сети` / `🟡 Работает от батареи` / `🔴 Критический заряд` / `⚫ ИБП не настроен`
- Карточки метрик:
  - Заряд батареи (%) + прогресс-бар
  - Запас хода (мин) — `battery.runtime / 60`
  - Нагрузка (%) — `ups.load`
  - Входное напряжение (В) — `input.voltage`
  - Модель — `device.model` + `device.mfr`
- Обновление каждые **5 секунд** через `upsc -j`

#### Блок 2 — Конфигурация UPS
- Toggle: **ИБП включён / выключен** (записывает `nut.conf MODE=standalone|none`)
- Поле: **Имя UPS** (идентификатор в NUT, по умолчанию `myups`)
- Поле: **Описание** (свободный текст, `desc` в ups.conf)
- Dropdown: **Тип подключения**: USB (`usbhid-ups`) / SNMP (`snmp-ups`) / Сеть (netclient)
  - USB: кнопка **Определить автоматически** → `nut-scanner -U`
  - SNMP: поля host + community
  - Сеть: поля хост:порт + пользователь + пароль
- Кнопка **Сохранить конфигурацию** + **Перезапустить NUT**

#### Блок 3 — Параметры защиты (Shutdown thresholds)
- Toggle: **Безопасное выключение** при потере питания
- Slider/input: **Заряд батареи (%)** — выключить при ≤ X% (по умолчанию 20%)
- Slider/input: **Запас хода (мин)** — выключить при ≤ X мин (по умолчанию 5 мин)
- Toggle: **Задержка shutdown** — ждать N секунд после перехода на батарею
- Кнопка **Сохранить**

#### Блок 4 — Сетевой UPS-сервер
- Toggle: **Предоставить UPS другим устройствам в сети** (переключает MODE=netserver)
- Отображение: IP-адрес и порт (3493) для настройки других устройств
- Таблица клиентов (из `upsd -c reload && upsc -l`)

#### Блок 5 — Журнал событий UPS
- Последние 20 событий из `/var/log/nut/upsmon.log` или syslog
- Фильтр по типу: ONBATT / ONLINE / LOWBATT / COMMLOST / SHUTDOWN

---

## 5. ups.js — ключевые паттерны

### Опрос статуса

```javascript
const UPS_NAME = "myups";  // читается из конфига

function loadUpsStatus() {
    cockpit.spawn(["sudo", "-n", "upsc", "-j", UPS_NAME + "@localhost"],
        { err: "message" })
    .done(function(out) {
        var data = safeJson(out);
        renderUpsStatus(data);
    })
    .fail(function(err) {
        // UPS не настроен или драйвер не запущен
        showNoUpsState();
    });
}

setInterval(loadUpsStatus, 5000);
```

**Формат `upsc -j`** (NUT 2.8+, доступен на Debian 13):
```json
{
  "battery.charge": "100",
  "battery.runtime": "2520",
  "ups.load": "12",
  "ups.status": "OL",
  "input.voltage": "230.0",
  "device.model": "Back-UPS 700",
  "device.mfr": "APC"
}
```

### ups.status флаги

| Флаг | Значение | Цвет UI |
|------|----------|---------|
| `OL` | On Line — питание от сети | 🟢 зелёный |
| `OB` | On Battery — батарея | 🟡 жёлтый |
| `OB LB` | Low Battery — критично | 🔴 красный |
| `CHRG` | Зарядка | 🔵 синий |
| `RB` | Replace Battery | 🟠 оранжевый |
| `COMMLOST` | Нет связи с UPS | ⚫ серый |

```javascript
function parseUpsStatus(statusStr) {
    var flags = statusStr.split(" ");
    if (flags.includes("LB")) return { cls: "danger", text: "Критический заряд" };
    if (flags.includes("OB")) return { cls: "warning", text: "Работает от батареи" };
    if (flags.includes("CHRG")) return { cls: "info", text: "Зарядка" };
    if (flags.includes("RB")) return { cls: "warning", text: "Замените батарею" };
    if (flags.includes("OL")) return { cls: "success", text: "Питание от сети" };
    return { cls: "default", text: "Нет данных" };
}
```

### Сохранение конфига через cockpit.file

```javascript
function saveNutConfig(mode, upsName, driver, desc) {
    var nutConf = "MODE=" + mode + "\n";
    var upsConf = "[" + upsName + "]\n" +
                  "  driver = " + driver + "\n" +
                  "  port = auto\n" +
                  "  desc = \"" + desc + "\"\n";

    Promise.all([
        cockpit.file("/etc/nut/nut.conf", { superuser: "require" }).replace(nutConf),
        cockpit.file("/etc/nut/ups.conf",  { superuser: "require" }).replace(upsConf)
    ]).then(function() {
        restartNut();
    });
}
```

### Перезапуск NUT

```javascript
function restartNut() {
    cockpit.spawn(["sudo", "-n", "systemctl", "restart", "nut.target"],
        { err: "message" })
    .done(function() {
        showAlert("success", "NUT перезапущен");
        setTimeout(loadUpsStatus, 2000);
    });
}
```

### Автообнаружение USB UPS

```javascript
function scanUsbUps() {
    setScanState(true);
    cockpit.spawn(["sudo", "-n", "nut-scanner", "-U"],
        { err: "message" })
    .done(function(out) {
        // Парсим вывод nut-scanner формата ups.conf
        var match = out.match(/driver\s*=\s*(\S+)/);
        if (match) {
            document.getElementById("ups-driver").value = match[1];
            showAlert("success", "UPS обнаружен: " + match[1]);
        }
    })
    .always(function() { setScanState(false); });
}
```

---

## 6. Конфигурационные шаблоны

### /etc/nut/upsd.users (создаётся при install)
```ini
[upsmon]
  password = rusnas_nut_2026
  upsmon primary
```

### /etc/nut/upsmon.conf (шаблон)
```
MONITOR myups@localhost 1 upsmon rusnas_nut_2026 primary
SHUTDOWNCMD "/sbin/shutdown -h +0 'UPS critical — shutting down'"
POWERDOWNFLAG /etc/killpower
MINSUPPLIES 1
RBWARNTIME 43200
NOTIFYCMD /usr/local/bin/rusnas-ups-notify
NOTIFYFLAG ONLINE  SYSLOG+EXEC
NOTIFYFLAG ONBATT  SYSLOG+EXEC
NOTIFYFLAG LOWBATT SYSLOG+EXEC+WALL
NOTIFYFLAG COMMLOST SYSLOG
NOTIFYFLAG SHUTDOWN SYSLOG+EXEC+WALL
NOTIFYFLAG REPLBATT SYSLOG+EXEC
```

### /etc/nut/upsd.conf (шаблон)
```
LISTEN 127.0.0.1 3493
MAXAGE 15
STATEPATH /run/nut
```

---

## 7. Скрипт уведомлений (rusnas-ups-notify.sh)

```bash
#!/bin/bash
# NOTIFYCMD hook — вызывается upsmon при событиях UPS
# Переменная $NOTIFYTYPE: ONLINE, ONBATT, LOWBATT, COMMLOST, SHUTDOWN, REPLBATT
# Переменная $UPSNAME: имя UPS

MSG="[rusNAS UPS] $NOTIFYTYPE: $UPSNAME"

# Telegram
if [ -f /etc/rusnas/telegram.conf ]; then
    source /etc/rusnas/telegram.conf
    curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
        -d chat_id="$TG_CHAT_ID" -d text="$MSG" >/dev/null 2>&1
fi

# Email (через sendmail/msmtp если настроен)
if command -v sendmail >/dev/null 2>&1; then
    echo -e "Subject: $MSG\n\n$MSG\n\nUPS Status: $(upsc $UPSNAME@localhost ups.status 2>/dev/null)" \
    | sendmail -t rusnas@localhost 2>/dev/null || true
fi

logger -t rusnas-ups "$MSG"
exit 0
```

---

## 8. install-ups.sh — деплой на VM

```bash
#!/bin/bash
set -e

VM="rusnas@10.10.10.72"
PASS="kl4389qd"

echo "=== Устанавливаем NUT на VM ==="
sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no $VM \
    "sudo apt-get install -y nut >/dev/null 2>&1 && echo 'NUT установлен'"

echo "=== Копируем скрипт уведомлений ==="
sshpass -p "$PASS" scp -o StrictHostKeyChecking=no \
    rusnas-ups/rusnas-ups-notify.sh $VM:/tmp/
sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no $VM \
    "sudo cp /tmp/rusnas-ups-notify.sh /usr/local/bin/rusnas-ups-notify && \
     sudo chmod +x /usr/local/bin/rusnas-ups-notify"

echo "=== Настраиваем sudoers ==="
sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no $VM "sudo tee /etc/sudoers.d/rusnas-nut > /dev/null <<'EOF'
rusnas ALL=(ALL) NOPASSWD: /usr/bin/upsc
rusnas ALL=(ALL) NOPASSWD: /usr/bin/nut-scanner
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl start nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl stop nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl status nut.target
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/upsdrvctl
EOF
"

echo "=== Деплоим Cockpit plugin ==="
./deploy.sh

echo "=== Готово! ==="
echo "Откройте Cockpit → ИБП для настройки UPS"
```

---

## 9. Sudoers

```
# /etc/sudoers.d/rusnas-nut
rusnas ALL=(ALL) NOPASSWD: /usr/bin/upsc
rusnas ALL=(ALL) NOPASSWD: /usr/bin/nut-scanner
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl start nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl stop nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart nut.target
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl status nut.target
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/upsdrvctl
```

---

## 10. manifest.json

```json
"ups": {
  "label": "ИБП 🔋",
  "order": 8
}
```

---

## 11. Важные факты реализации

### upsc -j (JSON mode)
Доступен в NUT 2.8+. Debian 13 Trixie поставляет NUT 2.8.x — JSON поддерживается.
Fallback: парсить `upsc myups@localhost` построчно (`VAR: value`).

### Когда UPS не подключён
`upsc` завершается с ошибкой `Error: Driver not connected`. UI показывает state "ИБП не настроен" с инструкцией.

### superuser в iframe
НЕ использовать `superuser: "require"` в cockpit.spawn — вызывает polkit timeout в iframe-контексте.
Использовать `["sudo", "-n", "upsc", ...]` — покрывается sudoers.

### cockpit.file для записи конфигов NUT
```javascript
cockpit.file("/etc/nut/nut.conf", { superuser: "require" }).replace(content)
```
Это корректно работает даже в iframe (cockpit.file использует отдельный канал, не polkit popup).

### Если NUT не установлен
При первом открытии страницы — проверяем `which upsc`. Если нет — показываем banner с кнопкой "Установить NUT" (`apt-get install nut`).

---

## 12. Паритет с Synology DSM

| Функция DSM | rusNAS реализация | Статус |
|-------------|------------------|--------|
| Статус ИБП (заряд, нагрузка, напряжение) | `upsc -j` → карточки | ✅ |
| Режим USB | `usbhid-ups driver` | ✅ |
| Режим SNMP | `snmp-ups driver` | ✅ |
| Сетевой клиент | `MODE=netclient` | ✅ |
| Сетевой сервер | `MODE=netserver` | ✅ |
| Порог заряда для shutdown | `override.battery.charge.low` | ✅ |
| Порог времени для shutdown | `override.battery.runtime.low` | ✅ |
| Уведомления при переходе на батарею | `NOTIFYCMD rusnas-ups-notify.sh` | ✅ |
| Уведомление "Замените батарею" | `REPLBATT` flag → notify | ✅ |
| Авто-сканирование USB UPS | `nut-scanner -U` | ✅ |
| Журнал событий UPS | syslog + journal парсинг | ✅ |
| Safe shutdown при отключении питания | `upsmon + SHUTDOWNCMD` | ✅ |
