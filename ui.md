# UI Guidelines — rusNAS Cockpit Plugin

## Core principle

All pages must use CSS custom properties defined in `css/style.css`. **Never hardcode colors, backgrounds, or borders inline.** This ensures automatic light/dark mode support.

## Dark mode

Cockpit v337+ propagates the user's theme to plugin iframes via the `color-scheme` CSS property. To receive it:

```html
<meta name="color-scheme" content="light dark">
```

Then use `@media (prefers-color-scheme: dark)` in CSS — it correctly responds to both the OS setting and Cockpit's manual theme toggle.

**Never** hardcode colors like `background: #fff` or `color: #151515` outside of the `:root` / dark media query blocks in `style.css`.

## CSS variables reference

All tokens are defined in `css/style.css`. Key variables:

| Variable | Usage |
|----------|-------|
| `--bg` | Page background |
| `--bg-card` | Card/section background |
| `--bg-input` | Input, select background |
| `--bg-th` | Table header background |
| `--color` | Primary text |
| `--color-muted` | Secondary/hint text |
| `--color-border` | All borders and dividers |
| `--primary` | Primary action color |
| `--danger` | Destructive action color |
| `--success` | Positive status color |
| `--warning` | Warning color |

## Page structure

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

Use `.section-toolbar` whenever a section header has an action button next to it. Plain `<h2>` without toolbar is also valid.

## Buttons

```html
<!-- Variants -->
<button class="btn btn-primary">Сохранить</button>
<button class="btn btn-secondary">Обновить</button>
<button class="btn btn-danger">Удалить</button>
<button class="btn btn-success">+ Добавить</button>
<button class="btn btn-warning">▶ Запустить</button>
<button class="btn btn-default">Отмена</button>

<!-- Small size (for table rows) -->
<button class="btn btn-danger btn-sm">Удалить</button>

<!-- Group -->
<div class="btn-group">
    <button class="btn btn-secondary">A</button>
    <button class="btn btn-secondary">B</button>
</div>
```

## Tables

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

Table headers are automatically uppercase, muted, and smaller via CSS.

## Badges

```html
<span class="badge badge-success">🟢 Активен</span>
<span class="badge badge-warning">🟡 Деградирован</span>
<span class="badge badge-danger">🔴 Неактивен</span>
<span class="badge badge-info">🔵 Синхронизация</span>
<span class="badge badge-secondary">система</span>
```

## Alerts (banner notifications)

```html
<div class="alert alert-danger">🔴 Текст ошибки. <a href="#">Действие</a></div>
<div class="alert alert-warning">🟡 Предупреждение.</div>
<div class="alert alert-info">🔵 Информация.</div>
```

## Modals

```html
<div class="modal-overlay hidden" id="my-modal">
    <div class="modal-box">
        <h3>Заголовок модала</h3>

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

Modal helpers (`showModal`/`closeModal`) must be defined in each page's JS file — they are **not** shared between pages:

```javascript
function showModal(id)  { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }
```

## Forms

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

<!-- Disabled field -->
<input type="text" id="readonly-field" disabled>

<!-- Checkbox -->
<label class="checkbox-label">
    <input type="checkbox" id="flag"> Включить
</label>

<!-- Checkbox group with scroll -->
<div class="checkbox-group" id="users-list"></div>
```

Disabled inputs get muted background and text automatically from CSS — **do not** add `style="background:#f0f0f0"` inline.

## Status and text helpers

```html
<span class="status-active">Активна</span>
<span class="status-inactive">Неактивна</span>

<span class="text-success">Хорошо</span>
<span class="text-warning">Внимание</span>
<span class="text-danger">Ошибка</span>
<span class="text-muted">Подсказка</span>
```

## RAID-specific components

```html
<!-- Array card -->
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
    <div class="array-slots">
        <span class="slot-ok">▪</span><span class="slot-missing">✕</span>
    </div>
    <!-- Progress bar (used when resyncing) -->
    <div class="progress-wrap">
        <div class="progress-bar" style="width: 42%"></div>
        <span>42%</span>
    </div>
    <div class="array-devices">
        <div class="device-row">🟢 <b>/dev/sdb</b> <small class="text-muted">(активен)</small></div>
    </div>
    <div class="array-hint">RAID 5 — выдержит отказ 1 диска.</div>
</div>

<!-- Warning box (before destructive action) -->
<div class="eject-warning">⚠ <b>Данные будут уничтожены.</b><br>...</div>

<!-- Info box (detail summary) -->
<div class="eject-details">
    <b>Диск:</b> /dev/sdb<br>
    <b>Серийный номер:</b> <code>WD-123456</code>
</div>

<!-- Mode description boxes -->
<div class="mode-info mode-replace">🔄 Замена диска...</div>
<div class="mode-info mode-expand">⤢ Расширение массива...</div>
```

## Fonts

Cockpit's Red Hat Text font is referenced via:
```css
@font-face {
    font-family: "Red Hat Text";
    src: url(../../static/fonts/RedHatText/RedHatTextVF.woff2) format("woff2-variations");
}
```

The `../../static/` path resolves relative to `css/style.css` → `/usr/share/cockpit/static/`.

## CSP rules

From `manifest.json`:
```json
"content-security-policy": "default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'"
```

- `onclick="..."` in dynamically generated innerHTML **is allowed** (unsafe-inline covers it)
- Static HTML elements must use `addEventListener` — inline handlers on static elements are a bad practice even when allowed
- Inline `style="width: X%"` on elements (e.g. progress bar) is allowed

## Storage Analyzer — UI Components

### Squarified Treemap
Interactive SVG treemap for file/folder visualization.

```html
<!-- Container -->
<div class="sa-treemap-wrap" id="treemapWrap"></div>
<div class="sa-treemap-tooltip" id="treemapTooltip" style="display:none"></div>
```

```javascript
// Data format: [{name, type, bytes, files?, mtime}]
// squarify(items, x, y, w, h) → [{label, value, entry, color, x, y, w, h}]
// guessColor(entry) → hex color based on file extension
renderTreemap(entries, containerElement);
```

**Behavior:**
- Rectangles colored by file type (video=red, photo=orange, docs=blue, archive=purple, backup=teal, code=green, other=gray)
- Hover → tooltip with name, size, file count, last modified
- Click on dir → navigates into it (`navigateTo(path)`)
- Breadcrumb navigation at top
- Labels shown only when rect is wide enough (w>60 && h>30)

### Donut Chart
SVG arc-based donut for file type distribution.

```javascript
// breakdown: [{type, bytes, color, label, count, change_7d}]
renderDonut(svgElement, breakdown, totalBytes);
```

**Structure:** SVG arc paths with 0.02 rad gap; click → filter Files tab by type.

### SVG Fill Chart
Line chart showing volume usage over time with forecast.

```javascript
// Called with overviewData (from API 'overview' command)
// chartPeriod global (7/30/90 days) controls X range
renderFillChart(overviewData);
```

**Features:** X/Y axes with labels, 95% danger threshold line (red dashed), forecast dashed line (orange), "сейчас" vertical marker.

### Sparkline
Mini inline line chart for share/user history.

```javascript
// values: array of numbers
buildSparkline(values, width, height) → SVG string
```

### SA Page Header
```html
<div class="sa-page-header">
  <div class="sa-page-header-left">
    <h2>💾 Анализ пространства</h2>
    <div class="sa-scan-info">...</div>
  </div>
  <div class="sa-page-header-right">
    <button class="btn btn-primary" id="btnScanNow">🔄 Сканировать сейчас</button>
  </div>
</div>
<div class="sa-scan-progress" id="scanProgress" style="display:none">
  <div class="sa-scan-progress-bar"></div>
</div>
```

### SA Summary Cards
```html
<div class="sa-cards-row">  <!-- CSS grid 4 columns -->
  <div class="sa-card sa-card-stat">
    <div class="sa-card-label">LABEL</div>
    <div class="sa-card-value">VALUE</div>
    <div class="sa-bar-wrap"><div class="sa-bar-fill" style="width:X%;background:COLOR"></div></div>
    <div class="sa-card-sub">subtitle</div>
  </div>
</div>
```

Bar color logic: `barColor(pct)` → `--success` (<70%), `--warning` (<85%), `#FF6F00` (<95%), `--danger` (≥95%).

### Forecast Display
```html
<div class="sa-forecast-lines">
  <div class="sa-forecast-row"><span class="sa-fl-label">24ч:</span><span class="sa-fl-val sa-fc-ok|warn|critical|nodata">N дн.</span></div>
  <div class="sa-forecast-row sa-fl-main"><!-- 7d trend, larger font --></div>
  <div class="sa-forecast-row"><!-- 30d trend --></div>
</div>
```

### Volume Cards
```html
<div class="sa-volumes-grid">  <!-- auto-fill minmax(280px,1fr) -->
  <div class="sa-vol-card">  <!-- cursor:pointer, click → files tab -->
    <div class="sa-vol-name">/mnt/data</div>
    <div class="sa-vol-meta">/dev/md0 • btrfs</div>
    <div class="sa-vol-bar-wrap"><div class="sa-vol-bar" style="width:X%;background:COLOR"></div></div>
    <div class="sa-vol-sizes"><span>used / total</span><span class="sa-vol-pct">X%</span></div>
  </div>
</div>
```

### SA Table
```html
<table class="table sa-table">
  <thead><tr><th>Col</th></tr></thead>
  <tbody>
    <tr class="sa-share-row"><td class="sa-path-cell">path</td>
      <td class="sa-delta-up">+5 ГБ</td>   <!-- positive growth = danger color -->
      <td class="sa-delta-down">-2 ГБ</td> <!-- negative = success color -->
    </tr>
  </tbody>
</table>
```

### SA Filters Bar
```html
<div class="sa-filters">
  <div class="sa-filter-group">
    <label>Label</label>
    <select class="form-control sa-select-sm">...</select>
  </div>
</div>
```

### Quota Bar
```html
<div class="sa-quota-bar-wrap">
  <div class="sa-quota-bar sa-quota-warn" style="width:X%"></div>
</div>
```
Classes: `.sa-quota-warn` (warning color), `.sa-quota-critical` (danger color).
