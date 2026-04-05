# ADR-002: Podman вместо Docker

## Статус
Принято (2026-03)

## Контекст
Для Container Manager нужен контейнерный runtime. Docker требует отдельный daemon (dockerd) — единая точка отказа. На Debian 13 Podman доступен из стандартных репозиториев.

## Решение
Podman как контейнерный runtime. Совместим с Docker CLI и docker-compose (через podman-compose). Daemonless архитектура — контейнеры как обычные процессы.

## Последствия
- ✅ Нет daemon — нет единой точки отказа
- ✅ Совместимость с docker-compose файлами через podman-compose
- ✅ Нативный пакет в Debian 13
- ⚠️ Rootless Podman на QEMU VM требует D-Bus (aardvark-dns) — приходится запускать от root
- ⚠️ aardvark-dns слушает только на первом bridge (10.89.0.1) — workaround: network_mode: host для межконтейнерной связи
- ❌ podman-compose менее зрелый чем docker-compose (нет --no-color и др. флагов)
