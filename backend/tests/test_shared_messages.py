"""Synthetic temporary-DB tests for immutable relationship-bound shared messages."""
import importlib.util


def test_shared_message_core_is_explicitly_separate_from_legacy():
    assert importlib.util.find_spec("backend.app.models.shared_message") is not None, "Missing immutable relationship-bound shared-message model"
    assert importlib.util.find_spec("backend.app.services.care_message_service") is not None, "Missing transactional shared-message service"

import importlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select, text

from backend.tests.test_care_message_scope import message_world


@pytest.fixture
def world(client):
    from backend.app.db.session import SessionLocal, engine
    from backend.app.db.base import Base
    from backend.app.models.user import User
    model = importlib.import_module("backend.app.models.shared_message")
    schema = importlib.import_module("backend.app.schemas.shared_message")
    service = importlib.import_module("backend.app.services.care_message_service")
    Base.metadata.create_all(engine)
    return client, SessionLocal, model, schema, service, User


def actors(world, *, child=False):
    data, headers, pid, doctors = message_world(world[0], child=child)
    return data["user"]["id"], headers, pid, [(d[0]["user"]["id"], d[1], {**d[2],"patient_actor_user_id":data["user"]["id"]}) for d in doctors]


def payload(world, pid, rel, *, key="immutable-message", content="真实共享内容", sender_uid=None, **extra):
    with world[1]() as db:
        contexts = world[4].list_message_relationships(db,db.get(world[5],sender_uid or rel["patient_actor_user_id"]),pid)["items"]
        context = next(r["send_context"] for r in contexts if r["relationship_id"] == rel["id"])
    return world[3].SharedMessageCreate(patient_id=pid,relationship_id=rel["id"],client_message_id=key,content=content,confirmed=True,send_context=context,**extra)


def send(world, uid, body):
    with world[1]() as db:
        result = world[4].send_message(db, db.get(world[5],uid),body)
        db.commit()
        return result


def read(world, uid, pid, rid):
    with world[1]() as db:
        result = world[4].list_messages(db,db.get(world[5],uid),pid,rid)
        db.commit()
        return result


def test_two_doctors_are_distinct_and_fixed_sender_reply_scope(world):
    uid, _, pid, doctors = actors(world)
    doc_a, _, rel_a = doctors[0]
    doc_b, _, rel_b = doctors[1]
    ack, made = send(world,uid,payload(world,pid,rel_a))
    assert made and ack["sender_user_id"] == uid and ack["doctor_user_id"] == doc_a
    assert ack["patient_actor_user_id"] == uid and ack["relationship_revision"] == rel_a["revision"]
    assert ack["version"] == 1 and ack["submission_status"] == "committed" and not ack["legacy"]
    assert datetime.fromisoformat(ack["sent_at"]).utcoffset() == timedelta(0)
    assert read(world,doc_a,pid,rel_a["id"])["items"][0]["content"] == ack["content"]
    assert read(world,doc_b,pid,rel_b["id"])["items"] == []
    with pytest.raises(HTTPException) as error:
        read(world,doc_b,pid,rel_a["id"])
    assert error.value.status_code == 403
    reply,_ = send(world,doc_a,payload(world,pid,rel_a,key="doctor-reply",sender_uid=doc_a,reply_to_message_id=ack["message_id"]))
    assert reply["sender_kind"] == "doctor" and reply["sender_user_id"] == doc_a
    with pytest.raises(HTTPException) as error:
        send(world,doc_b,payload(world,pid,rel_b,key="cross-reply",sender_uid=doc_b,reply_to_message_id=ack["message_id"]))
    assert error.value.status_code in {403,409}


def test_global_id_exact_ack_retry_and_conflicting_owner_relation_content(world):
    uid, _, pid, doctors = actors(world)
    body = payload(world,pid,doctors[0][2])
    ack, _ = send(world,uid,body)
    again, made = send(world,uid,body)
    assert again == ack and made is False
    for sender, changed in ((uid,{"content":"changed"}),(uid,{"relationship_id":doctors[1][2]["id"]}),(doctors[0][0],{})):
        with pytest.raises(HTTPException) as error:
            send(world,sender,body.model_copy(update=changed))
        assert error.value.status_code == 409
    with world[1]() as db:
        original = world[4].get_original_message(db,db.get(world[5],uid),body.client_message_id)
        assert original == ack
        assert db.scalar(select(func.count()).select_from(world[2].SharedCareMessage)) == 1
        from backend.app.models.event import CareEvent
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "shared_message_sent")) == 1


def test_each_actual_viewer_has_one_read_receipt_without_resolution(world):
    uid, _, pid, doctors = actors(world)
    doctor, _, rel = doctors[0]
    ack,_ = send(world,uid,payload(world,pid,rel))
    receipts = []
    for reader in (uid,doctor,doctor):
        with world[1]() as db:
            result = world[4].mark_message_read(db,db.get(world[5],reader),ack["message_id"])
            db.commit()
            receipts.append(result)
    assert receipts[1] == receipts[2] and receipts[0]["viewer_user_id"] != receipts[1]["viewer_user_id"]
    with world[1]() as db:
        assert db.scalar(select(func.count()).select_from(world[2].SharedMessageRead)) == 2
    item = read(world,doctor,pid,rel["id"])["items"][0]
    assert item["viewer_read_at"] and len(item["read_receipts"]) == 2
    assert "resolved" not in item and "professionally_processed" not in item


def test_basic_withdraw_history_remains_but_retry_ack_and_newgrant_cannot_borrow(world):
    uid, headers, pid, doctors = actors(world)
    rel = doctors[0][2]
    body = payload(world,pid,rel)
    ack,_ = send(world,uid,body)
    basic = next(r for r in world[0].get("/api/v1/patient/consents",headers=headers).json()["items"] if r["purpose"] == "basic_use")
    response = world[0].post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=headers,json={"expected_revision":basic["revision"]})
    assert response.status_code == 200,response.text
    with world[1]() as db:
        historical = world[4].list_message_relationships(db,db.get(world[5],uid),pid)["items"]
        original = next(r for r in historical if r["relationship_id"] == rel["id"])
        assert original["can_send"] is False and original["send_context"] is None
    assert read(world,uid,pid,rel["id"])["items"][0]["message_id"] == ack["message_id"]
    assert query_original(world,uid,body.client_message_id) == ack
    with pytest.raises(HTTPException) as error:
        send(world,uid,body)
    assert error.value.status_code == 403
    grant = world[0].post("/api/v1/patient/consents",headers=headers,json={"patient_id":pid,"purpose":"basic_use","scope":basic["scope"],"terms_version":"W02-1"})
    assert grant.status_code == 201,grant.text
    assert query_original(world,uid,body.client_message_id) == ack
    with pytest.raises(HTTPException) as error:
        send(world,uid,body)
    assert error.value.status_code == 409
    assert read(world,uid,pid,rel["id"])["items"][0]["message_id"] == ack["message_id"]


def query_original(world,uid,key):
    with world[1]() as db:
        return world[4].get_original_message(db,db.get(world[5],uid),key)


def test_revoked_relationship_and_regrant_same_doctor_do_not_reclaim_old_messages(world):
    uid, headers, pid, doctors = actors(world)
    doctor, doctor_headers, rel = doctors[0]
    send(world,uid,payload(world,pid,rel))
    from backend.app.models.identity import CareRelationship
    from backend.app.services import authorization_ledger as ledger
    with world[1]() as db:
        row = db.get(CareRelationship,rel["id"])
        ledger.deny(row)
        row.status = "revoked"
        db.commit()
    assert len(read(world,uid,pid,rel["id"])["items"]) == 1
    with world[1]() as db:
        historical = world[4].list_message_relationships(db,db.get(world[5],uid),pid)["items"]
        original = next(r for r in historical if r["relationship_id"] == rel["id"])
        assert original["can_send"] is False and original["send_context"] is None
        doctor_list = world[4].list_message_relationships(db,db.get(world[5],doctor),pid)["items"]
        assert all(r["relationship_id"] != rel["id"] for r in doctor_list)
    with pytest.raises(HTTPException) as error:
        read(world,doctor,pid,rel["id"])
    assert error.value.status_code == 403
    from backend.tests.w02_helpers import grant_synthetic_patient_authority
    grant_synthetic_patient_authority(pid,doctor)
    with world[1]() as db:
        new_rel = db.scalar(select(CareRelationship).where(CareRelationship.doctor_user_id == doctor,CareRelationship.status == "active"))
        new_id = new_rel.id
    assert new_id != rel["id"] and read(world,doctor,pid,new_id)["items"] == []
    with pytest.raises(HTTPException):
        read(world,doctor,pid,rel["id"])


def test_guardian_basis_and_lifecycle_loss_block_send_and_history(world):
    uid, _, pid, doctors = actors(world,child=True)
    body = payload(world,pid,doctors[0][2])
    ack,_ = send(world,uid,body)
    assert ack["sender_identity_basis"].startswith("guardian:")
    from backend.app.models.identity import GuardianRelationship
    from backend.app.services import authorization_ledger as ledger
    with world[1]() as db:
        guardian = db.scalar(select(GuardianRelationship).where(GuardianRelationship.patient_id == pid))
        ledger.deny(guardian)
        guardian.status = "revoked"
        db.commit()
    for operation in (lambda:send(world,uid,body),lambda:read(world,uid,pid,doctors[0][2]["id"]),lambda:read(world,doctors[0][0],pid,doctors[0][2]["id"])):
        with pytest.raises(HTTPException) as error:
            operation()
        assert error.value.status_code == 403


@pytest.mark.parametrize("mutation",["content='tampered'","relationship_revision=999","authorization_snapshot='[]'","sender_user_id=doctor_user_id","envelope_status='legacy'","version=2","content_digest='tampered'","confirmed=0"])
def test_cipher_and_original_authenticated_context_tampering_fail_closed(world,mutation):
    uid, _, pid, doctors = actors(world)
    ack,_ = send(world,uid,payload(world,pid,doctors[0][2]))
    from backend.app.core.record_envelope import RecordIntegrityError
    with world[1]() as db:
        raw = db.execute(text("SELECT content FROM shared_care_messages WHERE id=:id"),{"id":ack["message_id"]}).scalar_one()
        assert raw.startswith("aesgcm:v2:") and "真实" not in raw
        db.execute(text("UPDATE shared_care_messages SET "+mutation+" WHERE id=:id"),{"id":ack["message_id"]})
        db.commit()
    with pytest.raises(RecordIntegrityError):
        read(world,uid,pid,doctors[0][2]["id"])


@pytest.mark.parametrize("field,value",[("content","rewritten"),("envelope_status","legacy"),("relationship_id",999),("version",2)])
def test_committed_original_cannot_be_rewritten_with_orm(world,field,value):
    uid, _, pid, doctors = actors(world)
    ack,_ = send(world,uid,payload(world,pid,doctors[0][2]))
    with world[1]() as db:
        row = db.get(world[2].SharedCareMessage,ack["message_id"])
        setattr(row,field,value)
        with pytest.raises(ValueError,match="immutable"):
            db.flush()
        db.rollback()
    assert read(world,uid,pid,doctors[0][2]["id"])["items"][0]["content"] == ack["content"]


def test_business_event_audit_rollback_and_critical_audit_failure(world,monkeypatch):
    uid, _, pid, doctors = actors(world)
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    with world[1]() as db:
        before = db.scalar(select(func.count()).select_from(SecurityAuditLog))
    with world[1]() as db:
        ack,_ = world[4].send_message(db,db.get(world[5],uid),payload(world,pid,doctors[0][2]))
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog)) == before+1
        db.rollback()
    with world[1]() as db:
        assert db.scalar(select(func.count()).select_from(world[2].SharedCareMessage)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "shared_message_sent")) == 0
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog)) == before
    ack,_ = send(world,uid,payload(world,pid,doctors[0][2]))
    from backend.app.services import security_service
    def fail(*args,**kwargs):
        raise RuntimeError("synthetic unavailable critical audit")
    audit_body = payload(world,pid,doctors[0][2],key="audit-failed")
    monkeypatch.setattr(security_service,"_append_audit_log",fail)
    for operation in (lambda:read(world,uid,pid,doctors[0][2]["id"]),lambda:send(world,uid,audit_body)):
        with pytest.raises(HTTPException) as error:
            operation()
        assert error.value.status_code == 503
    with world[1]() as db:
        assert db.scalar(select(func.count()).select_from(world[2].SharedCareMessage)) == 1
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "shared_message_sent")) == 1


def test_payload_rejects_identity_status_private_ai_and_doctor_requires_confirmation(world):
    uid, _, pid, doctors = actors(world)
    body = payload(world,pid,doctors[0][2])
    for field,value in (("sender_user_id",uid),("status","sent"),("doctor_user_id",doctors[1][0]),("private_ai_transcript","secret"),("draft_id",1)):
        with pytest.raises(ValidationError):
            world[3].SharedMessageCreate.model_validate({**body.model_dump(),field:value})
    with pytest.raises(ValidationError):
        world[3].SharedMessageCreate.model_validate({**body.model_dump(),"confirmed":"true"})
    with pytest.raises(HTTPException) as error:
        send(world,doctors[0][0],body.model_copy(update={"confirmed":False}))
    assert error.value.status_code == 422
    with world[1]() as db:
        relation_list = world[4].list_message_relationships(db,db.get(world[5],uid),pid)
        assert {r["relationship_id"] for r in relation_list["items"]} == {d[2]["id"] for d in doctors}


def test_unposted_queued_original_cannot_borrow_new_basic_grant_and_context_cannot_be_forged(world):
    uid, headers, pid, doctors = actors(world)
    body = payload(world,pid,doctors[0][2],key="queued-before-revoke")
    basic = next(r for r in world[0].get("/api/v1/patient/consents",headers=headers).json()["items"] if r["purpose"] == "basic_use")
    response = world[0].post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=headers,json={"expected_revision":basic["revision"]})
    assert response.status_code == 200,response.text
    grant = world[0].post("/api/v1/patient/consents",headers=headers,json={"patient_id":pid,"purpose":"basic_use","scope":basic["scope"],"terms_version":"W02-1"})
    assert grant.status_code == 201,grant.text
    with pytest.raises(HTTPException) as error:
        send(world,uid,body)
    assert error.value.status_code in {403,409}
    with world[1]() as db:
        assert db.scalar(select(func.count()).select_from(world[2].SharedCareMessage)) == 0
    with pytest.raises(HTTPException) as error:
        send(world,uid,body.model_copy(update={"send_context":body.send_context[:-1]+("A" if body.send_context[-1] != "A" else "B")}))
    assert error.value.status_code == 403
    fresh = payload(world,pid,doctors[0][2],key="fresh-new-grant")
    assert send(world,uid,fresh)[1] is True
    with pytest.raises(HTTPException) as error:
        send(world,doctors[0][0],body.model_copy(update={"client_message_id":"stolen-actor"}))
    assert error.value.status_code == 403


def test_final_caller_commit_rechecks_original_ledger_and_rolls_back_every_fact(world):
    uid, _, pid, doctors = actors(world)
    body = payload(world,pid,doctors[0][2],key="commit-race")
    from sqlalchemy import event
    from backend.app.services.identity_access import recheck_request_authority
    from backend.app.models.consent import ConsentRecord
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    from backend.app.services import authorization_ledger as ledger
    with world[1]() as db:
        before = db.scalar(select(func.count()).select_from(SecurityAuditLog))
    with world[1]() as db:
        # The production get_db dependency installs this same final-commit check.
        event.listen(db,"before_commit",lambda *_:recheck_request_authority(db))
        world[4].send_message(db,db.get(world[5],uid),body)
        with world[1]() as revoker:
            original = revoker.scalar(select(ConsentRecord).where(ConsentRecord.patient_id == pid,ConsentRecord.purpose == "basic_use",ConsentRecord.status == "active"))
            ledger.deny(original)
            # Independent ledger denial is authoritative even if its business
            # revision transaction has not committed (or subsequently fails).
        with pytest.raises(HTTPException) as error:
            db.commit()
        assert error.value.status_code == 403
        db.rollback()
    with world[1]() as db:
        assert db.scalar(select(func.count()).select_from(world[2].SharedCareMessage)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "shared_message_sent")) == 0
        assert db.scalar(select(func.count()).select_from(SecurityAuditLog)) == before


def test_cipher_cannot_be_copied_between_actual_objects_and_legacy_ai_are_not_sources(world):
    uid, _, pid, doctors = actors(world)
    from backend.app.models.care_message import CareMessage
    from backend.app.models.ai_chat_log import AIChatLog
    with world[1]() as db:
        db.add(CareMessage(patient_id=pid,sender_user_id=uid,sender_role="patient",content="UNKNOWN LEGACY RELATIONSHIP"))
        db.add(AIChatLog(patient_id=pid,role="user",scope="general",content="PRIVATE AI NEVER SHARE"))
        db.commit()
    assert read(world,uid,pid,doctors[0][2]["id"])["items"] == []
    one,_ = send(world,uid,payload(world,pid,doctors[0][2],key="aad-one"))
    two,_ = send(world,uid,payload(world,pid,doctors[0][2],key="aad-two"))
    from backend.app.core.record_envelope import RecordIntegrityError
    with world[1]() as db:
        db.execute(text("UPDATE shared_care_messages SET content=(SELECT content FROM shared_care_messages WHERE id=:source) WHERE id=:target"),{"source":one["message_id"],"target":two["message_id"]})
        db.commit()
    with pytest.raises(RecordIntegrityError):
        read(world,uid,pid,doctors[0][2]["id"])


def test_read_receipt_audit_failure_rolls_back_receipt_event_and_no_disclosure(world,monkeypatch):
    uid, _, pid, doctors = actors(world)
    ack,_ = send(world,uid,payload(world,pid,doctors[0][2]))
    from backend.app.services import security_service
    from backend.app.models.event import CareEvent
    def fail(*args,**kwargs):
        raise RuntimeError("synthetic critical read-receipt audit failure")
    monkeypatch.setattr(security_service,"_append_audit_log",fail)
    with world[1]() as db:
        with pytest.raises(HTTPException) as error:
            world[4].mark_message_read(db,db.get(world[5],doctors[0][0]),ack["message_id"])
        assert error.value.status_code == 503
        db.rollback()
    with world[1]() as db:
        assert db.scalar(select(func.count()).select_from(world[2].SharedMessageRead)) == 0
        assert db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "shared_message_read")) == 0


def test_server_context_digest_metadata_and_original_clinical_purpose(world):
    uid, _, pid, doctors = actors(world)
    from backend.app.services.cognitive_contract import canonical_digest
    with world[1]() as db:
        item = world[4].list_message_relationships(db,db.get(world[5],uid),pid)["items"][0]
        assert item["send_context_digest"] == canonical_digest(item["send_context"])
    body = payload(world,pid,doctors[0][2],key="purpose-bound")
    from backend.app.models.identity import CareRelationship
    with world[1]() as db:
        rel = db.get(CareRelationship,doctors[0][2]["id"])
        rel.purpose = "research"
        db.commit()
    with pytest.raises(HTTPException) as error:
        send(world,uid,body)
    assert error.value.status_code == 403
