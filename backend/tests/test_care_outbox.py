"""Transactional outbox foundation; worker processing is a separate W05 gate."""
def test_outbox_has_one_canonical_event_table_and_durable_delivery(client):
    from sqlalchemy import inspect
    from backend.app.db.session import engine
    inspector = inspect(engine)
    assert "care_event_deliveries" in inspector.get_table_names()
    assert "dedupe_key" in {column["name"] for column in inspector.get_columns("care_events")}
    assert any(row.get("column_names") == ["event_id","consumer"] for row in inspector.get_unique_constraints("care_event_deliveries"))


# W05 engine tests use actual sessions and synthetic, file-backed databases.
from datetime import datetime, timedelta, timezone
from functools import partial
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import os
import subprocess
import sys

import pytest


@pytest.fixture
def outbox_store(tmp_path):
    from sqlalchemy import create_engine
    from backend.app.db.base import Base
    from backend.app.db.session import SessionLocal
    from backend.app import models
    engine = create_engine(f"sqlite:///{(tmp_path / 'outbox.db').as_posix()}",
        connect_args={"check_same_thread": False, "timeout": 15})
    Base.metadata.create_all(engine)
    factory = partial(SessionLocal, bind=engine)
    with factory() as db:
        user = models.User(email="synthetic-outbox@example.invalid", full_name="Synthetic",
            password_hash="not-a-password", role=models.UserRole.PATIENT)
        db.add(user)
        db.flush()
        patient = models.Patient(user_id=user.id, patient_type=models.PatientType.ADULT)
        db.add(patient)
        db.flush()
        row = models.CareEvent(patient_id=patient.id, actor_user_id=user.id,
            actor_identity_basis="synthetic-test", event_type="source_committed",
            aggregate_type="synthetic", aggregate_id=1, revision=1,
            payload={"object_id": 1}, dedupe_key="synthetic-source")
        db.add(row)
        db.flush()
        event_id = row.event_id
        db.add(models.CareEventDelivery(event_id=event_id, consumer="derive"))
        db.commit()
    yield factory, event_id, engine
    engine.dispose()


def derived_output(db, event, now):
    """A real encrypted care fact with a durable business unique key."""
    from sqlalchemy import select
    from backend.app.models.event import CareEvent
    key = f"derive:{event.event_id}"
    if db.scalar(select(CareEvent.id).where(CareEvent.dedupe_key == key)) is None:
        db.add(CareEvent(patient_id=event.patient_id, actor_user_id=event.actor_user_id,
            actor_identity_basis="synthetic-test", event_type="synthetic_derived",
            aggregate_type="synthetic", aggregate_id=event.aggregate_id, revision=1,
            payload={"source_event_id": event.event_id}, dedupe_key=key))
        db.flush()


def snapshot(factory, event_id):
    from sqlalchemy import select, func
    from backend.app.models.event import CareEvent, CareEventDelivery
    from backend.app.models.security import SecurityAuditLog
    with factory() as db:
        delivery = db.scalar(select(CareEventDelivery).where(CareEventDelivery.event_id == event_id))
        source = db.scalar(select(CareEvent).where(CareEvent.event_id == event_id))
        return {"status": delivery.status, "token": delivery.lease_token,
            "attempts": delivery.attempts, "retry_at": delivery.next_attempt_at,
            "error": delivery.last_error, "completed": delivery.completed_at,
            "published": source.published_at,
            "source": db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_id == event_id)),
            "outputs": db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "synthetic_derived")),
            "audits": db.scalar(select(func.count()).select_from(SecurityAuditLog))}


NOW = datetime(2026, 10, 15, tzinfo=timezone.utc)


def test_success_ack_output_and_critical_audit_commit_together(outbox_store):
    from backend.app.workers.care_worker import claim_next, process_claim, run_once
    factory, event_id, _ = outbox_store
    claim = claim_next(factory, {"derive": derived_output}, now=NOW)
    assert claim.event_id == event_id
    with pytest.raises((AttributeError, TypeError)):
        claim.lease_token = "replacement"
    assert process_claim(factory, claim, {"derive": derived_output}, clock=lambda: NOW)
    state = snapshot(factory, event_id)
    assert state["status"] == "succeeded"
    assert state["outputs"] == state["audits"] == state["source"] == 1
    assert state["published"] is not None and state["completed"] is not None
    assert state["token"] is None
    assert not process_claim(factory, claim, {"derive": derived_output}, clock=lambda: NOW)
    assert not run_once(factory, {"derive": derived_output}, clock=lambda: NOW)
    assert snapshot(factory, event_id)["outputs"] == 1


def test_concurrent_workers_compete_for_one_claim(outbox_store):
    from backend.app.workers.care_worker import claim_next
    factory, event_id, _ = outbox_store
    barrier = Barrier(2)
    def compete():
        barrier.wait(timeout=5)
        return claim_next(factory, {"derive": derived_output}, now=NOW)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: compete(), range(2)))
    assert sum(claim is not None for claim in claims) == 1
    assert snapshot(factory, event_id)["attempts"] == 1


def test_claim_crash_expiry_and_stale_token_cannot_touch_new_claim(outbox_store):
    from backend.app.workers.care_worker import claim_next, process_claim
    factory, event_id, _ = outbox_store
    handlers = {"derive": derived_output}
    old = claim_next(factory, handlers, now=NOW, lease_seconds=1)
    assert claim_next(factory, handlers, now=NOW) is None
    new_time = NOW + timedelta(seconds=2)
    new = claim_next(factory, handlers, now=new_time)
    assert old.lease_token != new.lease_token
    def stale_failure(db, event, now):
        raise AssertionError("stale handler must never execute")
    assert not process_claim(factory, old, {"derive": stale_failure}, clock=lambda: new_time)
    assert snapshot(factory, event_id)["token"] == new.lease_token
    assert process_claim(factory, new, handlers, clock=lambda: new_time)
    assert snapshot(factory, event_id)["outputs"] == 1


def test_output_then_exception_rolls_back_audit_and_obeys_backoff(outbox_store):
    from backend.app.workers.care_worker import claim_next, process_claim
    from backend.app.services.security_service import _append_audit_log
    factory, event_id, _ = outbox_store
    def fail_after_output(db, event, now):
        derived_output(db, event, now)
        _append_audit_log(db, action="synthetic_before_failure", status="success",
            message="synthetic", patient_id=event.patient_id, actor_user_id=event.actor_user_id)
        raise RuntimeError("sensitive-health-raw-text-must-not-persist")
    claim = claim_next(factory, {"derive": fail_after_output}, now=NOW)
    assert not process_claim(factory, claim, {"derive": fail_after_output}, clock=lambda: NOW)
    state = snapshot(factory, event_id)
    assert state["source"] == 1 and state["outputs"] == state["audits"] == 0
    assert state["status"] == "retry_failed" and state["error"] == "RuntimeError"
    assert state["published"] is None and state["retry_at"] is not None
    assert claim_next(factory, {"derive": derived_output}, now=NOW) is None
    retry_at = state["retry_at"].replace(tzinfo=timezone.utc)
    retry = claim_next(factory, {"derive": derived_output}, now=retry_at)
    assert process_claim(factory, retry, {"derive": derived_output}, clock=lambda: retry_at)
    assert snapshot(factory, event_id)["outputs"] == 1


def test_processing_beyond_lease_rolls_back_all_products(outbox_store):
    from backend.app.workers.care_worker import claim_next, process_claim
    factory, event_id, _ = outbox_store
    clock_value = [NOW]
    def slow(db, event, now):
        derived_output(db, event, now)
        clock_value[0] = NOW + timedelta(seconds=2)
    claim = claim_next(factory, {"derive": slow}, now=NOW, lease_seconds=1)
    assert not process_claim(factory, claim, {"derive": slow}, clock=lambda: clock_value[0])
    state = snapshot(factory, event_id)
    assert state["outputs"] == state["audits"] == 0 and state["source"] == 1
    assert state["published"] is None and state["status"] == "processing"


def test_critical_audit_failure_rolls_back_product(outbox_store, monkeypatch):
    from backend.app.workers.care_worker import claim_next, process_claim
    from backend.app.services import security_service
    factory, event_id, _ = outbox_store
    def fail(*args, **kwargs):
        raise OSError("synthetic audit storage failure")
    monkeypatch.setattr(security_service, "_append_audit_log", fail)
    claim = claim_next(factory, {"derive": derived_output}, now=NOW)
    assert not process_claim(factory, claim, {"derive": derived_output}, clock=lambda: NOW)
    state = snapshot(factory, event_id)
    assert state["outputs"] == state["audits"] == 0
    assert state["source"] == 1 and state["status"] == "retry_failed"


def test_unknown_consumer_is_never_claimed(outbox_store):
    from backend.app.workers.care_worker import claim_next
    factory, event_id, _ = outbox_store
    assert claim_next(factory, {"other": derived_output}, now=NOW) is None
    assert claim_next(factory, {}, now=NOW) is None
    assert snapshot(factory, event_id)["attempts"] == 0


def test_publication_waits_for_every_delivery(outbox_store):
    from backend.app.workers.care_worker import run_once
    from backend.app.models.event import CareEventDelivery
    factory, event_id, _ = outbox_store
    with factory() as db:
        db.add(CareEventDelivery(event_id=event_id, consumer="second"))
        db.commit()
    assert run_once(factory, {"derive": derived_output}, clock=lambda: NOW)
    assert snapshot(factory, event_id)["published"] is None
    assert run_once(factory, {"second": lambda db, event, now: None}, clock=lambda: NOW)
    assert snapshot(factory, event_id)["published"] is not None


def test_permanent_business_suspension_commits_without_publication(outbox_store):
    from backend.app.workers.care_worker import run_once, claim_next
    factory, event_id, _ = outbox_store
    def suspend(db, event, now):
        derived_output(db, event, now)
        return "suspended"
    assert run_once(factory, {"derive": suspend}, clock=lambda: NOW)
    state = snapshot(factory, event_id)
    assert state["status"] == "suspended" and state["completed"] is not None
    assert state["outputs"] == state["audits"] == 1
    assert state["published"] is None and state["token"] is None
    assert claim_next(factory, {"derive": suspend}, now=NOW + timedelta(days=1)) is None


def test_invalid_handler_result_rolls_back_product(outbox_store):
    from backend.app.workers.care_worker import run_once
    factory, event_id, _ = outbox_store
    def invalid(db, event, now):
        derived_output(db, event, now)
        return True
    assert not run_once(factory, {"derive": invalid}, clock=lambda: NOW)
    state = snapshot(factory, event_id)
    assert state["status"] == "retry_failed" and state["outputs"] == 0


def test_processing_rechecks_authenticated_actor_before_flush(outbox_store, monkeypatch):
    from sqlalchemy import update
    from backend.app.workers.care_worker import run_once
    from backend.app.db import session
    from backend.app.models.user import User
    factory, event_id, _ = outbox_store
    # Authority rechecks genuinely use a fresh session to the isolated store.
    monkeypatch.setattr(session, "SessionLocal", factory)
    with factory() as db:
        db.execute(update(User).values(is_active=False))
        db.commit()
    def authenticated(db, event, now):
        db.info["authenticated_actor_id"] = event.actor_user_id
        derived_output(db, event, now)
    assert not run_once(factory, {"derive": authenticated}, clock=lambda: NOW)
    state = snapshot(factory, event_id)
    assert state["outputs"] == state["audits"] == 0
    assert state["status"] == "retry_failed" and state["error"] == "HTTPException"


def test_processing_rechecks_authenticated_actor_at_commit(outbox_store, monkeypatch):
    from sqlalchemy import event as sa_event, update
    from backend.app.workers.care_worker import run_once
    from backend.app.db import session
    from backend.app.models.user import User
    from backend.app.models.event import CareEvent
    factory, event_id, _ = outbox_store
    monkeypatch.setattr(session, "SessionLocal", factory)
    with factory() as db:
        db.execute(update(User).values(is_active=False))
        db.commit()
    def authenticated_late(db, source, now):
        derived_output(db, source, now)
        def after_final_flush(session, context):
            # Introduce the original actor receipt after the final write, so
            # only before_commit can reject it. This is a local fault window.
            if source.published_at is not None:
                session.info["authenticated_actor_id"] = source.actor_user_id
        sa_event.listen(db, "after_flush_postexec", after_final_flush)
    assert not run_once(factory, {"derive": authenticated_late}, clock=lambda: NOW)
    state = snapshot(factory, event_id)
    assert state["outputs"] == state["audits"] == 0
    assert state["status"] == "retry_failed" and state["error"] == "HTTPException"


def test_commit_authority_check_cannot_outlive_lease(outbox_store, monkeypatch):
    from sqlalchemy import event as sa_event
    from backend.app.workers.care_worker import run_once
    from backend.app.db import session
    from backend.app.services import identity_access
    factory, event_id, _ = outbox_store
    monkeypatch.setattr(session, "SessionLocal", factory)
    clock_value = [NOW]
    original = identity_access.recheck_request_authority
    def authority_check(db):
        original(db)
        if db.info.get("synthetic_final_flush_finished"):
            clock_value[0] = NOW + timedelta(seconds=2)
    monkeypatch.setattr(identity_access, "recheck_request_authority", authority_check)
    def handler(db, source, now):
        db.info["authenticated_actor_id"] = source.actor_user_id
        derived_output(db, source, now)
        def after_final_flush(session, context):
            if source.published_at is not None:
                session.info["synthetic_final_flush_finished"] = True
        sa_event.listen(db, "after_flush_postexec", after_final_flush)
    assert not run_once(factory, {"derive": handler}, clock=lambda: clock_value[0], lease_seconds=1)
    state = snapshot(factory, event_id)
    assert state["outputs"] == state["audits"] == 0 and state["status"] == "processing"


def test_old_failure_after_new_worker_success_cannot_overwrite_it(outbox_store):
    from backend.app.workers.care_worker import claim_next, process_claim
    factory, event_id, _ = outbox_store
    def fail(db, event, now):
        derived_output(db, event, now)
        raise RuntimeError("synthetic old worker fault")
    old = claim_next(factory, {"derive": fail}, now=NOW, lease_seconds=1)
    calls = [0]
    def old_clock():
        calls[0] += 1
        if calls[0] == 1:
            return NOW
        # The callback transaction has rolled back, but its failure bookkeeping
        # has not started. A new worker now really claims and commits its output.
        at = NOW + timedelta(seconds=2)
        new = claim_next(factory, {"derive": derived_output}, now=at)
        assert new is not None
        assert process_claim(factory, new, {"derive": derived_output}, clock=lambda: at)
        return at
    assert not process_claim(factory, old, {"derive": fail}, clock=old_clock)
    state = snapshot(factory, event_id)
    assert state["status"] == "succeeded" and state["error"] is None
    assert state["outputs"] == state["audits"] == 1 and state["attempts"] == 2


def test_real_process_death_after_flushed_product_leaves_no_product(outbox_store, tmp_path):
    from backend.app.workers.care_worker import claim_next, process_claim
    factory, event_id, engine = outbox_store
    # The child receives only test stores/keys, never the development environment.
    env = {key: value for key, value in os.environ.items()
        if key in {"SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "COMSPEC", "PATHEXT"}}
    env.update(APP_ENV="test", DEEPSEEK_API_KEY="", DATABASE_URL=str(engine.url),
        AUTHORIZATION_LEDGER_PATH=str(tmp_path / "child-ledger.db"),
        DATA_ENCRYPTION_KEY="dGVzdC1rZXktMzItYnl0ZXMtaXNvbGF0ZWQtMDAwMDE=",
        SECRET_KEY="test-only-secret", SECURITY_MASTER_KEY_PATH=str(tmp_path / "child.key"),
        UPLOAD_ROOT=str(tmp_path / "uploads"), FINDVIZ_CACHE_ROOT=str(tmp_path / "findviz"))
    script = '''
import os
from datetime import datetime, timezone
from backend.app.db.session import SessionLocal
from backend.app.workers.care_worker import claim_next, process_claim
from backend.tests.test_care_outbox import derived_output
now = datetime(2026, 10, 15, tzinfo=timezone.utc)
def die(db, event, at):
    derived_output(db, event, at)
    os._exit(73)
handlers = {"derive": die}
claim = claim_next(SessionLocal, handlers, now=now, lease_seconds=1)
process_claim(SessionLocal, claim, handlers, clock=lambda: now)
raise AssertionError("child did not die at the intended window")
'''
    child = subprocess.run([sys.executable, "-c", script], env=env,
        capture_output=True, text=True, timeout=30)
    assert child.returncode == 73, child.stdout + child.stderr
    state = snapshot(factory, event_id)
    assert state["status"] == "processing" and state["attempts"] == 1
    assert state["outputs"] == state["audits"] == 0 and state["source"] == 1
    retry_time = NOW + timedelta(seconds=2)
    claim = claim_next(factory, {"derive": derived_output}, now=retry_time)
    assert process_claim(factory, claim, {"derive": derived_output}, clock=lambda: retry_time)
    state = snapshot(factory, event_id)
    assert state["outputs"] == state["audits"] == 1 and state["attempts"] == 2
