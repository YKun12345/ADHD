"""Print an explicitly selected store's read-only W09 schema/conversion plan."""
import argparse
import json
import os
from pathlib import Path
import sys


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-url',required=True)
    parser.add_argument('--dialect',choices=['sqlite','mysql'])
    args=parser.parse_args()
    os.environ['APP_ENV']='migration'
    os.environ['DATABASE_URL']=args.database_url
    os.environ['DEEPSEEK_API_KEY']=''
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
    from sqlalchemy import create_engine
    from sqlalchemy.engine import make_url
    selected=make_url(args.database_url)
    creator=None
    if selected.get_backend_name() == 'sqlite':
        if not selected.database or selected.database == ':memory:' or not Path(selected.database).is_file():
            parser.error('Read-only planning requires an existing SQLite database file; no file is created.')
        import sqlite3
        uri=Path(selected.database).resolve().as_uri()+'?mode=ro'
        creator=lambda:sqlite3.connect(uri,uri=True)
    import backend.app.models
    from backend.app.db.imaging_migration import schema_plan
    from backend.app.db.model_registry_migration import schema_plan as report_registry_plan
    engine=create_engine(args.database_url,**({'creator':creator} if creator is not None else {}))
    try:
        plan=schema_plan(engine,dialect_name=args.dialect)
        plan['report_and_model_registry']=report_registry_plan(engine,dialect_name=args.dialect)
        print(json.dumps(plan,ensure_ascii=False,indent=2))
    finally:
        engine.dispose()


if __name__ == '__main__':
    main()
