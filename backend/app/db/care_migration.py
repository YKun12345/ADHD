"""Reviewable W05 DDL only; never upgrades a selected real database at startup."""
import re
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, inspect
from sqlalchemy.schema import CreateColumn, CreateIndex, CreateTable
from backend.app.db.base import Base


def _check_expression(value):
    # Inspector dialects add identifier quotes, parentheses and keyword casing.
    # Preserve string literals so a different permitted value cannot pass.
    parts = re.split(r"('(?:''|[^'])*')",str(value))
    return ''.join(part if index % 2 else re.sub(r'[\s`"()]','',part).lower()
        for index,part in enumerate(parts))


def _missing_constraints(inspector,table):
    name = table.name
    unique_sets = {tuple(row.get("column_names") or []) for row in inspector.get_unique_constraints(name)}
    unique_sets.update(tuple(row.get("column_names") or []) for row in inspector.get_indexes(name) if row.get("unique"))
    check_sets = {_check_expression(row["sqltext"]) for row in inspector.get_check_constraints(name)}
    foreign_sets = {(tuple(row["constrained_columns"]),row["referred_table"],tuple(row["referred_columns"]))
        for row in inspector.get_foreign_keys(name)}
    missing = []
    for constraint in table.constraints:
        label = constraint.name or ','.join(column.name for column in constraint.columns)
        if isinstance(constraint,UniqueConstraint) and tuple(column.name for column in constraint.columns) not in unique_sets:
            missing.append(label)
        if isinstance(constraint,CheckConstraint) and _check_expression(constraint.sqltext) not in check_sets:
            missing.append(label)
        if isinstance(constraint,ForeignKeyConstraint):
            expected = (tuple(column.name for column in constraint.columns),constraint.referred_table.name,
                tuple(element.column.name for element in constraint.elements))
            if expected not in foreign_sets:
                missing.append('foreign_key:'+label)
    if tuple(inspector.get_pk_constraint(name).get('constrained_columns') or []) != tuple(column.name for column in table.primary_key):
        missing.append('primary_key')
    return sorted(missing)


def schema_plan(engine):
    if engine.dialect.name not in {"sqlite","mysql"}:
        raise RuntimeError("W05 schema planning supports reviewed SQLite/MySQL dialects only.")
    inspector = inspect(engine)
    existing = set(inspector.get_table_names())
    statements = []
    missing_columns = {}
    missing_constraints = {}
    for name in ("care_event_deliveries","attention_items","attention_actions","service_coverage_versions","care_system_events","care_reconciliation_cursors","care_deadline_cursors","care_cycles","daily_records","shared_care_messages","shared_message_reads",
            "care_transfer_requests","care_transfer_decisions","care_transfer_work_items","care_transfer_work_actions","care_transfer_claims","care_transfer_maintenance_cursors"):
        table = Base.metadata.tables[name]
        if name not in existing:
            statements.append(str(CreateTable(table).compile(dialect=engine.dialect)).strip())
            statements.extend(str(CreateIndex(index).compile(dialect=engine.dialect)).strip()
                for index in sorted(table.indexes,key=lambda value:value.name))
        else:
            missing = sorted(set(table.columns.keys()) - {column["name"] for column in inspector.get_columns(name)})
            if missing:
                # Partial sensitive rows need a preservation/conversion plan;
                # adding placeholder proof or responsibility would invent it.
                missing_columns[name] = missing
            missing = _missing_constraints(inspector,table)
            if missing:
                missing_constraints[name] = missing
    for name in ("assessment_sessions","patient_tasks"):
        if name in existing and "suspension_reason" not in {column["name"] for column in inspector.get_columns(name)}:
            column = Base.metadata.tables[name].c.suspension_reason
            statements.append(f"ALTER TABLE {name} ADD COLUMN {CreateColumn(column).compile(dialect=engine.dialect)}")
    return {"requires_explicit_review":True,"dialect":engine.dialect.name,"statements":statements,
        "missing_columns":missing_columns,"missing_constraints":missing_constraints,
        "prerequisites":"Reviewed W02/W03/W04 schema and encrypted legacy conversion; no identity or clinical approval is seeded.",
        "execution_policy":"Real migration requires separate authorization, backup, rehearsal and rollback review; runtime never executes this plan.",
        "legacy_policy":"No original dates, physician responsibility or authorization is invented for legacy records."}


def require_care_schema(engine):
    plan = schema_plan(engine)
    if plan["statements"] or plan["missing_columns"] or plan["missing_constraints"]:
        raise RuntimeError("W05 care schema requires reviewed explicit migration; runtime does not upgrade it.")
