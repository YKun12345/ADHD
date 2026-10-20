"""Read-only upgrade planning. Runtime startup never performs a real W02 migration."""
from sqlalchemy import inspect
from sqlalchemy.schema import CreateTable, CreateIndex
from backend.app.db.base import Base

IDENTITY_TABLES = {"patient_access","guardian_relationships","guardian_history","identity_confirmations","doctor_qualifications","institution_memberships","research_projects","research_project_members","consent_records","consent_authorities","care_relationships","care_events"}


def schema_plan(engine):
    inspector = inspect(engine)
    existing = set(inspector.get_table_names())
    missing = IDENTITY_TABLES - existing
    statements = []
    for table in Base.metadata.sorted_tables:
        if table.name in missing:
            statements.append(str(CreateTable(table).compile(dialect=engine.dialect)).strip())
            statements.extend(str(CreateIndex(index).compile(dialect=engine.dialect)) for index in sorted(table.indexes,key=lambda item:item.name))
    if "patients" in existing and "display_name" not in {column["name"] for column in inspector.get_columns("patients")}:
        statements.append("ALTER TABLE patients ADD COLUMN display_name TEXT NULL")
    return {"requires_explicit_review":True,"dialect":engine.dialect.name,"missing_tables":sorted(missing),"statements":statements,"legacy_authority_migration":"none; existing rows remain denied until separately verified","ledger":"independent store must be provisioned separately; never seed from business backup"}


def require_identity_schema(engine):
    plan = schema_plan(engine)
    if plan["statements"] or plan["missing_tables"]:
        raise RuntimeError("W02 identity schema requires an explicit reviewed migration; runtime startup cannot upgrade it. Use tools/plan-w02-schema.py with an explicit database.")
    from backend.app.services.authorization_ledger import _connect
    try:
        with _connect() as db:
            db.execute("SELECT ledger_key,revision,active FROM authorization_heads LIMIT 0")
    except Exception as exc:
        raise RuntimeError("An independently provisioned authorization ledger is required; runtime startup cannot restore or seed it.") from exc
