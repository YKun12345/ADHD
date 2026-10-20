"""Explicit temporary migration exercises, never a selected development store."""
import pytest

def test_reviewed_legacy_envelope_migration_is_repeatable_and_not_retroactive(client,tmp_path):
    from sqlalchemy import create_engine
    from backend.app.core.data_encryption import encrypt_value
    from backend.app.db.record_envelope_migration import migration_manifest, migrate_legacy_record_fields
    engine = create_engine("sqlite:///"+(tmp_path/"synthetic-legacy-envelope.db").as_posix())
    with engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE scale_results (id INTEGER PRIMARY KEY,patient_id INTEGER NOT NULL,score_json TEXT NOT NULL,total_score TEXT NOT NULL,risk_level TEXT NOT NULL,record_schema_version INTEGER NOT NULL DEFAULT 1,data_version INTEGER NOT NULL DEFAULT 1,record_key_version INTEGER NOT NULL DEFAULT 1,envelope_status VARCHAR(32) NOT NULL DEFAULT 'legacy')")
        conn.exec_driver_sql("INSERT INTO scale_results (id,patient_id,score_json,total_score,risk_level) VALUES (1,101,?,?,?)",(encrypt_value({"answers":[0]*18},"scale_results.score_json"),encrypt_value(0,"scale_results.total_score"),encrypt_value("low","scale_results.risk_level")))
    from backend.app.db.submission_migration import schema_plan
    with engine.begin() as conn:
        for statement in schema_plan(engine)["statements"]:
            conn.exec_driver_sql(statement)
    before = migration_manifest(engine)
    result = migrate_legacy_record_fields(engine,tmp_path/"backups",reviewed_manifest=before)
    assert result["migrated_rows"] == 1 and result["source_binding_retroactively_proven"] is False
    assert migrate_legacy_record_fields(engine,tmp_path/"backups",reviewed_manifest=migration_manifest(engine))["migrated_rows"] == 0
    from backend.app.core.record_envelope import open_record,RecordBinding
    with engine.connect() as conn:
        row = conn.exec_driver_sql("SELECT total_score,envelope_status FROM scale_results WHERE id=1").one()
        assert row.envelope_status == "migrated_from_legacy"
        assert open_record(row.total_score,RecordBinding(101,"scale_result",1,"total_score",2,1)) == 0
    engine.dispose()


def test_w04_schema_plan_is_read_only_and_repeatable(client,tmp_path):
    from sqlalchemy import create_engine,inspect
    from backend.app.db.submission_migration import schema_plan
    engine = create_engine("sqlite:///"+(tmp_path/"synthetic-schema.db").as_posix())
    plan = schema_plan(engine)
    assert plan["requires_explicit_review"] is True and plan["statements"]
    assert inspect(engine).get_table_names() == []
    with engine.begin() as conn:
        for statement in plan["statements"]:
            conn.exec_driver_sql(statement)
    assert schema_plan(engine)["statements"] == []
    engine.dispose()


@pytest.mark.parametrize("column,value", [("patient_id",202), ("record_key_version",2), ("record_origin","synthetic-racing-proof")])
def test_legacy_conversion_rejects_identity_or_provenance_changed_after_backup(client,tmp_path,monkeypatch,column,value):
    from sqlalchemy import create_engine
    from backend.app.core.data_encryption import encrypt_value
    from backend.app.db import record_envelope_migration as migration
    engine = create_engine("sqlite:///"+(tmp_path/"synthetic-migration-race.db").as_posix())
    with engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE scale_results (id INTEGER PRIMARY KEY,patient_id INTEGER NOT NULL,score_json TEXT NOT NULL,total_score TEXT NOT NULL,risk_level TEXT NOT NULL,record_schema_version INTEGER NOT NULL DEFAULT 1,data_version INTEGER NOT NULL DEFAULT 1,record_key_version INTEGER NOT NULL DEFAULT 1,envelope_status VARCHAR(32) NOT NULL DEFAULT 'legacy',record_origin TEXT)")
        conn.exec_driver_sql("INSERT INTO scale_results (id,patient_id,score_json,total_score,risk_level) VALUES (1,101,?,?,?)",(encrypt_value({"answers":[0]*18},"scale_results.score_json"),encrypt_value(0,"scale_results.total_score"),encrypt_value("low","scale_results.risk_level")))
    manifest = migration.migration_manifest(engine)
    original = migration.seal_origin
    changed = False
    def concurrent_change(*args,**kwargs):
        nonlocal changed
        if not changed:
            changed = True
            with engine.begin() as connection:
                connection.exec_driver_sql(f"UPDATE scale_results SET {column}=? WHERE id=1",(value,))
        return original(*args,**kwargs)
    monkeypatch.setattr(migration,"seal_origin",concurrent_change)
    with pytest.raises(ValueError,match="changed"):
        migration.migrate_legacy_record_fields(engine,tmp_path/"race-backups",reviewed_manifest=manifest)
    with engine.connect() as connection:
        row = connection.exec_driver_sql("SELECT envelope_status,total_score FROM scale_results WHERE id=1").one()
        assert row.envelope_status == "legacy" and row.total_score.startswith("aesgcm:v1:")
    engine.dispose()
