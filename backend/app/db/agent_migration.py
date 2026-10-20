"""Read-only schema requirements for authenticated Agent actions, runs and drafts."""
from fastapi import HTTPException
from sqlalchemy import inspect
from sqlalchemy.schema import CreateTable, CreateIndex
from sqlalchemy.dialects import mysql, sqlite
from backend.app.models.agent import AgentAction, AgentRun, AIArtifact, ArtifactDecision
from backend.app.db.care_migration import _missing_constraints

MODELS = (AgentAction, AgentRun, AIArtifact, ArtifactDecision)


def agent_schema_plan(bind, *, dialect_name=None):
    name = dialect_name or bind.dialect.name
    if name not in {'sqlite', 'mysql'}:
        raise ValueError('Agent schema planning supports SQLite and MySQL only.')
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
        if absent: missing_columns[table.name] = absent
        missing = _missing_constraints(inspector, table)
        if missing: missing_constraints[table.name] = missing
        if bind.dialect.name == 'mysql':
            for field in model.record_fields.keys() | {'record_origin'}:
                if field in columns and not isinstance(columns[field]['type'], mysql.LONGTEXT):
                    incompatible_types.append({'table': table.name, 'column': field, 'required': 'LONGTEXT'})
    return {'requires_explicit_review': True, 'dialect': name, 'statements': statements, 'missing_columns': missing_columns,
        'missing_constraints': missing_constraints, 'incompatible_types': incompatible_types, 'executed': False,
        'execution_policy': 'Read-only. Real-store upgrade requires separate authorization, backup and isolated rehearsal.',
        'legacy_policy': 'No old private chat, professional approval, provider use or historical Agent action is invented.'}


def require_agent_schema(bind):
    result = agent_schema_plan(bind)
    if result['statements'] or result['missing_columns'] or result['missing_constraints'] or result['incompatible_types']:
        raise HTTPException(503, {'code': 'agent_storage_upgrade_required', 'message': '助手存储尚未完成经审查的结构准备。'})
