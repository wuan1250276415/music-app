"""Create a short-lived certificate only inside the caller's owned test directory."""
from pathlib import Path
from datetime import datetime, timedelta, timezone
import sys
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

folder = Path(sys.argv[1]).resolve()
if folder.parent.parent != Path('D:/CodexTestData') or not folder.parent.name.startswith('aural-packaged-mvp-') or folder.name != 'tls':
    raise ValueError('Certificate output must be inside an owned packaged MVP directory')
folder.mkdir()
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Aural isolated packaged MVP')])
now = datetime.now(timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5))
        .not_valid_after(now+timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName('api.acoustid.org'), x509.DNSName('musicbrainz.org')]), critical=False)
        .sign(key, hashes.SHA256()))
(folder/'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
(folder/'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
