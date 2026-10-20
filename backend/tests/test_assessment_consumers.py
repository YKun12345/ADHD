"""W05 real committed evidence must lead to durable, authorized business state."""
from sqlalchemy import func, select

from backend.tests.test_submission_context import scale_submission
from backend.tests.test_submission_cognitive_evidence import cognitive_submission


def complete_assessment(client, *, doctor=False):
    owner, clinician, session, _, _, scale = scale_submission(client, doctor=doctor, suffix="w05-ready")
    response = client.post("/api/v1/care/submissions", headers=owner, json=scale)
    assert response.status_code == 201, response.text
    for task in ("reaction", "stroop", "flanker", "nback", "trail", "digit"):
        _, _, item, _, body = cognitive_submission(client, task, context=(owner, session, scale["patient_id"]))
        body["task_id"] = item["patient_task_id"]
        response = client.post("/api/v1/care/submissions", headers=owner, json=body)
        assert response.status_code == 201, response.text
    assert response.json()["assessment_status"] == "evidence_ready"
    return owner, clinician, session, scale["patient_id"]


def drain():
    from backend.app.services.care_consumers import consumer_handlers
    from backend.app.workers.care_worker import run_once
    from backend.app.db.session import SessionLocal
    count = 0
    for _ in range(64):
        if not run_once(SessionLocal, consumer_handlers()):
            return count
        count += 1
    raise AssertionError("A bounded synthetic consumer pass must terminate.")


def test_real_self_evidence_closes_once_without_doctor_or_clinical_acceptance(client):
    owner, _, session, _ = complete_assessment(client)
    assert drain() == 8
    closed = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert closed.status_code == 200, closed.text
    data = closed.json()
    assert data["status"] == "closed_self" and data["responsible_doctor_id"] is None
    assert all(item["acceptance_status"] == "not_required" for item in data["items"])
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEvent
    from backend.app.models.attention import AttentionItem
    with SessionLocal() as db:
        events = db.scalars(select(CareEvent).where(CareEvent.event_type == "assessment_closed_self")).all()
        assert len(events) == 1
        assert len(events[0].payload["evidence_manifest"]) == 7
        assert events[0].payload["category"] == "self_screening"
        assert db.scalar(select(func.count()).select_from(AttentionItem)) == 0
    assert drain() == 0


def test_doctor_ready_evidence_enters_real_owned_work_queue_without_auto_acceptance(client):
    owner, clinician, session, pid = complete_assessment(client, doctor=True)
    assert drain() == 8
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    assert current["status"] == "under_review"
    assert all(item["acceptance_status"] == "pending_review" for item in current["items"])
    queue = client.get("/api/v1/care/doctor/work_queue", headers=clinician)
    assert queue.status_code == 200, queue.text
    rows = [row for row in queue.json()["items"] if row["assessment_id"] == session["id"]]
    assert len(rows) == 1 and rows[0]["kind"] == "evidence_review"
    assert rows[0]["patient_id"] == pid and rows[0]["responsible_doctor_id"] == session["responsible_doctor_id"]
    assert rows[0]["status"] == "open" and rows[0]["response_coverage"]["status"] == "not_configured"
    assert rows[0]["expected_response_at"] is None
    assert drain() == 0


def test_limited_real_evidence_creates_owned_quality_attention_with_actual_original_ref(client):
    owner, session, _, _, body = cognitive_submission(client, "flanker", child=True)
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    saved = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert saved.status_code == 201 and saved.json()["quality_status"] == "limited", saved.text
    assert drain() == 2
    response = client.get(f"/api/v1/care/patient/attention?patient_id={body['patient_id']}", headers=owner)
    assert response.status_code == 200, response.text
    rows = response.json()["items"]
    assert len(rows) == 1 and rows[0]["kind"] == "assessment_quality"
    assert rows[0]["responsible_doctor_id"] is None and rows[0]["owner_kind"] == "patient_self"
    assert rows[0]["submission_id"] == body["submission_id"]
    assert rows[0]["quality_reasons"] == ["execution_interrupted"]
    assert rows[0]["response_coverage"]["status"] == "not_configured"
    assert "trials" not in response.text and "raw_result" not in response.text
    assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()["status"] == "active"


def test_old_ready_event_cannot_borrow_regranted_basic_authority_to_close(client):
    owner, _, session, pid = complete_assessment(client)
    basic = next(row for row in client.get("/api/v1/patient/consents", headers=owner).json()["items"] if row["purpose"] == "basic_use" and row["status"] == "active")
    withdrawn = client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=owner, json={"expected_revision": basic["revision"]})
    assert withdrawn.status_code == 200, withdrawn.text
    regranted = client.post("/api/v1/patient/consents", headers=owner, json={"patient_id": pid, "purpose": "basic_use", "scope": basic["scope"], "terms_version": "W02-1"})
    assert regranted.status_code == 201, regranted.text
    assert drain() == 9  # The real withdrawal now contributes its own durable delivery.
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert current.status_code == 200 and current.json()["status"] == "suspended", current.text
    assert all(not item["allowed_actions"] for item in current.json()["items"])
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEvent, CareEventDelivery
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "assessment_closed_self")) == 0
        assert db.scalar(select(func.count()).select_from(CareEventDelivery).where(CareEventDelivery.status == "suspended")) == 8
