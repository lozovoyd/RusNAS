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

---

## Сессия 10 — Guard улучшения + Dashboard фиксы + FTP/WebDAV (2026-03-15)

### Задачи сессии
- Исправить два крэша демона Guard при включении защиты
- Исправить PIN-диалог после `--reset-pin`
- Добавить FTP и WebDAV разделы в страницу Хранилища
- Починить блок "Диски" в Dashboard (не отображал данные)
- Добавить выбор путей из доступных томов в Guard (modal с discovery)
- Разбить Guard страницу на вкладки
- Улучшить журнал событий Guard

### Guard daemon: два критических краша

**BUG: `AttributeError: 'Detector' object has no attribute 'get_iops'`**
- `guard.py:_update_state()` вызывал `self._detector.get_iops()` — метода не существует
- `Detector._record_iops()` уже пишет `current_iops` напрямую в shared state dict
- Исправление: убрали вызов, добавили комментарий

**BUG: `FileNotFoundError` в `InotifyTrees.__init__`**
- `inotify.adapters.InotifyTrees(paths)` бросает исключение если путь не существует
- Вся нить детектора падала молча; `/mnt/data/shares/public` не существует на тестовой VM
- Исправление: фильтрация `os.path.isdir(p)` перед передачей в InotifyTrees

### Dashboard: блок "Диски" не отображался
- `ls /dev/sd? /dev/nvme?n? 2>/dev/null` возвращал exit code 1 если нет nvme-устройств
- `cockpit.spawn().fail()` → ничего не рендерилось
- Исправление: `ls /dev/sd? /dev/nvme?n? /dev/vd? 2>/dev/null; true`

### FTP и WebDAV разделы (index.html + app.js)

Добавлены два новых раздела в страницу Хранилища:

**FTP (vsftpd):**
- Статус-бейдж + старт/стоп сервиса
- Настройки: анонимный доступ, запись, chroot, пассивные порты
- Сохранение через Python-скрипт (`re.sub`) в `/etc/vsftpd.conf` + restart

**WebDAV (Apache):**
- Статус-бейдж + старт/стоп сервиса
- Редактирование URL-алиаса и пути директории
- Управление пользователями: список, добавить (htdigest / Python fallback), удалить (sed)
- Конфиг записывается в `/etc/apache2/sites-enabled/webdav.conf`

**Dashboard:** добавлен `apache2` (WebDAV) в список сервисов секции A4.

### Guard: улучшение модала добавления пути

Заменён простой текстовый input на discovery UI:
- При открытии модала запускается `findmnt --real` и `grep smb.conf`
- Показывает список доступных Btrfs/data томов и SMB-шар
- Кликнуть на строку → заполняет поле ввода (с hover highlight)
- Уже добавленные пути помечаются "уже добавлен" и блокируются

### Guard: вкладки

Страница разбита на 3 вкладки:
- **Обзор** — статистика (IOPS, события, baseline, пути, blocked IPs)
- **Журнал событий** — таблица с бейджем непросмотренных событий на вкладке
- **Настройки** — методы обнаружения, мониторируемые пути, снапшоты

Стили `.tabs / .tab-btn / .tab-panel` добавлены в `style.css`.

### Guard: журнал событий — полная переработка

**Backend (response.py, socket_server.py):**
- `load_events()` — добавлены параметры: `offset`, `method`, `status`, `date_from`, `date_to`; возвращает `{events, total}` вместо `list`
- Новая команда `clear_events` (auth required) — очищает `events.jsonl`

**Frontend (guard.html, guard.js):**
- Панель фильтров: тип события, статус, диапазон дат — применить/сбросить
- Пагинация: 25 событий на страницу, ◀/▶, счётчик "X–Y из N"
- Кнопка "⬇ CSV" — экспорт всех отфильтрованных событий с BOM для Excel
- Кнопка "🗑 Очистить журнал" (PIN required)
- Новые строки: непросмотренные события подсвечиваются красным фоном
- Детали: полный список файлов, энтропия, IOPS в одной ячейке

### Изменённые файлы

| Файл | Изменение |
|------|-----------|
| `rusnas-guard/daemon/guard.py` | Убран вызов get_iops() |
| `rusnas-guard/daemon/detector.py` | Фильтрация несуществующих путей перед InotifyTrees |
| `rusnas-guard/daemon/response.py` | Фильтры в load_events(), clear_events() |
| `rusnas-guard/daemon/socket_server.py` | Обновлён dispatch get_events, добавлен clear_events |
| `cockpit/rusnas/guard.html` | Вкладки, новый журнал событий с фильтрами |
| `cockpit/rusnas/js/guard.js` | Вкладки, discovery пути, фильтры/пагинация/экспорт |
| `cockpit/rusnas/index.html` | Разделы FTP и WebDAV |
| `cockpit/rusnas/js/app.js` | loadFtp, saveFtp, loadWebdav, saveWebdav, addWebdavUser |
| `cockpit/rusnas/js/dashboard.js` | Добавлен apache2 в SERVICES, фикс disk health |
| `cockpit/rusnas/css/style.css` | Стили .tabs/.tab-btn/.tab-panel |

### Git commits
- `d21b2a6` fix: Guard daemon crash on enable — remove get_iops() + filter missing paths
- `b6e188d` feat: FTP/WebDAV settings sections + dashboard fixes + Guard path discovery
- `b885a41` refactor: move Guard event log to separate tab
- `3a026e3` feat: Guard event log — filters, pagination, CSV export, clear

---

## Сессия 2026-03-15 — Деdup Manager: реализация + тестирование + фиксы

### Цели сессии
1. Реализовать полный раздел «Дедупликация» по spec `rusnas-dedup-spec.md`
2. Починить WORM «Выбрать» кнопку и пути в storage
3. Провести промышленное тестирование раздела Dedup

### Реализованные компоненты

**`cockpit/rusnas/dedup.html`** — новая страница:
- 4 статус-карточки: последний прогон, сэкономлено, файлов, статус
- Панель действий: Запустить / Остановить / Лог
- Вкладка «Как работает»: SVG-инфографика 3 уровня дедупликации, SVG-таймлайн суток, история 7 дней (бар-чарт), FAQ-аккордеон
- Вкладка «Настройки»: расписание (время + дни), таблица томов, SMB vfs_btrfs per-шара, продвинутые параметры duperemove

**`cockpit/rusnas/js/dedup.js`** — JavaScript логика:
- `loadLastRun()`, `loadHistory()`, `loadConfig()`, `loadVolumes()`, `loadSambaShares()`
- `renderStatusCards()`, `renderTimeline()`, `renderHistoryChart()`
- `saveSchedule()`, `saveVolumeConfig()`, `saveSambaConfig()`, `saveAdvancedConfig()`
- `runDedup()`, `stopDedup()`, `checkRunning()`, `startPolling()`
- `showLog()`, `showMsg()`

**`rusnas-dedup/rusnas-dedup-run.sh`** — backend wrapper:
- Читает `/etc/rusnas/dedup-config.json`
- Запускает duperemove с параметрами из конфига
- Считает метрику через `btrfs filesystem du -s` (shared extents)
- Пишет `dedup-last.json` и `dedup-history.json` с chmod 644

**`rusnas-dedup/rusnas-dedup.service`** — systemd oneshot, Nice=19, IOSchedulingClass=idle

**`install-dedup.sh`** — deploy script: копирует скрипт, сервис, настраивает sudoers, создаёт дефолтный конфиг

### Баги найдены и исправлены при тестировании

| Баг | Причина | Фикс |
|-----|---------|------|
| SMB шары "не найдены" | `configparser` падает на inline-комментариях smb.conf | Парсер на Python regex через tmpfile |
| duperemove exit code 22 | `--min-size` и `--hash` не поддерживаются v0.11.2 | Удалены из формы и saveAdvancedConfig() |
| Статус застывает в "Выполняется" | `setRunningState(false)` не очищал текст | Сразу ставим "—", loadLastRun() дополняет |
| Устаревший JSON после прогона | Race: polling читал файл до записи скриптом | 800ms задержка перед loadLastRun() |
| Controls расписания активны при disabled | Нет disabled-стейта на time/days | change listener + populateSettings() |
| WORM «Выбрать» не работает | Не был зарегистрирован event listener | Добавлен addEventListener + load SMB paths |

### Итог тестирования
Все элементы управления протестированы:
- Статус-карточки, таймлайн, история, FAQ ✅
- Запустить/Остановить + полинг + индикатор ✅
- Лог (полный вывод duperemove) ✅
- Расписание (cron создаётся/удаляется) ✅
- Тома (конфиг записывается) ✅
- SMB vfs_btrfs (добавляется/удаляется в smb.conf) ✅
- Параметры duperemove (hashfile + extra args) ✅

### Изменённые файлы

| Файл | Изменение |
|------|-----------|
| `cockpit/rusnas/dedup.html` | Новый файл (страница дедупликации) |
| `cockpit/rusnas/js/dedup.js` | Новый файл (логика UI) |
| `cockpit/rusnas/manifest.json` | Добавлен пункт меню dedup (order 7) |
| `cockpit/rusnas/js/app.js` | WORM browse button fix + SMB paths in suggestions |
| `rusnas-dedup/rusnas-dedup-run.sh` | Новый файл (backend wrapper) |
| `rusnas-dedup/rusnas-dedup.service` | Новый файл (systemd unit) |
| `install-dedup.sh` | Новый файл (deploy script) |
| `rusnas-dedup-spec.md` | Обновлён: статус реализован + implementation notes |
| `CLAUDE.md` | Добавлен раздел Dedup, ссылка на spec, известные баги |

### Git commits
- `git log --oneline feature/dedup` → реализация + фиксы тестирования
- Ветка `feature/dedup` слита в `main` 2026-03-15

---

## Сессия 8 — Системное тестирование всех разделов UI
**Дата:** 2026-03-16

### Что было сделано

Масштабное системное тестирование на предмет связанности компонентов:
- Протестированы все 7 разделов rusNAS UI: Dashboard, Storage, Disks&RAID, Users, Guard, Snapshots, Dedup
- Все найденные баги записаны в `bugs.MD`
- 5 критических багов исправлены по ходу тестирования

### Найденные и исправленные баги

| ID | Раздел | Описание | Статус |
|----|--------|----------|--------|
| BUG-13 | Dashboard | `getElementById("card-snaps")` возвращал null — TypeError при каждой загрузке | ✅ Исправлено |
| BUG-snap-modal | Снапшоты | Schedule modal не pre-fill currentSubvol при добавлении расписания | ✅ Исправлено |
| BUG-events | Снапшоты | Events tab показывал все события, не фильтруя по currentSubvol | ✅ Исправлено |
| BUG-browse | Снапшоты | Клик "Закрыть доступ" проваливался через modal overlay на кнопку "Метка" за ним | ✅ Исправлено |
| BUG-webdav | Хранилище | WebDAV "Путь к директории" показывал `/mnt/data/shares/webdav>` — trailing `>` | ✅ Исправлено |

### Root causes

- **dashboard.js null ref**: предыдущая сессия добавила `addEventListener` для `card-snaps`, но элемента с таким ID нет в HTML. Карточки уже имели `onclick="cockpit.jump()"` — дублированный код удалён
- **WebDAV regex**: `/<Directory\s+(\S+)/m` захватывал `>` из закрывающего тега Apache `<Directory /path>`. Исправлено: `/<Directory\s+([^>]+?)>/m`
- **Snapshots schedule + events**: добавлены `currentSubvol` pre-fill и `--subvol` filter
- **Browse modal click-through**: добавлен `e.stopPropagation()` + переименование кнопки

### Состояние всех разделов после тестирования

| Раздел | Статус | Замечания |
|--------|--------|-----------|
| Dashboard 🏠 | ✅ OK | Все карточки, метрики, Guard-виджет, снапшоты-виджет, мониторинг |
| Хранилище | ✅ OK | SMB, NFS, iSCSI, FTP, WebDAV, WORM — всё корректно |
| Диски и RAID | ✅ OK | md0 RAID5 active, 4 диска, бирки, кнопки действий |
| Пользователи | ✅ OK | 2 пользователя, 4 группы, Samba-статус |
| Guard 🛡️ | ✅ OK | Мониторинг активен, 3 вкладки, 4 метода обнаружения, настройки |
| Снапшоты 📸 | ✅ OK | Sidebar, переключение папок, schedule, events filter |
| Дедупликация | ✅ OK | Last run 1.2 ГБ, 21 файл, расписание, тома, SMB vfs_btrfs |

### Git commits
- `b7fe14f` — fix: system-wide integration testing — 5 bugs fixed

---

## Сессия 9 — 2026-03-16

### Задачи
1. Написать ТЗ `rusnas-ups-nut_spec.md` по образцу существующих TZ-файлов
2. Реализовать страницу ИБП / UPS (NUT: Network UPS Tools)
3. Исправить Dark Mode в Dashboard (неправильные CSS-переменные)
4. Добавить UPS-виджет на Dashboard
5. Обновить документацию

### Реализовано: ИБП / UPS (ветка main)

**Новые файлы:**
- `cockpit/rusnas/ups.html` — страница ИБП, 4 вкладки (Статус, Конфигурация, Защита, Журнал)
- `cockpit/rusnas/js/ups.js` — UI-логика: upsc -j, fallback text mode, scan USB, сохранение конфигов
- `rusnas-ups/rusnas-ups-notify.sh` — NOTIFYCMD hook (Telegram + email + syslog)
- `install-ups.sh` — деплой NUT + sudoers + notify script на VM
- `rusnas-ups-nut_spec.md` — полное ТЗ с паритетом Synology DSM

**Изменённые файлы:**
- `cockpit/rusnas/manifest.json` — добавлен пункт меню "ИБП 🔋" (order 8)
- `CLAUDE.md` — ссылка на rusnas-ups-nut_spec.md

**Ключевые технические решения:**
- NUT установлен через `apt install nut` (Debian 13: nut 2.8.1)
- `upsc -j` (JSON mode, NUT 2.8+) — основной метод опроса; fallback: text mode
- Конфиги `/etc/nut/` записываются через `cockpit.file().replace()` — НЕ через sudo tee
- `superuser:"require"` НЕ используется в spawn (polkit timeout в iframe) — sudoers покрывает
- Пароль upsd: `rusnas_nut_2026` (harcoded в шаблоне, можно сменить через UI)
- Судоерс: `/etc/sudoers.d/rusnas-nut` — upsc, nut-scanner, systemctl nut.target, journalctl

### Исправлен Dark Mode в Dashboard

**Причина:** `dashboard.css` использовал несуществующие CSS-переменные с fallback к светлым значениям:
- `var(--color-bg-secondary, #f0f0f0)` → должно быть `var(--bg-th)`
- `var(--color-card-bg, #fff)` → должно быть `var(--bg-card)`
- `var(--color-text-muted, #888)` → должно быть `var(--color-muted)`

В `dashboard.js` аналогичные inline-style строки тоже использовали неправильные переменные.

**Файлы исправлены:**
- `cockpit/rusnas/css/dashboard.css` — полная замена на правильные переменные из style.css
- `cockpit/rusnas/js/dashboard.js` — замена `--color-text-muted` → `--color-muted`, `--color-bg-secondary` → `--bg-th`
- `cockpit/rusnas/dashboard.html` — замена `var(--color-bg-secondary,#f5f5f5)` → `var(--bg-th)`

### UPS виджет на Dashboard

Добавлена карточка "🔋 ИБП" в grid (вместо grid-3 теперь grid-4 в нижней секции):
- Статус-точка (цветная, как у Guard)
- Текущий статус (OL/OB/LB/RB → цветной текст)
- 4 метрики: заряд (с прогресс-баром), запас хода, нагрузка, модель
- Кнопка "Управление ИБП →"
- Обновление каждые 10 секунд

### Деплой
- NUT установлен на VM: `nut 2.8.1-5`
- Sudoers `/etc/sudoers.d/rusnas-nut` настроены
- Notify script установлен: `/usr/local/bin/rusnas-ups-notify`
- Plugin задеплоен: `./deploy.sh`


---

## Сессия 12 — 2026-03-17: Storage Analyzer + Landing Page + Cockpit Branding

### Обзор
Три крупных задачи за одну сессию:
1. Лендинг-страница — деплой и дополнение новыми фичами
2. Редизайн окна логина Cockpit в стиле rusNAS
3. Новая функция: Storage Analyzer (Анализатор пространства)

### Лендинг-страница

Файл `/Users/dvl92/Downloads/rusnas.html` помещён в `landing/index.html`.

**Добавлены секции:**
- Дедупликация (3 метода: duperemove, Btrfs reflinks, SMB vfs_btrfs)
- Управление ИБП (виджет с зарядом 87%, 3 статуса, 140+ моделей)
- Мониторинг (Prometheus + Grafana)
- +4 строки в таблице сравнения с Synology

**Инфраструктура:**
- `landing/apache/rusnas-landing.conf` — Apache VirtualHost на порту 80
- `deploy-landing.sh` — деплой на VM (замена дефолтной страницы Apache)
- `http://10.10.10.72/` отдаёт лендинг (HTTP 200, 167539 байт)

### Cockpit Login Branding

`cockpit-branding/branding.css` — полный редизайн окна логина:
- Тёмный фон (#0d0d0d), оранжево-красные акценты
- SVG логотип rusNAS (rack-сервер с дисками) в блоке #badge
- Шрифт Manrope через Google Fonts
- CSS переменные совместимы с Cockpit login.css
- Интегрирован в `deploy.sh` для автоматического деплоя

### Storage Analyzer (Анализатор пространства)

**Ветка:** `feature/storage-analyzer`

**Файлы созданы:**
- `rusnas-storage-analyzer/storage-collector.py` — фоновый коллектор (systemd таймер)
- `rusnas-storage-analyzer/storage-analyzer-api.py` — 7 API команд (overview, shares, files, users, filetypes, scan-status, scan-now)
- `rusnas-storage-analyzer/rusnas-storage-collector.service` — systemd oneshot, nice+ionice
- `rusnas-storage-analyzer/rusnas-storage-collector.timer` — hourly, RandomizedDelaySec=300
- `cockpit/rusnas/storage-analyzer.html` — 5 вкладок, модал настроек, заголовок с кнопкой сканирования
- `cockpit/rusnas/js/storage-analyzer.js` — ~750 строк: squarified treemap, donut chart, SVG fill chart, sparklines
- `cockpit/rusnas/css/storage-analyzer.css` — расширен, ~600 строк
- `install-storage-analyzer.sh` — скрипт деплоя бэкенда

**Дашборд:** клик на Storage карточку теперь → `storage-analyzer.html` (было: disks.html)

**Деплой:** бэкенд установлен на VM, первое сканирование прошло успешно (1 том `/mnt/data`, 1 шара)

**Что работает на VM:**
- `storage-collector.py` — сбор данных в SQLite + JSON cache
- `storage-analyzer-api.py overview/shares/files/users/filetypes/scan-status` — все команды отвечают JSON
- `rusnas-storage-collector.timer` — включён, hourly

**Алгоритмы в JS:**
- Squarified Treemap: `squarify()` + `squarifyRow()` + `worstRatio()` — рекурсивный алгоритм (~80 строк)
- Donut chart: SVG arc paths с gap между сегментами
- Fill chart: SVG линейный с осями, прогнозной пунктирной линией, маркером "сейчас"
- Sparkline: SVG polyline для inline-графиков в шарах


---

## Сессия 2026-03-17 — SSD-кеширование (dm-cache / LVM)

**Задача:** Реализовать SSD-кеширование HDD RAID-массивов через LVM dm-cache с управлением из Cockpit UI.

**ТЗ:** [rusnas-ssd-tier-task.md](./rusnas-ssd-tier-task.md)

### Что реализовано

**Backend:**
- `install-ssd-tier.sh` — деплой: apt install lvm2 + thin-provisioning-tools, sudoers `/etc/sudoers.d/rusnas-ssd-tier`, создание `/etc/rusnas/ssd-tiers.json`
- Конфигурация: `/etc/rusnas/ssd-tiers.json` — JSON-файл со списком активных SSD-тиров (644, readable by Cockpit)
- Судоерс NOPASSWD: pvcreate, pvremove, pvs, vgcreate, vgremove, vgs, lvcreate, lvremove, lvs, lvconvert, lvchange, lvdisplay, dmsetup (`/sbin/` и `/usr/sbin/`)

**Frontend:**
- Секция "⚡ SSD-кеширование" в `disks.html` — после таблицы физических дисков
- 3 новых модала: Add SSD tier, Change mode, Remove tier
- `disks.js` — ~350 строк новых функций:
  - `getSsdCandidates()` — список SSD через lsblk JSON, фильтрация по rota=0, исключение дисков из mdstat
  - `getSsdTierStatus(vgName, lvName)` — парсинг lvs cache-метрик (hit_rate, cache_pct, mode)
  - `renderSsdTiers(tiers)` — таблица с прогрессбарами, бейджами режима, кнопками действий
  - `loadSsdTiers()` — читает ssd-tiers.json + Promise.all статусов
  - `openAddSsdTierModal()` — проверка lvm2, заполнение selects, показ модала
  - `doCreateSsdTier()` — 8-шаговый wizard (pvcreate×2 → vgcreate → lvcreate×3 → lvconvert cache-pool → lvconvert cache)
  - `doChangeCacheMode()` — lvchange --cachemode + обновление JSON
  - `doRemoveSsdTier()` — syncaction check → lvconvert --uncache → vgremove
  - `ssdCreateFail()` — откат при ошибке: vgremove -f
- CSS: `ssd-bar-wrap`, `ssd-bar-fill(.warn/.crit)`, `ssd-mode-wt`, `ssd-mode-wb`

**Архитектура:**
```
Btrfs → /dev/rusnas_vgN/data_lv (dm-cache LV) → /dev/mdX (HDD RAID) + /dev/sdY (SSD)
```

**Деплой на VM:** файлы задеплоены, lvm2 установлен, sudoers создан, ssd-tiers.json создан.

**Тестирование:**
- Секция SSD-кеширования видна на странице Диски и RAID ✓
- Пустое состояние "SSD-кеш не настроен" отображается ✓
- Модал "+ Добавить SSD-кеш" открывается, RAID-массив в select `/dev/md0 — RAIDraid5, 4 дисков` ✓
- "— нет доступных SSD —" корректно (VM без свободных SSD) ✓
- Writeback warning block скрыт при writethrough, показывается при выборе writeback ✓
- Кнопка "Отмена" закрывает модал ✓
- sudo -n pvs/vgs/lvs работает через NOPASSWD ✓
- `/etc/rusnas/ssd-tiers.json` создан и содержит `{"tiers": []}` ✓

**Файлы изменены:**
- `cockpit/rusnas/disks.html` — секция SSD + 3 модала
- `cockpit/rusnas/js/disks.js` — глобальные переменные + ~350 строк SSD-функций
- `cockpit/rusnas/css/style.css` — 9 строк CSS для прогрессбаров и бейджей
- `install-ssd-tier.sh` — новый скрипт деплоя

---

## Сессия 2026-03-17 — Guard: скрытие файлов-приманок от SMB-клиентов

**Задача:** Файлы-приманки Guard (`!~rng_*.docx` и т.п.) были видны в Windows Explorer и Mac Finder. Пользователи замечали посторонние файлы и могли их случайно удалить. Решение: Samba `hide files` — файлы скрыты в проводнике, но **доступны программам** (в т.ч. шифровальщикам).

### Как работает

```ini
[global]
  hide files = /!~rng_*/
```

Файлы не показываются в проводнике (атрибут DOS Hidden), но ransomware обходит этот атрибут и видит файлы — приманка по-прежнему срабатывает.

### Реализация

**`rusnas-guard/daemon/guard.py`:**
- Новый метод `_apply_smb_hide(enabled)` в классе `GuardDaemon`:
  - Читает `/etc/samba/smb.conf`
  - Удаляет существующую строку `hide files = /!~rng_*/` если есть
  - При `enabled=True` — вставляет строку сразу после `[global]`
  - Атомарная запись через `.guard.tmp` + `os.replace()`
  - Вызывает `systemctl reload smbd`
- `update_config()` — определяет изменение `detection.hide_smb_baits`, вызывает `_apply_smb_hide()`
- `run()` — при старте применяет сохранённое состояние `hide_smb_baits`

**`cockpit/rusnas/guard.html`:**
- Checkbox `#det-hide-smb` внутри карточки "🪤 Файлы-приманки (Honeypot)" как sub-row

**`cockpit/rusnas/js/guard.js`:**
- `loadConfig()` — читает `det.hide_smb_baits` и устанавливает состояние checkbox
- Обработчик сохранения "Методы обнаружения" — включает `hide_smb_baits` в объект конфига

### Ветка
`feature/mobile-ui` (совмещена с задачей мобильного UI)

---

## Сессия 2026-03-18 — Мобильный UI: тестирование и исправление адаптивности

**Задача:** Проверить все страницы rusNAS Cockpit plugin на мобильном viewport (390×844px, iPhone 14 Pro) и исправить найденные проблемы.

### Тестирование (Playwright, 5 страниц, 31 проблема)

Агент провёл полное тестирование. Ключевые находки:

**Корневая причина большинства проблем:** Ни в одной HTML-странице не было `<meta name="viewport">`. Браузер рендерил страницы как desktop (980px) и масштабировал вниз → все `@media (max-width: ...)` не срабатывали вообще.

### Исправления

**Критические:**
| Файл | Изменение |
|------|-----------|
| Все 9 HTML (`dashboard`, `guard`, `snapshots`, `disks`, `index`, `storage-analyzer`, `dedup`, `ups`, `users`) | Добавлен `<meta name="viewport" content="width=device-width, initial-scale=1">` |
| `css/style.css` | Добавлен блок `@media (max-width: 768px)`: таблицы scroll, snap-layout стек, advisor-tabs scroll, snap-main btn-group 2-per-row, section-toolbar стек |
| `css/style.css` | Добавлен блок `@media (max-width: 480px)`: body padding, h1 размер, кнопки полная ширина, модалы, iOS zoom fix, snap-summary стек, tabs scroll |
| `css/dashboard.css` | `@media (max-width: 700px)`: guard-stats 2 колонки, metrics-grid 1 колонка |
| `css/storage-analyzer.css` | `@media (max-width: 480px)`: sa-tabs scroll, page-header стек |

**Специфические:**
- `guard.html`: добавлен `flex-wrap:wrap` на контейнер кнопок режима
- `dashboard.html`: metrics grid перенесён из inline style в CSS-класс `.db-metrics-grid`
- `style.css`: `input[type="checkbox"]` увеличен до 20×20px, `select` min-height 38px
- `style.css`: `.gd-mode-rec` 10px → 11px

### Архитектура mobile CSS
```
style.css:
  @media (max-width: 768px)  — планшет и ниже: таблицы, snap-layout, advisor-tabs, чекбоксы, selects
  @media (max-width: 480px)  — мобильный: padding, кнопки, модалы, iOS zoom, tabs

dashboard.css:
  @media (max-width: 700px)  — guard-stats 2col, metrics-grid 1col
  @media (max-width: 480px)  — identity-bar, db-identity-sep hidden

storage-analyzer.css:
  @media (max-width: 900px)  — уже существовал
  @media (max-width: 600px)  — уже существовал
  @media (max-width: 480px)  — sa-tabs scroll, page-header stack (добавлено)
```

### Файлы изменены
- 9× `.html` — viewport meta
- `css/style.css` — ~120 строк mobile breakpoints
- `css/dashboard.css` — 30 строк + `.db-metrics-grid` класс
- `css/storage-analyzer.css` — 25 строк
- `cockpit/rusnas/guard.html` — flex-wrap на mode buttons
- `cockpit/rusnas/dashboard.html` — db-metrics-grid class

---

## Сессия 2026-03-19 — Редизайн страницы Storage (Хранилище)

**Задача:** Привести раздел «Хранилище» (`/rusnas`, `index.html` + `app.js`) в порядок с точки зрения удобства использования. На одной странице было 6 вертикальных секций (SMB, NFS, iSCSI, FTP, WebDAV, WORM), при большом количестве шар страница становилась нечитаемой. Прототип решения — Synology DSM (Control Panel → Shared Folder + File Services).

**Ветка:** `feature/storage-redesign` → влита в `main`.

**ТЗ:** [rusnas-storage-task.md](./rusnas-storage-task.md)

### Что сделано

#### Новая структура страницы — 4 вкладки (`advisor-tabs`)

| Вкладка | Загрузка | Содержимое |
|---------|----------|-----------|
| `📂 Шары` | при открытии страницы | Единая таблица SMB+NFS + status bar |
| `🎯 iSCSI` | lazy (первый клик) | Таблица targets (без изменений) |
| `🔒 WORM` | lazy (первый клик) | WriteOnce paths (без изменений) |
| `⚙️ Сервисы` | lazy (первый клик) | FTP + WebDAV карточки (без изменений) |

#### Вкладка «Шары» (главное нововведение)

- **Service status bar** над таблицей: `SMB ● Активен | NFS ● Активен`
- **Единая таблица** объединяет SMB-шары и NFS-экспорты по path. Колонки: Имя | Путь | **Протоколы** (badges) | Доступ | Действия
- **Unified Share Modal** (`#share-modal`) с внутренними вкладками `Основные / SMB / NFS` заменяет 4 старых modal (#add-share, #edit-share, #add-nfs, #edit-nfs)
- Create mode: tom select + name → настройки SMB и/или NFS в одном диалоге
- Edit mode: volume select disabled, показывает текущий путь; все поля предзаполнены
- Удаление: убирает только конфигурации, директорию не трогает

#### Рефактор app.js

| Было | Стало |
|------|-------|
| `loadShares()` (рендерит таблицу) | `parseSmbConf()` — Promise, только парсинг |
| `loadNFS()` (рендерит таблицу) | `parseNfsExports()` — Promise, только парсинг |
| `openEditShare()`, `addShare()` | `openShareModal(shareData\|null)` |
| `saveEditShare()`, `addShare()` | `saveShareModal()` |
| `deleteShare(name)`, `deleteNFS(path)` | `deleteShareEntry(shareData)` |
| `openEditNFS()`, `addNFS()` | объединено в `openShareModal()` |

Новые функции: `setupStorageTabs()`, `setupShareModalTabs()`, `loadAllShares()`, `renderSharesTable()`, `loadServiceStatus()`

#### Статистика изменений

| Файл | Строк было | Строк стало | Δ |
|------|-----------|------------|---|
| `index.html` | 445 | 297 | −148 |
| `js/app.js` | 1132 | 873 | −259 |
| `css/style.css` | 1240 | 1266 | +26 |

### Технические решения

- `window._sharesData[]` — глобальный массив для event handlers динамически генерируемых строк таблицы
- `_shareModalMode` + `_shareModalData` — переменные состояния modal (create vs edit)
- `loadVolumeSelects(callback, targetId)` — добавлен второй параметр `targetId` вместо хардкода старых ID
- `_tabsLoaded.worm` / `_tabsLoaded.services` — guard против повторной загрузки при каждом клике вкладки
- SMB reload через `systemctl reload smbd` (не restart) — не рвёт активные соединения

### Диагностика памяти VM (попутно в той же сессии)

Пользователь заметил высокое потребление памяти. Диагностика показала:
- `cron.service` cgroup = 2.6 ГБ — это **page cache** от duperemove (каждый день в 03:00) и rusnas-snap. Не утечка, нормальное поведение Linux.
- `MemAvailable = 3.3 ГБ` — памяти достаточно, OOM-событий нет.
- Рекомендация: ограничить journald (`SystemMaxUse=100M` в `/etc/systemd/journald.conf`), т.к. journald использует 97 МБ RSS.

---

## Сессия 16 — FileBrowser Quantum Integration (Фаза 1 + Фаза 2)
**Дата:** 2026-03-19

### Что было сделано

**Фаза 1 — Backend:**
- Установлен FileBrowser v2.31.2 на VM (`/usr/local/bin/filebrowser`)
- Системный пользователь `rusnas-fb` (nologin)
- Сервис `rusnas-filebrowser.service` → `127.0.0.1:8088`
- Конфиг: `/etc/rusnas/filebrowser/settings.json` (port 8088, baseURL="/files", root="/")
- БД пользователей: `/var/lib/rusnas/filebrowser/users.db` (BoltDB)
- Apache proxy: `/files/` → `http://127.0.0.1:8088/files/` (mod_proxy + mod_proxy_http)
- SSL: self-signed cert `/etc/ssl/rusnas/rusnas.{crt,key}`, nginx на порту 443

**Новые скрипты:**
- `install-filebrowser.sh` — деплой скрипт (бинарник скачивается на Mac, копируется через scp)
- `cockpit/rusnas/scripts/fb-init.sh` — инициализация (admin pass + синхронизация через CLI)
- `cockpit/rusnas/scripts/fb-sync-user.py` — sync одного пользователя (CLI: стоп/старт сервиса)
- `cockpit/rusnas/scripts/fb-sync-all-users.py` — первичная sync всех Linux-пользователей (UID≥1000)
- `cockpit/rusnas/cgi/fb-users-list.py` — список пользователей FileBrowser → JSON (GET API работает)
- `cockpit/rusnas/cgi/fb-set-user-access.py` — обновление scope/WAN пользователя (CLI + access_rules.json)

**Фаза 2 — Cockpit UI:**
- `app.js`: `getFileBrowserUrl()`, кнопка «📂 Файлы» в таблице шар, 5-я вкладка «📁 Файловый менеджер» с управлением сервисом и таблицей пользователей
- `index.html`: 5-я вкладка + `#tab-filebrowser` + `#fb-user-modal`
- `users.js`: fire-and-forget sync в addUser/saveEditUser/deleteUser
- `storage-analyzer.js`: `getFileBrowserUrl()`, FileBrowser deep-links вместо in-app навигации
- `dashboard.js`: `loadFbDashStatus()` в polling (TICK_UPS=10000)
- `dashboard.html`: карточка «📂 ФАЙЛОВЫЙ МЕНЕДЖЕР» в grid-4

### Технические решения

- **Apache вместо nginx**: порт 80 уже занят Apache (лендинг). nginx на 443 конфликтовал; используем Apache mod_proxy для `/files/`
- **CLI вместо API для write-операций**: FileBrowser v2.31.2 API POST `/api/users` возвращает "invalid data type" (баг или несовместимость). GET работает. Для создания/обновления/удаления пользователей — `filebrowser --config ... users add/update/rm` с кратким стопом сервиса
- **Инициализация**: `fb-init.sh` останавливает сервис → CLI создаёт пользователей → запускает → получает API-токен для CGI-скриптов (GET)
- **API URL**: FileBrowser baseURL="/files" → все API endpoints с префиксом `/files/api/...` (не `/api/...`)
- **Token файл**: `/etc/rusnas/filebrowser/admin_token` (chmod 600, root-owned) — используется `fb-users-list.py` для GET-запросов
- **Синхронизация**: огонь-и-забудь в Cockpit Users — не блокирует UI

### Пароли по умолчанию
- admin: `rusnas_admin_2026` (меняется через FileBrowser UI)
- пользователи: `rusnas_<username>_2026` (первичная синхронизация)

### Sudoers
- `/etc/sudoers.d/rusnas-filebrowser` — python3 для CGI + systemctl start/stop/is-active

### Ветка
- `feature/filebrowser` → merge в `main`

---

## Сессия 2026-03-20 — Редизайн UI (feature/redesign-ui)

### Цель
Анализ текущего дизайна и полный редизайн дизайн-системы с помощью ui-ux-pro-max skill.

### Анализ текущего дизайна
- Стиль: PatternFly 2018-era, плоский, функциональный
- Проблемы: устаревшая палитра #0066cc, нет hover-эффектов на карточках, плоские кнопки без теней, старый underline tab style, слабая тёмная тема, нет анимаций

### Что изменено

**style.css:**
- Новая цветовая система: Slate-based light (#f1f5f9 bg, #0f172a text, #2563eb primary) + Deep navy dark (#0f172a bg, #1e293b cards, #3b82f6 primary)
- Кнопки: box-shadow на primary/danger/success, усиление при hover
- Вкладки advisor-tabs: pill-style (активная = синий background), было underline
- Карточки RAID: hover translateY(-1px) + card-shadow-hover
- Модалы: backdrop-filter blur(2px) + @keyframes modal-in анимация
- Progress bars: linear-gradient
- Таблицы: border-radius на th:first/last-child
- border-radius: 6px → 10px cards, 14px modals
- Улучшена типографика: letter-spacing, font-weight

**dashboard.css:**
- Dashboard карточки: hover = translateY(-1px) + border-color primary
- Status dots: ring-glow (box-shadow 0 0 0 3px) вместо simple glow
- Progress fill: linear-gradient для success/warn/crit
- Guard stat cells: border добавлен
- UPS metric items: border добавлен
- db-card-metric: font-size 28px → 30px, font-weight 700 → 800

### Ветка
- `feature/redesign-ui` — создана от main, задеплоена на VM

---

## Сессия N+1 — CPU Monitor Modal + Light Theme + ui.md (2026-03-20)

### Задачи
1. Починить поломанный dashboard.js (переменные удалены в предыдущей сессии, функции сломаны)
2. Добавить модальный монитор ресурсов (htop-like, по клику на CPU-виджет дашборда)
3. Починить светлую тему (shadows, row-hover)
4. Обновить ui.md с полным описанием дизайн-системы

### Реализовано

#### dashboard.js — починка поломанных переменных
- Возвращены: `prevCpu`, `prevNet`, `prevDisk`, `smartCache`, `TICK_STORAGE`, `TICK_SMART`, `TICK_GUARD`
- Без этих переменных все функции CPU/Net/IO/SMART падали с ReferenceError

#### dashboard.js + dashboard.html + dashboard.css — CPU Monitor Modal
- Клик по карточке CPU (`#card-cpu`) открывает модал `#cpu-modal`
- Обновление каждые 1 секунду через `setInterval(refreshCpuModal, 1000)`
- Layout: 2-column grid (CPU cores + Memory/Load) + процессы внизу
- CPU bars: per-core (C0, C1...) + total, gradient цвет по нагрузке
- Memory bars: RAM (синий) + Swap (фиолетовый) с human-readable подписями
- Load grid: 4 tile (1мин / 5мин / 15мин / CPU temp)
- Process table: топ-12 процессов по CPU (PID, имя, CPU%, MEM%, RAM)
- Цвета баров: зелёный (0-59%) → жёлтый (60-79%) → красный (≥80%)
- Закрытие: кнопка ✕ или клик по overlay

#### style.css — светлая тема
- `--card-shadow`: `0 1px 3px rgba(0,0,0,0.09), 0 2px 6px rgba(0,0,0,0.05)` (усилено)
- `--card-shadow-hover`: `0 4px 20px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.07)` (усилено)
- `--bg-row-hover`: `#f1f5f9` → `#e8edf3` (теперь заметно отличается от bg-card white)
- `.advisor-tab-btn.active box-shadow`: rgba(hardcoded) → `color-mix(in srgb, var(--primary) 40%, transparent)` (адаптивно к теме)

#### ui.md — полная переработка
- Документированы все CSS-переменные (таблицы свет/тёмн)
- Документированы pill-tabs vs underline-tabs
- Modal дизайн (backdrop-blur, animation, radius-lg)
- Dashboard компоненты: sparklines (bezier, gradient fill, endpoint dot, grid lines)
- Status dots ring-glow через color-mix
- CPU Monitor Modal компоненты
- Все адаптивные breakpoints
- JS правила (CSP, superuser, Promise.all pattern)

### Ветка
- `main` — задеплоено на VM

---

## Сессия N+2 — Network Modal, Guard Auto-Start, Snapshot Fix, TX Bug (2026-03-21)

### Задачи
1. Сетевой монитор в модальном окне (клик по виджету СЕТЬ на дашборде)
2. Guard не запускался автоматически после перезагрузки сервера
3. Неправильный подсчёт снапшотов в виджете дашборда
4. Исходящий трафик (↑) всегда показывал 0 Б/с

### Реализовано

#### dashboard.html + dashboard.css + dashboard.js — Network Monitor Modal
- Клик по карточке `#card-net` открывает модал `#net-modal`
- Live-скорости RX/TX (копируются с основной карточки, обновление 1 сек)
- vnstat интеграция: `cockpit.spawn(["vnstat", "--json"])` → парсинг JSON
- 7-дневный бар-чарт (SVG, попарные столбики RX/TX зелёный/оранжевый)
- 24-часовой почасовой бар-чарт (сортировка по timestamp)
- Таблица помесячной статистики (последние 12 месяцев, новые сверху)
- CSS `.nm-*` классы по аналогии с `.cm-*` (CPU modal)
- Закрытие: кнопка ✕ или клик по overlay

**Баг vnstat:** неправильные ключи JSON — `traffic.days/hours/months` → правильно `traffic.day/hour/month`;
порядок записей oldest-first → today = `day[day.length-1]`

#### rusnas-guard/daemon/guard.py — Auto-Start Detector
- Добавлен `auto_start: true` флаг (default True)
- В `run()` после инициализации: если `auto_start` → вызывается `start_guard()` автоматически
- Результат: после `systemctl restart rusnas-guard` и после ребута сервера детектор запускается сам
- `state.json` сразу показывает `daemon_running: true`

#### dashboard.js — Snapshot Widget Fix
- Было: `total_count` из `storage-info` включал старые тестовые пути `/mnt/btrfspool/...` → 46 снапшотов вместо 20
- Стало: cross-reference с `schedule list` — показываются субволюмы которые имеют расписание (любое) ИЛИ ненулевое количество снапшотов
- Суммирование `totalCount` и `totalSize` пересчитывается по отфильтрованному списку
- Используется `fmtBytes()` для форматирования размера вместо `total_size_human` из API

#### dashboard.js — TX Speed Fix (/proc/net/dev regex)
- Баг: regex `/^(\w+):\s+(\d+)(\s+\d+){6}\s+(\d+)/` захватывал `RX_multicast` (8-й RX-столбец, всегда ≈0) вместо `TX_bytes` (9-й столбец)
- `/proc/net/dev` формат: `iface: RX_bytes pkt errs drop fifo frame compressed multicast | TX_bytes ...`
- Исправление: добавлен один `\s+\d+` → теперь правильно пропускает все 7 RX-полей и захватывает TX_bytes
- Это исправляет как модал (↑ 0 Б/с), так и спарклайн оранжевой линии TX на основной карточке

### Ветка
- `feature/redesign-ui` → слита в `main`, задеплоена на VM

---

## Сессия 2026-03-22 — iSCSI Architectural Redesign

### Задача
Полный редизайн iSCSI-секции: разделение LUN Manager и Target Manager (как в Synology DSM), устранение orphaned файлов, замена хрупкого text-парсинга `targetcli ls /` на чтение структурированного `saveconfig.json`.

### Ключевые изменения

**index.html:**
- Заменён `#tab-iscsi` — теперь два раздела: «LUN / Хранилища» + «iSCSI Targets»
- Старый `#add-iscsi-modal` заменён тремя новыми модалами:
  - `#iscsi-lun-modal` — создание LUN (fileio/block, опция создания файла)
  - `#iscsi-target-modal` — создание/редактирование target (LUN-чеклист, ACL, CHAP)
  - `#iscsi-delete-modal` — подтверждение удаления с опцией «Удалить файл с диска»

**app.js (iSCSI секция, ~400 строк):**
- Новое состояние: `_iscsiState = { backstores, targets, loaded }`, `_iscsiDeleteCtx`
- `_tcli(args)` — helper для `sudo targetcli`
- `_readSaveconfig()` — читает `/etc/rtslib-fb-target/saveconfig.json`
- `_iscsiLoadConfig(cfg)` — парсит JSON в `_iscsiState`:
  - `storage_objects` — flat list, поле `plugin` (не `type`), путь нормализуется (`/backstores/` strip)
  - `targets` — flat list, фильтр `fabric === "iscsi"`
- `loadISCSI()` — сначала `targetcli saveconfig` (гарантирует свежий JSON), потом читает и рендерит
- `renderLunsTable()` — кнопка «Удалить» задисейблена если `inUseBy.length > 0`
- `renderTargetsTable()` — кнопки «Изменить» и «Удалить»
- `saveLun()` — fileio (mkdir + create) / block (create)
- `confirmDeleteLun()` / `_iscsiExecuteDeleteLun()` — опциональное удаление `.img`
- `openTargetModal()` — LUN-чеклист из `_iscsiState.backstores`
- `saveTarget()` — create/edit: LUN-mappings, ACL, CHAP
- `confirmDeleteTarget()` / `_iscsiExecuteDeleteTarget()` — только конфиг, файлы не трогает
- `_esc()` — HTML-эскейп для safe rendering

### Критические факты (для будущих сессий)
- Конфиг: `/etc/rtslib-fb-target/saveconfig.json` (НЕ `/etc/target/`)
- `storage_object` в JSON: `/backstores/fileio/backup1` — нормализуется strip `/backstores/`
- Всегда вызывать `targetcli saveconfig` перед чтением JSON (файл обновляется только явно)
- `_esc()` нужна для всех данных в innerHTML (IQN, пути содержат спецсимволы)

### Ветка
- Коммиты в `main`, задеплоено на VM

### Продолжение сессии 2026-03-22 — багфиксы iSCSI + Storage Analyzer

**iSCSI — дополнительные исправления:**
- `_readSaveconfig()`: заменён `sudo cat` на `cockpit.file(path, {superuser:"try"}).read()` — `sudo cat` не был в sudoers NOPASSWD
- `saveLun()` — fileio без галочки «Создать файл»: убран аргумент `size=` (targetcli определяет размер автоматически для существующего файла)
- Поле «Размер» скрывается когда «Создать файл» снят; появляется подсказка «Файл уже существует»
- Удаление файла LUN: заменён `cockpit.spawn(["sudo","rm",...])` на `cockpit.spawn(["rm",...],{superuser:"try"})` — `sudo rm` не в NOPASSWD
- Добавлена кнопка «🔍 Найти незарегистрированные» — сканирует `/mnt/data/iscsi/*.img`, предлагает зарегистрировать незарегистрированные файлы как backstores

**Storage Analyzer — исправления:**
- `storage-analyzer-api.py`: `classify_ext` и константы расширений вынесены инлайн (убран `from storage_collector_lib import classify_ext` — модуль не существует)
- `cmd_files`: при `ftype != "all"` — рекурсивный `os.walk` вместо плоского `os.listdir`; директории не включаются (убирает таймаут от `du -sb` на больших папках)
- Файлы показываются с относительным путём от текущей директории (`documents/update.img`)

**Лендинг:** обновлены карточка «Все протоколы» (упомянут LUN Manager) и «Анализатор пространства» (фильтрация по типам); добавлена строка «Независимый LUN Manager» в сравнительную таблицу

---

## Сессия 2026-03-21 (продолжение) — Network module + Сертификаты

### Задача
Реализация полного модуля управления сетью (вкладка Сеть в Cockpit) + вкладка Сертификаты с Let's Encrypt, самоподписанными и импортированными сертификатами.

### Новые файлы
- `rusnas-network-task.md` — полное ТЗ для модуля сети
- `cockpit/rusnas/network.html` — 5-вкладочная страница (Интерфейсы, DNS и хосты, Маршруты, Диагностика, Сертификаты)
- `cockpit/rusnas/css/network.css` — стили с ui-ux-pro-max: elevation shadows, pulse animation, terminal output
- `cockpit/rusnas/js/network.js` — полная логика: ifupdown management, трафик-мониторинг, диагностика, сертификаты
- `cockpit/rusnas/scripts/network-api.py` — backend: parse/write /etc/network/interfaces, DNS, hosts, routes
- `cockpit/rusnas/scripts/certs-api.py` — backend: list-certs, issue-letsencrypt, create-selfsigned, import-cert, delete-cert, check-and-renew, daemon-status
- `rusnas-certcheck/rusnas-certcheck.service` — systemd oneshot сервис (daily check)
- `rusnas-certcheck/rusnas-certcheck.timer` — daily 03:30, RandomizedDelaySec=1800
- `install-network.sh` — деплой: пакеты (traceroute, dnsutils, netcat-openbsd, certbot), sudoers, systemd timer

### Архитектура сертификатов
- Хранение LE: `/etc/letsencrypt/live/`
- Хранение кастомных: `/etc/rusnas/certs/{name}/cert.pem + key.pem + meta.json`
- certbot: webroot (через /var/www/rusnas-landing) или standalone
- openssl SAN: автоматически `DNS:` или `IP:` prefix по regex
- Автопродление: ≤30 дней → certbot renew (только LE), daemon = rusnas-certcheck.timer
- Лог: `/var/log/rusnas/certcheck.log`

### Критические факты
- `network-api.py parse_interfaces()`: `/etc/network/interfaces` может иметь 2 stanza для одного интерфейса (inet + inet6); prefer `inet` for config_mode; inet6 → `method6`
- `allow-hotplug` обрабатывается аналогично `auto` в парсере
- Port check: `nc` (`/bin/nc`) из пакета netcat-openbsd; НЕ ncat
- cert SANs в openssl.cnf: `DNS:hostname` или `IP:x.x.x.x` (обязательно prefix!)
- `install-network.sh`: sudoers записывается через `echo | ssh cat >` → `sudo cp` (не heredoc + sudo -S)
- Certbot установлен на VM: `certbot 4.0.0` (Debian 13 Trixie)

### Ветка
- `feature/network` — активная разработка, задеплоено на VM

---

## Сессия N — Domain Services Tab (2026-03-22)

### Реализовано: 6-я вкладка «🏢 Домен» в network.html

#### Новые файлы
- `cockpit/rusnas/scripts/domain-api.py` — 888 строк, 35 команд для обоих режимов

#### Изменённые файлы
- `network.html` — 6-я вкладка + mode selector + 11 sub-tabs + 7 modals
- `js/network.js` — +1130 строк JS (domainApi, member mode, DC mode)
- `css/network.css` — +457 строк стилей
- `install-network.sh` — пакеты realmd/winbind/krb5 + sudoers

#### Режим «Участник домена»
- `detect-mode` → `status` → join/leave wizard (realm join/leave)
- Список пользователей/групп через wbinfo
- Управление разрешёнными группами (realm permit/deny)
- Редактор [global] smb.conf

#### Режим «Контроллер домена» (Samba AD DC)
- DC provision wizard (samba-tool domain provision + krb5.conf)
- CRUD пользователей + enable/disable + смена пароля
- CRUD групп + управление участниками
- Репликация: статус + sync (samba-tool drs)
- DNS: query/add/delete записей (samba-tool dns)
- GPO: список + создание (samba-tool gpo)
- FSMO роли в обзоре

#### API тест на VM (mode: none, services: winbind+smbd active)
```
python3 domain-api.py detect-mode → {"ok": true, "mode": "none"}
python3 domain-api.py status → {"ok": true, "joined": false, ...}
python3 domain-api.py dc-status → {"ok": true, "provisioned": false, ...}
python3 domain-api.py get-smb-global → {"ok": true, "settings": {...}}
```

#### Ветка
- `feature/network` — commit 5a13dc5

---

## Сессия N+1 — Документация Domain Services (2026-03-22)

### Создан: rusnas-domain-task.md
Полное ТЗ + архитектура Domain Services:
- Схема detect-mode (samba-ad-dc → winbind → none)
- Member mode: схема интеграции SMB + AD, NSSwitch, IDmap, realm join/leave
- DC mode: samba-tool provision, структура smb.conf, FSMO роли, DNS backends, репликация
- Таблица всех 35 backend-команд domain-api.py
- Ограничения и нюансы (samba-ad-dc ≠ smbd, медленный dc-user-list при 1000+ юзеров и т.д.)

### Обновлён: CLAUDE.md
- Ссылка на rusnas-domain-task.md в шапке
- Секция «✅ Domain Services» с key architecture notes, critical notes, JS state
- Название Network раздела обновлено: «6 вкладок» вместо «5»

### Обновлён: landing/index.html
- Новая карточка «🏢 Active Directory» в features-grid
- Новая карточка «🔒 TLS-сертификаты» в features-grid
- Tech stack: добавлен «Samba AD DC + Winbind»
- Comparison table: разделены строки «Участник AD» и «Контроллер домена»
- Specs (User & Auth): добавлена строка «Контроллер домена AD»
- Деплой: http://10.10.10.72/

---

## Сессия N+2 — Network Auto-Revert (Безопасное применение сетевых настроек) (2026-03-22)

### Проблема
При смене IP-адреса через UI изменения применялись мгновенно и необратимо. Инцидент: баг в `set-interface` (дублирование `allow-hotplug` + `auto`) оставил VM недоступной — пришлось логиниться через tty1 в UTM.

### Решение: Commit-to-Revert (классический паттерн NetworkManager/pfSense)

#### Изменённые файлы
- `cockpit/rusnas/scripts/network-api.py` — backup + systemd transient timer + 4 новые команды
- `cockpit/rusnas/js/network.js` — баннер с обратным отсчётом + safety modal + get-pending при загрузке
- `cockpit/rusnas/network.html` — #netRollbackBanner + #netSafetyModal
- `cockpit/rusnas/css/network.css` — стили баннера и safety modal

#### Как работает

1. `set-interface` делает `shutil.copy2(INTERFACES_FILE, bak_path)` ПЕРЕД записью нового конфига
2. После успешного `ifup` запускает `systemd-run --on-active=90s --unit=rusnas-net-revert-{iface}` (python3 _revert-apply)
3. Возвращает `{"ok": true, "pending": true, "seconds": 90}`
4. Если `ifup` rc≠0 — немедленный автооткат через `_do_revert()`, возвращает `{"ok": false, "error": "..."}`
5. Баннер показывается с таймером 90→0, кнопки: ✓ Подтвердить / ↩ Откатить
6. Подтверждение: `systemctl stop rusnas-net-revert-{iface}.timer` + удаление .bak/.ts файлов
7. Откат: восстановить .bak → ifdown → ifup → удалить файлы
8. При reload страницы: `get-pending` для каждого интерфейса → восстанавливает баннер с оставшимся временем

#### Safety Modal
Показывается только при критичных изменениях (смена режима DHCP↔Static, смена IP, смена шлюза). Пошаговая инструкция на русском.

#### Файлы состояния на VM
```
/etc/rusnas/net-rollback-<iface>.bak   ← копия /etc/network/interfaces до изменений
/etc/rusnas/net-rollback-<iface>.ts    ← float unix timestamp истечения таймера
```

#### Новые команды network-api.py
| Команда | Действие |
|---------|---------|
| `confirm-change <iface>` | Останавливает таймер, удаляет backup-файлы |
| `revert-change <iface>` | Останавливает таймер, восстанавливает backup |
| `get-pending <iface>` | Проверяет активный pending (is-active timer + оставшиеся секунды) |
| `_revert-apply <iface>` | Вызывается systemd при истечении таймера — откатывает конфиг |

#### Ветка
- `feature/network` → смержено в `main`

---

## Сессия N+3 — DC режим: dc-stop/dc-start/dc-deprovision + SMB статус в dashboard (2026-03-22)

### Проблемы

1. **"Unknown command: dc-stop"** — UI вызывал `dc-stop`/`dc-start`/`dc-deprovision` (network.js:2208), но эти команды отсутствовали в `domain-api.py`
2. **SMB "Остановлен" при работающем DC** — dashboard смотрел только на `smbd`; при DC режиме `smbd` намеренно остановлена, `samba-ad-dc` предоставляет SMB на порту 445
3. **smbd не поднималась после dc-stop** — `samba-tool domain provision` перезаписывает `/etc/samba/smb.conf` в DC-формат (`server role = active directory domain controller`); смбд с таким конфигом не стартует
4. **Побочный баг**: smb.conf.bak содержал `guest ok = Yes[documents]` — inline-комментарий слипся со значением; исправлено на `guest ok = No`

### Исправления

#### domain-api.py
- **dc-start**: `systemctl start samba-ad-dc`
- **dc-stop**: `systemctl stop samba-ad-dc` + `_restore_smbd()`
- **dc-deprovision**: stop+disable+mask samba-ad-dc, удалить DC smb.conf, `_restore_smbd()`
- **dc-provision**: backup `smb.conf` → `smb.conf.pre-dc` ДО запуска provision; mask smbd/nmbd; restore smbd если provision упал
- **_restore_smbd()**: хелпер — восстанавливает `smb.conf.pre-dc` (или пишет minimal fallback если нет бэкапа), unmask + start smbd/nmbd

#### dashboard.js
- SMB карточка теперь проверяет два сервиса: `smbd` (primary) и `samba-ad-dc` (fallback)
- Статусы: "Активен" / "Активен (DC)" / "Остановлен"
- Карточка не красная если SMB работает через DC режим

### Ветка
- Коммиты прямо в `main` (hotfix)

---

## Сессия MCP-AI — AI Ассистент (Session 1) (2026-03-22)

### Что было сделано

Реализован AI-ассистент прямо в Cockpit UI — страница для управления NAS на естественном языке.

### Новые файлы

- **`cockpit/rusnas/scripts/mcp-api.py`** — NAS command dispatcher (JSON stdio). 11 команд: get-status, list-shares, list-disks, list-raid, list-snapshots, create-snapshot, delete-snapshot, list-users, get-events, run-smart-test, get-smart. Логирование мутирующих команд в `/var/log/rusnas/ai-actions.jsonl`.
- **`cockpit/rusnas/ai.html`** — страница AI-чата. Viewport meta, dark mode, suggestion chips.
- **`cockpit/rusnas/js/ai.js`** — Claude API + tool calling loop. Tool schema (11 инструментов), agentic loop (while stop_reason === "tool_use"), localStorage для API ключа и истории, восстановление истории при перезагрузке.
- **`cockpit/rusnas/css/ai.css`** — стили: chat bubbles, tool call blocks (collapsible), thinking indicator (animated dots), settings panel, responsive.
- **`install-mcp.sh`** — деплой backend на VM (sudoers + log dir).

### Изменения существующих файлов

- **`manifest.json`**: добавлен entry "AI Ассистент 🤖" (order 11) + `connect-src https://api.anthropic.com` в CSP.

### Архитектура

```
ai.html / ai.js ──fetch()──▶ Anthropic Claude API (claude-sonnet-4-6)
      │                              │ tool_use callback
      └──cockpit.spawn──▶ mcp-api.py (Python, JSON stdio)
                                     │
                          rusnas-snap / testparm / mdadm / smartctl / ...
```

### Технические детали

- API ключ хранится в localStorage — никогда не уходит на VM
- Tool calling loop: `while (resp.stop_reason === "tool_use") { executeTool() → push tool_result → callClaude() }`
- Параллельное выполнение всех tool_use блоков одного ответа через `Promise.all()`
- Системный промпт включает NAS контекст (get-status + list-disks), загружаемый при старте
- Suggestion chips для быстрого старта
- Sudoers: `/etc/sudoers.d/rusnas-mcp` — NOPASSWD для mcp-api.py

### Ветка
- `feature/mcp-ai` → будет слита в `main`

### Следующая сессия (Session 2)
- HTTP SSE транспорт (порт 8765) для Claude Desktop / Cursor
- `pip install mcp` SDK
- Ollama поддержка

---

## Сессия MCP-AI-2 — Multi-provider AI + openEYE Agent + SMART fix (2026-03-23)

### A. Multi-provider AI (YandexGPT + Anthropic)

**Проблема:** Fetch из браузера (Cockpit iframe) к `ai.api.cloud.yandex.net` блокируется CORS (нет `Access-Control-Allow-Origin`). Прямой fetch из JS к Yandex невозможен.

**Решение:** Все AI-вызовы идут через `mcp-api.py` на VM (Python не знает CORS). Паттерн:
1. `cockpit.file("/tmp/rusnas-ai-req.json").replace(JSON.stringify(payload))` — записывает payload
2. `cockpit.spawn(["sudo", "-n", "python3", MCP_SCRIPT, "ai-chat", tmpFile])` — `mcp-api.py` читает файл, вызывает AI API, возвращает ответ

**Почему не stdin:** Cockpit 337 не закрывает stdin после записи через `input` option → `sys.stdin.read()` блокируется бесконечно. Файловый подход надёжен.

#### YandexGPT (OpenAI-compatible format)
- API: `https://ai.api.cloud.yandex.net/v1/chat/completions`
- Авторизация: `Bearer <IAM-key>`, требует `folder_id` в `model_uri: "gpt://folder/model"`
- Формат tool calling: OpenAI-совместимый (`tools[]`, `finish_reason: "tool_calls"`, `role: "tool"`)
- Дефолт: `yandexgpt-5-pro/latest`, поддерживает function calling
- Предзаполненные учётные данные (playground-ключ)

#### Anthropic (нативный формат)
- API: `https://api.anthropic.com/v1/messages`
- `anthropic_tools`: `input_schema` вместо `parameters`, `tool_use`/`tool_result` блоки
- `convertToAnthropicMessages()` — конвертация OpenAI-формата в Anthropic перед вызовом

#### ai.js — ключевые изменения
- `callViaProxy(messages)` — единый proxy через mcp-api.py для обоих провайдеров
- `normalizeResponse(data, provider)` — нормализует ответ провайдера в `{stopReason, text, toolCalls, rawMessage}`
- Внутренний формат сообщений: OpenAI (Yandex-native), `convertToAnthropicMessages()` конвертирует при Anthropic вызове
- `TOOLS_SCHEMA` в OpenAI формате; `toAnthropicTools()` конвертирует schema для Anthropic
- localStorage ключи: `rusnas_ai_provider`, `rusnas_yandex_key`, `rusnas_yandex_folder`, `rusnas_yandex_model`, `rusnas_claude_key`, `rusnas_ai_model`, `rusnas_ai_maxtokens`

#### ai.html — изменения
- Provider selector: `<select id="ai-provider-select">` — Yandex / Anthropic
- Yandex fields: API Key, Folder ID, Model select
- Anthropic fields: API Key, Model select (скрыты при Yandex-провайдере)

### B. openEYE Agent

**Концепция:** При открытии любой страницы rusNAS, если включено в настройках AI, автоматически анализирует текстовое содержимое страницы и показывает AI-выводы в левой выезжающей панели.

#### Новые файлы
- **`cockpit/rusnas/js/eye.js`** — IIFE-модуль. Активируется только при `localStorage.getItem("rusnas_eye_enabled") === "true"`. Ждёт 3500ms после DOMContentLoaded (чтобы JS успел отрисовать динамические данные). Извлекает `document.querySelector(".page-wrap")?.innerText` (до 5000 символов). Вызывает AI через тот же `cockpit.file().replace() → cockpit.spawn(mcp-api.py ai-chat)` proxy.
- **`cockpit/rusnas/css/eye.css`** — Стили левой панели: FAB кнопка `#eye-fab` (нижний левый угол), панель `#eye-panel` (320px, `transform: translateX(-330px)` → `translateX(0)` с `.open`), findings с цветными левыми бордерами по уровню.

#### Промпт к AI
Запрашивает строго JSON: `{"findings":[{"level":"critical|warning|info|ok","text":"..."}]}`
Уровни: critical (🔴 красный), warning (🟡 жёлтый), info (🔵 синий), ok (🟢 зелёный). Максимум 6 findings.

#### Интеграция во все страницы
`css/eye.css` + `js/eye.js` добавлены во все 10 HTML-страниц плагина (dashboard, index, disks, users, guard, snapshots, dedup, ups, storage-analyzer, network, ai).

#### Настройка
- Чекбокс "👁 openEYE Agent" в `ai.html` настройках → сохраняет `rusnas_eye_enabled = "true"` в localStorage
- `ai.js`: `loadSettingsToUI()` и `saveSettings()` обрабатывают `#ai-eye-toggle`

### C. SMART data fix

**Проблема:** В разделе Дисков все показывают "нет данных" — `smartctl` не был в sudoers NOPASSWD + неправильный паттерн spawn.

**Неправильный паттерн:**
```javascript
cockpit.spawn(["bash", "-c", "sudo smartctl -i -H /dev/sda 2>/dev/null | grep ..."])
```
bash запускается без привилегий → внутренний sudo требует пароль → команда падает.

**Правильный паттерн:**
```javascript
cockpit.spawn(["sudo", "-n", "smartctl", "-i", "-H", "/dev/" + disk], {err: "message"})
```

**Исправления:**
- `disks.js:327` `loadDiskInfo()` — `-i -H` без bash
- `disks.js:503` `loadAddDiskInfo()` — `-i` без bash+grep (JS парсинг)
- `disks.js:544` `openEjectDisk()` — `-i` без bash+grep (JS парсинг)
- `dashboard.js:344` `loadDiskHealth()` — `-H /dev/dev` без bash+grep (JS indexOf)

**Судоерс:** `/etc/sudoers.d/rusnas-smart`
```
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/smartctl
```

**Регулярный мониторинг:** `smartmontools.service` (smartd) предустановлен и включён на VM — работает на реальном железе. Dashboard опрашивает `smartctl -H` каждые 5 минут (`TICK_SMART = 300000ms`) с кэшированием.

### Ветка
- `feature/mcp-ai`



---

## Сессия 2026-03-23 — RAID Upgrade, Array Deletion Cleanup, Stale Resources

**Ветка:** `feature/mcp-ai`

### Выполнено

#### 1. RAID 1→5 апгрейд (disks.js)
- Добавлена запись `"raid1"` в `RAID_UPGRADES` map с описанием (3 диска RAID 5 = 2× ёмкость vs 1× у RAID 1)
- Кнопка "⬆ Апгрейд" теперь динамическая — проверяет `RAID_UPGRADES[arr.level]` и показывает целевой уровень
- Ранее работал только RAID 5→6

#### 2. Очистка зависимостей при удалении RAID-массива (disks.js, disks.html)
- `scanArrayDeps(mp, callback)` — параллельно сканирует точку монтирования:
  - SMB шары: python3 через `/tmp/rusnas_dep_scan.py` парсит smb.conf секции по `path=`
  - NFS экспорты: grep `/etc/exports`
  - Расписания снапшотов: `rusnas-snap schedule list` → фильтр по subvol_path
- `openDeleteArrayModal()` вызывает сканирование и показывает блок "🔗 Будут удалены связанные ресурсы"
- `doDeleteArray()` перед umount удаляет: SMB секции (sed + systemctl reload smbd), NFS строки (sed + exportfs -ra), расписания (rusnas-snap schedule delete)
- Добавлен `_escHtml()` helper в disks.js

#### 3. Индикация "мёртвых" шар в таблице (app.js)
- `loadAllShares()`: после merge SMB+NFS — bash-проверка `[ -d path ]` для всех путей за один spawn
- `renderSharesTable()`: строки с `pathExists=false` — opacity 0.6, путь красным, бейдж `⚠ путь не найден`, кнопка "📂 Файлы" скрыта

#### 4. Offline-субволюмы в снапшотах (snapshots.js)
- `isSubvolOffline(path)` — хелпер по `subvolGroups[]`
- `loadSnapshots()`: ранний return с предупреждением и инструкцией если offline; кнопка "Создать" disabled
- `renderSchedules()`: бейдж + disabled-кнопки для offline-субволюмов; кнопка Удалить остаётся

#### 5. Bugfix: guard.py не исполняемый (VM)
- После `scp`-деплоя без `install-guard.sh` файл терял бит `+x`
- `chmod +x /usr/lib/rusnas-guard/guard.py` на VM
- `install-guard.sh` уже содержит правильный `chmod 755` — надо запускать при каждом обновлении guard.py

### Файлы изменены
| Файл | Изменения |
|------|----------|
| `cockpit/rusnas/js/disks.js` | `_escHtml()`, `_deleteArrayDeps`, `scanArrayDeps()`, `openDeleteArrayModal()`, `doDeleteArray()`, `RAID_UPGRADES` +raid1, upgradeBtn dynamic |
| `cockpit/rusnas/disks.html` | `#delete-array-deps` секция в modal-delete-array |
| `cockpit/rusnas/js/app.js` | path existence check в `loadAllShares()`, stale badge в `renderSharesTable()` |
| `cockpit/rusnas/js/snapshots.js` | `isSubvolOffline()`, offline guard в `loadSnapshots()`, offline badges в `renderSchedules()` |
| `bugs.md` | BUG-14..BUG-17, FEAT-01 |
| `project_history.md` | эта запись |
| `CLAUDE.md` | Known Bugs обновлён |


---

## Сессия 2026-03-23 — Снапшоты: Репликация (инфографика + systemd)

**Ветка:** `feature/mcp-ai`

### Контекст

Функция репликации снапшотов (btrfs send/receive по SSH) была полностью реализована ранее на уровне CLI и JS, но:
1. Вкладка «Репликация» в `snapshots.html` не имела описания/инфографики (только пустой `#replication-content`)
2. `rusnas-snapd.service` запускал только `scheduled-run` — репликация не выполнялась по таймеру

### Выполнено

#### 1. Инфографика в вкладке «Репликация» (snapshots.html)
- Добавлен статический HTML-блок перед `#replication-content`
- **Flow-диаграмма:** Исходный NAS → SSH туннель → Удалённый хост
  - Используются CSS-классы `sg-repl-flow` / `sg-repl-nas` / `sg-repl-remote` / `sg-repl-arrow` (уже были в inline `<style>`)
- **Сравнительные карточки** (`sg-cmp`): «Первая репликация (полная)» vs «Последующие (инкрементальные)»
- **3 сценария** (`gd-scenarios`): резервный NAS, Georedundancy/DR-сайт, удалённый офис
- **Quick start** (`gd-quickstart`): 4 шага от настройки SSH-ключа до первой репликации
- Разделитель `.sg-div` перед динамическим списком задач

#### 2. Запуск репликации по расписанию (rusnas-snapd.service)
- Добавлен второй `ExecStart`:
  ```ini
  ExecStart=/usr/local/bin/rusnas-snap replication run-all
  ```
- Таймер (каждые 5 минут) теперь последовательно запускает `scheduled-run` и `replication run-all`
- Задеплоено через `./install-snapshots.sh`

### Файлы изменены

| Файл | Изменения |
|------|-----------|
| `cockpit/rusnas/snapshots.html` | Инфографика в `#tab-replication` |
| `rusnas-snap/rusnas-snapd.service` | Второй `ExecStart` для `replication run-all` |
| `roadmap.md` | Раздел «Снапшоты: репликация» помечен ✅, детали реализации |
| `CLAUDE.md` | Roadmap-таблица ✅, Critical notes для replication |
| `project_history.md` | эта запись |

### Архитектурные заметки

- Инфографика в вкладке — **статический HTML**, не рендерится JS; `#replication-content` — динамический список задач
- CSS-классы для инфографики все уже были в inline `<style>` snapshots.html: `sg-repl-*` (flow-диаграмма), `sg-cmp-*` (карточки); `gd-*` — из `style.css` (guard-паттерн)
- `replication list` возвращает `{tasks:[...], ok:true}` — разбирать как `data.tasks`
- Репликация требует: Btrfs-субволюм на удалённом хосте + SSH ключ (`ssh-copy-id`) до настройки через UI

---

## Сессия 2026-03-25 — Regression Testing + CPU Optimization + Night Report + btrfs-problems.md

### Цели

1. Полная регрессионная проверка всего плагина rusNAS (все страницы, все функции)
2. Оптимизация CPU-нагрузки Cockpit без потери функциональности
3. Реализация Night Report (ночной отчёт на дашборде)
4. Документирование всех известных проблем Btrfs+mdadm в `btrfs-problems.md`

---

### Выполнено

#### CPU-оптимизация (dashboard.js)

Ветка: `testing/full-regression`, коммит `9ed5d1a`

Основной выигрыш: 4 отдельных `cockpit.spawn()` в `tickFast()` → 1 bash-спавн с разделителем `===M===`.

```javascript
function loadFastMetrics() {
    cockpit.spawn(["bash", "-c",
        "cat /proc/stat | head -1; cat /proc/loadavg; nproc; ... echo '===M==='; " +
        "cat /proc/meminfo; echo '===M==='; cat /proc/net/dev; echo '===M==='; cat /proc/diskstats"
    ], {err: "message"})
    .done(function(out) {
        var parts = out.split("===M===\n");
        _parseCpuOut(parts[0]); _parseRamOut(parts[1]);
        _parseNetOut(parts[2], now); _parseDiskOut(parts[3], now);
    });
}
```

#### Фиксы багов (BUG-18 — BUG-23)

| Bug | Fix |
|-----|-----|
| `sysctl -w` через `sudo -n` — нет в sudoers | `writeSysFile("/proc/sys/...", val)` через cockpit.file superuser |
| `escHtml(null)` → TypeError | `String(s \|\| "").replace(...)` |
| Race condition в openCpuModal interval | `clearInterval(_cmInterval)` перед новым setInterval |
| vnstat фетч при каждом открытии модала | Кэш `_vnstatLastFetch` + `VNSTAT_CACHE_MS=60000` |
| setInterval без сохранения ID | `_snapRefreshTimer = setInterval(...)` |
| Performance Tuner apply не работал | `sysctlPath()` + `writeSysFile()` вместо `sysctl -w` |

#### Night Report (ночной отчёт)

Новый виджет на дашборде — «утренняя газета для инфраструктуры». Показывает сводку за последние 8 часов:

- Health Score (0–100 баллов, localStorage)
- 5 ключевых метрик: инциденты безопасности, снапшоты, нагрузка CPU, сеть, SMART
- 3 колонки: Guard события, SMART статус дисков, Дедупликация и снапшоты
- Кнопка «Обновить» для ручного обновления

**Файлы:**
- `dashboard.html` — HTML-блок `#night-report`
- `css/dashboard.css` — все `.nr-*` CSS-классы + responsive
- `js/dashboard.js` — `initNightReport()`, `nrCollect*()`, `nrRender*()` (ES5 промис-цепочки)

#### btrfs-problems.md

Создан документ с 15 разделами по известным проблемам Btrfs+mdadm:
RAID5/6 write hole, CoW+RAID overhead, scrub vs fsck, balance stalls, power loss recovery, snapshot fragmentation, THP, stripe_cache_size, noatime обязателен, zstd tuning, qgroups overhead, rebuild behavior, mdadm bitmap, defrag side effects, RAID grow + btrfs resize sequence.

#### Регрессионное тестирование (Playwright)

Протестированы все 9 страниц плагина. Результат: **9/9 PASS, 0 FAIL**.

| Страница | Статус | Примечания |
|----------|--------|------------|
| Dashboard | ✅ PASS | Night Report, метрики, Guard/RAID статус — всё работает |
| Диски и RAID | ✅ PASS | md127 RAID6, 4 диска, SMART OK |
| Снапшоты | ✅ PASS | 44 снапшота, предупреждение об offline-субволюме `images` (ожидаемо) |
| Performance Tuner | ✅ PASS | Детект железа, таблица оптимизаций с текущими значениями |
| Хранилище | ✅ PASS | SMB/NFS Активен, табы, пустой список шар (ожидаемо) |
| Пользователи | ✅ PASS | Таблица пользователей и групп |
| Дедупликация | ✅ PASS | Последний запуск, 2.1 ГБ сэкономлено |
| Guard | ✅ PASS | Защита активна, 0 событий |
| ИБП (UPS) | ✅ PASS | Загрузка без устройства (ожидаемо) |

**Некритичные наблюдения:**
- Google Fonts CSP-блок — ожидаем (нет интернета на VM)
- 404 для mcp-api.py — сервис не запущен на VM (не мешает UI)
- Subvolume `images` offline — конфигурационная особенность тестовой VM

### Новые антипаттерны в CLAUDE.md / bugs.md

Добавлены 5 строк в таблицу Known Bugs:
- `sysctl -w via sudo -n` → `writeSysFile(sysctlPath, val)`
- `escHtml(null)` → `String(s || "").replace(...)`
- Modal interval race → `clearInterval` перед новым `setInterval`
- `setInterval` без ID → всегда хранить в переменной
- `tickFast()` N spawns → батч в один bash с `===M===` разделителем

### Файлы изменены

| Файл | Изменения |
|------|-----------|
| `cockpit/rusnas/js/dashboard.js` | `loadFastMetrics()`, Night Report, race fix, vnstat cache |
| `cockpit/rusnas/js/performance.js` | `sysctlPath()`, `writeSysFile()` вместо sysctl -w |
| `cockpit/rusnas/js/snapshots.js` | `_snapRefreshTimer` ID сохраняется |
| `cockpit/rusnas/dashboard.html` | Блок `#night-report` |
| `cockpit/rusnas/css/dashboard.css` | Все `.nr-*` классы + responsive |
| `bugs.md` | BUG-18 — BUG-23 |
| `CLAUDE.md` | 5 новых строк в Known Bugs |
| `btrfs-problems.md` | Создан (15 секций) |
| `project_history.md` | эта запись |

### Архитектурные заметки

- `cockpit.file(path, {superuser:"require"}).replace(val)` работает для `/proc/sys/` — не нужен sudoers
- `sysctlPath("vm.swappiness")` → `"/proc/sys/vm/swappiness"` — стандартный паттерн
- Night Report: `setTimeout(initNightReport, 800)` в DOMContentLoaded — задержка чтобы не мешать основной загрузке
- Playwright + Cockpit: 404 для статических файлов — ожидаемо, они раздаются через WebSocket bridge

---

## Сессия 2026-03-26 — UI Cohesion + Light Theme Redesign + Dark Sidebar

### Цели сессии

- Улучшить визуальную цельность UI (rusnas-ui-design skill)
- Исправить оранжевый цвет ссылок в боковом меню Cockpit
- Переработать светлую тему в корпоративный стиль
- Полное browser UI тестирование (webapp-testing skill)

### Результаты

**Ветка:** `feature/ui-cohesion-improvement` → merge в `main`

**Результат тестов:** 11/12 страниц pass, 4/4 mobile no overflow
(1 timeout на storage-analyzer — flaky, не баг кода; исправлено при retry)

### Выполненные изменения

**1. Унифицированные компоненты — `css/style.css`:**
- `Toast notifications` (.toast-container, .toast-*)
- `Skeleton loading` (.skeleton-line с shimmer анимацией)
- `Live dot` (.live-dot, .live-dot--warn/danger/gray)
- `Stagger animation` (.stagger-item с --stagger-i CSS переменной)
- `Status card` (.status-card, .status-card--ok/warn/danger/info)
- `Snapshots mobile fix` (.snap-layout overflow-x:hidden, .snap-main min-width:0)
- `Page entry animation` (body > * page-in keyframe)

**2. storage-analyzer.html — исправление Bootstrap nav-tabs:**
- Заменён `<ul class="nav nav-tabs">` на `<div class="advisor-tabs">` (обязательный паттерн Cockpit v300+)
- Обновлён `switchTab()` и event listeners в storage-analyzer.js

**3. Исправления мета-тегов:**
- Добавлен `<meta name="color-scheme" content="light dark">` в network.html, storage-analyzer.html
- Исправлены заголовки страниц (h2→h1) в ai.html, network.html, storage-analyzer.html, dedup.html
- Удалены сломанные `../base1/cockpit.css` импорты из network.html, storage-analyzer.html
- Добавлен `lang="ru"` в disks.html, index.html, users.html

**4. ai.css — 480px mobile breakpoint добавлен**

**5. branding.css — Dark Sidebar + фикс утечки оранжевого цвета:**
- Проблема: `:root { --color-link: #f5a623 }` без скопирования в `body.login-pf` утекал в боковое меню Cockpit, делая ссылки оранжевыми
- Решение: добавлена секция `body:not(.login-pf)` с PatternFly v6 оверрайдами:
  - `.pf-v6-c-page__sidebar, .pf-v6-c-nav` → `background: #1e293b` (тёмно-синий)
  - `.pf-v6-c-masthead` → `background: #0f172a`
  - `.pf-v6-c-nav__link` → `color: #cbd5e1` (читаемый белый-серый)
  - Active item: `border-left: 3px solid #3b82f6` + blue highlight
  - General links reset: `#60a5fa` вместо оранжевого

**6. style.css — Light Theme Enterprise Redesign:**
- `--bg: #eef2f7` (глубже, более характерный)
- `--color-border: #c4d0dd` (более заметная граница)
- `--card-shadow` усилен: `0 1px 4px rgba(15,23,42,0.08), 0 4px 12px rgba(15,23,42,0.06)`
- `.section` добавлен `border-top: 3px solid var(--primary)` — blue accent для enterprise-вида
- `.section h2` → uppercase + letter-spacing: 0.04em + font-size: 14px
- `h1` → font-weight: 800, letter-spacing: -0.02em, border-bottom: 2px + display:flex

### Файлы изменены

| Файл | Изменения |
|------|-----------|
| `cockpit/rusnas/css/style.css` | Новые компоненты, light theme redesign, section/h1 improvements |
| `cockpit/rusnas/css/ai.css` | 480px mobile breakpoint |
| `cockpit-branding/branding.css` | Dark sidebar overrides, fix orange link leak |
| `cockpit/rusnas/storage-analyzer.html` | advisor-tabs, meta fixes, h1 fix |
| `cockpit/rusnas/js/storage-analyzer.js` | switchTab() updated |
| `cockpit/rusnas/network.html` | color-scheme meta, h1 fix, removed cockpit.css |
| `cockpit/rusnas/ai.html` | h2→h1 fix |
| `cockpit/rusnas/dedup.html` | h1 prefix fix, removed duplicate CSS |
| `cockpit/rusnas/ups.html` | Removed duplicate CSS |
| `cockpit/rusnas/disks.html + index.html + users.html` | lang="ru" added |
| `test_rusnas_ui.py` | Created Playwright test (12 pages + 4 mobile) |
| `project_history.md` | эта запись |

### Архитектурные заметки

- `body:not(.login-pf)` — правильный способ скопировать CSS overrides для Cockpit shell (не логин страницы)
- `.pf-v6-c-nav__link.pf-m-current` — active nav item в PatternFly v6
- `border-top: 3px solid var(--primary)` на `.section` — enterprise-паттерн для Proxmox/Grafana-стиля
- Playwright evaluates outer Cockpit shell document, not iframe — тема плагина не видна для некоторых страниц (не баг)

---

## Сессия 2026-03-26 — Ghost Pill Sidebar + CSS Cascade Bug Fix

### Цель
Переработать навигацию Cockpit shell: убрать «планки» (плоские прямоугольные блоки) → внедрить «ghost pill» паттерн (Linear/Vercel/shadcn стиль).

### Диагностика

CSS cascade bug в `branding.css`:
- PF6 расставляет `aria-current="false"` **на всех** nav-ссылках (не только на активной)
- Selector `[aria-current]` совпадал со ВСЕМИ ссылками → все получали синий pill
- Дополнительно: `--pf-v6-c-nav__link--m-current--BackgroundColor` на `.pf-v6-c-nav` каскадировал на все дочерние элементы

```
link2_bg: 'rgba(37, 99, 235, 0.09)'       ← ВСЕ inactive items
link2_mCurrentVar: 'rgba(37,99,235,0.09)' ← m-current var cascades to all
```

### Исправления в `cockpit-branding/branding.css`

1. **Убраны CSS variable overrides** (`--pf-v6-c-nav__link--*`) с `.pf-v6-c-nav` — они каскадировали на все дочерние элементы
2. **Заменены selectors** `[aria-current]` → `[aria-current="page"]` (4 места: dark+light, active+hover)
3. **Ghost pill паттерн** реализован только через прямые `!important` overrides:
   - Inactive: `background: transparent` + `margin: 1px 8px` + `border-radius: 6px`
   - Hover: `rgba(255,255,255,0.07)` / `rgba(15,23,42,0.06)` для dark/light
   - Active: `rgba(59,130,246,0.14)` fill + `box-shadow: inset 3px 0 0 #3b82f6` accent bar

### Результат

- Ghost pill визуально: transparent inactive, тонкий hover, filled+accent active
- Dark sidebar: `#1a2233`, Light sidebar: `#f8fafc` (adaptive)
- Регрессия: 12/12 pass, 4/4 mobile no overflow

### Файлы изменены

| Файл | Изменения |
|------|-----------|
| `cockpit-branding/branding.css` | Ghost pill nav, CSS cascade fix, [aria-current="page"] |
| `project_history.md` | эта запись |

### Ключевые находки / архитектурные заметки

- **PF6 aria-current bug**: Cockpit PatternFly 6 ставит `aria-current="false"` на ВСЕ неактивные ссылки — attribute-selector `[aria-current]` матчит их. Правильно: `[aria-current="page"]`
- **CSS variable cascade**: `--pf-v6-c-nav__link--m-current--BackgroundColor` на `.pf-v6-c-nav` наследуется всеми потомками через CSS inheritance, даже если прямой `background: transparent !important` написан на самом элементе-ссылке
- **Решение**: Только прямые `!important` property overrides (не CSS variable переопределения на родителе)

---

## Сессия 2026-03-26 — Bootstrap Installer + License Server + Cockpit License Page

### Цель
Реализовать полную систему дистрибуции rusNAS: bootstrap-скрипт для установки, license server на VPS, страницу активации лицензии в Cockpit.

### Что было сделано (3 плана, 13 задач, 14 коммитов)

**Branch:** `feat/bootstrap-installer-spec` (не слит в main — ожидает деплоя на реальный VPS)

#### Bootstrap Installer (`bootstrap.sh`)
- Одна команда: `curl -fsSL https://activate.rusnas.ru/install | bash -s -- RUSNAS-XXXX-...`
- Preflight: root check, Debian 13 (trixie) check, serial format regex, connectivity check
- Пишет серийник в `/etc/rusnas/serial`
- Fetches install-token с license server (идемпотентно — пропускает если `license.json` уже есть)
- Настраивает apt repo: GPG keyring + sources.list + auth.conf.d
- Устанавливает `rusnas-system`
- Serial regex: `RUSNAS-[BCDFGHJKLMNPQRSTVWXYZ2345679]{4}` (без гласных, без 0/1)

#### VPS nginx конфиг (`vps-setup/nginx-rusnas.conf`)
- `/install` → статический bootstrap.sh
- `/apt/` → reprepro с nginx `auth_request` (порт 8766 apt-auth service)
- `/` → proxy_pass на FastAPI license server (порт 8765)
- 180-day grace period через apt-auth service

#### rusNAS License Server (`rusnas-license-server/`)
Полностью реализован. **22/22 тестов проходят**.

| Файл | Назначение |
|------|-----------|
| `crypto.py` | Ed25519 sign/verify, Base62, RNAC formatting |
| `db.py` | aiosqlite CRUD: serials, licenses, activations, audit_log |
| `models.py` | Pydantic v2, serial validation regex |
| `server.py` | FastAPI: `/api/activate`, `/api/status`, `/api/install-token`, `/admin/*` |
| `apt_auth.py` | nginx auth_request — grace period + per-component gating |
| `admin.py` | CLI: serial add/import/list, license create/show/revoke, gen-code, report |
| `keygen.py` | Генератор ключевой пары Ed25519 оператора |
| `admin_web.py` | FastAPI router `/admin/*` (Jinja2 server-rendered) |
| `static/activate.html` | Customer activation portal (no CDN, dark theme) |
| `static/admin/*.html` | 6 Jinja2 templates: base, dashboard, serials, licenses, new, detail |
| `rusnas-license.service` | systemd unit для uvicorn server (порт 8765) |
| `rusnas-apt-auth.service` | systemd unit для apt-auth (порт 8766) |
| `.env.example` | Конфиг шаблон |
| `pytest.ini` | asyncio_mode=auto (требуется для pytest-asyncio ≥1.3) |

**Ключевые архитектурные решения:**
- Offline activation: устройство **никогда** не обращается к серверу напрямую. Только пользователь copy-pastes RNAC-код
- apt-auth Grace period: 180 дней с первой установки все пакеты доступны без лицензии
- Install token идемпотентен: `first_install_at` пишется только один раз (не перезаписывается)
- RNAC формат: `RNAC-\n` + 8 блоков по 5 символов в строке
- apt-auth: два компонента — `main` (требует `updates_features`) и `security` (требует любую активную лицензию)

**Operator public key** (Ed25519 raw, base64):
```
1d6UQHGzNP3wZPQVFpXUkc5qF+5UAyQlrUMSQAffdA0=
```
Файл: `rusnas-license-server/operator_public.pem` (уже в репо)
Private key: `rusnas-license-server/operator_private.pem` (в `.gitignore` — только на VPS)

#### Cockpit License Page (`cockpit/rusnas/`)
- `license.html` — статус-карточка + textarea для RNAC-кода
- `js/license.js` — полный Ed25519 в браузере через WebCrypto API (`crypto.subtle.importKey`, `Ed25519`)
- Пишет `/etc/rusnas/license.json` и `/etc/apt/auth.conf.d/rusnas.conf` через `cockpit.file superuser`
- Задеплоено на VM 10.10.10.72, серийник `/etc/rusnas/serial` = `RUSNAS-TEST-BCDF-GHJK-LMNP`
- Добавлено в `manifest.json` как "Лицензия 🔑" (order 13)

### Что ещё нужно сделать перед продакшн-деплоем

1. **Настроить реальный VPS**: DNS `activate.rusnas.ru` → IP VPS, certbot TLS, useradd rusnas-license
2. **Создать apt репозиторий**: reprepro + nginx + собрать deb-пакет `rusnas-system`
3. **Ansible role**: разложить `operator_public.pem` на устройства в `/etc/rusnas/`
4. **Инициализация БД на VPS**: `python3 admin.py serial add ...` для первой партии серийников
5. **MCP Session 2**: SSE-стриминг, Ollama integration (отдельная ветка)

### Файлы изменены

| Файл | Изменения |
|------|-----------|
| `rusnas-license-server/` | Новый модуль — полная реализация license server |
| `bootstrap.sh` | Новый — one-command installer |
| `vps-setup/nginx-rusnas.conf` | Новый — nginx конфиг для VPS |
| `vps-setup/README.md` | Новый — инструкция по деплою |
| `cockpit/rusnas/license.html` | Новый — страница активации |
| `cockpit/rusnas/js/license.js` | Новый — Ed25519 WebCrypto активация |
| `cockpit/rusnas/manifest.json` | +license page entry |
| `.gitignore` | Добавлены .worktrees/, node_modules, playwright-mcp |
| `project_history.md` | эта запись |

### Архитектурные заметки

- **WebCrypto Ed25519**: `{ name: "Ed25519" }` работает в Chromium 113+ и Firefox 129+. Cockpit использует Chromium-based WebView — поддерживается
- **Base62 в JS**: BigInt обязателен для ~350-символьных строк (> Number.MAX_SAFE_INTEGER)
- **pytest-asyncio ≥1.3**: требует `asyncio_mode = "auto"` в pytest.ini — иначе async fixtures не работают (STRICT mode по умолчанию)
- **FastAPI `@app.on_event("startup")`**: deprecated в пользу `lifespan`, но работает. Предупреждения при тестах — не ошибки
- **python-multipart**: обязателен для FastAPI Form() endpoints — не включён в fastapi по умолчанию
- **TemplateResponse в Starlette 1.0+**: первый аргумент — `request`, не в словаре контекста

---

## Session 2026-03-28: RAID Backup Mode (HDD Spindown) Implementation

**Branch:** `feat/raid-backup-mode` (not yet merged to main)

**Goal:** Implement automatic RAID spindown for backup NAS use-case

### What was implemented

**Backend daemon (rusnas-spind/):**
- `monitor.py` — SpindownMonitor: reads /proc/diskstats, state machine active→flushing→standby→waking→active
- `controller.py` — SpinController: wraps hdparm (dry_run mock for QEMU VM)
- `btrfs_helper.py` — BtrfsFlusher: commit_min=0 + sync + restore_commit
- `mdadm_helper.py` — suppress_check/restore_check, get_member_disks, get_mountpoint
- `state_writer.py` — atomic JSON writes for state.json and totals.json
- `spind.py` — main daemon: do_spindown/do_wakeup, adaptive polling (15s/3s), SIGHUP/SIGTERM

**Backend CGI:**
- `cockpit/rusnas/cgi/spindown_ctl.py` — 5 commands: get_state, get_config, set_config, wake_up, spindown_now

**UI:**
- `cockpit/rusnas/js/disks.js` — Backup Mode panel per array, _warnIfSleeping guard in expand/replace/umount/subvol
- `cockpit/rusnas/js/dashboard.js` — spindown state sub-line per RAID card

**Monitoring:**
- `rusnas-metrics/metrics_server.py` — 5 new Prometheus metrics: rusnas_spindown_state, wakeup_count_total, idle_timeout_minutes, backup_mode_enabled, last_standby_seconds

**Deploy:**
- `install-spindown.sh` — deploys daemon, CGI, hdparm, config, sudoers, systemd unit

**Tests:**
- `tests/test_backup_mode_ui.py` — 15 Playwright tests, all passing on live VM

### Key architectural decisions
- Dry-run mode (--dry-run flag) for QEMU VM where hdparm Y is no-op
- suppress_check: writes `idle` to /sys/block/mdX/md/sync_action to prevent RAID check during sleep
- Atomic state writes via .tmp → os.replace()
- wakeup_count_total persisted across daemon restarts in /var/lib/rusnas/spindown_totals.json
- _iso() uses datetime.fromtimestamp().astimezone().isoformat(timespec="seconds") for correct timezone

### Files changed
| File | Change |
|------|--------|
| `rusnas-spind/monitor.py` | NEW — SpindownMonitor state machine |
| `rusnas-spind/controller.py` | NEW — SpinController + dry-run |
| `rusnas-spind/btrfs_helper.py` | NEW — BtrfsFlusher |
| `rusnas-spind/mdadm_helper.py` | NEW — mdadm helpers |
| `rusnas-spind/state_writer.py` | NEW — atomic state writes |
| `rusnas-spind/spind.py` | NEW — main daemon |
| `rusnas-spind/rusnas-spind.service` | NEW — systemd unit |
| `cockpit/rusnas/cgi/spindown_ctl.py` | NEW — CGI interface |
| `cockpit/rusnas/js/disks.js` | MODIFIED — Backup Mode UI + _warnIfSleeping |
| `cockpit/rusnas/js/dashboard.js` | MODIFIED — spindown sub-line per RAID card |
| `rusnas-metrics/metrics_server.py` | MODIFIED — 5 new Prometheus metrics |
| `install-spindown.sh` | NEW — deploy script |
| `tests/test_backup_mode_ui.py` | NEW — 15 Playwright UI tests |
| `docs/superpowers/plans/2026-03-28-raid-backup-mode.md` | NEW — implementation plan |
| `CLAUDE.md` | UPDATED — Backup Mode section + roadmap |
| `project_history.md` | this entry |

### Test results (2026-03-28)
```
RESULTS: 15 PASS  0 FAIL
```
All 15 Playwright UI tests passed on live VM (10.10.10.72) with daemon in --dry-run mode.

---

## Session 2026-03-28-C: Storage Analyzer UI Redesign

**Date:** 2026-03-28
**Branch:** main

### Goal
Redesign the Storage Analyzer overview tab to match a macOS-inspired mockup: window chrome header with traffic lights, underline-style tab navigation, fill bar, squarified treemap of top consumers, and 4 stat boxes (ЗАНЯТО / СВОБОДНО / ЗАПОЛНЕНО / ЗА НЕДЕЛЮ).

### Changes made

**cockpit/rusnas/storage-analyzer.html:**
- Replaced old `.sa-page-header` with `.sa-window-chrome` containing macOS-style traffic lights (red/yellow/green dots) + "АНАЛИЗАТОР ПРОСТРАНСТВА" title
- SVG icon buttons for Настройки and Сканировать (no emoji)
- Replaced `advisor-tabs` with `.sa-tabs-row` + `.sa-tab-btn` underline-style tabs
- Replaced Overview tab content: old 4-card grid + volume map + fill chart + top consumers → new fill bar + treemap + 4 stat boxes
- Hidden elements added for backward-compat with legacy JS element IDs (volumesGrid, fillChartWrap, topConsumers, etc.)

**cockpit/rusnas/css/storage-analyzer.css:**
- Added: `.sa-window-chrome`, `.sa-chrome-left/right`, `.sa-traffic-lights`, `.sa-tl`, `.sa-chrome-title`
- Added: `.sa-tabs-row`, `.sa-tab-btn` (underline style with blue active border)
- Added: `.sa-fill-bar-card`, `.sa-fill-bar-label/track/fill/forecast`
- Added: `.sa-overview-treemap-wrap`, `.sa-otm-svg`
- Added: `.sa-stat-boxes`, `.sa-stat-box`, `.sa-stat-val`, `.sa-stat-lbl`, `.sa-stat-blue/green/amber/purple`
- Responsive breakpoints for stat boxes (2-col at 700px, 1-col at 480px)

**cockpit/rusnas/js/storage-analyzer.js:**
- Added local `escHtml(s)` definition (BUG-31 fix — eye.js scope isolation)
- Updated `switchTab()`: `.advisor-tab-btn` → `.sa-tab-btn`
- Updated DOMContentLoaded selector: `.advisor-tab-btn` → `.sa-tab-btn`
- Updated `renderOverviewCards()`: now fills fill bar label/fill/forecast + new stat boxes (statUsed/statFree/statPct/statWeekGrowth); legacy hidden elements also updated for compat
- Added `OTM_COLORS` palette (7 dark muted colors for treemap tiles)
- Added `renderOverviewTreemap(consumers)`: SVG squarified treemap using existing `squarify()` function; tile name + size labels; truncates long names per tile width
- Updated `loadOverview()`: calls `renderOverviewTreemap()` + null guards on `scanAge`/`scanDuration` elements; improved error handling with `escHtml`

### Bug found and fixed
- **BUG-31**: `escHtml` not defined in `storage-analyzer.js` scope — Cockpit iframe sandbox isolates script tag globals. Fixed by adding local copy of `escHtml()`.

### Test results (Playwright)
- Traffic lights: 3 ✅
- Underline tab buttons: 5 ✅
- Fill bar rendered with correct width (9%) ✅
- Stat boxes: 4 (1.9 ГБ / 19.0 ГБ / 9% / +0 Б) ✅
- Treemap SVG rendered (1392×340, indigo tile "documents2 / 1.8 ГБ") ✅
- Tab switching functional (Шары tab → overview tab) ✅
- No page errors after BUG-31 fix ✅

### Files modified
- `cockpit/rusnas/storage-analyzer.html`
- `cockpit/rusnas/css/storage-analyzer.css`
- `cockpit/rusnas/js/storage-analyzer.js`
- `bugs.MD` (BUG-31 added)
- `project_history.md` (this entry)

## Session 2026-03-28-D: Container Manager Landing Page Section

**Date:** 2026-03-28
**Branch:** main

### Changes made:
- Added Container Manager marketing section to `landing/index.html` (before CTA)
  - Architecture diagram SVG: Browser → nginx proxy → Podman (rootless) → Btrfs volume
  - App catalog grid: 10 apps (Nextcloud, Immich, Jellyfin, Vaultwarden, Home Assistant, Pi-hole, WireGuard, Mailcow, OnlyOffice, Rocket.Chat) + custom compose slot
  - 4 usage scenario cards: Домашний офис / Малый бизнес / Медиасервер / Сетевая безопасность
  - 3-step deploy infographic
  - Inline CSS with `--blue` accent (#5B9BF8), dark background, SVG icons (no emoji)
  - Fully responsive: 5→4→3→2→1 column breakpoints for app grid

### Files modified:
- `landing/index.html` — new `<section id="containers" class="cm-section">` with inline `<style>`

### Testing:
- Deployed to VM via `./deploy-landing.sh`
- Playwright: #containers FOUND, 11 apps rendered, 4 scenarios, 3 steps
- Visual check: screenshots at /tmp/lp_cm_0{1,2,3}.png — layout correct

---

## Session 2026-03-28 (Session 16) — Container Manager Module

### Branch: feat/container-manager → merged to main

### What was done:
Container Manager Cockpit plugin page — full implementation across 11 tasks via subagent-driven development.

### New files:
- `cockpit/rusnas/containers.html` — 3-tab page (Catalog / Installed / Custom)
- `cockpit/rusnas/css/containers.css` — app-card grid, install modal, progress UI
- `cockpit/rusnas/js/containers.js` — all page logic (706 lines)
- `cockpit/rusnas/cgi/container_api.py` — CGI backend (14 commands)
- `cockpit/rusnas/catalog/index.json` — 10-app catalog index
- `cockpit/rusnas/catalog/*/rusnas-app.json` + `docker-compose.yml` — 10 apps: nextcloud, immich, jellyfin, vaultwarden, home-assistant, pihole, wireguard, mailcow, onlyoffice, rocketchat
- `install-containers.sh` — VM deploy script
- `tests/test_container_api.py` — 12 CGI unit tests
- `tests/test_container_metrics.py` — 2 metrics tests
- `tests/test_containers_ui.py` — 5 Playwright UI tests

### Modified files:
- `cockpit/rusnas/manifest.json` — added "containers" entry (order 55)
- `cockpit/rusnas/js/dashboard.js` — container count widget + click nav
- `cockpit/rusnas/dashboard.html` — db-containers-card added
- `rusnas-metrics/metrics_server.py` — collect_containers() (count by status, CPU/RAM per container)

### Architecture:
- CGI pattern: `container_api.py` called via `cockpit.spawn(["sudo","-n","python3",CGI,cmd,...])`
- Rootless Podman as `rusnas-containers` user (separate system user, subuid/subgid)
- Compose templates: `{{VAR:-default}}` substitution, network `rusnas-<appid>`, containers `rusnas-<appid>-<role>`
- nginx location blocks auto-generated per app at `/var/lib/rusnas-containers/nginx-apps/`
- Sudoers: `rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/cgi/container_api.py *`

### Tests: 14/14 unit + 5/5 Playwright UI (all passing)

### Key bugs fixed during development:
- rocketchat: MONGO_URL must use service key name (`rocketchat-mongo`), not container_name
- home-assistant: `install_params` had `web_port` but compose uses `network_mode: host` — removed
- nextcloud: `db_password` added to `install_params` with `generate: true`
- haiku model delivered Task 4 claiming DONE without writing files — re-dispatched with sonnet

---

## Session 17 — 2026-03-28: nginx Primary Web Server + Container Port Conflict Detection

### Goals:
- Resolve port conflict issue with Apache occupying :80 (blocked container apps)
- Make nginx the single public entry point for all web traffic
- Add port conflict detection before container install
- Create webservice.md as authoritative web services architecture doc

### Problem solved:
Container Manager assumed nginx on :80, but Apache was there. OnlyOffice showed "stopped" and clicking "Открыть" gave Apache 404 because nginx proxy configs were being written but not used.

### Architecture changes:

**Before:**
- Apache: :80 (landing, FileBrowser proxy, WebDAV)
- nginx: not active on :80

**After (nginx-primary):**
- nginx: :80 (landing static, proxy to Cockpit :9090, FileBrowser :8088, WebDAV Apache :8091, container apps)
- Apache: 127.0.0.1:8091 (WebDAV only, internal)
- FileBrowser: 127.0.0.1:8088 (unchanged)
- Container apps: 127.0.0.1:8090–8999 (via nginx /etc/nginx/conf.d/rusnas-apps/)

### Modified files:
- `cockpit/rusnas/cgi/container_api.py`:
  - `NGINX_APPS_DIR` → `/etc/nginx/conf.d/rusnas-apps/` (was `/var/lib/rusnas-containers/nginx-apps/`)
  - Added `port_is_free(port)` via `socket.bind()`
  - Added `next_free_port(start, end)`
  - Added `cmd_check_ports` command (new API endpoint)
  - `generate_nginx_proxy` → `generate_proxy_config` (uses new dir)
  - `cmd_install`: port conflict check before starting containers; stores `proxy_url`, `direct_url`, `proxy_active` in installed.json
  - `cmd_uninstall`: only reloads nginx if conf file existed
- `cockpit/rusnas/js/containers.js`:
  - Install modal: port inputs get live availability indicator (✓/✗)
  - Auto-fill suggested free port after 1.5s if current port taken
  - `renderInstalled`: prefer `proxy_url` field over `nginx_path` concat
- `webservice.md` (new): full architecture doc — nginx routes, Apache internal, FileBrowser, Cockpit, container ports
- `install-nginx-primary.sh` (new): migration script (installs nginx, moves Apache to :8091, sudoers)
- `CLAUDE.md`: mandatory reference to webservice.md + updated Container Manager notes

### VM changes applied:
- nginx enabled and started on :80/:443
- Apache moved to 127.0.0.1:8091 (all VirtualHost *:80 → 127.0.0.1:8091)
- `/etc/nginx/sites-available/rusnas.conf` written
- `/etc/nginx/conf.d/rusnas-apps/` created
- `/etc/sudoers.d/rusnas-nginx` created
- rusnas-filebrowser.conf nginx site disabled (replaced by rusnas.conf)

### Verification:
- `http://10.10.10.72/` → 200 (landing)
- `http://10.10.10.72/files/` → 200 (FileBrowser)
- `http://10.10.10.72/webdav/` → 403 (WebDAV, expected, needs auth)
- All services active: nginx + apache2 + rusnas-fb + cockpit

---

## Сессия N — Comprehensive Container Manager Testing (2026-03-28)

### Что сделано:
Comprehensive automated testing of ALL Container Manager functions (CGI backend + Playwright frontend). Found and fixed 1 critical bug.

### Bug found and fixed:

**BUG-32 — container_api.py: get_catalog не включает name/description/install_params из манифестов**
- `cmd_get_catalog()` читал только `catalog/index.json`, который содержит лишь `id`, `category`, `featured`
- Индивидуальные манифесты `catalog/<appid>/rusnas-app.json` с `name`, `description`, `install_params`, `default_port` и т.д. **не мерджились**
- Следствия:
  1. Карточки каталога показывали app ID вместо человекочитаемых названий (e.g. "nextcloud" вместо "Nextcloud")
  2. Модал установки не имел полей формы (password, port) — `install_params` было пустым массивом
  3. Нельзя было установить ни одно приложение корректно
- **Fix:** `cmd_get_catalog()` теперь для каждого entry из `index.json` читает `<appid>/rusnas-app.json` и мерджит данные (`{**manifest, **index_entry}` — index entry перекрывает manifest для `id`/`category`/`featured`)
- **Файл:** `cockpit/rusnas/cgi/container_api.py`

### Test results:
- Backend CGI: **17/17 passed**
- Frontend Playwright UI: **45/45 passed**
- Edge cases: **6/6 passed**
- **Total: 68/68 passed**

### Test file created:
- `/Users/dvl92/projects/RusNAS/tests/test_containers_comprehensive.py`

### Modified files:
- `cockpit/rusnas/cgi/container_api.py` — fix `cmd_get_catalog()` to merge individual manifests
- `tests/test_containers_comprehensive.py` — new comprehensive test suite (68 tests)

---

## Session 2026-03-29 — Rocket.Chat nginx sub-path fix + container image cleanup

### Goal
Починить Rocket.Chat (устанавливается через Container Manager, открывается через `/chat/`).

### Problems solved

**1. Образы контейнеров не удаляются при uninstall**
`cmd_uninstall()` удалял compose dir и data dir, но не удалял образы из `/mnt/data/containers/storage`. После нескольких установок/удалений образы занимали ~10GB. Фикс: добавлен `podman image prune -af` после `podman-compose down --volumes`.

**2. Rocket.Chat не запускался (no container found)**
Контейнер падал при старте. Причины: MongoDB 6.x несовместим с Rocket.Chat 8.x (нужен `mongo:8`), aardvark-dns не работает на второй podman-сети. Фикс: `mongo:8`, `network_mode: host`, `MONGO_URL=mongodb://localhost:27017/...?directConnection=true`.

**3. Rocket.Chat "Unknown path" (один nginx location блок)**
С `proxy_pass http://host:3000/;` (trailing slash) nginx стриппал `/chat/` → RC получал `/` → "Unknown path" (RC с ROOT_URL=/chat обслуживает только `/chat/`). С `proxy_pass http://host:3000;` (без slash) страница грузилась, но API возвращало HTML.

**Архитектурное открытие:** Rocket.Chat с ROOT_URL=`http://host/chat`:
- SPA и assets → на `/chat/*` (Meteor catch-all)
- REST API → на `/api/v1/*` (без sub-path prefix), НЕ `/chat/api/v1/*`
- sockjs → на `/chat/sockjs/*` (как SPA)
- WebSocket → на `/websocket` (без prefix)

**Решение — 3 nginx location блока:**
```
location ~ ^/chat/api/   → rewrite /chat → /   (API без prefix)
location /chat/websocket → rewrite /chat → / + WS headers
location /chat/          → без rewrite           (SPA+assets+sockjs)
```

**4. Site_Url в MongoDB перезаписывает ROOT_URL**
После рестарта RC читает `Site_Url` из MongoDB и игнорирует env var. При первой установке `Site_Url` был `http://localhost:3000` из прошлого запуска. Фикс: при изменении ROOT_URL — обновлять и БД через mongosh. В `cmd_install()` для rocketchat добавлено обновление Site_Url после rs.initiate.

### Files changed
- `cockpit/rusnas/cgi/container_api.py` — `generate_proxy_config()`: поддержка 3-блочного nginx для RC; `cmd_uninstall()`: `podman image prune -af`; ROOT_URL derivation in `cmd_install()`
- `cockpit/rusnas/catalog/rocketchat/docker-compose.yml` — mongo:8, network_mode: host, directConnection=true
- `cockpit/rusnas/catalog/rocketchat/rusnas-app.json` — `nginx_strip_prefix: false`, `nginx_websocket: true`
- `CLAUDE.md` — секция Rocket.Chat nginx sub-path, новые баги в Known Bugs

---

## Session 2026-03-31 / 2026-04-01 — Sidebar Redesign + Dashboard Performance Charts + Perf Collector Daemon

### Goal
Полный редизайн навигации Cockpit (стиль Tatlin/YADRO), замена спарклайн-карточек дашборда на Chart.js графики с историей, backend daemon сбора метрик производительности.

### 1. Sidebar Navigation Redesign
- Убраны эмодзи-иконки из `manifest.json` labels
- Добавлены 22 монохромных Heroicons (outline SVG) через CSS `mask-image` в `branding.css`
- Исправлен `justify-content: space-between` → `flex-start` для корректного выравнивания текста
- Иконки для всех системных страниц Cockpit (Обзор, Журналы, Хранилище-system, Сеть-system и др.)

### 2. Collapsible Nav Groups (стиль Tatlin/YADRO)
- Реализовано в `eye.js` (работает из iframe плагина, управляет DOM родительского shell)
- 4 группы: Хранилище, Защита данных, Инфраструктура, Мониторинг
- Chevron-стрелки, анимация collapse/expand
- Состояние сохраняется в `localStorage`
- Группа активной страницы авто-раскрывается
- DOM-реордеринг для соответствия логическим группам

### 3. Alert Badges на nav-группах
- Реал-тайм polling каждые 30 секунд из `eye.js`
- Проверки: RAID degraded (`/proc/mdstat`), Guard events (`events.jsonl`), UPS на батарее (`upsc`)
- Оранжевый badge = warning, красный = danger
- Badge исчезает когда проблем нет

### 4. Dashboard Performance Charts (стиль Tatlin)
- Заменены старые sparkline-карточки (CPU/RAM/Net/Disk I/O) на 6 графиков Chart.js 4.x
- Графики: CPU%, RAM%, Network KB/s, Disk I/O MB/s, IOPS, Latency ms
- Селектор периода: 5 MIN / 15 MIN / 30 MIN / 1 HOUR / 24H
- Тултипы с точными значениями + timestamps при наведении
- Легенда с цветными маркерами (Read=blue, Write=green)
- Кнопка (i) на CPU/RAM/Net карточках — детальные модалы
- Кнопка (expand) — full-screen chart modal

### 5. Backend Performance Collector Daemon (perf-collector.py)
- Новый systemd daemon (не таймер): `rusnas-perf-collector.service`
- Собирает CPU/RAM/Net/Disk метрики каждые 10 секунд из `/proc`
- Пишет в `/var/lib/rusnas/perf-history.json` каждые 2 минуты (atomic rename)
- 24ч retention с автоматическим downsampling (raw 10s → 30s → 120s)
- Ресурсы: ~3 MB RAM, <0.5% CPU, MemoryMax=32M в systemd
- Dashboard.js ТОЛЬКО читает файл (никакого сбора данных в браузере)

### 6. Critical Architecture Rule (добавлено в CLAUDE.md)
- Cockpit = ТОЛЬКО отображение, НИКОГДА сбор/обработка данных
- Все метрики собираются в backend (Python daemon + systemd)
- `cockpit.file()` НЕ используется для больших данных (вызывает раздувание RAM cockpit-bridge)

### 7. Прочие фиксы
- ESC key закрывает все модалы (глобальный handler в `eye.js`)
- Исправлено выравнивание donut chart в `storage-analyzer.css`
- Исправлено выравнивание radio buttons в `disks.html`

### Files changed
- `cockpit/rusnas/manifest.json` — убраны эмодзи из label
- `cockpit/rusnas/css/branding.css` — 22 SVG-иконки через mask-image, nav group styles
- `cockpit/rusnas/js/eye.js` — collapsible nav groups, alert badges polling, ESC handler
- `cockpit/rusnas/js/dashboard.js` — Chart.js 4.x графики, period selector, detail/expand modals
- `cockpit/rusnas/dashboard.html` — новая разметка графиков, Chart.js CDN
- `cockpit/rusnas/css/dashboard.css` — стили для Chart.js карточек, модалов, period selector
- `cockpit/rusnas/css/storage-analyzer.css` — donut chart alignment fix
- `cockpit/rusnas/disks.html` — radio button alignment fix
- `rusnas-perf-collector/perf-collector.py` — новый daemon сбора метрик
- `rusnas-perf-collector/rusnas-perf-collector.service` — systemd unit
- `install-perf-collector.sh` — install script
- `claude.MD` — архитектурное правило "Cockpit = only display"

### Architecture notes
- `perf-collector.py` пишет данные в `/var/lib/rusnas/perf-history.json` каждые 2 минуты
- Dashboard JS читает этот файл через `cockpit.spawn(["cat", "/var/lib/rusnas/perf-history.json"])`
- Downsampling: raw (10s, last 5min) → medium (30s, 5-60min) → coarse (120s, 1-24h)
- Dashboard spec file exists: `rusnas-dashboard-spec.md`

---

## Session 2026-03-31: Penetration Test + Security Self-Test

### Что сделано

1. **Ручной пентест rusNAS (OWASP Top 10)**
   - Полный пентест VM 10.10.10.72 с использованием nmap, nuclei, ffuf, sqlmap, curl
   - Обнаружено 9 findings: 1 critical, 2 high, 3 medium, 3 low
   - Critical: FileBrowser admin/admin с root filesystem scope
   - High: NFS export `*`, SMB anonymous access
   - Отчёт: `pentest-report-2026-03-31.md`

2. **Скил web-pentest создан** (для skill-creator)
   - SKILL.md + references/owasp-top10-checks.md
   - 4 фазы: Recon → OWASP Testing → Automated Scan → Report

3. **Security Self-Test (rusnas-sectest/)**
   - Автоматизированный пентест сборки rusNAS
   - 9 модулей проверок (47+ checks в quick mode)
   - Оркестратор sectest.py: --quick, --json, --category
   - Scoring: 0-100, Grade A-F
   - systemd timer: monthly (1-е число, 04:00)
   - Dashboard интеграция: карточка "🔒 БЕЗОПАСНОСТЬ" + alert banner
   - Output: JSON state + Markdown report + .log

4. **Установка pentest-инструментов на Mac**
   - nmap, nuclei v3.7.1, ffuf v2.1.0, sqlmap 1.10.3, httpx v1.9.0, seclists

### Files created
- `rusnas-sectest/sectest.py` — orchestrator (530 lines)
- `rusnas-sectest/checks/recon.py` — port scan, service detection
- `rusnas-sectest/checks/web_headers.py` — TLS, security headers
- `rusnas-sectest/checks/access_control.py` — NFS, SMB, rsync, FTP, FileBrowser
- `rusnas-sectest/checks/auth.py` — default creds, JWT, rate limiting
- `rusnas-sectest/checks/injection.py` — SQLi, XSS, SSTI
- `rusnas-sectest/checks/misconfig.py` — directory listing, TRACE, CORS
- `rusnas-sectest/checks/vuln_scan.py` — nuclei templates
- `rusnas-sectest/checks/endpoint_fuzz.py` — ffuf discovery
- `rusnas-sectest/checks/network_services.py` — SMB signing, Samba config
- `rusnas-sectest/wordlists/rusnas-paths.txt` — 110+ paths
- `rusnas-sectest/rusnas-sectest.service` + `.timer`
- `rusnas-sectest/README.md` + `rusnas-sectest-task.md`
- `install-sectest.sh` — deploy + tool install
- `pentest-report-2026-03-31.md` — ручной пентест отчёт

### Files changed
- `cockpit/rusnas/dashboard.html` — карточка Security
- `cockpit/rusnas/js/dashboard.js` — sectest polling, run, report functions
- `cockpit/rusnas/css/dashboard.css` — sectest badge/summary styles
- `deploy.sh` — quick sectest after deploy
- `CLAUDE.md` — sectest reference, roadmap, project structure

---

## Session: 2026-04-03 — Demo Release (.deb installer)

**Ветка:** `feat/demo-release` → merged в `main`
**VM:** 10.10.10.31 (чистый Debian 13 Trixie)

### Что сделано

1. **build-deb.sh** — скрипт сборки .deb пакета
   - JS минификация через terser (15 файлов → `.min.js`)
   - Vendor JS (Chart.js) копируется as-is, HTML ссылки переписываются корректно
   - Удалённая сборка через `BUILD_HOST`/`BUILD_USER`/`BUILD_PASS` (macOS не имеет dpkg-deb)
   - Удаление macOS `._*` metadata перед tar (`COPYFILE_DISABLE=1`)

2. **demo-install.sh** — установщик для чистого Debian 13
   - Preflight: проверка root, Debian 13, наличие .deb
   - Network detection: интерфейс, IP, gateway, DHCP/static
   - Port checks: 80, 9090, 8091 — предупреждение если заняты
   - Interactive confirmation [Y/n]
   - Установка ~100 apt-пакетов + dpkg -i (--force-overwrite для branding.css)
   - Создание пользователя rusnas, demo-лицензия (Enterprise, all features)
   - nginx primary (:80), Apache (:8091), Cockpit (:9090), /help/ docs

3. **pkg/DEBIAN/** — метаданные Debian пакета
   - control: Depends + Recommends
   - postinst: dirs, permissions, systemctl enable
   - prerm: stop services
   - conffiles: protect /etc/rusnas-guard/

4. **User documentation** — MkDocs Material site включен в пакет
   - 32 markdown-страницы, 36 скриншотов, тёмная тема
   - Доступна по `http://<IP>/help/`

5. **Favicon + Logo** — SVG NAS drive bay icon
   - Добавлен во все 14 HTML-страниц Cockpit
   - Добавлен в landing page

6. **Landing page offline** — убраны CDN зависимости
   - Шрифт Manrope self-hosted (5 weights, landing/fonts/)
   - TMX logo заменён на text span
   - Ноль внешних URL

7. **docs/build-guide.md** — полное руководство по сборке и установке

### Найденные и исправленные проблемы

- macOS `._*` metadata файлы в tar → ломают dpkg-deb на Linux → `COPYFILE_DISABLE=1` + `find -delete`
- `su -c` не наследует PATH с /usr/sbin → `export PATH=...` в начале скриптов
- branding.css конфликт с cockpit-ws → `dpkg --force-overwrite`
- `python3-inotify` не ставился → Guard daemon crash loop → добавлен в deps
- Chart.js vendor `.min.js` двойная минификация → placeholder-based sed rewrite
- `sudo` может быть не предустановлен на minimal Debian → добавлен в Depends

### Ключевые файлы

- `VERSION` — 1.0.0-demo
- `build-deb.sh` — сборка пакета
- `demo-install.sh` — установщик
- `pkg/DEBIAN/` — метаданные пакета
- `docs/build-guide.md` — руководство по сборке
- `cockpit/rusnas/assets/` — favicon.svg, logo.svg
- `landing/fonts/` — Manrope TTF (5 weights)
- `landing/favicon.svg`

---

## Сессия 2026-04-04 (вечер) — Fix: Dashboard perf charts full history

**Задача:** Графики производительности на дашборде показывали данные только за последние 15 минут вместо полного аптайма системы (6+ часов).

**Root cause:** 3 связанных проблемы:
1. Дефолтное окно `_perfMinutes = 15` — графики показывали только последние 15 минут
2. `GAP_MS = 30000` (30с) разрывал линию на даунсэмпленных данных (120-180с интервалы)
3. Жёсткий `y.max = 100` для CPU/RAM делал низкие значения (2-5%) невидимыми

**Что сделано:**
- Авто-определение периода при первой загрузке (`_perfAutoFitted` flag)
- Clamp xMin к первой точке данных — убирает пустое пространство слева
- GAP_MS увеличен до 600000 (10 мин) — непрерывные линии
- Убран жёсткий `y.max = 100` для CPU/RAM — авто-масштаб Chart.js
- Те же фиксы применены к expand-модалу графиков

**Изменённые файлы:**
- `cockpit/rusnas/js/dashboard.js` — perfReload(), _updCh(), updatePerfCharts(), _renderExpandChart()

**Ветка:** `claude/keen-pare` → merged в `main`

### RAM Monitor Modal (та же сессия)

**Задача:** Кнопка (i) на графике RAM открывала тот же CPU-модал. Нужен отдельный модал с подробной информацией о памяти.

**Что сделано:**
- Новый RAM-модал (`#ram-modal`) с тремя секциями:
  - 📊 Разбивка памяти: stacked bar + breakdown bars (Приложения/Буферы/Кеш/Shared/Slab/Свободно)
  - 📋 Статистика: 12+ метрик из `/proc/meminfo` (Available, Free, Dirty, Writeback, Page Tables, Slab recl/unrecl, Swap, HugePages)
  - 🏋️ Топ 15 процессов по RSS: PID, имя, RSS, %MEM, VSZ
- Кнопка (i) на RAM-графике теперь `data-modal="ram"` → `openRamModal()`
- Обновление каждые 2 секунды (RAM меняется медленнее CPU)
- Responsive: на мобильном скрываются колонки VSZ и %MEM

**Изменённые файлы:**
- `cockpit/rusnas/dashboard.html` — новый `#ram-modal` HTML, `data-modal="ram"` на кнопке
- `cockpit/rusnas/js/dashboard.js` — `openRamModal()`, `closeRamModal()`, `refreshRamModal()`, `renderRamModal()`, обработчик клика
- `cockpit/rusnas/css/dashboard.css` — `.rm-*` стили (stacked bar, legend, stat grid, proc table)
