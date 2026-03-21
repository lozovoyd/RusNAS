#!/usr/bin/env python3
# rusNAS Certs API
# /usr/share/cockpit/rusnas/scripts/certs-api.py
# Called via: cockpit.spawn(['sudo', '-n', 'python3', SCRIPT, mode, ...args])

import os, sys, json, subprocess, re, base64, datetime, ssl, socket
import tempfile, shutil, glob

CERTS_DIR   = "/etc/rusnas/certs"
LE_DIR      = "/etc/letsencrypt/live"
CERT_LOG    = "/var/log/rusnas/certcheck.log"
DAEMON_TIMER = "rusnas-certcheck.timer"
WEBROOT_DEFAULT = "/var/www/rusnas-landing"

# Days threshold for "expiring soon" warning
WARN_DAYS = 30
RENEW_DAYS = 30


def ok(data):
    print(json.dumps(data))

def err(msg):
    print(json.dumps({"ok": False, "error": msg}))

def run(cmd, timeout=120, input_data=None):
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout, input=input_data
        )
        return r.stdout.strip(), r.stderr.strip(), r.returncode
    except subprocess.TimeoutExpired:
        return "", "timeout", -1
    except Exception as e:
        return "", str(e), -1


def run_stream(cmd, timeout=120):
    """Run command and yield output lines in real-time (used in scan-now)."""
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1
        )
        lines = []
        for line in proc.stdout:
            lines.append(line.rstrip())
        proc.wait(timeout=timeout)
        return "\n".join(lines), proc.returncode
    except Exception as e:
        return str(e), -1


def ensure_dirs():
    os.makedirs(CERTS_DIR, mode=0o755, exist_ok=True)
    os.makedirs(os.path.dirname(CERT_LOG), exist_ok=True)


def parse_cert_info(cert_path):
    """Parse a PEM cert file using openssl x509."""
    out, _, rc = run(["openssl", "x509", "-noout",
                      "-subject", "-issuer",
                      "-startdate", "-enddate",
                      "-in", cert_path])
    if rc != 0:
        return None

    info = {}
    for line in out.splitlines():
        if line.startswith("subject="):
            # Extract CN
            m = re.search(r"CN\s*=\s*([^,/\n]+)", line)
            if m:
                info["cn"] = m.group(1).strip()
            info["subject"] = line.split("=", 1)[1].strip()
        elif line.startswith("issuer="):
            issuer_str = line.split("=", 1)[1].strip()
            info["issuer_raw"] = issuer_str
            if "Let's Encrypt" in issuer_str or "letsencrypt" in issuer_str.lower():
                info["issuer"] = "Let's Encrypt"
                info["type"]   = "letsencrypt"
            elif info.get("subject") == issuer_str or "CN" not in issuer_str.replace("subject=",""):
                info["issuer"] = "Самоподписанный"
                info["type"]   = "selfsigned"
            else:
                info["issuer"] = issuer_str
                info["type"]   = "custom"
        elif line.startswith("notBefore="):
            info["not_before"] = line.split("=", 1)[1].strip()
        elif line.startswith("notAfter="):
            info["not_after"] = line.split("=", 1)[1].strip()

    # Parse expiry date
    if "not_after" in info:
        try:
            exp = datetime.datetime.strptime(
                info["not_after"], "%b %d %H:%M:%S %Y %Z"
            ).replace(tzinfo=datetime.timezone.utc)
            now = datetime.datetime.now(datetime.timezone.utc)
            delta = exp - now
            info["days_left"] = delta.days
            info["not_after_iso"] = exp.strftime("%Y-%m-%d")
            if delta.days < 0:
                info["status"] = "expired"
            elif delta.days < WARN_DAYS:
                info["status"] = "expiring"
            else:
                info["status"] = "valid"
        except Exception:
            info["days_left"] = None
            info["status"] = "unknown"

    # Get SANs
    san_out, _, _ = run(["openssl", "x509", "-noout", "-ext", "subjectAltName", "-in", cert_path])
    sans = re.findall(r"(?:DNS|IP Address):([^\s,]+)", san_out)
    info["sans"] = sans

    return info


def cmd_list_certs():
    """Scan all cert locations and return structured list."""
    ensure_dirs()
    certs = []

    # 1. Let's Encrypt certs
    if os.path.isdir(LE_DIR):
        for domain in os.listdir(LE_DIR):
            cert_path = os.path.join(LE_DIR, domain, "cert.pem")
            if not os.path.exists(cert_path):
                # Try fullchain
                cert_path = os.path.join(LE_DIR, domain, "fullchain.pem")
            if os.path.exists(cert_path):
                info = parse_cert_info(cert_path)
                if info:
                    info.update({
                        "name":      domain,
                        "cert_path": cert_path,
                        "key_path":  os.path.join(LE_DIR, domain, "privkey.pem"),
                        "chain_path":os.path.join(LE_DIR, domain, "chain.pem"),
                        "source":    "letsencrypt",
                        "type":      "letsencrypt",
                        "renewable": True,
                    })
                    certs.append(info)

    # 2. Custom certs in /etc/rusnas/certs/
    for name in os.listdir(CERTS_DIR):
        cert_dir = os.path.join(CERTS_DIR, name)
        if not os.path.isdir(cert_dir):
            continue
        cert_path = os.path.join(cert_dir, "cert.pem")
        if not os.path.exists(cert_path):
            cert_path = os.path.join(cert_dir, "fullchain.pem")
        if not os.path.exists(cert_path):
            continue
        info = parse_cert_info(cert_path)
        if info:
            meta_path = os.path.join(cert_dir, "meta.json")
            meta = {}
            if os.path.exists(meta_path):
                try:
                    with open(meta_path) as f:
                        meta = json.load(f)
                except Exception:
                    pass
            info.update({
                "name":      name,
                "cert_path": cert_path,
                "key_path":  os.path.join(cert_dir, "key.pem"),
                "chain_path":os.path.join(cert_dir, "chain.pem") if os.path.exists(os.path.join(cert_dir, "chain.pem")) else "",
                "source":    meta.get("source", "custom"),
                "renewable": meta.get("source") == "letsencrypt",
            })
            if not info.get("type"):
                info["type"] = meta.get("source", "custom")
            certs.append(info)

    # Sort: expiring first, then by days_left
    certs.sort(key=lambda c: (c.get("days_left") or 9999))

    ok({"ok": True, "certs": certs})


def cmd_issue_letsencrypt(domain, email, method, webroot):
    """Issue Let's Encrypt certificate via certbot."""
    if not domain or not email:
        err("domain and email required")
        return

    # Check certbot
    certbot = shutil.which("certbot")
    if not certbot:
        err("certbot not installed. Run: apt install certbot")
        return

    if method == "standalone":
        cmd = [certbot, "certonly", "--standalone",
               "--non-interactive", "--agree-tos",
               "--email", email,
               "-d", domain]
    else:
        # webroot
        wr = webroot or WEBROOT_DEFAULT
        os.makedirs(os.path.join(wr, ".well-known", "acme-challenge"), exist_ok=True)
        cmd = [certbot, "certonly", "--webroot",
               "--webroot-path", wr,
               "--non-interactive", "--agree-tos",
               "--email", email,
               "-d", domain]

    output, rc = run_stream(cmd, timeout=120)

    if rc == 0:
        ok({"ok": True, "output": output, "domain": domain})
    else:
        ok({"ok": False, "error": "certbot вернул ошибку", "output": output, "rc": rc})


def cmd_renew_cert(name):
    """Renew a Let's Encrypt cert by domain name."""
    certbot = shutil.which("certbot")
    if not certbot:
        err("certbot not installed")
        return

    if name == "all":
        cmd = [certbot, "renew", "--non-interactive"]
    else:
        cmd = [certbot, "renew", "--cert-name", name, "--non-interactive"]

    output, rc = run_stream(cmd, timeout=180)
    ok({"ok": rc == 0, "output": output, "rc": rc})


def cmd_create_selfsigned(name, cn, org, san_list, days, keysize):
    """Create a self-signed certificate using openssl."""
    ensure_dirs()

    if not cn:
        err("Common Name (CN) required")
        return

    cert_dir = os.path.join(CERTS_DIR, name)
    os.makedirs(cert_dir, mode=0o755, exist_ok=True)

    key_path  = os.path.join(cert_dir, "key.pem")
    cert_path = os.path.join(cert_dir, "cert.pem")
    conf_path = os.path.join(cert_dir, "openssl.cnf")

    # Build SAN extension config
    sans = [s.strip() for s in san_list.split(",") if s.strip()]
    san_entries = []
    for i, s in enumerate(sans):
        prefix = "IP:" if re.match(r"^\d+\.\d+\.\d+\.\d+$", s) else "DNS:"
        san_entries.append(f"{prefix}{s}")

    # Always include CN as SAN
    cn_prefix = "IP:" if re.match(r"^\d+\.\d+\.\d+\.\d+$", cn) else "DNS:"
    if f"{cn_prefix}{cn}" not in san_entries:
        san_entries.insert(0, f"{cn_prefix}{cn}")

    conf = f"""[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
C  = RU
O  = {org}
CN = {cn}

[v3_req]
subjectAltName = {', '.join(san_entries)}
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
"""
    with open(conf_path, "w") as f:
        f.write(conf)

    # Generate key
    _, stderr, rc = run([
        "openssl", "genrsa", "-out", key_path, str(keysize)
    ])
    if rc != 0:
        err(f"Key generation failed: {stderr}")
        return

    # Generate cert
    _, stderr, rc = run([
        "openssl", "req", "-new", "-x509",
        "-key", key_path,
        "-out", cert_path,
        "-days", str(days),
        "-config", conf_path
    ])
    if rc != 0:
        err(f"Certificate generation failed: {stderr}")
        return

    os.chmod(key_path, 0o600)
    os.chmod(cert_path, 0o644)

    # Write metadata
    meta = {"source": "selfsigned", "cn": cn, "created_at": datetime.datetime.now().isoformat()}
    with open(os.path.join(cert_dir, "meta.json"), "w") as f:
        json.dump(meta, f)

    ok({"ok": True, "name": name, "cert_path": cert_path, "key_path": key_path})


def cmd_import_cert(name, cert_pem_b64, key_pem_b64, chain_pem_b64):
    """Import an externally issued certificate."""
    ensure_dirs()

    if not name or not cert_pem_b64 or not key_pem_b64:
        err("name, cert and key required")
        return

    try:
        cert_pem  = base64.b64decode(cert_pem_b64).decode("utf-8")
        key_pem   = base64.b64decode(key_pem_b64).decode("utf-8")
        chain_pem = base64.b64decode(chain_pem_b64).decode("utf-8") if chain_pem_b64 else ""
    except Exception as e:
        err(f"Base64 decode error: {e}")
        return

    # Validate cert
    tmp_cert = tempfile.NamedTemporaryFile(suffix=".pem", delete=False, mode="w")
    tmp_cert.write(cert_pem)
    tmp_cert.close()
    _, stderr, rc = run(["openssl", "x509", "-noout", "-in", tmp_cert.name])
    os.unlink(tmp_cert.name)
    if rc != 0:
        err(f"Invalid certificate PEM: {stderr}")
        return

    cert_dir = os.path.join(CERTS_DIR, name)
    os.makedirs(cert_dir, mode=0o755, exist_ok=True)

    with open(os.path.join(cert_dir, "cert.pem"), "w") as f:
        f.write(cert_pem)
    with open(os.path.join(cert_dir, "key.pem"), "w") as f:
        f.write(key_pem)
    if chain_pem:
        with open(os.path.join(cert_dir, "chain.pem"), "w") as f:
            f.write(chain_pem)

    os.chmod(os.path.join(cert_dir, "key.pem"), 0o600)
    os.chmod(os.path.join(cert_dir, "cert.pem"), 0o644)

    meta = {"source": "custom", "imported_at": datetime.datetime.now().isoformat()}
    with open(os.path.join(cert_dir, "meta.json"), "w") as f:
        json.dump(meta, f)

    ok({"ok": True, "name": name})


def cmd_delete_cert(name, source):
    """Delete a certificate. For LE: revoke optional, remove from our tracking."""
    if source == "letsencrypt":
        certbot = shutil.which("certbot")
        if certbot:
            run([certbot, "delete", "--cert-name", name, "--non-interactive"])
    else:
        cert_dir = os.path.join(CERTS_DIR, name)
        if os.path.isdir(cert_dir):
            shutil.rmtree(cert_dir)
    ok({"ok": True})


def cmd_check_and_renew():
    """Check all LE certs and renew those expiring within RENEW_DAYS. Called by daemon."""
    ensure_dirs()
    log_entries = []

    def log(msg):
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{ts}] {msg}"
        log_entries.append(line)
        print(line, flush=True)

    log("=== rusNAS certcheck started ===")

    certbot = shutil.which("certbot")
    if not certbot:
        log("certbot not found, skipping LE renewal")
    else:
        # Check which LE certs need renewal
        if os.path.isdir(LE_DIR):
            for domain in os.listdir(LE_DIR):
                cert_path = os.path.join(LE_DIR, domain, "cert.pem")
                if not os.path.exists(cert_path):
                    continue
                info = parse_cert_info(cert_path)
                if not info:
                    continue
                days_left = info.get("days_left", 9999)
                log(f"  {domain}: {days_left} days left")
                if days_left <= RENEW_DAYS:
                    log(f"  Renewing {domain}...")
                    output, rc = run_stream([certbot, "renew", "--cert-name", domain, "--non-interactive"])
                    if rc == 0:
                        log(f"  {domain}: renewed successfully")
                    else:
                        log(f"  {domain}: renewal FAILED (rc={rc})")
                        log(f"  Output: {output[:500]}")

    log("=== certcheck complete ===")

    # Append to log file
    try:
        with open(CERT_LOG, "a") as f:
            for line in log_entries:
                f.write(line + "\n")
    except Exception:
        pass

    ok({"ok": True, "log": log_entries})


def cmd_get_log():
    """Return last 100 lines of cert log."""
    if not os.path.exists(CERT_LOG):
        ok({"ok": True, "log": "Лог пустой — проверка ещё не запускалась"})
        return
    try:
        with open(CERT_LOG) as f:
            lines = f.readlines()
        ok({"ok": True, "log": "".join(lines[-100:])})
    except Exception as e:
        err(str(e))


def cmd_daemon_status():
    """Check if rusnas-certcheck.timer is active."""
    _, _, rc_active = run(["systemctl", "is-active", DAEMON_TIMER])
    _, _, rc_enabled = run(["systemctl", "is-enabled", DAEMON_TIMER])

    # Get last run time
    last_run = ""
    out, _, _ = run(["systemctl", "show", DAEMON_TIMER,
                     "--property=LastTriggerUSec", "--value"])
    if out and out != "0":
        last_run = out

    # Get next run
    next_run = ""
    out2, _, _ = run(["systemctl", "show", DAEMON_TIMER,
                      "--property=NextElapseUSecRealtime", "--value"])
    if out2 and out2 != "0":
        next_run = out2

    ok({
        "ok": True,
        "active":  rc_active == 0,
        "enabled": rc_enabled == 0,
        "last_run": last_run,
        "next_run": next_run,
    })


def cmd_daemon_enable():
    run(["systemctl", "enable", "--now", DAEMON_TIMER])
    ok({"ok": True})


def cmd_daemon_disable():
    run(["systemctl", "disable", "--now", DAEMON_TIMER])
    ok({"ok": True})


def cmd_check_certbot():
    """Check if certbot is installed and return version."""
    path = shutil.which("certbot")
    if not path:
        ok({"ok": True, "installed": False})
        return
    out, _, rc = run([path, "--version"])
    ok({"ok": True, "installed": rc == 0, "version": out})


def cmd_install_certbot():
    """Install certbot via apt."""
    out, err_str, rc = run(["apt-get", "install", "-y", "certbot"], timeout=180)
    ok({"ok": rc == 0, "output": out + err_str})


# ── dispatch ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        err("No command")
        sys.exit(1)

    cmd  = sys.argv[1]
    args = sys.argv[2:]

    dispatch = {
        "list-certs":         lambda: cmd_list_certs(),
        "issue-letsencrypt":  lambda: cmd_issue_letsencrypt(
            args[0] if len(args)>0 else "",
            args[1] if len(args)>1 else "",
            args[2] if len(args)>2 else "webroot",
            args[3] if len(args)>3 else WEBROOT_DEFAULT,
        ),
        "renew-cert":         lambda: cmd_renew_cert(args[0] if args else "all"),
        "create-selfsigned":  lambda: cmd_create_selfsigned(
            args[0] if len(args)>0 else "",   # name
            args[1] if len(args)>1 else "",   # cn
            args[2] if len(args)>2 else "rusNAS",  # org
            args[3] if len(args)>3 else "",   # san_list
            args[4] if len(args)>4 else "730",# days
            args[5] if len(args)>5 else "4096",# keysize
        ),
        "import-cert":        lambda: cmd_import_cert(
            args[0] if len(args)>0 else "",
            args[1] if len(args)>1 else "",
            args[2] if len(args)>2 else "",
            args[3] if len(args)>3 else "",
        ),
        "delete-cert":        lambda: cmd_delete_cert(
            args[0] if len(args)>0 else "",
            args[1] if len(args)>1 else "custom",
        ),
        "check-and-renew":    lambda: cmd_check_and_renew(),
        "get-log":            lambda: cmd_get_log(),
        "daemon-status":      lambda: cmd_daemon_status(),
        "daemon-enable":      lambda: cmd_daemon_enable(),
        "daemon-disable":     lambda: cmd_daemon_disable(),
        "check-certbot":      lambda: cmd_check_certbot(),
        "install-certbot":    lambda: cmd_install_certbot(),
    }

    if cmd in dispatch:
        dispatch[cmd]()
    else:
        err(f"Unknown command: {cmd}")
