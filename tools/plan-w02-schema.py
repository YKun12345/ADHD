"""Produce a reviewable W02 schema plan for an explicitly selected database."""
import argparse
import json
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url",required=True)
    parser.add_argument("--authorization-ledger",required=True)
    parser.add_argument("--execute",action="store_true")
    parser.add_argument("--reviewed",action="store_true")
    args = parser.parse_args()
    if args.execute and not args.reviewed:
        parser.error("Execution requires an explicitly reviewed schema plan (--reviewed).")
    if not Path(args.authorization_ledger).is_absolute():
        parser.error("Authorization ledger must use an explicit absolute path outside business backups.")
    os.environ["APP_ENV"] = "migration"
    os.environ["DATABASE_URL"] = args.database_url
    os.environ["AUTHORIZATION_LEDGER_PATH"] = args.authorization_ledger
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
    from sqlalchemy import create_engine
    import backend.app.models
    from backend.app.db.identity_migration import schema_plan
    from backend.app.services.authorization_ledger import _path
    _path()
    engine = create_engine(args.database_url)
    try:
        plan = schema_plan(engine)
        print(json.dumps(plan,ensure_ascii=False,indent=2))
        if args.execute:
            with engine.begin() as db:
                for statement in plan["statements"]:
                    db.exec_driver_sql(statement)
            from backend.app.services.authorization_ledger import initialize_ledger
            initialize_ledger()
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
