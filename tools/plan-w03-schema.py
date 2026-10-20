"""Produce a reviewable W03 schema plan for an explicitly selected store."""
import argparse
import json
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--reviewed", action="store_true")
    args = parser.parse_args()
    if args.execute and not args.reviewed:
        parser.error("Execution requires explicit review of this selected schema plan (--reviewed).")
    os.environ["APP_ENV"] = "migration"
    os.environ["DATABASE_URL"] = args.database_url
    os.environ["DEEPSEEK_API_KEY"] = ""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from sqlalchemy import create_engine
    import backend.app.models
    from backend.app.db.assessment_migration import schema_plan
    engine = create_engine(args.database_url)
    try:
        plan = schema_plan(engine)
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        if args.execute:
            if plan["missing_columns"]:
                parser.error("Existing partial W03 objects need a separate preservation/migration review; required performer/age metadata cannot be invented.")
            with engine.begin() as db:
                for statement in plan["statements"]:
                    db.exec_driver_sql(statement)
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
