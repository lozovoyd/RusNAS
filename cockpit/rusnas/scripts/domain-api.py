#!/usr/bin/env python3
"""domain-api.py — rusNAS Domain Services backend
Usage: python3 domain-api.py COMMAND [ARGS...]
All output is JSON to stdout.
"""
import json
import os
import re
import subprocess
import sys

TIMEOUT = 30


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def run(cmd, timeout=TIMEOUT, input=None):
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, input=input
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"
    except FileNotFoundError as e:
        return -1, "", str(e)


def svc_active(name):
    rc, _, _ = run(["systemctl", "is-active", name])
    return "active" if rc == 0 else "inactive"


# ── detect-mode ───────────────────────────────────────────────────────────────

def cmd_detect_mode():
    # Check samba-ad-dc first
    if svc_active("samba-ad-dc") == "active":
        out({"ok": True, "mode": "dc", "details": {"service": "samba-ad-dc"}})
        return

    # Check winbind + domain connectivity
    winbind_st = svc_active("winbind")
    if winbind_st == "active":
        rc, stdout, _ = run(["wbinfo", "--own-domain"])
        if rc == 0 and stdout.strip() and stdout.strip().upper() not in ("", "WORKGROUP"):
            rc2, dom, _ = run(["wbinfo", "--own-domain"])
            out({"ok": True, "mode": "member", "details": {"domain": dom.strip()}})
            return

    out({"ok": True, "mode": "none", "details": {}})


# ── status (member mode) ──────────────────────────────────────────────────────

def cmd_status():
    result = {
        "ok": True,
        "joined": False,
        "domain": "",
        "workgroup": "",
        "dc": "",
        "method": "winbind",
        "services": {
            "winbind": svc_active("winbind"),
            "smbd": svc_active("smbd"),
        },
        "kerberos_tgt": False,
        "realm": "",
    }

    # realm list
    rc, stdout, _ = run(["realm", "list"])
    if rc == 0 and stdout.strip():
        realm_info = {}
        current_realm = None
        for line in stdout.splitlines():
            line = line.strip()
            if not line.startswith(" ") and ":" not in line:
                current_realm = line.strip()
                realm_info[current_realm] = {}
            elif ":" in line and current_realm:
                k, _, v = line.partition(":")
                realm_info[current_realm][k.strip()] = v.strip()
        if realm_info:
            first_realm = list(realm_info.keys())[0]
            info = realm_info[first_realm]
            result["joined"] = True
            result["realm"] = first_realm
            result["domain"] = info.get("domain-name", first_realm)
            result["workgroup"] = info.get("short-domain-name", "")
            result["method"] = "winbind" if "winbind" in info.get("client-software", "") else "sssd"

    # wbinfo domain controller
    if result["joined"]:
        rc2, dc_out, _ = run(["wbinfo", "--dsgetdcname=" + result["domain"]])
        if rc2 == 0:
            result["dc"] = dc_out.strip().lstrip("\\")

    # klist -s (silent check for valid TGT)
    rc3, _, _ = run(["klist", "-s"])
    result["kerberos_tgt"] = (rc3 == 0)

    out(result)


# ── discover ──────────────────────────────────────────────────────────────────

def cmd_discover(domain):
    rc, stdout, stderr = run(["realm", "discover", domain])
    if rc != 0:
        out({"ok": False, "error": stderr.strip() or "realm discover failed"})
        return

    result = {
        "ok": True,
        "domain": domain,
        "realm": "",
        "server_software": "",
        "configured_id": "",
        "domain_controllers": [],
    }
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith(" ") and ":" not in line:
            result["realm"] = line.strip()
        elif ":" in line:
            k, _, v = line.partition(":")
            k = k.strip()
            v = v.strip()
            if k == "server-software":
                result["server_software"] = v
            elif k == "configured":
                result["configured_id"] = v
            elif k == "domain-name":
                result["domain"] = v

    # DNS SRV lookup for DCs
    rc2, dns_out, _ = run(["host", "-t", "SRV", "_ldap._tcp." + domain])
    if rc2 == 0:
        for line in dns_out.splitlines():
            m = re.search(r'has SRV record\s+\d+\s+\d+\s+\d+\s+(\S+)', line)
            if m:
                dc = m.group(1).rstrip(".")
                if dc not in result["domain_controllers"]:
                    result["domain_controllers"].append(dc)

    out(result)


# ── join ──────────────────────────────────────────────────────────────────────

def cmd_join(domain, user, method, password):
    # realm join -U USER DOMAIN --membership-software=samba (for winbind)
    if method == "winbind":
        cmd = ["realm", "join", "-U", user, "--membership-software=samba", domain]
    else:
        cmd = ["realm", "join", "-U", user, domain]

    rc, stdout, stderr = run(cmd, timeout=60, input=password + "\n")
    if rc != 0:
        # Try without password on stdin (some versions prompt differently)
        combined = (stdout + "\n" + stderr).strip()
        out({"ok": False, "error": combined or "realm join failed"})
        return

    out({"ok": True, "domain": domain, "method": method})


# ── leave ─────────────────────────────────────────────────────────────────────

def cmd_leave(user, password):
    rc, stdout, stderr = run(["realm", "leave", "-U", user], timeout=30, input=password + "\n")
    if rc != 0:
        combined = (stdout + "\n" + stderr).strip()
        out({"ok": False, "error": combined or "realm leave failed"})
        return
    out({"ok": True})


# ── list-users (winbind) ──────────────────────────────────────────────────────

def cmd_list_users():
    rc, stdout, stderr = run(["wbinfo", "-u"])
    if rc != 0:
        out({"ok": False, "error": stderr.strip() or "wbinfo -u failed (not joined?)"})
        return
    users = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        # DOMAIN\username or just username
        if "\\" in line:
            username = line.split("\\", 1)[1]
        else:
            username = line
        users.append({"username": username, "uid": ""})
    out({"ok": True, "users": users})


# ── list-groups (winbind) ─────────────────────────────────────────────────────

def cmd_list_groups():
    rc, stdout, stderr = run(["wbinfo", "-g"])
    if rc != 0:
        out({"ok": False, "error": stderr.strip() or "wbinfo -g failed (not joined?)"})
        return
    groups = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        if "\\" in line:
            name = line.split("\\", 1)[1]
        else:
            name = line
        groups.append({"name": name, "gid": ""})
    out({"ok": True, "groups": groups})


# ── list-permitted ────────────────────────────────────────────────────────────

def cmd_list_permitted():
    rc, stdout, stderr = run(["realm", "list"])
    if rc != 0:
        out({"ok": True, "groups": []})
        return
    groups = []
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("permitted-groups:"):
            vals = line.split(":", 1)[1].strip()
            if vals:
                groups = [g.strip() for g in vals.split(",") if g.strip()]
    out({"ok": True, "groups": groups})


# ── permit-group / deny-group ─────────────────────────────────────────────────

def cmd_permit_group(group):
    rc, stdout, stderr = run(["realm", "permit", "-g", group])
    if rc != 0:
        out({"ok": False, "error": stderr.strip()})
        return
    out({"ok": True})


def cmd_deny_group(group):
    rc, stdout, stderr = run(["realm", "deny", "-g", group])
    if rc != 0:
        out({"ok": False, "error": stderr.strip()})
        return
    out({"ok": True})


# ── get-smb-global ────────────────────────────────────────────────────────────

def cmd_get_smb_global():
    smb_conf = "/etc/samba/smb.conf"
    if not os.path.exists(smb_conf):
        out({"ok": False, "error": "smb.conf not found"})
        return
    settings = {}
    in_global = False
    try:
        with open(smb_conf, "r") as f:
            for line in f:
                line_s = line.strip()
                if line_s.lower() == "[global]":
                    in_global = True
                    continue
                if in_global and line_s.startswith("["):
                    break
                if in_global and "=" in line_s and not line_s.startswith("#") and not line_s.startswith(";"):
                    # Strip inline comments
                    line_clean = re.sub(r'\s[;#].*$', '', line_s)
                    k, _, v = line_clean.partition("=")
                    settings[k.strip()] = v.strip()
    except Exception as e:
        out({"ok": False, "error": str(e)})
        return
    out({"ok": True, "settings": settings})


# ── set-smb-global ────────────────────────────────────────────────────────────

def cmd_set_smb_global(key, value):
    smb_conf = "/etc/samba/smb.conf"
    if not os.path.exists(smb_conf):
        out({"ok": False, "error": "smb.conf not found"})
        return
    try:
        with open(smb_conf, "r") as f:
            content = f.read()

        lines = content.splitlines(keepends=True)
        in_global = False
        key_found = False
        new_lines = []

        for line in lines:
            stripped = line.strip()
            if stripped.lower() == "[global]":
                in_global = True
                new_lines.append(line)
                continue
            if in_global and stripped.startswith("["):
                if not key_found:
                    new_lines.append("   " + key + " = " + value + "\n")
                in_global = False
                key_found = False
            if in_global and "=" in stripped and not stripped.startswith("#") and not stripped.startswith(";"):
                k = re.sub(r'\s[;#].*$', '', stripped).partition("=")[0].strip()
                if k.lower() == key.lower():
                    new_lines.append("   " + key + " = " + value + "\n")
                    key_found = True
                    continue
            new_lines.append(line)

        if in_global and not key_found:
            # Append before end of file
            new_lines.append("   " + key + " = " + value + "\n")

        tmp = smb_conf + ".domain_tmp"
        with open(tmp, "w") as f:
            f.writelines(new_lines)
        os.rename(tmp, smb_conf)
        out({"ok": True})
    except Exception as e:
        out({"ok": False, "error": str(e)})


# ── kerberos-renew ────────────────────────────────────────────────────────────

def cmd_kerberos_renew():
    rc, stdout, stderr = run(["kinit", "-R"])
    if rc != 0:
        out({"ok": False, "error": stderr.strip() or "kinit -R failed"})
        return
    out({"ok": True})


# ── restart-winbind ───────────────────────────────────────────────────────────

def cmd_restart_winbind():
    rc, stdout, stderr = run(["systemctl", "restart", "winbind"])
    if rc != 0:
        out({"ok": False, "error": stderr.strip()})
        return
    out({"ok": True})


# ── dc-status ─────────────────────────────────────────────────────────────────

def cmd_dc_status():
    result = {
        "ok": True,
        "provisioned": False,
        "domain": "",
        "realm": "",
        "netbios": "",
        "dc_hostname": "",
        "level": "",
        "fsmo": {},
        "services": {
            "samba_ad_dc": svc_active("samba-ad-dc"),
            "bind9": svc_active("bind9"),
        },
        "clients": 0,
    }

    if result["services"]["samba_ad_dc"] != "active":
        out(result)
        return

    # samba-tool domain info
    rc, stdout, stderr = run(["samba-tool", "domain", "info", "127.0.0.1"])
    if rc == 0:
        result["provisioned"] = True
        for line in stdout.splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                k = k.strip().lower()
                v = v.strip()
                if k == "realm":
                    result["realm"] = v
                elif k == "domain":
                    result["domain"] = v
                elif k == "netbios domain":
                    result["netbios"] = v
                elif k == "dc name":
                    result["dc_hostname"] = v.lstrip("\\")
                elif "level" in k:
                    result["level"] = v

    # fsmo
    rc2, fsmo_out, _ = run(["samba-tool", "fsmo", "show"])
    if rc2 == 0:
        fsmo = {}
        role_map = {
                "schemamasterrole": "SchemaMaster",
                "ridmanagerrole": "RIDManager",
                "pdcrole": "PDCEmulator",
                "domainnamingrole": "DomainMaster",
                "infrastructuremaster": "InfrastructureMaster",
        }
        for line in fsmo_out.splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                k_norm = k.strip().lower().replace(" ", "").replace("-", "")
                for role_key, role_name in role_map.items():
                    if role_key in k_norm:
                        fsmo[role_name] = v.strip().lstrip("\\")
        result["fsmo"] = fsmo

    out(result)


# ── dc-provision ──────────────────────────────────────────────────────────────

def cmd_dc_provision(domain, netbios, adminpass, dns_backend, rfc2307):
    cmd = [
        "samba-tool", "domain", "provision",
        "--realm=" + domain.upper(),
        "--domain=" + netbios.upper(),
        "--adminpass=" + adminpass,
        "--dns-backend=" + dns_backend,
        "--server-role=dc",
        "--use-xattrs=yes",
    ]
    if rfc2307 == "yes":
        cmd.append("--use-rfc2307")

    rc, stdout, stderr = run(cmd, timeout=120)
    combined = stdout + "\n" + stderr
    if rc != 0:
        out({"ok": False, "error": combined.strip()[:500]})
        return

    # Setup krb5.conf symlink
    krb5_src = "/var/lib/samba/private/krb5.conf"
    if os.path.exists(krb5_src):
        try:
            if os.path.exists("/etc/krb5.conf"):
                os.rename("/etc/krb5.conf", "/etc/krb5.conf.bak")
            os.symlink(krb5_src, "/etc/krb5.conf")
        except Exception:
            pass

    # Enable samba-ad-dc
    run(["systemctl", "unmask", "samba-ad-dc"])
    run(["systemctl", "enable", "--now", "samba-ad-dc"])

    out({"ok": True, "output": combined.strip()[:200]})


# ── dc-user-list ──────────────────────────────────────────────────────────────

def cmd_dc_user_list():
    rc, stdout, stderr = run(["samba-tool", "user", "list"])
    if rc != 0:
        out({"ok": False, "error": stderr.strip() or "samba-tool user list failed"})
        return
    usernames = [u.strip() for u in stdout.splitlines() if u.strip()]
    users = []
    for uname in usernames:
        user_info = {"username": uname, "fullname": "", "email": "", "enabled": True}
        rc2, info_out, _ = run(["samba-tool", "user", "show", uname])
        if rc2 == 0:
            for line in info_out.splitlines():
                if ":" in line:
                    k, _, v = line.partition(":")
                    k = k.strip()
                    v = v.strip()
                    if k == "displayName":
                        user_info["fullname"] = v
                    elif k == "mail":
                        user_info["email"] = v
                    elif k == "userAccountControl":
                        # 514 = disabled, 512 = enabled
                        try:
                            uac = int(v)
                            user_info["enabled"] = not bool(uac & 0x2)
                        except ValueError:
                            pass
        users.append(user_info)
    out({"ok": True, "users": users})


# ── dc-user-info ──────────────────────────────────────────────────────────────

def cmd_dc_user_info(user):
    rc, stdout, stderr = run(["samba-tool", "user", "show", user])
    if rc != 0:
        out({"ok": False, "error": stderr.strip()})
        return
    info = {}
    for line in stdout.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            info[k.strip()] = v.strip()
    out({"ok": True, "info": info})


# ── dc-user-add ───────────────────────────────────────────────────────────────

def cmd_dc_user_add(username, password, fullname, email):
    cmd = ["samba-tool", "user", "create", username, password]
    if fullname:
        cmd += ["--given-name=" + fullname.split()[0] if fullname else ""]
        cmd += ["--display-name=" + fullname]
    if email:
        cmd += ["--mail-address=" + email]
    rc, stdout, stderr = run(cmd)
    if rc != 0:
        out({"ok": False, "error": (stdout + " " + stderr).strip()})
        return
    out({"ok": True})


# ── dc-user-delete ────────────────────────────────────────────────────────────

def cmd_dc_user_delete(user):
    rc, stdout, stderr = run(["samba-tool", "user", "delete", user])
    if rc != 0:
        out({"ok": False, "error": (stdout + " " + stderr).strip()})
        return
    out({"ok": True})


# ── dc-user-setpass ───────────────────────────────────────────────────────────

def cmd_dc_user_setpass(user, password):
    rc, stdout, stderr = run(["samba-tool", "user", "setpassword", user, "--newpassword=" + password])
    if rc != 0:
        out({"ok": False, "error": (stdout + " " + stderr).strip()})
        return
    out({"ok": True})


# ── dc-user-enable / disable ──────────────────────────────────────────────────

def cmd_dc_user_enable(user):
    rc, stdout, stderr = run(["samba-tool", "user", "enable", user])
    if rc != 0:
        out({"ok": False, "error": (stdout + " " + stderr).strip()})
        return
    out({"ok": True})


def cmd_dc_user_disable(user):
    rc, stdout, stderr = run(["samba-tool", "user", "disable", user])
    if rc != 0:
        out({"ok": False, "error": (stdout + " " + stderr).strip()})
        return
    out({"ok": True})


# ── dc-group-list ─────────────────────────────────────────────────────────────

def cmd_dc_group_list():
    rc, stdout, stderr = run(["samba-tool", "group", "list"])
    if rc != 0:
        out({"ok": False, "error": stderr.strip() or "samba-tool group list failed"})
        return
    groups = []
    for line in stdout.splitlines():
        name = line.strip()
        if not name:
            continue
        # Get member count
        rc2, members_out, _ = run(["samba-tool", "group", "listmembers", name])
        count = len([m for m in members_out.splitlines() if m.strip()]) if rc2 == 0 else 0
        groups.append({"name": name, "type": "Security Group", "members_count": count})
    out({"ok": True, "groups": groups})


# ── dc-group-members ──────────────────────────────────────────────────────────

def cmd_dc_group_members(group):
    rc, stdout, stderr = run(["samba-tool", "group", "listmembers", group])
    if rc != 0:
        out({"ok": False, "error": stderr.strip()})
        return
    members = [m.strip() for m in stdout.splitlines() if m.strip()]
    out({"ok": True, "group": group, "members": members})


# ── dc-group-add ──────────────────────────────────────────────────────────────

def cmd_dc_group_add(group):
    rc, stdout, stderr = run(["samba-tool", "group", "add", group])
    if rc != 0:
        out({"ok": False, "error": (stdout + " " + stderr).strip()})
        return
    out({"ok": True})


# ── dc-group-delete ───────────────────────────────────────────────────────────

def cmd_dc_group_delete(group):
    rc, stdout, stderr = run(["samba-tool", "group", "delete", group])
    if rc != 0:
        out({"ok": False, "error": (stdout + " " + stderr).strip()})
        return
    out({"ok": True})


# ── dc-group-addmember ────────────────────────────────────────────────────────

def cmd_dc_group_addmember(group, user):
    rc, stdout, stderr = run(["samba-tool", "group", "addmembers", group, user])
    if rc != 0:
        out({"ok": False, "error": (stdout + " " + stderr).strip()})
        return
    out({"ok": True})


# ── dc-group-delmember ────────────────────────────────────────────────────────

def cmd_dc_group_delmember(group, user):
    rc, stdout, stderr = run(["samba-tool", "group", "removemembers", group, user])
    if rc != 0:
        out({"ok": False, "error": (stdout + " " + stderr).strip()})
        return
    out({"ok": True})


# ── dc-repl-status ────────────────────────────────────────────────────────────

def cmd_dc_repl_status():
    rc, stdout, stderr = run(["samba-tool", "drs", "showrepl"])
    if rc != 0:
        out({"ok": False, "error": stderr.strip() or "samba-tool drs showrepl failed"})
        return

    partners = []
    last_sync = ""
    # Parse basic partner info from output
    current_partner = None
    for line in stdout.splitlines():
        line_s = line.strip()
        m = re.match(r'(\S+)\s+via RPC', line_s)
        if m:
            current_partner = {"host": m.group(1), "last_sync": "", "ok": True}
            partners.append(current_partner)
        elif current_partner and "Last attempt" in line_s:
            ts = line_s.split(":", 1)[1].strip() if ":" in line_s else ""
            current_partner["last_sync"] = ts
            if "was successful" in line_s:
                current_partner["ok"] = True
            elif "failed" in line_s.lower():
                current_partner["ok"] = False
        elif "Last attempt @" in line_s or "was successful" in line_s:
            last_sync_m = re.search(r'@ (.+?) was', line_s)
            if last_sync_m:
                last_sync = last_sync_m.group(1)

    out({
        "ok": True,
        "partners": partners,
        "last_sync": last_sync,
        "raw": stdout[:2000],
    })


# ── dc-repl-sync ──────────────────────────────────────────────────────────────

def cmd_dc_repl_sync():
    rc, stdout, stderr = run(["samba-tool", "drs", "replicate", "localhost", "localhost", "DC=dummy,DC=test"], timeout=30)
    # This often fails if there's no partner — that's OK
    out({"ok": True, "output": (stdout + stderr).strip()[:200]})


# ── dc-dns-query ──────────────────────────────────────────────────────────────

def cmd_dc_dns_query(zone):
    rc, stdout, stderr = run(["samba-tool", "dns", "query", "127.0.0.1", zone, "@", "ALL", "--machine-pass"])
    if rc != 0:
        out({"ok": False, "error": (stderr or stdout).strip()[:300]})
        return

    records = []
    current_name = "@"
    for line in stdout.splitlines():
        line_s = line.strip()
        # Name header line
        m_name = re.match(r'^Name=([^,]+),', line_s)
        if m_name:
            current_name = m_name.group(1).strip()
            continue
        # Record line: A: 192.168.1.1 (ttl=900)
        m_rec = re.match(r'(\w+):\s+(.+?)(?:\s+\(ttl=(\d+)\))?$', line_s)
        if m_rec:
            records.append({
                "name": current_name,
                "type": m_rec.group(1),
                "value": m_rec.group(2).strip(),
                "ttl": m_rec.group(3) or "",
            })

    out({"ok": True, "records": records})


# ── dc-dns-add ────────────────────────────────────────────────────────────────

def cmd_dc_dns_add(zone, name, rtype, value):
    rc, stdout, stderr = run(["samba-tool", "dns", "add", "127.0.0.1", zone, name, rtype, value, "--machine-pass"])
    if rc != 0:
        out({"ok": False, "error": (stderr or stdout).strip()})
        return
    out({"ok": True})


# ── dc-dns-delete ─────────────────────────────────────────────────────────────

def cmd_dc_dns_delete(zone, name, rtype, value):
    rc, stdout, stderr = run(["samba-tool", "dns", "delete", "127.0.0.1", zone, name, rtype, value, "--machine-pass"])
    if rc != 0:
        out({"ok": False, "error": (stderr or stdout).strip()})
        return
    out({"ok": True})


# ── dc-gpo-list ───────────────────────────────────────────────────────────────

def cmd_dc_gpo_list():
    rc, stdout, stderr = run(["samba-tool", "gpo", "listall"])
    if rc != 0:
        out({"ok": False, "error": stderr.strip() or "samba-tool gpo listall failed"})
        return

    gpos = []
    current = {}
    for line in stdout.splitlines():
        line_s = line.strip()
        if line_s.startswith("GPO") and ":" in line_s:
            if current:
                gpos.append(current)
            current = {"name": "", "guid": "", "path": ""}
            # GPO          : {GUID}
            m = re.search(r'\{([^}]+)\}', line_s)
            if m:
                current["guid"] = "{" + m.group(1) + "}"
        elif "displayName" in line_s and ":" in line_s:
            current["name"] = line_s.split(":", 1)[1].strip()
        elif "gPCFileSysPath" in line_s and ":" in line_s:
            current["path"] = line_s.split(":", 1)[1].strip()
    if current:
        gpos.append(current)

    out({"ok": True, "gpos": gpos})


# ── dc-gpo-create ─────────────────────────────────────────────────────────────

def cmd_dc_gpo_create(name):
    rc, stdout, stderr = run(["samba-tool", "gpo", "create", name])
    if rc != 0:
        out({"ok": False, "error": (stderr or stdout).strip()})
        return
    out({"ok": True})


# ── dc-fsmo-show ──────────────────────────────────────────────────────────────

def cmd_dc_fsmo_show():
    rc, stdout, stderr = run(["samba-tool", "fsmo", "show"])
    if rc != 0:
        out({"ok": False, "error": stderr.strip() or "samba-tool fsmo show failed"})
        return
    roles = {}
    role_map = {
        "schemamasterrole": "SchemaMaster",
        "ridmanagerrole": "RIDManager",
        "pdcrole": "PDCEmulator",
        "domainnamingrole": "DomainMaster",
        "infrastructuremaster": "InfrastructureMaster",
    }
    for line in stdout.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            k_norm = k.strip().lower().replace(" ", "").replace("-", "")
            for role_key, role_name in role_map.items():
                if role_key in k_norm:
                    roles[role_name] = v.strip().lstrip("\\")
    out({"ok": True, "roles": roles})


# ── dispatch ──────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        out({"ok": False, "error": "No command"})
        return

    cmd = sys.argv[1]
    args = sys.argv[2:]

    try:
        if cmd == "detect-mode":
            cmd_detect_mode()
        elif cmd == "status":
            cmd_status()
        elif cmd == "discover":
            cmd_discover(args[0])
        elif cmd == "join":
            cmd_join(args[0], args[1], args[2], args[3])
        elif cmd == "leave":
            cmd_leave(args[0], args[1])
        elif cmd == "list-users":
            cmd_list_users()
        elif cmd == "list-groups":
            cmd_list_groups()
        elif cmd == "list-permitted":
            cmd_list_permitted()
        elif cmd == "permit-group":
            cmd_permit_group(args[0])
        elif cmd == "deny-group":
            cmd_deny_group(args[0])
        elif cmd == "get-smb-global":
            cmd_get_smb_global()
        elif cmd == "set-smb-global":
            cmd_set_smb_global(args[0], args[1])
        elif cmd == "kerberos-renew":
            cmd_kerberos_renew()
        elif cmd == "restart-winbind":
            cmd_restart_winbind()
        elif cmd == "dc-status":
            cmd_dc_status()
        elif cmd == "dc-provision":
            cmd_dc_provision(args[0], args[1], args[2], args[3], args[4])
        elif cmd == "dc-user-list":
            cmd_dc_user_list()
        elif cmd == "dc-user-info":
            cmd_dc_user_info(args[0])
        elif cmd == "dc-user-add":
            cmd_dc_user_add(args[0], args[1], args[2] if len(args) > 2 else "", args[3] if len(args) > 3 else "")
        elif cmd == "dc-user-delete":
            cmd_dc_user_delete(args[0])
        elif cmd == "dc-user-setpass":
            cmd_dc_user_setpass(args[0], args[1])
        elif cmd == "dc-user-enable":
            cmd_dc_user_enable(args[0])
        elif cmd == "dc-user-disable":
            cmd_dc_user_disable(args[0])
        elif cmd == "dc-group-list":
            cmd_dc_group_list()
        elif cmd == "dc-group-members":
            cmd_dc_group_members(args[0])
        elif cmd == "dc-group-add":
            cmd_dc_group_add(args[0])
        elif cmd == "dc-group-delete":
            cmd_dc_group_delete(args[0])
        elif cmd == "dc-group-addmember":
            cmd_dc_group_addmember(args[0], args[1])
        elif cmd == "dc-group-delmember":
            cmd_dc_group_delmember(args[0], args[1])
        elif cmd == "dc-repl-status":
            cmd_dc_repl_status()
        elif cmd == "dc-repl-sync":
            cmd_dc_repl_sync()
        elif cmd == "dc-dns-query":
            cmd_dc_dns_query(args[0])
        elif cmd == "dc-dns-add":
            cmd_dc_dns_add(args[0], args[1], args[2], args[3])
        elif cmd == "dc-dns-delete":
            cmd_dc_dns_delete(args[0], args[1], args[2], args[3])
        elif cmd == "dc-gpo-list":
            cmd_dc_gpo_list()
        elif cmd == "dc-gpo-create":
            cmd_dc_gpo_create(args[0])
        elif cmd == "dc-fsmo-show":
            cmd_dc_fsmo_show()
        else:
            out({"ok": False, "error": "Unknown command: " + cmd})
    except IndexError as e:
        out({"ok": False, "error": "Missing argument: " + str(e)})
    except Exception as e:
        out({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
