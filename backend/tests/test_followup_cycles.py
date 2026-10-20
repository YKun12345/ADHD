"""Real temporary DB contracts for fixed-date, immutable self care cycles."""
from datetime import date, datetime, timedelta, timezone
import importlib

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text

from backend.tests.test_assessment_sessions import actor


def test_cycle_capability_exists_before_routes_are_connected():
    assert importlib.util.find_spec("backend.app.models.care_cycle") is not None, "W05 real-date cycle model is not implemented"


@pytest.fixture
def world(client):
    # client reloads backend.app between tests; register the matching fresh Base.
    from backend.app.db.session import SessionLocal, engine
    from backend.app.db.base import Base
    model = importlib.import_module("backend.app.models.care_cycle")
    schema = importlib.import_module("backend.app.schemas.care_cycle")
    service = importlib.import_module("backend.app.services.care_cycle_service")
    Base.metadata.create_all(engine)
    return client, SessionLocal, model, schema, service


def setup(world, *, child=False, suffix="cycle"):
    client, factory, model, schema, service = world
    data, headers, pid = actor(client, child=child, suffix=suffix)
    from backend.app.models.user import User
    return data["user"]["id"], headers, pid, User


def cycle(world, uid, pid, User, start=None, end=None, key="cycle-one"):
    _, factory, _, schema, service = world
    start = start or date.today() - timedelta(days=13)
    with factory() as db:
        result = service.create_cycle(db, db.get(User, uid), schema.CareCycleCreate(
            patient_id=pid, client_cycle_id=key, start_date=start, end_date=end or start+timedelta(days=13)))
        db.commit()
        return result


def body(world, pid, cid, *, day=None, key="daily-one", revision=0, **extra):
    return world[3].DailyRecordCreate(patient_id=pid, cycle_id=cid,
        record_date=day or date.today(), client_submission_id=key,
        expected_revision=revision, content={"focus_minutes":0,"note":"真实自报"}, **extra)


def save(world, uid, User, payload):
    with world[1]() as db:
        result = world[4].submit_daily_record(db, db.get(User,uid), payload)
        db.commit()
        return result


def test_two_real_fourteen_day_cycles_missing_backfill_and_revisions(world):
    uid, _, pid, User = setup(world)
    first = cycle(world,uid,pid,User,start=date.today()-timedelta(days=27),key="first")
    second = cycle(world,uid,pid,User,key="second")
    assert first["id"] != second["id"] and second["responsible_doctor_id"] is None
    original = body(world,pid,first["id"],day=date.today()-timedelta(days=15))
    ack, created = save(world,uid,User,original)
    assert created and ack["revision"] == 1 and ack["recorded_at"] is None
    assert ack["submission_status"] == "committed"
    assert ack["recorded_at_status"] == "unknown" and ack["is_backfill"] is True
    revised = original.model_copy(update={"client_submission_id":"revision-two","expected_revision":1,
        "content":world[3].DailyRecordContent(focus_minutes=25)})
    assert save(world,uid,User,revised)[0]["revision"] == 2
    save(world,uid,User,body(world,pid,second["id"],key="second-original"))
    with world[1]() as db:
        summary = world[4].get_cycle(db,db.get(User,uid),first["id"])
        assert summary["summary"]["completed_count"] == 1
        assert len(summary["summary"]["missing_dates"]) == 13
        assert summary["records"][0]["content"]["focus_minutes"] == 25
        history = world[4].daily_history(db,db.get(User,uid),first["id"],original.record_date)
        assert [r["revision"] for r in history["items"]] == [1,2]
        assert history["items"][0]["content"]["focus_minutes"] == 0
        assert db.scalar(select(func.count()).select_from(world[2].DailyRecord)) == 3


def test_ack_exact_retry_conflict_global_actor_and_stale_revision(world):
    uid, _, pid, User = setup(world)
    cid = cycle(world,uid,pid,User)["id"]
    payload = body(world,pid,cid)
    ack,_ = save(world,uid,User,payload)
    retry,created = save(world,uid,User,payload)
    assert not created and retry == ack
    for changed in (payload.model_copy(update={"expected_revision":1}),
        payload.model_copy(update={"content":world[3].DailyRecordContent(note="different")})):
        with pytest.raises(HTTPException) as error:
            save(world,uid,User,changed)
        assert error.value.status_code == 409
    stranger, _, other_pid, _ = setup(world,suffix="stranger")
    other_cycle = cycle(world,stranger,other_pid,User,key="other-cycle")["id"]
    with pytest.raises(HTTPException) as error:
        save(world,stranger,User,body(world,other_pid,other_cycle))
    assert error.value.status_code == 409
    with pytest.raises(HTTPException) as error:
        save(world,uid,User,body(world,pid,cid,key="stale"))
    assert error.value.status_code == 409


def test_future_cycle_has_zero_due_dates_future_and_outside_records_rejected(world):
    uid, _, pid, User = setup(world)
    future = cycle(world,uid,pid,User,start=date.today()+timedelta(days=1))
    with world[1]() as db:
        read = world[4].get_cycle(db,db.get(User,uid),future["id"])
        assert read["summary"]["due_count"] == 0 and read["summary"]["coverage"] is None
    for day in (date.today(),date.today()+timedelta(days=1)):
        with pytest.raises(HTTPException) as error:
            save(world,uid,User,body(world,pid,future["id"],day=day))
        assert error.value.status_code == 422


def test_basic_withdrawal_history_survives_but_retry_and_newgrant_cannot_borrow(world):
    uid, headers, pid, User = setup(world)
    cid = cycle(world,uid,pid,User)["id"]
    payload = body(world,pid,cid)
    ack,_ = save(world,uid,User,payload)
    client = world[0]
    basic = next(r for r in client.get("/api/v1/patient/consents",headers=headers).json()["items"] if r["purpose"] == "basic_use")
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=headers,json={"expected_revision":basic["revision"]}).status_code == 200
    with pytest.raises(HTTPException) as error:
        save(world,uid,User,payload)
    assert error.value.status_code == 403
    with world[1]() as db:
        history = world[4].get_cycle(db,db.get(User,uid),cid)
        assert history["records"][0]["record_id"] == ack["record_id"]
        assert history["processing_status"] == "suspended" and history["allowed_actions"] == []
        assert history["suspension_reason"] == "original_authorization_unavailable"
        assert db.info["requires_basic_use"] is False
        assert all(receipt[3] != "processing" for receipt in db.info["authorization_receipts"])
    response = client.post("/api/v1/patient/consents",headers=headers,json={"patient_id":pid,"purpose":"basic_use","scope":basic["scope"],"terms_version":"W02-1"})
    assert response.status_code == 201,response.text
    with pytest.raises(HTTPException) as error:
        save(world,uid,User,payload)
    assert error.value.status_code == 409
    with world[1]() as db:
        user = db.get(User,uid)
        read = world[4].get_cycle(db,user,cid)
        assert read["processing_status"] == "suspended"
        assert read["suspension_reason"] == "original_authorization_replaced"
        assert db.info["requires_basic_use"] is False
        listing = world[4].list_cycles(db,user,pid)
        assert listing["as_of_date"] == date.today().isoformat()
        assert listing["calendar_timezone"] == "Asia/Shanghai"
        assert listing["items"][0]["allowed_actions"] == []
    with pytest.raises(HTTPException) as error:
        save(world,uid,User,body(world,pid,cid,key="newgrant"))
    assert error.value.status_code == 409
    # A genuinely new self cycle is an explicit new grant context.
    fresh = cycle(world,uid,pid,User,key="fresh-authority")
    assert save(world,uid,User,body(world,pid,fresh["id"],key="fresh-daily"))[1]
    with world[1]() as db:
        read = world[4].get_cycle(db,db.get(User,uid),fresh["id"])
        assert read["processing_status"] == "active" and read["allowed_actions"] == ["create_daily"]


def test_verified_guardian_actor_is_frozen_and_revocation_blocks_history(world):
    uid, headers, pid, User = setup(world,child=True)
    cid = cycle(world,uid,pid,User)["id"]
    ack,_ = save(world,uid,User,body(world,pid,cid))
    assert ack["actor_user_id"] == uid and ack["actor_identity_basis"].startswith("guardian:")
    relation = world[0].get("/api/v1/identity/context",headers=headers).json()["guardian_relationships"][0]
    from backend.app.models.identity import GuardianRelationship
    from backend.app.services import authorization_ledger as ledger
    with world[1]() as db:
        row = db.get(GuardianRelationship,relation["id"])
        ledger.deny(row)
        row.status = "revoked"
        db.commit()
    with world[1]() as db, pytest.raises(HTTPException) as error:
        world[4].get_cycle(db,db.get(User,uid),cid)
    assert error.value.status_code == 403


@pytest.mark.parametrize("mutation",["revision=9","content='not-authenticated'","authorization_snapshot='[]'","recorded_at='2000-01-01 00:00:00'"])
def test_raw_context_and_cipher_tamper_fail_closed(world,mutation):
    uid, _, pid, User = setup(world)
    cid = cycle(world,uid,pid,User)["id"]
    ack,_ = save(world,uid,User,body(world,pid,cid))
    from backend.app.core.record_envelope import RecordIntegrityError
    with world[1]() as db:
        raw = db.execute(text("SELECT content FROM daily_records WHERE id=:id"),{"id":ack["record_id"]}).scalar_one()
        assert raw.startswith("aesgcm:v2:") and "真实自报" not in raw
        db.execute(text(f"UPDATE daily_records SET {mutation} WHERE id=:id"),{"id":ack["record_id"]})
        db.commit()
    with world[1]() as db, pytest.raises(RecordIntegrityError):
        world[4].get_cycle(db,db.get(User,uid),cid)


def test_caller_rollback_removes_record_event_and_audit(world):
    uid, _, pid, User = setup(world)
    cid = cycle(world,uid,pid,User)["id"]
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    with world[1]() as db:
        before_audit = db.scalar(select(func.count()).select_from(SecurityAuditLog))
    with world[1]() as db:
        ack,_ = world[4].submit_daily_record(db,db.get(User,uid),body(world,pid,cid))
        assert ack["record_id"]
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog)) == before_audit+1
        db.rollback()
    with world[1]() as db:
        assert db.scalar(select(func.count()).select_from(world[2].DailyRecord)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "daily_record_submitted")) == 0
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog)) == before_audit


def test_validation_bounds_unknown_time_and_professional_block(world):
    uid, _, pid, User = setup(world)
    schema = world[3]
    from pydantic import ValidationError
    for kwargs in ({"end_date":date.today()-timedelta(days=1)}, {"end_date":date.today()+timedelta(days=366)}):
        with pytest.raises(ValidationError):
            schema.CareCycleCreate(patient_id=pid,client_cycle_id="invalid",start_date=date.today(),**kwargs)
    with world[1]() as db, pytest.raises(HTTPException) as error:
        world[4].create_cycle(db,db.get(User,uid),schema.CareCycleCreate(patient_id=pid,client_cycle_id="professional",start_date=date.today(),end_date=date.today(),cycle_type="professional"))
    assert error.value.status_code == 409
    cid = cycle(world,uid,pid,User)["id"]
    with pytest.raises(ValidationError):
        body(world,pid,cid,recorded_at=datetime.now())
    with pytest.raises(HTTPException) as error:
        save(world,uid,User,body(world,pid,cid,recorded_at=datetime.now(timezone.utc)+timedelta(days=1)))
    assert error.value.status_code == 422


def test_original_ack_lookup_critical_audit_and_legacy_are_separate(world,monkeypatch):
    uid, _, pid, User = setup(world)
    cid = cycle(world,uid,pid,User)["id"]
    aware_time = datetime.now(timezone.utc)-timedelta(hours=2)
    payload = body(world,pid,cid,recorded_at=aware_time)
    ack,_ = save(world,uid,User,payload)
    with world[1]() as db:
        assert world[4].get_daily_record(db,db.get(User,uid),payload.client_submission_id) == ack
        # A real legacy row with created_at does not become a dated daily record.
        from backend.app.models.tracking_log import TrackingLog
        db.add(TrackingLog(patient_id=pid,day_index=2,focus_minutes=999))
        db.commit()
    with world[1]() as db:
        assert world[4].get_cycle(db,db.get(User,uid),cid)["summary"]["completed_count"] == 1
    from backend.app.services import security_service
    def fail(*args,**kwargs):
        raise RuntimeError("synthetic critical audit unavailable")
    monkeypatch.setattr(security_service,"_append_audit_log",fail)
    with world[1]() as db, pytest.raises(HTTPException) as error:
        world[4].get_cycle(db,db.get(User,uid),cid)
    assert error.value.status_code == 503
    with pytest.raises(HTTPException) as error:
        save(world,uid,User,body(world,pid,cid,key="audit-fails",revision=1))
    assert error.value.status_code == 503
    with world[1]() as db:
        assert db.scalar(select(func.count()).select_from(world[2].DailyRecord)) == 1


def test_cycle_create_idempotence_plain_metadata_tamper_and_wrong_patient(world):
    uid, _, pid, User = setup(world)
    original = cycle(world,uid,pid,User)
    assert cycle(world,uid,pid,User) == original
    with pytest.raises(HTTPException) as error:
        cycle(world,uid,pid,User,start=date.today()-timedelta(days=12))
    assert error.value.status_code == 409
    other_uid, _, other_pid, _ = setup(world,suffix="other")
    other = cycle(world,other_uid,other_pid,User,key="other")
    with pytest.raises(HTTPException) as error:
        save(world,uid,User,body(world,pid,other["id"],key="wrong-patient"))
    assert error.value.status_code == 409
    with world[1]() as db:
        db.execute(text("UPDATE care_cycles SET end_date='2090-01-01' WHERE id=:id"),{"id":original["id"]})
        db.commit()
    from backend.app.core.record_envelope import RecordIntegrityError
    with world[1]() as db, pytest.raises(RecordIntegrityError):
        world[4].get_cycle(db,db.get(User,uid),original["id"])
