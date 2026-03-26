import pytest
from crypto import (
    generate_keypair, load_private_key_pem, load_public_key_pem,
    sign_payload, verify_and_decode,
    base62_encode, base62_decode,
    format_activation_code, normalize_activation_code,
)
from cryptography.exceptions import InvalidSignature

def test_keypair_generation():
    priv, pub = generate_keypair()
    assert priv.startswith(b"-----BEGIN PRIVATE KEY-----")
    assert pub.startswith(b"-----BEGIN PUBLIC KEY-----")

def test_sign_and_verify_roundtrip(keypair):
    priv, pub = keypair
    payload = {"ver": 1, "serial": "RUSNAS-TEST-0000-0000-0001", "license_type": "standard"}
    code = sign_payload(priv, payload)
    result = verify_and_decode(pub, code)
    assert result["serial"] == "RUSNAS-TEST-0000-0000-0001"
    assert result["license_type"] == "standard"

def test_tampered_code_rejected(keypair):
    priv, pub = keypair
    code = sign_payload(priv, {"ver": 1, "serial": "X"})
    tampered = code[:-4] + "ZZZZ"
    with pytest.raises((InvalidSignature, ValueError)):
        verify_and_decode(pub, tampered)

def test_base62_roundtrip():
    data = b"\x00\x01\x02\xff\xfe" * 20
    assert base62_decode(base62_encode(data)) == data

def test_base62_leading_zeros():
    data = b"\x00\x00\x00abc"
    assert base62_decode(base62_encode(data)) == data

def test_format_normalize_roundtrip(keypair):
    priv, pub = keypair
    raw = sign_payload(priv, {"ver": 1, "x": "y"})
    formatted = format_activation_code(raw)
    assert formatted.startswith("RNAC-")
    assert normalize_activation_code(formatted) == raw
