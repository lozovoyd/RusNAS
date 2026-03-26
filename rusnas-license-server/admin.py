#!/usr/bin/env python3
import argparse, asyncio, time, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import db, crypto
from datetime import datetime

def ts(dt_str):
    return int(datetime.strptime(dt_str, "%Y-%m-%d").timestamp())

def fmt_ts(t):
    if t is None: return "бессрочно"
    return datetime.fromtimestamp(t).strftime("%d.%m.%Y")

async def cmd_serial_add(args):
    ok = await db.issue_serial(args.serial, batch=args.batch, note=args.note)
    print("Added" if ok else "Already exists")

async def cmd_serial_import(args):
    serials = [l.strip() for l in open(args.file) if l.strip()]
    for s in serials:
        ok = await db.issue_serial(s, batch=args.batch)
        print(f"{'OK' if ok else 'DUP'} {s}")

async def cmd_serial_list(args):
    rows = await db.get_all_serials()
    for r in rows:
        print(f"{r['serial']}  batch={r['batch']}  install={fmt_ts(r['first_install_at'])}")

async def cmd_license_create(args):
    from models import ALL_FEATURES
    features = {}
    feat_list = args.features.split(",") if args.features != "all" else list(ALL_FEATURES.keys())
    for f in feat_list:
        f = f.strip()
        features[f] = {"type": "addon_perpetual"}
    expires = None if args.no_expiry or not args.expires else ts(args.expires)
    lid = await db.create_license(args.serial, args.type, expires,
        features, args.customer, args.max_volumes, args.operator or "admin")
    print(f"License #{lid} created for {args.serial}")

async def cmd_license_show(args):
    lic = await db.get_active_license(args.serial)
    if not lic:
        print("No active license")
        return
    print(f"Serial:      {args.serial}")
    print(f"Customer:    {lic['customer']}")
    print(f"Type:        {lic['license_type']}")
    print(f"Expires:     {fmt_ts(lic['expires_at'])}")
    print(f"Max volumes: {lic['max_volumes']}")
    print(f"Status:      {'REVOKED' if lic.get('revoked') else 'ACTIVE'}")
    count = await db.get_activation_count(args.serial)
    print(f"Activations: {count}")

async def cmd_license_revoke(args):
    lic = await db.get_active_license(args.serial)
    if not lic:
        print("No active license")
        return
    await db.revoke_license(lic["id"], args.reason)
    print(f"License #{lic['id']} revoked")

async def cmd_gen_code(args):
    priv = crypto.load_private_key(os.getenv("PRIVATE_KEY_PATH", "./operator_private.pem"))
    lic = await db.get_active_license(args.serial)
    if not lic:
        print("No active license"); return
    features = {"core": {"type": "base"}, "updates_security": {"type": "base"}}
    features.update(lic["features"])
    payload = {"ver": 1, "type": "activation", "serial": args.serial,
               "issued_at": int(time.time()), "license_type": lic["license_type"],
               "expires_at": lic["expires_at"], "customer": lic["customer"] or "",
               "max_volumes": lic["max_volumes"], "features": features}
    raw = crypto.sign_payload(priv, payload)
    print(crypto.format_activation_code(raw))

async def cmd_report(args):
    serials = await db.get_all_serials()
    active  = await db.list_licenses(active_only=True)
    expired = await db.list_licenses(expired=True)
    revoked = await db.list_licenses(revoked=True)
    print(f"Serials: {len(serials)} total")
    print(f"Licenses: {len(active)} active, {len(expired)} expired, {len(revoked)} revoked")

def main():
    p = argparse.ArgumentParser(description="rusNAS License Server admin CLI")
    sub = p.add_subparsers(dest="cmd")

    # serial subcommands
    ps = sub.add_parser("serial", help="Manage serials")
    ss = ps.add_subparsers(dest="sub")
    a = ss.add_parser("add"); a.add_argument("serial"); a.add_argument("--batch"); a.add_argument("--note")
    a = ss.add_parser("import"); a.add_argument("file"); a.add_argument("--batch")
    ss.add_parser("list")

    # license subcommands
    pl = sub.add_parser("license", help="Manage licenses")
    ls = pl.add_subparsers(dest="sub")
    a = ls.add_parser("create")
    a.add_argument("--serial", required=True)
    a.add_argument("--type", default="standard")
    a.add_argument("--expires", default=None)
    a.add_argument("--no-expiry", action="store_true")
    a.add_argument("--customer", default="")
    a.add_argument("--features", default="core")
    a.add_argument("--max-volumes", type=int, default=4)
    a.add_argument("--operator", default=None)
    a = ls.add_parser("show"); a.add_argument("serial")
    a = ls.add_parser("revoke"); a.add_argument("serial"); a.add_argument("--reason", default="")

    # top-level commands
    a = sub.add_parser("gen-code", help="Generate activation code for serial")
    a.add_argument("serial")
    sub.add_parser("report", help="Summary report")
    sub.add_parser("keygen", help="Run keygen.py to generate operator keypair")

    args = p.parse_args()
    asyncio.run(db.init_db())

    dispatch = {
        ("serial", "add"):      cmd_serial_add,
        ("serial", "import"):   cmd_serial_import,
        ("serial", "list"):     cmd_serial_list,
        ("license", "create"):  cmd_license_create,
        ("license", "show"):    cmd_license_show,
        ("license", "revoke"):  cmd_license_revoke,
        "gen-code":             cmd_gen_code,
        "report":               cmd_report,
    }
    key = (args.cmd, getattr(args, "sub", None)) if args.cmd in ("serial", "license") else args.cmd
    fn = dispatch.get(key)
    if fn:
        asyncio.run(fn(args))
    elif args.cmd == "keygen":
        import keygen; keygen.main()
    else:
        p.print_help()

if __name__ == "__main__":
    main()
