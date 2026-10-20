"""Read-only plan DDL; upgrading old cycle constraints requires explicit review."""
from fastapi import HTTPException
from sqlalchemy import inspect
from sqlalchemy.schema import CreateTable, CreateIndex
from sqlalchemy.dialects import mysql, sqlite
from backend.app.models.care_plan import CarePlan, PlanVersion, PlanTask, PlanAcknowledgement
from backend.app.models.care_cycle import CareCycle
from backend.app.db.care_migration import _missing_constraints

MODELS = (CarePlan, PlanVersion, PlanTask, PlanAcknowledgement)


def care_plan_schema_plan(bind, *, dialect_name=None):
    name = dialect_name or bind.dialect.name
    if name not in {'sqlite', 'mysql'}:
        raise ValueError('Plan schema planning supports SQLite and MySQL only.')
    dialect = mysql.dialect() if name == 'mysql' else sqlite.dialect()
    inspector = inspect(bind); tables = set(inspector.get_table_names())
    statements, missing_columns, missing_constraints, incompatible_types = [], {}, {}, []
    for model in MODELS:
        table = model.__table__
        if table.name not in tables:
            statements.append(str(CreateTable(table).compile(dialect=dialect)).strip())
            statements.extend(str(CreateIndex(index).compile(dialect=dialect)).strip() for index in sorted(table.indexes, key=lambda item: item.name))
            continue
        columns = {item['name']: item for item in inspector.get_columns(table.name)}
        absent = sorted(set(table.c.keys()) - set(columns))
        if absent:
            missing_columns[table.name] = absent
        missing = _missing_constraints(inspector, table)
        if missing:
            missing_constraints[table.name] = missing
        if bind.dialect.name == 'mysql':
            for field in model.record_fields.keys() | {'record_origin'}:
                if field in columns and not isinstance(columns[field]['type'], mysql.LONGTEXT):
                    incompatible_types.append({'table': table.name, 'column': field, 'required': 'LONGTEXT'})
    cycle = CareCycle.__table__
    if cycle.name not in tables:
        missing_constraints[cycle.name] = ['requires_reviewed_care_cycle_table']
    else:
        missing = _missing_constraints(inspector, cycle)
        if missing:
            missing_constraints[cycle.name] = missing
    return {'requires_explicit_review': True, 'dialect': name, 'statements': statements, 'missing_columns': missing_columns,
        'missing_constraints': missing_constraints, 'incompatible_types': incompatible_types,
        'care_cycle_target_ddl': str(CreateTable(cycle).compile(dialect=dialect)).strip(),
        'cycle_upgrade_policy': 'Review existing self rows, encrypted backups, dependent daily records and rollback before replacing the self-only constraint and adding actual plan FKs. No runtime ALTER or destructive rebuild.',
        'legacy_policy': 'No historical plan, doctor, date, receipt or execution is invented.', 'executed': False}


def require_care_plan_schema(bind):
    plan = care_plan_schema_plan(bind)
    if plan['statements'] or plan['missing_columns'] or plan['missing_constraints'] or plan['incompatible_types']:
        raise HTTPException(503, {'code': 'care_plan_storage_upgrade_required', 'message': '计划存储及真实周期约束尚未完成经审查的结构准备。'})
