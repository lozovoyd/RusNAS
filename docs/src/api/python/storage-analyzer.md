# Storage Analyzer API

**storage-analyzer-api.py** — API анализатора дискового пространства.

- **Размещение:** `/usr/share/cockpit/rusnas/scripts/storage-analyzer-api.py`
- **DB:** `/var/lib/rusnas/storage_history.db` (SQLite WAL)
- **Collector:** `storage-collector.py` (ежечасный таймер)

## Команды API

| Команда | Аргументы | Описание |
|---------|-----------|----------|
| `overview` | — | Total/used/free по всем томам + forecast |
| `shares` | — | Метрики по шарам + history[] |
| `files` | `path [sort] [ftype] [older_than]` | Файлы/папки для treemap |
| `users` | — | Использование по UID 1000–60000 |
| `file_types` | `volume_path` | Распределение по типам |
| `forecast` | `volume_path` | Прогноз заполнения (линейная регрессия) |

## Таблицы БД (storage_history.db)

### volume_snapshots
| Поле | Тип | Описание |
|------|-----|----------|
| id | INTEGER PK | Автоинкремент |
| ts | INTEGER | Unix timestamp |
| volume_path | TEXT | Путь к тому |
| total_bytes | INTEGER | Общий размер |
| used_bytes | INTEGER | Использовано |
| free_bytes | INTEGER | Свободно |

### share_snapshots
| Поле | Тип | Описание |
|------|-----|----------|
| id | INTEGER PK | Автоинкремент |
| ts | INTEGER | Unix timestamp |
| share_name | TEXT | Имя шары |
| path | TEXT | Путь |
| used_bytes | INTEGER | Использовано |
| file_count | INTEGER | Количество файлов |

### user_snapshots
| Поле | Тип | Описание |
|------|-----|----------|
| id | INTEGER PK | Автоинкремент |
| ts | INTEGER | Unix timestamp |
| username | TEXT | Имя пользователя |
| uid | INTEGER | UID (1000–60000) |
| used_bytes | INTEGER | Использовано |

### file_type_snapshots
| Поле | Тип | Описание |
|------|-----|----------|
| id | INTEGER PK | Автоинкремент |
| ts | INTEGER | Unix timestamp |
| volume_path | TEXT | Путь к тому |
| file_type | TEXT | Тип (video, images...) |
| used_bytes | INTEGER | Использовано |
| file_count | INTEGER | Количество |
