# Container Manager API

**container_api.py** — CGI-скрипт управления контейнерными приложениями.

- **Размещение:** `/usr/lib/rusnas/cgi/container_api.py`
- **Вызов:** `cockpit.spawn(["sudo", "-n", "python3", "/usr/lib/rusnas/cgi/container_api.py", cmd, ...])`

## Команды

| Команда | Аргументы | Описание |
|---------|-----------|----------|
| `get_catalog` | — | Список приложений из каталога |
| `get_installed` | — | Установленные контейнеры |
| `install` | `appid [params_json] [force]` | Установка приложения |
| `uninstall` | `appid` | Удаление (containers + volumes + images) |
| `start` | `appid` | Запуск контейнеров |
| `stop` | `appid` | Остановка |
| `restart` | `appid` | Перезапуск |
| `get_status` | `appid` | Статус (running/stopped/error) |
| `get_logs` | `appid [lines]` | Журналы контейнеров |
| `check_ports` | `port` | Проверка доступности порта |
| `get_resources` | `path` | RAM (МБ) + диск (ГБ) |

## Каталог приложений (10)

| App ID | Приложение | mem_limit |
|--------|-----------|-----------|
| nextcloud | Облачное хранилище | 1024M |
| immich | Фотогалерея | 2048M |
| jellyfin | Медиасервер | 1024M |
| vaultwarden | Менеджер паролей | 256M |
| home-assistant | Умный дом | 512M |
| pihole | DNS-блокировщик | 256M |
| wireguard | VPN-сервер | 128M |
| mailcow | Почтовый сервер | 2048M |
| onlyoffice | Офисный пакет | 1024M |
| rocketchat | Мессенджер | 1024M |
