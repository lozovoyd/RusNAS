rusNAS — История разработки проекта

Хронология ключевых решений и результатов по всем чат-сессиям проекта.
Передаётся в Claude Code вместе с CLAUDE.md для полного контекста.


Сессия 1 — Архитектура и ТЗ
Дата: февраль 2026
Чат: Создание собственного NAS на базе TrueNAS
Что было сделано

Определили бизнес-модель: коммерческий NAS для SMB-клиентов, собственное железо, 1000+ устройств
Выбрали функциональный ориентир: Synology RS1619xs+
Сформировали полный технический стек
Создали Word-документ с ТЗ

Ключевые архитектурные решения
ZFS vs Btrfs:
Изначально рассматривали ZFS как enterprise-решение. Отказались потому что ZFS не поддерживает online миграцию уровня RAID (например RAID5 → RAID6 без пересоздания). Это hard requirement бизнес-модели — клиент должен мочь расширить массив без downtime. Финальный выбор: Btrfs + mdadm.
Веб-интерфейс: Cockpit (быстро, готовый) → свой UI потом
Обновления: Кастомный deb-репозиторий (reprepro + nginx), устройства pull через apt upgrade по расписанию
Итоговый стек
ОС:           Debian (начали с 12, перешли на 13 Trixie)
RAID:         mdadm — Basic, JBOD, RAID 0/1/5/6/10, RAID F1
ФС:           Btrfs (снапшоты, online resize)
SMB:          Samba
NFS:          knfsd
FTP:          vsftpd
WebDAV:       Apache
Rsync:        rsync daemon
AFP:          запланировано
iSCSI:        targetcli-fb (LIO)
AD:           winbind / sssd
Веб-UI:       Cockpit + плагин rusnas
Уведомления: email (msmtp) + Telegram (bash + curl)
Файрвол:      nftables
Провизионинг: Ansible монорепо
Обновления:   reprepro + nginx deb-репо

Сессия 2 — Сборка стека на VM
Дата: февраль–март 2026
Чат: Сборка NAS платформы на Debian 12 в UTM
Среда

Host: Intel Mac, UTM (QEMU)
VM: Debian 13 Trixie x86_64, 2 ядра, 4GB RAM
Диски: 1×16GB системный + 3×10GB для тестового RAID
Перенос файлов: scp через пользователя rusnas (root SSH отключён)

Что было установлено и протестировано
КомпонентСтатусПримечанияmdadm RAID5✅/dev/md0, три дискаBtrfs✅UUID-based fstab, /mnt/dataSamba✅Проверено с Mac через smbutil и FinderNFS✅mountd зафиксирован на порт 20048vsftpd✅Пассивные порты 30000–30100, нужны правила файрволаWebDAV (Apache)✅Digest auth, нужен Options IndexesRsync daemon✅Пользователь rsyncuser с паролёмiSCSI (targetcli-fb)✅fileio backstoreCockpit✅+ cockpit-storagednftables✅
Cockpit плагин — первая версия (rusnas-storage)
Разработан итеративно. Решённые проблемы:

Неправильный путь к cockpit.js → правильный: ../base1/cockpit.js
CSP блокирует inline обработчики → перенесли всё в addEventListener
JS не выполнялся → добавили unsafe-inline и unsafe-eval в CSP в manifest.json

Результат: плагин показывает SMB-шары и iSCSI-таргеты, поддерживает создание/удаление через cockpit.spawn().
Решённые технические проблемы

Бинарники mdadm, mkfs.btrfs не в PATH → добавили /sbin в .bashrc
VPN на хосте отключал сеть VM → переключили UTM на Bridged режим
Длинные команды обрезаются при вставке в терминал → workflow: файл + scp
macOS NFS mount не работает → нужна опция insecure в /etc/exports

Завершение сессии
Создан документ rusnas-claude-code-task.md — детальная спецификация Ansible-ролей для всех компонентов (base, mdadm, btrfs, samba, nfs, ftp, webdav, rsync, iscsi, cockpit, firewall, notifications). Готов для передачи в Claude Code.

Сессия 3 — Cockpit плагин: доработка и раздел Disks & RAID
Дата: март 2026
Чат: Cockpit плагин для управления NAS
Что было исправлено
1. smb.conf — критический баг
Python regex для редактирования INI-блоков оказался ненадёжным: при удалении/редактировании шары портился весь smb.conf.
Решение: заменили на sed range pattern:
bashsed -i '/^\[sharename\]/,/^\[/{/^\[sharename\]/d; /^\[/!d}' /etc/samba/smb.conf
2. NFS — дублирование записей
При каждом добавлении экспорта запись дублировалась.
Решение: перед append удалять старую запись:
bashsed -i '\|^/path |d' /etc/exports
3. iSCSI targetcli — не выполнялся
superuser: "require" в manifest.json покрывает файловые операции, но не subprocess-вызовы targetcli.
Решение: явный sudo в каждом вызове:
javascriptcockpit.spawn(["sudo", "targetcli", ...])
4. Архитектура путей шар
Раньше пути были хардкодными. Переделали: dropdown заполняется через findmnt --real, фильтруя устройства /dev/md*, /dev/sd[b-z]*, /dev/nvme*.
Новый раздел: Диски и RAID (disks.html + disks.js)
Парсер /proc/mdstat
Определяет состояния: active / degraded / inactive / resyncing / reshaping.
⚠️ Важно: проверяются оба ключевых слова — resync И reshape. Баг: изначально проверялся только resync, при reshape показывалось "Active". Исправлено.
Таблица физических дисков

Модель и серийный номер: sudo smartctl -i /dev/sdX
S.M.A.R.T. здоровье

Операции с дисками

Безопасное извлечение: --fail → --remove → device/delete, подтверждение по серийному номеру
Replace disk и Expand array — отдельные операции
Expand: --add + --grow --raid-devices=N + автоматический resize2fs или btrfs resize по завершению reshape
Ресканирование SCSI-шины: echo "- - -" > /sys/class/scsi_host/host*/scan

Авто-обновление
Каждые 4 секунды когда массив в состоянии degraded или resyncing/reshaping.
Структура меню (manifest.json)
Order 1: Storage   → storage.html
Order 2: Disks     → disks.html   ← новый
Order 3: Users     → users.html
Структура файлов плагина
/usr/share/cockpit/rusnas/
├── manifest.json
├── index.html
├── storage.html
├── users.html
├── disks.html
└── js/
    ├── storage.js
    ├── users.js
    └── disks.js

Сессия 4 — HA кластер (исследование)
Дата: март 2026
Чат: Синхронизация NAS для отказоустойчивого кластера

Исследовательская сессия. В код ничего не легло, но решения приняты для будущей реализации.

Архитектура HA-кластера для rusNAS
Репликация данных — DRBD
Node1: /dev/drbd0 ←── TCP/IP ──→ /dev/drbd0 :Node2
            ↑                           ↑
        mdadm RAID                  mdadm RAID
            ↓                           ↓
          Btrfs                       Btrfs

Протокол C = синхронный (zero data loss)
Протокол A = асинхронный (выше производительность)
DRBD идёт поверх mdadm-массива

Failover — Pacemaker + Corosync

Corosync: heartbeat между узлами
Pacemaker: управляет ресурсами (VIP, DRBD, mount, Samba/NFS)
При падении узла: ~10–30 сек даунтайм для клиентов (floating IP мигрирует)

Арбитр — Raspberry Pi
Решает проблему split-brain при двух узлах:

iSCSI SBD диск — каждый узел пишет heartbeat в свой слот. Если узел завис, watchdog его ребутит (15 сек → 30 сек даунтайм, полностью автономно)
QNetd — кворум-арбитр

Финальная схема:
Node1 ──[eth0]── Switch ──[eth0]── Node2   (клиенты + SBD iSCSI)
Node1 ──[eth1]─────────────────── Node2    (прямой кабель, DRBD)
                Switch
                  │
            Raspberry Pi 4
            ├── iSCSI target (SBD диск)
            └── QNetd (кворум)
Стоимость арбитра: ~$50. Одна плата тянет обе роли.
Синхронизация конфигурации
При изменении конфига через Cockpit плагин → Ansible синхронизирует конфиги на оба узла.

Текущее состояние проекта
Готово ✅

Полный стек установлен и протестирован на VM
Cockpit плагин: Storage (SMB + iSCSI), Users, Disks & RAID
Ansible спецификация (rusnas-claude-code-task.md) — все роли описаны

В работе / следующие шаги 🔜

 Ansible роли — реализация по спеке (отдельная Claude Code сессия)
 Cockpit плагин — снапшоты Btrfs
 Cockpit плагин — мониторинг и уведомления
 AFP протокол
 Active Directory (winbind/sssd)
 Email + Telegram уведомления
 HA кластер (DRBD + Pacemaker + Corosync + Raspberry Pi)


Сводка принятых решений
РешениеВыборПричинаФСBtrfs + mdadmZFS не поддерживает online RAID level migrationВеб-UICockpit + кастомный плагинСкорость разработкиsmb.conf редактированиеsed range patternPython regex ненадёжен для INI-блоковiSCSI в Cockpitявный sudo в spawn()superuser:require не покрывает subprocessПути шарfindmnt --real dropdownНе хардкодить, брать реальные точки монтированияNFS идемпотентностьsed delete перед appendИначе дублируются записиmdstat парсингresync + reshape обаТолько resync → reshape показывало "Active"Арбитр HARaspberry Pi (SBD + QNetd)$50, решает split-brain и зависания ядра