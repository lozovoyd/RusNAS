# Быстрый старт для разработчика

## Предварительные требования

- macOS / Linux
- UTM или QEMU для VM
- Node.js 18+ (для сборки документации)
- Python 3.11+

## Настройка окружения

### 1. Клонирование репозитория

```bash
git clone https://github.com/lozovoyd/RusNAS.git
cd RusNAS
```

### 2. Подключение к VM

```bash
# SSH доступ
ssh rusnas@10.10.10.72
# Пароль: kl4389qd
```

### 3. Деплой плагина

```bash
./deploy.sh
```

После деплоя откройте `https://10.10.10.72:9090/` в браузере.

## Структура проекта

```
cockpit/rusnas/          # Cockpit плагин (frontend)
  ├── manifest.json      # Манифест (CSP, routing, menu)
  ├── *.html             # 12 HTML-страниц
  ├── css/               # style.css + dashboard.css
  └── js/                # 15 JS-файлов (ES5)

rusnas-guard/daemon/     # Guard антишифровальщик (Python)
rusnas-snap/             # Снапшоты CLI (Python)
rusnas-dedup/            # Дедупликация (Bash + systemd)
rusnas-metrics/          # Prometheus metrics (Python)
ansible/roles/           # Ansible провизионирование
```

## Ключевые паттерны

### cockpit.spawn — выполнение команд

```javascript
// ПРАВИЛЬНО: через sudo -n с err:"message"
cockpit.spawn(["sudo", "-n", "smartctl", "-i", "/dev/sda"], { err: "message" })
  .done(function(out) { /* JSON в out */ })
  .fail(function(ex) { /* ошибка */ });
```

!!! danger "Никогда"
    - НЕ использовать `superuser: "require"` в iframe (timeout polkit)
    - НЕ использовать `bash -c "sudo cmd | grep ..."` (bash без прав)
    - НЕ использовать `err: "out"` (смешивает stderr в stdout → ломает JSON)

### cockpit.file — чтение/запись файлов

```javascript
// Чтение (без sudo)
cockpit.file("/etc/rusnas/dedup-config.json").read()
  .done(function(content) { var cfg = JSON.parse(content); });

// Запись (с привилегиями)
cockpit.file("/etc/sysctl.d/99-rusnas-perf.conf", { superuser: "require" })
  .replace(newContent);
```

### Promise.all с cockpit.spawn

```javascript
// cockpit.spawn НЕ возвращает нативный Promise!
// Оборачивать обязательно:
function spawnPromise(args) {
  return new Promise(function(resolve, reject) {
    cockpit.spawn(args, { err: "message" }).done(resolve).fail(reject);
  });
}

Promise.all([spawnPromise(cmd1), spawnPromise(cmd2)])
  .then(function(results) { /* ... */ })
  .catch(function(err) { /* ОБЯЗАТЕЛЬНО .catch() */ });
```

## Сборка документации

```bash
npm install                        # Установить JSDoc + jsdoc2md
pip install -r docs/requirements-docs.txt  # MkDocs + Material
npm run docs                       # Собрать docs-site/
npm run docs:serve                 # Локальный сервер :8000
```
