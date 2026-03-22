# rusNAS — Domain Services ТЗ и архитектура

> Реализовано: 2026-03-22, ветка `feature/network`
> UI: вкладка «🏢 Домен» в `network.html` (6-я вкладка)
> Backend: `cockpit/rusnas/scripts/domain-api.py`
> Деплой: `./deploy.sh` + `./install-network.sh`

---

## Назначение

Модуль Domain Services позволяет русNAS работать в двух взаимоисключающих режимах:

| Режим | Назначение |
|-------|-----------|
| **Участник домена** | NAS присоединяется к существующему AD (Windows Server или Samba). SMB-шары принимают доменную аутентификацию. |
| **Контроллер домена** | NAS сам является Samba AD DC — совместим с Windows AD. Управление пользователями, группами, DNS, GPO, репликацией. |

---

## Технологический стек

| Компонент | Режим | Назначение |
|-----------|-------|-----------|
| `realmd` + `adcli` | Member | Join/leave домена (обёртка над net ads) |
| `winbind` + `libnss-winbind` + `libpam-winbind` | Member | SMB-аутентификация доменных пользователей |
| `sssd` + `sssd-tools` | Member | Альтернативный метод (Linux-логины через AD) |
| `krb5-user` | Both | Kerberos TGT — `kinit`, `klist`, `kinit -R` |
| `samba` (full) | DC | Samba AD Domain Controller |
| `samba-ad-dc` | DC | Дополнительные компоненты DC |
| `bind9` + `bind9utils` | DC | DNS с DLZ backend (опция для production) |
| `samba-common-bin` | Both | `net ads join/testjoin`, `samba-tool` |

---

## Схема работы: автоопределение режима

```
detect-mode (domain-api.py)
│
├─ systemctl is-active samba-ad-dc == active?
│    └─ YES → mode = "dc"
│
├─ systemctl is-active winbind == active?
│    └─ YES → wbinfo --own-domain (не WORKGROUP?)
│              └─ YES → mode = "member"
│
└─ mode = "none" (не подключён)
```

---

## Режим 1: Участник домена

### Схема интеграции SMB с AD

```
Windows клиент
    │ SMB (Kerberos / NTLM)
    ▼
rusNAS smbd
    │ PAM/NSS lookup
    ▼
winbind daemon ──────────────────────────────►  Active Directory DC
    │                                           (Windows Server / Samba AD)
    │  Kerberos TGT (krb5-user)
    │  LDAP (adcli)
    ▼
/etc/samba/smb.conf [global]
    security = ads
    realm = COMPANY.LOCAL
    workgroup = COMPANY
    kerberos method = secrets and keytab
    winbind use default domain = yes
    template shell = /bin/bash
    template homedir = /home/%U
```

### Процесс Join

```
realm discover COMPANY.LOCAL
    → realm join -U Administrator COMPANY.LOCAL
    → (internally: kinit Administrator@COMPANY.LOCAL)
    → (internally: net ads join)
    → update smb.conf [global]: security=ads, realm=...
    → update /etc/nsswitch.conf: passwd/group → winbind
    → systemctl enable --now winbind
    → wbinfo -P (проверка ping DC)
```

### NSSwitch после Join

```
# /etc/nsswitch.conf
passwd:     files winbind
group:      files winbind
```

### IDmap (смапирование UID/GID для доменных пользователей)

```
# smb.conf
idmap config * : backend = tdb
idmap config * : range = 3000-7999
idmap config COMPANY : backend = ad
idmap config COMPANY : range = 10000-999999
```

Стратегия `ad` использует атрибуты `uidNumber`/`gidNumber` из AD (RFC 2307) если они заданы. Иначе — `tdb` с автоназначением из диапазона.

### Разрешённые группы (realm permit/deny)

```bash
realm permit -g "Domain Admins"
realm permit -g "IT Staff"
realm deny --all        # запретить всех кроме разрешённых
```

Хранится в `/etc/sssd/sssd.conf` → `simple_allow_groups` (если SSSD) или в smb.conf → `valid users = @"COMPANY\Domain Admins"` (если Winbind).

---

## Режим 2: Контроллер домена (Samba AD DC)

### Архитектура Samba AD DC

```
Клиент Windows/Linux
    │
    ├── LDAP :389 / LDAPS :636    ──►  Samba AD DC
    ├── Kerberos :88              ──►  Samba KDC (встроен)
    ├── DNS :53                   ──►  Samba DNS (internal) или BIND9 DLZ
    ├── SMB :445                  ──►  samba service (не smbd)
    └── GC :3268                  ──►  Global Catalog
```

> **Важно:** В режиме DC служба `samba-ad-dc` заменяет `smbd`/`nmbd` — они не должны работать одновременно.

### Процесс Provision

```bash
samba-tool domain provision \
    --realm=COMPANY.LOCAL \
    --domain=COMPANY \
    --adminpass="Password123!" \
    --dns-backend=SAMBA_INTERNAL \
    --use-rfc2307
```

После provision:
```bash
# Настройка Kerberos
cp /var/lib/samba/private/krb5.conf /etc/krb5.conf

# Запуск
systemctl enable --now samba-ad-dc
```

### Структура /etc/samba/smb.conf после provision

```ini
[global]
    workgroup = COMPANY
    realm = COMPANY.LOCAL
    netbios name = RUSNAS
    server role = active directory domain controller
    dns forwarder = 8.8.8.8

[netlogon]
    path = /var/lib/samba/sysvol/company.local/scripts
    read only = No

[sysvol]
    path = /var/lib/samba/sysvol
    read only = No
```

### Уровни домена (--function-level)

| Значение | Windows совместимость |
|----------|----------------------|
| `2008_R2` | Windows Server 2008 R2 и выше |
| `2012_R2` | Windows Server 2012 R2 и выше (рекомендуется) |
| `2016` | Windows Server 2016 и выше |

### DNS backends

| Backend | Когда использовать |
|---------|-------------------|
| `SAMBA_INTERNAL` | Тест, small office. Samba сам отвечает на DNS :53. |
| `BIND9_DLZ` | Production. BIND9 загружает зоны через DLZ-плагин из Samba LDB. Поддерживает DNSSEC, zone transfers, split-brain DNS. |

### FSMO роли

5 ролей, всегда на первом DC при provision:

| Роль | Описание |
|------|---------|
| Schema Master | Единственный, кто может расширять схему AD |
| Domain Master | Управляет именованием объектов домена |
| PDC Emulator | Синхронизация паролей, мастер времени |
| RID Manager | Выдаёт пулы RID новым DC |
| Infrastructure Master | Обновляет cross-domain object references |

Передача роли: `samba-tool fsmo transfer --role=<role>`

### Репликация (при наличии нескольких DC)

```
Первичный DC (rusnas)       Дополнительный DC (dc2)
        │                            │
        ├── DRS (Directory Replication Service)
        │   ← samba-tool drs replicate
        │   ← samba-tool drs showrepl
        │
        └── USN (Update Sequence Number) tracking
```

Добавление второго DC:
```bash
# На дополнительном DC:
samba-tool domain join COMPANY.LOCAL DC \
    -U administrator@COMPANY.LOCAL \
    --dns-backend=SAMBA_INTERNAL
```

---

## Backend: domain-api.py

**Расположение:** `/usr/share/cockpit/rusnas/scripts/domain-api.py`
**Запуск:** `sudo python3 domain-api.py COMMAND [ARGS...]`
**Вывод:** JSON в stdout, всегда `{"ok": true/false, ...}`

### Команды — общие

| Команда | Что делает |
|---------|-----------|
| `detect-mode` | Определяет текущий режим: `dc` / `member` / `none` |

### Команды — Member режим

| Команда | Инструмент |
|---------|-----------|
| `status` | `realm list` + `systemctl is-active` + `wbinfo -P` + `klist -s` |
| `discover DOMAIN` | `realm discover DOMAIN` |
| `join DOMAIN USER METHOD PASS` | `realm join -U USER DOMAIN` (METHOD=winbind/sssd) |
| `leave USER PASS` | `realm leave -U USER DOMAIN` |
| `list-users` | `wbinfo -u` |
| `list-groups` | `wbinfo -g` |
| `list-permitted` | `realm list` → parse AllowedGroups |
| `permit-group GROUP` | `realm permit -g GROUP` |
| `deny-group GROUP` | `realm deny -g GROUP` |
| `get-smb-global` | parse `/etc/samba/smb.conf` [global] |
| `set-smb-global KEY VALUE` | sed update [global] в smb.conf |
| `kerberos-renew` | `kinit -R` |
| `restart-winbind` | `systemctl restart winbind` |

### Команды — DC режим

| Команда | Инструмент |
|---------|-----------|
| `dc-status` | `samba-tool domain info` + `samba-tool fsmo show` + `systemctl is-active` |
| `dc-provision DOMAIN NB PASS DNS RFC` | `samba-tool domain provision` + krb5.conf + systemctl |
| `dc-user-list` | `samba-tool user list` + `samba-tool user show` |
| `dc-user-add USER PASS FULLNAME EMAIL` | `samba-tool user create` |
| `dc-user-delete USER` | `samba-tool user delete` |
| `dc-user-setpass USER PASS` | `samba-tool user setpassword` |
| `dc-user-enable USER` | `samba-tool user enable` |
| `dc-user-disable USER` | `samba-tool user disable` |
| `dc-group-list` | `samba-tool group list` |
| `dc-group-members GRP` | `samba-tool group listmembers` |
| `dc-group-add GRP` | `samba-tool group add` |
| `dc-group-delete GRP` | `samba-tool group delete` |
| `dc-group-addmember GRP USER` | `samba-tool group addmembers` |
| `dc-group-delmember GRP USER` | `samba-tool group removemembers` |
| `dc-repl-status` | `samba-tool drs showrepl` |
| `dc-repl-sync` | `samba-tool drs replicate` |
| `dc-dns-query ZONE` | `samba-tool dns query 127.0.0.1 ZONE @ ALL` |
| `dc-dns-add ZONE NAME TYPE VAL` | `samba-tool dns add` |
| `dc-dns-delete ZONE NAME TYPE VAL` | `samba-tool dns delete` |
| `dc-gpo-list` | `samba-tool gpo listall` |
| `dc-gpo-create NAME` | `samba-tool gpo create` |
| `dc-fsmo-show` | `samba-tool fsmo show` |

---

## Sudoers

Файл: `/etc/sudoers.d/rusnas-domain`

```
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/domain-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/sbin/realm
rusnas ALL=(ALL) NOPASSWD: /usr/bin/net
rusnas ALL=(ALL) NOPASSWD: /usr/bin/wbinfo
rusnas ALL=(ALL) NOPASSWD: /usr/bin/samba-tool
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart winbind
rusnas ALL=(ALL) NOPASSWD: /bin/systemctl restart smbd
rusnas ALL=(ALL) NOPASSWD: /usr/bin/kinit
```

---

## Пакеты Debian 13

```bash
# Member mode
apt-get install -y realmd adcli winbind libnss-winbind libpam-winbind krb5-user samba-common-bin

# DC mode (дополнительно)
apt-get install -y samba samba-ad-dc bind9 bind9utils
```

> **Важно для DC:** `samba` full-пакет конфликтует с `samba-ad-dc` на уровне конфигурации. Перед provision отключить `smbd`/`nmbd`:
> ```bash
> systemctl disable --now smbd nmbd
> systemctl unmask samba-ad-dc
> systemctl enable --now samba-ad-dc
> ```

---

## UI: структура вкладки «🏢 Домен»

```
network.html → tab-domain
│
├── [mode selector] ○ Участник домена  ● Контроллер домена
│
├── Member Panel (domainMemberPanel)
│   ├── 📊 Обзор          → loadMemberOverview()  → status
│   ├── 🔗 Подключение    → loadMemberJoin()      → join / leave
│   ├── 👥 Пользователи   → loadDomainUsers()     → list-users / list-groups / permit
│   └── ⚙️ Samba          → loadSmbGlobal()       → get-smb-global / set-smb-global
│
└── DC Panel (domainDcPanel)
    ├── 📊 Обзор          → loadDcOverview()      → dc-status
    ├── ⚙️ Создать домен  → initDcProvision()     → dc-provision
    ├── 👥 Пользователи   → loadDcUsers()         → dc-user-*
    ├── 🏢 Группы         → loadDcGroups()        → dc-group-*
    ├── 🔗 Репликация     → loadDcRepl()          → dc-repl-*
    ├── 🌐 DNS            → queryDcDns()          → dc-dns-*
    └── 📋 Политики       → loadDcGpo()           → dc-gpo-*
```

### Глобальные переменные JS

```javascript
_domainMode   // null | "member" | "dc" | "none"
_domainState  // { joined, domain, workgroup, dc, method, ... }
_dcState      // { provisioned, domain, realm, netbios, fsmo, ... }
_domainTabLoaded  // bool — lazy init guard
_dcGroupCurrent   // string — для modal участников группы
```

---

## Ограничения и известные нюансы

### Member mode

- `realm join` использует пароль через stdin (безопаснее, чем аргумент CLI).
- `wbinfo -u` выдаёт `DOMAIN\username` — strip-ится до просто `username` для отображения.
- `klist -s` возвращает RC=0 только если TGT существует и не истёк.
- `nsswitch.conf` должен быть обновлён вручную или через `realm join` (он делает это автоматически).
- Winbind может показывать `joined: true` через несколько секунд после join — UI показывает статус через `wbinfo -P`, а не через `realm list`.

### DC mode

- **Нельзя запускать smbd и samba-ad-dc одновременно** — `samba-ad-dc` включает свой SMB-стек.
- `dc-user-list` вызывает `samba-tool user show` для каждого пользователя — при большой базе (1000+) медленно. Для prod использовать `samba-tool user list --full-dn` + LDAP-запрос.
- DNS-записи типа SRV парсятся из вывода `samba-tool dns query` — формат нестабилен между версиями Samba.
- `samba-tool domain provision` требует что hostname уже настроен (FQDN резолвится в localhost).

---

## Проверка после деплоя

```bash
# Тест API
sudo python3 /usr/share/cockpit/rusnas/scripts/domain-api.py detect-mode
sudo python3 /usr/share/cockpit/rusnas/scripts/domain-api.py status
sudo python3 /usr/share/cockpit/rusnas/scripts/domain-api.py dc-status
sudo python3 /usr/share/cockpit/rusnas/scripts/domain-api.py get-smb-global

# Member: join тест
sudo python3 /usr/share/cockpit/rusnas/scripts/domain-api.py discover COMPANY.LOCAL

# Пакеты
dpkg -l realmd adcli winbind krb5-user | grep -E "^ii"

# Судоерс
sudo visudo -c
```

---

## Связанные файлы

| Файл | Назначение |
|------|-----------|
| `cockpit/rusnas/network.html` | 6-я вкладка + модалы |
| `cockpit/rusnas/js/network.js` | domainApi() + вся JS-логика |
| `cockpit/rusnas/css/network.css` | Стили domain-* компонентов |
| `cockpit/rusnas/scripts/domain-api.py` | Backend 888 строк, 35 команд |
| `install-network.sh` | Деплой пакетов + судоерс |
| [network.html вкладки 1–5] | ifupdown, DNS, маршруты, диагностика, сертификаты |
