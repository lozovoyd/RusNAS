# Metrics Server API

**metrics_server.py** — HTTP-сервер метрик (Prometheus + JSON).

- **Размещение:** `/usr/share/cockpit/rusnas/scripts/rusnas-metrics/metrics_server.py`
- **Порт:** 9100
- **Сервис:** `rusnas-metrics.service`

## Endpoints

| URL | Format | Описание |
|-----|--------|----------|
| `GET /metrics` | Prometheus text | Метрики для Prometheus scrape |
| `GET /metrics.json` | JSON | Метрики для Dashboard JS |

## Метрики

| Имя | Тип | Описание |
|-----|-----|----------|
| `rusnas_cpu_usage_percent` | gauge | Загрузка CPU (%) |
| `rusnas_memory_used_bytes` | gauge | Использовано RAM |
| `rusnas_memory_total_bytes` | gauge | Всего RAM |
| `rusnas_disk_read_bytes` | counter | Прочитано с диска |
| `rusnas_disk_write_bytes` | counter | Записано на диск |
| `rusnas_net_rx_bytes` | counter | Принято по сети |
| `rusnas_net_tx_bytes` | counter | Отправлено по сети |
| `rusnas_spindown_state` | gauge | Состояние Backup Mode (0=active, 1=flushing, 2=standby, 3=waking) |
| `rusnas_spindown_wakeup_count_total` | counter | Всего пробуждений |

## Warm-up период

Первые показания дельты (CPU, Net, Disk I/O) требуют 1 секунду для накопления базовой линии. В этот период значения = 0.
