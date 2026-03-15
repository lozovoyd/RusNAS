# rusNAS — История разработки проекта

Хронология ключевых решений и результатов по всем чат-сессиям проекта.
Передаётся в Claude Code вместе с CLAUDE.md для полного контекста.

> ⚠️ ВАЖНО: этот файл только ДОПОЛНЯЕТСЯ. Никогда не перезаписывать целиком.

---

## Сессия 1 — Архитектура и ТЗ
**Дата:** февраль 2026

### Что было сделано

- Определили бизнес-модель: коммерческий NAS для SMB-клиентов, собственное железо, 1000+ устройств
- Выбрали функциональный ориентир: Synology RS1619xs+
- Сформировали полный технический стек
- Создали Word-документ с ТЗ

### Ключевые архитектурные решения

**ZFS vs Btrfs:** Изначально рассматривали ZFS как enterprise-решение. Отказались потому что ZFS не поддерживает online миграцию уровня RAID (например RAID5 → RAID6 без пересоздания). Это hard requirement бизнес-модели — клиент должен мочь расширить массив без downtime. Финальный выбор: **Btrfs + mdadm**.

**Итоговый стек:**
```
ОС:           Debian (начали с 12, перешли на 13 Trixie)
RAID:         mdadm — Basic, JBOD, RAID 0/1/5/6/10, RAID F1
ФС:           Btrfs (снапшоты, online resize)
SMB:          Samba
NFS:          knfsd
FTP:          vsftpd
WebDAV:       Apache
Rsync:        rsync daemon
iSCSI:        targetcli-fb (LIO)
Веб-UI:       Cockpit + плагин rusnas
Уведомления:  email (msmtp) + Telegram (bash + curl)
Файрвол:      nftables
Провизионинг: Ansible монорепо
Обновления:   reprepro + nginx deb-репо
```

---

## Сессия 2 — Сборка стека на VM
**Дата:** февраль–март 2026

### Среда
- Host: Intel Mac, UTM (QEMU)
- VM: Debian 13 Trixie x86_64, 2 ядра, 4GB RAM
- Диски: 1×16GB системный + 3×10GB для тестового RAID
- Перенос файлов: scp через пользователя rusnas (root SSH отключён)

### Что было установлено и протестировано

| Компонент | Статус | Примечания |
|-----------|--------|-----------|
| mdadm RAID5 | ✅ | /dev/md0, три диска |
| Btrfs | ✅ | UUID-based fstab, /mnt/data |
| Samba | ✅ | Проверено с Mac через smbutil и Finder |
| NFS | ✅ | mountd зафиксирован на порт 20048 |
| vsftpd | ✅ | Пассивные порты 30000–30100, нужны правила файрвола |
| WebDAV (Apache) | ✅ | Digest auth, нужен Options Indexes |
| Rsync daemon | ✅ | Пользователь rsyncuser с паролём |
| iSCSI (targetcli-fb) | ✅ | fileio backstore |
| Cockpit | ✅ | + cockpit-storaged |
| nftables | ✅ | |

### Cockpit плагин — первая версия (rusnas-storage)

Разработан итеративно. Решённые проблемы:
- Неправильный путь к cockpit.js → правильный: `../base1/cockpit.js`
- CSP блокирует inline обработчики → перенесли всё в `addEventListener`
- JS не выполнялся → добавили `unsafe-inline` и `unsafe-eval` в CSP в `manifest.json`

### Решённые технические проблемы
- Бинарники mdadm, mkfs.btrfs не в PATH → добавили `/sbin` в `.bashrc`
- VPN на хосте отключал сеть VM → переключили UTM на Bridged режим
- Длинные команды обрезаются при вставке в терминал → workflow: файл + scp
- macOS NFS mount не работает → нужна опция `insecure` в `/etc/exports`

---

## Сессия 3 — Cockpit плагин: доработка и раздел Disks & RAID
**Дата:** март 2026

### Что было исправлено

**1. smb.conf — критический баг**
Python regex для редактирования INI-блоков оказался ненадёжным. Решение — `sed` range pattern:
```bash
sed -i '/^\[sharename\]/,/^\[/{/^\[sharename\]/d; /^\[/!d}' /etc/samba/smb.conf
```

**2. NFS — дублирование записей**
При каждом добавлении экспорта запись дублировалась. Решение — перед append удалять старую запись:
```bash
sed -i '\|^/path |d' /etc/exports
```

**3. iSCSI targetcli — не выполнялся**
`superuser: "require"` в manifest.json покрывает файловые операции, но не subprocess-вызовы targetcli. Решение — явный `sudo` в каждом вызове:
```javascript
cockpit.spawn(["sudo", "targetcli", ...])
```

**4. Архитектура путей шар**
Dropdown заполняется через `findmnt --real`, фильтруя устройства `/dev/md*`, `/dev/sd[b-z]*`, `/dev/nvme*`.

### Новый раздел: Диски и RAID (disks.html + disks.js)

- Парсер `/proc/mdstat`: состояния `active` / `degraded` / `inactive` / `resyncing` / `reshaping`
  - ⚠️ Важно: проверяются оба ключевых слова — `resync` И `reshape`
- S.M.A.R.T. информация о дисках через `sudo smartctl -i`
- Безопасное извлечение: `--fail → --remove → device/delete`, подтверждение по серийному номеру
- Replace disk и Expand array — отдельные операции
- Авто-обновление каждые 4 сек при degraded/resyncing

---

## Сессия 4 — HA кластер (исследование)
**Дата:** март 2026

Исследовательская сессия. В код ничего не легло, но решения приняты для будущей реализации.

### Архитектура HA-кластера
- **Репликация данных:** DRBD поверх mdadm-массива (Протокол C — синхронный)
- **Failover:** Pacemaker + Corosync (~10–30 сек даунтайм при падении узла)
- **Арбитр:** Raspberry Pi 4 (~$50) — iSCSI SBD диск + QNetd

```
Node1 ──[eth0]── Switch ──[eth0]── Node2   (клиенты + SBD iSCSI)
Node1 ──[eth1]─────────────────── Node2    (прямой кабель, DRBD)
                Switch
                  │
            Raspberry Pi 4
            ├── iSCSI target (SBD диск)
            └── QNetd (кворум)
```

---

## Сессия 5 — Git, DevOps, UI redesign
**Дата:** 12 марта 2026

### Что было сделано

**1. Git-репозиторий**
Инициализирован git-репо в `/Users/dvl92/projects/RusNAS/`. Уточнена реальная структура файлов:
```
/usr/share/cockpit/rusnas/
├── manifest.json
├── index.html       ← (не storage.html как было записано)
├── disks.html
├── users.html
├── css/style.css
└── js/
    ├── app.js       ← (не storage.js)
    ├── disks.js
    └── users.js
```

**2. deploy.sh**
`scp → /tmp/ → sudo cp → chmod 644/755`. Проблемы: sshpass, sudo -S, права 600 после scp.

**3. Фикс страницы Users (зависала на "Загрузка...")**
- `initUsers()` не вызывалась — нет `DOMContentLoaded` listener
- `showModal/closeModal` не определены в `users.js`
- Нет `.fail()` на `cockpit.spawn()` → pending никогда не достигал 0

**4. Редизайн UI — dark mode + CSS custom properties**
- CSS custom properties для всех цветов
- `@media (prefers-color-scheme: dark)` — автоматическая тёмная тема
- PatternFly v6 inspired дизайн-токены
- Создан `ui.md` — UI guidelines

---

## Сессия 6 — rusNAS Guard (Антишифровальщик)
**Дата:** 13 марта 2026 | Ветка: `feature/rusnas-guard`

### Архитектура daemon (Python 3)
5 модулей в `/usr/lib/rusnas-guard/`: `guard.py`, `detector.py`, `entropy.py`, `honeypot.py`, `response.py`, `socket_server.py`

### Четыре метода обнаружения

| Метод | Триггер | Примечание |
|-------|---------|-----------|
| Honeypot | Любое изменение bait-файла | Мгновенно |
| Entropy | >7.2 бит/байт при IN_CLOSE_WRITE | Пропускает mp4/zip/jpg и <16KB |
| IOPS anomaly | rate > median + 4×σ И rate > 50 ops/min | Активен после 7-дневного обучения |
| Extensions | ~200 расширений (.locked/.encrypted/etc.) | |

### Три режима реагирования
- **Monitor** — только лог и уведомления
- **Active** — снапшот + блокировка IP (nftables) + отключение SMB
- **Super-Safe** — снапшоты всех томов → уведомление → стоп всех служб → poweroff через 30 сек

### Guard PIN
- Bcrypt hash в `/etc/rusnas-guard/guard.pin`
- Независим от пароля Cockpit-администратора
- Session token 30 минут (только в памяти daemon)
- Сброс: `sudo rusnas-guard --reset-pin` (только root/SSH)

---

## Сессия 7 — Guard PIN Reset
**Дата:** 14 марта 2026 | Ветка: `feature/rusnas-guard`

Реализован механизм сброса Guard PIN. Сброс НЕ доступен через UI — требует root/SSH.
- `guard.py --reset-pin`: проверяет `os.geteuid() == 0`, удаляет `guard.pin`
- `ln -sf /usr/lib/rusnas-guard/guard.py /usr/local/sbin/rusnas-guard`
- Подсказка в PIN-диалоге UI с командой сброса

---

## Сессия 8 — Guard: исправление багов, тестирование, мёрж в main
**Дата:** 14 марта 2026 | Ветка: `feature/rusnas-guard → main`

### Критические баги

**Баг 1: IOPS counter всегда показывал 0**
`InotifyTrees` возвращает `watch_path` = поддиректорию, а `_iops_windows` заполнен ключами root-путей. При первом событии в поддиректории `_iops_windows[watch_path]` бросает `KeyError` — поток детектора падает молча.
Исправление: `_root_path(watch_path)` нормализует поддиректорию до root-пути из конфига.

**Баг 2: Socket permissions**
`chmod 0o660` (root:root) → permission denied для Cockpit bridge (не-root). `RuntimeDirectoryMode=0750` → директория непроходима. `superuser: "require"` в iframe → polkit timeout.
Исправления: сокет `0o666`, `RuntimeDirectoryMode=0755`, убрано `superuser: "require"` из `guard.js`.

**Баг 3: `/etc/rusnas-guard/` chmod 700**
Cockpit bridge не мог читать `ransom_extensions.txt`. Исправлено: `chmod 755`.

### Тестирование (18 тестов через Playwright MCP — все ✅)
Включая: IOPS-триггер (777 ops/min), Entropy-триггер (entropy ~8.0 > 7.2), Honeypot-триггер.

---

## Сессия 9 — rusNAS Snapshots: Btrfs snapshot manager
**Дата:** 14 марта 2026 | Ветка: `feature/snapshots`

### Что реализовано

**CLI `rusnas-snap`** (`/usr/local/bin/rusnas-snap`, ~500 строк Python 3):
- SQLite БД `/var/lib/rusnas/snaps.db` (WAL-режим)
- Команды: `create`, `list`, `delete`, `lock/unlock`, `label`, `retention`, `restore`, `restore-file`, `browse`, `browse-umount`, `update-sizes`, `scheduled-run`, `pre-update-all`, `schedule set/list`, `events`
- Smart Retention (5 окон): last N, hourly, daily, weekly, monthly

**Systemd таймер:** `rusnas-snapd.timer` — каждые 5 минут

**Apt hook:** `/etc/apt/apt.conf.d/99rusnas-snapshot` — автоснапшот перед `apt upgrade`

**Cockpit UI** (`snapshots.html` + `js/snapshots.js`):
- Три вкладки: Снапшоты / Расписание / Журнал событий
- Browse снапшота: монтирует read-only bind mount + временная SMB-шара, показывает Windows/macOS путь

### Ключевые решения
- `schedule list` и `events` не принимают `--json` (всегда JSON stdout) — флаг убран
- `err: "message"` в cockpit.spawn (не `err: "out"`) — stderr отдельно от JSON
- bash НЕ в sudoers NOPASSWD — discovery через `btrfs subvolume list` напрямую, не через bash

---

## Сессия 10 — Snapshot SMB Browse + Guard memory leak fix
**Дата:** 14 марта 2026 | Коммит: `e63bfaf`

### Snapshots — кнопка «Просмотр»
- `rusnas-snap browse`: монтирует снапшот как read-only bind mount, добавляет временную SMB-шару `[snap-XXXXXXXX]`, планирует auto-umount через 30 мин (`systemd-run`)
- `rusnas-snap browse-umount`: удаляет шару, размонтирует
- Модал: Windows-путь (`\\rusNAS\snap-XXXXXXXX`) и macOS-путь (`smb://IP/snap-XXXXXXXX`) с кнопками «Копировать»

### Guard — фикс утечки памяти cockpit-bridge
- `_statusPending` lock: новый запрос не отправляется пока предыдущий в полёте (было 2 параллельных канала каждые 5с)
- `get_events` теперь последовательный — только после ответа status
- Интервал 5с → 10с
- Таймер паузируется при скрытой вкладке (`visibilitychange`)

---

## Сессия 11 — RAID Full Lifecycle UI
**Дата:** 14 марта 2026 | Коммит: после merge feature/snapshots

### Реализовано в `disks.html` + `js/disks.js`

| Feature | Детали |
|---------|--------|
| **+ Создать массив** | 2-step wizard: RAID level (0/1/5/6/10 с min-disk валидацией), чекбоксы дисков, mount point + FS label → progress log → `mdadm --create` + `mkfs.btrfs` + `mount` + `/etc/fstab` |
| **Удалить массив** | Confirm modal со списком дисков → `umount` + fstab cleanup (по UUID) + `mdadm --stop` + `mdadm --zero-superblock` |
| **Смонтировать** | `blkid` FS detection (кнопка неактивна без FS) → `mkdir -p` + `mount` + fstab |
| **Размонтировать** | Confirm dialog → `umount` |
| **Субтома Btrfs** | Кнопка только когда btrfs смонтирован; modal: список + create + delete |

**Mount status на карточке массива:** `📂 /mnt/data (btrfs)` или `— не смонтирован`

### Верификация на VM
1. ✅ Удалён md127 через UI
2. ✅ Создан RAID 5 (md0, 3 диска, 21.5 GB) → Btrfs → `/mnt/data`
3. ✅ Созданы субтомы `homes`, `documents`
4. ✅ Unmount → remount цикл

---

## Сессия 12 — Btrfs субтомы в Storage (Хранилище) + bugfixes
**Дата:** 14 марта 2026

### A. Интеграция субтомов в создание SMB/NFS шар (`js/app.js`, `index.html`)

**Проблема:** dropdown в «Создать шару» показывал только mount points (`/mnt/data`), субтомы не видны.

**Решение:**
- `loadVolumeSelects()` переписан: `findmnt -rno` → для каждого btrfs-тома параллельно `btrfs subvolume list -o` через native Promise wrappers (не bash)
- Btrfs тома с субтомами отображаются как `<optgroup>` с опциями «Весь том» + `📁 homes`, `📁 documents`
- `change`-обработчик на `#share-volume`: при выборе субтома авто-заполняет имя шары и показывает hint `"Путь шары: /mnt/data/homes (Btrfs субтом)"`
- `addShare()`: при выборе субтома путь = субтом напрямую (не `volume + "/" + name`)

**Ключевой баг:** `cockpit.spawn().then().catch()` не возвращает нативный Promise → `Promise.all()` не работал. Исправлено: `spawnBtrfsSubvols()` оборачивает в `new Promise()` с `.stream()`.

### B. Исправления `js/snapshots.js`

- `findBtrfsSubvols()`: заменён `sudo -n bash -c "..."` (bash не в NOPASSWD sudoers) на `cockpit.spawn(findmnt)` + `cockpit.spawn(btrfs subvolume list, {superuser: "require"})`
- `loadSubvols()`: теперь запускает schedule list + live discovery параллельно через `Promise.all`, merge с дедупликацией — свежие субтомы без расписаний сразу видны
- `fmtSubvol()`: убрана зависимость от `/shares/` → все субтомы показываются как `📁 homes (/mnt/data/homes)`

### C. Исправления `js/disks.js` (bugs.MD)

**Баг: субтомы показывали снапшоты**
`btrfs subvolume list /mnt/data` без фильтрации показывал `.snapshots/...`. Исправлено: фильтрация путей с `.snapshots` в JS.

**Баг: кнопка «Удалить субтом» не работала**
Строковая интерполяция пути с `/`, `@`, `.` в `data-subvol` атрибуте и `bash -c "sudo btrfs..."` вызывала проблемы. Исправлено:
- `data-idx` вместо `data-subvol` (индекс в массиве, без спецсимволов)
- `cockpit.spawn(["btrfs", "subvolume", "delete", fullPath], {superuser: "require"})` без bash

### D. Исправление размеров снапшотов (`rusnas-snap`)

**Проблема:** `cmd_create` не вычислял размер → `size_bytes = 0` в БД до ручного `update-sizes`.

**Исправление:** `cmd_create` теперь вызывает `get_snap_size(snap_path)` сразу после создания и сохраняет в INSERT. Размер через `du -sb` (fallback когда qgroups не включены).

Старые снапшоты обновлены: `rusnas-snap update-sizes` → все получили корректные размеры.

---

## Сессия 13 — Фикс загрузки больших файлов по SMB (macOS)
**Дата:** 14 марта 2026

### Проблема
Загрузка больших файлов с macOS на SMB-шару `documents` завершалась «неожиданной ошибкой».

### Диагностика
Лог Samba (`/var/log/samba/log.dvls`):
```
sys_path_to_bdev() failed for path [.]!   (повторяется при каждой операции записи)
```
Samba при каждой записи пытается получить дисковую квоту через Linux quota API. Btrfs не поддерживает традиционные Linux-квоты → `sys_path_to_bdev(".")` падает → macOS Finder получает некорректный ответ о свободном месте → «неожиданная ошибка» на больших файлах. Запись 500MB напрямую на сервере работала нормально.

### Исправление (`/etc/samba/smb.conf [global]`)
```ini
vfs objects = catia fruit streams_xattr
fruit:metadata = stream
fruit:model = MacSamba
fruit:posix_rename = yes
fruit:veto_appledouble = no
fruit:wipe_intentionally_left_blank_rfork = yes
fruit:delete_empty_adfiles = yes
use sendfile = yes
aio read size = 1
aio write size = 1
socket options = TCP_NODELAY IPTOS_LOWDELAY
```
Модуль `fruit` включает специальную обработку macOS-клиентов с корректным репортингом свободного пространства без quota API. `socket options` убирает задержки Nagle-алгоритма.

---

## Сводная таблица принятых решений

| Решение | Выбор | Причина |
|---------|-------|---------|
| ФС | Btrfs + mdadm | ZFS не поддерживает online RAID level migration |
| Веб-UI | Cockpit + кастомный плагин | Скорость разработки |
| smb.conf редактирование | sed range pattern | Python regex ненадёжен для INI-блоков |
| iSCSI в Cockpit | явный sudo в spawn() | superuser:require не покрывает subprocess |
| Пути шар | findmnt --real dropdown | Не хардкодить, брать реальные точки монтирования |
| NFS идемпотентность | sed delete перед append | Иначе дублируются записи |
| mdstat парсинг | resync + reshape оба | Только resync → reshape показывало "Active" |
| Арбитр HA | Raspberry Pi (SBD + QNetd) | $50, решает split-brain и зависания ядра |
| Guard сокет права | 0o666, dir 0755, без superuser:require | Polkit не propagates в iframe-контексте |
| Guard daemon жизненный цикл | Сервис всегда запущен; Start/Stop = Detector thread | UI всегда может подключиться к сокету |
| Guard IOPS | `_root_path()` нормализация | InotifyTrees даёт поддиректорию, не root-путь |
| Guard /etc/rusnas-guard | chmod 755 | Cockpit bridge читает как не-root |
| CLI вывод rusnas-snap | JSON stdout, лог stderr | err:"message" разделяет их |
| schedule list | Без --json флага | Команда всегда выводит JSON |
| Subvol discovery | Promise.all(schedule+live) | bash не в sudoers; merge с дедупликацией |
| Btrfs на VM | RAID 5 md0 → /mnt/data | Реальный mdadm-массив (не loop image) |
| cockpit.spawn Promise | new Promise() wrapper | .then().catch() cockpit не совместим с Promise.all |
| Snap размеры | get_snap_size() в cmd_create | du -sb fallback когда qgroups отключены |
| SMB macOS large files | vfs objects = catia fruit streams_xattr | fruit корректно репортит свободное место без quota API |

---

## Сессия 14 — UX редизайн модуля снапшотов: сайдбар + глобальная статистика

**Дата:** 2026-03-14

### Задача
Три проблемы с модулем снапшотов:
1. Пользователь не видит, сколько ВСЕГО занимают снапшоты по всем папкам
2. Выбор папки через dropdown неудобен при большом количестве папок (10+)
3. Нет наглядного отображения состояния каждой папки (сколько снапшотов, сколько места)

### Исследование
Изучены UX-паттерны конкурентов: Synology (dropdown на 1 папку), TrueNAS SCALE (1 задача = 1 датасет), QNAP (левая панель + статистика по пулу). Вывод: left-panel + на каждом элементе счётчик снапшотов/размер — наиболее usable при 10+ папках.

### Реализация

**CLI (`rusnas-snap/rusnas-snap`):**
- Добавлена команда `storage-info` → JSON: `{total_count, total_size_bytes, total_size_human, subvols: [{subvol_path, count, size_bytes, size_human}]}`
- Запрос к SQLite: `GROUP BY subvol_path` + общие итоги
- Зарегистрирован в `build_parser()` + `main()`

**HTML (`snapshots.html`) — полный редизайн:**
- Убран dropdown `#snap-object-select` и верхняя `.section` с кнопками
- Добавлена `.snap-summary-strip` — строка с глобальными итогами (все субволюмы)
- Новый двухколоночный layout: `.snap-layout` → `.snap-sidebar` + `.snap-main`
- Сайдбар: список всех папок с иконкой 📁, именем, мета-строкой (N снапш. · X МБ), кнопка `+ Создать снапшот` внизу
- Заголовок активной папки с полным путём перенесён в `.snap-main`
- Tabs и контент остались без изменений

**CSS (`style.css`):**
- `.snap-summary-strip` — горизонтальная полоска с глобальными числами
- `.snap-sidebar`, `.snap-sidebar-item` — левая панель с выделением активного элемента (синяя левая граница + `--info-light` фон)
- `.snap-main` — правая область, `flex:1; min-width:0`
- `.snap-folder-header` — заголовок текущей папки + кнопка ↻

**JS (`snapshots.js`):**
- `populateSelects()` — убран `snap-object-select`, теперь только modal-selects
- `loadStorageInfo()` — вызывает `storage-info`, обновляет summary strip + рендерит сайдбар со статистикой
- `renderSidebar(statsMap)` — рендерит элементы сайдбара, клик = `currentSubvol` + `loadSnapshots()`
- `updateCurrentTitle()` — обновляет заголовок и путь в `.snap-folder-header`
- `loadSubvols()` → после загрузки вызывает `loadStorageInfo()` + `updateCurrentTitle()`
- `loadSnapshots()` → после загрузки снапшотов перезагружает `loadStorageInfo()` (обновляет счётчики)

### Результат
- Глобальный итог: "28 снапшотов · 1.1 ГБ занято · 5 папок" всегда виден вверху
- Левая панель показывает все 5 папок с их статистикой без скролла
- Клик по папке — мгновенное переключение без перезагрузки страницы
- `storage-info` CLI работает корректно (проверено на VM)

### Таблица решений
| Решение | Причина |
|---------|---------|
| left-panel sidebar вместо dropdown | Лучший UX при 10+ папках (QNAP-паттерн) |
| `storage-info` CLI → GROUP BY subvol_path | Агрегация прямо в SQLite, без лишних spawn |
| `loadStorageInfo()` вызывается после каждого `loadSnapshots()` | Актуальные счётчики в сайдбаре |
| `sticky; top:16px` для сайдбара | Остаётся виден при скролле длинного списка снапшотов |

---

## Сессия 15 — Tree view в сайдбаре: вложенные подпапки + офлайн-тома

**Дата:** 2026-03-14

### Задача
Поддержка подпапок в сайдбаре снапшотов: нужно красиво отображать вложенность субволюмов при большом количестве папок.

### Реализация

**`findBtrfsSubvols()`** переписана:
- Теперь возвращает `[{mountPoint, subvols, offline}]` вместо плоского массива
- Фильтрует `/mnt/rusnas-browse/` из `findmnt` (это временные mount'ы для browse-снапшотов)

**`loadSubvols()`** — новая логика orphan:
- Schedule-only пути (том не смонтирован) группируются по инферированному mount point через `inferMountPoint(path)` → `/mnt/foo/bar/baz` → `/mnt/foo`
- Создаётся группа с `offline: true` вместо единой группы `__orphan__`
- State `subvolGroups: [{mountPoint, subvols, offline}]` хранится отдельно от плоского `subvolList`

**`buildPathTree(mountPoint, paths)`** — новая функция:
- Строит JS-дерево из списка путей: полный путь → относительный → сегменты → дерево
- Узлы с `fullPath: null` = виртуальные директории (не субволюмы, просто группировка)
- Узлы с `fullPath: str` = реальные субволюмы (кликабельны)

**`renderSidebar(statsMap)` + `renderTreeNodeHtml(node, statsMap, depth)`**:
- Каждая группа отображается с заголовком: `🖴 data` (online) или `📎 btrfspool (офлайн)` (offline)
- Дерево рендерится рекурсивно с `padding-left: 10 + depth*14 px`
- Реальные субволюмы (📁): кликабельны, показывают счётчик снапшотов/размер
- Виртуальные директории (📂): grey, некликабельны, имя с `/` суффиксом
- Expand/collapse: `▼`/`▶` кнопка; клик скрывает/показывает `.snap-tree-children` div

**CSS** — новые классы:
- `.snap-tree-group` — заголовок mount-point группы
- `.snap-tree-node`, `.snap-tree-real`, `.snap-tree-virtual` — узлы дерева
- `.snap-tree-toggle`, `.snap-tree-spacer` — toggle/отступ перед иконкой
- `.snap-tree-virtual .snap-tree-name` — grey, font-weight 400

### Поведение с разными конфигурациями
| Ситуация | Отображение |
|----------|-------------|
| Один Btrfs том, плоские субволюмы | Заголовок `🖴 data`, список без дерева |
| Один том, вложенные субволюмы (`shares/docs/archive`) | Заголовок + дерево с `shares/` виртуальной папкой |
| Несколько томов | Два отдельных заголовка с деревьями |
| Том в расписании, но не смонтирован | `📎 btrfspool (офлайн)` + его субволюмы |
| Смешанный случай (VM: data + btrfspool офлайн) | Оба показываются правильно |

---

## Сессия 16 — Репликация btrfs send/receive + MCP/AI TZ

**Дата:** 2026-03-15

### Что сделано

#### Документация: MCP Server + AI Agent
- Создан файл `rusnas_mcp_ai.MD` — краткое ТЗ на будущую интеграцию:
  - MCP-сервер на Python (инструменты: get_status, list_shares, snapshots, disks, users и др.)
  - Встроенный AI-чат в Cockpit (Ollama / Claude API)
  - HTTP-транспорт для внешних MCP-клиентов (Claude Desktop, Cursor)
  - Безопасность: Bearer token, подтверждение опасных операций, логи в `ai-actions.jsonl`
- Ссылка добавлена в шапку `CLAUDE.md` и в раздел Roadmap

#### Репликация btrfs send/receive

**CLI (`rusnas-snap replication`):**
- Новая таблица `replication_tasks` в SQLite:
  `id, subvol_path, remote_user, remote_host, remote_path, cron_expr, enabled, last_sent_snap, last_run_at, last_status, last_error, created_at, updated_at`
- `replication set <subvol> --host HOST --user USER --path PATH [--cron CRON]` — upsert задачи
- `replication list` — список задач (JSON)
- `replication delete <subvol>` — удалить задачу
- `replication run <subvol>` — выполнить репликацию (для UI), один JSON-ответ
- `replication run-all` — все enabled задачи по cron (для systemd timer)
- `replication check-ssh <subvol>` — проверить SSH-соединение (`{"ssh_ok": true/false}`)

**Логика btrfs send/receive:**
- `_do_btrfs_send_receive(task)` — ядро: `btrfs send [[-p parent]] snap | ssh user@host btrfs receive /path`
- Инкрементально если `last_sent_snap` известен и parent-снапшот существует на диске
- Полная копия при первой репликации или если parent потерян
- Таймаут 2 часа; `StrictHostKeyChecking=accept-new`
- Статусы: `running → ok / error`; ошибки логируются в events + `last_error`

**UI (вкладка «Репликация»):**
- Новая вкладка «Репликация» в tabs (между «Расписание» и «Журнал событий»)
- Список задач: назначение (`user@host:/path`), расписание cron, статус-badge, дата последнего запуска, текст ошибки
- Кнопки: `▶ Запустить`, `Изменить`, `Включить/Отключить`, `Удалить`
- Пустое состояние: описание технологии + кнопка «+ Добавить репликацию»
- Модал добавления/редактирования:
  - Предупреждение о SSH-ключе с готовыми командами настройки
  - Поля: субволюм, remote host, remote user (default: rusnas), remote path, cron с пресетами
  - Кнопка «Проверить SSH» (проверяет уже сохранённую задачу через `check-ssh`)
- `populateSelects()` теперь включает `modal-repl-subvol`

**Автозапуск через таймер:**
```bash
# Добавить в rusnas-snapd.service ExecStart или создать отдельный timer:
/usr/local/bin/rusnas-snap replication run-all
```

### Инструкция по настройке репликации

1. **На источнике (rusNAS)** — настроить SSH-ключ:
   ```bash
   sudo ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_rusnas_repl
   sudo ssh-copy-id -i /root/.ssh/id_rusnas_repl.pub rusnas@backup-host
   # Проверить:
   sudo ssh -o BatchMode=yes rusnas@backup-host echo OK
   ```

2. **На приёмнике (backup-host)** — подготовить Btrfs-путь:
   ```bash
   # Путь должен быть на Btrfs-разделе:
   mkdir -p /backup/nas1
   # btrfs receive требует прав root или member btrfs group
   ```

3. **В Cockpit** — вкладка «Снапшоты» → «Репликация» → «+ Добавить репликацию»

4. **Первый запуск** — полная передача (может занять время):
   ```bash
   sudo rusnas-snap replication run /mnt/data/homes
   ```

5. **Последующие запуски** — только diff от предыдущего снапшота (инкрементально).

### Файлы изменены
- `rusnas-snap/rusnas-snap` — +~200 строк: replication_tasks table, 7 новых команд
- `cockpit/rusnas/snapshots.html` — вкладка Репликация + модал
- `cockpit/rusnas/js/snapshots.js` — replicationsData state + 8 новых функций
- `cockpit/rusnas/css/style.css` — `.snap-sidebar-meta`
- `rusnas_mcp_ai.MD` — новый файл ТЗ
- `CLAUDE.md` — ссылка на MCP TZ, roadmap обновлён

---

## Сессия 17 — 2026-03-15

### Задачи
1. Исправить 3 бага из bugs.MD + провести комплексное тестирование всех страниц
2. Написать отчёт по результатам тестирования в bugs.MD

### Выполнено

**BUG-01 (Снапшоты — schedule tab)** — исправлен в предыдущей сессии, верифицирован ✅
- Клик на «documents» в sidebar при открытой вкладке «Расписание» мгновенно показывает «Расписания не настроены» (у documents нет расписания)

**BUG-02 (SMB Изменить)** — исправлен в предыдущей сессии, верифицирован ✅
- Кнопка «Изменить» открывает модал с правильными данными

**BUG-03 (Guard --reset-pin)** — дополнительно исправлен
- Root cause: на VM был задеплоен старый `guard.py` без обработчика `--reset-pin` (272 строки vs 292 локально)
- Деплой через `scp` в `install-guard.sh` не работал из-за неизвестной причины — скопирован вручную
- После деплоя: `sudo rusnas-guard --reset-pin` → «Guard PIN сброшен.» ✅

**BUG-04 (NFS "Ошибка:")** — НОВЫЙ БАГ, исправлен
- `grep` возвращает exit code 1 на пустом файле → `cockpit.spawn().fail()` срабатывал
- Исправление: `|| true` + `{superuser: "require", err: "message"}`

**BUG-05 (SMB путь захардкожен)** — НОВЫЙ БАГ, исправлен
- `loadShares()` показывал `/mnt/data/shares/<name>` вместо реального пути из smb.conf
- Исправление: `loadShares()` теперь использует `python3` + `testparm -s` для парсинга реальных путей

**BUG-06 (Browse modal — click ghost)** — НОВЫЙ БАГ, задокументирован в bugs.MD
- «Закрыть доступ» в модале SMB browse случайно активирует кнопку «Метка» за оверлеем

### Новые UX проблемы задокументированы в bugs.MD
- G-01..G-07: Guard page (кнопки, post-attack flow, журнал событий)
- S-01..S-04: Snapshots page (счётчики, размеры, retention docs)
- H-01..H-03: Storage page (статус сервисов, кнопка удалить)

### Изменённые файлы
- `cockpit/rusnas/js/app.js` — BUG-04 (NFS || true), BUG-05 (loadShares python3 paths)
- `rusnas-guard/daemon/guard.py` — деплой на VM (guard.py с --reset-pin уже был правильным локально)
- `install-guard.sh` — ранее исправлен порядок chmod (предыдущая сессия)
- `bugs.MD` — полностью переписан: 5 исправленных багов + новые UX замечания + таблица покрытия

---

## Сессия 9 — Dashboard + Metrics Server (2026-03-15)

### Задачи
- Верификация ранее исправленных багов (BUG-01..BUG-05) — через Playwright browser automation
- Создание ветки `feature/dashboard`
- Реализация Dashboard по ТЗ `rusnas-dashboard-spec.md`
- Реализация Metrics Server (Prometheus + JSON API)

### Результат Dashboard

Полный дашборд задеплоен и работает на `https://10.10.10.72:9090/rusnas/dashboard`.

**Компоненты:**

| Файл | Описание |
|------|----------|
| `cockpit/rusnas/dashboard.html` | Разметка: Identity Bar, секции A/B/C/D/E, блок мониторинга |
| `cockpit/rusnas/css/dashboard.css` | Стили: карточки, прогресс-бары, sparklines, Guard status dots |
| `cockpit/rusnas/js/dashboard.js` | ~500 строк: delta CPU/Net/IO, SMART cache 5мин, parseMdstat, Guard state machine |
| `cockpit/rusnas/manifest.json` | Dashboard добавлен как order:1 в боковом меню |

**Работающие секции:**
- Identity Bar: hostname, IP, uptime, live clock ✅
- A1 Storage: 37%, прогресс-бар, RAID теги ✅
- A2 RAID: md0 raid5 active 4/4 дисков ✅
- A3 Disks: показывает "—" без admin access (ожидаемое поведение) ✅
- A4 Shares: SMB/NFS/FTP активны, iSCSI остановлен ✅
- B CPU/RAM/Net: sparklines SVG, live метрики ✅
- C Disk I/O: dual sparklines (read/write), per-disk статистика ✅
- D Events: journalctl -n 12 ✅
- D Snapshots: 4 субтома, 37 снапшотов, 1.1 ГБ ✅
- E Guard: "Guard отключён" + ссылка на настройки ✅
- Metrics endpoint: URL скопируется, "Сервис метрик: активен ✅" ✅

### Metrics Server

Задеплоен и запущен: `systemctl enable --now rusnas-metrics`

| Файл | Описание |
|------|----------|
| `rusnas-metrics/metrics_server.py` | Python 3, порт 9100, `/metrics` + `/metrics.json` |
| `rusnas-metrics/rusnas-metrics.service` | systemd unit |
| `rusnas-metrics-install.sh` | Скрипт установки |

Эндпоинты:
- `http://10.10.10.72:9100/metrics` — Prometheus text format
- `http://10.10.10.72:9100/metrics.json` — JSON API (для Zabbix)

Метрики: CPU %, load avg, temp; RAM/Swap; сеть RX/TX по интерфейсу; диски R/W + SMART; RAID статус; тома; сервисы; Guard state.

### Архитектурные решения
- Delta-расчёт скоростей (CPU/Net/IO) через глобальные prev_ переменные с timestamp
- SMART cache TTL 5мин (TICK_SMART=300000) — не нагружать диски
- Guard state читается из `/run/rusnas-guard/state.json` (RuntimeDirectory)
- Metrics server — warmup: 1 сек sleep после первых чтений для корректного delta

### Git
- Branch: `feature/dashboard`
- Commit: `334d87c feat: add rusNAS Dashboard — main overview page + metrics server`
