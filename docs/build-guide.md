# rusNAS Build & Installation Guide

Руководство по сборке установочного пакета `.deb` и развертыванию rusNAS на чистой машине.

---

## Быстрый старт (30 секунд)

```bash
# На Mac (dev-машина) — собрать пакет через удалённый Debian хост:
BUILD_HOST=10.10.10.31 BUILD_USER=dvl92 ./build-deb.sh

# Скопировать на целевую машину:
scp rusnas-system_1.0.0-demo_amd64.deb demo-install.sh user@target:/tmp/

# На целевой машине — установить:
cd /tmp && sudo bash demo-install.sh
```

---

## Предварительные требования

### На dev-машине (Mac/Linux)

| Компонент | Команда установки | Назначение |
|-----------|------------------|------------|
| Node.js + npm | `brew install node` | Для terser (JS minification) |
| terser | `npm install -g terser` | Минификация JavaScript |
| python3 | Предустановлен на Mac | Проверка синтаксиса |
| SSH доступ | `~/.ssh/config` | Для удалённой сборки .deb |

**dpkg-deb** (опционально): Если установлен (`brew install dpkg`), сборка идёт локально. Если нет — автоматически используется удалённая сборка через SSH.

### На build-хосте (любая Debian/Ubuntu машина)

Нужен только `dpkg-deb` (предустановлен в любом Debian). Это может быть та же целевая машина, отдельная VM, или CI-сервер.

### На целевой машине

| Требование | Описание |
|-----------|----------|
| ОС | Debian 13 (Trixie) — обязательно |
| Архитектура | amd64 |
| Диски | Минимум 2 диска для RAID (помимо системного) |
| Сеть | Доступ к apt-репозиториям Debian |
| RAM | Минимум 2 GB (рекомендуется 4 GB) |

---

## Сборка пакета

### Шаг 1: Подготовка исходников

```bash
cd /path/to/RusNAS
git checkout feat/demo-release   # или main после merge
```

### Шаг 2: Сборка документации (один раз или при изменениях)

```bash
pip3 install mkdocs-material     # один раз
cd user-docs && python3 -m mkdocs build --clean && cd ..
```

Результат: `user-docs/site/` (~10 MB) — статический HTML сайт с руководством пользователя.

### Шаг 3: Сборка .deb

#### Вариант A: С удалённой сборкой (рекомендуется для Mac)

```bash
BUILD_HOST=10.10.10.31 BUILD_USER=dvl92 ./build-deb.sh
```

Скрипт:
1. Минифицирует JS через terser (15 файлов → `.min.js`)
2. Переписывает HTML ссылки на `.min.js`
3. Собирает все компоненты в `pkg/` дерево
4. Создаёт `tar.gz`, отправляет на BUILD_HOST
5. Запускает `dpkg-deb` на BUILD_HOST
6. Скачивает готовый `.deb` обратно

#### Вариант B: Локально на Linux

```bash
./build-deb.sh
```

Работает напрямую если `dpkg-deb` доступен (любая Debian/Ubuntu машина).

#### Вариант C: Ручная удалённая сборка

```bash
./build-deb.sh                    # создаст rusnas-pkg.tar.gz
scp rusnas-pkg.tar.gz user@debian:/tmp/
ssh user@debian '
  mkdir -p /tmp/pkg && cd /tmp/pkg
  tar xzf /tmp/rusnas-pkg.tar.gz
  dpkg-deb --root-owner-group --build . /tmp/rusnas-system_1.0.0-demo_amd64.deb
'
scp user@debian:/tmp/rusnas-system_1.0.0-demo_amd64.deb .
```

### Шаг 4: Проверка пакета

```bash
# Размер (ожидается 4-7 MB)
ls -lh rusnas-system_*.deb

# Содержимое
dpkg-deb --contents rusnas-system_*.deb | head -30

# JS защищены (только .min.js, нет исходников)
dpkg-deb --contents rusnas-system_*.deb | grep 'rusnas/js/'

# Документация включена
dpkg-deb --contents rusnas-system_*.deb | grep 'rusnas-help'
```

---

## Установка на целевую машину

### Что получает пользователь

Два файла:
```
rusnas-system_1.0.0-demo_amd64.deb   (~5 MB)
demo-install.sh                       (~8 KB)
```

### Процесс установки

```bash
# Скопировать файлы на машину (USB, scp, шара — любым способом)
# Зайти на машину по SSH или локально
cd /path/to/files
sudo bash demo-install.sh
```

### Что делает установщик

```
[1/8] Preflight checks
  ✓ Running as root
  ✓ Debian 13 (trixie)
  ✓ Package found

  Network configuration:
    Interface: enp0s1
    IP:        192.168.1.50 (Static)
    Gateway:   192.168.1.1

  Port availability:
  ✓ Port 80 (HTTP) is free
  ✓ Port 9090 (Cockpit) is free
  ✓ Port 8091 (WebDAV) is free

  Continue with installation? [Y/n]

[2/8] Installing system dependencies     (~3-5 мин на чистой системе)
[3/8] Installing rusNAS package
[4/8] Configuring user & permissions     (rusnas/rusnas)
[5/8] Setting up demo license            (Enterprise, all features)
[6/8] Configuring services               (nginx, Apache, Cockpit)
[7/8] Documentation
[8/8] Starting services

  rusNAS Demo установлен успешно!
  Cockpit:    https://<IP>:9090
  Landing:    http://<IP>
  Docs:       http://<IP>/help/
  Login:      rusnas / rusnas
```

### После установки

1. Открыть `https://<IP>:9090` в браузере
2. Принять self-signed SSL сертификат (Advanced → Proceed)
3. Войти: `rusnas` / `rusnas`
4. Нажать замок "Turn on administrative access" → ввести `rusnas`
5. Перейти в "Диски и RAID" для настройки массивов

---

## Что входит в пакет

### Cockpit plugin (14 страниц)

| Страница | Описание |
|----------|----------|
| Dashboard | Метрики, Night Report, статус Guard/RAID/UPS |
| Хранилище | SMB/NFS шары, iSCSI, WORM, FTP/WebDAV |
| Диски и RAID | Создание/управление массивами, SMART, SSD-кеш |
| Пользователи | CRUD пользователей и групп |
| Guard | Антишифровальщик (daemon + журнал + настройки) |
| Снапшоты | Btrfs snapshots, расписание, репликация |
| Дедупликация | duperemove + reflinks |
| ИБП | NUT (Network UPS Tools) |
| Анализ | Анализатор дискового пространства (treemap, charts) |
| Сеть | Интерфейсы, bonding, VLAN, сертификаты, DDNS |
| AI Ассистент | MCP + Yandex GPT / Claude |
| Performance | 12 уровней авто-оптимизации |
| Лицензия | Статус и активация |
| Приложения | Каталог контейнерных приложений (10 apps) |

### Backend daemons (6 штук)

| Daemon | Сервис | Назначение |
|--------|--------|------------|
| Guard | rusnas-guard.service | Антишифровальщик (inotify + entropy + honeypots) |
| Spindown | rusnas-spind.service | HDD spindown для backup-массивов |
| Metrics | rusnas-metrics.service | Prometheus + JSON HTTP endpoint |
| Perf Collector | rusnas-perf-collector.service | Сбор метрик производительности (10s) |
| Snapshots | rusnas-snapd.timer | Автоматические снапшоты по расписанию |
| Storage Collector | rusnas-storage-collector.timer | Сбор статистики дискового пространства |

### Защита исходников

| Тип файлов | Защита | В пакете |
|-----------|--------|----------|
| JavaScript (15 файлов) | terser minification | Только `.min.js` |
| Vendor JS (Chart.js) | Уже минифицированы | `.min.js` as-is |
| Python (39 файлов) | Исходники (для production — pyarmor) | `.py` |
| HTML/CSS | Без обфускации | As-is |

---

## Обновление версии

```bash
# 1. Изменить версию
echo "1.1.0-demo" > VERSION

# 2. Пересобрать
BUILD_HOST=10.10.10.31 BUILD_USER=dvl92 ./build-deb.sh

# 3. На целевой машине — обновить
sudo dpkg --force-overwrite -i rusnas-system_1.1.0-demo_amd64.deb
```

Конфиги в `/etc/rusnas-guard/` сохраняются при обновлении (conffiles).

---

## Структура файлов в пакете

```
rusnas-system_VERSION_amd64.deb
├── DEBIAN/
│   ├── control          # Метаданные + зависимости
│   ├── postinst         # Создание dirs, права, systemctl enable
│   ├── prerm            # Остановка сервисов
│   └── conffiles        # Защищённые конфиги
├── etc/
│   ├── rusnas-guard/    # Guard config + ransom_extensions.txt
│   ├── sudoers.d/rusnas # Consolidated NOPASSWD rules (~80 правил)
│   └── apt/apt.conf.d/  # Pre-upgrade snapshot hook
├── lib/systemd/system/  # 10 services + 5 timers
├── usr/
│   ├── share/cockpit/rusnas/    # Cockpit plugin
│   │   ├── *.html (14)
│   │   ├── js/*.min.js (17)
│   │   ├── css/*.css (7)
│   │   ├── scripts/*.py (8)
│   │   ├── cgi/*.py (4)
│   │   ├── catalog/ (10 apps)
│   │   ├── assets/ (favicon, logo)
│   │   └── manifest.json
│   ├── share/cockpit/branding/debian/  # Login branding
│   ├── share/rusnas-help/     # MkDocs documentation (~10 MB)
│   ├── lib/rusnas-guard/      # Guard daemon (6 py)
│   ├── lib/rusnas/spind/      # Spindown daemon (6 py)
│   ├── lib/rusnas/cgi/        # CGI backend (2 py)
│   ├── lib/rusnas/sectest/    # Security self-test (11 py + wordlists)
│   ├── local/bin/             # CLI tools (rusnas-snap, rusnas-worm, dedup)
│   └── local/lib/rusnas/      # Metrics server
└── var/www/rusnas-landing/    # Landing page + fonts + favicon
```

---

## Troubleshooting

### dpkg конфликт с branding.css
```
trying to overwrite '/usr/share/cockpit/branding/debian/branding.css',
which is also in package cockpit-ws
```
Решение: `dpkg --force-overwrite -i rusnas-system_*.deb` (demo-install.sh делает это автоматически)

### Guard daemon в состоянии "activating"
Нормально на чистой системе — нет Btrfs volumes для мониторинга. После создания RAID и шар Guard перейдёт в `active`.

### macOS ._ файлы ломают dpkg
macOS tar добавляет `._*` metadata файлы. build-deb.sh использует `COPYFILE_DISABLE=1` + `--no-mac-metadata` для предотвращения.

### Port 80 занят
demo-install.sh проверяет порты перед установкой и предупреждает. nginx переконфигурирует порт 80, Apache перемещается на 8091.
