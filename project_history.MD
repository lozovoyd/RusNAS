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

Сессия 5 — Git, DevOps, UI redesign
Дата: 12 марта 2026
Чат: Claude Code — инициализация репозитория и редизайн UI

Что было сделано

1. Git-репозиторий и рабочий каталог
Инициализирован git-репо в /Users/dvl92/projects/RusNAS/.
Собраны все файлы плагина с VM (10.10.10.72:/usr/share/cockpit/rusnas/) через scp.

Уточнена реальная структура файлов — отличается от документации:
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

2. deploy.sh — автоматический деплой
Создан скрипт deploy.sh: scp в /tmp/ → sudo cp → chmod 644/755 → готово.
Проблемы и решения:
— SSH без пароля: установлен sshpass (brew), добавлены флаги -o PreferredAuthentications=password -o PubkeyAuthentication=no
— sudo на VM: передача пароля через echo 'pass' | sudo -S
— Права файлов 600 после scp: Cockpit не мог читать → deploy.sh теперь выставляет 644 на файлы, 755 на директории

3. Фикс страницы Users (зависала на "Загрузка...")
Три бага одновременно:
— initUsers() никогда не вызывалась — не было DOMContentLoaded listener
— showModal/closeModal не определены в users.js (они живут в app.js, который users.html не загружает)
— Нет .fail() на внутренних cockpit.spawn() в loadUsers() → pending никогда не достигал 0

4. Редизайн UI — dark mode + CSS custom properties
style.css полностью переписан:
— CSS custom properties для всех цветов (--bg, --bg-card, --color, --primary и т.д.)
— @media (prefers-color-scheme: dark) для автоматической тёмной темы
— Cockpit v337 передаёт тему в iframe через color-scheme CSS property → prefers-color-scheme срабатывает корректно
— Шрифт Red Hat Text подключён через ../../static/fonts/ (Cockpit bundled fonts)
— PatternFly v6 inspired дизайн-токены (цвета взяты из bundled Cockpit CSS)
Все три HTML файла обновлены:
— <meta name="color-scheme" content="light dark"> добавлен в head
— Все inline style="..." убраны
— Новые классы: .section-toolbar, .modal-footer, .btn-group, .table-hint
— inline <style> блок из disks.html перенесён в style.css

5. ui.md — UI guidelines
Создан документ с правилами разработки UI:
— Все компоненты с примерами HTML
— Правило: никогда не хардкодить цвета вне CSS custom properties
— Механизм dark mode объяснён
— CSP правила (что работает через unsafe-inline, что нет)
— Ссылка добавлена в CLAUDE.md

Текущее состояние проекта
Готово ✅

Полный стек установлен и протестирован на VM
Cockpit плагин: Storage (SMB + NFS + iSCSI), Users, Disks & RAID
Git-репозиторий инициализирован, deploy.sh работает
UI redesign: dark mode, CSS custom properties, PatternFly v6 стиль
ui.md — UI guidelines, CLAUDE.md актуален

В работе / следующие шаги 🔜

 Ansible роли — реализация по спеке (отдельная Claude Code сессия)
 Cockpit плагин — снапшоты Btrfs
 Cockpit плагин — мониторинг и уведомления
 AFP протокол
 Active Directory (winbind/sssd)
 Email + Telegram уведомления
 HA кластер (DRBD + Pacemaker + Corosync + Raspberry Pi)


Сессия 6 — rusNAS Guard (Антишифровальщик)
Дата: 13 марта 2026
Ветка: feature/rusnas-guard
Коммит: b27cac4

Что было сделано

Реализован полноценный daemon защиты от шифровальщиков — rusnas-guard.

1. Архитектура daemon (Python 3)
5 модулей в /usr/lib/rusnas-guard/:

guard.py — точка входа, main loop, управление жизненным циклом
detector.py — inotify watcher, диспетчер 4 методов обнаружения
entropy.py — Shannon entropy: 16×4KB случайных блоков, порог 7.2 бит/байт
honeypot.py — bait-файлы: !~rng_XXXXXXXX.docx/.xlsx/.pdf в каждой папке
response.py — блокировка IP (nftables), снапшоты Btrfs, уведомления, JSONL-лог
socket_server.py — Unix socket, JSON protocol, bcrypt PIN, session tokens (30 мин)

2. Четыре независимых метода обнаружения

Метод          | Триггер                                              | Примечание
Honeypot       | Любое изменение bait-файла                          | Мгновенно, без порога
Entropy        | >7.2 бит/байт при IN_CLOSE_WRITE                   | Пропускает mp4/zip/jpg и <16KB файлы
IOPS anomaly   | rate > median + 4×σ И rate > 50 ops/min            | Активен после 7-дневного обучения
Extensions     | Файл создан/переименован в .locked/.encrypted/etc. | ~200 расширений в списке

3. Три режима реагирования

Monitor — только лог и уведомления, без блокировок
Active — снапшот + блокировка IP через nftables + отключение SMB-соединений
Super-Safe — снапшоты ВСЕХ томов → уведомление → стоп всех служб → poweroff через 30 сек

4. Guard PIN
— Bcrypt hash в /etc/rusnas-guard/guard.pin
— Независим от пароля Cockpit-администратора
— Требуется для: start/stop, смены режима, изменения настроек, acknowledge событий
— Session token 30 минут (только в памяти daemon)
— First-run wizard при первом открытии страницы без PIN

5. Post-attack safe mode
— После Super-Safe shutdown: флаг /etc/rusnas-guard/post_attack
— На следующем старте: Monitor mode, предупреждение в UI
— Снимается только PIN-подтверждением через "Подтвердить и восстановить режим"

6. Cockpit UI (guard.html + guard.js)
— Статус-бар: Running/Stopped + кнопки Start/Stop + режим
— Dashboard: 6 плиток (события/день, IOPS, baseline, снапшот, путей, блокировок)
— Журнал событий: последние 50, с acknowledge кнопкой
— Настройки обнаружения: toggle + slider энтропии + dropdown чувствительности IOPS
— Мониторируемые пути: таблица с per-path флагами
— Снапшоты: local + remote SSH (с генерацией ed25519 ключа в UI)
— Список расширений: textarea-редактор

7. Деплой и инфраструктура
— install-guard.sh: загружает daemon, ставит python3-inotify, регистрирует systemd service
— systemd service: disabled by default, enable --now только через UI с PIN
— manifest.json обновлён: Guard 🛡️ → order 4

8. Проверка
— python3 -m py_compile: все 6 модулей без ошибок
— Файлы на VM: /usr/lib/rusnas-guard/ ✅, /etc/rusnas-guard/ ✅
— Cockpit: guard.html + guard.js задеплоены с правами 644 ✅
— systemctl status rusnas-guard: loaded (disabled) ✅

Зависимости на VM
python3-inotify (0.2.10-5) — установлен
python3-bcrypt (4.2.0-2.1+b1) — был установлен
btrfs-progs, nftables, openssh-client — были установлены

Текущее состояние проекта после сессии 6
Готово ✅

Все предыдущие фичи (Storage, Disks&RAID, Users)
rusNAS Guard daemon: установлен на VM, синтаксически валиден
Cockpit Guard UI: доступен в браузере → Guard 🛡️
Git: ветка feature/rusnas-guard, коммит b27cac4, запушен на GitHub

Следующие шаги 🔜

Протестировать Guard в реальных условиях:
  — создать bait-файл и убедиться что honeypot срабатывает
  — записать /dev/urandom → проверить entropy trigger
  — переименовать файл в .locked → проверить extensions trigger
Интеграция уведомлений: создать /usr/lib/rusnas/notify.sh (email + Telegram)
Ansible роль для Guard (автоустановка на новых устройствах)
PR: feature/rusnas-guard → main

Сводка принятых решений
РешениеВыборПричинаФСBtrfs + mdadmZFS не поддерживает online RAID level migrationВеб-UICockpit + кастомный плагинСкорость разработкиsmb.conf редактированиеsed range patternPython regex ненадёжен для INI-блоковiSCSI в Cockpitявный sudo в spawn()superuser:require не покрывает subprocessПути шарfindmnt --real dropdownНе хардкодить, брать реальные точки монтированияNFS идемпотентностьsed delete перед appendИначе дублируются записиmdstat парсингresync + reshape обаТолько resync → reshape показывало "Active"Арбитр HARaspberry Pi (SBD + QNetd)$50, решает split-brain и зависания ядра