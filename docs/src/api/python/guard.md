# API демона Guard

**rusnas-guard** — демон антишифровальщика. Обнаруживает и блокирует ransomware-атаки в реальном времени.

- **Размещение:** `/usr/lib/rusnas-guard/`
- **Сервис:** `rusnas-guard.service` (systemd, always-on)
- **Сокет:** `/run/rusnas-guard/control.sock` (JSON-RPC)
- **Спецификация:** [Guard ТЗ](../../specs/guard.md)

## guard.py — Точка входа

Главный файл демона. Запускает socket-сервер и поток детектора.

::: guard

## detector.py — Наблюдатель inotify

Мониторинг файловой системы через inotify. 4 метода обнаружения.

::: detector

## entropy.py — Энтропия Шеннона

Вычисление энтропии Шеннона для обнаружения зашифрованных файлов.

::: entropy

## honeypot.py — Файлы-приманки

Управление файлами-приманками в контролируемых директориях.

::: honeypot

## response.py — Реагирование

Реагирование на атаки: создание снапшотов, блокировка IP, остановка сервисов.

::: response

## socket_server.py — Unix-сокет JSON-RPC

Сервер управления Guard через Unix domain socket.

::: socket_server
