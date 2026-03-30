# API управления сетью

**network-api.py** — backend управления сетевой конфигурацией.

- **Размещение:** `/usr/share/cockpit/rusnas/scripts/network-api.py`
- **Вызов:** `cockpit.spawn(["sudo", "-n", "python3", path, cmd, ...])`
- **Config:** `/etc/network/interfaces` (ifupdown)

## Доступные команды

| Группа | Команда | Описание |
|--------|---------|----------|
| Интерфейсы | `list_interfaces` | Список через `ip -j addr` |
| | `set_interface` | DHCP/static IP, MTU |
| | `apply_interface` | ifdown + config write + ifup |
| DNS | `get_dns` | Чтение /etc/resolv.conf |
| | `set_dns` | Запись nameservers |
| Hosts | `get_hosts` | Чтение /etc/hosts |
| | `set_hosts` | Запись /etc/hosts |
| Маршруты | `list_routes` | `ip -j route` |
| | `add_route` | Добавить статический маршрут |
| | `del_route` | Удалить маршрут |
| Диагностика | `ping` | `/usr/bin/ping -c 4` |
| | `traceroute` | `/usr/bin/traceroute` |
| | `dns_lookup` | `/usr/bin/dig` |
| | `port_check` | `nc` (netcat-openbsd) |
| | `wol` | Wake-on-LAN по MAC |
| Bonding | `create_bond` | LACP/active-backup/round-robin |
| VLAN | `create_vlan` | Виртуальный интерфейс |
| Certs | `certbot_issue` | Let's Encrypt сертификат |
| DDNS | `ddns_update` | Dynamic DNS обновление |
