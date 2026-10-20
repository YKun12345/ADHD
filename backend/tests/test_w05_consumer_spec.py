"""Independent W05 first-segment spec probes using disposable synthetic stores.

These tests exercise actual committed assessment evidence and production consumers.
They do not represent full W05 cycle/message/coverage/transfer acceptance.
"""
import pytest
from datetime import datetime, timezone
from sqlalchemy import create_engine, inspect, select

from backend.tests.test_assessment_consumers import complete_assessment, drain
from backend.tests.test_care_suspension import current_consent, withdraw
from backend.tests.test_submission_cognitive_evidence import cognitive_submission
from backend.tests.test_submission_context import scale_submission


@pytest.mark.parametrize("column", ["state_snapshot", "record_origin"])
def test_partial_attention_schema_must_fail_explicit_startup_guard(tmp_path, column):
    from backend.app import models
    from backend.app.db.base import Base
    from backend.app.db.care_migration import require_care_schema, schema_plan

    engine = create_engine(f"sqlite:///{(tmp_path/'partial-w05.db').as_posix()}")
    try:
        Base.metadata.create_all(engine)
        with engine.begin() as db:
            db.exec_driver_sql(f"ALTER TABLE attention_items DROP COLUMN {column}")
        before = {row["name"] for row in inspect(engine).get_columns("attention_items")}
        assert column not in before
        print({"missing_attention_column": column, "schema_plan": schema_plan(engine)})
        with pytest.raises(RuntimeError, match="explicit|reviewed"):
            require_care_schema(engine)
        assert {row["name"] for row in inspect(engine).get_columns("attention_items")} == before
    finally:
        engine.dispose()


def test_partial_outbox_schema_must_fail_joint_explicit_startup_guards(tmp_path):
    from backend.app import models
    from backend.app.db.base import Base
    from backend.app.db.identity_migration import require_identity_schema
    from backend.app.db.assessment_migration import require_assessment_schema
    from backend.app.db.submission_migration import require_submission_schema
    from backend.app.db.care_migration import require_care_schema
    from backend.app.services.authorization_ledger import initialize_ledger

    engine = create_engine(f"sqlite:///{(tmp_path/'partial-outbox.db').as_posix()}")
    try:
        initialize_ledger()
        Base.metadata.create_all(engine)
        with engine.begin() as db:
            db.exec_driver_sql("ALTER TABLE care_event_deliveries DROP COLUMN lease_token")
        before = {row["name"] for row in inspect(engine).get_columns("care_event_deliveries")}
        assert "lease_token" not in before
        # Execute the exact guard sequence used by non-test init_db, while all
        # runtime configuration stays APP_ENV=test and the store is disposable.
        with pytest.raises(RuntimeError, match="explicit|reviewed"):
            for guard in (require_identity_schema, require_assessment_schema,
                          require_submission_schema, require_care_schema):
                guard(engine)
                print({"missing_delivery_column": "lease_token", "guard_accepted": guard.__name__})
        assert {row["name"] for row in inspect(engine).get_columns("care_event_deliveries")} == before
    finally:
        engine.dispose()


def test_attention_audit_failure_withholds_actual_quality_rows(client, monkeypatch):
    owner, _, _, _, body = cognitive_submission(client, "flanker")
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    saved = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert saved.status_code == 201 and saved.json()["quality_status"] == "limited", saved.text
    assert drain() == 2
    url = f"/api/v1/care/patient/attention?patient_id={body['patient_id']}"
    assert len(client.get(url, headers=owner).json()["items"]) == 1
    from backend.app.services import security_service

    def fail(*args, **kwargs):
        raise OSError("synthetic audit failure; no health details")

    monkeypatch.setattr(security_service, "_append_audit_log", fail)
    response = client.get(url, headers=owner)
    assert response.status_code == 503, response.text
    assert body["submission_id"] not in response.text
    assert "execution_interrupted" not in response.text and "assessment_quality" not in response.text


def test_basic_invalidation_suspends_open_attention_after_self_history_closes(client):
    owner, _, session, _, _, scale = scale_submission(client, suffix="spec-closed-attention")
    pid = scale["patient_id"]
    assert client.post("/api/v1/care/submissions", headers=owner, json=scale).status_code == 201
    _, _, _, _, limited = cognitive_submission(client, "flanker", context=(owner, session, pid))
    limited["content"]["execution_metadata"]["interrupted_count"] = 1
    saved = client.post("/api/v1/care/submissions", headers=owner, json=limited)
    assert saved.status_code == 201 and saved.json()["quality_status"] == "limited", saved.text
    assert drain() == 3
    url = f"/api/v1/care/patient/attention?patient_id={pid}"
    prior_attention = client.get(url, headers=owner).json()["items"]
    assert len(prior_attention) == 1 and prior_attention[0]["status"] == "open"

    fresh = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    _, _, _, _, valid = cognitive_submission(client, "flanker", context=(owner, fresh, pid))
    valid["submission_id"] += "-valid-retest"
    saved = client.post("/api/v1/care/submissions", headers=owner, json=valid)
    assert saved.status_code == 201 and saved.json()["quality_status"] == "valid", saved.text
    for task in ("reaction", "stroop", "nback", "trail", "digit"):
        _, _, _, _, body = cognitive_submission(client, task, context=(owner, session, pid))
        saved = client.post("/api/v1/care/submissions", headers=owner, json=body)
        assert saved.status_code == 201, saved.text
    assert drain() == 7
    historical = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    assert historical["status"] == "closed_self"
    assert client.get(url, headers=owner).json()["items"][0]["status"] == "open"

    withdraw(client, owner, current_consent(client, owner, "basic_use"))
    assert drain() == 1
    retained = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert retained.status_code == 200 and retained.json() == historical, retained.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    from backend.app.models.event import CareEventDelivery

    with SessionLocal() as db:
        attention = db.get(AttentionItem, prior_attention[0]["id"])
        invalidation = db.scalar(select(CareEventDelivery).where(
            CareEventDelivery.consumer == "care_authority_invalidation"))
        print({"assessment_status": retained.json()["status"], "attention_status": attention.status,
               "attention_reason": attention.suspension_reason, "invalidation_ack": invalidation.status})
        assert attention.status == "suspended"
        assert attention.suspension_reason == "original_authority_invalid"


def test_doctor_attention_respects_original_owner_and_cannot_borrow_new_relationship(client):
    from backend.tests.w02_helpers import register, grant_synthetic_patient_authority
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship

    owner, clinician, session, _, _, scale = scale_submission(client, doctor=True, suffix="spec-owned")
    pid = scale["patient_id"]
    _, _, item, _, body = cognitive_submission(client, "flanker", context=(owner, session, pid))
    body["task_id"] = item["patient_task_id"]
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    saved = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert saved.status_code == 201 and saved.json()["quality_status"] == "limited", saved.text
    assert drain() == 2
    queue_url = "/api/v1/care/doctor/work_queue"
    own_queue = client.get(queue_url, headers=clinician)
    assert own_queue.status_code == 200 and len(own_queue.json()["items"]) == 1, own_queue.text
    attention_id = own_queue.json()["items"][0]["id"]

    stranger, stranger_headers = register(client, "spec-other-doctor@example.com", "researcher")
    grant_synthetic_patient_authority(pid, stranger["user"]["id"])
    assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=stranger_headers).status_code == 200
    for viewer in (clinician, stranger_headers):
        denied = client.get(f"/api/v1/care/patient/attention?patient_id={pid}", headers=viewer)
        assert denied.status_code == 403 and "items" not in denied.json(), denied.text
    other_queue = client.get(queue_url, headers=stranger_headers)
    assert other_queue.status_code == 200 and other_queue.json()["items"] == [], other_queue.text
    with SessionLocal() as db:
        relationship = db.scalar(select(CareRelationship).where(
            CareRelationship.patient_id == pid,
            CareRelationship.doctor_user_id == session["responsible_doctor_id"]))
        relationship_id, revision = relationship.id, relationship.revision
    revoked = client.post(f"/api/v1/care/relationships/{relationship_id}/revoke", headers=owner,
                          json={"expected_revision": revision})
    assert revoked.status_code == 200, revoked.text
    # These reads happen before any asynchronous invalidation consumer runs.
    immediate = client.get(queue_url, headers=clinician)
    assert immediate.status_code == 200 and immediate.json()["items"] == [], immediate.text
    grant_synthetic_patient_authority(pid, session["responsible_doctor_id"])
    regranted = client.get(queue_url, headers=clinician)
    assert regranted.status_code == 200 and regranted.json()["items"] == [], regranted.text


@pytest.mark.parametrize("doctor", [False, True])
def test_real_ready_products_and_ack_rollback_together_then_retry_once(client, monkeypatch, doctor):
    from backend.app.db.session import SessionLocal
    from backend.app.models.assessment import AssessmentSession
    from backend.app.models.attention import AttentionItem
    from backend.app.models.event import CareEvent, CareEventDelivery
    from backend.app.services import security_service
    from backend.app.services.care_consumers import consumer_handlers
    from backend.app.workers.care_worker import run_once

    _, _, session, _ = complete_assessment(client, doctor=doctor)
    original_audit = security_service._append_audit_log

    def fail_consumed(*args, **kwargs):
        if kwargs.get("action") == "care_event_consumed":
            raise OSError("synthetic final consumer audit failure")
        return original_audit(*args, **kwargs)

    monkeypatch.setattr(security_service, "_append_audit_log", fail_consumed)
    handlers = {"assessment_evidence_ready": consumer_handlers()["assessment_evidence_ready"]}
    now = datetime.now(timezone.utc)
    assert run_once(SessionLocal, handlers, clock=lambda: now) is False
    with SessionLocal() as db:
        actual = db.get(AssessmentSession, session["id"])
        delivery = db.scalar(select(CareEventDelivery).where(
            CareEventDelivery.consumer == "assessment_evidence_ready"))
        assert actual.status == "evidence_ready"
        assert db.scalars(select(AttentionItem)).all() == []
        assert db.scalars(select(CareEvent).where(CareEvent.event_type == "assessment_closed_self")).all() == []
        assert delivery.status == "retry_failed" and delivery.completed_at is None
        assert delivery.last_error == "OSError" and delivery.next_attempt_at is not None
        retry_at = delivery.next_attempt_at.replace(tzinfo=timezone.utc)
        version = actual.version
        print({"doctor": doctor, "failed_ready_status": actual.status,
               "failed_delivery_status": delivery.status, "failed_version": version})
    monkeypatch.setattr(security_service, "_append_audit_log", original_audit)
    assert run_once(SessionLocal, handlers, clock=lambda: retry_at) is True
    assert run_once(SessionLocal, handlers, clock=lambda: retry_at) is False
    with SessionLocal() as db:
        actual = db.get(AssessmentSession, session["id"])
        assert actual.status == ("under_review" if doctor else "closed_self")
        assert actual.version == version + 1
        assert len(db.scalars(select(AttentionItem)).all()) == int(doctor)
        assert len(db.scalars(select(CareEvent).where(CareEvent.event_type == "assessment_closed_self")).all()) == int(not doctor)


def test_actual_ready_consumer_rechecks_original_authority_before_commit(client, monkeypatch):
    from backend.app.db.session import SessionLocal
    from backend.app.models.assessment import AssessmentSession
    from backend.app.models.attention import AttentionItem
    from backend.app.models.consent import ConsentRecord
    from backend.app.models.event import CareEventDelivery
    from backend.app.models.security import SecurityAuditLog
    from backend.app.services import authorization_ledger, security_service
    from backend.app.services.care_consumers import consumer_handlers
    from backend.app.workers.care_worker import run_once

    owner, _, session, _ = complete_assessment(client, doctor=True)
    basic = current_consent(client, owner, "basic_use")
    original_audit = security_service._append_audit_log
    invalidated = []

    def deny_at_consumer_audit(db, **kwargs):
        # The real independent head can deny immediately even while the worker
        # holds the business write lock. This models revoke/commit concurrency.
        if kwargs.get("action") == "care_event_consumed" and not invalidated:
            with SessionLocal() as authority_db:
                original = authority_db.get(ConsentRecord, basic["id"])
                authorization_ledger.deny(original)
                assert authorization_ledger.matches(original) is False
                invalidated.append(original.ledger_key)
        return original_audit(db, **kwargs)

    monkeypatch.setattr(security_service, "_append_audit_log", deny_at_consumer_audit)
    handlers = {"assessment_evidence_ready": consumer_handlers()["assessment_evidence_ready"]}
    now = datetime.now(timezone.utc)
    assert run_once(SessionLocal, handlers, clock=lambda: now) is False
    assert len(invalidated) == 1
    with SessionLocal() as db:
        actual = db.get(AssessmentSession, session["id"])
        delivery = db.scalar(select(CareEventDelivery).where(
            CareEventDelivery.consumer == "assessment_evidence_ready"))
        assert actual.status == "evidence_ready"
        assert db.scalars(select(AttentionItem)).all() == []
        assert db.scalars(select(SecurityAuditLog).where(SecurityAuditLog.action == "care_event_consumed")).all() == []
        assert delivery.status == "retry_failed" and delivery.completed_at is None
        retry_at = delivery.next_attempt_at.replace(tzinfo=timezone.utc)
        print({"authority_denied_before_commit": True, "assessment_status": actual.status,
               "delivery_status": delivery.status, "error_type": delivery.last_error})
    monkeypatch.setattr(security_service, "_append_audit_log", original_audit)
    assert run_once(SessionLocal, handlers, clock=lambda: retry_at) is True
    with SessionLocal() as db:
        assert db.get(AssessmentSession, session["id"]).status == "suspended"
        assert db.scalars(select(AttentionItem)).all() == []
        delivery = db.scalar(select(CareEventDelivery).where(
            CareEventDelivery.consumer == "assessment_evidence_ready"))
        assert delivery.status == "suspended" and delivery.completed_at is not None
