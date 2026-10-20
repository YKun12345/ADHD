"""DDL plans run twice only against an empty, disposable synthetic database."""
import pytest
from sqlalchemy import create_engine, inspect


def test_attention_schema_requires_explicit_plan_and_is_repeatable(tmp_path):
    from backend.app import models
    from backend.app.db.base import Base
    engine = create_engine(f"sqlite:///{(tmp_path/'w05-migration.db').as_posix()}")
    Base.metadata.create_all(engine)
    with engine.begin() as db:
        db.exec_driver_sql("DROP TABLE attention_items")
        db.exec_driver_sql("ALTER TABLE assessment_sessions DROP COLUMN suspension_reason")
        db.exec_driver_sql("ALTER TABLE patient_tasks DROP COLUMN suspension_reason")
    from backend.app.db.care_migration import schema_plan, require_care_schema
    before = set(inspect(engine).get_table_names())
    first,second = schema_plan(engine),schema_plan(engine)
    assert first == second and first["requires_explicit_review"] is True
    assert before == set(inspect(engine).get_table_names())
    with pytest.raises(RuntimeError,match="explicit"):
        require_care_schema(engine)
    with engine.begin() as db:
        for statement in first["statements"]:
            db.exec_driver_sql(statement)
    assert schema_plan(engine)["statements"] == []
    require_care_schema(engine)
    engine.dispose()


def test_six_handover_tables_are_planned_without_touching_the_selected_schema(tmp_path):
    from backend.app import models
    from backend.app.db.base import Base
    from backend.app.db.care_migration import schema_plan, require_care_schema
    engine = create_engine(f"sqlite:///{(tmp_path/'w05-transfer-migration.db').as_posix()}")
    Base.metadata.create_all(engine)
    names = ('care_transfer_work_actions', 'care_transfer_claims', 'care_transfer_maintenance_cursors',
        'care_transfer_work_items', 'care_transfer_decisions', 'care_transfer_requests')
    with engine.begin() as db:
        for name in names:
            db.exec_driver_sql('DROP TABLE ' + name)
    before = set(inspect(engine).get_table_names())
    first = schema_plan(engine)
    assert first == schema_plan(engine) and set(inspect(engine).get_table_names()) == before
    for name in names:
        assert any('CREATE TABLE ' + name in statement for statement in first['statements'])
    with pytest.raises(RuntimeError, match='explicit'):
        require_care_schema(engine)
    with engine.begin() as db:
        for statement in first['statements']:
            db.exec_driver_sql(statement)
    require_care_schema(engine)
    assert schema_plan(engine)['statements'] == []
    engine.dispose()
