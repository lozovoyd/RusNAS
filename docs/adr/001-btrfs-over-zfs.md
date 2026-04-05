# ADR-001: Btrfs + mdadm вместо ZFS

## Статус
Принято (2026-01)

## Контекст
RusNAS — коммерческая NAS-платформа для SMB-сегмента (1000+ устройств), альтернатива Synology DSM. Ключевое бизнес-требование — online RAID level migration (например, RAID 5 → RAID 6 без остановки и потери данных). ZFS не поддерживает изменение уровня RAID (vdev topology) на лету — это жёсткое ограничение архитектуры ZFS.

## Решение
Использовать связку Btrfs (файловая система) + mdadm (RAID-уровень). mdadm обеспечивает RAID 0/1/5/6/10/F1 с поддержкой `--grow` для онлайн-миграции уровней и расширения массивов. Btrfs даёт native snapshots, online resize, reflinks, subvolumes.

## Последствия
- ✅ Online RAID migration через `mdadm --grow --level=N --raid-devices=M`
- ✅ Native Btrfs snapshots (мгновенные, CoW)
- ✅ Reflinks для дедупликации (duperemove)
- ✅ Online resize файловой системы
- ⚠️ Btrfs + mdadm имеют 15+ известных проблем (write hole, CoW degradation, scrub conflicts) — документированы в docs/specs/btrfs-problems.md
- ⚠️ Нет встроенного RAID-Z эквивалента — полагаемся на mdadm
- ❌ Btrfs RAID 5/6 нестабилен — используем mdadm для RAID, Btrfs только для filesystem
