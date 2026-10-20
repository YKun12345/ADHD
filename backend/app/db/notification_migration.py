"""Read-only notification DDL; runtime never applies a schema change."""
from sqlalchemy import inspect
from sqlalchemy.schema import CreateIndex, CreateTable
from backend.app.models.notification import WechatBinding, NotificationPermission, NotificationDelivery, NotificationCursor
from backend.app.db.care_migration import _missing_constraints

MODELS = (WechatBinding, NotificationPermission, NotificationDelivery, NotificationCursor)


def schema_plan(engine, *, dialect_name=None):
    selected_dialect = dialect_name or engine.dialect.name
    if engine.dialect.name not in {'sqlite', 'mysql'} or selected_dialect not in {'sqlite', 'mysql'}:
        raise RuntimeError('Notification schema planning supports SQLite/MySQL only.')
    from sqlalchemy.dialects import mysql, sqlite
    dialect = mysql.dialect() if selected_dialect == 'mysql' else sqlite.dialect()
    inspector = inspect(engine)
    existing = set(inspector.get_table_names())
    statements, missing_columns, missing_constraints = [], {}, {}
    for model in MODELS:
        table = model.__table__
        if table.name not in existing:
            statements.append(str(CreateTable(table).compile(dialect=dialect)).strip())
            statements.extend(str(CreateIndex(index).compile(dialect=dialect)).strip()
                for index in sorted(table.indexes, key=lambda row: row.name))
        else:
            columns = set(table.columns.keys()) - {column['name'] for column in inspector.get_columns(table.name)}
            if columns: missing_columns[table.name] = sorted(columns)
            constraints = _missing_constraints(inspector, table)
            if constraints: missing_constraints[table.name] = constraints
    return {'requires_explicit_review': True, 'dialect': selected_dialect, 'statements': statements, 'missing_columns': missing_columns,
        'missing_constraints': missing_constraints, 'execution_policy': 'Read-only plan. No real migration or seed is executed.'}


def require_notification_schema(engine):
    plan = schema_plan(engine)
    if plan['statements'] or plan['missing_columns'] or plan['missing_constraints']:
        raise RuntimeError('Notification schema requires a separately reviewed explicit migration; runtime never upgrades it.')
