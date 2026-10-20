"""Independent W05 message scope review: disposable DB, ledger and synthetic identities."""
from sqlalchemy import event, func, select, text
from sqlalchemy.orm import Session

from backend.tests.test_care_message_scope import message_world


def context(client, headers, patient_id, relationship_id):
    response = client.get(f"/api/v1/care/shared-messages/relationships?patient_id={patient_id}", headers=headers)
    assert response.status_code == 200, response.text
    return next(row["send_context"] for row in response.json()["items"] if row["relationship_id"] == relationship_id)


def body(patient_id, relationship_id, token, key):
    return {"patient_id": patient_id, "relationship_id": relationship_id, "send_context": token,
        "content": "INDEPENDENT SYNTHETIC PRIVATE MESSAGE", "confirmed": True, "client_message_id": key}


def test_first_post_cannot_swap_actual_account_or_recipient_context(client):
    _, owner, patient_id, doctors = message_world(client)
    token = context(client, owner, patient_id, doctors[0][2]["id"])
    original = body(patient_id, doctors[0][2]["id"], token, "spec-original-context")
    for headers, change in ((doctors[0][1], {}), (owner, {"relationship_id": doctors[1][2]["id"]})):
        response = client.post("/api/v1/care/shared-messages", headers=headers, json={**original, **change})
        assert response.status_code == 403, response.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.shared_message import SharedCareMessage
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SharedCareMessage)) == 0
    response = client.post("/api/v1/care/shared-messages", headers=owner, json=original)
    assert response.status_code == 201, response.text
    other_token = context(client, doctors[1][1], patient_id, doctors[1][2]["id"])
    cross_reply = {**body(patient_id, doctors[1][2]["id"], other_token, "spec-cross-reply"),
        "reply_to_message_id": response.json()["message_id"]}
    rejected = client.post("/api/v1/care/shared-messages", headers=doctors[1][1], json=cross_reply)
    assert rejected.status_code == 409, rejected.text


def test_final_commit_rechecks_original_context_and_rolls_back_fact_event_audit(client, monkeypatch):
    _, owner, patient_id, doctors = message_world(client)
    original = body(patient_id, doctors[0][2]["id"], context(client, owner, patient_id, doctors[0][2]["id"]), "spec-final-commit-denied")
    from backend.app.db.session import SessionLocal
    from backend.app.models.shared_message import SharedCareMessage
    from backend.app.models.event import CareEvent
    from backend.app.models.identity import CareRelationship
    from backend.app.models.security import SecurityAuditLog
    from backend.app.services import authorization_ledger, care_message_service
    real_send = care_message_service.send_message

    def deny_after_facts(*args, **kwargs):
        result = real_send(*args, **kwargs)
        with SessionLocal() as authority_db:
            authorization_ledger.deny(authority_db.get(CareRelationship, doctors[0][2]["id"]))
        return result

    monkeypatch.setattr(care_message_service, "send_message", deny_after_facts)
    response = client.post("/api/v1/care/shared-messages", headers=owner, json=original)
    assert response.status_code == 403, response.text
    assert original["content"] not in response.text
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SharedCareMessage)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "shared_message_sent")) == 0
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog).where(SecurityAuditLog.action == "shared_message_sent")) == 0


def test_all_message_read_paths_fail_closed_when_final_critical_commit_fails(client):
    owner_data, owner, patient_id, doctors = message_world(client)
    original = body(patient_id, doctors[0][2]["id"], context(client, owner, patient_id, doctors[0][2]["id"]), "spec-critical-read-commit")
    sent = client.post("/api/v1/care/shared-messages", headers=owner, json=original)
    assert sent.status_code == 201, sent.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_message import CareMessage
    from backend.app.models.shared_message import SharedMessageRead
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    critical_read_actions = ("shared_message_relationships_read", "shared_messages_read", "shared_message_original_ack_read",
        "shared_message_read_receipt", "legacy_messages_read", "legacy_messages_scope_unverified", "care_shared_message_summary_read")
    with SessionLocal() as db:
        db.add(CareMessage(patient_id=patient_id, sender_user_id=owner_data["user"]["id"], sender_role="patient", content=original["content"]))
        db.commit()
        before_audits = db.scalar(select(func.count()).select_from(SecurityAuditLog).where(SecurityAuditLog.action.in_(critical_read_actions)))

    failed_paths = []

    def fail_commit(db):
        request = db.info.get("authorization_request")
        if request is not None and request.url.path.startswith("/api/v1/care/"):
            failed_paths.append(request.url.path)
            raise OSError("Independent synthetic final commit outage")

    event.listen(Session, "before_commit", fail_commit)
    try:
        for method, headers, path in (
            ("get", owner, f"/api/v1/care/shared-messages/relationships?patient_id={patient_id}"),
            ("get", owner, f"/api/v1/care/shared-messages?patient_id={patient_id}&relationship_id={doctors[0][2]['id']}"),
            ("get", owner, "/api/v1/care/shared-messages/submissions/spec-critical-read-commit"),
            ("post", doctors[0][1], f"/api/v1/care/shared-messages/{sent.json()['message_id']}/read"),
            ("get", owner, "/api/v1/care/patient/messages"),
            ("get", owner, "/api/v1/care/patient/summary"),
            ("get", doctors[0][1], f"/api/v1/care/doctor/patient/{patient_id}/messages"),
            ("get", doctors[0][1], f"/api/v1/care/doctor/patient/{patient_id}/summary"),
        ):
            response = getattr(client, method)(path, headers=headers)
            assert response.status_code == 503, (path, response.text)
            assert original["content"] not in response.text
            assert "items" not in response.json()
    finally:
        event.remove(Session, "before_commit", fail_commit)
    assert len(failed_paths) == 8
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SharedMessageRead)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "shared_message_read")) == 0
        # The independent ordinary HTTP failure audit is allowed to persist;
        # no provisional sensitive-read critical audit may survive its failed commit.
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog).where(SecurityAuditLog.action.in_(critical_read_actions))) == before_audits


def test_nonclinical_original_purpose_never_becomes_a_clinical_message_scope(client):
    _, owner, patient_id, doctors = message_world(client)
    rid = doctors[0][2]["id"]
    original = body(patient_id, rid, context(client, owner, patient_id, rid), "spec-purpose-bound")
    saved = client.post("/api/v1/care/shared-messages", headers=owner, json=original)
    assert saved.status_code == 201, saved.text
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        db.execute(text("UPDATE care_relationships SET purpose='research' WHERE id=:id"), {"id": rid})
        db.commit()
    url = f"/api/v1/care/shared-messages?patient_id={patient_id}&relationship_id={rid}"
    assert client.get(url, headers=doctors[0][1]).status_code == 403
    assert client.post("/api/v1/care/shared-messages", headers=owner, json={**original, "client_message_id": "spec-purpose-first-post"}).status_code == 403
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/summary", headers=doctors[0][1]).status_code == 403
    history = client.get(url, headers=owner)
    assert history.status_code == 200 and history.json()["items"][0]["message_id"] == saved.json()["message_id"]


def test_actual_read_receipt_envelope_cannot_move_between_messages(client):
    _, owner, patient_id, doctors = message_world(client)
    rid = doctors[0][2]["id"]
    token = context(client, owner, patient_id, rid)
    ids = []
    for index in range(2):
        response = client.post("/api/v1/care/shared-messages", headers=owner, json=body(patient_id, rid, token, "spec-receipt-" + str(index)))
        assert response.status_code == 201, response.text
        ids.append(response.json()["message_id"])
        read = client.post(f"/api/v1/care/shared-messages/{ids[-1]}/read", headers=doctors[0][1])
        assert read.status_code == 200, read.text
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        db.execute(text("UPDATE shared_message_reads SET snapshot=(SELECT snapshot FROM shared_message_reads WHERE message_id=:one) WHERE message_id=:two"), {"one": ids[0], "two": ids[1]})
        db.commit()
    for path in (f"/api/v1/care/shared-messages?patient_id={patient_id}&relationship_id={rid}", f"/api/v1/care/doctor/patient/{patient_id}/summary"):
        response = client.get(path, headers=doctors[0][1])
        assert response.status_code == 503, response.text
        assert "INDEPENDENT SYNTHETIC PRIVATE MESSAGE" not in response.text
