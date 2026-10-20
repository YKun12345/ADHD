"""Independent quality probes; only synthetic identities and fixture-isolated stores."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import event, func, select, text
from sqlalchemy.orm import Session

from backend.tests.test_care_message_scope import message_world
from backend.tests.test_w05_shared_spec import body, context


def test_send_final_commit_outage_rolls_back_and_same_original_recovers_exactly_once(client):
    _, owner, patient_id, doctors = message_world(client)
    rid = doctors[0][2]["id"]
    original = body(patient_id, rid, context(client, owner, patient_id, rid), "quality-commit-recovery")
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    from backend.app.models.shared_message import SharedCareMessage

    hits = []

    def fail_commit(db):
        request = db.info.get("authorization_request")
        if request is not None and request.url.path == "/api/v1/care/shared-messages":
            hits.append(request.url.path)
            raise OSError("independent synthetic final send commit outage")

    event.listen(Session, "before_commit", fail_commit)
    try:
        rejected = client.post("/api/v1/care/shared-messages", headers=owner, json=original)
        assert rejected.status_code == 503, rejected.text
        assert original["content"] not in rejected.text
        assert "message_id" not in rejected.json()
    finally:
        event.remove(Session, "before_commit", fail_commit)
    assert hits == ["/api/v1/care/shared-messages"]
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SharedCareMessage)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "shared_message_sent")) == 0
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog).where(SecurityAuditLog.action == "shared_message_sent")) == 0
    assert client.get("/api/v1/care/shared-messages/submissions/" + original["client_message_id"], headers=owner).status_code == 404
    first = client.post("/api/v1/care/shared-messages", headers=owner, json=original)
    assert first.status_code == 201, first.text
    retry = client.post("/api/v1/care/shared-messages", headers=owner, json=original)
    recovered = client.get("/api/v1/care/shared-messages/submissions/" + original["client_message_id"], headers=owner)
    assert retry.status_code == recovered.status_code == 200
    assert first.json() == retry.json() == recovered.json()
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SharedCareMessage)) == 1
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "shared_message_sent")) == 1
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog).where(SecurityAuditLog.action == "shared_message_sent")) == 1


def test_own_history_and_summary_survive_original_doctor_qualification_expiry(client):
    _, owner, patient_id, doctors = message_world(client)
    doctor_data, doctor, relationship = doctors[0]
    rid = relationship["id"]
    sent = client.post("/api/v1/care/shared-messages", headers=doctor,
        json=body(patient_id, rid, context(client, doctor, patient_id, rid), "quality-expired-doctor-history"))
    assert sent.status_code == 201, sent.text
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        db.execute(text("UPDATE doctor_qualifications SET expires_at=:expiry WHERE user_id=:id"),
            {"expiry": datetime.now(timezone.utc) - timedelta(seconds=1), "id": doctor_data["user"]["id"]})
        db.commit()
    scope = f"/api/v1/care/shared-messages?patient_id={patient_id}&relationship_id={rid}"
    assert client.get(scope, headers=doctor).status_code == 403
    selection = client.get(f"/api/v1/care/shared-messages/relationships?patient_id={patient_id}", headers=owner)
    assert selection.status_code == 200, selection.text
    old = next(row for row in selection.json()["items"] if row["relationship_id"] == rid)
    assert old["can_send"] is False and old["send_context"] is None and old["send_context_digest"] is None
    history = client.get(scope, headers=owner)
    assert history.status_code == 200 and history.json()["items"][0]["message_id"] == sent.json()["message_id"]
    summary = client.get("/api/v1/care/patient/summary", headers=owner)
    assert summary.status_code == 200 and summary.json()["unread_message_count"] == 1
    viewed = client.post(f"/api/v1/care/shared-messages/{sent.json()['message_id']}/read", headers=owner)
    assert viewed.status_code == 200, viewed.text
    summary = client.get("/api/v1/care/patient/summary", headers=owner)
    assert summary.status_code == 200 and summary.json()["unread_message_count"] == 0
