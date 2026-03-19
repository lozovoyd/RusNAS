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
