"""Read-only schema plan for the immutable image reports and model registry."""
from sqlalchemy import inspect
from sqlalchemy.schema import CreateTable,CreateColumn,CreateIndex
from sqlalchemy.dialects import mysql,sqlite


def schema_plan(engine,*,dialect_name=None):
    from backend.app.models.imaging_report import ImagingReportVersion
    from backend.app.models.model_registry import ModelVersion,ModelRegistry,ModelRegistryAction
    name=dialect_name or engine.dialect.name
    if name not in {'sqlite','mysql'}:raise ValueError('Only SQLite/MySQL schema planning is supported.')
    dialect=mysql.dialect() if name=='mysql' else sqlite.dialect()
    inspector=inspect(engine);tables=set(inspector.get_table_names());statements=[];missing={}
    # Versions precede the pointer and action foreign keys.
    for model in (ModelVersion,ModelRegistry,ModelRegistryAction,ImagingReportVersion):
        table=model.__table__
        if table.name not in tables:
            missing[table.name]=list(table.c.keys())
            statements.append(str(CreateTable(table).compile(dialect=dialect)).strip())
            statements.extend(str(CreateIndex(index).compile(dialect=dialect)).strip() for index in sorted(table.indexes,key=lambda item:item.name))
        else:
            present={column['name'] for column in inspector.get_columns(table.name)}
            for column in table.c:
                if column.name not in present:
                    missing.setdefault(table.name,[]).append(column.name)
                    statements.append('ALTER TABLE '+table.name+' ADD COLUMN '+str(CreateColumn(column).compile(dialect=dialect)))
    return {'dialect':name,'missing_columns':missing,'statements':statements,'requires_explicit_review':True,
            'execution_policy':'Read-only plan; no migration, backfill, model activation or ledger reset is performed.',
            'backfill_policy':'Historical predictions need explicit source review; GET does not invent report provenance.'}
