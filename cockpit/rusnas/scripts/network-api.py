#!/usr/bin/env python3
# rusNAS Network API
# /usr/share/cockpit/rusnas/scripts/network-api.py
# Called via: cockpit.spawn(['sudo', '-n', 'python3', SCRIPT, mode, ...args])
# All output as JSON to stdout.

import os, sys, json, subprocess, re, shutil, tempfile, time

INTERFACES_FILE = "/etc/network/interfaces"
RESOLV_CONF     = "/etc/resolv.conf"
HOSTS_FILE      = "/etc/hosts"
BAK_DIR         = "/etc/rusnas"
REVERT_SECONDS  = 90

# System hosts entries to preserve but not show in UI
SYSTEM_HOSTS_PREFIXES = ("127.", "::1", "ff02::", "fe00::")


def ok(data):
    print(json.dumps(data))

def err(msg):
    print(json.dumps({"ok": False, "error": msg}))

def run(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip(), r.returncode
    except Exception as e:
        return "", -1

def run_json(cmd, timeout=10):
    out, rc = run(cmd, timeout)
    try:
        return json.loads(out)
    except Exception:
        return None


# ── interfaces parser ──────────────────────────────────────────────────────────

def parse_interfaces(path=INTERFACES_FILE):
    """Parse /etc/network/interfaces into list of interface dicts."""
    ifaces = {}
    current = None
    auto_set = set()
    auto_keywords = {}   # name → "auto" | "allow-hotplug"

    try:
        with open(path) as f:
            lines = f.readlines()
    except OSError:
        return {}

    for line in lines:
        line_s = line.strip()
        if not line_s or line_s.startswith("#"):
            continue

        if line_s.startswith("auto ") or line_s.startswith("allow-hotplug "):
            keyword = line_s.split()[0]   # "auto" or "allow-hotplug"
            for name in line_s.split()[1:]:
                auto_set.add(name)
                auto_keywords[name] = keyword

        elif line_s.startswith("iface "):
            parts = line_s.split()
            if len(parts) >= 4:
                current = parts[1]
                family  = parts[2]   # inet / inet6
                method  = parts[3]   # static / dhcp / loopback / manual
                if current not in ifaces:
                    ifaces[current] = {
                        "name": current, "post_up": []
                    }
                # Prefer inet (IPv4) stanza for config_mode; don't overwrite with inet6
                if family == "inet" or "method" not in ifaces[current]:
                    ifaces[current].update({
                        "family": family,
                        "method": method,
                    })
                # Always track inet6 separately
                if family == "inet6":
                    ifaces[current]["method6"] = method

        elif current and line_s.startswith("address "):
            ifaces[current]["address"] = line_s.split(None, 1)[1].strip()
        elif current and line_s.startswith("netmask "):
            ifaces[current]["netmask"] = line_s.split(None, 1)[1].strip()
        elif current and line_s.startswith("gateway "):
            ifaces[current]["gateway"] = line_s.split(None, 1)[1].strip()
        elif current and line_s.startswith("mtu "):
            ifaces[current]["mtu"] = line_s.split(None, 1)[1].strip()
        elif current and line_s.startswith("dns-nameservers "):
            ifaces[current]["dns_nameservers"] = line_s.split(None, 1)[1].strip()
        elif current and re.match(r"post-up\s+ip\s+route\s+add\s+", line_s):
            ifaces[current]["post_up"].append(line_s.split("post-up ", 1)[1].strip())

    for name in auto_set:
        if name in ifaces:
            ifaces[name]["auto"] = True
            ifaces[name]["auto_keyword"] = auto_keywords.get(name, "auto")

    return ifaces


def mask_to_prefix(mask):
    """Convert netmask like 255.255.255.0 → 24, or pass through /24."""
    if mask.startswith("/"):
        return int(mask[1:])
    try:
        return sum(bin(int(x)).count("1") for x in mask.split("."))
    except Exception:
        return 24


def prefix_to_mask(prefix):
    """24 → 255.255.255.0"""
    try:
        prefix = int(prefix)
        bits = (0xFFFFFFFF >> (32 - prefix)) << (32 - prefix)
        return ".".join(str((bits >> (8 * i)) & 0xFF) for i in reversed(range(4)))
    except Exception:
        return "255.255.255.0"


# ── commands ───────────────────────────────────────────────────────────────────

def cmd_get_interfaces():
    """Return live interface info: ip -j addr + ip -j route + interfaces config."""
    addr_data  = run_json(["/sbin/ip", "-j", "addr"])  or []
    route_data = run_json(["/sbin/ip", "-j", "route"]) or []
    ifaces_cfg = parse_interfaces()

    # Build default gateway map per iface
    gw_map = {}
    for r in route_data:
        if r.get("dst") == "default":
            dev = r.get("dev", "")
            gw_map[dev] = r.get("gateway", "")

    result = []
    for iface in addr_data:
        name = iface.get("ifname", "")
        if name in ("lo",) and name not in ifaces_cfg:
            continue
        flags = iface.get("flags", [])
        is_up = "UP" in flags

        # Collect IPv4
        ipv4_list = []
        for ai in iface.get("addr_info", []):
            if ai.get("family") == "inet":
                ipv4_list.append({
                    "ip":     ai["local"],
                    "prefix": ai["prefixlen"],
                    "mask":   prefix_to_mask(ai["prefixlen"])
                })

        # Collect IPv6 (non link-local only for display)
        ipv6_list = []
        for ai in iface.get("addr_info", []):
            if ai.get("family") == "inet6":
                ipv6_list.append({
                    "ip":     ai["local"],
                    "prefix": ai["prefixlen"],
                    "scope":  ai.get("scope", "")
                })

        cfg = ifaces_cfg.get(name, {})

        entry = {
            "name":        name,
            "flags":       flags,
            "up":          is_up,
            "mac":         iface.get("address", ""),
            "mtu":         iface.get("mtu", 1500),
            "ipv4":        ipv4_list,
            "ipv6":        ipv6_list,
            "gateway":     gw_map.get(name, ""),
            "config_mode": cfg.get("method", "dhcp"),   # static / dhcp / …
            "config":      cfg,
            "link_type":   iface.get("link_type", "")
        }
        result.append(entry)

    ok({"ok": True, "interfaces": result})


def cmd_get_dns():
    """Parse /etc/resolv.conf; detect if it's managed by resolvconf/systemd-resolved."""
    manager = None
    if os.path.islink(RESOLV_CONF):
        target = os.readlink(RESOLV_CONF)
        if "systemd" in target:
            manager = "systemd-resolved"
        elif "resolvconf" in target:
            manager = "resolvconf"
        else:
            manager = target

    servers = []
    search  = ""
    try:
        with open(RESOLV_CONF) as f:
            for line in f:
                line = line.strip()
                if line.startswith("nameserver "):
                    servers.append(line.split(None, 1)[1])
                elif line.startswith("search "):
                    search = line.split(None, 1)[1]
                elif line.startswith("domain ") and not search:
                    search = line.split(None, 1)[1]
    except OSError:
        pass

    ok({"ok": True, "servers": servers, "search": search, "manager": manager})


def cmd_set_dns(servers_arg, search_arg):
    """Rewrite /etc/resolv.conf atomically."""
    lines = ["# Generated by rusNAS\n"]
    if search_arg:
        lines.append(f"search {search_arg}\n")
    for s in servers_arg.split(","):
        s = s.strip()
        if s:
            lines.append(f"nameserver {s}\n")

    try:
        tmp = RESOLV_CONF + ".rusnas.tmp"
        with open(tmp, "w") as f:
            f.writelines(lines)
        os.rename(tmp, RESOLV_CONF)
        ok({"ok": True})
    except Exception as e:
        err(str(e))


def cmd_get_hosts():
    """Return /etc/hosts entries, skipping system lines."""
    entries = []
    try:
        with open(HOSTS_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if any(line.startswith(p) for p in SYSTEM_HOSTS_PREFIXES):
                    continue
                parts = line.split()
                if len(parts) >= 2:
                    entries.append({
                        "ip":       parts[0],
                        "hostname": parts[1],
                        "aliases":  parts[2:]
                    })
    except OSError:
        pass
    ok({"ok": True, "hosts": entries})


def cmd_set_hosts(hosts_json):
    """Rewrite /etc/hosts, preserving system lines and replacing custom ones."""
    try:
        new_entries = json.loads(hosts_json)
    except Exception as e:
        err(f"Invalid JSON: {e}")
        return

    # Keep system lines
    system_lines = []
    try:
        with open(HOSTS_FILE) as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or any(s.startswith(p) for p in SYSTEM_HOSTS_PREFIXES):
                    system_lines.append(line if line.endswith("\n") else line + "\n")
    except OSError:
        system_lines = ["127.0.0.1\tlocalhost\n", "::1\tlocalhost ip6-localhost ip6-loopback\n"]

    custom_lines = []
    for e in new_entries:
        ip = e.get("ip", "").strip()
        hostname = e.get("hostname", "").strip()
        aliases  = " ".join(e.get("aliases", []))
        if ip and hostname:
            row = f"{ip}\t{hostname}"
            if aliases:
                row += f" {aliases}"
            custom_lines.append(row + "\n")

    try:
        tmp = HOSTS_FILE + ".rusnas.tmp"
        with open(tmp, "w") as f:
            f.writelines(system_lines)
            if custom_lines:
                f.write("\n# rusNAS custom entries\n")
                f.writelines(custom_lines)
        os.rename(tmp, HOSTS_FILE)
        ok({"ok": True})
    except Exception as e:
        err(str(e))


def cmd_get_routes():
    """Return ip route list as structured data."""
    route_data = run_json(["/sbin/ip", "-j", "route"]) or []
    ifaces_cfg = parse_interfaces()

    # Collect persistent routes from interfaces post-up
    persistent = set()
    for cfg in ifaces_cfg.values():
        for pu in cfg.get("post_up", []):
            m = re.match(r"ip route add (\S+)\s+via (\S+)", pu)
            if m:
                persistent.add((m.group(1), m.group(2)))

    routes = []
    for r in route_data:
        dst     = r.get("dst", "")
        gw      = r.get("gateway", "")
        dev     = r.get("dev", "")
        metric  = r.get("metric", "")
        is_perm = (dst, gw) in persistent or dst == "default"
        routes.append({
            "dst":       dst,
            "gateway":   gw,
            "dev":       dev,
            "metric":    metric,
            "persistent": is_perm,
            "proto":     r.get("protocol", "")
        })

    ok({"ok": True, "routes": routes})


def cmd_add_route(network, gateway, iface, metric, persist):
    """Add a route (runtime + optionally persist in /etc/network/interfaces)."""
    cmd = ["/sbin/ip", "route", "add", network, "via", gateway]
    if iface:
        cmd += ["dev", iface]
    if metric:
        cmd += ["metric", str(metric)]

    out, rc = run(["sudo", "-n"] + cmd)
    if rc != 0 and "File exists" not in out:
        err(f"ip route add failed: {out}")
        return

    if persist == "1" and iface:
        _persist_route_add(iface, network, gateway, metric)

    ok({"ok": True})


def _persist_route_add(iface, network, gateway, metric):
    """Append post-up ip route add to the interface block in /etc/network/interfaces."""
    line = f"\tpost-up ip route add {network} via {gateway}"
    if metric:
        line += f" metric {metric}"

    try:
        with open(INTERFACES_FILE) as f:
            content = f.read()

        # Find the iface block and append post-up after last line of that block
        pattern = re.compile(
            r"(iface\s+" + re.escape(iface) + r"\s+inet[6]?\s+\S+(?:\n(?:[ \t]+\S.*|\n))*)",
            re.MULTILINE
        )
        m = pattern.search(content)
        if m:
            old_block = m.group(0)
            new_block = old_block.rstrip("\n") + "\n" + line + "\n"
            content = content.replace(old_block, new_block)
        else:
            content += f"\n# Added by rusNAS\npost-up ip route add {network} via {gateway}\n"

        tmp = INTERFACES_FILE + ".rusnas.tmp"
        with open(tmp, "w") as f:
            f.write(content)
        os.rename(tmp, INTERFACES_FILE)
    except Exception:
        pass  # non-fatal


def cmd_del_route(network, gateway):
    """Delete a route (runtime)."""
    cmd = ["/sbin/ip", "route", "del", network]
    if gateway:
        cmd += ["via", gateway]
    out, rc = run(["sudo", "-n"] + cmd)
    if rc != 0:
        err(f"ip route del failed: {out}")
        return

    # Also remove from /etc/network/interfaces if present
    _persist_route_del(network, gateway)
    ok({"ok": True})


def _persist_route_del(network, gateway):
    try:
        with open(INTERFACES_FILE) as f:
            content = f.read()
        pattern = re.compile(
            r"[ \t]*post-up ip route add " + re.escape(network) + r".*\n?",
            re.MULTILINE
        )
        new_content = pattern.sub("", content)
        if new_content != content:
            tmp = INTERFACES_FILE + ".rusnas.tmp"
            with open(tmp, "w") as f:
                f.write(new_content)
            os.rename(tmp, INTERFACES_FILE)
    except Exception:
        pass


def _cleanup_rollback_files(iface):
    for path in [f"{BAK_DIR}/net-rollback-{iface}.bak",
                 f"{BAK_DIR}/net-rollback-{iface}.ts"]:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


def _do_revert(iface):
    bak = f"{BAK_DIR}/net-rollback-{iface}.bak"
    if os.path.exists(bak):
        shutil.copy2(bak, INTERFACES_FILE)
        run(["/usr/sbin/ifdown", iface])
        run(["/usr/sbin/ifup", iface], timeout=15)
    _cleanup_rollback_files(iface)


def cmd_set_interface(iface_name, config_json):
    """
    Rewrite the iface block for iface_name in /etc/network/interfaces.
    config_json: {"mode":"static","ip":"x","prefix":24,"gateway":"y","mtu":1500,"ipv6_mode":"off",...}
    Then apply with ifdown/ifup.
    """
    try:
        cfg = json.loads(config_json)
    except Exception as e:
        err(f"Invalid JSON: {e}")
        return

    mode = cfg.get("mode", "dhcp")
    mtu  = cfg.get("mtu", "")

    # Read existing config first — preserve auto_keyword and post-up routes
    ifaces_cfg = parse_interfaces()
    existing = ifaces_cfg.get(iface_name, {})
    auto_keyword = existing.get("auto_keyword", "auto")

    lines = [f"\n{auto_keyword} {iface_name}\n"]
    lines.append(f"iface {iface_name} inet {mode}\n")

    if mode == "static":
        ip     = cfg.get("ip", "")
        prefix = cfg.get("prefix", 24)
        gw     = cfg.get("gateway", "")
        if not ip:
            err("IP address required for static mode")
            return
        lines.append(f"\taddress {ip}\n")
        lines.append(f"\tnetmask {prefix_to_mask(prefix)}\n")
        if gw:
            lines.append(f"\tgateway {gw}\n")

    if mtu and str(mtu) != "1500":
        lines.append(f"\tmtu {mtu}\n")

    for pu in existing.get("post_up", []):
        lines.append(f"\tpost-up {pu}\n")

    # IPv6
    ipv6_mode = cfg.get("ipv6_mode", "off")
    if ipv6_mode != "off":
        method6 = {"auto": "auto", "dhcpv6": "dhcp", "static": "static"}.get(ipv6_mode, "auto")
        lines.append(f"\niface {iface_name} inet6 {method6}\n")
        if ipv6_mode == "static":
            v6addr   = cfg.get("ipv6_addr", "")
            v6prefix = cfg.get("ipv6_prefix", 64)
            if v6addr:
                lines.append(f"\taddress {v6addr}\n")
                lines.append(f"\tnetmask {v6prefix}\n")

    new_block = "".join(lines)

    bak_path = f"{BAK_DIR}/net-rollback-{iface_name}.bak"
    ts_path  = f"{BAK_DIR}/net-rollback-{iface_name}.ts"

    # Save backup BEFORE any changes
    try:
        os.makedirs(BAK_DIR, exist_ok=True)
        shutil.copy2(INTERFACES_FILE, bak_path)
    except Exception:
        pass  # non-fatal

    try:
        with open(INTERFACES_FILE) as f:
            content = f.read()

        # Remove existing auto/allow-hotplug + iface blocks for this interface
        content = re.sub(r"\b(?:auto|allow-hotplug)\s+" + re.escape(iface_name) + r"[ \t]*\n", "", content)
        # iface block(s)
        content = re.sub(
            r"iface\s+" + re.escape(iface_name) + r"\s+inet6?\s+\S+(?:\n(?:[ \t]+\S.*|\n))*",
            "",
            content
        )
        content = content.rstrip("\n") + "\n" + new_block

        tmp = INTERFACES_FILE + ".rusnas.tmp"
        with open(tmp, "w") as f:
            f.write(content)
        os.rename(tmp, INTERFACES_FILE)
    except Exception as e:
        _cleanup_rollback_files(iface_name)
        err(f"Write error: {e}")
        return

    # Apply: ifdown + ifup
    run(["/usr/sbin/ifdown", iface_name])
    _, rc = run(["/usr/sbin/ifup", iface_name], timeout=15)
    if rc != 0:
        # ifup failed — auto-revert immediately
        _do_revert(iface_name)
        ok({"ok": False, "error": f"ifup failed (rc={rc}), config reverted automatically"})
        return

    # Arm auto-revert timer
    expires_at = time.time() + REVERT_SECONDS
    try:
        with open(ts_path, "w") as f:
            f.write(str(expires_at))
    except Exception:
        pass

    unit_name  = f"rusnas-net-revert-{iface_name}"
    revert_cmd = ["python3", "/usr/share/cockpit/rusnas/scripts/network-api.py",
                  "_revert-apply", iface_name]
    run(["systemd-run",
         f"--on-active={REVERT_SECONDS}s",
         f"--unit={unit_name}",
         "--description=rusNAS network auto-revert",
         "--"] + revert_cmd)

    ok({"ok": True, "pending": True, "seconds": REVERT_SECONDS})


def cmd_confirm_change(iface):
    unit = f"rusnas-net-revert-{iface}"
    run(["systemctl", "stop", f"{unit}.timer"])
    run(["systemctl", "stop", f"{unit}.service"])
    _cleanup_rollback_files(iface)
    ok({"ok": True})


def cmd_revert_change(iface):
    unit = f"rusnas-net-revert-{iface}"
    run(["systemctl", "stop", f"{unit}.timer"])
    run(["systemctl", "stop", f"{unit}.service"])
    _do_revert(iface)
    ok({"ok": True})


def cmd_get_pending(iface):
    bak  = f"{BAK_DIR}/net-rollback-{iface}.bak"
    ts_f = f"{BAK_DIR}/net-rollback-{iface}.ts"
    if not os.path.exists(bak):
        ok({"ok": True, "pending": False})
        return
    _, rc = run(["systemctl", "is-active", f"rusnas-net-revert-{iface}.timer"])
    if rc != 0:
        _cleanup_rollback_files(iface)
        ok({"ok": True, "pending": False})
        return
    remaining = REVERT_SECONDS
    try:
        expires = float(open(ts_f).read())
        remaining = max(0, int(expires - time.time()))
    except Exception:
        pass
    ok({"ok": True, "pending": True, "seconds": remaining})


def cmd_revert_apply(iface):
    """Called by systemd transient timer when admin doesn't confirm."""
    _do_revert(iface)
    ok({"ok": True})


def cmd_ifdown(iface_name):
    out, rc = run(["sudo", "-n", "/usr/sbin/ifdown", iface_name])
    ok({"ok": rc == 0, "output": out})


def cmd_ifup(iface_name):
    out, rc = run(["sudo", "-n", "/usr/sbin/ifup", iface_name], timeout=15)
    ok({"ok": rc == 0, "output": out})


# ── dispatch ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        err("No command")
        sys.exit(1)

    cmd  = sys.argv[1]
    args = sys.argv[2:]

    dispatch = {
        "get-interfaces": lambda: cmd_get_interfaces(),
        "get-dns":        lambda: cmd_get_dns(),
        "get-hosts":      lambda: cmd_get_hosts(),
        "get-routes":     lambda: cmd_get_routes(),
        "set-dns":        lambda: cmd_set_dns(args[0] if args else "", args[1] if len(args)>1 else ""),
        "set-hosts":      lambda: cmd_set_hosts(args[0] if args else "[]"),
        "add-route":      lambda: cmd_add_route(
            args[0] if len(args)>0 else "",
            args[1] if len(args)>1 else "",
            args[2] if len(args)>2 else "",
            args[3] if len(args)>3 else "",
            args[4] if len(args)>4 else "0",
        ),
        "del-route":      lambda: cmd_del_route(
            args[0] if len(args)>0 else "",
            args[1] if len(args)>1 else "",
        ),
        "set-interface":  lambda: cmd_set_interface(
            args[0] if len(args)>0 else "",
            args[1] if len(args)>1 else "{}",
        ),
        "ifdown":           lambda: cmd_ifdown(args[0] if args else ""),
        "ifup":             lambda: cmd_ifup(args[0] if args else ""),
        "confirm-change":   lambda: cmd_confirm_change(args[0] if args else ""),
        "revert-change":    lambda: cmd_revert_change(args[0] if args else ""),
        "get-pending":      lambda: cmd_get_pending(args[0] if args else ""),
        "_revert-apply":    lambda: cmd_revert_apply(args[0] if args else ""),
    }

    if cmd in dispatch:
        dispatch[cmd]()
    else:
        err(f"Unknown command: {cmd}")
