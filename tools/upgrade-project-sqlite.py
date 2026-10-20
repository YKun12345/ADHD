"""Explicit, backed-up SQLite upgrade. Never called by application startup.

Builds and checks a temporary copy before publishing it. It preserves legacy
ownership columns but never turns them into consent, guardian or doctor grants.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _quote(name):
    return '"' + name.replace('"', '""') + '"'


def _image(path):
    from contextlib import closing
    with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(':memory:')) as target:
            source.backup(target)
            return target.serialize()


def _logical_state(engine, columns=None):
    from sqlalchemy import inspect
    from backend.app.db.base import Base
    from backend.app.core.data_encryption import EncryptedValue, PREFIX, decrypt_value
    from backend.app.core.record_envelope import RecordBinding, open_record, PREFIX as V2
    from backend.app.db.record_envelope_migration import TABLES
    from backend.app.db.imaging_migration import _models
    bindings = {name: (kind, set(fields)) for name, (kind, fields) in TABLES.items()}
    bindings.update({model.__tablename__: (model.record_object_type, set(model.record_fields)) for model in _models()})
    inspector=inspect(engine)
    columns = columns or {name: [item['name'] for item in inspector.get_columns(name)] for name in inspector.get_table_names()}
    content, counts = {}, {}
    with engine.connect() as conn:
        for name, names in columns.items():
            rows=conn.exec_driver_sql('SELECT * FROM '+_quote(name)+' ORDER BY rowid').mappings().all()
            normalized=[]
            table=Base.metadata.tables.get(name)
            for row in rows:
                values={}
                for field in names:
                    value=row[field]
                    kind, bound_fields=bindings.get(name,(None,set()))
                    column_type=table.c[field].type if table is not None and field in table.c else None
                    if isinstance(value,str) and value.startswith(PREFIX):
                        if isinstance(column_type,EncryptedValue):
                            value=decrypt_value(value,column_type.context)
                        elif field in bound_fields:
                            value=decrypt_value(value,name+'.'+field)
                    elif isinstance(value,str) and value.startswith(V2) and field in bound_fields:
                        value=open_record(value,RecordBinding(row['patient_id'],kind,row['id'],field,
                            row['record_schema_version'],row['data_version'],row['record_key_version']))
                    values[field]=value
                normalized.append(values)
            counts[name]=len(rows)
            content[name]=normalized
    return {'columns':columns,'counts':counts,'content_sha256':_sha(json.dumps(content,sort_keys=True,
        separators=(',',':'),default=str,ensure_ascii=False).encode())}


def _apply_schema(engine):
    from sqlalchemy import inspect, UniqueConstraint
    from sqlalchemy.schema import CreateColumn
    from backend.app.db.base import Base
    inspector=inspect(engine)
    existing=set(inspector.get_table_names())
    created=sorted(set(Base.metadata.tables)-existing)
    added=[]
    with engine.connect() as conn:
        conn.exec_driver_sql('BEGIN IMMEDIATE')
        try:
            Base.metadata.create_all(conn)
            for name in sorted(existing & set(Base.metadata.tables)):
                table=Base.metadata.tables[name]
                old={item['name'] for item in inspect(conn).get_columns(name)}
                for column in table.c:
                    if column.name in old: continue
                    if not column.nullable and column.server_default is None:
                        raise ValueError('Cannot invent a value for required legacy column '+name+'.'+column.name)
                    definition=str(CreateColumn(column).compile(dialect=engine.dialect))
                    for foreign in column.foreign_keys:
                        if not column.nullable:
                            raise ValueError('Legacy foreign keys must remain nullable')
                        definition+=' REFERENCES '+_quote(foreign.column.table.name)+'('+_quote(foreign.column.name)+')'
                        if foreign.ondelete: definition+=' ON DELETE '+foreign.ondelete
                    conn.exec_driver_sql('ALTER TABLE '+_quote(name)+' ADD COLUMN '+definition)
                    added.append(name+'.'+column.name)
                for index in sorted(table.indexes,key=lambda item:item.name):
                    index.create(conn,checkfirst=True)
                known={tuple(item['column_names']) for item in inspect(conn).get_unique_constraints(name)}
                known.update(tuple(item['column_names']) for item in inspect(conn).get_indexes(name) if item.get('unique'))
                for constraint in table.constraints:
                    if not isinstance(constraint,UniqueConstraint): continue
                    names=tuple(column.name for column in constraint.columns)
                    if names in known: continue
                    index_name=constraint.name or 'uq_upgrade_'+name+'_'+'_'.join(names)
                    conn.exec_driver_sql('CREATE UNIQUE INDEX '+_quote(index_name)+' ON '+_quote(name)+
                        ' ('+','.join(_quote(field) for field in names)+')')
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return created,added


def _schema_issues(engine):
    from sqlalchemy import inspect
    from backend.app.db.base import Base
    from backend.app.db.care_migration import _missing_constraints
    inspector=inspect(engine); present=set(inspector.get_table_names()); issues={}
    for table in Base.metadata.sorted_tables:
        if table.name not in present:
            issues[table.name]={'missing_table':True};continue
        columns=sorted(set(table.c.keys())-{item['name'] for item in inspector.get_columns(table.name)})
        constraints=_missing_constraints(inspector,table)
        if columns or constraints: issues[table.name]={'columns':columns,'constraints':constraints}
    return issues


def prepare_upgraded_copy(source, work_root, backup_root):
    """Source is read-only. All schema/conversion work occurs under system temp."""
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import Session
    import backend.app.models
    from backend.app.db.encryption_migration import _write_backup, _write_manifest
    from backend.app.core.data_encryption import FILE_MAGIC, decrypt_bytes
    from backend.app.db.record_envelope_migration import migration_manifest, migrate_legacy_record_fields
    from backend.app.db.imaging_migration import prepare_temporary_conversion,convert_reviewed_temporary_store
    source=Path(source).resolve(); work=Path(work_root).resolve(); backups=Path(backup_root).resolve()
    if not source.is_file() or not work.is_relative_to(Path(tempfile.gettempdir()).resolve()) or work==source.parent:
        raise ValueError('Select an existing source and a separate system-temporary working directory')
    work.mkdir(parents=True,exist_ok=False); backups.mkdir(parents=True,exist_ok=False)
    original_sha=_sha(source.read_bytes()); image=_image(source)
    upgraded=work/'upgraded.db'; upgraded.write_bytes(image)
    _write_backup(backups,'database-before-upgrade.db',image); _write_manifest(backups)
    restored=decrypt_bytes((backups/'database-before-upgrade.db.enc').read_bytes()[len(FILE_MAGIC):],
                           'migration-backup:database-before-upgrade.db')
    if restored!=image:raise ValueError('Encrypted database backup failed restoration')
    restored_path=work/'restore-check.db'; restored_path.write_bytes(restored)
    engine=create_engine('sqlite:///'+upgraded.as_posix())
    try:
        before=_logical_state(engine)
        restore_engine=create_engine('sqlite:///'+restored_path.as_posix())
        try:
            if _logical_state(restore_engine)!=before:raise ValueError('Restored backup differs from source')
        finally:restore_engine.dispose()
        created,added=_apply_schema(engine)
        manifest=migration_manifest(engine)
        converted=migrate_legacy_record_fields(engine,work/'record-backups',reviewed_manifest=manifest)['migrated_rows']
        imaging=prepare_temporary_conversion(engine,work/'imaging-backups')
        converted+=convert_reviewed_temporary_store(engine,reviewed_manifest=imaging['manifest'],
            backup_path=imaging['backup_path'],backup_sha256=imaging['backup_sha256'])['migrated_rows']
        after=_logical_state(engine,before['columns'])
        if before!=after:raise ValueError('Original logical records or counts changed during migration')
        issues=_schema_issues(engine)
        with engine.connect() as conn:
            foreign=len(conn.exec_driver_sql('PRAGMA foreign_key_check').all())
            integrity=conn.exec_driver_sql('PRAGMA integrity_check').scalar_one()
        if issues or foreign or integrity!='ok':raise ValueError('Upgraded schema/foreign keys/integrity failed')
        from backend.app.models.scale_result import ScaleResult
        from backend.app.models.cognitive_test import CognitiveTest
        from backend.app.models.model_prediction import ModelPrediction
        from backend.app.models.imaging_visualization import ImagingVisualization
        with Session(engine) as db:
            for model in (ScaleResult,CognitiveTest,ModelPrediction,ImagingVisualization):
                for row in db.scalars(select(model)):
                    for field in model.record_fields:getattr(row,field)
        return {'source_path':str(source),'source_sha256':original_sha,'upgraded_path':str(upgraded),
            'backup_directory':str(backups),'backup_image_sha256':_sha(image),'backup_restore_verified':True,
            'counts_preserved':before['counts'],'logical_content_sha256':before['content_sha256'],
            'logical_content_preserved':True,'new_tables':created,'added_columns':added,
            'converted_rows':converted,'missing_schema_after':issues,'foreign_key_issues':foreign,
            'integrity_check':integrity,'professional_or_consent_authority_seeded':False}
    finally:
        engine.dispose()
        restored_path.unlink(missing_ok=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-path',required=True)
    parser.add_argument('--execute',action='store_true')
    parser.add_argument('--reviewed',action='store_true')
    args=parser.parse_args()
    if not args.execute or not args.reviewed:
        parser.error('Explicit authorization and reviewed execution require --execute --reviewed')
    target=Path(args.database_path).resolve()
    if target!=ROOT/'backend/app.db':parser.error('This reviewed release selects only the project backend/app.db')
    from dotenv import load_dotenv,set_key
    load_dotenv(ROOT/'backend/.env',override=False)
    os.environ['APP_ENV']='migration'
    os.environ['DATABASE_URL']='sqlite:///'+target.as_posix()
    from backend.app.core.config import settings
    if not settings.DATA_ENCRYPTION_KEY and not Path(settings.SECURITY_MASTER_KEY_PATH).is_file():
        raise ValueError('Existing encryption key is required; never generate a replacement during migration')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup_root=ROOT/'backend/migration-backups'/('explicit-upgrade-'+stamp)
    temp_parent=Path(tempfile.mkdtemp(prefix='adhd-explicit-upgrade-'))
    receipt=prepare_upgraded_copy(target,temp_parent/'work',backup_root)
    from backend.app.db.encryption_migration import _write_backup,_write_manifest,restore_backup
    from backend.app.core.data_encryption import FILE_MAGIC,decrypt_bytes
    env_path=ROOT/'backend/.env'
    _write_backup(backup_root,'backend.env',env_path.read_bytes())
    uploads=Path(settings.UPLOAD_ROOT).resolve(); upload_hashes={}
    for file in sorted(uploads.rglob('*')):
        if not file.is_file():continue
        relative=file.relative_to(uploads).as_posix(); raw=file.read_bytes()
        _write_backup(backup_root,'uploads/'+relative,raw)
        encrypted=(backup_root/('uploads/'+relative+'.enc')).read_bytes()
        if decrypt_bytes(encrypted[len(FILE_MAGIC):],'migration-backup:uploads/'+relative)!=raw:
            raise ValueError('Upload backup restoration failed')
        upload_hashes[relative]=_sha(raw)
    _write_manifest(backup_root)
    restored_resources=temp_parent/'full-restore-check'
    restored_files=restore_backup(backup_root,restored_resources)
    if (_sha((restored_resources/'database-before-upgrade.db').read_bytes())!=receipt['backup_image_sha256']
            or (restored_resources/'backend.env').read_bytes()!=env_path.read_bytes()):
        raise ValueError('Complete backup restore does not match the reviewed sources')
    for relative,digest in upload_hashes.items():
        if _sha((restored_resources/'uploads'/relative).read_bytes())!=digest:
            raise ValueError('Restored upload content differs')
    receipt['complete_backup_restore_verified']=True
    receipt['backup_components_verified']=restored_files
    # This freshly created restore directory must stay under this run's temp
    # root. Remove its own restored files, including the temporary .env copy.
    if not restored_resources.resolve().is_relative_to(temp_parent.resolve()):
        raise ValueError('Restore cleanup escaped the selected temporary directory')
    for restored_file in restored_resources.rglob('*'):
        if restored_file.is_file():restored_file.unlink()
    if not settings.DATA_ENCRYPTION_KEY:
        key_path=Path(settings.SECURITY_MASTER_KEY_PATH).resolve()
        recovery=key_path.with_name('upgrade-recovery-'+stamp+'.key')
        with recovery.open('xb') as out:out.write(key_path.read_bytes())
        if _sha(recovery.read_bytes())!=_sha(key_path.read_bytes()):raise ValueError('Key backup mismatch')
        receipt['separate_key_backup']=str(recovery)
    # No stale business copy may reset or reconstruct an authorization ledger.
    ledger=Path(settings.AUTHORIZATION_LEDGER_PATH).resolve() if settings.AUTHORIZATION_LEDGER_PATH else ROOT/'backend/.keys/authorization-heads.db'
    settings.AUTHORIZATION_LEDGER_PATH=str(ledger)
    from backend.app.services.authorization_ledger import initialize_ledger
    initialize_ledger()
    startup_env=dict(os.environ,DATABASE_URL='sqlite:///'+Path(receipt['upgraded_path']).as_posix(),
        APP_ENV='migration',AUTHORIZATION_LEDGER_PATH=str(ledger),CARE_WORKER_ENABLED='false',
        AGENT_WORKER_ENABLED='false',FEDERATED_WORKER_ENABLED='false',WECHAT_NOTIFICATION_WORKER_ENABLED='false')
    checked=subprocess.run([sys.executable,'-B','-c','from backend.app.db.init_db import init_db; init_db()'],
        cwd=str(ROOT),env=startup_env,capture_output=True,timeout=60)
    if checked.returncode:
        raise RuntimeError('Non-test startup schema preflight failed: '+checked.stderr.decode(errors='replace')[-1500:])
    receipt['non_test_startup_preflight_passed']=True
    if _sha(target.read_bytes())!=receipt['source_sha256']:
        raise ValueError('Live database changed during rehearsal; publication aborted')
    for suffix in ('-wal','-journal'):
        sidecar=Path(str(target)+suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise ValueError('Live SQLite has an active journal; stop writers before publication')
    # Both selected files are on the same local volume. Source and all uploads
    # remain backed up; no recursive removal, table drop or key rotation occurs.
    os.replace(receipt['upgraded_path'],target)
    set_key(str(env_path),'AUTHORIZATION_LEDGER_PATH',str(ledger))
    receipt.update(published=True,authorization_ledger_path=str(ledger),upload_files_preserved=len(upload_hashes),
        completed_at=datetime.now(timezone.utc).isoformat())
    for relative,digest in upload_hashes.items():
        if _sha((uploads/relative).read_bytes())!=digest:raise ValueError('Original upload changed')
    output=ROOT/'docs/evidence/live-schema-upgrade-receipt-20261018.json'
    output.write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(receipt,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
