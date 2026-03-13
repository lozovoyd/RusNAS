# rusNAS

> Коммерческая NAS-платформа на базе Debian Linux — альтернатива Synology DSM для SMB-клиентов.

Целевая аудитория: малый и средний бизнес. Ориентир по функциональности: Synology RS1619xs+. Масштаб: 1000+ устройств на одном стеке.

---

## Стек технологий

| Слой | Компонент |
|------|-----------|
| ОС | Debian 13 Trixie |
| RAID | mdadm — JBOD, RAID 0/1/5/6/10, RAID F1 |
| Файловая система | Btrfs (встроенные снапшоты, online resize) |
| SMB | Samba |
| NFS | knfsd + mountd (порт 20048) |
| FTP | vsftpd (пассивные порты 30000–30100) |
| WebDAV | Apache + Digest auth |
| iSCSI | targetcli-fb (LIO) |
| Веб-интерфейс | Cockpit + кастомный плагин `rusnas` |
| Антишифровальщик | rusNAS Guard (Python 3, inotify) |
| Файрвол | nftables |
| Провизионинг | Ansible монорепо |
| Обновления | Кастомный deb-репозиторий (reprepro + nginx) |

**Ключевое архитектурное решение:** Btrfs + mdadm вместо ZFS — ZFS не поддерживает online миграцию уровня RAID (например RAID 5 → RAID 6 без пересоздания массива), а это hard requirement бизнес-модели.

---

## Функциональность

### Хранилище (Storage)
- Управление SMB-шарами: создание, редактирование, удаление
- NFS-экспорты
- iSCSI-таргеты (targetcli/LIO)
- Выбор пути монтирования из реальных Btrfs/mdadm точек (`findmnt --real`)

### Диски и RAID (Disks & RAID)
- Обзор всех физических дисков: модель, серийный номер, S.M.A.R.T.
- Состояния mdadm-массивов: active / degraded / resyncing / reshaping
- Создание массивов JBOD, RAID 0/1/5/6/10, RAID F1
- Безопасное извлечение дисков: `--fail → --remove` с подтверждением по серийному номеру
- Замена диска vs расширение массива — отдельные операции
- Авто-обновление UI каждые 4 секунды при деградации/ресинке
- RAID Advisor: таблица сравнения уровней + калькулятор ёмкости по реальным размерам дисков

### Пользователи (Users)
- Создание и удаление системных пользователей
- Управление паролями

### rusNAS Guard 🛡️ — защита от шифровальщиков
Подробнее: [rusnas-guard-task.md](./rusnas-guard-task.md)

---

## rusNAS Guard — как работает

Демон мониторинга файловой системы реального времени. Не зависит от протокола — перехватывает события на уровне ядра (inotify), поэтому одинаково работает для SMB, NFS, FTP, WebDAV и локального доступа.

### Архитектура

```
Cockpit UI (guard.html / guard.js)
        │  JSON over Unix socket
        ▼
socket_server.py  ──  PIN auth (bcrypt)  ──  session tokens
        │
        ▼
GuardDaemon (guard.py)
  ├── Detector (detector.py)     ← inotify watcher
  │     ├── Honeypot check
  │     ├── Entropy analysis
  │     ├── IOPS anomaly
  │     └── Known extensions
  └── Response (response.py)
        ├── nftables IP block
        ├── Btrfs snapshot
        └── Notifications
```

**Жизненный цикл:** systemd-сервис запущен постоянно. Кнопки Start/Stop в UI управляют внутренним Detector-потоком, а не процессом — сокет-сервер всегда доступен.

### Методы обнаружения

| Метод | Триггер | Особенности |
|-------|---------|-------------|
| **Honeypot** | Любое изменение bait-файла | Мгновенно, без порогов; файлы пересоздаются после срабатывания |
| **Entropy** | Shannon entropy > 7.2 бит/байт при записи | Пропускает уже сжатые форматы (zip, jpg, mp4); rate limit 200 ev/s |
| **IOPS anomaly** | rate > median + 4×σ AND rate > 50 ops/min | 7-дневный период обучения; скользящее окно 60 сек |
| **Extensions** | Создан/переименован файл с расширением шифровальщика | ~200 расширений в `/etc/rusnas-guard/ransom_extensions.txt` |

### Режимы реагирования

- **Monitor** — только лог и уведомления
- **Active** — Btrfs snapshot + блокировка IP через nftables + разрыв SMB-сессий
- **Super-Safe** — snapshots всех томов → стоп всех файловых служб → poweroff через 30 сек

### Guard PIN
Отдельный пароль (bcrypt), независимый от пароля Cockpit-администратора. Требуется для всех чувствительных операций. Сброс только через SSH:
```bash
sudo rusnas-guard --reset-pin
```

---

## Структура проекта

```
rusNAS/
├── cockpit/
│   └── rusnas/                 # Cockpit-плагин
│       ├── manifest.json
│       ├── index.html          # Storage (SMB, NFS, iSCSI)
│       ├── disks.html          # Диски и RAID
│       ├── users.html          # Пользователи
│       ├── guard.html          # Guard 🛡️
│       ├── css/style.css       # Dark mode, CSS custom properties
│       └── js/
│           ├── app.js          # Storage
│           ├── disks.js        # Диски и RAID
│           ├── users.js        # Пользователи
│           └── guard.js        # Guard UI
├── rusnas-guard/
│   ├── daemon/
│   │   ├── guard.py            # Точка входа, main loop
│   │   ├── detector.py         # inotify watcher, 4 метода обнаружения
│   │   ├── entropy.py          # Shannon entropy
│   │   ├── honeypot.py         # Bait-файлы
│   │   ├── response.py         # Блокировки, снапшоты, уведомления
│   │   └── socket_server.py    # Unix socket сервер, PIN auth
│   ├── config/
│   │   ├── config.json
│   │   └── ransom_extensions.txt
│   └── service/
│       └── rusnas-guard.service
├── ansible/                    # Ansible роли (провизионинг)
├── deploy.sh                   # Деплой Cockpit-плагина на VM
├── install-guard.sh            # Деплой Guard daemon на VM
├── rusnas-guard-task.md        # Полное ТЗ и архитектура Guard
├── project_history.MD          # Хронология всех сессий разработки
└── CLAUDE.md                   # Инструкции для Claude Code
```

---

## Текущая версия

### Что готово ✅

**Cockpit-плагин:**
- Storage: SMB-шары, NFS-экспорты, iSCSI-таргеты
- Disks & RAID: полное управление mdadm + RAID Advisor
- Users: управление пользователями
- Guard 🛡️: полнофункциональный UI антишифровальщика

**rusNAS Guard:**
- Все 4 метода обнаружения реализованы и протестированы
- 3 режима реагирования: Monitor / Active / Super-Safe
- PIN-аутентификация (bcrypt), session tokens (30 мин)
- Post-attack safe mode (флаг `/etc/rusnas-guard/post_attack`)
- PIN reset через CLI
- Полное E2E тестирование (18 тестов, все прошли):
  - IOPS-триггер: 777 ops/min при реальной нагрузке
  - Entropy-триггер: 50 событий на random-бинарных файлах (entropy ~8.0)
  - Honeypot-триггер: обнаружение bait-файла за <3 сек

**Инфраструктура:**
- deploy.sh — автодеплой плагина на VM (sshpass + chmod 644/755)
- install-guard.sh — установка Guard daemon
- Git-репозиторий, CI-ready структура

### В работе / следующие шаги 🔜

- [ ] Ansible роли для автоматической установки на новых устройствах
- [ ] Интеграция уведомлений Guard (email + Telegram)
- [ ] Btrfs снапшоты через UI (отдельная секция)
- [ ] HA кластер: DRBD + Pacemaker + Corosync + Raspberry Pi арбитр
- [ ] Active Directory (winbind / sssd)
- [ ] AFP протокол

---

## Разработка

### Требования
- macOS с UTM (QEMU) для VM
- VM: Debian 13 Trixie, 10.10.10.72
- `sshpass` на хосте: `brew install sshpass`

### Деплой

```bash
# Cockpit-плагин
./deploy.sh

# Guard daemon
./install-guard.sh
```

### Среда разработки
```
Host:     Intel Mac, UTM QEMU
VM:       Debian 13 Trixie x86_64
          2 ядра, 4 GB RAM
          1×16 GB системный диск
          3×10 GB для тестового RAID
Доступ:   ssh rusnas@10.10.10.72
```

Cockpit автоматически перезагружает плагин при обновлении страницы — рестарт сервиса не нужен.

---

## Документация

| Документ | Содержание |
|----------|-----------|
| [CLAUDE.md](./CLAUDE.md) | Инструкции для Claude Code, паттерны разработки, известные баги |
| [rusnas-guard-task.md](./rusnas-guard-task.md) | Полное ТЗ Guard: архитектура, протокол, реализация |
| [project_history.MD](./project_history.MD) | Хронология всех сессий разработки, принятые решения |
| [ui.md](./ui.md) | UI guidelines: компоненты, dark mode, CSP правила |
