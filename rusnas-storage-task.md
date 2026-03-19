# rusNAS Storage Page — ТЗ на редизайн

> Версия 1.1 — 2026-03-19
> Ветка: `feature/storage-redesign` → влита в `main` 2026-03-19
> Статус: ✅ Реализовано и задеплоено

---

## Обоснование

Страница `/rusnas` (index.html + app.js) содержала 6 вертикальных секций на одном экране:
SMB-шары, NFS-шары, iSCSI, FTP, WebDAV, WORM. При 10+ шарах страница становилась
нечитаемой. SMB и NFS шары одного и того же каталога не были визуально связаны.

**Прототип:** Synology DSM (Control Panel → Shared Folder + File Services).

**Ключевой принцип:** «Общая папка» — первичная концепция. Папка может быть доступна
по нескольким протоколам (SMB, NFS). Протокол — это атрибут папки, а не отдельный список.

---

## Новая структура страницы

### 4 вкладки (advisor-tabs pattern)

```
[📂 Шары] [🎯 iSCSI] [🔒 WORM] [⚙️ Сервисы]
```

| Вкладка | Содержимое | Изменения |
|---------|-----------|-----------|
| **📂 Шары** | Объединённая таблица SMB + NFS | **НОВОЕ** — полная переработка |
| **🎯 iSCSI** | Таблица iSCSI targets | Перенесена без изменений |
| **🔒 WORM** | WriteOnce protection | Перенесена без изменений |
| **⚙️ Сервисы** | FTP + WebDAV карточки | Перенесены без изменений |

---

## Вкладка «📂 Шары»

### Status bar (верх вкладки)

```
SMB ● Активен     NFS ● Активен
```

Получается через: `systemctl is-active smbd nfs-kernel-server`

### Таблица шар

| Колонка | Содержимое |
|---------|-----------|
| **Имя** | Имя SMB-шары (из smb.conf) или `basename(path)` для NFS-only |
| **Путь** | Абсолютный путь (например `/mnt/data/documents`) |
| **Протоколы** | Badges: `SMB` (синий = включён, серый = нет), `NFS` (аналогично) |
| **Доступ** | «Публичный» / «Приватный» (из SMB guest ok) |
| **Действия** | `✏️ Изменить` `🗑️ Удалить` |

Кнопка `+ Создать шару` — открывает unified modal в режиме создания.

### Алгоритм объединения данных (loadAllShares)

```javascript
async function loadAllShares() {
  const [smbShares, nfsShares] = await Promise.all([
    parseSmbConf(),      // читает smb.conf, возвращает [{name, path, ...}]
    parseNfsExports()    // читает /etc/exports, возвращает [{path, clients, ...}]
  ]);

  const byPath = {};

  // Сначала SMB (имеют имена)
  for (const s of smbShares) {
    byPath[s.path] = { name: s.name, path: s.path, smb: s, nfs: null };
  }

  // Добавляем NFS (merge по path)
  for (const n of nfsShares) {
    if (byPath[n.path]) {
      byPath[n.path].nfs = n;                           // merge с существующей
    } else {
      const name = n.path.split('/').pop();             // NFS-only: имя = basename
      byPath[n.path] = { name, path: n.path, smb: null, nfs: n };
    }
  }

  return Object.values(byPath);
}
```

---

## Unified Share Modal (главное нововведение)

Один modal заменяет 4 старых (`#add-share-modal`, `#edit-share-modal`, `#add-nfs-modal`, `#edit-nfs-modal`).

### Структура

```
┌─────────────────────────────────────────┐
│ Новая шара / Редактировать: documents   │
├─────────────────────────────────────────┤
│ [Основные] [SMB] [NFS]                  │  ← tab-btn внутри modal-box
├─────────────────────────────────────────┤
│                                         │
│   (содержимое активной вкладки)         │
│                                         │
├─────────────────────────────────────────┤
│ [Сохранить]  [Отмена]                   │
└─────────────────────────────────────────┘
```

### Вкладка «Основные»

- **Имя шары** — `<input>` (readonly при редактировании)
- **Путь** — `<select>` из `loadVolumeSelects()` или `<input>` вручную
- **Владелец** — `<select>` из `/etc/passwd` (через `populateOwnerSelects()`)
- **Группа** — `<select>` из `/etc/group`
- **Права** — `<select>`: 777 (все), 755 (owner rw), 555 (только чтение), 700 (только owner)

### Вкладка «SMB»

- **Включить SMB доступ** — `<input type="checkbox">` toggle
- *(если включено):*
  - **Публичный / Приватный** — radio buttons (`guest ok = yes/no`)
  - **Разрешённые пользователи** — checkboxes (через `populateUserCheckboxes()`)
  - **Browseable** — toggle
  - **Writable** — toggle

### Вкладка «NFS»

- **Включить NFS доступ** — `<input type="checkbox">` toggle
- *(если включено):*
  - **Клиенты** — `<input>` (например `192.168.1.0/24` или `*`)
  - **Доступ** — radio: `rw` / `ro`
  - **Root squash** — toggle (`root_squash` / `no_root_squash`)

---

## Логика saveShareModal()

```
1. Читаем состояние всех трёх вкладок

2. Если путь не существует:
   → mkdir -p <path> && chmod <mode> <path> && chown <owner>:<group> <path>

3. SMB:
   ├── toggle ON  + было OFF → добавить секцию [name] в smb.conf
   ├── toggle ON  + было ON  → заменить секцию (sed range pattern /^\[name\]/,/^\[/)
   └── toggle OFF + было ON  → удалить секцию из smb.conf
   → systemctl reload smbd

4. NFS:
   ├── toggle ON  → sed -i '\|^<path> |d' /etc/exports && echo "<line>" >> /etc/exports
   └── toggle OFF + было ON → sed -i '\|^<path> |d' /etc/exports
   → exportfs -r

5. loadAllShares() → renderSharesTable()
```

## Логика deleteShare(shareData)

```
Диалог подтверждения:
  "Удалить шару '<name>'?
   Директория НЕ будет удалена, только конфигурация."

При подтверждении:
  → если shareData.smb: удалить секцию из smb.conf + reload smbd
  → если shareData.nfs: удалить из /etc/exports + exportfs -r
  → loadAllShares()
```

> ⚠️ Директория физически НЕ удаляется — только убирается из конфигов протоколов.

---

## Новые JS-функции

| Функция | Описание |
|---------|---------|
| `setupStorageTabs()` | Инициализация 4 основных advisor-tabs |
| `setupShareModalTabs()` | Внутренние tab-btn вкладки внутри #share-modal |
| `loadAllShares()` | Параллельный Promise.all + merge по path |
| `renderSharesTable(shares)` | Отрисовка объединённой таблицы (с badges) |
| `openShareModal(shareData)` | Открыть modal (null = create, object = edit) |
| `saveShareModal()` | Сохранить в smb.conf + /etc/exports |
| `deleteShare(shareData)` | Удалить из конфигов с подтверждением |
| `loadServiceStatus()` | Статус smbd + nfs-kernel-server в status-bar |

## Переименование существующих функций

| Было | Станет | Причина |
|------|--------|---------|
| `loadShares()` | `parseSmbConf()` | Теперь возвращает Promise, не рендерит |
| `loadNFS()` | `parseNfsExports()` | Аналогично |

## Удалить (заменяются новыми функциями)

- `openEditShare()` → заменяется `openShareModal(shareData)`
- `addShare()` → заменяется `openShareModal(null)`
- `deleteShare(name)` (старый вариант) → заменяется `deleteShare(shareData)`
- `openEditNFS()` → заменяется `openShareModal(shareData)`
- `addNFS()` → заменяется `openShareModal(null)` с NFS toggle
- `deleteNFS()` → заменяется `deleteShare(shareData)`

---

## Файлы для изменения

| Файл | Тип изменений |
|------|--------------|
| `cockpit/rusnas/index.html` | Полная реструктуризация HTML |
| `cockpit/rusnas/js/app.js` | Рефактор + новые функции + удаление старых |
| `cockpit/rusnas/css/style.css` | 3 новых CSS-класса (минимум) |
| `CLAUDE.md` | Обновить секцию Storage page + Known Bugs |
| `project_history.md` | Добавить запись о сессии |

---

## Новые CSS-классы (минимальные добавления)

```css
/* Строка статуса сервисов над таблицей шар */
.service-status-bar {
    display: flex;
    gap: 24px;
    padding: 8px 0 14px;
    font-size: 13px;
}

/* Группа badges в колонке Протоколы */
.share-proto-badges {
    display: flex;
    gap: 4px;
}

/* Вкладки внутри modal (уже есть .tab-btn, нужен только отступ) */
.modal-tabs {
    margin-bottom: 16px;
    margin-top: -8px;
}
```

---

## Технические ограничения (из CLAUDE.md — не нарушать)

- `smb.conf` изменяется через `sed` range + `cockpit.file().replace()` — **не через Python regex**
- `/etc/exports`: всегда `sed -i '\|^/path |d'` перед добавлением (предотвращает дублирование)
- `superuser: "require"` **НЕ** используется в `cockpit.spawn` — polkit timeout в iframe
- iSCSI требует явного `sudo` в spawn
- `cockpit.spawn().then().catch()` — не нативный Promise → оборачивать в `new Promise()`
- `bash` НЕ в sudoers NOPASSWD — не использовать `sudo -n bash -c ...`

---

## Тест-план (после реализации)

1. Открыть страницу → 4 вкладки видны, активна «Шары»
2. Таблица показывает SMB + NFS шары с правильными badges
3. `+ Создать шару` → modal с 3 внутренними вкладками открывается
4. Создать SMB-only шару → проверить `testparm -s`, отсутствие в `/etc/exports`
5. Редактировать шару → включить NFS → проверить `/etc/exports`
6. Редактировать шару → отключить SMB → проверить smb.conf
7. Удалить шару → проверить оба конфига, директория осталась
8. Tab «iSCSI» → таблица работает
9. Tab «WORM» → таблица работает
10. Tab «Сервисы» → FTP + WebDAV карточки работают
11. Mobile 390px: вкладки scrollable, таблица в overflow-x

---

## Заметки по реализации (2026-03-19)

### Что реализовано точно по ТЗ

- 4 вкладки (`advisor-tabs`) — `📂 Шары | 🎯 iSCSI | 🔒 WORM | ⚙️ Сервисы`
- Unified Share Modal с внутренними `.tab-btn` вкладками (`Основные / SMB / NFS`)
- `parseSmbConf()` + `parseNfsExports()` как Promise-хелперы, `loadAllShares()` с merge по path
- `loadServiceStatus()` — badges над таблицей шар
- `deleteShareEntry()` — удаляет только из конфигов, директорию не трогает
- 3 CSS-класса: `.service-status-bar`, `.share-proto-badges`, `.modal-tabs`

### Отклонения от ТЗ (обоснованные)

| ТЗ | Реализовано | Причина |
|----|-------------|---------|
| `deleteShare(shareData)` | `deleteShareEntry(shareData)` | Имя изменено чтобы не конфликтовать с именем в WORM-коде |
| `loadVolumeSelects(callback)` параметры | Добавлен второй параметр `targetId` | Для точечного указания целевого `<select>` без изменения логики |
| В ТЗ говорилось `cockpit.file().replace()` для smb.conf | Используется `bash -c + sed + printf` | Исторически этот подход уже работал и проверен; `cockpit.file().replace()` подходит для JSON/простых конфигов, но smb.conf требует атомарного range-replace через sed |
| Lazy load WORM только при первом входе | `_tabsLoaded.worm` флаг | Добавлен guard чтобы WORM не перезагружался при каждом клике на вкладку |

### Архитектурные решения, зафиксированные в коде

- **`window._sharesData`** — глобальный массив для event handlers кнопок в таблице (стандартный паттерн для динамически генерируемых строк)
- **`_shareModalMode`** / **`_shareModalData`** — модульные переменные состояния modal (create vs edit)
- **SMB reload**: `systemctl reload smbd` (не restart) — более мягкий, не рвёт активные соединения
- **NFS**: `exportfs -ra` после каждого изменения — полная пересинхронизация
- **Volume select в edit mode**: disabled `<select>` с одним элементом (текущий путь) — вместо отдельного input для простоты

### Файлы изменены

| Файл | Строк (было → стало) | Тип |
|------|----------------------|-----|
| `cockpit/rusnas/index.html` | 445 → 297 | Полная реструктуризация |
| `cockpit/rusnas/js/app.js` | 1132 → 873 | Рефактор (-259 строк) |
| `cockpit/rusnas/css/style.css` | 1240 → 1266 | +26 строк (3 класса) |
