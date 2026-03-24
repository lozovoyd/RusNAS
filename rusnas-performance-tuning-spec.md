# ТЗ: rusNAS Performance Tuner — Авто-оптимизатор производительности

> Сохранить как `rusnas-performance-tuning-spec.md` в корне проекта после реализации.

---

## Цель

Реализовать в Cockpit-плагине rusNAS страницу/инструмент **Performance Tuner** — авто-оптимизатор дисковой подсистемы и сети. Инструмент анализирует текущую конфигурацию системы, выводит список применимых оптимизаций с объяснением, позволяет применить их в один клик (или всё сразу), и сохраняет изменения персистентно (через udev, sysctl.d, systemd, конфиги сервисов).

**Охват:** ALL уровни — ядро, драйверы, планировщики I/O, файловая система, RAID, сеть (sysctl + ethtool), Samba, NFS, демоны.

**Принцип:** не ломать то, что работает. Каждый параметр — с объяснением, текущим значением и рекомендованным. Возможен откат.

---

## Стек системы (на что ориентируемся)

| Слой | Компонент |
|------|-----------|
| OS | Debian 13 Trixie, ядро 6.12+ |
| RAID | mdadm (RAID 0/1/5/6/10) |
| FS | Btrfs |
| SMB | Samba |
| NFS | knfsd |
| Сеть | 1GbE / 10GbE |
| Кеш | dm-cache / LVM (SSD tier, опционально) |

---

## Уровни оптимизации

### УРОВЕНЬ 1: Ядро — vm.* (память и dirty pages)

**Файл:** `/etc/sysctl.d/99-rusnas-perf.conf`
**Применение:** `sysctl -p /etc/sysctl.d/99-rusnas-perf.conf`

| Параметр | Дефолт | NAS-значение | Влияние | Пояснение |
|----------|--------|-------------|---------|-----------|
| `vm.dirty_ratio` | 20 | **35** | HIGH | Макс. % RAM под грязные страницы до принудительного сброса |
| `vm.dirty_background_ratio` | 10 | **10** | HIGH | % RAM для фонового сброса (не менять — баланс) |
| `vm.dirty_writeback_centisecs` | 500 | **150** | MED | Интервал проверки flush (каждые 1.5 сек вместо 5) |
| `vm.vfs_cache_pressure` | 100 | **50** | MED | Меньше вытесняет inode/dentry кеш → быстрее поиск файлов |
| `vm.swappiness` | 60 | **10** | HIGH | RAM дороже swap для NAS; 10 = почти никогда не свапим |
| `vm.zone_reclaim_mode` | 0 | **0** | LOW | NUMA: не менять (VM без NUMA) |

**Transparent Hugepages:**
```bash
# /etc/rc.local или systemd oneshot
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo never    > /sys/kernel/mm/transparent_hugepage/defrag
```

---

### УРОВЕНЬ 2: Block Device — I/O планировщик

**Файл:** `/etc/udev/rules.d/70-rusnas-io-scheduler.rules`
**Применение:** `udevadm control --reload && udevadm trigger`

| Тип устройства | Планировщик | Почему |
|---------------|-------------|--------|
| HDD (вращающийся диск) | `mq-deadline` | Сортирует запросы для минимизации перемещений головки |
| SSD (кеш-диск) | `none` | Нет механики → не нужна сортировка, убираем overhead |
| NVMe | `none` | По умолчанию, оптимально |
| RAID-устройство (md*) | `mq-deadline` | Упорядочивает запросы к массиву |

```udev
# /etc/udev/rules.d/70-rusnas-io-scheduler.rules
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="nvme*", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="md*",   ATTR{queue/scheduler}="mq-deadline"
```

---

### УРОВЕНЬ 3: Block Device — Read-Ahead и Queue Depth

**Файл:** `/etc/udev/rules.d/71-rusnas-readahead.rules`

| Устройство | read_ahead_kb | nr_requests | Почему |
|-----------|--------------|-------------|--------|
| HDD | **8192** (8 МБ) | **256** | Последовательное чтение — большой prefetch даёт +10-15% |
| SSD | **512** (512 КБ) | **256** | SSD быстрый сам по себе, большой RA не нужен |
| md RAID-массив | **8192** | **256** | Увеличивает stripe-reads |

```udev
# /etc/udev/rules.d/71-rusnas-readahead.rules
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/read_ahead_kb}="8192", ATTR{queue/nr_requests}="256"
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/read_ahead_kb}="512",  ATTR{queue/nr_requests}="256"
ACTION=="add|change", KERNEL=="md*",     ATTR{queue/read_ahead_kb}="8192"
```

---

### УРОВЕНЬ 4: mdadm RAID — stripe_cache_size

**Location:** `/sys/block/mdX/md/stripe_cache_size`
**Persist:** через rc-local service или udev trigger

| Дисков в RAID5/6 | stripe_cache_size | RAM | Прирост |
|-----------------|------------------|-----|---------|
| 3 | **2048** | ~24 МБ | +15-20% последовательной записи |
| 4-5 | **4096** | ~64 МБ | +20-25% |
| 6+ | **8192** | ~160 МБ | +25-30% (тест!) |

**Параметры скорости ребилда:**
```
/etc/sysctl.d/99-rusnas-perf.conf:
dev.raid.speed_limit_min = 1000
dev.raid.speed_limit_max = 500000
```

**Bitmap для ускорения ресинка после сбоя питания:**
```bash
mdadm --grow /dev/md0 --bitmap=internal --bitmap-chunk=32k
```

---

### УРОВЕНЬ 5: Btrfs — mount options

**Файл:** `/etc/fstab`
**Влияние:** от +5% до +20% на latency и throughput

**Оптимальная строка fstab:**
```
/dev/md0  /mnt/data  btrfs  defaults,noatime,space_cache=v2,compress=zstd:1,discard=async  0  2
```

| Опция | Влияние | Условие |
|-------|---------|---------|
| `noatime` | **+20% снижение write-latency** (CoW для atime очень дорог) | Всегда |
| `space_cache=v2` | +5% поиск свободного места | Всегда |
| `compress=zstd:1` | +5-10% эффективная ёмкость | Для текстов/данных |
| `compress=lzo` | Быстрее zstd, хуже ratio | Для высокой IOPS нагрузки |
| `discard=async` | Батч-TRIM для SSD-кеша | Только если SSD-tier |
| `autodefrag` | Снижает фрагментацию | Только для малых random-write файлов |

**НЕ использовать:**
- `nodatasum` — отключает checksums, bit rot не поймаем
- `compress=zstd:3+` — CPU overhead превышает пользу
- `flushoncommit` — огромные latency spikes

---

### УРОВЕНЬ 6: Сеть — sysctl

**Файл:** `/etc/sysctl.d/99-rusnas-net.conf`

#### Профиль 10GbE:
```sysctl
# Буферы ядра
net.core.rmem_max          = 134217728    # 128 МБ RX max
net.core.wmem_max          = 134217728    # 128 МБ TX max
net.core.rmem_default      = 33554432     # 32 МБ default
net.core.wmem_default      = 33554432     # 32 МБ default

# TCP авто-тюнинг буферов
net.ipv4.tcp_rmem          = 4096 87380 134217728
net.ipv4.tcp_wmem          = 4096 65536  134217728

# Очереди соединений
net.core.somaxconn         = 65535
net.core.netdev_max_backlog = 65536
net.ipv4.tcp_max_syn_backlog = 65536

# TCP congestion control
net.ipv4.tcp_congestion_control = bbr   # Лучше CUBIC для LAN
net.core.default_qdisc          = fq    # Fair Queue (нужен для BBR)

# TIME-WAIT оптимизация
net.ipv4.tcp_tw_reuse  = 1
net.ipv4.tcp_fin_timeout = 10
```

#### Профиль 1GbE (экономичный):
```sysctl
net.core.rmem_max       = 33554432
net.core.wmem_max       = 33554432
net.ipv4.tcp_rmem       = 4096 87380 33554432
net.ipv4.tcp_wmem       = 4096 65536 33554432
net.core.somaxconn      = 32768
net.core.netdev_max_backlog = 32768
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc  = fq
```

---

### УРОВЕНЬ 7: NIC Hardware — ethtool

**Persist:** `/etc/systemd/system/rusnas-nic-tune.service`

#### Ring buffers:
```bash
ethtool -G eth0 rx 4096 tx 4096   # 10GbE
ethtool -G eth0 rx 2048 tx 2048   # 1GbE
```

#### Interrupt coalescing (баланс latency/throughput):
```bash
ethtool -C eth0 adaptive-rx on adaptive-tx on rx-usecs 100 tx-usecs 100
# Для 10GbE high-throughput: rx-usecs 200
# Для low-latency: rx-usecs 50
```

#### Offload (обычно уже включено, проверить):
```bash
ethtool -K eth0 tso on gso on gro on tx on rx on
```

#### Jumbo Frames (только если вся сеть поддерживает):
```bash
ip link set eth0 mtu 9000
# fstab/netplan: mtu: 9000
```

**Проверить поддержку:** `ping -M do -s 8972 <remote-ip>`

---

### УРОВЕНЬ 8: Samba — smb.conf оптимизация

**Файл:** `/etc/samba/smb.conf [global]`

```ini
[global]
    server max protocol = SMB3_11

    # Zero-copy reads
    use sendfile = yes

    # Async I/O (16+ КБ запросы — async)
    aio read size  = 16384
    aio write size = 16384

    # Кэш записи на шару
    write cache size = 4194304    # 4 МБ

    # Клиентское кэширование файлов (oplocks)
    oplocks        = yes
    level2 oplocks = yes
    kernel oplocks = yes

    # SMB3 Multichannel (если несколько NIC)
    # smb3 max credits = 8192
```

**ВАЖНО:** Не добавлять `socket options = SO_RCVBUF/SO_SNDBUF` — ядро 4.4+ тюнит TCP само. Явные значения могут снизить производительность.

---

### УРОВЕНЬ 9: NFS — nfsd threads + export options

**Файл:** `/etc/default/nfs-kernel-server` и `/etc/exports`

#### Количество потоков nfsd:
```bash
# /etc/default/nfs-kernel-server
RPCNFSDCOUNT=32    # 1-2 потока на ядро CPU
```

Мониторинг: `cat /proc/net/rpc/nfsd` — строка `th`, последние 2 числа > 0.8 → увеличить.

#### Опции экспорта:
```bash
/mnt/data/share  *(rw,sync,no_subtree_check,crossmnt,fsid=0)
```

#### sunrpc slot table (параллелизм RPC):
```bash
# /etc/modprobe.d/rusnas-sunrpc.conf
options sunrpc tcp_slot_table_entries=128
options sunrpc udp_slot_table_entries=128
```

Применить: `rmmod sunrpc && modprobe sunrpc` (или reboot).

---

### УРОВЕНЬ 10: CPU Governor

```bash
# Все ядра в режим производительности
for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > "$f"
done

# Persist: /etc/default/cpufrequtils
GOVERNOR="performance"
```

---

### УРОВЕНЬ 11: IRQ Balancing

```bash
apt install irqbalance
systemctl enable --now irqbalance
```

Для advanced-конфигураций: ручная привязка IRQ NIC к CPU-ядрам через `/proc/irq/N/smp_affinity`.

---

### УРОВЕНЬ 12: TuneD профиль

```bash
apt install tuned
tuned-adm profile throughput-performance   # NAS общего назначения
# или:
tuned-adm profile network-throughput       # 10GbE heavy
```

**Кастомный профиль rusNAS** (`/etc/tuned/rusnas/tuned.conf`):
```ini
[main]
include = throughput-performance

[sysctl]
vm.dirty_ratio = 35
vm.swappiness = 10
net.ipv4.tcp_congestion_control = bbr
```

---

## Чек-лист авто-оптимизатора (приоритет по влиянию)

| # | Уровень | Параметр | Влияние | Сложность реализации |
|---|---------|----------|---------|---------------------|
| 1 | Сеть (sysctl) | tcp_rmem/wmem, rmem_max | **+20%** throughput (10GbE) | Простая |
| 2 | RAID | stripe_cache_size | **+20%** RAID5/6 записи | Простая |
| 3 | Память | dirty_ratio=35, swappiness=10 | **+15%** стабильность записи | Простая |
| 4 | I/O планировщик | mq-deadline (HDD), none (SSD) | **+5-8%** IOPS | Простая |
| 5 | Btrfs | noatime + compress=zstd:1 | **+5-20%** latency | Требует remount |
| 6 | Samba | sendfile, aio, oplocks | **+10%** SMB throughput | Средняя |
| 7 | NFS | 32 threads + rsize=1M | **+15%** NFS throughput | Средняя |
| 8 | NIC | Ring buffers, offload | Предотвращает дропы | Средняя |
| 9 | CPU | performance governor | Стабильность под нагрузкой | Простая |
| 10 | IRQ | irqbalance | **+2-5%** многопоточная нагрузка | Простая |
| 11 | TuneD | throughput-performance | Комплексный baseline | Простая |
| 12 | sunrpc | tcp_slot_table=128 | Параллелизм NFS | Требует reboot |
| 13 | RAID bitmap | internal bitmap | Быстрый ресинк после сбоя | Средняя |
| 14 | Jumbo frames | MTU 9000 | Только для 10GbE | Рискованная |
| 15 | BBR | tcp_congestion_control=bbr | **+5-10%** LAN throughput | Простая |

---

## Архитектура Cockpit-страницы Performance Tuner

### Расположение
Новая страница в плагине: `performance.html` + `js/performance.js`
Добавить в `manifest.json`.

### Структура UI

```
Performance Tuner
├── [Профиль системы] — детект аппаратуры, авто-выбор параметров
│   ├── Обнаружено дисков: 4× HDD + 1× SSD
│   ├── RAID: md0 RAID5 (3 диска)
│   ├── Сеть: eth0 1GbE
│   └── ОЗУ: 16 ГБ
│
├── [Параметры оптимизации] — таблица с чекбоксами
│   ├── Категория: Память
│   │   ├── ☑ vm.swappiness: 60 → 10  [Применить] [?]
│   │   └── ☑ vm.dirty_ratio: 20 → 35 [Применить] [?]
│   ├── Категория: I/O планировщик
│   │   └── ☑ /dev/sda: cfq → mq-deadline [Применить] [?]
│   ├── Категория: RAID
│   │   └── ☑ stripe_cache: 256 → 2048  [Применить] [?]
│   ├── Категория: Сеть
│   │   ├── ☑ tcp_rmem: default → 128MB [Применить] [?]
│   │   └── ☑ BBR: cubic → bbr          [Применить] [?]
│   └── ...
│
├── [Кнопки]
│   ├── [✓ Применить выбранные]
│   ├── [↺ Откатить всё]
│   └── [📋 Экспорт конфига]
│
└── [Статус] — Applied/Pending/Error per item
```

### Backend

**Операции:**
- Читать текущие значения: `sysctl -n <param>`, `cat /sys/block/sdX/queue/scheduler`, `blockdev --getra`, `ethtool -g eth0`
- Применять: `sysctl -w`, write to `/etc/sysctl.d/99-rusnas-perf.conf`, write udev rules
- Перезагружать: `udevadm trigger`, `sysctl --system`, `systemctl restart samba/nfs-kernel-server`
- Персистентность: sysctl.d + udev rules + systemd service для ethtool

**Судоерс** `/etc/sudoers.d/rusnas-performance`:
```
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/sysctl
rusnas ALL=(ALL) NOPASSWD: /sbin/blockdev
rusnas ALL=(ALL) NOPASSWD: /sbin/ethtool
rusnas ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/sysctl.d/99-rusnas-perf.conf
rusnas ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/udev/rules.d/70-rusnas-io-scheduler.rules
rusnas ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/udev/rules.d/71-rusnas-readahead.rules
rusnas ALL=(ALL) NOPASSWD: /usr/bin/tee /etc/udev/rules.d/90-rusnas-nic.rules
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/udevadm control --reload
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/udevadm trigger
rusnas ALL=(ALL) NOPASSWD: /usr/bin/tuned-adm
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart tuned
```

---

## Файлы для создания/изменения

| Файл | Действие |
|------|---------|
| `cockpit/rusnas/performance.html` | Новая страница |
| `cockpit/rusnas/js/performance.js` | Логика чтения/записи параметров |
| `cockpit/rusnas/manifest.json` | Добавить раздел performance |
| `rusnas-performance-tuning-spec.md` | Копия этого ТЗ в корне проекта |
| `install-performance.sh` | Деплой судоерс + tuned на VM |

---

## Верификация

1. `./deploy.sh` + открыть `/rusnas/performance`
2. Страница определяет текущие значения (не показывает дефолты, а реальные)
3. Нажать "Применить" у одного параметра → `sysctl -n <param>` показывает новое значение
4. Перезагрузить VM → параметр остался (persistence через sysctl.d)
5. "Откатить" → значение вернулось к дефолту
6. Benchmark до/после: `fio --rw=write --bs=1M --size=1G --numjobs=4 --filename=/mnt/data/test`

---

## Источники

- Red Hat / RHEL 9/10 Performance Tuning Guides
- Samba Wiki: Performance Tuning
- Btrfs Documentation: Mount Options, Compression
- fasterdata.es.net: Linux 10GbE Host Tuning
- Linux RAID Wiki: Performance
- mdadm stripe_cache_size benchmarks (Baptiste Wicht)
- Microsoft Azure NetApp: sunrpc tcp_slot_table_entries

## Как работают SMART self-tests

`smartctl -t short /dev/sda` — немедленно возвращается, тест идёт **асинхронно** прямо на диске:
- **Краткий (short):** ~2 мин
- **Расширенный (extended):** ~60 мин

Прогресс виден через `smartctl -a`: строка `Self test in progress ... XX% of test remaining`.
Результаты хранятся в логе диска и видны в секции `SMART Self-test log` того же вывода.

---

## Целевой UX

```
[ История тестов ]
┌────┬──────────────┬────────────────────────┬───────────┬──────────┐
│  # │ Тип          │ Результат              │ Осталось  │ Часы     │
├────┼──────────────┼────────────────────────┼───────────┼──────────┤
│  1 │ Short        │ ✓ Completed            │ 00%       │ 1        │
│  2 │ Extended     │ ✗ Failed (LBA: 12345)  │ 00%       │ 50       │
└────┴──────────────┴────────────────────────┴───────────┴──────────┘

[ Кнопки ]   ▶ Краткий (~2 мин)   ▶ Расширенный (~60 мин)   Закрыть

-- во время теста --
[ ⏳ Краткий тест: осталось 61% ... ]  (кнопка disabled, обновляется каждые 5с)
-- по завершении --
[ автоматически обновляет Modal данными ]
```

---

## Файлы для изменения

| Файл | Изменение |
|------|-----------|
| `cockpit/rusnas/js/disks.js` | `renderSmartModal()`, polling, `renderTestHistory()`, fix bug |
| `cockpit/rusnas/disks.html` | Добавить кнопку "▶ Расширенный тест" |

---

## 1. Парсинг истории тестов → таблица

В `renderSmartModal()` заменить секцию "Self-test log" с raw-text на вызов `renderTestHistory(out)`:

```javascript
function renderTestHistory(out) {
    // Строки вида:
    // # 1  Short offline  Completed without error  00%  100  -
    var rows = "";
    var re = /#\s*(\d+)\s+([\w ]+?)\s{2,}([\w ()]+?)\s{2,}(\d+%)\s+(\d+)\s+(\S+)/g;
    var m;
    while ((m = re.exec(out)) !== null) {
        var num    = m[1];
        var type   = m[2].trim();
        var status = m[3].trim();
        var rem    = m[4];
        var hours  = m[5];
        var lba    = m[6] === "-" ? "—" : m[6];
        var ok     = status.toLowerCase().indexOf("completed without error") !== -1;
        var ico    = ok ? "✓" : "✗";
        var color  = ok ? "#4caf50" : "#f44336";
        rows += "<tr style='border-bottom:1px solid var(--color-border)'>" +
            "<td style='padding:4px 8px;font-family:monospace'>" + num + "</td>" +
            "<td style='padding:4px 8px'>" + _escHtml(type) + "</td>" +
            "<td style='padding:4px 8px;color:" + color + "'>" + ico + " " + _escHtml(status) + "</td>" +
            "<td style='padding:4px 8px;text-align:center'>" + rem + "</td>" +
            "<td style='padding:4px 8px;text-align:right;font-family:monospace'>" + hours + "</td>" +
            "<td style='padding:4px 8px;font-family:monospace'>" + _escHtml(lba) + "</td>" +
            "</tr>";
    }
    if (!rows) return "<span style='color:var(--color-muted);font-size:12px'>Тесты не запускались</span>";
    return "<table style='width:100%;border-collapse:collapse;font-size:12px'>" +
        "<thead><tr style='background:var(--bg-th);color:var(--color-muted);font-size:10px;text-transform:uppercase'>" +
        "<th style='padding:4px 8px'>#</th><th style='padding:4px 8px'>Тип</th>" +
        "<th style='padding:4px 8px'>Результат</th><th style='padding:4px 8px;text-align:center'>Остаток</th>" +
        "<th style='padding:4px 8px;text-align:right'>Часы</th><th style='padding:4px 8px'>LBA ошибки</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table>";
}
```

В `renderSmartModal()`:
```javascript
// Было:
document.getElementById("smart-modal-tests").textContent = testText;
// Стало:
document.getElementById("smart-modal-tests").innerHTML = renderTestHistory(out);
```

Элемент в HTML изменить с `<div ... white-space:pre-wrap>` → убрать `white-space:pre-wrap` (или просто style без него).

---

## 2. Прогресс-полинг после запуска теста

Глобальная переменная `_smartTestPollTimer`. После `smartctl -t short/extended`:

```javascript
var _smartTestPollTimer = null;

function startSmartTestPoll() {
    if (_smartTestPollTimer) return;
    _smartTestPollTimer = setInterval(function() {
        cockpit.spawn(["sudo", "-n", "smartctl", "-a", "/dev/" + _smartModalDisk], {err: "message"})
        .done(function(out) {
            var running = out.indexOf("Self test in progress") !== -1 ||
                          out.indexOf("self-test in progress") !== -1;
            if (running) {
                var pctM = out.match(/(\d+)% of test remaining/);
                var pct  = pctM ? pctM[1] : "?";
                var shortBtn = document.getElementById("btn-smart-run-short");
                var longBtn  = document.getElementById("btn-smart-run-long");
                if (shortBtn) shortBtn.textContent = "⏳ Осталось " + pct + "%";
                if (longBtn)  longBtn.textContent  = "⏳ Осталось " + pct + "%";
            } else {
                // Тест завершён
                stopSmartTestPoll();
                renderSmartModal(out);  // обновить данные
            }
        })
        .fail(function() { stopSmartTestPoll(); });
    }, 5000);
}

function stopSmartTestPoll() {
    if (_smartTestPollTimer) {
        clearInterval(_smartTestPollTimer);
        _smartTestPollTimer = null;
    }
    var shortBtn = document.getElementById("btn-smart-run-short");
    var longBtn  = document.getElementById("btn-smart-run-long");
    if (shortBtn) { shortBtn.disabled = false; shortBtn.textContent = "▶ Краткий (~2 мин)"; }
    if (longBtn)  { longBtn.disabled  = false; longBtn.textContent  = "▶ Расширенный (~60 мин)"; }
}
```

Также вызвать `stopSmartTestPoll()` в начале `openSmartModal()` — при открытии другого диска полинг предыдущего останавливается.

---

## 3. Кнопки в disks.html

```html
<div class="modal-footer">
    <button class="btn btn-secondary" id="btn-smart-run-short">▶ Краткий (~2 мин)</button>
    <button class="btn btn-secondary" id="btn-smart-run-long">▶ Расширенный (~60 мин)</button>
    <button class="btn btn-default" id="btn-smart-close">Закрыть</button>
</div>
```

Убрать `white-space:pre-wrap` из `#smart-modal-tests` (теперь это таблица).

---

## 4. Обработчики в DOMContentLoaded

```javascript
// Расширенный тест
document.getElementById("btn-smart-run-long").addEventListener("click", function() {
    if (!_smartModalDisk) return;
    var shortBtn = document.getElementById("btn-smart-run-short");
    var longBtn  = document.getElementById("btn-smart-run-long");
    shortBtn.disabled = true;
    longBtn.disabled  = true;
    longBtn.textContent = "Запускается…";
    cockpit.spawn(["sudo", "-n", "smartctl", "-t", "long", "/dev/" + _smartModalDisk], {err: "message"})
    .always(function() { startSmartTestPoll(); });
});

// Краткий тест — FIX: был disabled = true в .always, теперь через stopSmartTestPoll
document.getElementById("btn-smart-run-short").addEventListener("click", function() {
    if (!_smartModalDisk) return;
    var shortBtn = document.getElementById("btn-smart-run-short");
    var longBtn  = document.getElementById("btn-smart-run-long");
    shortBtn.disabled = true;
    longBtn.disabled  = true;
    shortBtn.textContent = "Запускается…";
    cockpit.spawn(["sudo", "-n", "smartctl", "-t", "short", "/dev/" + _smartModalDisk], {err: "message"})
    .always(function() { startSmartTestPoll(); });
});
```

**Примечание:** `smartctl -t` возвращается немедленно (тест начат). `.always()` запускает поллинг, кнопки остаются disabled пока поллинг не поймает завершение теста.

---

---

## 5. Автоматическое расписание тестов (smartd)

**Стандарт индустрии:** Synology, QNAP, TrueNAS все делают автоматические тесты. TrueNAS использует `smartd` — стандартный Linux-инструмент для этого.

**Подход:** управлять `/etc/smartd.conf` из Cockpit UI. `smartd` уже установлен в Debian 13 (пакет `smartmontools`).

### Что добавить в SMART-модалку — раздел "Автотесты"

После секции "История тестов", перед кнопками:

```
[ Расписание автотестов ]

[x] Краткий тест — каждое [воскресенье ▼] в [02:00 ▼]
[x] Расширенный тест — каждое [1 число ▼] в [03:00 ▼]

[Сохранить расписание]
```

### Backend: /etc/smartd.conf

`smartd` конфиг-строка для диска `/dev/sda` с двумя тестами:
```
/dev/sda -a -s S/../../7/02 -s L/../../1/03
```
- `S` = Short, `L` = Long
- Формат: `T/MM/DD/DOW/HH` (DOW: 1=пн...7=вс, `..` = каждый)
- Если тест не нужен — строка без `-s` для этого типа

**Функция `saveSmartSchedule(disk, shortDow, shortHour, longDay, longHour)`:**

```javascript
function saveSmartSchedule(disk, shortEnabled, shortDow, shortHour,
                                  longEnabled,  longDay,  longHour) {
    // Читаем /etc/smartd.conf
    // Удаляем строку для /dev/{disk}
    // Строим новую строку:
    //   /dev/{disk} -a -s S/../../{dow}/{hh} -s L/../{dd}/../{hh}
    // Дописываем
    // systemctl restart smartd
}
```

Чтение/запись через `cockpit.file("/etc/smartd.conf", {superuser:"require"}).read()` + `.replace()`.

### Судоерс

Добавить в `/etc/sudoers.d/rusnas-smart`:
```
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart smartd
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl enable smartd
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl start smartd
```

### UI в disks.html — секция расписания

```html
<div id="smart-modal-schedule" style="margin-bottom:16px">
  <div style="...заголовок...">Расписание автотестов</div>
  <div style="display:flex;flex-direction:column;gap:10px;padding:12px;background:var(--bg-th);border-radius:6px">
    <!-- Краткий тест -->
    <label style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="smart-sched-short-en">
      <span>Краткий тест — каждый</span>
      <select id="smart-sched-short-dow">...</select>
      <span>в</span>
      <select id="smart-sched-short-hour">...</select>
    </label>
    <!-- Расширенный тест -->
    <label style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="smart-sched-long-en">
      <span>Расширенный тест — каждое</span>
      <select id="smart-sched-long-day">1..28</select>
      <span>число месяца в</span>
      <select id="smart-sched-long-hour">...</select>
    </label>
    <button class="btn btn-primary" id="btn-smart-save-schedule" style="align-self:flex-start">Сохранить</button>
  </div>
</div>
```

При открытии модалки: читаем `/etc/smartd.conf` → парсим строку для текущего диска → заполняем чекбоксы/select.

---

## Верификация

1. `./deploy.sh`
2. Открыть Диски и RAID → кликнуть на строку диска
3. **История тестов** — таблица (не raw text)
4. **Запуск вручную:** "▶ Краткий (~2 мин)":
   - Обе кнопки disabled, текст меняется на "⏳ Осталось X%"
   - Через ~2 мин данные обновляются автоматически, кнопки разблокируются
5. **Расписание:** включить краткий тест, сохранить → проверить `/etc/smartd.conf` на VM
6. `sudo systemctl status smartd` — сервис работает
