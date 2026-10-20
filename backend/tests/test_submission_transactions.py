"""Real HTTP/persistence failure windows, always isolated by the client fixture."""
import pytest

from backend.tests.w02_helpers import register


def test_legacy_scale_capture_failure_rolls_back_result(client, monkeypatch):
    from sqlalchemy import func, select
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from backend.app.api.routes import patient
    _, headers = register(client,"w04-capture-fault@example.com")
    def fail(*args, **kwargs):
        raise RuntimeError("synthetic capture storage interruption")
    monkeypatch.setattr(patient,"capture_scale_result_cipher",fail)
    with pytest.raises(RuntimeError,match="synthetic capture"):
        client.post("/api/v1/patient/submit_scale",headers=headers,json={"scale_type":"ASRS","answers":[0]*18})
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(ScaleResult)) == 0


def test_committed_legacy_write_survives_ordinary_observation_failure(client, monkeypatch):
    from backend.app.services import access_audit
    _, headers = register(client,"w04-observation-fault@example.com")
    def fail(*args,**kwargs):
        raise RuntimeError("synthetic ordinary observation interruption")
    monkeypatch.setattr(access_audit,"record_access",fail)
    response = client.post("/api/v1/patient/submit_cognitive_test",headers=headers,json={"test_type":"reaction","result_json":{"test_run_id":"w04-observation","raw_result":{"accuracy":92}}})
    assert response.status_code == 201, response.text


def test_legacy_write_contains_result_event_and_critical_audit(client):
    from sqlalchemy import select
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    _, headers = register(client,"w04-write-event@example.com")
    response = client.post("/api/v1/patient/submit_scale",headers=headers,json={"scale_type":"ASRS","answers":[0]*18})
    assert response.status_code == 201, response.text
    with SessionLocal() as db:
        event = db.scalar(select(CareEvent).where(CareEvent.event_type == "legacy_result_committed",CareEvent.aggregate_type == "scale_result",CareEvent.aggregate_id == response.json()["id"]))
        assert event is not None
        log = db.scalar(select(SecurityAuditLog).where(SecurityAuditLog.action == "submission_committed"))
        assert log is not None


@pytest.mark.parametrize("stage",["result","state","event","critical_audit","commit"])
def test_new_submission_failure_windows_roll_back_all_business_facts(client,monkeypatch,stage):
    from sqlalchemy import func,select
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.submission import SubmissionRecord
    from backend.app.models.assessment import TaskAttempt,AssessmentItem,AssessmentSession
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    from backend.app.services import submission_service as service
    from backend.tests.test_submission_context import scale_submission
    owner,_,session,item,attempt,body = scale_submission(client)
    if stage == "commit":
        from sqlalchemy.orm import Session
        original = Session.commit
        def interrupted(db):
            request = db.info.get("authorization_request")
            if request is not None and request.url.path == "/api/v1/care/submissions":
                raise RuntimeError("synthetic commit interruption")
            return original(db)
        monkeypatch.setattr(Session,"commit",interrupted)
    else:
        name = {"result":"_result","state":"_advance","event":"append_care_event","critical_audit":"append_submission_audit"}[stage]
        original = getattr(service,name)
        def interrupted(*args,**kwargs):
            original(*args,**kwargs)
            raise RuntimeError("synthetic "+stage+" interruption")
        monkeypatch.setattr(service,name,interrupted)
    with pytest.raises(RuntimeError,match="synthetic"):
        client.post("/api/v1/care/submissions",headers=owner,json=body)
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(ScaleResult)) == 0
        assert db.scalar(select(func.count()).select_from(SubmissionRecord)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "submission_committed")) == 0
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog).where(SecurityAuditLog.action == "submission_committed")) == 0
        assert db.get(TaskAttempt,attempt["id"]).execution_status == "in_progress"
        assert db.get(AssessmentItem,item["id"]).execution_status == "in_progress"
        assert db.get(AssessmentSession,session["id"]).status == "active"


def test_commit_then_ack_loss_recovers_original_result_without_duplicate_fact(client,monkeypatch):
    from backend.tests.test_submission_context import scale_submission
    from backend.app.services import submission_service as service
    owner,_,_,_,_,body = scale_submission(client)
    original = service.ack_response
    def lost(*args,**kwargs): raise RuntimeError("synthetic ACK lost after commit")
    monkeypatch.setattr(service,"ack_response",lost)
    with pytest.raises(RuntimeError,match="ACK lost"):
        client.post("/api/v1/care/submissions",headers=owner,json=body)
    monkeypatch.setattr(service,"ack_response",original)
    recovered = client.get("/api/v1/care/submissions/"+body["submission_id"],headers=owner)
    retry = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert recovered.status_code == retry.status_code == 200
    assert recovered.json()["result"] == retry.json()["result"]
    from sqlalchemy import func,select
    from backend.app.db.session import SessionLocal
    from backend.app.models.submission import SubmissionRecord
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SubmissionRecord)) == 1
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "submission_committed")) == 1
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog).where(SecurityAuditLog.action == "submission_committed")) == 1


def test_real_concurrent_new_submission_creates_one_result(client):
    from concurrent.futures import ThreadPoolExecutor
    from backend.tests.test_submission_context import scale_submission
    owner,_,_,_,_,body = scale_submission(client)
    def submit(_): return client.post("/api/v1/care/submissions",headers=owner,json=body)
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(submit,range(4)))
    assert sorted(row.status_code for row in responses) == [200,200,200,201],[row.text for row in responses]
    assert len({row.json()["result"]["id"] for row in responses}) == 1


def test_critical_write_audit_failure_returns_retryable_id_and_rolls_back(client,monkeypatch):
    from backend.tests.test_submission_context import scale_submission
    owner,_,_,_,_,body = scale_submission(client)
    from backend.app.services import security_service
    def fail(*args,**kwargs): raise RuntimeError("synthetic critical audit failure")
    monkeypatch.setattr(security_service,"_append_audit_log",fail)
    response = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert response.status_code == 503,response.text
    from sqlalchemy import func,select
    from backend.app.db.session import SessionLocal
    from backend.app.models.submission import SubmissionRecord
    from backend.app.models.scale_result import ScaleResult
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SubmissionRecord)) == 0
        assert db.scalar(select(func.count()).select_from(ScaleResult)) == 0


def test_only_real_valid_results_make_the_actual_assessment_evidence_ready(client):
    from backend.tests.test_submission_context import scale_submission
    from backend.tests.test_submission_cognitive_evidence import cognitive_submission
    owner,_,session,_,_,body = scale_submission(client)
    response = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert response.status_code == 201 and response.json()["assessment_status"] == "active"
    for task in ("reaction","stroop","flanker","nback","trail","digit"):
        _,_,_,_,body = cognitive_submission(client,task,context=(owner,session,body["patient_id"]))
        response = client.post("/api/v1/care/submissions",headers=owner,json=body)
        assert response.status_code == 201,response.text
    assert response.json()["assessment_status"] == "evidence_ready"
    assert response.json()["acceptance_status"] == "not_required"
    from sqlalchemy import func,select
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEvent
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "assessment_evidence_ready")) == 1

