"""Print a W04/W05 schema plan for an explicitly selected database, without writes."""
import argparse
import json
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url",required=True)
    args = parser.parse_args()
    os.environ["APP_ENV"] = "migration"
    os.environ["DATABASE_URL"] = args.database_url
    os.environ["DEEPSEEK_API_KEY"] = ""
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
    from sqlalchemy import create_engine
    import backend.app.models
    from backend.app.db.submission_migration import schema_plan
    engine = create_engine(args.database_url)
    try:
        print(json.dumps(schema_plan(engine),ensure_ascii=False,indent=2))
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
