"""Read-only W04/W05 schema planning. Runtime never upgrades a selected store."""
from sqlalchemy import inspect
from sqlalchemy.schema import CreateColumn,CreateIndex,CreateTable
from backend.app.db.base import Base

NEW_TABLES = {"submission_records","care_event_deliveries"}
BOUND_TABLES = {"scale_results","cognitive_tests","assessment_sessions","task_attempts","care_events","submission_records"}
VERSION_COLUMNS = {"record_schema_version","data_version","record_key_version","envelope_status","record_origin"}


def schema_plan(engine):
    if engine.dialect.name not in {"sqlite","mysql"}:
        raise RuntimeError("W04 schema planning supports reviewed SQLite/MySQL dialects only.")
    inspector = inspect(engine)
    existing = set(inspector.get_table_names())
    statements = []
    for table in Base.metadata.sorted_tables:
        if table.name in NEW_TABLES and table.name not in existing:
            statements.append(str(CreateTable(table).compile(dialect=engine.dialect)).strip())
            statements.extend(str(CreateIndex(index).compile(dialect=engine.dialect)).strip() for index in sorted(table.indexes,key=lambda index:index.name))
    for table_name in sorted(BOUND_TABLES & existing):
        table = Base.metadata.tables[table_name]
        columns = {column["name"] for column in inspector.get_columns(table_name)}
        wanted = set(VERSION_COLUMNS)
        if table_name == "care_events":
            wanted.add("dedupe_key")
        for name in sorted(wanted-columns):
            column_sql = str(CreateColumn(table.c[name]).compile(dialect=engine.dialect))
            statements.append(f"ALTER TABLE {table_name} ADD COLUMN {column_sql}")
        if table_name == "care_events":
            uniques = [row.get("column_names") for row in inspector.get_unique_constraints(table_name)] + [row.get("column_names") for row in inspector.get_indexes(table_name) if row.get("unique")]
            if ["dedupe_key"] not in uniques:
                statements.append("CREATE UNIQUE INDEX uq_care_event_dedupe_key ON care_events (dedupe_key)")
    return {"requires_explicit_review":True,"dialect":engine.dialect.name,"statements":statements,
        "legacy_policy":"Existing rows receive explicit legacy envelopes; no old value is retroactively object-authenticated. Cipher conversion requires a separately reviewed source manifest and encrypted backup.",
        "execution_policy":"No runtime schema mutation. Real store execution requires separate authorization, backup, rehearsal and rollback review.",
        "authority_policy":"No consent, identities, clinician qualification or template approval is seeded."}


def require_submission_schema(engine):
    plan = schema_plan(engine)
    if plan["statements"]:
        raise RuntimeError("W04/W05 submission/envelope schema requires a reviewed explicit migration; runtime does not upgrade it.")
