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
