"""Fresh independent W05 foundation quality probes, synthetic stores only."""
from datetime import timedelta, timezone

import pytest
from sqlalchemy import event, func, select, text

from backend.tests.test_assessment_consumers import drain
from backend.tests.test_attention_deadlines import actual_deadline_attention
from backend.tests.test_responsibility_transfers import accepted_transfer, real_transfer_source
from backend.tests.test_submission_cognitive_evidence import cognitive_submission


def second_limited_source(client, owner, session):
    _, _, item, _, payload = cognitive_submission(client, "reaction", context=(owner, session, session["patient_id"]))
    payload["task_id"] = item["patient_task_id"]
    payload["submission_id"] = "independent-quality-second-limited"
    payload["content"]["execution_metadata"]["interrupted_count"] = 1
    response = client.post("/api/v1/care/submissions", headers=owner, json=payload)
    assert response.status_code == 201, response.text
    assert response.json()["quality_status"] == "limited"
    assert drain() == 2


def test_independent_deadline_corrupt_first_original_advances_bounded_cursor_and_keeps_later_fact(client):
    owner, _, session, first_id, _ = actual_deadline_attention(client)
    second_limited_source(client, owner, session)
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    from backend.app.models.care_system_event import CareDeadlineCursor, CareSystemEvent
    from backend.app.core.record_envelope import RecordIntegrityError
    from backend.app.services.attention_deadline_service import monitor_once, PRINCIPAL
    with SessionLocal() as db:
        originals = db.scalars(select(AttentionItem).where(AttentionItem.assessment_id == session["id"])
                               .order_by(AttentionItem.id)).all()
        assert len(originals) == 2 and originals[0].id == first_id
        second_id = originals[1].id
        observed = max(row.expected_response_at.replace(tzinfo=timezone.utc) for row in originals) + timedelta(seconds=1)
        db.execute(text("UPDATE attention_items SET state_snapshot=:broken WHERE id=:id"),
                   {"broken": "independent-corrupt-ciphertext", "id": first_id})
        db.commit()
    assert monitor_once(SessionLocal, limit=1, clock=lambda: observed) == 0
    with SessionLocal() as db:
        assert db.get(CareDeadlineCursor, PRINCIPAL).last_attention_id == first_id
    assert monitor_once(SessionLocal, limit=1, clock=lambda: observed) == 1
    with SessionLocal() as db:
        assert db.get(CareDeadlineCursor, PRINCIPAL).last_attention_id == second_id
        facts = db.scalars(select(CareSystemEvent)).all()
        assert len(facts) == 1 and facts[0].payload["attention_id"] == second_id
        assert facts[0].payload["human_action"] is False
        assert facts[0].payload["external_delivery_status"] == "not_configured"
        # Deliberately corrupt rows must fail full ORM loading. Read only the
        # clear state column to establish the scanner did not mutate the row.
        assert db.scalar(select(AttentionItem.status).where(AttentionItem.id == first_id)) == "open"
        assert db.get(AttentionItem, second_id).status == "open"
    with SessionLocal() as db, pytest.raises(RecordIntegrityError):
        db.get(AttentionItem, first_id)
    assert monitor_once(SessionLocal, limit=1, clock=lambda: observed) == 0
    assert monitor_once(SessionLocal, limit=1, clock=lambda: observed) == 0
    assert monitor_once(SessionLocal, limit=1, clock=lambda: observed) == 0


def test_independent_successor_corrupt_first_work_does_not_starve_later_natural_suspension(client):
    owner, _, incoming, session, relation, _ = real_transfer_source(client)
    second_limited_source(client, owner, session)
    options = client.get(f"/api/v1/care/responsibility-transfers/options?patient_id={session['patient_id']}", headers=owner)
    assert options.status_code == 200, options.text
    sources = [{key: row[key] for key in ("source_type", "source_id", "expected_version")}
               for row in options.json()["sources"]]
    assert len(sources) == 2
    body = {"patient_id": session["patient_id"], "receiving_relationship_id": relation["id"],
            "sources": sources, "reason": "Independent explicit two-item handover"}
    check = client.post("/api/v1/care/responsibility-transfers/preflight", headers=owner, json=body)
    assert check.status_code == 200, check.text
    proposal = client.post("/api/v1/care/responsibility-transfers", headers=owner, json={**body,
        "client_transfer_id": "quality-two-source-request", "confirmed": True,
        "request_context": check.json()["request_context"]})
    assert proposal.status_code == 201, proposal.text
    detail = client.get(f"/api/v1/care/responsibility-transfers/{proposal.json()['id']}", headers=incoming)
    assert detail.status_code == 200, detail.text
    accepted = client.post("/api/v1/care/responsibility-transfer-decisions", headers=incoming,
        json={"patient_id": session["patient_id"], "transfer_id": proposal.json()["id"],
              "client_decision_id": "quality-two-source-accept", "expected_version": 1,
              "decision": "accept", "reason": None, "confirmed": True,
              "decision_context": detail.json()["decision_context"]})
    assert accepted.status_code == 201, accepted.text
    first_id, second_id = accepted.json()["work_item_ids"]
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_transfer import CareTransferMaintenanceCursor, CareTransferWorkItem
    from backend.app.models.care_system_event import CareSystemEvent
    from backend.app.models.user import User
    from backend.app.core.record_envelope import RecordIntegrityError
    from backend.app.services.care_transfer_maintenance import maintain_once, PRINCIPAL
    with SessionLocal() as db:
        db.execute(text("UPDATE care_transfer_work_items SET state_snapshot=:broken WHERE id=:id"),
                   {"broken": "independent-corrupt-work-ciphertext", "id": first_id})
        db.get(User, relation["doctor_user_id"]).is_active = False
        db.commit()
    assert maintain_once(SessionLocal, limit=1) == 0
    with SessionLocal() as db:
        assert db.get(CareTransferMaintenanceCursor, PRINCIPAL).last_work_id == first_id
    assert maintain_once(SessionLocal, limit=1) == 1
    with SessionLocal() as db:
        assert db.get(CareTransferMaintenanceCursor, PRINCIPAL).last_work_id == second_id
        assert db.scalar(select(CareTransferWorkItem.status).where(CareTransferWorkItem.id == first_id)) == "open"
        healthy = db.get(CareTransferWorkItem, second_id)
        assert (healthy.status, healthy.version, healthy.suspension_reason) == ("suspended", 2, "original_authority_invalid")
        facts = db.scalars(select(CareSystemEvent).where(CareSystemEvent.event_type == "transfer_work_authority_suspended")).all()
        assert len(facts) == 1 and facts[0].payload["work_item_id"] == second_id
        assert facts[0].payload["observation"]["code"] == "account_disabled"
    with SessionLocal() as db, pytest.raises(RecordIntegrityError):
        db.get(CareTransferWorkItem, first_id)
    assert maintain_once(SessionLocal, limit=1) == 0


def work_action(client, incoming, session, identifier, client_id):
    detail = client.get(f"/api/v1/care/transferred-work/{identifier}", headers=incoming)
    assert detail.status_code == 200, detail.text
    return {"patient_id": session["patient_id"], "work_item_id": identifier, "client_action_id": client_id,
            "expected_version": 1, "action": "acknowledge", "reason": None,
            "action_context": detail.json()["action_context"], "confirmed": True}


def test_independent_never_posted_successor_action_cannot_borrow_republished_original_receiving_head(client):
    owner, _, incoming, session, relation, _, identifier, _, _ = accepted_transfer(client)
    body = work_action(client, incoming, session, identifier, "quality-never-posted-before-regrant")
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_transfer import CareTransferWorkAction, CareTransferWorkItem
    from backend.app.models.identity import CareRelationship
    from backend.app.services import authorization_ledger
    with SessionLocal() as db:
        row = db.get(CareRelationship, relation["id"])
        authorization_ledger.deny(row)
        db.commit()
        authorization_ledger.publish(row)
    denied = client.post("/api/v1/care/transferred-work-actions", headers=incoming, json=body)
    assert denied.status_code in {403, 409}, denied.text
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CareTransferWorkAction)) == 0
        assert (db.get(CareTransferWorkItem, identifier).status, db.get(CareTransferWorkItem, identifier).version) == ("open", 1)
    assert client.get(f"/api/v1/care/transferred-work/{identifier}", headers=incoming).status_code in {403, 409}
    historical = client.get(f"/api/v1/care/transferred-work/{identifier}", headers=owner)
    assert historical.status_code == 200 and historical.json()["allowed_actions"] == [], historical.text


def test_independent_successor_action_commit_failure_discloses_no_ack_then_exact_id_recovers_once(client, monkeypatch):
    _, _, incoming, session, _, _, identifier, _, _ = accepted_transfer(client)
    body = work_action(client, incoming, session, identifier, "quality-work-action-failed-final-commit")
    from backend.app.services import care_transfer_work_service
    original = care_transfer_work_service.act
    def fail_after_action(db, *args):
        result = original(db, *args)
        def fail(*_):
            raise OSError("independent injected final work-action commit failure")
        event.listen(db, "before_commit", fail, once=True)
        return result
    monkeypatch.setattr(care_transfer_work_service, "act", fail_after_action)
    response = client.post("/api/v1/care/transferred-work-actions", headers=incoming, json=body)
    assert response.status_code == 503 and "action_id" not in response.text, response.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_transfer import CareTransferWorkAction, CareTransferWorkItem
    from backend.app.models.event import CareEvent
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CareTransferWorkAction)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "care_transfer_work_acknowledged")) == 0
        row = db.get(CareTransferWorkItem, identifier)
        assert (row.status, row.version) == ("open", 1)
    query = "/api/v1/care/transferred-work-actions/" + body["client_action_id"]
    assert client.get(query, headers=incoming).status_code == 404
    monkeypatch.setattr(care_transfer_work_service, "act", original)
    saved = client.post("/api/v1/care/transferred-work-actions", headers=incoming, json=body)
    assert saved.status_code == 201, saved.text
    assert client.get(query, headers=incoming).json() == saved.json()
    assert client.post("/api/v1/care/transferred-work-actions", headers=incoming, json=body).json() == saved.json()
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CareTransferWorkAction)) == 1
