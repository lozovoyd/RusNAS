# UI Guidelines — rusNAS Cockpit Plugin

> Актуальная версия: после редизайна 2026-03-20. Использовать как основу для ВСЕХ новых страниц и компонентов.

## Принципы

- Всё через CSS-переменные — никаких хардкодных цветов вне `:root` / dark-media-query
- Slate-цветовая система: синий (#2563eb) + slate (fon) + семантические цвета
- «Приподнятые» карточки: белые на сером фоне в свет. теме; shadow + border-radius
- Минимализм + информационная плотность: корпоративный NAS, не consumer product

## Тёмная тема

Cockpit v337+ передаёт тему плагину через `color-scheme` CSS. Для поддержки:

```html
<meta name="color-scheme" content="light dark">
```

Затем `@media (prefers-color-scheme: dark)` в CSS — реагирует на OS и ручной тоггл в Cockpit.

**Никогда** не хардкодить `background: #fff` или `color: #151515` вне блоков `:root` / dark media query в `style.css`.

---

## Дизайн-токены (CSS переменные)

Все токены определены в `css/style.css`. Два набора: `:root` (свет) и `@media (prefers-color-scheme: dark)` (темн).

### Фоны

| Переменная | Светлая | Тёмная | Назначение |
|------------|---------|--------|------------|
| `--bg` | `#f1f5f9` | `#0f172a` | Фон страницы (тело) |
| `--bg-card` | `#ffffff` | `#1e293b` | Карточка / секция |
| `--bg-input` | `#ffffff` | `#1e293b` | Поле ввода, select |
| `--bg-th` | `#f8fafc` | `#162032` | Заголовок таблицы, вторичный bg |
| `--bg-row-hover` | `#e8edf3` | `#243447` | Hover строки таблицы |
| `--bg-disabled` | `#f8fafc` | `#162032` | Отключённый input |

### Текст и границы

| Переменная | Светлая | Тёмная | Назначение |
|------------|---------|--------|------------|
| `--color` | `#0f172a` | `#f1f5f9` | Основной текст |
| `--color-muted` | `#64748b` | `#94a3b8` | Второстепенный текст |
| `--color-border` | `#e2e8f0` | `#334155` | Все границы и делители |
| `--color-link` | `#2563eb` | `#60a5fa` | Ссылки |

### Цвета действий

| Переменная | Светлая | Тёмная |
|------------|---------|--------|
| `--primary` | `#2563eb` | `#3b82f6` |
| `--primary-hover` | `#1d4ed8` | `#60a5fa` |
| `--primary-light` | `#eff6ff` | `#172554` |
| `--primary-border` | `#bfdbfe` | `#1d4ed8` |
| `--danger` | `#dc2626` | `#ef4444` |
| `--warning` | `#d97706` | `#f59e0b` |
| `--success` | `#16a34a` | `#22c55e` |

### Тени и форма

| Переменная | Светлая | Тёмная |
|------------|---------|--------|
| `--card-shadow` | `0 1px 3px rgba(0,0,0,0.09), 0 2px 6px rgba(0,0,0,0.05)` | `0 1px 4px rgba(0,0,0,0.4)` |
| `--card-shadow-hover` | `0 4px 20px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.07)` | `0 4px 16px rgba(0,0,0,0.55)` |
| `--radius-sm` | `5px` | (то же) |
| `--radius` | `10px` | (то же) |
| `--radius-lg` | `14px` | (то же) |

---

## Структура страницы

```html
<body>
    <h1>rusNAS — Заголовок страницы</h1>

    <div class="section">
        <div class="section-toolbar">
            <h2>Заголовок секции</h2>
            <button class="btn btn-success">+ Добавить</button>
        </div>
        <table>...</table>
    </div>
</body>
```

- `.section-toolbar` — flex-строка с h2 + кнопкой действия
- Plain `<h2>` без toolbar тоже допустим

---

## Кнопки

```html
<button class="btn btn-primary">Сохранить</button>
<button class="btn btn-secondary">Обновить</button>
<button class="btn btn-danger">Удалить</button>
<button class="btn btn-success">+ Добавить</button>
<button class="btn btn-warning">▶ Запустить</button>
<button class="btn btn-default">Отмена</button>

<!-- Маленькие (для строк таблицы) -->
<button class="btn btn-danger btn-sm">Удалить</button>

<!-- Группа -->
<div class="btn-group">
    <button class="btn btn-secondary">A</button>
    <button class="btn btn-secondary">B</button>
</div>
```

**Дизайн:** все кнопки с `box-shadow` для визуального веса; hover усиливает тень. Disabled — `opacity: 0.45`.

---

## Таблицы

```html
<table>
    <thead>
        <tr><th>Имя</th><th>Статус</th><th>Действия</th></tr>
    </thead>
    <tbody id="my-body">
        <tr><td colspan="3">Загрузка...</td></tr>
    </tbody>
</table>
<p class="table-hint">Подсказка под таблицей</p>
```

- Заголовки — uppercase, muted, 11px, `var(--bg-th)` фон
- `tbody tr:hover { background: var(--bg-row-hover) }` — заметный hover (сменён с #f1f5f9 на #e8edf3 в свет. теме)
- Последняя строка без `border-bottom`

---

## Навигационные вкладки

### Pill-стиль (`advisor-tabs`) — основной

Используется на Storage, Snapshots, Dedup, FileBrowser, RAID wizard:

```html
<div class="advisor-tabs">
    <button class="advisor-tab-btn active">📂 Шары</button>
    <button class="advisor-tab-btn">🎯 iSCSI</button>
    <button class="advisor-tab-btn">⚙️ Сервисы</button>
</div>
```

```css
/* Активная вкладка — pill (применяется в JS) */
.advisor-tab-btn.active {
    background: var(--primary);
    color: #ffffff;
    font-weight: 600;
    box-shadow: 0 1px 4px color-mix(in srgb, var(--primary) 40%, transparent);
}
```

**Правило:** `advisor-tab-btn.active` = синий pill (`--primary` bg, белый текст). Не underline, не border — только pill.

### Underline-стиль (`tabs` / `tab-btn`) — Guard, вложенные

```html
<div class="tabs">
    <button class="tab-btn tab-active">Обзор</button>
    <button class="tab-btn">Журнал</button>
</div>
<div class="tab-panel">...</div>
```

---

## Модальные окна

```html
<div class="modal-overlay hidden" id="my-modal">
    <div class="modal-box">
        <h3>Заголовок</h3>

        <div class="form-group">
            <label>Поле</label>
            <input type="text" id="field" placeholder="...">
        </div>

        <div class="modal-footer">
            <button class="btn btn-primary" id="btn-save">Сохранить</button>
            <button class="btn btn-default" id="btn-cancel">Отмена</button>
        </div>
    </div>
</div>
```

**Дизайн деталей:**
- `backdrop-filter: blur(2px)` — размытие фона
- `animation: modal-in 0.18s ease` — slide+scale вход (`translateY(-10px) scale(0.98)` → `translateY(0) scale(1)`)
- `border-radius: var(--radius-lg)` = 14px — более округлый чем обычные карточки
- `box-shadow: var(--modal-shadow)` — глубокая тень

Для широких модалов (RAID wizard, мониторинг):
```html
<div class="modal-box modal-box-wide">   <!-- 820px -->
```

Или с явной шириной:
```html
<div class="modal-box" style="width:760px;max-width:96vw">
```

Хелперы:
```javascript
function showModal(id)  { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }
```

---

## Формы

```html
<div class="form-group">
    <label>Имя</label>
    <input type="text" id="name">
</div>

<div class="form-group">
    <label>Тип</label>
    <select id="type">
        <option value="a">Вариант A</option>
    </select>
</div>

<!-- Disabled — мuted фон и текст автоматически -->
<input type="text" disabled>

<!-- Checkbox -->
<label class="checkbox-label">
    <input type="checkbox" id="flag"> Включить
</label>

<!-- Checkbox group со скроллом -->
<div class="checkbox-group" id="users-list"></div>
```

**Focus ring:** `border-color: var(--primary)` + `box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent)` — работает в обеих темах через `color-mix`.

---

## Badges (бейджи)

```html
<span class="badge badge-success">🟢 Активен</span>
<span class="badge badge-warning">🟡 Деградирован</span>
<span class="badge badge-danger">🔴 Неактивен</span>
<span class="badge badge-info">🔵 Синхронизация</span>
<span class="badge badge-secondary">система</span>
```

---

## Уведомления (alerts)

```html
<div class="alert alert-danger">🔴 Текст ошибки. <a href="#">Действие</a></div>
<div class="alert alert-warning">🟡 Предупреждение.</div>
<div class="alert alert-info">🔵 Информация.</div>
```

---

## Текстовые хелперы

```html
<span class="status-active">Активна</span>
<span class="status-inactive">Неактивна</span>
<span class="text-success">Хорошо</span>
<span class="text-warning">Внимание</span>
<span class="text-danger">Ошибка</span>
<span class="text-muted">Подсказка</span>
```

---

## Dashboard — компоненты (`dashboard.html` / `dashboard.css`)

### Карточки метрик (`db-card`)

```html
<div class="db-card db-card-ok" id="card-cpu" style="cursor:pointer">
    <div class="db-card-icon">⚡</div>
    <div class="db-card-title">CPU</div>
    <div class="db-card-metric db-ok" id="cpu-pct">—%</div>
    <div class="db-progress-bar">
        <div class="db-progress-fill" id="cpu-bar" style="width:0%"></div>
    </div>
    <div class="db-card-sub" id="cpu-detail">— ядер</div>
</div>
```

**Статус-акцент слева:**
- `.db-card-ok` — зелёная полоска (`--success`)
- `.db-card-warn` — жёлтая (`--warning`)
- `.db-card-crit` — красная (`--danger`)
- `.db-card-blue` — синяя (`--primary`)

**Hover:** `translateY(-1px)` + `var(--card-shadow-hover)` + `border-color: var(--primary)`

**Progress fill gradient:**
- Normal: `linear-gradient(90deg, var(--success), color-mix(...))`
- `.warn`: жёлтый gradient
- `.crit`: красный gradient

### Статус-точки (`db-status-dot`)

```html
<div class="db-status-dot db-dot-green"></div>
```

**Классы:**
- `.db-dot-green` — зелёный + ring-glow (`box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 25%, transparent)`)
- `.db-dot-blue` — синий + ring-glow
- `.db-dot-orange` — жёлтый + ring-glow
- `.db-dot-red` — красный + ring-glow + `animation: db-blink` (мигает)
- `.db-dot-purple` — фиолетовый + ring-glow
- `.db-dot-gray` — серый (неактивен)

**Правило:** ring-glow через `color-mix(in srgb, COLOR 25%, transparent)` — адаптируется к обеим темам.

### Sparklines (SVG-графики)

Рендерятся в JS через `renderSparkline(svgId, values, color)` и `renderDualSparkline(svgId, v1, c1, v2, c2)`.

**Дизайн:**
- Кубическая Безье (`C` SVG команды, tension=0.35) — плавные линии
- Area gradient fill: `opacity 0.22 → 0` (single) / `0.18 → 0` + `0.14 → 0` (dual)
- Endpoint dot: `<circle r="2.5">` на последней точке
- Grid lines: горизонтальные на 33%/66% со `stroke-opacity="0.07"`
- Высота: 56px (обычный) / 64px (Disk I/O)

```html
<svg id="spark-cpu" class="db-sparkline"></svg>   <!-- 56px by CSS -->
<svg id="spark-io"  class="db-sparkline" style="height:64px"></svg>
```

**Цвета:**
- CPU: `#22aa44` (нормальный) → `#e68a00` (высокий >80%) → `#cc2200` (критический >95%)
- RAM: `#0066cc` → `#e68a00` → `#cc2200`
- Net RX: `#22c55e`, Net TX: `#f97316`
- IO Read: `#3b82f6`, IO Write: `#f97316`

### Dual-line legend

```html
<div class="db-spark-legend">
    <span class="db-spark-legend-item" style="color:#22c55e">↓ <span id="net-rx-val">—</span></span>
    <span class="db-spark-legend-item" style="color:#f97316">↑ <span id="net-tx-val">—</span></span>
</div>
```

### Grid layouts

```html
<div class="db-grid-4"><!-- 4 колонки, коллапс до 2 на ≤1100px, до 1 на ≤700px --></div>
<div class="db-grid-3"><!-- 3 колонки, коллапс до 2 на ≤1100px, до 1 на ≤700px --></div>
```

---

## CPU Monitor Modal (Монитор ресурсов)

Открывается по клику на карточку CPU дашборда. Показывает real-time данные как htop.

```html
<!-- Структура -->
<div class="modal-overlay hidden" id="cpu-modal">
  <div class="modal-box" style="width:780px;max-width:96vw">
    <!-- header с кнопкой закрытия -->
    <div class="cm-grid">
      <div class="cm-section">  <!-- CPU cores -->
        <div class="cm-cores-wrap" id="cm-cpu-cores">...</div>
      </div>
      <div class="cm-section">  <!-- Memory + Load -->
        <div class="cm-load-grid">
          <div class="cm-load-item"><div class="cm-load-val" id="cm-la1">—</div>...</div>
        </div>
      </div>
    </div>
    <div class="cm-section">  <!-- Process list -->
      <div class="cm-proc-head">...</div>
      <div id="cm-proc-list">...</div>
    </div>
  </div>
</div>
```

**Цвета баров:**
- CPU/Mem 0–59%: `#22c55e` (зелёный)
- CPU/Mem 60–79%: `#f59e0b` (жёлтый)
- CPU/Mem ≥80%: `#ef4444` (красный)
- RAM: `#3b82f6` (синий, меняется на желт/красн при высокой нагрузке)
- Swap: `#a855f7` (фиолетовый)

**JS функции:** `openCpuModal()`, `closeCpuModal()`, `refreshCpuModal()` (1s interval).

---

## RAID компоненты (`disks.html`)

```html
<div class="array-card">
    <div class="array-header">
        <div>
            <span class="array-name">md0</span>
            <span class="array-level">RAID5</span>
            <span class="array-size">100.0 GB</span>
        </div>
        <div class="array-actions">
            <button class="btn btn-secondary btn-sm">Расширить</button>
        </div>
    </div>
    <div class="array-status">
        <span class="badge badge-success">🟢 Активен</span>
        <span class="status-desc">Работает нормально.</span>
    </div>
    <div class="progress-wrap">
        <div class="progress-bar" style="width: 42%"></div>
        <span>42%</span>
    </div>
    <div class="array-hint">RAID 5 — выдержит отказ 1 диска.</div>
</div>

<div class="eject-warning">⚠ <b>Данные будут уничтожены.</b></div>
<div class="eject-details">Диск: /dev/sdb<br>S/N: <code>WD-123456</code></div>
<div class="mode-info mode-replace">🔄 Замена...</div>
<div class="mode-info mode-expand">⤢ Расширение...</div>
```

**`.array-level` badge** — `--primary-light` фон + `--primary` текст + `--primary-border` граница. Pill shape.

---

## Guard компоненты (`guard.html`)

```html
<!-- Pipeline step -->
<div class="gd-pipeline">
    <div class="gd-step gd-step-blue">
        <div class="gd-step-icon">👁</div>
        <div class="gd-step-title">Мониторинг</div>
        <div class="gd-step-sub">inotify watcher</div>
    </div>
    <span class="gd-arrow">→</span>
</div>

<!-- Method card -->
<div class="gd-method">
    <div class="gd-method-icon" style="background:rgba(37,99,235,0.1)">🔍</div>
    <div class="gd-method-name">Расширения</div>
    <div class="gd-method-desc">...</div>
</div>

<!-- Mode card -->
<div class="gd-mode gd-mode-active">
    <div class="gd-mode-header">
        <div class="gd-mode-dot" style="background:var(--success)"></div>
        <span class="gd-mode-name">Защита</span>
        <span class="gd-mode-rec">Рекомендуется</span>
    </div>
</div>
```

---

## Storage Analyzer (`storage-analyzer.html`)

### Treemap, Donut, Sparkline

```javascript
// Squarified treemap: fills sa-treemap-wrap
renderTreemap(entries, containerElement);

// Donut chart
renderDonut(svgElement, breakdown, totalBytes);

// Mini sparkline (returns SVG string)
buildSparkline(values, width, height);
```

### Компоненты

```html
<div class="sa-cards-row">   <!-- 4-column grid -->
  <div class="sa-card sa-card-stat">
    <div class="sa-card-label">LABEL</div>
    <div class="sa-card-value">VALUE</div>
    <div class="sa-bar-wrap"><div class="sa-bar-fill" style="width:X%;background:COLOR"></div></div>
  </div>
</div>

<div class="sa-volumes-grid">  <!-- auto-fill minmax(280px,1fr) -->
  <div class="sa-vol-card">...</div>
</div>
```

---

## SSD кеш компоненты

```html
<div class="ssd-bar-wrap">
    <div class="ssd-bar-fill" style="width:65%"></div>
</div>
<span class="ssd-mode-wt">WT</span>   <!-- WriteThrough: зелёный -->
<span class="ssd-mode-wb">WB</span>   <!-- WriteBack: жёлтый -->
```

---

## Шрифты

Cockpit включает Red Hat Text:
```css
@font-face {
    font-family: "Red Hat Text";
    src: url(../../static/fonts/RedHatText/RedHatTextVF.woff2) format("woff2-variations");
}
```

Путь `../../static/` = `/usr/share/cockpit/static/` (относительно `css/style.css`).

---

## CSP и JS правила

```json
"content-security-policy": "default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'"
```

- Статические HTML элементы — **только `addEventListener`**, не `onclick="..."`
- Динамически созданный innerHTML — `onclick=` разрешён (unsafe-inline)
- `targetcli` требует явный `sudo`: `cockpit.spawn(["sudo", "targetcli", ...])`
- `superuser: "require"` в iframe context вызывает polkit timeout — не использовать
- `cockpit.spawn().then().catch()` — не нативный Promise, оборачивать в `new Promise()`

---

## Мобильный / Responsive

Все HTML-страницы **обязательно** должны иметь:
```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

**Breakpoints в `style.css`:**
- `≤768px` — таблицы `display:block;overflow-x:auto`, advisor-tabs scroll, section-toolbar stack
- `≤480px` — buttons full-width, iOS font-size fix (16px)

**Breakpoints в `dashboard.css`:**
- `≤1100px` — db-grid-4/3 → 2 columns
- `≤700px` — все grids → 1 column, guard-stats 2col, cm-grid 1col
- `≤480px` — identity-bar condensed

**Правило:** при добавлении новых страниц — добавить viewport meta + проверить на 390px.

---

## ⚠️ Правило: вкладки (табы) — ТОЛЬКО advisor-tabs

### Проблема
Cockpit v300+ использует **PatternFly 4**. Bootstrap-классы `nav nav-tabs`, `<ul><li><a>` и их CSS **НЕ работают** — рендерятся как обычный маркированный список.

### ✅ Правильный паттерн

**HTML:**
```html
<div class="advisor-tabs" id="myTabs">
  <button class="advisor-tab-btn active" data-tab="tab1">Вкладка 1</button>
  <button class="advisor-tab-btn" data-tab="tab2">Вкладка 2</button>
  <button class="advisor-tab-btn" data-tab="tab3">Вкладка 3 <span class="badge" id="myBadge"></span></button>
</div>

<div class="tab-content" id="tab-tab1">...</div>
<div class="tab-content" id="tab-tab2" style="display:none">...</div>
<div class="tab-content" id="tab-tab3" style="display:none">...</div>
```

**JS — switchTab():**
```javascript
function switchTab(tabName) {
    document.querySelectorAll(".tab-content").forEach(function(el) { el.style.display = "none"; });
    document.querySelectorAll("#myTabs .advisor-tab-btn").forEach(function(btn) {
        btn.classList.remove("active");
    });
    var content = document.getElementById("tab-" + tabName);
    if (content) content.style.display = "";
    var btn = document.querySelector('#myTabs .advisor-tab-btn[data-tab="' + tabName + '"]');
    if (btn) btn.classList.add("active");
}
```

**JS — навешивание обработчиков:**
```javascript
document.querySelectorAll("#myTabs .advisor-tab-btn[data-tab]").forEach(function(btn) {
    btn.addEventListener("click", function() { switchTab(btn.dataset.tab); });
});
```

### ❌ Запрещённые паттерны

```html
<!-- НЕ РАБОТАЕТ в Cockpit: -->
<ul class="nav nav-tabs">
  <li class="active"><a href="#" data-tab="...">...</a></li>
</ul>
```

```javascript
// НЕ ИСПОЛЬЗОВАТЬ:
document.querySelectorAll("#tabs li")
document.querySelectorAll("#tabs a[data-tab]")
link.parentElement.classList.add("active")
```

### Ссылка на стили
Классы `advisor-tabs` и `advisor-tab-btn` определены в `css/style.css`. **Не переопределять и не дублировать** их в других CSS-файлах страницы.
