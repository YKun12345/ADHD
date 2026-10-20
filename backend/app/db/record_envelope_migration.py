"""Explicit legacy conversion with source digests, encrypted backup and provenance."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from sqlalchemy import inspect,text

from backend.app.core.data_encryption import PREFIX as LEGACY_PREFIX, decrypt_value,encrypt_value
from backend.app.core.record_envelope import RecordBinding,open_record,seal_record,seal_origin

TABLES = {
    "scale_results":("scale_result",("score_json","total_score","risk_level")),
    "cognitive_tests":("cognitive_test",("result_json",)),
    "assessment_sessions":("assessment_session",("background",)),
    "task_attempts":("task_attempt",("execution_metadata",)),
    "care_events":("care_event",("payload",)),
}


def _legacy_rows(engine):
    inspector = inspect(engine)
    existing = set(inspector.get_table_names())
    rows = []
    with engine.connect() as conn:
        for table,(object_type,fields) in TABLES.items():
            if table not in existing:
                continue
            names = {column["name"] for column in inspector.get_columns(table)}
            if not {"envelope_status","record_schema_version","data_version","record_key_version","record_origin"} <= names:
                raise RuntimeError("Review and apply the explicit envelope schema plan before conversion.")
            for row in conn.execute(text(f"SELECT * FROM {table} WHERE envelope_status='legacy' ORDER BY id")).mappings():
                if row["record_origin"] is not None:
                    raise ValueError("A record with authenticated provenance cannot be silently readmitted as unbound legacy input.")
                raw = {field:row[field] for field in fields}
                if any(not isinstance(value,str) or not value.startswith(LEGACY_PREFIX) for value in raw.values()):
                    raise ValueError("Unauthenticated or unexpected legacy input cannot be silently migrated.")
                rows.append({"table":table,"object_type":object_type,"id":row["id"],"patient_id":row["patient_id"],
                    "record_schema_version":row["record_schema_version"],"data_version":row["data_version"],"record_key_version":row["record_key_version"],"raw":raw})
    return rows


def _summary(rows):
    entries = [{"table":row["table"],"id":row["id"],"patient_id":row["patient_id"],
        "record_schema_version":row["record_schema_version"],"data_version":row["data_version"],"record_key_version":row["record_key_version"],
        "fields":{field:hashlib.sha256(raw.encode("ascii")).hexdigest() for field,raw in row["raw"].items()}} for row in rows]
    digest = hashlib.sha256(json.dumps(entries,sort_keys=True,separators=(",",":")).encode("utf-8")).hexdigest()
    return {"manifest_version":2,"source_digest":digest,"rows":entries,"source_binding_retroactively_proven":False}


def migration_manifest(engine):
    return _summary(_legacy_rows(engine))


def migrate_legacy_record_fields(engine,backup_root,*,reviewed_manifest):
    rows = _legacy_rows(engine)
    manifest = _summary(rows)
    if manifest != reviewed_manifest:
        raise ValueError("The reviewed source manifest no longer matches the selected legacy store.")
    if not rows:
        return {"migrated_rows":0,"source_binding_retroactively_proven":False}
    directory = Path(backup_root).resolve()/datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    directory.mkdir(parents=True,exist_ok=False)
    backup = encrypt_value({"manifest":manifest,"records":rows},"w04-reviewed-record-backup")
    target = directory/"legacy-records.json.enc"
    target.write_text(backup,encoding="ascii")
    if decrypt_value(target.read_text(encoding="ascii"),"w04-reviewed-record-backup") != {"manifest":manifest,"records":rows}:
        raise ValueError("Encrypted backup verification failed.")
    after = []
    with engine.begin() as conn:
        for row in rows:
            table,object_type = row["table"],row["object_type"]
            values = {"record_schema_version":2,"record_key_version":1,"envelope_status":"migrated_from_legacy"}
            values["record_origin"] = seal_origin(row["patient_id"],object_type,row["id"],schema_version=2,
                data_version=row["data_version"],key_version=1,status="migrated_from_legacy")
            for field,raw in row["raw"].items():
                plain = decrypt_value(raw,table+"."+field)
                binding = RecordBinding(row["patient_id"],object_type,row["id"],field,2,row["data_version"])
                values[field] = seal_record(plain,binding)
                if open_record(values[field],binding) != plain:
                    raise ValueError("Migrated record validation failed.")
            where = " AND ".join(["id=:source_id","patient_id=:source_patient","envelope_status='legacy'","record_origin IS NULL",
                "data_version=:source_version","record_schema_version=:source_schema","record_key_version=:source_key"]+[f"{field}=:source_{field}" for field in row["raw"]])
            params = {**values,"source_id":row["id"],"source_patient":row["patient_id"],"source_version":row["data_version"],
                "source_schema":row["record_schema_version"],"source_key":row["record_key_version"],**{"source_"+field:raw for field,raw in row["raw"].items()}}
            result = conn.execute(text(f"UPDATE {table} SET "+",".join(f"{field}=:{field}" for field in values)+" WHERE "+where),params)
            if result.rowcount != 1:
                raise ValueError("Legacy source changed during the reviewed conversion.")
            after.append({"table":table,"id":row["id"],"fields":{field:hashlib.sha256(values[field].encode("ascii")).hexdigest() for field in row["raw"]}})
    receipt = {"migrated_rows":len(rows),"source_binding_retroactively_proven":False,"source_digest":manifest["source_digest"],"after":after,"backup_directory":str(directory)}
    (directory/"migration-receipt.json").write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding="utf-8")
    return receipt
