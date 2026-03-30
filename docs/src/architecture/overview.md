# Обзор архитектуры

## Уровневая модель

| Уровень | Компонент | Технология |
|---------|-----------|------------|
| L1. Аппаратный | Диски HDD/SSD/NVMe, NIC, UPS | SATA/SAS/NVMe, Ethernet |
| L2. Ядро ОС | md (RAID), dm-cache, inotify, nftables | Linux 6.x |
| L3. Хранилище | mdadm, Btrfs, LVM | Программный RAID + CoW FS |
| L4. Сетевые сервисы | Samba, knfsd, vsftpd, Apache WebDAV, LIO | SMB/NFS/FTP/WebDAV/iSCSI |
| L5. Демоны | Guard, spind, metrics_server, NUT | Python 3, systemd |
| L6. API/CGI | network-api, container_api, storage-analyzer-api | Python 3, cockpit.spawn |
| L7. Веб-интерфейс | Cockpit + RusNAS плагин (12 страниц) | HTML5/CSS3/JS ES5 |
| L8. Reverse proxy | nginx (:80/:443) | HTTP/HTTPS |
| L9. Контейнеры | Podman (10 приложений) | OCI, podman-compose |

## Компонентная диаграмма

```mermaid
graph TB
    Browser["Браузер администратора"]
    Browser -->|HTTPS :443| nginx

    subgraph "nginx reverse proxy"
        nginx -->|:9090| Cockpit
        nginx -->|:8088| FileBrowser
        nginx -->|:8091| Apache["Apache WebDAV"]
        nginx -->|dynamic| Apps["Container Apps"]
    end

    subgraph "Cockpit + RusNAS Plugin"
        Cockpit --> Dashboard
        Cockpit --> Storage
        Cockpit --> Disks
        Cockpit --> Guard_UI["Guard UI"]
        Cockpit --> Snapshots
        Cockpit --> Network_UI["Network UI"]
        Cockpit --> AI_UI["AI UI"]
        Cockpit --> Perf["Performance"]
    end

    subgraph "Backend Daemons"
        Guard["rusnas-guard.service"]
        Metrics["rusnas-metrics.service"]
        Spind["rusnas-spind.service"]
        SnapTimer["rusnas-snapd.timer"]
        CollectorTimer["storage-collector.timer"]
    end

    subgraph "System Services"
        Samba["smbd (SMB)"]
        NFS["knfsd (NFS)"]
        FTP["vsftpd (FTP)"]
        iSCSI["LIO (iSCSI)"]
        NUT["nut-server (UPS)"]
    end

    subgraph "Storage Stack"
        Btrfs --> mdadm
        mdadm --> Disks_HW["HDD/SSD"]
        LVM["LVM dm-cache"] --> SSD["SSD Cache"]
    end

    Dashboard -.->|cockpit.spawn| Metrics
    Guard_UI -.->|Unix socket| Guard
    Disks -.->|cockpit.spawn| mdadm
    Snapshots -.->|cockpit.spawn| SnapCLI["rusnas-snap CLI"]
```

## Ключевые архитектурные решения

### Btrfs + mdadm вместо ZFS

ZFS не поддерживает онлайн-миграцию уровня RAID (5→6), что является жёстким бизнес-требованием. Btrfs + mdadm предоставляет:

- Снапшоты (CoW, мгновенные)
- Online resize
- Subvolumes
- Reflinks (дедупликация)
- `mdadm --grow --level` для апгрейда RAID

### Cockpit как UI-платформа

- PAM-аутентификация (системные учётки)
- WebSocket-транспорт (cockpit.spawn, cockpit.file)
- Модульная система плагинов
- Авто-reload при обновлении файлов

### nginx как единая точка входа

```
:80/:443 → nginx
  /cockpit/    → :9090 (Cockpit)
  /files/      → :8088 (FileBrowser)
  /webdav/     → :8091 (Apache)
  /nextcloud/  → :8080 (Container)
  /chat/       → :3000 (Rocket.Chat, 3 location блока)
```
