"""Create, encrypt, restore and verify ONLY a temporary synthetic SQLite snapshot.

No project database, key file, model, upload or authorization ledger is opened.
The receipt proves this local mechanism only; it cannot authorize a real release.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import secrets
import sqlite3
import tempfile
from contextlib import closing

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def sha(data):
    return hashlib.sha256(data).hexdigest()


def rehearse():
    with tempfile.TemporaryDirectory(prefix='adhd-s456-synthetic-') as directory:
        root = Path(directory)
        key = AESGCM.generate_key(bit_length=256)
        cipher = AESGCM(key)
        nonce = secrets.token_bytes(12)
        record = cipher.encrypt(nonce, b'synthetic-record-only', b'synthetic-row-1')
        source = root / 'synthetic.db'
        with closing(sqlite3.connect(source)) as db, db:
            db.execute('CREATE TABLE synthetic_records (id INTEGER PRIMARY KEY, sealed BLOB NOT NULL)')
            db.execute('INSERT INTO synthetic_records VALUES (1, ?)', (nonce + record,))
        upload = b'synthetic-upload-only-no-real-subject'
        snapshot = root / 'snapshot.db'
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as origin, closing(sqlite3.connect(snapshot)) as target:
            origin.backup(target)
        image = snapshot.read_bytes()
        package = json.dumps({'database': base64.b64encode(image).decode(),
            'upload': base64.b64encode(upload).decode()}, sort_keys=True).encode()
        backup_nonce = secrets.token_bytes(12)
        encrypted = backup_nonce + cipher.encrypt(backup_nonce, package, b'adhd-s456-synthetic-backup-v1')
        backup = root / 'snapshot.enc'
        backup.write_bytes(encrypted)
        restored = json.loads(cipher.decrypt(encrypted[:12], encrypted[12:], b'adhd-s456-synthetic-backup-v1'))
        restored_image = base64.b64decode(restored['database'])
        restored_upload = base64.b64decode(restored['upload'])
        target = root / 'restored.db'
        target.write_bytes(restored_image)
        with closing(sqlite3.connect(target.as_uri() + '?mode=ro', uri=True)) as db:
            integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
            sealed = db.execute('SELECT sealed FROM synthetic_records WHERE id=1').fetchone()[0]
        tampered = bytearray(encrypted)
        tampered[-1] ^= 1
        rejected = wrong_rejected = False
        try:
            cipher.decrypt(tampered[:12], tampered[12:], b'adhd-s456-synthetic-backup-v1')
        except InvalidTag:
            rejected = True
        try:
            AESGCM(AESGCM.generate_key(bit_length=256)).decrypt(encrypted[:12], encrypted[12:], b'adhd-s456-synthetic-backup-v1')
        except InvalidTag:
            wrong_rejected = True
        report = {'scope': 'local_synthetic_backup_restore_only', 'synthetic_only': True,
            'database_sha256': sha(image), 'restored_database_sha256': sha(restored_image),
            'upload_sha256': sha(upload), 'restored_upload_sha256': sha(restored_upload),
            'encrypted_archive_sha256': sha(encrypted), 'sqlite_integrity_check': integrity,
            'synthetic_record_decrypted_after_restore': cipher.decrypt(sealed[:12], sealed[12:], b'synthetic-row-1') == b'synthetic-record-only',
            'tampered_archive_rejected': rejected, 'wrong_key_rejected': wrong_rejected,
            'authorization_ledger_restored_from_business_backup': False,
            'project_credentials_or_databases_read': False, 'live_target_backup_verified': False}
    report['temporary_workspace_removed'] = not root.exists()
    assert report['database_sha256'] == report['restored_database_sha256']
    assert report['upload_sha256'] == report['restored_upload_sha256']
    assert integrity == 'ok' and rejected and wrong_rejected and report['synthetic_record_decrypted_after_restore']
    assert report['temporary_workspace_removed']
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = rehearse()
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
