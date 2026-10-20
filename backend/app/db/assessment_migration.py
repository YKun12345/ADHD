"""Explicit W03 schema plan; never infers authority or historic measurement metadata."""
from sqlalchemy import inspect
from sqlalchemy.schema import CreateIndex, CreateTable

from backend.app.db.base import Base

ASSESSMENT_TABLES = {"assessment_sessions", "assessment_items", "task_attempts"}
REFERENCES = {"assessment_id":"assessment_sessions", "assessment_item_id":"assessment_items", "task_attempt_id":"task_attempts"}
ADDITIONS = {"patient_tasks":("assessment_id","assessment_item_id"), "scale_results":tuple(REFERENCES), "cognitive_tests":tuple(REFERENCES)}


def schema_plan(engine):
    if engine.dialect.name not in {"sqlite", "mysql"}:
        raise RuntimeError("W03 reviewed schema planning supports SQLite/MySQL only.")
    inspector = inspect(engine)
    existing = set(inspector.get_table_names())
    missing = ASSESSMENT_TABLES - existing
    missing_columns = {name:sorted(set(Base.metadata.tables[name].columns.keys()) - {column["name"] for column in inspector.get_columns(name)}) for name in ASSESSMENT_TABLES & existing}
    missing_columns = {name:columns for name,columns in missing_columns.items() if columns}
    statements = []
    for table in Base.metadata.sorted_tables:
        if table.name in missing:
            statements.append(str(CreateTable(table).compile(dialect=engine.dialect)).strip())
            statements.extend(str(CreateIndex(index).compile(dialect=engine.dialect)).strip() for index in sorted(table.indexes,key=lambda item:item.name))
    for table, columns in ADDITIONS.items():
        if table not in existing:
            continue
        names = {column["name"] for column in inspector.get_columns(table)}
        for column in columns:
            if column not in names:
                ref = f" REFERENCES {REFERENCES[column]}(id)" if engine.dialect.name == "sqlite" else ""
                statements.append(f"ALTER TABLE {table} ADD COLUMN {column} INTEGER NULL{ref}")
        if "legacy" not in names:
            statements.append(f"ALTER TABLE {table} ADD COLUMN legacy BOOLEAN NOT NULL DEFAULT 1")
        unique_column = "assessment_item_id" if table == "patient_tasks" else "task_attempt_id"
        uniques = [row.get("column_names") for row in inspector.get_unique_constraints(table)] + [row.get("column_names") for row in inspector.get_indexes(table) if row.get("unique")]
        if [unique_column] not in uniques:
            statements.append(f"CREATE UNIQUE INDEX uq_w03_{table}_{unique_column} ON {table} ({unique_column})")
        if engine.dialect.name == "mysql":
            fks = [row.get("constrained_columns") for row in inspector.get_foreign_keys(table)]
            for column in columns:
                if [column] not in fks:
                    statements.append(f"ALTER TABLE {table} ADD CONSTRAINT fk_w03_{table}_{column} FOREIGN KEY ({column}) REFERENCES {REFERENCES[column]}(id)")
    return {"requires_explicit_review":True, "dialect":engine.dialect.name, "missing_tables":sorted(missing), "missing_columns":missing_columns, "statements":statements, "legacy_policy":"Existing tasks/results retain original evidence and null assessment/attempt references; legacy=true. No age, observer, protocol, consent, doctor, or accepted status is backfilled.", "authority_policy":"No authority/ledger/template approval is seeded; W02 authority remains separately provisioned.", "runtime_policy":"Non-test startup fails closed on missing W03 schema; no automatic upgrade. Existing partial W03 objects need their own reviewed preservation plan, never invented performer/age metadata.", "real_database_execution":"Requires separately authorized review, backup, rehearsal, counts/digests/relations, and rollback review; current execution evidence is temporary SQLite only."}


def require_assessment_schema(engine):
    plan = schema_plan(engine)
    if plan["missing_tables"] or plan["statements"] or plan["missing_columns"]:
        raise RuntimeError("W03 assessment schema requires an explicit reviewed migration; runtime startup cannot upgrade it. Use tools/plan-w03-schema.py with an explicit database.")
