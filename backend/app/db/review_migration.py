"""Read-only W06 DDL plans. A runtime request never applies these statements."""
from fastapi import HTTPException
from sqlalchemy import inspect
from sqlalchemy.schema import CreateTable, CreateIndex
from sqlalchemy.dialects import mysql, sqlite
from backend.app.models.review import ReviewInputSnapshot, ReviewRecord, ReportVersion, ReviewClarification, ClarificationReply, CycleReview
from backend.app.db.care_migration import _missing_constraints

MODELS = (ReviewInputSnapshot, ReviewRecord, ReportVersion, ReviewClarification, ClarificationReply, CycleReview)


def review_schema_plan(bind, *, dialect_name=None):
    name = dialect_name or bind.dialect.name
    if name not in {'sqlite', 'mysql'}:
        raise ValueError('Review schema planning supports SQLite and MySQL only.')
    dialect = mysql.dialect() if name == 'mysql' else sqlite.dialect()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())
    statements, missing_columns, missing_constraints, incompatible_types, incompatible_nullability = [], {}, {}, [], []
    for model in MODELS:
        table = model.__table__
        if table.name not in tables:
            statements.append(str(CreateTable(table).compile(dialect=dialect)).strip())
            statements.extend(str(CreateIndex(index).compile(dialect=dialect)).strip() for index in sorted(table.indexes, key=lambda item: item.name))
            continue
        columns = {item['name']: item for item in inspector.get_columns(table.name)}
        if table.name == 'report_versions' and 'review_id' in columns and not columns['review_id']['nullable']:
            incompatible_nullability.append({'table': table.name, 'column': 'review_id', 'required_nullable': True})
        absent = sorted(set(table.c.keys()) - set(columns))
        if absent:
            missing_columns[table.name] = absent
        constraints = _missing_constraints(inspector, table)
        if constraints:
            missing_constraints[table.name] = constraints
        if bind.dialect.name == 'mysql':
            for field in ['snapshot', 'record_origin']:
                if field in columns and not isinstance(columns[field]['type'], mysql.LONGTEXT):
                    incompatible_types.append({'table': table.name, 'column': field, 'required': 'LONGTEXT'})
    return {'requires_explicit_review': True, 'dialect': name, 'statements': statements,
        'missing_columns': missing_columns, 'missing_constraints': missing_constraints, 'incompatible_types': incompatible_types,
        'incompatible_nullability': incompatible_nullability,
        'execution_policy': 'Read-only. Separate authorization, backup and temporary rehearsal required before real-store DDL.',
        'legacy_policy': 'No historical doctor, input snapshot, clinical approval or publication is invented.'}


def require_review_schema(bind):
    plan = review_schema_plan(bind)
    if plan['statements'] or plan['missing_columns'] or plan['missing_constraints'] or plan['incompatible_types'] or plan['incompatible_nullability']:
        raise HTTPException(503, {'code': 'review_storage_upgrade_required', 'message': '审核存储尚未完成经审查的结构准备。'})
