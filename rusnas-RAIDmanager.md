# rusNAS RAID Manager — ТЗ и архитектура

> Реализация: `cockpit/rusnas/disks.html` + `cockpit/rusnas/js/disks.js`

## Проблема

Новый пользователь открывает Cockpit → «Диски и RAID» и видит «RAID массивов не обнаружено».
Создать, удалить, смонтировать массив или создать Btrfs субтом — только через SSH.
Это противоречит концепции NAS-платформы «всё из браузера».

## Область задачи (MVP)

| # | Функция | Команды |
|---|---------|---------|
| 1 | **Создать массив** + форматировать Btrfs + смонтировать + fstab | `mdadm --create`, `mkfs.btrfs`, `mount`, `/etc/fstab` |
| 2 | **Удалить массив** | `umount`, `mdadm --stop`, `mdadm --zero-superblock` |
| 3 | **Смонтировать** существующий массив | `mkdir -p`, `mount`, `/etc/fstab` |
| 4 | **Размонтировать** | `umount` |
| 5 | **Субтома Btrfs** — создать / удалить | `btrfs subvolume create/delete/list` |

**Не в MVP:** смена уровня RAID, fsck, UI для hot spare, квоты Btrfs.

## Архитектура

### Новые глобальные переменные (disks.js)

```javascript
var currentDisks    = [];  // заполняется в renderDisks()
var currentMountMap = {};  // md device → {target, fstype}, заполняется в loadDisksAndArrays()
```

### Изменения в loadDisksAndArrays()

Добавить параллельный вызов `findmnt` для получения статуса монтирования:

```javascript
cockpit.spawn(["bash", "-c", "findmnt -rno SOURCE,TARGET,FSTYPE 2>/dev/null || true"])
    .done(function(out) {
        currentMountMap = parseMountInfo(out);
        renderArrays(arrays, currentMountMap);
    });
```

### Изменения в renderArrays(arrays, mountMap)

Для каждой карточки массива добавить:
- Строку статуса монтирования (`📂 /mnt/data (btrfs)` или `— не смонтирован`)
- Кнопки в `array-actions`: `📂 Смонтировать` / `⏏ Размонтировать`, `🗂 Субтома`, `🗑 Удалить`

### Изменения в renderDisks()

Сохранять данные в `currentDisks[]`:
```javascript
currentDisks = disks.map(function(line) {
    var parts = line.trim().split(/\s+/);
    return { name: parts[0], size: parts[1], array: diskArrayMap[parts[0]] || null };
});
```

## Новые элементы UI (disks.html)

### Кнопка в section-toolbar
```html
<button class="btn btn-primary" id="btn-create-array">+ Создать массив</button>
```

### modal-create-array
Двухшаговый мастер:
- **Шаг 1 (конфигурация):** уровень RAID (0/1/5/6/10), чекбоксы свободных дисков с валидацией минимума, точка монтирования, метка ФС
- **Шаг 2 (прогресс):** пошаговый лог (`▶ команда... ✓ / ✗ ошибка`), кнопка «Готово ✓» после завершения

### modal-delete-array
- Список дисков-участников, предупреждение об уничтожении данных
- После подтверждения: прогресс-лог в `eject-status`

### modal-mount-array
- Ввод точки монтирования, автоопределение ФС через `blkid`
- Если ФС нет — кнопка заблокирована с предупреждением

### modal-subvolumes
- Таблица существующих субтомов с путями + кнопка 🗑 для каждого
- Поле создания нового субтома

## Команды (все через bash, superuser: "require")

### Создать массив (последовательная цепочка)
```bash
# 1. Найти первое свободное имя
for i in 0 1 2 3 4 5 6 7 8 9; do [ ! -e /dev/md$i ] && echo md$i && break; done

# 2. Создать
mdadm --create /dev/md0 --level=5 --raid-devices=3 /dev/sdb /dev/sdc /dev/sdd --force --run

# 3. Сохранить конфигурацию
mdadm --detail --scan | grep md0 >> /etc/mdadm/mdadm.conf

# 4. Создать точку монтирования
mkdir -p /mnt/data

# 5. Форматировать Btrfs
mkfs.btrfs -L rusnas-data -f /dev/md0

# 6. Смонтировать
mount /dev/md0 /mnt/data

# 7. Добавить в fstab
UUID=$(blkid -s UUID -o value /dev/md0)
grep -q $UUID /etc/fstab || echo "UUID=$UUID /mnt/data btrfs defaults,nofail 0 0" >> /etc/fstab
```

### Удалить массив
```bash
MP=$(findmnt -n -o TARGET /dev/md0 2>/dev/null || true)
[ -n "$MP" ] && umount "$MP" 2>/dev/null || true
UUID=$(blkid -s UUID -o value /dev/md0 2>/dev/null || true)
[ -n "$UUID" ] && sed -i "/UUID=$UUID/d" /etc/fstab || true
mdadm --stop /dev/md0
for d in /dev/sdb /dev/sdc /dev/sdd; do mdadm --zero-superblock $d 2>/dev/null || true; done
```

### Субтома
```bash
btrfs subvolume list /mnt/data           # список
btrfs subvolume create /mnt/data/homes   # создать
btrfs subvolume delete /mnt/data/homes   # удалить
```

## Верификация (сквозное тестирование)

1. **Создать:** «+ Создать массив» → 3 диска, RAID 5, `/mnt/data` → лог → массив смонтирован в UI
2. **Субтома:** «Субтома» → создать `homes`, `documents` → использовать как путь для SMB-шары
3. **Размонтировать / Смонтировать:** проверить смену статуса в карточке
4. **Удалить:** подтверждение → лог → диски свободны, массив исчез из UI
