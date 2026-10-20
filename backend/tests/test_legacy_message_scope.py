"""Actual HTTP compatibility boundaries for unbound legacy message history."""
import pytest
from sqlalchemy import select

from backend.tests.test_care_message_scope import message_world


def seed_legacy(pid, sender_id, role="researcher"):
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_message import CareMessage
    with SessionLocal() as db:
        row = CareMessage(patient_id=pid, sender_user_id=sender_id,
            sender_role=role, content="Synthetic legacy history: original relationship unknown")
        db.add(row)
        db.commit()
        return row.id


def send_scoped(client, headers, pid, rid, key):
    contexts = client.get(f"/api/v1/care/shared-messages/relationships?patient_id={pid}", headers=headers)
    assert contexts.status_code == 200, contexts.text
    context = next(row["send_context"] for row in contexts.json()["items"] if row["relationship_id"] == rid)
    response = client.post("/api/v1/care/shared-messages", headers=headers, json={
        "patient_id":pid, "relationship_id":rid, "content":"Synthetic scoped message",
        "client_message_id":key, "confirmed":True, "send_context":context})
    assert response.status_code == 201, response.text
    return response.json()


def test_both_legacy_posts_require_explicit_new_relationship(client):
    _, owner, pid, doctors = message_world(client)
    for headers, path in ((owner,"/api/v1/care/patient/messages"),
            (doctors[0][1],f"/api/v1/care/doctor/patient/{pid}/messages")):
        response = client.post(path, headers=headers, json={"content":"Do not create unbound data", "client_message_id":"legacy-disabled"})
        assert response.status_code == 409, response.text
        assert "shared-messages" in response.json()["detail"]
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_message import CareMessage
    with SessionLocal() as db:
        assert db.scalar(select(CareMessage)) is None


@pytest.mark.parametrize("child", [False, True])
def test_legacy_unknown_scope_retains_own_history_and_excludes_all_doctors(client, child):
    _, owner, pid, doctors = message_world(client, child=child)
    row_id = seed_legacy(pid, doctors[0][0]["user"]["id"])
    own = client.get("/api/v1/care/patient/messages", headers=owner)
    assert own.status_code == 200, own.text
    assert own.json()["legacy_scope_status"] == "own_history_only"
    assert own.json()["items"][0]["id"] == row_id
    assert own.json()["items"][0]["legacy"] is True
    for _, headers, _ in doctors:
        other = client.get(f"/api/v1/care/doctor/patient/{pid}/messages", headers=headers)
        assert other.status_code == 200, other.text
        assert other.json()["items"] == []
        assert other.json()["legacy_scope_status"] == "unverified_relationship"
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_message import CareMessage
    with SessionLocal() as db:
        assert db.get(CareMessage,row_id).content.startswith("Synthetic legacy history")


def test_legacy_read_routes_never_write_role_shared_read_receipts(client):
    data, owner, pid, doctors = message_world(client)
    legacy_id = seed_legacy(pid,data["user"]["id"],"patient")
    for headers, path in ((owner,"/api/v1/care/patient/messages/read"),
            (doctors[0][1],f"/api/v1/care/doctor/patient/{pid}/messages/read")):
        response = client.post(path, headers=headers)
        assert response.status_code == 409, response.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_message import CareMessage
    with SessionLocal() as db:
        row = db.get(CareMessage,legacy_id)
        assert row.read_by_researcher_at is None and row.read_by_patient_at is None


def test_summary_counts_only_actual_viewer_accessible_scoped_unread(client):
    data, owner, pid, doctors = message_world(client)
    seed_legacy(pid,data["user"]["id"],"patient")
    seed_legacy(pid,doctors[0][0]["user"]["id"])
    sent = send_scoped(client,owner,pid,doctors[0][2]["id"],"summary-original-a")
    paths = [f"/api/v1/care/doctor/patient/{pid}/summary"] * 2
    for (_, headers, _), path, expected in zip(doctors,paths,[1,0]):
        summary = client.get(path,headers=headers)
        assert summary.status_code == 200, summary.text
        assert summary.json()["unread_message_count"] == expected
        assert summary.json()["unread_message_scope"] == "accessible_shared_messages_actual_viewer"
    assert client.post(f"/api/v1/care/shared-messages/{sent['message_id']}/read",headers=doctors[1][1]).status_code == 403
    assert client.get(paths[0],headers=doctors[0][1]).json()["unread_message_count"] == 1
    assert client.post(f"/api/v1/care/shared-messages/{sent['message_id']}/read",headers=doctors[0][1]).status_code == 200
    assert client.get(paths[0],headers=doctors[0][1]).json()["unread_message_count"] == 0
    reply = send_scoped(client,doctors[0][1],pid,doctors[0][2]["id"],"summary-reply-a")
    assert client.get("/api/v1/care/patient/summary",headers=owner).json()["unread_message_count"] == 1
    assert client.post(f"/api/v1/care/shared-messages/{reply['message_id']}/read",headers=owner).status_code == 200
    assert client.get("/api/v1/care/patient/summary",headers=owner).json()["unread_message_count"] == 0


def test_legacy_own_history_survives_basic_withdrawal_but_not_guardian_loss(client):
    data, owner, pid, doctors = message_world(client,child=True)
    seed_legacy(pid,doctors[0][0]["user"]["id"])
    basic = next(r for r in client.get("/api/v1/patient/consents",headers=owner).json()["items"] if r["purpose"] == "basic_use" and r["status"] == "active")
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=owner,json={"expected_revision":basic["revision"]}).status_code == 200
    assert len(client.get("/api/v1/care/patient/messages",headers=owner).json()["items"]) == 1
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import GuardianRelationship
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        guardian = db.scalar(select(GuardianRelationship).where(GuardianRelationship.patient_id == pid))
        ledger.deny(guardian)
        guardian.status = "revoked"
        db.commit()
    assert client.get("/api/v1/care/patient/messages",headers=owner).status_code == 403


def test_critical_audit_failure_blocks_legacy_history_and_summary(client, monkeypatch):
    _, owner, pid, doctors = message_world(client)
    seed_legacy(pid,doctors[0][0]["user"]["id"])
    from backend.app.services import security_service
    def fail(*args,**kwargs):
        raise RuntimeError("Synthetic audit outage")
    monkeypatch.setattr(security_service,"_append_audit_log",fail)
    for headers,path in ((owner,"/api/v1/care/patient/messages"),(owner,"/api/v1/care/patient/summary"),
            (doctors[0][1],f"/api/v1/care/doctor/patient/{pid}/messages"),
            (doctors[0][1],f"/api/v1/care/doctor/patient/{pid}/summary")):
        response = client.get(path,headers=headers)
        assert response.status_code == 503, response.text
        assert "Synthetic legacy history" not in response.text


def test_summary_regrant_keeps_new_scope_without_claiming_old_and_own_keeps_history(client):
    _, owner, pid, doctors = message_world(client)
    doctor_data, doctor, original = doctors[0]
    old = send_scoped(client,owner,pid,original["id"],"summary-before-revoke")
    revoked = client.post(f"/api/v1/care/relationships/{original['id']}/revoke",headers=owner,
        json={"expected_revision":original["revision"]})
    assert revoked.status_code == 200, revoked.text
    invited = client.post("/api/v1/care/relationships/invitations",headers=doctor,
        json={"target_email":client.get("/api/v1/auth/me",headers=owner).json()["email"],
            "patient_id":pid,"scope":["profile","care"],"purpose":"clinical_sharing"})
    assert invited.status_code == 201, invited.text
    accepted = client.post(f"/api/v1/care/relationships/{invited.json()['id']}/accept",headers=owner,
        json={"expected_revision":invited.json()["revision"]})
    assert accepted.status_code == 200, accepted.text
    fresh = send_scoped(client,owner,pid,accepted.json()["id"],"summary-after-regrant")
    summary = client.get(f"/api/v1/care/doctor/patient/{pid}/summary",headers=doctor)
    assert summary.status_code == 200 and summary.json()["unread_message_count"] == 1, summary.text
    assert client.post(f"/api/v1/care/shared-messages/{old['message_id']}/read",headers=doctor).status_code == 403
    assert client.post(f"/api/v1/care/shared-messages/{fresh['message_id']}/read",headers=doctor).status_code == 200
    assert client.get(f"/api/v1/care/doctor/patient/{pid}/summary",headers=doctor).json()["unread_message_count"] == 0
    assert client.get(f"/api/v1/care/shared-messages?patient_id={pid}&relationship_id={original['id']}",headers=owner).json()["items"][0]["message_id"] == old["message_id"]


def test_summary_integrity_failure_is_not_silently_skipped_as_unauthorized(client):
    from sqlalchemy import text
    _, owner, pid, doctors = message_world(client)
    sent = send_scoped(client,owner,pid,doctors[0][2]["id"],"summary-integrity")
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        db.execute(text("UPDATE shared_care_messages SET relationship_revision=999 WHERE id=:id"),{"id":sent["message_id"]})
        db.commit()
    summary = client.get(f"/api/v1/care/doctor/patient/{pid}/summary",headers=doctors[0][1])
    assert summary.status_code == 503, summary.text
    assert "unread_message_count" not in summary.json()


def test_legacy_and_summary_critical_audits_are_persisted_before_disclosure(client):
    _, owner, pid, doctors = message_world(client)
    seed_legacy(pid,doctors[0][0]["user"]["id"])
    assert client.get("/api/v1/care/patient/messages",headers=owner).status_code == 200
    assert client.get(f"/api/v1/care/doctor/patient/{pid}/messages",headers=doctors[0][1]).status_code == 200
    assert client.get("/api/v1/care/patient/summary",headers=owner).status_code == 200
    from backend.app.db.session import SessionLocal
    from backend.app.models.security import SecurityAuditLog
    with SessionLocal() as db:
        actions = db.scalars(select(SecurityAuditLog.action).where(SecurityAuditLog.patient_id == pid)).all()
        for expected in ("legacy_messages_read","legacy_messages_scope_unverified","care_shared_message_summary_read"):
            assert expected in actions
