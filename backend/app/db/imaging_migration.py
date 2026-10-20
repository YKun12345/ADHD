"""Read-only W09 plans and explicit, reviewed TEMPORARY SQLite rehearsals.

Nothing here is called at startup. Real-store conversion is intentionally absent.
"""
import base64
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
from uuid import uuid4
from sqlalchemy import inspect, text
from sqlalchemy.schema import CreateColumn, CreateTable, CreateIndex
from sqlalchemy.dialects import mysql, sqlite
from backend.app.core.data_encryption import PREFIX as V1, encrypt_value, decrypt_value
from backend.app.core.record_envelope import RecordBinding, seal_record, seal_origin
from backend.app.models.imaging_storage import canonical_metadata

VERSION_COLUMNS = {'record_schema_version','data_version','record_key_version','envelope_status','record_origin','storage_context'}
LEGACY_ENCRYPTED = {
    'model_predictions': {'file_name','prediction_label','probability','probability_control','summary_text'},
    'imaging_visualizations': {'slice_screenshot_data','surface_screenshot_data','slice_interpretation','surface_interpretation','summary_text','notes'},
}


def _models():
    from backend.app.models.model_prediction import ModelPrediction
    from backend.app.models.imaging_visualization import ImagingVisualization
    return (ModelPrediction,ImagingVisualization)


def missing_storage_columns(bind):
    inspector=inspect(bind)
    tables=set(inspector.get_table_names())
    return {model.__tablename__: sorted(set(model.__table__.c.keys()) - ({c['name'] for c in inspector.get_columns(model.__tablename__)} if model.__tablename__ in tables else set()))
        for model in _models() if model.__tablename__ not in tables or set(model.__table__.c.keys()) - {c['name'] for c in inspector.get_columns(model.__tablename__)}}


def storage_schema_issues(bind):
    if bind.dialect.name != 'mysql':
        return []
    inspector=inspect(bind)
    tables=set(inspector.get_table_names())
    issues=[]
    for model in _models():
        if model.__tablename__ not in tables:
            continue
        for column in inspector.get_columns(model.__tablename__):
            if column['name'] in set(model.record_fields)|{'record_origin'} and not isinstance(column['type'],mysql.LONGTEXT):
                issues.append({'table':model.__tablename__,'column':column['name'],'issue':'requires_longtext'})
    return issues


def schema_plan(engine, *, dialect_name=None):
    name=dialect_name or engine.dialect.name
    if name not in {'sqlite','mysql'}:
        raise ValueError('W09 plans support SQLite/MySQL only.')
    dialect=mysql.dialect() if name == 'mysql' else sqlite.dialect()
    inspector=inspect(engine)
    tables=set(inspector.get_table_names())
    statements=[]
    pending={}
    for model in _models():
        table=model.__table__
        if table.name not in tables:
            statements.append(str(CreateTable(table).compile(dialect=dialect)).strip())
            statements.extend(str(CreateIndex(index).compile(dialect=dialect)).strip() for index in sorted(table.indexes,key=lambda i:i.name))
            pending[table.name]=0
            continue
        columns={c['name']:c for c in inspector.get_columns(table.name)}
        for column in table.c:
            if column.name not in columns:
                statements.append(f'ALTER TABLE {table.name} ADD COLUMN '+str(CreateColumn(column).compile(dialect=dialect)))
            elif name == 'mysql' and column.name in set(model.record_fields)|{'record_origin'}:
                # Existing names and filenames may have been VARCHAR; v2 is
                # larger and must never be truncated by those old definitions.
                statements.append(f'ALTER TABLE {table.name} MODIFY COLUMN {column.name} LONGTEXT '+('NULL' if column.nullable else 'NOT NULL'))
        with engine.connect() as conn:
            clause=" WHERE envelope_status='legacy'" if 'envelope_status' in columns else ''
            pending[table.name]=conn.execute(text(f'SELECT COUNT(*) FROM {table.name}'+clause)).scalar_one()
    return {'requires_explicit_review':True,'dialect':name,'statements':statements,
        'missing_columns':missing_storage_columns(engine),'incompatible_types':storage_schema_issues(engine),'pending_conversion':pending,
        'execution_policy':'Read-only plan. Real-store DDL/conversion requires separate authorization; no startup execution.',
        'legacy_policy':'Explicit temporary review, exact source manifest and encrypted backup digest; no automatic v1 reads.',
        'source_binding_retroactively_proven':False}


def _temporary_path(path):
    candidate=Path(path).resolve()
    temporary=Path(tempfile.gettempdir()).resolve()
    if not candidate.is_relative_to(temporary) or candidate == temporary:
        raise ValueError('Rehearsal is restricted to an explicitly selected temporary SQLite file.')
    return candidate


def _temporary_database(engine):
    if engine.dialect.name != 'sqlite' or not engine.url.database or engine.url.database == ':memory:':
        raise ValueError('Rehearsal requires a temporary file-backed SQLite database; real-store execution is unavailable.')
    return _temporary_path(engine.url.database)


def _legacy_rows(conn):
    if missing_storage_columns(conn):
        raise ValueError('Review/apply the schema plan on the temporary copy before conversion.')
    result=[]
    for model in _models():
        table=model.__tablename__
        for row in conn.execute(text(f"SELECT * FROM {table} WHERE envelope_status='legacy' ORDER BY id")).mappings():
            row=dict(row)
            if row['record_origin'] is not None or row['storage_context'] is not None or any(isinstance(row[f],str) and row[f].startswith('aesgcm:v2:') for f in model.record_fields):
                raise ValueError('An authenticated record cannot be downgraded and approved as legacy.')
            if row['record_schema_version'] != 1 or row['data_version'] != 1 or row['record_key_version'] != 1:
                raise ValueError('Unexpected legacy version markers require manual review.')
            for field in LEGACY_ENCRYPTED[table]:
                if row[field] is not None and (not isinstance(row[field],str) or not row[field].startswith(V1)):
                    raise ValueError('Unencrypted or unexpected legacy sensitive input requires separate review.')
            result.append({'table':table,'values':row})
    return result


def _manifest(rows):
    entries=[{'table':item['table'],'id':item['values']['id'],'patient_id':item['values']['patient_id'],
        'row_sha256':hashlib.sha256(json.dumps(item['values'],sort_keys=True,separators=(',',':'),default=str).encode()).hexdigest()} for item in rows]
    return {'manifest_version':1,'rows':entries,'source_digest':hashlib.sha256(json.dumps(entries,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
        'source_binding_retroactively_proven':False}


def prepare_temporary_conversion(engine, backup_root):
    database=_temporary_database(engine)
    directory=_temporary_path(backup_root)
    directory.mkdir(parents=True,exist_ok=True)
    # SQLite backup captures a consistent image, including a database using WAL.
    with sqlite3.connect(f'file:{database.as_posix()}?mode=ro',uri=True) as source, sqlite3.connect(':memory:') as target:
        source.backup(target)
        image=target.serialize()
    from sqlalchemy import create_engine
    snapshot=directory/(uuid4().hex+'.snapshot.db')
    snapshot.write_bytes(image)
    temporary_engine=create_engine('sqlite:///'+snapshot.as_posix())
    try:
        with temporary_engine.connect() as conn:
            manifest=_manifest(_legacy_rows(conn))
    finally:
        temporary_engine.dispose()
        snapshot.unlink()
    backup=directory/(uuid4().hex+'.imaging-backup.enc')
    backup.write_text(encrypt_value({'manifest':manifest,'database_image':base64.b64encode(image).decode('ascii'),
        'image_sha256':hashlib.sha256(image).hexdigest()},'w09-temporary-imaging-backup'),encoding='ascii')
    digest=hashlib.sha256(backup.read_bytes()).hexdigest()
    _read_backup(backup,digest)
    return {'manifest':manifest,'backup_path':str(backup),'backup_sha256':digest}


def _read_backup(path,digest):
    source=_temporary_path(path)
    raw=source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('Encrypted backup digest does not match the reviewed backup.')
    payload=decrypt_value(raw.decode('ascii'),'w09-temporary-imaging-backup')
    image=base64.b64decode(payload['database_image'],validate=True)
    if hashlib.sha256(image).hexdigest() != payload['image_sha256']:
        raise ValueError('Backup image digest failed.')
    return payload,image


def convert_reviewed_temporary_store(engine, *, reviewed_manifest, backup_path, backup_sha256):
    _temporary_database(engine)
    backup,_=_read_backup(backup_path,backup_sha256)
    if backup['manifest'] != reviewed_manifest:
        raise ValueError('Reviewed manifest does not match encrypted backup.')
    model_by_table={model.__tablename__:model for model in _models()}
    with engine.connect() as conn:
        conn.exec_driver_sql('BEGIN IMMEDIATE')
        try:
            rows=_legacy_rows(conn)
            if _manifest(rows) != reviewed_manifest:
                raise ValueError('Reviewed source manifest no longer matches the temporary store.')
            for item in rows:
                table=item['table']; row=item['values']; model=model_by_table[table]
                metadata=canonical_metadata(SimpleNamespace(storage_metadata_fields=model.storage_metadata_fields,**row))
                values={'record_schema_version':2,'record_key_version':1,'envelope_status':'migrated_from_legacy'}
                for field in model.record_fields:
                    if field == 'storage_context':
                        plain={'context_version':1,'actor_user_id':None,'authority_receipts':[],
                            'source_binding_status':'not_recorded','source_binding_retroactively_proven':False,
                            'professional_review_status':'not_recorded','input':{'kind':'legacy_not_recorded'},'metadata':metadata,
                            'conversion_source_digest':reviewed_manifest['source_digest']}
                    else:
                        raw=row[field]
                        plain=decrypt_value(raw,table+'.'+field) if raw is not None and field in LEGACY_ENCRYPTED[table] else raw
                    values[field]=seal_record(plain,RecordBinding(row['patient_id'],model.record_object_type,row['id'],field,2,1,1))
                values['record_origin']=seal_origin(row['patient_id'],model.record_object_type,row['id'],schema_version=2,data_version=1,key_version=1,status='migrated_from_legacy')
                assignments=', '.join(name+'=:'+name for name in values)
                conn.execute(text(f'UPDATE {table} SET {assignments} WHERE id=:row_id'),{**values,'row_id':row['id']})
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {'migrated_rows':len(rows),'source_binding_retroactively_proven':False}


def restore_temporary_backup(backup_path,backup_sha256,destination):
    target=_temporary_path(destination)
    _,image=_read_backup(backup_path,backup_sha256)
    if target.exists():
        raise ValueError('Restore destination already exists; overwrite is prohibited.')
    with target.open('xb') as output:
        output.write(image)
    return {'restored_path':str(target),'image_sha256':hashlib.sha256(image).hexdigest()}
