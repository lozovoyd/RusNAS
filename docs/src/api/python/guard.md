# Guard Daemon API

**rusnas-guard** — демон антишифровальщика. Обнаруживает и блокирует ransomware-атаки в реальном времени.

- **Размещение:** `/usr/lib/rusnas-guard/`
- **Сервис:** `rusnas-guard.service` (systemd, always-on)
- **Сокет:** `/run/rusnas-guard/control.sock` (JSON-RPC)
- **Спецификация:** [Guard ТЗ](../../specs/guard.md)

## guard.py — Entry Point

Главный файл демона. Запускает socket server и detector thread.

::: guard

## detector.py — inotify Watcher

Мониторинг файловой системы через inotify. 4 метода обнаружения.

::: detector

## entropy.py — Shannon Entropy

Вычисление энтропии Шеннона для обнаружения зашифрованных файлов.

::: entropy

## honeypot.py — Bait Files

Управление файлами-приманками в контролируемых директориях.

::: honeypot

## response.py — Blocking & Snapshots

Реагирование на атаки: создание снапшотов, блокировка IP, остановка сервисов.

::: response

## socket_server.py — Unix Socket JSON-RPC

Сервер управления Guard через Unix domain socket.

::: socket_server
