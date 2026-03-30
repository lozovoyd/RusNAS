# Развёртывание

## Dev-среда

| Параметр | Значение |
|----------|----------|
| Host | Intel Mac + UTM (QEMU) |
| VM | Debian 13 Trixie, x86_64 |
| VM IP | 10.10.10.72, user: rusnas |
| SSH | `sshpass -p 'kl4389qd' ssh rusnas@10.10.10.72` |
| RAID | md127 RAID 6 (4 диска: sdb/sdc/sdd/sde) → /mnt/data |

## Деплой Cockpit-плагина

```bash
# Все файлы плагина одной командой
./deploy.sh

# Или вручную
scp -r cockpit/rusnas/* rusnas@10.10.10.72:/tmp/rusnas-plugin/
ssh rusnas@10.10.10.72 "sudo cp -r /tmp/rusnas-plugin/* /usr/share/cockpit/rusnas/"
```

!!! warning "Права доступа"
    `scp` копирует файлы с локальными permissions (часто `600`).
    Cockpit требует `644` для файлов и `755` для директорий.
    `deploy.sh` исправляет это автоматически.

Cockpit перезагружает плагины при обновлении страницы — перезапуск сервисов не нужен.

## Деплой backend-компонентов

| Компонент | Скрипт |
|-----------|--------|
| Guard daemon | `./install-guard.sh` |
| Snapshots CLI | `./install-snapshots.sh` |
| Dedup backend | `./install-dedup.sh` |
| UPS (NUT) | `./install-ups.sh` |
| Network module | `./install-network.sh` |
| SSD caching | `./install-ssd-tier.sh` |
| Storage Analyzer | `./install-storage-analyzer.sh` |
| FileBrowser | `./install-filebrowser.sh` |
| MCP AI proxy | `./install-mcp.sh` |
| Container Manager | `./install-containers.sh` |
| WORM backend | `./install-worm.sh` |
| Spindown daemon | `./install-spindown.sh` |
| Metrics server | `./rusnas-metrics-install.sh` |
| Landing page | `./deploy-landing.sh` |

## Production (обновление через apt)

```bash
# На VPS (activate.rusnas.ru)
# 1. Собрать deb-пакет
# 2. Загрузить в reprepro
# 3. Устройства получают через:
apt update && apt upgrade
```

Аутентификация apt через license server (порт 8766).
