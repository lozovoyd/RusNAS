import json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import (
    Encoding, PrivateFormat, PublicFormat, NoEncryption,
    load_pem_private_key, load_pem_public_key,
)
from cryptography.exceptions import InvalidSignature

BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

def generate_keypair() -> tuple[bytes, bytes]:
    key = Ed25519PrivateKey.generate()
    priv = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    pub  = key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    return priv, pub

def load_private_key_pem(pem: bytes) -> Ed25519PrivateKey:
    return load_pem_private_key(pem, password=None)

def load_public_key_pem(pem: bytes) -> Ed25519PublicKey:
    return load_pem_public_key(pem)

def load_private_key(path: str) -> Ed25519PrivateKey:
    return load_private_key_pem(open(path, "rb").read())

def load_public_key(path: str) -> Ed25519PublicKey:
    return load_public_key_pem(open(path, "rb").read())

def base62_encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    if n == 0:
        return BASE62_ALPHABET[0] * len(data)
    leading = len(data) - len(data.lstrip(b"\x00"))
    result = []
    while n:
        n, r = divmod(n, 62)
        result.append(BASE62_ALPHABET[r])
    return BASE62_ALPHABET[0] * leading + "".join(reversed(result))

def base62_decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 62 + BASE62_ALPHABET.index(c)
    leading = len(s) - len(s.lstrip(BASE62_ALPHABET[0]))
    if n == 0:
        return b"\x00" * len(s)
    result = []
    while n:
        n, r = divmod(n, 256)
        result.append(r)
    return b"\x00" * leading + bytes(reversed(result))

def sign_payload(private_key: Ed25519PrivateKey, payload: dict) -> str:
    payload_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    signature = private_key.sign(payload_bytes)
    blob = signature + payload_bytes
    return base62_encode(blob)

def verify_and_decode(public_key: Ed25519PublicKey, activation_code: str) -> dict:
    try:
        blob = base62_decode(activation_code)
    except (ValueError, IndexError) as e:
        raise ValueError(f"Cannot decode activation code: {e}")
    if len(blob) < 64:
        raise ValueError("Activation code too short")
    signature     = blob[:64]
    payload_bytes = blob[64:]
    public_key.verify(signature, payload_bytes)   # raises InvalidSignature if wrong
    return json.loads(payload_bytes)

def format_activation_code(raw_base62: str) -> str:
    blocks = [raw_base62[i:i+5] for i in range(0, len(raw_base62), 5)]
    lines  = [" ".join(blocks[i:i+8]) for i in range(0, len(blocks), 8)]
    return "RNAC-\n" + "\n".join(lines)

def normalize_activation_code(formatted: str) -> str:
    s = formatted.strip()
    if s.upper().startswith("RNAC-"):
        s = s[5:]
    return s.replace(" ", "").replace("\n", "").replace("\r", "").replace("-", "")
