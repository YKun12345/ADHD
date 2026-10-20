"""Actual HTTP original recovery and caller transaction failures, synthetic stores only."""
from sqlalchemy import event, func, select

from backend.tests.test_assessment_consumers import drain
from backend.tests.test_submission_cognitive_evidence import cognitive_submission
from backend.tests.test_attention_lifecycle import action_body, preflight


def created_attention(client):
    owner, _, _, _, body = cognitive_submission(client, "flanker")
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    saved = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert saved.status_code == 201, saved.text
    assert drain() == 2
    row = client.get(f"/api/v1/care/patient/attention?patient_id={body['patient_id']}", headers=owner).json()["items"][0]
    return owner, row, preflight(client, owner, row["id"])


def facts(identifier):
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    from backend.app.models.attention_action import AttentionAction
    from backend.app.models.event import CareEvent
    with SessionLocal() as db:
        row = db.get(AttentionItem, identifier)
        return (row.status, row.version, db.scalar(select(func.count()).select_from(AttentionAction)),
            db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "attention_action_committed")))


def test_fixed_queue_route_never_rebinds_patient_and_returns_exact_original_ack(client):
    owner, row, view = created_attention(client)
    body = {**action_body(view, "fixed-queue-original", "acknowledge"), "patient_id": row["patient_id"], "attention_id": row["id"]}
    wrong = client.post("/api/v1/care/attention-actions", headers=owner, json={**body, "patient_id": row["patient_id"] + 999})
    assert wrong.status_code == 409, wrong.text
    assert facts(row["id"]) == ("open", 1, 0, 0)
    first = client.post("/api/v1/care/attention-actions", headers=owner, json=body)
    assert first.status_code == 201, first.text
    repeated = client.post("/api/v1/care/attention-actions", headers=owner, json=body)
    queried = client.get("/api/v1/care/attention-actions/fixed-queue-original", headers=owner)
    assert repeated.status_code == queried.status_code == 200
    assert first.json() == repeated.json() == queried.json()
    assert facts(row["id"]) == ("acknowledged", 2, 1, 1)


def test_actual_action_commit_failure_rolls_back_then_same_id_can_recover_once(client, monkeypatch):
    owner, row, view = created_attention(client)
    body = action_body(view, "commit-failure-original", "acknowledge")
    from backend.app.services import attention_action_service
    original = attention_action_service.act_on_attention
    def fail_after_fact(db, user, identifier, payload):
        result = original(db, user, identifier, payload)
        def fail(*_):
            raise OSError("synthetic final commit unavailable")
        event.listen(db, "before_commit", fail, once=True)
        return result
    monkeypatch.setattr(attention_action_service, "act_on_attention", fail_after_fact)
    result = client.post(f"/api/v1/care/attention/{row['id']}/actions", headers=owner, json=body)
    assert result.status_code == 503, result.text
    assert "action_id" not in result.json() and "actor_identity_basis" not in result.text
    assert facts(row["id"]) == ("open", 1, 0, 0)
    assert client.get("/api/v1/care/attention-actions/commit-failure-original", headers=owner).status_code == 404
    monkeypatch.setattr(attention_action_service, "act_on_attention", original)
    recovered = client.post(f"/api/v1/care/attention/{row['id']}/actions", headers=owner, json=body)
    assert recovered.status_code == 201, recovered.text
    assert facts(row["id"]) == ("acknowledged", 2, 1, 1)


def test_detail_and_history_never_disclose_if_their_critical_audit_cannot_commit(client, monkeypatch):
    owner, row, _ = created_attention(client)
    from backend.app.api.routes import care_attention
    original = care_attention._commit_cycle_response
    def failing_commit(db, value):
        def fail(*_):
            raise OSError("synthetic sensitive read audit commit unavailable")
        event.listen(db, "before_commit", fail, once=True)
        return original(db, value)
    monkeypatch.setattr(care_attention, "_commit_cycle_response", failing_commit)
    for route in (f"/api/v1/care/attention/{row['id']}", f"/api/v1/care/attention/{row['id']}/history"):
        result = client.get(route, headers=owner)
        assert result.status_code == 503, result.text
        assert "action_context" not in result.text and "items" not in result.json()
    assert facts(row["id"]) == ("open", 1, 0, 0)
