#!/usr/bin/env python3
"""Generate operator Ed25519 keypair. Run once at VPS setup."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from crypto import generate_keypair

def main():
    priv, pub = generate_keypair()
    priv_path, pub_path = "operator_private.pem", "operator_public.pem"
    with open(priv_path, "wb") as f: f.write(priv)
    with open(pub_path,  "wb") as f: f.write(pub)
    os.chmod(priv_path, 0o600)
    print(f"Generated {priv_path} (600) and {pub_path}")
    print("\n  ВАЖНО: operator_private.pem — храните в тайне, делайте резервные копии!")
    print("\nPublic key (вшейте в образ rusNAS):")
    print(pub.decode())

if __name__ == "__main__":
    main()
