import pytest
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from crypto import generate_keypair, load_private_key_pem, load_public_key_pem

@pytest.fixture(scope="session")
def keypair(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("keys")
    priv_pem, pub_pem = generate_keypair()
    priv_path = tmp / "private.pem"
    pub_path  = tmp / "public.pem"
    priv_path.write_bytes(priv_pem)
    pub_path.write_bytes(pub_pem)
    return (
        load_private_key_pem(priv_pem),
        load_public_key_pem(pub_pem),
    )
