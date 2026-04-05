# rusNAS — SSD-кеш (SSD Tier): ТЗ и архитектура

> **Статус: ✅ Реализовано (2026-03-17)**

## Контекст

rusNAS — Cockpit-плагин (`/usr/share/cockpit/rusnas/`), Debian 13, mdadm + Btrfs.
Функционал встроен в существующую страницу **Диски и RAID** (`disks.html`/`disks.js`) как отдельная секция ниже таблицы физических дисков.

Технология: **dm-cache через LVM** (`lvmcache`). bcache не используется — опасен с Btrfs в режиме writeback из-за нарушения порядка записи.

---

## Архитектура стека

```
Приложение / SMB / NFS
        ↓
      Btrfs
        ↓
  /dev/rusnas_vgN/data_lv  (LVM LV с dm-cache)
        ↓ (cache hit)        ↓ (cache miss)
   /dev/sdY (SSD)       /dev/mdX (HDD RAID)
```

Btrfs монтируется поверх LV, а не напрямую на mdadm-устройство.

---

## Структура данных

Состояние всех SSD-тиров хранится в `/etc/rusnas/ssd-tiers.json` (chmod 644):

```json
{
  "tiers": [
    {
      "vg_name": "rusnas_vg0",
      "lv_name": "data_lv",
      "cache_device": "/dev/sdb",
      "backing_device": "/dev/md0",
      "mode": "writethrough",
      "created_at": "2026-03-17T00:00:00Z"
    }
  ]
}
```

---

## Backend: зависимости и судоерс

**Пакеты:** `lvm2`, `thin-provisioning-tools` (Debian 13: уже установлены или ставятся `install-ssd-tier.sh`)

**Судоерс** `/etc/sudoers.d/rusnas-ssd-tier` (chmod 440):
```
rusnas ALL=(ALL) NOPASSWD: /sbin/pvcreate, /sbin/pvremove, /sbin/pvs
rusnas ALL=(ALL) NOPASSWD: /sbin/vgcreate, /sbin/vgremove, /sbin/vgs
rusnas ALL=(ALL) NOPASSWD: /sbin/lvcreate, /sbin/lvremove, /sbin/lvs
rusnas ALL=(ALL) NOPASSWD: /sbin/lvconvert, /sbin/lvchange, /sbin/lvdisplay
rusnas ALL=(ALL) NOPASSWD: /sbin/dmsetup
(аналогично /usr/sbin/*)
```

LVM бинарные в `/sbin/` (Debian 13). Sudo находит их через `secure_path="/usr/local/sbin:...:/sbin:/bin"`.

---

## Backend: shell-операции (реализованы в disks.js)

### 1. Список кандидатов для кеша (SSD)

```bash
lsblk -d -o NAME,SIZE,ROTA,TYPE --json
# Фильтр: rota == 0 (не ротационный), type == "disk"
# Исключить диски из /proc/mdstat
```

### 2. Создать SSD-тир (8 шагов)

```bash
# 1. pvcreate -f /dev/md0         (backing device)
# 2. pvcreate -f /dev/sdb         (cache device)
# 3. vgcreate rusnas_vg0 /dev/md0 /dev/sdb
# 4. lvcreate -l 100%PVS -n data_lv rusnas_vg0 /dev/md0
# 5. lvcreate -L 512M -n cache_meta rusnas_vg0 /dev/sdb
# 6. lvcreate -l 100%FREE -n cache_data rusnas_vg0 /dev/sdb
# 7. lvconvert --yes --type cache-pool --poolmetadata rusnas_vg0/cache_meta rusnas_vg0/cache_data
# 8. lvconvert --yes --type cache --cachepool rusnas_vg0/cache_data --cachemode writethrough rusnas_vg0/data_lv
```

VG именование: `rusnas_vg<N>` где N = `vgs --noheadings -o vg_name | grep -c rusnas_vg`

Откат при ошибке: `vgremove -f rusnas_vgN`

### 3. Статус тира

```bash
sudo -n lvs --noheadings --units g \
  -o lv_name,cache_read_hits,cache_read_misses,cache_write_hits,cache_write_misses,cache_used_blocks,cache_total_blocks,cache_mode \
  rusnas_vg0
```

Метрики:
- `hit_rate = read_hits / (read_hits + read_misses) * 100`
- `cache_pct = cache_used_blocks / cache_total_blocks * 100`

### 4. Изменить режим

```bash
lvchange --cachemode writeback rusnas_vg0/data_lv
lvchange --cachemode writethrough rusnas_vg0/data_lv
```

### 5. Отключить тир

```bash
# 1. Сброс dirty блоков
lvchange --syncaction check rusnas_vg0/data_lv
# 2. Отключить кеш
lvconvert --yes --uncache rusnas_vg0/data_lv
# 3. Удалить VG
vgremove -f rusnas_vg0
```

---

## Frontend: UI-компоненты

### Секция "⚡ SSD-кеширование" (disks.html)

Добавлена между таблицей физических дисков и первым модалом.

**Таблица:**
| Массив | SSD-диск | Режим | Эффективность | Кеш занят | Действия |
|--------|----------|-------|---------------|-----------|----------|
| /dev/md0 | /dev/sdb | Безопасный ✓ | ████░ 72% | ████░ 61% | [Режим] [Отключить] |

Режим отображается:
- `Безопасный (writethrough) ✓` — зелёный (`.ssd-mode-wt`)
- `Быстрый (writeback) ⚠` — оранжевый (`.ssd-mode-wb`)

Прогрессбары (`.ssd-bar-wrap` + `.ssd-bar-fill`):
- hit_rate < 50% → `.warn` (оранжевый)
- cache_pct > 90% → `.crit` (красный), > 70% → `.warn`

### Модал "Добавить SSD-кеш"

- Select основного массива (из `currentArrays`)
- Select SSD-диска (из `getSsdCandidates()`)
- Radio: writethrough (default) / writeback
- Writeback: предупреждение ⚠ + чекбокс "Использую ИБП"
- Предупреждение о резервной копии + чекбокс подтверждения
- Progress log для 8 шагов создания

### Модал "Изменить режим"

Radio writethrough / writeback. Применяется через `lvchange --cachemode`.

### Модал "Отключить SSD-кеш"

Предупреждение о сбросе dirty-блоков. Progress log для 3 шагов отключения.

---

## Ограничения

- **Нет свободного SSD** → select показывает "— нет доступных SSD —", кнопка "+Добавить" открывает модал с пустым select (операция заблокирована самим UI)
- **Массив уже в LVM** → pvcreate выдаст ошибку "already a physical volume", откат автоматический
- **lvm2 не установлен** → проверка `which lvconvert && which pvs` в `openAddSsdTierModal()` показывает alert

---

## Файлы

| Файл | Изменение |
|------|-----------|
| `install-ssd-tier.sh` | Создан — деплой deps + sudoers + JSON |
| `cockpit/rusnas/disks.html` | Секция SSD + 3 модала |
| `cockpit/rusnas/js/disks.js` | `currentSsdTiers`, `ssdTierTimer` + ~350 строк SSD-функций + init в DOMContentLoaded |
| `cockpit/rusnas/css/style.css` | 9 строк CSS (ssd-bar-wrap/fill, ssd-mode-wt/wb) |
| `/etc/rusnas/ssd-tiers.json` | Создаётся install-скриптом, chmod 644 |
| `/etc/sudoers.d/rusnas-ssd-tier` | Создаётся install-скриптом, chmod 440 |

---

## Терминология для UI

| Технический термин | В UI |
|---|---|
| dm-cache / lvmcache | SSD-кеш |
| cache device (SSD) | Быстрый диск / SSD-диск |
| backing device (mdadm) | Основной массив |
| writethrough | Безопасный режим |
| writeback | Быстрый режим |
| cache hit rate | Эффективность |
