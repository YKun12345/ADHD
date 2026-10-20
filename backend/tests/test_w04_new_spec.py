"""Independent new-submission specification probes, using synthetic HTTP fixtures."""
from copy import deepcopy

import pytest

from backend.tests.test_submission_context import scale_submission
from backend.tests.test_submission_cognitive_evidence import cognitive_submission
from backend.tests.test_assessment_sessions import start


def test_limited_actual_evidence_has_atomic_quality_issue_outbox(client):
    owner, _, _, attempt, body = cognitive_submission(client, "flanker")
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    response = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert response.status_code == 201, response.text
    assert response.json()["quality_status"] == "limited"
    retried = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert retried.status_code == 200 and retried.json()["result"] == response.json()["result"]
    from sqlalchemy import select
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEvent, CareEventDelivery
    from backend.app.models.submission import SubmissionRecord
    with SessionLocal() as db:
        saved = db.scalar(select(SubmissionRecord).where(SubmissionRecord.attempt_id == attempt["id"]))
        events = db.scalars(select(CareEvent).where(CareEvent.patient_id == body["patient_id"])).all()
        issues = [row for row in events if row.event_type == "assessment_quality_issue"]
        assert len(issues) == 1, "A committed limited result needs exactly one durable quality-issue fact (contract section 6)."
        issue = issues[0]
        assert issue.aggregate_id == saved.id
        assert issue.payload["submission_id"] == body["submission_id"]
        assert issue.payload["attempt_id"] == attempt["id"]
        assert issue.payload["quality_reasons"] == ["execution_interrupted"]
        deliveries = db.scalars(select(CareEventDelivery).where(CareEventDelivery.event_id == issue.event_id)).all()
        assert len(deliveries) == 1 and deliveries[0].status == "pending"
        assert "trials" not in str(issue.payload) and "raw_result" not in str(issue.payload)


def test_valid_historical_attempt_is_not_erased_from_evidence_readiness_by_new_attempt(client):
    owner, _, session, _, _, body = scale_submission(client, suffix="new-spec-history")
    saved = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert saved.status_code == 201, saved.text
    fresh = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    next_attempt = start(client, owner, fresh["items"][0], body["patient_id"])
    assert next_attempt.status_code == 201, next_attempt.text
    for task in ("reaction", "stroop", "flanker", "nback", "trail", "digit"):
        _, _, _, _, cognitive = cognitive_submission(client, task, context=(owner, session, body["patient_id"]))
        response = client.post("/api/v1/care/submissions", headers=owner, json=cognitive)
        assert response.status_code == 201, response.text
    assert response.json()["assessment_status"] == "evidence_ready", "Each applicable item has an actual valid result; a later unfinished attempt must not erase it (contract section 5)."
    history = client.get(f"/api/v1/care/submissions/{body['submission_id']}/evidence", headers=owner)
    assert history.status_code == 200
    assert history.json()["ack"]["result"] == saved.json()["result"]


@pytest.mark.parametrize("field", ["task_id", "protocol_id", "protocol_schema_version", "template_digest", "submitter_user_id", "performer_patient_id"])
def test_uncommitted_server_attempt_rejects_forged_context_before_any_result(client, field):
    owner, _, _, _, _, body = scale_submission(client, suffix="new-spec-context")
    changed = deepcopy(body)
    old = changed[field]
    changed[field] = old + 500 if type(old) is int else 500 if old is None else "different"
    response = client.post("/api/v1/care/submissions", headers=owner, json=changed)
    assert response.status_code == 409, response.text
    from sqlalchemy import func, select
    from backend.app.db.session import SessionLocal
    from backend.app.models.submission import SubmissionRecord
    from backend.app.models.scale_result import ScaleResult
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SubmissionRecord)) == 0
        assert db.scalar(select(func.count()).select_from(ScaleResult)) == 0


@pytest.mark.parametrize("field", ["content", "execution_metadata", "record_origin"])
def test_submission_cross_object_raw_ciphertext_swap_withholds_ack_and_evidence(client, field):
    owner, _, session, _, _, body = scale_submission(client, suffix="new-spec-aad")
    assert client.post("/api/v1/care/submissions", headers=owner, json=body).status_code == 201
    _, _, _, _, cognitive = cognitive_submission(client, "flanker", context=(owner, session, body["patient_id"]))
    assert client.post("/api/v1/care/submissions", headers=owner, json=cognitive).status_code == 201
    from sqlalchemy import text
    from backend.app.db.session import engine
    with engine.begin() as db:
        source = db.execute(text(f"SELECT {field} FROM submission_records WHERE submission_id=:id"), {"id": cognitive["submission_id"]}).scalar_one()
        db.execute(text(f"UPDATE submission_records SET {field}=:cipher WHERE submission_id=:id"), {"cipher": source, "id": body["submission_id"]})
    for suffix in ("", "/evidence"):
        response = client.get(f"/api/v1/care/submissions/{body['submission_id']}{suffix}", headers=owner)
        assert response.status_code in (409, 503), response.text
        assert "answers" not in response.text and "score_json" not in response.text


@pytest.mark.parametrize("field,value", [("quality_status", "valid"), ("acceptance_status", "accepted")])
def test_raw_database_status_rewrite_cannot_promote_authenticated_original_evidence(client, field, value):
    """Same database-write threat as ciphertext swaps, not an ordinary API privilege claim."""
    owner, _, _, _, body = cognitive_submission(client, "flanker")
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    response = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert response.status_code == 201 and response.json()["quality_status"] == "limited", response.text
    from sqlalchemy import text
    from backend.app.db.session import engine
    with engine.begin() as db:
        db.execute(text(f"UPDATE submission_records SET {field}=:value WHERE submission_id=:id"), {"value": value, "id": body["submission_id"]})
    response = client.get(f"/api/v1/care/submissions/{body['submission_id']}/evidence", headers=owner)
    status = response.json().get("ack", {}).get(field)
    assert response.status_code in (409, 503), f"Rewritten {field}={status!r} must fail closed against immutable authenticated result."
    assert "trials" not in response.text


def test_later_limited_attempt_preserves_earlier_valid_evidence_for_same_item(client):
    owner, _, session, _, _, scale = scale_submission(client, suffix="new-spec-limited-history")
    assert client.post("/api/v1/care/submissions", headers=owner, json=scale).status_code == 201
    _, _, _, _, first = cognitive_submission(client, "flanker", context=(owner, session, scale["patient_id"]))
    assert client.post("/api/v1/care/submissions", headers=owner, json=first).status_code == 201
    fresh = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    _, _, _, _, second = cognitive_submission(client, "flanker", context=(owner, fresh, scale["patient_id"]))
    second["submission_id"] += "-limited-retake"
    second["content"]["execution_metadata"]["interrupted_count"] = 1
    result = client.post("/api/v1/care/submissions", headers=owner, json=second)
    assert result.status_code == 201 and result.json()["quality_status"] == "limited", result.text
    for task in ("reaction", "stroop", "nback", "trail", "digit"):
        _, _, _, _, body = cognitive_submission(client, task, context=(owner, session, scale["patient_id"]))
        result = client.post("/api/v1/care/submissions", headers=owner, json=body)
        assert result.status_code == 201, result.text
    assert result.json()["assessment_status"] == "evidence_ready"
    history = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    attempts = next(row for row in history["items"] if row["key"] == "flanker")["attempts"]
    assert [row["quality_status"] for row in attempts] == ["valid", "limited"]


def test_quality_issue_append_failure_rolls_back_result_submission_state_and_all_submission_events(client, monkeypatch):
    owner, _, _, attempt, body = cognitive_submission(client, "flanker")
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    from backend.app.services import submission_service as service
    original = service.append_care_event
    def interrupted(*args, **kwargs):
        result = original(*args, **kwargs)
        if kwargs.get("event_type") == "assessment_quality_issue":
            raise RuntimeError("synthetic quality outbox interruption")
        return result
    monkeypatch.setattr(service, "append_care_event", interrupted)
    with pytest.raises(RuntimeError, match="quality outbox interruption"):
        client.post("/api/v1/care/submissions", headers=owner, json=body)
    from sqlalchemy import func, select
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEvent
    from backend.app.models.submission import SubmissionRecord
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.models.assessment import TaskAttempt
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SubmissionRecord)) == 0
        assert db.scalar(select(func.count()).select_from(CognitiveTest)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type.in_(["submission_committed", "assessment_quality_issue"]))) == 0
        assert db.get(TaskAttempt, attempt["id"]).execution_status == "in_progress"


@pytest.mark.parametrize("kind", ["scale", "cognitive"])
def test_formal_result_cannot_be_rewritten_through_the_orm_after_commit(client, kind):
    if kind == "scale":
        owner, _, _, _, _, body = scale_submission(client, suffix="new-spec-immutable")
    else:
        owner, _, _, _, body = cognitive_submission(client, "flanker")
    response = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert response.status_code == 201, response.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.cognitive_test import CognitiveTest
    with SessionLocal() as db:
        row = db.get(ScaleResult if kind == "scale" else CognitiveTest, response.json()["result"]["id"])
        if kind == "scale":
            row.total_score = 72
        else:
            result = row.result_json
            result["raw_result"]["accuracy"] = 0
            row.result_json = result
        with pytest.raises((ValueError, RuntimeError), match="(?i)immutable|formal|committed"):
            db.commit()
        db.rollback()


def test_clearing_origin_proof_cannot_readmit_a_new_bound_result_as_legacy(client):
    """An erased proof must fail closed, including simultaneously changed v1 markers."""
    from backend.tests.w02_helpers import register
    _, owner = register(client, "w04-new-spec-origin@example.org")
    saved = client.post("/api/v1/patient/submit_scale", headers=owner, json={"scale_type": "ASRS", "answers": [0] * 18})
    assert saved.status_code == 201, saved.text
    from backend.app.core.data_encryption import encrypt_value
    from backend.app.db.session import engine
    from sqlalchemy import text
    v1 = {"score_json": encrypt_value({"answers": [4] * 18}, "scale_results.score_json"),
          "total_score": encrypt_value(72, "scale_results.total_score"),
          "risk_level": encrypt_value("high", "scale_results.risk_level"), "id": saved.json()["id"]}
    with engine.begin() as db:
        db.execute(text("UPDATE scale_results SET score_json=:score_json,total_score=:total_score,risk_level=:risk_level,record_origin=NULL,envelope_status='legacy',record_schema_version=1 WHERE id=:id"), v1)
    response = client.get("/api/v1/patient/comprehensive_report", headers=owner)
    assert response.status_code in (409, 503), response.text
    assert "answers" not in response.text and "score_json" not in response.text


@pytest.mark.parametrize("boundary", ["rollback_expire", "expire", "refresh"])
def test_discarded_pending_plaintext_cannot_hide_persistent_evidence_after_orm_lifecycle(client, boundary):
    owner, _, _, _, _, body = scale_submission(client, suffix="new-spec-cache-lifecycle")
    saved = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert saved.status_code == 201, saved.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    with SessionLocal() as db:
        row = db.get(ScaleResult, saved.json()["result"]["id"])
        row.total_score = 72
        if boundary == "rollback_expire":
            with pytest.raises(ValueError, match="(?i)immutable"):
                db.commit()
            db.rollback()
            db.expire(row)
        elif boundary == "expire":
            db.expire(row)
        else:
            db.refresh(row)
        assert row.total_score == 0, "Discarded plaintext must not mask the actual persistent, object-bound value."


def _legacy_mutable_scale(client, suffix):
    from backend.tests.w02_helpers import register
    _, owner = register(client, f"w04-new-spec-{suffix}@example.org")
    saved = client.post("/api/v1/patient/submit_scale", headers=owner, json={"scale_type": "ASRS", "answers": [0] * 18})
    assert saved.status_code == 201, saved.text
    assert saved.json()["legacy"] is True
    return saved.json()["id"]


def test_partial_refresh_discards_only_the_refreshed_pending_field(client):
    identity = _legacy_mutable_scale(client, "partial-refresh")
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    with SessionLocal() as db:
        row = db.get(ScaleResult, identity)
        row.total_score = 10
        row.risk_level = "high"
        db.refresh(row, ["_risk_level_cipher"])
        assert row.risk_level == "low"
        assert row.total_score == 10, "Refreshing risk must preserve the unrelated legitimate pending total."
        db.commit()
    with SessionLocal() as db:
        row = db.get(ScaleResult, identity)
        assert row.total_score == 10 and row.risk_level == "low"


def test_partial_expiration_of_binding_metadata_does_not_commit_empty_placeholders(client):
    identity = _legacy_mutable_scale(client, "partial-metadata-expire")
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    with SessionLocal() as db:
        row = db.get(ScaleResult, identity)
        row.total_score = 10
        row.risk_level = "high"
        db.expire(row, ["data_version"])
        assert row.total_score == 0 and row.risk_level == "low"
        db.commit()
    with SessionLocal() as db:
        row = db.get(ScaleResult, identity)
        assert row.total_score == 0 and row.risk_level == "low"
        raw = db.connection().exec_driver_sql("SELECT total_score,risk_level FROM scale_results WHERE id=?", (identity,)).one()
        assert all(value.startswith("aesgcm:v2:") for value in raw)
