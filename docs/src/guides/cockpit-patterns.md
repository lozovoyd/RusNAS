# Паттерны Cockpit-плагина RusNAS

## Общие правила

### CSP (Content Security Policy)

```json
// manifest.json
"content-security-policy": "... 'unsafe-inline' 'unsafe-eval' ..."
```

!!! warning "Inline handlers запрещены CSP"
    ```javascript
    // ✗ НЕЛЬЗЯ
    element.onclick = handler;
    // <button onclick="doSomething()">

    // ✓ ПРАВИЛЬНО
    element.addEventListener('click', handler);
    ```

### Пути к cockpit.js

```html
<script src="../base1/cockpit.js"></script>
```

## Паттерны взаимодействия с системой

### cockpit.spawn — sudoers NOPASSWD

Каждый модуль имеет свой файл в `/etc/sudoers.d/`:

| Модуль | Sudoers файл | Команды |
|--------|-------------|---------|
| Guard | rusnas-guard | — (socket, не sudo) |
| Snapshots | (inline) | /usr/local/bin/rusnas-snap |
| Dedup | install-dedup.sh | systemctl, tee, rm |
| UPS | rusnas-nut | upsc, nut-scanner, systemctl |
| Storage Analyzer | rusnas-storage | python3 scripts |
| Network | rusnas-network | python3 network-api.py |
| SSD Tier | rusnas-ssd-tier | pvcreate, vgcreate, lvcreate... |
| Containers | rusnas-containers | python3 container_api.py |
| Spindown | rusnas-spindown | python3 spindown_ctl.py |

### Guard Socket Protocol

```javascript
// Подключение к Unix socket Guard
var ch = cockpit.channel({
    payload: "stream",
    unix: "/run/rusnas-guard/control.sock"
    // НЕ добавлять superuser: "require"!
});

// Отправка команды
ch.send(JSON.stringify({ cmd: "status" }) + "\n");

// Получение ответа
ch.addEventListener("message", function(ev, data) {
    var resp = JSON.parse(data);
});
```

### Запись в /proc/sys/ (Performance Tuner)

```javascript
// Без sudoers! Через cockpit.file superuser
function writeSysFile(path, val) {
    return cockpit.file(path, { superuser: "require" }).replace(String(val));
}

// Конвертация sysctl → /proc/sys/
function sysctlPath(param) {
    return "/proc/sys/" + param.replace(/\./g, "/");
}

// Пример: vm.swappiness → /proc/sys/vm/swappiness
writeSysFile(sysctlPath("vm.swappiness"), "10");
```

## Типичные ошибки (и фиксы)

| Ошибка | Причина | Решение |
|--------|---------|---------|
| `escHtml(null)` → TypeError | Нет проверки на null | `String(s \|\| "").replace(...)` |
| Несколько `setInterval` | Не очищен предыдущий | `if (_timer) clearInterval(_timer)` |
| `Promise.all().then()` без `.catch()` | Необработанный rejection | Всегда добавлять `.catch()` |
| `results.push()` в параллельных callbacks | Race condition | `results[idx] = ...` с индексом |
| `worstStatus` при нескольких массивах | Перезаписывает более критичный | Приоритет: inactive > degraded > resyncing > active |
| `setTimeout(300)` для синхронизации | Ненадёжная гонка | Возвращать Promise, использовать `.then()` |

## Viewport meta (обязательно)

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

Без этого мобильные браузеры игнорируют `@media` queries.

## Breakpoints

- `@media (max-width: 768px)` — таблетки, таблицы → блоки
- `@media (max-width: 480px)` — телефоны, full-width кнопки, iOS zoom fix
