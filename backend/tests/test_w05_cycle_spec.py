"""Independent W05 self-cycle specification probes; disposable stores only."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from threading import Barrier

import pytest
from fastapi import HTTPException
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, MetaData, create_engine, func, inspect, select

from backend.tests.test_assessment_sessions import actor


def _world(client, suffix):
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.models.care_cycle import CareCycle, DailyRecord
    from backend.app.services import care_cycle_service as service
    data, headers, pid = actor(client, suffix=suffix)
    return SessionLocal, User, CareCycle, DailyRecord, service, data["user"]["id"], headers, pid


def _create(world, *, key="spec-cycle", start="2026-10-01", end="2026-10-31"):
    factory, User, _, _, service, uid, _, pid = world
    with factory() as db:
        result = service.create_cycle(db, db.get(User, uid), {"patient_id":pid,
            "client_cycle_id":key,"start_date":start,"end_date":end})
        db.commit()
        return result


def _body(world, cid, key="spec-daily", day="2026-10-15", revision=0):
    return {"patient_id":world[-1],"cycle_id":cid,"client_submission_id":key,
        "record_date":day,"expected_revision":revision,"recorded_at":None,
        "content":{"focus_minutes":0,"is_medication":False,"note":"合成规范审查"}}


def test_shanghai_midnight_due_dates_and_backfill_follow_server_calendar(client, monkeypatch):
    world = _world(client,"spec-midnight")
    factory, User, _, _, service, uid, _, _ = world

    class DatetimeType(type):
        def __instancecheck__(cls, value):
            # SQLite reloads built-in datetime values; freezing now must not
            # change the service's datetime/date serialization branches.
            return isinstance(value, datetime)

    class Clock(datetime, metaclass=DatetimeType):
        current = datetime(2026,10,15,15,59,59,tzinfo=timezone.utc)

        @classmethod
        def now(cls, tz=None):
            return cls.current.astimezone(tz) if tz is not None else cls.current.replace(tzinfo=None)

    monkeypatch.setattr(service,"datetime",Clock)
    cid = _create(world,start="2026-10-15",end="2026-10-16")["id"]
    with factory() as db:
        before = service.get_cycle(db,db.get(User,uid),cid)
        assert before["summary"]["due_count"] == 1
        assert before["summary"]["missing_dates"] == ["2026-10-15"]
    with factory() as db, pytest.raises(HTTPException) as error:
        service.submit_daily_record(db,db.get(User,uid),_body(world,cid,day="2026-10-16"))
    assert error.value.status_code == 422
    Clock.current += timedelta(seconds=1)
    with factory() as db:
        current, _ = service.submit_daily_record(db,db.get(User,uid),_body(world,cid,day="2026-10-16"))
        db.commit()
    assert current["is_backfill"] is False and current["recorded_at"] is None
    with factory() as db:
        earlier, _ = service.submit_daily_record(db,db.get(User,uid),_body(world,cid,key="spec-yesterday"))
        db.commit()
    assert earlier["is_backfill"] is True
    with factory() as db:
        after = service.get_cycle(db,db.get(User,uid),cid)
        assert after["as_of_date"] == "2026-10-16"
        assert after["summary"]["due_count"] == after["summary"]["completed_count"] == 2
        assert after["summary"]["missing_dates"] == []
        assert after["summary"]["coverage"] == 1


def test_real_parallel_revision_cas_has_one_original_and_one_conflict(client):
    world = _world(client,"spec-parallel")
    factory, User, _, DailyRecord, service, uid, _, _ = world
    today = datetime.now(timezone.utc).astimezone(__import__('zoneinfo').ZoneInfo("Asia/Shanghai")).date().isoformat()
    cid = _create(world,start=today,end=today)["id"]
    start = Barrier(2)

    def submit(key):
        with factory() as db:
            user = db.get(User,uid)
            start.wait(timeout=10)
            try:
                ack, created = service.submit_daily_record(db,user,_body(world,cid,key=key,day=today))
                db.commit()
                return 201,ack["revision"],created
            except HTTPException as exc:
                db.rollback()
                return exc.status_code,None,False

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit,["parallel-a","parallel-b"]))
    assert sorted(result[0] for result in results) == [201,409],results
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(DailyRecord)) == 1
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "daily_record_submitted")) == 1
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog).where(SecurityAuditLog.action == "daily_record_submitted")) == 1


def test_http_commit_failure_rolls_back_daily_fact_event_and_critical_audit(client, monkeypatch):
    world = _world(client,"spec-rollback")
    factory, _, _, DailyRecord, service, _, headers, _ = world
    today = datetime.now(timezone.utc).astimezone(__import__('zoneinfo').ZoneInfo("Asia/Shanghai")).date().isoformat()
    cid = _create(world,start=today,end=today)["id"]
    original = service._audit

    def fail_after_audit(db,user,patient_id,action,**detail):
        original(db,user,patient_id,action,**detail)
        if action == "daily_record_submitted":
            from sqlalchemy import event
            def fail(*args):
                raise RuntimeError("synthetic commit boundary failure")
            event.listen(db,"before_commit",fail,once=True)

    monkeypatch.setattr(service,"_audit",fail_after_audit)
    response = client.post("/api/v1/care/daily-records",headers=headers,json=_body(world,cid,day=today))
    assert response.status_code == 503,response.text
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    with factory() as db:
        assert db.scalar(select(func.count()).select_from(DailyRecord)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "daily_record_submitted")) == 0
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog).where(SecurityAuditLog.action == "daily_record_submitted")) == 0


def test_orm_cannot_rewrite_a_committed_original_or_cycle_dates(client):
    world = _world(client,"spec-immutable")
    factory, User, CareCycle, DailyRecord, service, uid, _, _ = world
    today = datetime.now(timezone.utc).astimezone(__import__('zoneinfo').ZoneInfo("Asia/Shanghai")).date().isoformat()
    cid = _create(world,start=today,end=today)["id"]
    with factory() as db:
        ack,_ = service.submit_daily_record(db,db.get(User,uid),_body(world,cid,day=today))
        db.commit()
    for model,identifier,field,value in [(DailyRecord,ack["record_id"],"recorded_at",datetime(2000,1,1,tzinfo=timezone.utc)),
            (CareCycle,cid,"end_date",date(2090,1,1))]:
        with factory() as db:
            setattr(db.get(model,identifier),field,value)
            with pytest.raises(ValueError,match="immutable"):
                db.commit()
            db.rollback()
    with factory() as db:
        assert service.get_daily_record(db,db.get(User,uid),ack["client_submission_id"]) == ack


@pytest.mark.parametrize("table_name,missing_kind",[("care_cycles","check"),("daily_records","foreign_key")])
def test_partial_cycle_schema_with_missing_semantic_constraint_fails_closed(client,tmp_path,table_name,missing_kind):
    from backend.app.db.base import Base
    from backend.app.db.care_migration import require_care_schema, schema_plan
    copied = MetaData()
    for table in Base.metadata.sorted_tables:
        table.to_metadata(copied)
    target = copied.tables[table_name]
    kind = CheckConstraint if missing_kind == "check" else ForeignKeyConstraint
    removed = [constraint for constraint in target.constraints if isinstance(constraint,kind)]
    assert removed
    for constraint in removed:
        target.constraints.remove(constraint)
    engine = create_engine(f"sqlite:///{(tmp_path/(table_name+'-partial.db')).as_posix()}")
    try:
        copied.create_all(engine)
        inspector = inspect(engine)
        assert (inspector.get_check_constraints(table_name) if missing_kind == "check" else inspector.get_foreign_keys(table_name)) == []
        plan = schema_plan(engine)
        assert not plan["statements"] and not plan["missing_columns"]
        with pytest.raises(RuntimeError,match="explicit"):
            require_care_schema(engine)
    finally:
        engine.dispose()
