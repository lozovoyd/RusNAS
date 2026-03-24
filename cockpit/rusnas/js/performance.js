// ─── rusNAS Performance Tuner ─────────────────────────────────────────────────

var _profileData  = {};   // detected system profile
var _tuneItems    = [];   // array of tuning items with current/recommended values
var _origValues   = {};   // original values for rollback  (id → original_value)
var _appliedItems = {};   // id → true if applied this session

// ─── Spawn helper (returns Promise) ──────────────────────────────────────────

function spawnP(args) {
    return new Promise(function(res, rej) {
        cockpit.spawn(["sudo", "-n"].concat(args), {err: "message"})
            .done(res).fail(function(e, out) { rej(out || e || "error"); });
    });
}

function spawnSafe(args) {
    return new Promise(function(res) {
        cockpit.spawn(["sudo", "-n"].concat(args), {err: "message"})
            .done(res).fail(function() { res(""); });
    });
}

// No-sudo variant — for reads that don't need root (sysctl -n, /proc, /sys reads)
function spawnNoSudo(args) {
    return new Promise(function(res) {
        cockpit.spawn(args, {err: "message"})
            .done(res).fail(function() { res(""); });
    });
}

// Write a single sysfs/procfs file as root via cockpit.file
function writeSysFile(path, value) {
    return cockpit.file(path, {superuser: "require"}).replace(value + "\n")
        .catch(function(e) { return Promise.reject("tee " + path + ": " + e); });
}

// List /sys/block devices matching regex, return Promise<string[]>
function listBlockDevices(pattern) {
    return spawnNoSudo(["ls", "/sys/block"]).then(function(out) {
        return out.trim().split("\n").filter(function(d) { return d && pattern.test(d); });
    });
}

// ─── Tuning item definitions ──────────────────────────────────────────────────

// Each item:
// { id, category, param, label, desc, impact,
//   readFn()→Promise<string>,      // returns current value as string
//   recommendFn(profile)→string,   // returns recommended value (may depend on profile)
//   applyFn(value)→Promise,
//   persistFn(value)→Promise,      // write to sysctl.d / udev / etc
//   rollbackFn(originalValue)→Promise
// }

function makeSysctlItem(id, cat, param, label, desc, impact, recommended, unit) {
    return {
        id: id, category: cat, param: param, label: label, desc: desc,
        impact: impact, unit: unit || "",
        readFn: function() {
            return spawnNoSudo(["sysctl", "-n", param])
                .then(function(v) { return v.trim(); });
        },
        recommendFn: function() { return String(recommended); },
        applyFn: function(val) {
            return spawnP(["sysctl", "-w", param + "=" + val]);
        },
        persistFn: function(val) {
            // Append/update in our sysctl file
            return writeSysctlConf(param, val);
        },
        rollbackFn: function(orig) {
            return spawnP(["sysctl", "-w", param + "=" + orig])
                .then(function() { return removeSysctlConf(param); });
        }
    };
}

function ITEMS() {
    return [
        // ── Memory ──────────────────────────────────────────────────────────
        makeSysctlItem("vm_swappiness", "Память", "vm.swappiness",
            "Свопинг",
            "Низкое значение оставляет рабочий набор данных в RAM. Для NAS RAM важнее swap.",
            "high", 10),

        makeSysctlItem("vm_dirty_ratio", "Память", "vm.dirty_ratio",
            "Порог грязных страниц (dirty_ratio)",
            "Максимальный % RAM под немодифицированные данные перед принудительным сбросом на диск. Выше = больше буфер записи.",
            "high", 35),

        makeSysctlItem("vm_dirty_writeback", "Память", "vm.dirty_writeback_centisecs",
            "Интервал flush (writeback)",
            "Как часто ядро проверяет страницы для сброса (в 0.01 сек). 150 = каждые 1.5 сек вместо 5.",
            "med", 150),

        makeSysctlItem("vm_vfs_pressure", "Память", "vm.vfs_cache_pressure",
            "Давление на VFS-кеш",
            "100 = агрессивное вытеснение inode/dentry кеша. 50 = сохранять кеш дольше → быстрее поиск файлов.",
            "med", 50),

        // ── Network ─────────────────────────────────────────────────────────
        {
            id: "net_rmem_max", category: "Сеть", param: "net.core.rmem_max",
            label: "RX буфер сокета (rmem_max)",
            desc: "Максимальный размер буфера приёма сокета. 128 МБ нужно для насыщения 10GbE при высоком RTT.",
            impact: "high", unit: " байт",
            readFn: function() { return spawnNoSudo(["sysctl", "-n", "net.core.rmem_max"]).then(function(v){return v.trim();}); },
            recommendFn: function(p) { return p.netSpeed >= 10000 ? "134217728" : "33554432"; },
            applyFn: function(v) { return spawnP(["sysctl", "-w", "net.core.rmem_max=" + v]); },
            persistFn: function(v) { return writeSysctlConf("net.core.rmem_max", v); },
            rollbackFn: function(orig) { return spawnP(["sysctl", "-w", "net.core.rmem_max=" + orig]).then(function(){ return removeSysctlConf("net.core.rmem_max"); }); }
        },
        {
            id: "net_wmem_max", category: "Сеть", param: "net.core.wmem_max",
            label: "TX буфер сокета (wmem_max)",
            desc: "Максимальный размер буфера передачи сокета. Аналогично rmem_max.",
            impact: "high", unit: " байт",
            readFn: function() { return spawnNoSudo(["sysctl", "-n", "net.core.wmem_max"]).then(function(v){return v.trim();}); },
            recommendFn: function(p) { return p.netSpeed >= 10000 ? "134217728" : "33554432"; },
            applyFn: function(v) { return spawnP(["sysctl", "-w", "net.core.wmem_max=" + v]); },
            persistFn: function(v) { return writeSysctlConf("net.core.wmem_max", v); },
            rollbackFn: function(orig) { return spawnP(["sysctl", "-w", "net.core.wmem_max=" + orig]).then(function(){ return removeSysctlConf("net.core.wmem_max"); }); }
        },
        {
            id: "net_tcp_rmem", category: "Сеть", param: "net.ipv4.tcp_rmem",
            label: "TCP RX авто-тюнинг",
            desc: "Три числа: мин, дефолт, макс буфер TCP приёма. Большой макс = ядро авто-тюнит под скорость линка.",
            impact: "high", unit: "",
            readFn: function() { return spawnNoSudo(["sysctl", "-n", "net.ipv4.tcp_rmem"]).then(function(v){return v.trim().replace(/\s+/g," ");}); },
            recommendFn: function(p) { var m = p.netSpeed >= 10000 ? "134217728" : "33554432"; return "4096 87380 " + m; },
            applyFn: function(v) { return spawnP(["sysctl", "-w", "net.ipv4.tcp_rmem=" + v]); },
            persistFn: function(v) { return writeSysctlConf("net.ipv4.tcp_rmem", v); },
            rollbackFn: function(orig) { return spawnP(["sysctl", "-w", "net.ipv4.tcp_rmem=" + orig]).then(function(){ return removeSysctlConf("net.ipv4.tcp_rmem"); }); }
        },
        {
            id: "net_tcp_wmem", category: "Сеть", param: "net.ipv4.tcp_wmem",
            label: "TCP TX авто-тюнинг",
            desc: "Три числа: мин, дефолт, макс буфер TCP передачи.",
            impact: "high", unit: "",
            readFn: function() { return spawnNoSudo(["sysctl", "-n", "net.ipv4.tcp_wmem"]).then(function(v){return v.trim().replace(/\s+/g," ");}); },
            recommendFn: function(p) { var m = p.netSpeed >= 10000 ? "134217728" : "33554432"; return "4096 65536 " + m; },
            applyFn: function(v) { return spawnP(["sysctl", "-w", "net.ipv4.tcp_wmem=" + v]); },
            persistFn: function(v) { return writeSysctlConf("net.ipv4.tcp_wmem", v); },
            rollbackFn: function(orig) { return spawnP(["sysctl", "-w", "net.ipv4.tcp_wmem=" + orig]).then(function(){ return removeSysctlConf("net.ipv4.tcp_wmem"); }); }
        },
        makeSysctlItem("net_backlog", "Сеть", "net.core.netdev_max_backlog",
            "RX очередь сетевого стека",
            "Макс. пакетов в очереди перед обработкой ядром. При 10GbE дефолт 1000 слишком мал.",
            "med", 65536),
        makeSysctlItem("net_somaxconn", "Сеть", "net.core.somaxconn",
            "Очередь accept() (somaxconn)",
            "Макс. ожидающих соединений на сокет. Важно при многих одновременных SMB/NFS клиентах.",
            "med", 65535),
        {
            id: "net_bbr", category: "Сеть", param: "net.ipv4.tcp_congestion_control",
            label: "TCP Congestion Control (BBR)",
            desc: "BBR (Bottleneck Bandwidth and RTT) — современный алгоритм управления перегрузкой Google. На LAN даёт +5-10% throughput по сравнению с CUBIC.",
            impact: "med", unit: "",
            readFn: function() { return spawnNoSudo(["sysctl", "-n", "net.ipv4.tcp_congestion_control"]).then(function(v){return v.trim();}); },
            recommendFn: function() { return "bbr"; },
            applyFn: function(v) {
                // BBR requires fq qdisc
                return spawnP(["sysctl", "-w", "net.core.default_qdisc=fq"])
                    .then(function() { return spawnP(["sysctl", "-w", "net.ipv4.tcp_congestion_control=" + v]); });
            },
            persistFn: function(v) {
                return writeSysctlConf("net.core.default_qdisc", "fq")
                    .then(function() { return writeSysctlConf("net.ipv4.tcp_congestion_control", v); });
            },
            rollbackFn: function(orig) {
                return spawnP(["sysctl", "-w", "net.ipv4.tcp_congestion_control=" + orig])
                    .then(function() { return removeSysctlConf("net.ipv4.tcp_congestion_control"); })
                    .then(function() { return removeSysctlConf("net.core.default_qdisc"); });
            }
        },

        // ── RAID ─────────────────────────────────────────────────────────────
        makeSysctlItem("raid_speed_max", "RAID", "dev.raid.speed_limit_max",
            "Макс. скорость ребилда RAID",
            "500 МБ/с — достаточно для современных HDD. Дефолт 200 МБ/с слишком мал для быстрых дисков.",
            "med", 500000),
        makeSysctlItem("raid_speed_min", "RAID", "dev.raid.speed_limit_min",
            "Мин. скорость ребилда RAID",
            "Минимальная скорость, которую ядро гарантирует для ребилда даже под нагрузкой.",
            "low", 1000),

        // ── CPU ──────────────────────────────────────────────────────────────
        {
            id: "cpu_governor", category: "CPU", param: "cpu.scaling_governor",
            label: "CPU Governor (производительность)",
            desc: "Режим 'performance' держит CPU на максимальной частоте. Устраняет latency spikes при масштабировании частоты под нагрузкой.",
            impact: "med", unit: "",
            readFn: function() {
                return spawnNoSudo(["cat", "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"])
                    .then(function(v) { return v.trim() || "N/A"; });
            },
            recommendFn: function() { return "performance"; },
            applyFn: function(val) {
                // Write to all CPU governor files via cockpit.file
                return spawnNoSudo(["ls", "/sys/devices/system/cpu"]).then(function(out) {
                    var cpus = out.trim().split("\n").filter(function(d) { return /^cpu\d+$/.test(d); });
                    var chain = Promise.resolve();
                    cpus.forEach(function(cpu) {
                        var path = "/sys/devices/system/cpu/" + cpu + "/cpufreq/scaling_governor";
                        chain = chain.then(function() {
                            return writeSysFile(path, val).catch(function() {});
                        });
                    });
                    return chain;
                });
            },
            persistFn: function() {
                return cockpit.file("/etc/default/cpufrequtils", {superuser: "require"})
                    .replace("GOVERNOR=\"performance\"\n").catch(function() {});
            },
            rollbackFn: function(orig) {
                if (!orig || orig === "N/A") return Promise.resolve();
                return spawnNoSudo(["ls", "/sys/devices/system/cpu"]).then(function(out) {
                    var cpus = out.trim().split("\n").filter(function(d) { return /^cpu\d+$/.test(d); });
                    var chain = Promise.resolve();
                    cpus.forEach(function(cpu) {
                        var path = "/sys/devices/system/cpu/" + cpu + "/cpufreq/scaling_governor";
                        chain = chain.then(function() {
                            return writeSysFile(path, orig).catch(function() {});
                        });
                    });
                    return chain;
                });
            }
        },

        // ── NFS ──────────────────────────────────────────────────────────────
        {
            id: "nfs_threads", category: "NFS", param: "nfsd.threads",
            label: "Потоки nfsd",
            desc: "Количество рабочих потоков NFS сервера. Рекомендуется 1-2 на ядро CPU. Маленькое значение = NFS-клиенты ждут при параллельных запросах.",
            impact: "med", unit: "",
            readFn: function() {
                return spawnNoSudo(["cat", "/proc/fs/nfsd/threads"])
                    .then(function(v) { return v.trim() || "0"; });
            },
            recommendFn: function(p) { return String(Math.max(8, (p.cpuCores || 2) * 2)); },
            applyFn: function(v) {
                return writeSysFile("/proc/fs/nfsd/threads", v);
            },
            persistFn: function(v) {
                // Read and update /etc/default/nfs-kernel-server
                return cockpit.file("/etc/default/nfs-kernel-server", {superuser: "require"}).read()
                    .then(function(content) {
                        content = content || "";
                        if (content.match(/RPCNFSDCOUNT=/)) {
                            content = content.replace(/RPCNFSDCOUNT=\S*/g, "RPCNFSDCOUNT=" + v);
                        } else {
                            content += "\nRPCNFSDCOUNT=" + v + "\n";
                        }
                        return cockpit.file("/etc/default/nfs-kernel-server", {superuser: "require"}).replace(content);
                    }).catch(function() {});
            },
            rollbackFn: function(orig) {
                if (!orig || orig === "0") return Promise.resolve();
                return writeSysFile("/proc/fs/nfsd/threads", orig).catch(function() {});
            }
        },

        // ── I/O Scheduler ────────────────────────────────────────────────────
        {
            id: "io_scheduler_udev", category: "I/O планировщик", param: "udev.io_scheduler",
            label: "I/O планировщик (HDD: mq-deadline, SSD: none)",
            desc: "mq-deadline для HDD минимизирует перемещения головки. none для SSD убирает лишний overhead. Применяется через udev rules.",
            impact: "high", unit: "",
            readFn: function() {
                return listBlockDevices(/^sd/).then(function(disks) {
                    if (!disks.length) return "нет дисков";
                    var parts = disks.map(function(d) {
                        var rot = spawnNoSudo(["cat", "/sys/block/" + d + "/queue/rotational"]);
                        var sch = spawnNoSudo(["cat", "/sys/block/" + d + "/queue/scheduler"]);
                        return Promise.all([rot, sch]).then(function(r) {
                            var s = (r[1] || "").match(/\[([^\]]+)\]/);
                            return d + " rot=" + r[0].trim() + " sched=" + (s ? s[1] : "?");
                        });
                    });
                    return Promise.all(parts).then(function(lines) { return lines.join("\n"); });
                });
            },
            recommendFn: function() { return "mq-deadline (HDD) / none (SSD)"; },
            applyFn: function() {
                return listBlockDevices(/^sd/).then(function(disks) {
                    var chain = Promise.resolve();
                    disks.forEach(function(d) {
                        chain = chain.then(function() {
                            return spawnNoSudo(["cat", "/sys/block/" + d + "/queue/rotational"])
                                .then(function(rot) {
                                    var sched = rot.trim() === "1" ? "mq-deadline" : "none";
                                    return writeSysFile("/sys/block/" + d + "/queue/scheduler", sched).catch(function(){});
                                });
                        });
                    });
                    return chain;
                });
            },
            persistFn: function() {
                var rules = [
                    'ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="mq-deadline"',
                    'ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="none"',
                    'ACTION=="add|change", KERNEL=="nvme*", ATTR{queue/scheduler}="none"',
                    'ACTION=="add|change", KERNEL=="md*",   ATTR{queue/scheduler}="mq-deadline"',
                    ""
                ].join("\n");
                return cockpit.file("/etc/udev/rules.d/70-rusnas-io-scheduler.rules",
                    {superuser: "require"}).replace(rules)
                    .then(function() { return spawnSafe(["udevadm", "control", "--reload"]); });
            },
            rollbackFn: function() {
                return cockpit.file("/etc/udev/rules.d/70-rusnas-io-scheduler.rules",
                    {superuser: "require"}).replace("# removed by rusNAS rollback\n");
            }
        },

        // ── Read-Ahead ───────────────────────────────────────────────────────
        {
            id: "readahead_udev", category: "I/O планировщик", param: "udev.read_ahead",
            label: "Read-ahead (HDD: 8 МБ, SSD: 512 КБ)",
            desc: "Предварительная выборка данных с диска. HDD: 8 МБ даёт +10-15% для последовательного чтения. SSD: 512 КБ (SSD и так быстрый).",
            impact: "high", unit: "",
            readFn: function() {
                return listBlockDevices(/^sd/).then(function(disks) {
                    if (!disks.length) return "нет дисков";
                    var parts = disks.map(function(d) {
                        return Promise.all([
                            spawnNoSudo(["cat", "/sys/block/" + d + "/queue/rotational"]),
                            spawnNoSudo(["cat", "/sys/block/" + d + "/queue/read_ahead_kb"])
                        ]).then(function(r) {
                            return d + " rot=" + r[0].trim() + " ra=" + r[1].trim() + "КБ";
                        });
                    });
                    return Promise.all(parts).then(function(lines) { return lines.join("\n"); });
                });
            },
            recommendFn: function() { return "8192 КБ (HDD) / 512 КБ (SSD)"; },
            applyFn: function() {
                return Promise.all([
                    listBlockDevices(/^sd/),
                    listBlockDevices(/^md/)
                ]).then(function(results) {
                    var sdDisks = results[0], mdDisks = results[1];
                    var chain = Promise.resolve();
                    sdDisks.forEach(function(d) {
                        chain = chain.then(function() {
                            return spawnNoSudo(["cat", "/sys/block/" + d + "/queue/rotational"])
                                .then(function(rot) {
                                    var ra = rot.trim() === "1" ? "8192" : "512";
                                    return writeSysFile("/sys/block/" + d + "/queue/read_ahead_kb", ra).catch(function(){});
                                });
                        });
                    });
                    mdDisks.forEach(function(d) {
                        chain = chain.then(function() {
                            return writeSysFile("/sys/block/" + d + "/queue/read_ahead_kb", "8192").catch(function(){});
                        });
                    });
                    return chain;
                });
            },
            persistFn: function() {
                var rules = [
                    'ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/read_ahead_kb}="8192", ATTR{queue/nr_requests}="256"',
                    'ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="0", ATTR{queue/read_ahead_kb}="512",  ATTR{queue/nr_requests}="256"',
                    'ACTION=="add|change", KERNEL=="md*",     ATTR{queue/read_ahead_kb}="8192"',
                    ""
                ].join("\n");
                return cockpit.file("/etc/udev/rules.d/71-rusnas-readahead.rules",
                    {superuser: "require"}).replace(rules)
                    .then(function() { return spawnSafe(["udevadm", "control", "--reload"]); });
            },
            rollbackFn: function() {
                return cockpit.file("/etc/udev/rules.d/71-rusnas-readahead.rules",
                    {superuser: "require"}).replace("# removed by rusNAS rollback\n");
            }
        },

        // ── RAID stripe_cache ─────────────────────────────────────────────────
        {
            id: "raid_stripe_cache", category: "RAID", param: "md.stripe_cache_size",
            label: "RAID stripe_cache_size",
            desc: "Страйп-кеш для RAID5/6. Увеличение с 256 до 2048-4096 даёт +15-25% последовательной записи. Размер в страницах (4 КБ каждая).",
            impact: "high", unit: " стр.",
            readFn: function() {
                return listBlockDevices(/^md/).then(function(devs) {
                    if (!devs.length) return "нет RAID";
                    var parts = devs.map(function(d) {
                        return spawnNoSudo(["cat", "/sys/block/" + d + "/md/stripe_cache_size"])
                            .then(function(v) { return v.trim() ? d + ": " + v.trim() : null; });
                    });
                    return Promise.all(parts).then(function(lines) {
                        var res = lines.filter(Boolean).join(", ");
                        return res || "нет RAID5/6";
                    });
                });
            },
            recommendFn: function(p) {
                var n = p.raidDisks || 3;
                if (n <= 3) return "2048";
                if (n <= 5) return "4096";
                return "8192";
            },
            applyFn: function(v) {
                return listBlockDevices(/^md/).then(function(devs) {
                    var chain = Promise.resolve();
                    devs.forEach(function(d) {
                        chain = chain.then(function() {
                            return writeSysFile("/sys/block/" + d + "/md/stripe_cache_size", v).catch(function(){});
                        });
                    });
                    return chain;
                });
            },
            persistFn: function(v) { return writeStripeService(v); },
            rollbackFn: function(orig) {
                if (!orig || orig.indexOf("нет") !== -1) return Promise.resolve();
                var m = orig.match(/:\s*(\d+)/);
                var val = m ? m[1] : "256";
                return listBlockDevices(/^md/).then(function(devs) {
                    var chain = Promise.resolve();
                    devs.forEach(function(d) {
                        chain = chain.then(function() {
                            return writeSysFile("/sys/block/" + d + "/md/stripe_cache_size", val).catch(function(){});
                        });
                    });
                    return chain;
                });
            }
        },

        // ── Transparent Hugepages ─────────────────────────────────────────────
        {
            id: "thp_defrag", category: "Память", param: "thp.defrag",
            label: "Transparent HugePages defrag",
            desc: "Режим 'never' для дефрагментации THP устраняет latency spikes от фоновой дефрагментации памяти.",
            impact: "low", unit: "",
            readFn: function() {
                return spawnNoSudo(["cat", "/sys/kernel/mm/transparent_hugepage/defrag"])
                    .then(function(v) {
                        var m = v.match(/\[([^\]]+)\]/);
                        return m ? m[1] : (v.trim() || "N/A");
                    });
            },
            recommendFn: function() { return "never"; },
            applyFn: function() {
                return writeSysFile("/sys/kernel/mm/transparent_hugepage/defrag", "never")
                    .then(function() {
                        return writeSysFile("/sys/kernel/mm/transparent_hugepage/enabled", "madvise").catch(function(){});
                    });
            },
            persistFn: function() {
                var svc = [
                    "[Unit]",
                    "Description=rusNAS THP settings",
                    "After=sysinit.target",
                    "[Service]",
                    "Type=oneshot",
                    "ExecStart=/bin/bash -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag; echo madvise > /sys/kernel/mm/transparent_hugepage/enabled'",
                    "RemainAfterExit=yes",
                    "[Install]",
                    "WantedBy=multi-user.target",
                    ""
                ].join("\n");
                return cockpit.file("/etc/systemd/system/rusnas-thp.service", {superuser: "require"})
                    .replace(svc)
                    .then(function() { return spawnSafe(["systemctl", "daemon-reload"]); })
                    .then(function() { return spawnSafe(["systemctl", "enable", "rusnas-thp.service"]); });
            },
            rollbackFn: function(orig) {
                if (!orig || orig === "N/A") return Promise.resolve();
                return writeSysFile("/sys/kernel/mm/transparent_hugepage/defrag", orig).catch(function(){});
            }
        }
    ];
}

// ─── sysctl.d persistence helpers ────────────────────────────────────────────

var SYSCTL_FILE = "/etc/sysctl.d/99-rusnas-perf.conf";

function writeSysctlConf(param, value) {
    return cockpit.file(SYSCTL_FILE, {superuser: "require"}).read()
    .then(function(content) {
        content = content || "";
        var lines = content.split("\n").filter(function(l) {
            return !l.match(new RegExp("^\\s*" + param.replace(".", "\\.") + "\\s*="));
        });
        lines.push(param + " = " + value);
        // Remove trailing blank lines, add one
        while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
        return cockpit.file(SYSCTL_FILE, {superuser: "require"})
            .replace(lines.join("\n") + "\n");
    })
    .catch(function() {
        return cockpit.file(SYSCTL_FILE, {superuser: "require"})
            .replace("# rusNAS performance tuning\n" + param + " = " + value + "\n");
    });
}

function removeSysctlConf(param) {
    return cockpit.file(SYSCTL_FILE, {superuser: "require"}).read()
    .then(function(content) {
        if (!content) return;
        var lines = content.split("\n").filter(function(l) {
            return !l.match(new RegExp("^\\s*" + param.replace(".", "\\.") + "\\s*="));
        });
        return cockpit.file(SYSCTL_FILE, {superuser: "require"})
            .replace(lines.join("\n"));
    })
    .catch(function() {});
}

function writeStripeService(value) {
    var svc = [
        "[Unit]",
        "Description=rusNAS RAID stripe_cache_size",
        "After=mdadm.service",
        "DefaultDependencies=no",
        "[Service]",
        "Type=oneshot",
        "ExecStart=/bin/bash -c 'for d in /sys/block/md*; do sc=/sys/block/$(basename $d)/md/stripe_cache_size; [ -f $sc ] && echo " + value + " > $sc; done'",
        "RemainAfterExit=yes",
        "[Install]",
        "WantedBy=multi-user.target",
        ""
    ].join("\n");
    return cockpit.file("/etc/systemd/system/rusnas-stripe-cache.service", {superuser: "require"})
        .replace(svc)
        .then(function() { return spawnSafe(["systemctl", "daemon-reload"]); })
        .then(function() { return spawnSafe(["systemctl", "enable", "rusnas-stripe-cache.service"]); });
}

// ─── System Profile Detection ─────────────────────────────────────────────────

function detectProfile() {
    var profile = { ramGB: 0, cpuCores: 1, hddCount: 0, ssdCount: 0,
                    raidDevices: [], raidDisks: 0, netIface: "", netSpeed: 1000 };

    return Promise.all([
        // RAM — /proc/meminfo, no sudo needed
        spawnNoSudo(["cat", "/proc/meminfo"]),
        // CPU cores
        spawnNoSudo(["nproc"]),
        // All block devices
        spawnNoSudo(["ls", "/sys/block"]),
        // RAID mdstat
        spawnNoSudo(["cat", "/proc/mdstat"]),
        // NIC speed — enumerate /sys/class/net
        spawnNoSudo(["ls", "/sys/class/net"]),
        // tuned active (needs sudo)
        spawnSafe(["tuned-adm", "active"])
    ]).then(function(results) {
        // RAM
        var memMatch = (results[0] || "").match(/MemTotal:\s+(\d+)\s+kB/);
        profile.ramGB = memMatch ? Math.round(parseInt(memMatch[1]) / 1048576) : 0;

        // CPU
        profile.cpuCores = parseInt(results[1]) || 1;

        // Disks — read rotational for each sd* device
        var blockDevs = (results[2] || "").trim().split("\n").filter(function(d) { return /^sd/.test(d); });
        var rotPromises = blockDevs.map(function(d) {
            return spawnNoSudo(["cat", "/sys/block/" + d + "/queue/rotational"])
                .then(function(v) { return v.trim(); });
        });

        // RAID
        var mdLines = (results[3] || "").split("\n").filter(function(l) { return /^md/.test(l); });
        profile.raidDevices = mdLines.map(function(l) { return l.split(/\s+/)[0]; }).filter(Boolean);

        // NIC speed — find first interface with positive speed
        var netIfaces = (results[4] || "").trim().split("\n").filter(function(i) {
            return i && i !== "lo";
        });
        var nicPromises = netIfaces.map(function(iface) {
            return spawnNoSudo(["cat", "/sys/class/net/" + iface + "/speed"])
                .then(function(v) { return { iface: iface, speed: parseInt(v) || 0 }; });
        });

        profile.tunedProfile = (results[5] || "").replace(/Current active profile:\s*/i, "").trim();

        return Promise.all([Promise.all(rotPromises), Promise.all(nicPromises)]);
    }).then(function(r) {
        var rotVals = r[0], nics = r[1];
        rotVals.forEach(function(v) {
            if (v === "1") profile.hddCount++;
            else if (v === "0") profile.ssdCount++;
        });
        profile.raidDisks = profile.hddCount;

        // Pick fastest NIC with valid speed
        nics.forEach(function(n) {
            if (n.speed > profile.netSpeed || (profile.netSpeed === 1000 && !profile.netIface)) {
                profile.netIface = n.iface;
                profile.netSpeed = n.speed || 1000;
            }
        });
        if (!profile.netIface && nics.length) {
            profile.netIface = nics[0].iface;
        }

        return profile;
    });
}

function renderProfile(p) {
    document.getElementById("prof-ram-val").textContent = p.ramGB + " ГБ";
    document.getElementById("prof-cpu-val").textContent = p.cpuCores + " ядер";

    var diskStr = [];
    if (p.hddCount) diskStr.push(p.hddCount + "× HDD");
    if (p.ssdCount) diskStr.push(p.ssdCount + "× SSD");
    document.getElementById("prof-disks-val").textContent = diskStr.join(" + ") || "нет данных";

    document.getElementById("prof-raid-val").textContent =
        p.raidDevices.length ? p.raidDevices.join(", ") : "нет RAID";

    document.getElementById("prof-net-val").textContent =
        p.netIface ? (p.netIface + " " + (p.netSpeed >= 10000 ? "10GbE" : p.netSpeed >= 2500 ? "2.5GbE" : "1GbE")) : "нет данных";

    document.getElementById("prof-tuned-val").textContent = p.tunedProfile || "не активен";
}

// ─── Load and render tuning table ─────────────────────────────────────────────

function loadTuningTable(profile) {
    var items = ITEMS();
    _tuneItems = items;

    // Read all current values in parallel
    var readPromises = items.map(function(item) {
        return item.readFn().catch(function() { return "ошибка"; });
    });

    Promise.all(readPromises).then(function(currentValues) {
        currentValues.forEach(function(val, i) {
            items[i]._currentValue = val;
            items[i]._recommendedValue = items[i].recommendFn(profile);
            // Save original for rollback
            if (!_origValues[items[i].id]) {
                _origValues[items[i].id] = val;
            }
        });

        renderTuningTable(items);
    });
}

function renderTuningTable(items) {
    var categories = [];
    var byCategory = {};
    items.forEach(function(item) {
        if (!byCategory[item.category]) {
            categories.push(item.category);
            byCategory[item.category] = [];
        }
        byCategory[item.category].push(item);
    });

    var html = "";
    categories.forEach(function(cat) {
        var catItems = byCategory[cat];
        html += "<div class='perf-category'>" + cat + "</div>";
        html += "<div class='perf-row-group'>";
        catItems.forEach(function(item) {
            var cur  = item._currentValue || "…";
            var rec  = item._recommendedValue || "";
            var same = valuesEqual(cur, rec);
            var applied = !!_appliedItems[item.id];

            var curHtml = "<span class='perf-val-cur'>" + escHtml(truncate(cur, 28)) + "</span>";
            var recHtml = same
                ? "<span class='perf-val-same'>✓ уже оптимально</span>"
                : "<span class='perf-val-rec'>" + escHtml(truncate(rec, 28)) + "</span>";

            var statusHtml = applied
                ? "<span class='perf-status-ok'>✓ применено</span>"
                : same
                    ? "<span class='perf-status-ok'>✓ OK</span>"
                    : "<span class='perf-status-todo'>⚑ рекомендуется</span>";

            var impactHtml = "<span class='perf-impact-" + item.impact + "'>" +
                (item.impact === "high" ? "HIGH" : item.impact === "med" ? "MED" : "LOW") + "</span>";

            var chkDisabled = same || applied ? " disabled" : "";
            var chkChecked  = (!same && !applied) ? " checked" : "";

            html += "<div class='perf-row' data-id='" + item.id + "'>" +
                "<input type='checkbox' class='perf-chk' data-id='" + item.id + "'" +
                    chkChecked + chkDisabled + " style='width:14px;height:14px'>" +
                "<div>" +
                    "<div class='perf-param'>" + escHtml(item.param) + " &nbsp; " + impactHtml + "</div>" +
                    "<div style='font-size:13px;margin-top:1px'>" + escHtml(item.label) + "</div>" +
                    "<div class='perf-desc'>" + escHtml(item.desc.substring(0, 80)) + "… " +
                        "<a href='#' class='perf-info-link' data-id='" + item.id + "'>подробнее</a></div>" +
                "</div>" +
                "<div>" + curHtml + "</div>" +
                "<div>" + recHtml + "</div>" +
                "<div>" + statusHtml + "</div>" +
                "<div id='perf-act-" + item.id + "'>" +
                    (same || applied ? "" :
                    "<button class='btn btn-sm btn-secondary perf-apply-btn' data-id='" + item.id + "' style='padding:2px 10px;font-size:12px'>Применить</button>") +
                "</div>" +
                "</div>";
        });
        html += "</div>";
    });

    document.getElementById("tuning-table").innerHTML = html;

    // Wire up info links
    document.getElementById("tuning-table").addEventListener("click", function(e) {
        var infoLink = e.target.closest(".perf-info-link");
        if (infoLink) { e.preventDefault(); openInfoModal(infoLink.dataset.id); return; }

        var applyBtn = e.target.closest(".perf-apply-btn");
        if (applyBtn) { applySingleItem(applyBtn.dataset.id); return; }
    });
}

function valuesEqual(cur, rec) {
    if (!cur || !rec) return false;
    // Normalize spaces for multi-value sysctls like "4096 87380 ..."
    return cur.trim().replace(/\s+/g, " ") === rec.trim().replace(/\s+/g, " ");
}

function truncate(s, n) {
    s = String(s || "");
    if (s.length <= n) return s;
    return s.substring(0, n) + "…";
}

function escHtml(s) {
    return String(s || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Apply logic ──────────────────────────────────────────────────────────────

function applySingleItem(id) {
    var item = _tuneItems.find(function(x) { return x.id === id; });
    if (!item) return;

    var actEl = document.getElementById("perf-act-" + id);
    actEl.innerHTML = "<span class='perf-status-spin'>⏳ Применяется…</span>";

    var rec = item._recommendedValue;
    item.applyFn(rec)
    .then(function() { return item.persistFn(rec); })
    .then(function() {
        _appliedItems[id] = true;
        // Update status cell and action cell
        var row = document.querySelector(".perf-row[data-id='" + id + "']");
        if (row) {
            var statusEl = row.querySelector(".perf-status-todo, .perf-status-err, .perf-status-spin");
            if (statusEl) statusEl.outerHTML = "<span class='perf-status-ok'>✓ применено</span>";
            var chk = row.querySelector(".perf-chk");
            if (chk) { chk.checked = false; chk.disabled = true; }
        }
        actEl.innerHTML = "<span class='perf-status-ok'>✓</span>";
        showBanner("✓ Применено: " + item.label, "success");
    })
    .catch(function(e) {
        actEl.innerHTML = "<button class='btn btn-sm btn-secondary perf-apply-btn' data-id='" + id + "' style='padding:2px 10px;font-size:12px'>Повторить</button>";
        showBanner("✗ Ошибка при применении " + item.param + ": " + (e || "неизвестная ошибка"), "danger");
    });
}

// ─── Staged apply with crash auto-rollback ────────────────────────────────────
// Phase 1: apply in-memory only (no persistence) — one by one with progress
// Phase 2: show 60s confirmation countdown
// Phase 3: confirm → persist; cancel/timeout → in-memory rollback
// Crash protection: persistent files are written ONLY after confirmation.
// If system crashes before confirmation, next boot uses original sysctl.d values.

var _confirmTimer       = null;
var _pendingPersistIds  = [];
var _CONFIRM_SECONDS    = 60;

function applySelected() {
    var ids = [];
    document.querySelectorAll(".perf-chk:checked:not(:disabled)").forEach(function(chk) {
        ids.push(chk.dataset.id);
    });
    if (!ids.length) { showBanner("Нет выбранных параметров", "info"); return; }

    var btn = document.getElementById("btn-apply-all");
    btn.disabled = true;

    var appliedIds = [];
    var chain = Promise.resolve();

    ids.forEach(function(id, idx) {
        chain = chain.then(function() {
            btn.textContent = "Шаг " + (idx + 1) + "/" + ids.length + "…";
            showBanner("⏳ Шаг " + (idx + 1) + "/" + ids.length + ": " + _itemParam(id), "info");
            return _applyInMemory(id).then(function() {
                appliedIds.push(id);
            }).catch(function(e) {
                console.error("Apply failed for", id, e);
                showBanner("✗ Ошибка на шаге " + (idx + 1) + " (" + _itemParam(id) + "): " + (e || ""), "danger");
            });
        });
    });

    chain.then(function() {
        btn.disabled = false;
        btn.textContent = "✓ Применить выбранные";
        if (!appliedIds.length) { showBanner("Ни один параметр не был применён", "info"); return; }
        _showConfirmPhase(appliedIds);
    });
}

function _itemParam(id) {
    var item = _tuneItems.find(function(x) { return x.id === id; });
    return item ? item.param : id;
}

// Apply in-memory only (applyFn), no persistFn yet
function _applyInMemory(id) {
    var item = _tuneItems.find(function(x) { return x.id === id; });
    if (!item) return Promise.resolve();
    var actEl = document.getElementById("perf-act-" + id);
    if (actEl) actEl.innerHTML = "<span class='perf-status-spin'>⏳</span>";
    var rec = item._recommendedValue;
    return item.applyFn(rec).then(function() {
        _appliedItems[id] = true;
        var row = document.querySelector(".perf-row[data-id='" + id + "']");
        if (row) {
            var s = row.querySelector("[class^='perf-status']");
            if (s) s.outerHTML = "<span class='perf-status-ok'>✓ в памяти</span>";
            var chk = row.querySelector(".perf-chk");
            if (chk) { chk.checked = false; chk.disabled = true; }
        }
        if (actEl) actEl.innerHTML = "<span class='perf-status-ok' title='Ожидает подтверждения'>⏳✓</span>";
    });
}

function _showConfirmPhase(appliedIds) {
    _pendingPersistIds = appliedIds;
    var modal    = document.getElementById("perf-confirm-modal");
    var countEl  = document.getElementById("perf-confirm-count");
    var barEl    = document.getElementById("perf-confirm-bar");
    var logEl    = document.getElementById("perf-confirm-stage-log");
    var countdown = _CONFIRM_SECONDS;

    logEl.innerHTML = appliedIds.map(function(id) {
        return "✓ " + _itemParam(id);
    }).join("<br>");

    countEl.textContent = countdown;
    barEl.style.width = "100%";
    modal.classList.remove("hidden");

    _confirmTimer = setInterval(function() {
        countdown--;
        countEl.textContent = countdown;
        barEl.style.width = Math.round(countdown / _CONFIRM_SECONDS * 100) + "%";
        if (countdown <= 0) {
            _autoRollback();
        }
    }, 1000);
}

function _autoRollback() {
    if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }
    document.getElementById("perf-confirm-modal").classList.add("hidden");
    showBanner("⏰ Время вышло — автооткат изменений в памяти…", "danger");
    var ids = _pendingPersistIds;
    _pendingPersistIds = [];
    _inMemoryRollback(ids).then(function() {
        _appliedItems = {};
        showBanner("✓ Автооткат выполнен. Персистентные файлы не изменены.", "success");
        setTimeout(function() { init(); }, 2000);
    });
}

function confirmChanges() {
    if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }
    document.getElementById("perf-confirm-modal").classList.add("hidden");
    var ids = _pendingPersistIds;
    _pendingPersistIds = [];
    showBanner("💾 Сохранение изменений персистентно…", "info");
    var chain = Promise.resolve();
    ids.forEach(function(id) {
        var item = _tuneItems.find(function(x) { return x.id === id; });
        if (!item) return;
        chain = chain.then(function() {
            return item.persistFn(item._recommendedValue).catch(function(e) {
                console.error("Persist failed for", id, e);
            });
        });
    });
    chain.then(function() {
        // Mark as fully applied in the table
        ids.forEach(function(id) {
            var actEl = document.getElementById("perf-act-" + id);
            if (actEl) actEl.innerHTML = "<span class='perf-status-ok'>✓</span>";
            var row = document.querySelector(".perf-row[data-id='" + id + "']");
            if (row) {
                var s = row.querySelector(".perf-status-ok");
                if (s && s.textContent.indexOf("памяти") !== -1) s.textContent = "✓ применено";
            }
        });
        showBanner("✓ Изменения сохранены персистентно и применятся при каждой загрузке системы", "success");
    });
}

function cancelConfirm() {
    if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }
    document.getElementById("perf-confirm-modal").classList.add("hidden");
    showBanner("Откат изменений…", "info");
    var ids = _pendingPersistIds;
    _pendingPersistIds = [];
    _inMemoryRollback(ids).then(function() {
        _appliedItems = {};
        showBanner("✓ Откат выполнен. Значения восстановлены.", "success");
        setTimeout(function() { init(); }, 1500);
    });
}

function _inMemoryRollback(ids) {
    var chain = Promise.resolve();
    ids.forEach(function(id) {
        var item = _tuneItems.find(function(x) { return x.id === id; });
        if (!item) return;
        var orig = _origValues[id];
        chain = chain.then(function() {
            return item.rollbackFn(orig).catch(function(e) {
                console.error("Rollback failed for", id, e);
            });
        });
    });
    return chain;
}

function rollbackAll() {
    if (!Object.keys(_appliedItems).length) {
        showBanner("Нет применённых изменений для отката", "info");
        return;
    }
    if (!confirm("Откатить все применённые изменения к исходным значениям?")) return;

    var btn = document.getElementById("btn-rollback-all");
    btn.disabled = true;
    btn.textContent = "Откат…";

    _inMemoryRollback(Object.keys(_appliedItems)).then(function() {
        _appliedItems = {};
        btn.disabled = false;
        btn.textContent = "↺ Откатить всё";
        showBanner("✓ Откат выполнен. Страница обновляется…", "success");
        setTimeout(function() { init(); }, 1500);
    });
}

// ─── Info modal ───────────────────────────────────────────────────────────────

var _infoData = {
    vm_swappiness:    { title: "vm.swappiness", body: "Контролирует агрессивность использования swap-раздела. Значение 0 = никогда не свапить, 100 = свапить агрессивно. <br><br>Для NAS рекомендуется <b>10</b>: система остаётся отзывчивой, рабочий набор данных остаётся в RAM.<br><br><b>Риск:</b> при нехватке RAM процессы могут получить OOM kill вместо ухода в своп. Мониторьте использование RAM через Dashboard." },
    vm_dirty_ratio:   { title: "vm.dirty_ratio", body: "Максимальный процент RAM, который может занимать «грязные» (немодифицированные на диске) страницы до принудительного сброса.<br><br>Дефолт 20% — при 16 ГБ RAM это 3.2 ГБ буфер. При значении 35% — 5.6 ГБ.<br><br>Больший буфер = лучший throughput для пакетной записи (файл-серверные нагрузки). При внезапном отключении питания (без UPS) больше данных потеряется — используйте UPS." },
    vm_dirty_writeback: { title: "vm.dirty_writeback_centisecs", body: "Интервал в сотых долях секунды, с которым ядро проверяет грязные страницы для фонового сброса.<br><br>Дефолт 500 = каждые 5 секунд. Значение 150 = каждые 1.5 секунды — более равномерная запись без всплесков." },
    vm_vfs_pressure:  { title: "vm.vfs_cache_pressure", body: "Управляет агрессивностью вытеснения inode/dentry кеша. 100 = дефолт (активное вытеснение). 50 = кеш сохраняется вдвое дольше.<br><br>Для NAS с тысячами файлов это ускоряет операции с метаданными (ls, stat, open)." },
    net_rmem_max:     { title: "net.core.rmem_max", body: "Максимальный размер приёмного буфера сокета (в байтах). TCP авто-тюнинг использует это значение как верхнюю границу.<br><br>128 МБ (134217728) нужно для насыщения 10GbE линка при RTT 1-5 мс. Для 1GbE достаточно 32 МБ.<br><br>Этот параметр <b>не выделяет память сразу</b> — только устанавливает максимум; реальное использование управляется TCP авто-тюнингом." },
    net_wmem_max:     { title: "net.core.wmem_max", body: "Аналог rmem_max для передачи (TX). Рекомендуется устанавливать одинаково с rmem_max." },
    net_tcp_rmem:     { title: "net.ipv4.tcp_rmem", body: "Три значения: минимальный, дефолтный и максимальный размер TCP RX буфера (байты).<br><br><b>min</b>: всегда гарантируется (4096 = 4 КБ).<br><b>default</b>: начальный размер (87380 ≈ 85 КБ).<br><b>max</b>: максимум для авто-тюнинга (128 МБ для 10GbE)." },
    net_tcp_wmem:     { title: "net.ipv4.tcp_wmem", body: "Аналог tcp_rmem для TX." },
    net_backlog:      { title: "net.core.netdev_max_backlog", body: "Максимальное число пакетов в очереди RX перед обработкой ядром. При 10GbE с маленькой очередью возможны дропы пакетов под нагрузкой." },
    net_somaxconn:    { title: "net.core.somaxconn", body: "Максимальная длина очереди ожидающих соединений (backlog) для listen() сокета. Важно при большом числе одновременных SMB/NFS клиентов." },
    net_bbr:          { title: "TCP BBR Congestion Control", body: "BBR (Bottleneck Bandwidth and RTT) — алгоритм управления перегрузкой от Google (2016). Работает лучше CUBIC на LAN, так как не ждёт потерь пакетов для снижения скорости, а оценивает пропускную способность и RTT напрямую.<br><br>Требует <b>net.core.default_qdisc=fq</b> (устанавливается автоматически).<br><br><b>Доступность:</b> ядро 4.9+. Debian 13: доступен." },
    raid_speed_max:   { title: "dev.raid.speed_limit_max", body: "Максимальная скорость ребилда RAID массива (КБ/с). Дефолт в ядре 200000 (200 МБ/с). Современные HDD пишут 150-250 МБ/с, поэтому 500000 разумный максимум.<br><br>Более быстрый ребилд = меньше время в деградированном состоянии." },
    raid_speed_min:   { title: "dev.raid.speed_limit_min", body: "Минимальная гарантированная скорость ребилда. Ядро не снизит скорость ниже этого значения даже под нагрузкой. 1000 КБ/с = минимальный прогресс." },
    cpu_governor:     { title: "CPU Governor: performance", body: "Режим масштабирования частоты CPU.<br><br><b>powersave/ondemand:</b> CPU работает на низкой частоте и масштабируется под нагрузку. Это создаёт latency spikes при старте интенсивных операций.<br><br><b>performance:</b> CPU всегда на максимальной частоте. Для NAS-сервера, работающего 24/7, это оптимально." },
    nfs_threads:      { title: "Потоки nfsd", body: "NFS сервер создаёт фиксированное число рабочих потоков для обработки RPC запросов. Если все потоки заняты, клиенты ждут.<br><br>Рекомендуется 2 потока на ядро CPU. Для 4 ядер = 8 потоков.<br><br><b>Мониторинг:</b> <code>cat /proc/net/rpc/nfsd</code> — строка 'th'. Если предпоследнее число (busy threads) близко к числу потоков — увеличьте." },
    io_scheduler_udev: { title: "I/O планировщик", body: "<b>mq-deadline (HDD):</b> Добавляет deadline для каждого запроса и сортирует по LBA адресу, минимизируя перемещения головки. На HDD даёт 3-5% улучшение throughput.<br><br><b>none (SSD/NVMe):</b> SSD не имеет механических ограничений — лишняя сортировка только добавляет overhead. 'none' отдаёт запросы устройству напрямую.<br><br>Применяется через udev rules — настройка персистентна и применяется к каждому диску при подключении." },
    readahead_udev:   { title: "Read-Ahead", body: "Предварительная выборка данных: ядро читает больше данных, чем запрошено, ожидая что они понадобятся.<br><br><b>8 МБ (HDD):</b> Для последовательного чтения (видео, резервные копии) снижает количество запросов к диску. Прирост +10-15%.<br><br><b>512 КБ (SSD):</b> SSD сам по себе быстрый; большой read-ahead при случайном доступе тратит пропускную способность впустую." },
    raid_stripe_cache:{ title: "RAID stripe_cache_size", body: "Для RAID5/6 каждая запись требует чтения старых данных и чётности (read-modify-write). Страйп-кеш хранит частично заполненные страйпы в памяти, объединяя несколько малых записей в одну операцию на диске.<br><br>Размер в страницах (4 КБ каждая). 2048 страниц = 8 МБ для 3-дискового RAID5. Прирост: +15-25% для последовательной записи.<br><br><b>Расчёт: </b> страниц × 4 КБ × число дисков = память." },
    thp_defrag:       { title: "THP Defragmentation", body: "Transparent HugePages — ядро объединяет 4 КБ страницы в 2 МБ страницы для снижения TLB промахов.<br><br><b>defrag=never:</b> Отключает фоновую дефрагментацию памяти. Дефрагментация может вызывать кратковременные паузы (latency spikes) при перераспределении памяти.<br><br><b>enabled=madvise:</b> THP включается только для процессов, запросивших это явно (madvise). Не влияет на Samba, NFS и ядро — они не используют madvise." }
};

function openInfoModal(id) {
    var data = _infoData[id];
    if (!data) return;
    document.getElementById("perf-info-title").textContent = data.title;
    document.getElementById("perf-info-body").innerHTML = data.body;
    document.getElementById("perf-info-modal").classList.remove("hidden");
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function showBanner(msg, type) {
    var el = document.getElementById("perf-status-banner");
    el.className = "alert alert-" + (type === "success" ? "success" : type === "danger" ? "danger" : "info");
    el.textContent = msg;
    el.classList.remove("hidden");
    if (type === "success") {
        setTimeout(function() { el.classList.add("hidden"); }, 4000);
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
    document.getElementById("tuning-table").innerHTML =
        "<div style='padding:24px;text-align:center;color:var(--color-muted)'>Загрузка данных…</div>";

    detectProfile().then(function(profile) {
        _profileData = profile;
        renderProfile(profile);
        loadTuningTable(profile);
    }).catch(function(e) {
        document.getElementById("tuning-table").innerHTML =
            "<div style='padding:24px;color:var(--danger,#f44336)'>Ошибка загрузки: " + escHtml(String(e)) + "</div>";
    });
}

document.addEventListener("DOMContentLoaded", function() {
    document.getElementById("btn-refresh").addEventListener("click", init);
    document.getElementById("btn-apply-all").addEventListener("click", applySelected);
    document.getElementById("btn-rollback-all").addEventListener("click", rollbackAll);
    document.getElementById("btn-perf-info-close").addEventListener("click", function() {
        document.getElementById("perf-info-modal").classList.add("hidden");
    });
    document.getElementById("btn-perf-confirm").addEventListener("click", confirmChanges);
    document.getElementById("btn-perf-cancel-apply").addEventListener("click", cancelConfirm);
    document.getElementById("chk-select-all").addEventListener("change", function() {
        var checked = this.checked;
        document.querySelectorAll(".perf-chk:not(:disabled)").forEach(function(chk) {
            chk.checked = checked;
        });
    });

    init();
});
