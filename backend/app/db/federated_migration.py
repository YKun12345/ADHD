"""Idempotent read-only DDL planning; no production provisioning is implicit."""
from sqlalchemy import inspect
from sqlalchemy.schema import CreateTable,CreateIndex
from sqlalchemy.dialects import mysql,sqlite


def schema_plan(engine,*,dialect_name=None):
    from backend.app.services.federated_control_service import TABLES
    name=dialect_name or engine.dialect.name
    if name not in {'sqlite','mysql'}:raise ValueError('SQLite/MySQL only')
    dialect=mysql.dialect() if name=='mysql' else sqlite.dialect()
    inspector=inspect(engine);existing=set(inspector.get_table_names());statements=[];missing={}
    for model in TABLES:
        table=model.__table__
        if table.name in existing:
            absent=set(table.c.keys())-{column['name'] for column in inspector.get_columns(table.name)}
            if absent:missing[table.name]=sorted(absent)
            continue
        missing[table.name]=list(table.c.keys());statements.append(str(CreateTable(table).compile(dialect=dialect)).strip())
        statements.extend(str(CreateIndex(index).compile(dialect=dialect)).strip() for index in sorted(table.indexes,key=lambda item:item.name))
    return {'dialect':name,'missing_columns':missing,'statements':statements,'requires_explicit_review':True,
        'execution_policy':'Read-only; no real DDL, identity bootstrap, consent backfill or ledger reset.',
        'partial_schema_policy':'Existing incomplete tables require an explicit reviewed migration; they are never silently recreated.'}
