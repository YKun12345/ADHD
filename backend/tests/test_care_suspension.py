"""Authority events must suspend actual old work after submission deliveries finish."""
from sqlalchemy import select

from backend.tests.test_assessment_sessions import actor, created
from backend.tests.test_submission_context import scale_submission
from backend.tests.test_submission_cognitive_evidence import cognitive_submission


def drain(*, invalidations=True):
    from backend.app.db.session import SessionLocal
    from backend.app.services.care_consumers import consumer_handlers
    from backend.app.workers.care_worker import run_once
    handlers = consumer_handlers().copy()
    if invalidations:
        from backend.app.services.care_suspension_service import consume_authority_invalidation
        handlers["care_authority_invalidation"] = consume_authority_invalidation
    else:
        handlers.pop("care_authority_invalidation", None)
    count = 0
    for _ in range(64):
        if not run_once(SessionLocal, handlers):
            return count
        count += 1
    raise AssertionError("Synthetic delivery pass did not terminate")


def current_consent(client, owner, purpose):
    return next(row for row in client.get("/api/v1/patient/consents", headers=owner).json()["items"]
                if row["purpose"] == purpose and row["status"] == "active")


def withdraw(client, owner, row):
    response = client.post(f"/api/v1/patient/consents/{row['id']}/withdraw", headers=owner,
                           json={"expected_revision":row["revision"]})
    assert response.status_code == 200, response.text


def invalidation_events():
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEvent, CareEventDelivery
    with SessionLocal() as db:
        return [(event.event_id, event.event_type, event.payload, delivery.status)
                for event, delivery in db.execute(select(CareEvent, CareEventDelivery)
                    .join(CareEventDelivery, CareEvent.event_id == CareEventDelivery.event_id)
                    .where(CareEventDelivery.consumer == "care_authority_invalidation")).all()]


def test_relationship_revoke_after_quality_consumed_pauses_owned_work_and_preserves_history(client):
    owner, clinician, session, _, _, scale = scale_submission(client, doctor=True, suffix="pause-doctor")
    saved = client.post("/api/v1/care/submissions", headers=owner, json=scale)
    assert saved.status_code == 201, saved.text
    _, _, item, _, body = cognitive_submission(client, "flanker", context=(owner, session, scale["patient_id"]))
    body["task_id"] = item["patient_task_id"]
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    limited = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert limited.status_code == 201 and limited.json()["quality_status"] == "limited", limited.text
    assert drain(invalidations=False) == 3
    independent = created(client, owner, scale["patient_id"])
    queue = client.get("/api/v1/care/doctor/work_queue", headers=clinician)
    assert len(queue.json()["items"]) == 1
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    with SessionLocal() as db:
        relationship = db.scalar(select(CareRelationship).where(CareRelationship.patient_id == scale["patient_id"]))
        relationship_id, revision = relationship.id, relationship.revision
    response = client.post(f"/api/v1/care/relationships/{relationship_id}/revoke", headers=owner,
                           json={"expected_revision":revision})
    assert response.status_code == 200, response.text
    assert {row[1] for row in invalidation_events()} == {"consent.withdrawn", "care_relationship.revoked"}
    assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=clinician).status_code == 403
    assert drain() == 2
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert current.status_code == 200, current.text
    assert current.json()["status"] == "suspended"
    assert current.json()["suspension_reason"] == "original_authority_invalid"
    assert client.get(f"/api/v1/care/assessments/{independent['id']}", headers=owner).json()["status"] == "active"
    attention = client.get(f"/api/v1/care/patient/attention?patient_id={scale['patient_id']}", headers=owner)
    assert attention.status_code == 200, attention.text
    assert attention.json()["items"][0]["status"] == "suspended"
    assert attention.json()["items"][0]["responsible_doctor_id"] == session["responsible_doctor_id"]
    assert client.get(f"/api/v1/care/submissions/{scale['submission_id']}", headers=owner).json()["result"] == saved.json()["result"]
    from backend.app.models.patient_task import PatientTask, PatientTaskStatus
    from backend.app.models.assessment import AssessmentSession
    from backend.app.services.care_suspension_service import consume_authority_invalidation
    from backend.app.models.event import CareEvent
    from datetime import datetime, timezone
    with SessionLocal() as db:
        tasks = db.scalars(select(PatientTask).where(PatientTask.assessment_id == session["id"])).all()
        assert sum(task.status == PatientTaskStatus.COMPLETED for task in tasks) == 1
        assert sum(task.status == PatientTaskStatus.SUSPENDED for task in tasks) == 6
        before = db.get(AssessmentSession, session["id"]).version
        for identifier, *_ in invalidation_events():
            consume_authority_invalidation(db, db.scalar(select(CareEvent).where(CareEvent.event_id == identifier)), datetime.now(timezone.utc))
        db.commit()
        assert db.get(AssessmentSession, session["id"]).version == before
    assert drain() == 0


def test_late_basic_withdrawal_only_pauses_original_receipts_after_regrant(client):
    _, owner, pid = actor(client, suffix="pause-basic")
    original = created(client, owner, pid)
    basic = current_consent(client, owner, "basic_use")
    withdraw(client, owner, basic)
    assert len(invalidation_events()) == 1
    grant = client.post("/api/v1/patient/consents", headers=owner,
        json={"patient_id":pid,"purpose":"basic_use","scope":basic["scope"],"terms_version":"W02-1"})
    assert grant.status_code == 201, grant.text
    fresh = created(client, owner, pid)
    assert drain() == 1
    old = client.get(f"/api/v1/care/assessments/{original['id']}", headers=owner)
    assert old.status_code == 200 and old.json()["status"] == "suspended", old.text
    assert client.get(f"/api/v1/care/assessments/{fresh['id']}", headers=owner).json()["status"] == "active"


def test_external_ai_withdrawal_has_no_clinical_suspension_delivery(client):
    _, owner, pid = actor(client, suffix="pause-ai")
    session = created(client, owner, pid)
    grant = client.post("/api/v1/patient/consents", headers=owner,
        json={"patient_id":pid,"purpose":"external_ai","scope":["assessment"],"terms_version":"W02-1"})
    assert grant.status_code == 201, grant.text
    withdraw(client, owner, grant.json())
    assert invalidation_events() == []
    assert drain() == 0
    assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()["status"] == "active"


def test_guardian_restoration_new_revision_does_not_revive_old_work_or_suspend_new_work(client):
    from backend.tests.w02_helpers import register, qualify
    data, owner = register(client, "pause-guardian@example.com", child=True)
    reviewer, reviewer_headers = register(client, "pause-reviewer@example.com", "researcher")
    qualify(reviewer["user"]["id"], reviewer=True)
    relationship = client.get("/api/v1/identity/context", headers=owner).json()["guardian_relationships"][0]
    url = f"/api/v1/identity/guardians/{relationship['id']}"
    reviewed = client.post(url + "/review", headers=reviewer_headers,
        json={"expected_revision":relationship["revision"],"status":"verified",
              "review_reference":"synthetic-review","expires_at":"2090-01-01T00:00:00Z"})
    assert reviewed.status_code == 200, reviewed.text
    # Replacing a never-effective pending registration grant creates history,
    # but there is no authorized care work for an invalidation consumer.
    assert invalidation_events() == []
    pid = relationship["patient_id"]
    old = created(client, owner, pid, child=True)
    suspended = client.post(url + "/suspend", headers=reviewer_headers,
        json={"expected_revision":reviewed.json()["revision"],"review_reference":"synthetic-suspend"})
    assert suspended.status_code == 200, suspended.text
    events = invalidation_events()
    assert {row[1] for row in events} == {"consent.identity_invalidated","guardian.suspend"}
    assert all(row[2]["authority_ref"]["actor_identity_basis"].startswith("institution_reviewer:") for row in events)
    restored = client.post(url + "/restore", headers=reviewer_headers,
        json={"expected_revision":suspended.json()["revision"],"review_reference":"synthetic-restore",
              "expires_at":"2090-01-01T00:00:00Z"})
    assert restored.status_code == 200, restored.text
    granted = client.post("/api/v1/patient/consents", headers=owner,
        json={"patient_id":pid,"purpose":"basic_use","scope":["profile","assessment","tracking","care","imaging"],"terms_version":"W02-1"})
    assert granted.status_code == 201, granted.text
    fresh = created(client, owner, pid, child=True)
    assert drain() == 2
    assert client.get(f"/api/v1/care/assessments/{old['id']}", headers=owner).json()["status"] == "suspended"
    assert client.get(f"/api/v1/care/assessments/{fresh['id']}", headers=owner).json()["status"] == "active"


def test_active_basic_superseded_pauses_only_its_old_round(client):
    _, owner, pid = actor(client, suffix="pause-superseded")
    old = created(client, owner, pid)
    basic = current_consent(client, owner, "basic_use")
    grant = client.post("/api/v1/patient/consents", headers=owner,
        json={"patient_id":pid,"purpose":"basic_use","scope":basic["scope"],"terms_version":"W02-1"})
    assert grant.status_code == 201, grant.text
    assert [row[1] for row in invalidation_events()] == ["consent.superseded"]
    fresh = created(client, owner, pid)
    assert drain() == 1
    assert client.get(f"/api/v1/care/assessments/{old['id']}", headers=owner).json()["status"] == "suspended"
    assert client.get(f"/api/v1/care/assessments/{fresh['id']}", headers=owner).json()["status"] == "active"


def test_changed_event_routing_is_rejected_without_suspending_other_work(client):
    from sqlalchemy import update
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEvent, CareEventDelivery
    _, owner, pid = actor(client, suffix="pause-tamper")
    session = created(client, owner, pid)
    withdraw(client, owner, current_consent(client, owner, "basic_use"))
    event_id = invalidation_events()[0][0]
    with SessionLocal() as db:
        db.execute(update(CareEvent).where(CareEvent.event_id == event_id).values(revision=999))
        db.commit()
    assert drain() == 0
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert current.status_code == 200 and current.json()["status"] == "active", current.text
    with SessionLocal() as db:
        delivery = db.scalar(select(CareEventDelivery).where(CareEventDelivery.event_id == event_id))
        assert delivery.status == "retry_failed" and delivery.last_error == "RecordIntegrityError"


def test_critical_audit_failure_rolls_back_actual_suspension_and_ack(client, monkeypatch):
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEventDelivery
    from backend.app.models.assessment import AssessmentSession
    from backend.app.services import security_service
    _, owner, pid = actor(client, suffix="pause-audit")
    session = created(client, owner, pid)
    withdraw(client, owner, current_consent(client, owner, "basic_use"))
    def fail(*args, **kwargs):
        raise RuntimeError("synthetic critical audit failure")
    monkeypatch.setattr(security_service, "_append_audit_log", fail)
    assert drain() == 0
    with SessionLocal() as db:
        actual = db.get(AssessmentSession, session["id"])
        assert actual.status == "active" and actual.version == session["version"]
        delivery = db.scalar(select(CareEventDelivery).where(CareEventDelivery.consumer == "care_authority_invalidation"))
        assert delivery.status == "retry_failed" and delivery.completed_at is None


def test_closed_self_history_stays_closed_after_later_basic_invalidation(client):
    from backend.tests.test_assessment_consumers import complete_assessment
    owner, _, session, _ = complete_assessment(client)
    assert drain() == 8
    before = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    assert before["status"] == "closed_self"
    withdraw(client, owner, current_consent(client, owner, "basic_use"))
    assert drain() == 1
    after = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert after.status_code == 200 and after.json() == before, after.text
