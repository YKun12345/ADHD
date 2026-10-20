"""Print a read-only W08 Agent schema plan for an explicitly selected existing store."""
import argparse
import json
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-url', required=True)
    parser.add_argument('--dialect', choices=['sqlite', 'mysql'])
    args = parser.parse_args()
    os.environ.update(APP_ENV='migration', DATABASE_URL=args.database_url, DEEPSEEK_API_KEY='')
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from sqlalchemy import create_engine
    from sqlalchemy.engine import make_url
    selected = make_url(args.database_url)
    creator = None
    if selected.get_backend_name() == 'sqlite':
        if not selected.database or selected.database == ':memory:' or not Path(selected.database).is_file():
            parser.error('An existing SQLite file is required; read-only planning never creates a database.')
        import sqlite3
        uri = Path(selected.database).resolve().as_uri() + '?mode=ro'
        creator = lambda: sqlite3.connect(uri, uri=True)
    import backend.app.models
    from backend.app.db.agent_migration import agent_schema_plan
    engine = create_engine(args.database_url, **({'creator': creator} if creator else {}))
    try:
        print(json.dumps(agent_schema_plan(engine, dialect_name=args.dialect), ensure_ascii=False, indent=2))
    finally:
        engine.dispose()


if __name__ == '__main__':
    main()
