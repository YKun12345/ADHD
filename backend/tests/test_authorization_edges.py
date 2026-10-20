from datetime import datetime, timedelta, timezone
import sqlite3

from backend.tests.w02_helpers import register, qualify, invite


def account_only(client, email):
    response = client.post("/api/v1/auth/register",json={"email":email,"password":"Synthetic123!","full_name":"Independent New Actor","role":"patient","consent_agreed":True,"account_only":True})
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["user"]["patient_profile"] is None
    return data, {"Authorization":"Bearer " + data["access_token"]}


def active_care(client, suffix="edge", scope=None):
    doctor, clinician = register(client, f"doctor-{suffix}@example.com", "researcher")
    patient, owner = register(client, f"patient-{suffix}@example.com")
    qualify(doctor["user"]["id"])
    pid = patient["user"]["patient_profile"]["id"]
    response = client.post("/api/v1/care/relationships/invitations", headers=clinician, json={"target_email":patient["user"]["email"],"patient_id":pid,"scope":scope or ["profile","assessment","tracking","care","imaging"],"purpose":"clinical_sharing"})
    assert response.status_code == 201, response.text
    relationship = response.json()
    accepted = client.post(f"/api/v1/care/relationships/{relationship['id']}/accept", headers=owner, json={"expected_revision":1})
    assert accepted.status_code == 200, accepted.text
    return doctor, clinician, patient, owner, pid, accepted.json()


def verified_guardian(client, suffix="guardian"):
    child, guardian = register(client, f"{suffix}@example.com", child=True)
    reviewer, reviewer_headers = register(client, f"reviewer-{suffix}@example.com", "researcher")
    qualify(reviewer["user"]["id"], reviewer=True)
    context = client.get("/api/v1/identity/context", headers=guardian)
    assert context.status_code == 200
    relationship = context.json()["guardian_relationships"][0]
    response = client.post(f"/api/v1/identity/guardians/{relationship['id']}/review", headers=reviewer_headers, json={"expected_revision":1,"status":"verified","expires_at":"2090-01-01T00:00:00Z","review_reference":"synthetic-review"})
    assert response.status_code == 200, response.text
    return child, guardian, reviewer_headers, response.json()


def test_qualification_expiry_and_scope_restrict_all_clinical_surfaces(client):
    doctor, clinician, _, _, pid, _ = active_care(client, scope=["care"])
    assert client.get(f"/api/v1/care/doctor/patient/{pid}/messages", headers=clinician).status_code == 200
    assert client.get(f"/api/v1/doctor/patient/{pid}/report", headers=clinician).status_code == 403
    assert client.post("/api/v1/imaging/session", headers=clinician, json={"patient_id":pid}).status_code == 403
    assert client.get(f"/api/v1/care/doctor/patient/{pid}/ai_logs", headers=clinician).status_code == 403
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification
    from sqlalchemy import select
    with SessionLocal() as db:
        db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == doctor["user"]["id"])).expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    assert client.get(f"/api/v1/care/doctor/patient/{pid}/messages", headers=clinician).status_code == 403


def test_guardian_suspend_restore_keeps_history_and_blocks_old_grants(client):
    _, guardian, reviewer, row = verified_guardian(client)
    queue = client.get("/api/v1/identity/guardians/review_queue", headers=reviewer)
    assert queue.status_code == 200
    assert "institution_reviewer" in client.get("/api/v1/identity/context", headers=reviewer).json()["identities"]
    suspended = client.post(f"/api/v1/identity/guardians/{row['id']}/suspend", headers=reviewer, json={"expected_revision":2,"review_reference":"synthetic-suspension"})
    assert suspended.status_code == 200, suspended.text
    assert client.get("/api/v1/patient/dashboard_status", headers=guardian).status_code == 403
    assert client.get("/api/v1/auth/me", headers=guardian).json()["patient_profile"] is None
    restored = client.post(f"/api/v1/identity/guardians/{row['id']}/restore", headers=reviewer, json={"expected_revision":3,"review_reference":"synthetic-restoration","expires_at":"2090-01-01T00:00:00Z"})
    assert restored.status_code == 200, restored.text
    assert client.get("/api/v1/patient/dashboard_status", headers=guardian).status_code == 200
    assert len(restored.json()["history"]) == 4


def test_research_requires_concrete_project_membership_and_never_clinical(client):
    patient, owner = register(client, "research-scope@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    researcher, technical = register(client, "project-researcher@example.com", "researcher")
    response = client.post("/api/v1/patient/consents", headers=owner, json={"patient_id":pid,"purpose":"research","scope":["assessment"],"terms_version":"W02-1"})
    assert response.status_code in [400,422]
    from backend.app.models.identity import ResearchProject, ResearchProjectMember
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        from backend.app.services import authorization_ledger as ledger
        project = ResearchProject(name="Synthetic scoped study", status="active")
        db.add(project)
        db.flush()
        member = ResearchProjectMember(project_id=project.id, user_id=researcher["user"]["id"], status="active")
        db.add(member)
        db.flush()
        ledger.reserve(project)
        ledger.reserve(member)
        project_id = project.id
        db.commit()
        ledger.publish(project)
        ledger.publish(member)
    grant = client.post("/api/v1/patient/consents", headers=owner, json={"patient_id":pid,"purpose":"research","project_id":project_id,"scope":["assessment"],"terms_version":"W02-1"})
    assert grant.status_code == 201, grant.text
    from backend.app.services.identity_service import require_research_access
    with SessionLocal() as db:
        assert require_research_access(db, researcher["user"]["id"], pid, project_id, "assessment")
    assert client.get(f"/api/v1/ai-enhanced/patient/{pid}/trend_predictions", headers=technical).status_code == 403


def test_missing_authorization_ledger_fails_closed_without_business_reseed(client):
    doctor, clinician, _, _, pid, _ = active_care(client, suffix="ledger")
    from backend.app.core.config import settings
    ledger = settings.AUTHORIZATION_LEDGER_PATH
    with sqlite3.connect(ledger) as db:
        db.execute("DELETE FROM authorization_heads")
    assert client.get(f"/api/v1/care/doctor/patient/{pid}/messages", headers=clinician).status_code == 403
    with sqlite3.connect(ledger) as db:
        assert db.execute("SELECT count(*) FROM authorization_heads").fetchone()[0] == 0


def test_withdraw_commit_failure_keeps_independent_deny_head(client, monkeypatch):
    patient, owner = register(client, "commit-fail@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    grant = client.post("/api/v1/patient/consents", headers=owner, json={"patient_id":pid,"purpose":"external_ai","scope":["assessment"],"terms_version":"W02-1"})
    assert grant.status_code == 201, grant.text
    from backend.app.db.session import SessionLocal
    from backend.app.services.consent_service import has_consent
    from sqlalchemy import event
    from sqlalchemy.orm import Session
    injected = []
    def failure(db):
        from backend.app.models.identity import ConsentRecord
        # The event outbox flushes before commit. Inspect the actual transaction
        # row rather than assuming a flushed consent remains in db.dirty.
        current = db.get(ConsentRecord,grant.json()["id"])
        if current is not None and current.status == "withdrawn":
            injected.append(True)
            raise RuntimeError("synthetic business commit failure")
    event.listen(Session,"before_commit",failure)
    try:
        with __import__("pytest").raises(RuntimeError, match="synthetic business"):
            client.post(f"/api/v1/patient/consents/{grant.json()['id']}/withdraw", headers=owner, json={"expected_revision":1})
    finally:
        event.remove(Session,"before_commit",failure)
    assert injected == [True]
    with SessionLocal() as db:
        assert not has_consent(db, pid, "external_ai")


def test_authorization_changes_use_canonical_care_event_outbox(client):
    _, _, _, owner, pid, relationship = active_care(client, suffix="outbox")
    response = client.post(f"/api/v1/care/relationships/{relationship['id']}/revoke", headers=owner, json={"expected_revision":2})
    assert response.status_code == 200
    from backend.app.db.session import SessionLocal
    from backend.app.models.event import CareEvent
    from sqlalchemy import select
    with SessionLocal() as db:
        events = db.scalars(select(CareEvent).where(CareEvent.patient_id == pid)).all()
        assert any(event.event_type == "care_relationship.revoked" for event in events)
        assert all(event.published_at is None and event.actor_user_id for event in events)


def test_transfer_requires_authenticated_new_guardian_and_new_consents(client):
    child, guardian, reviewer, row = verified_guardian(client,suffix="transfer")
    pid = row["patient_id"]
    grant = client.post("/api/v1/patient/consents",headers=guardian,json={"patient_id":pid,"purpose":"external_ai","scope":["profile","assessment","tracking"],"terms_version":"W02-1"})
    assert grant.status_code == 201
    new, next_guardian = account_only(client,"new-guardian@example.com")
    body = {"expected_revision":2,"new_guardian_user_id":new["user"]["id"],"proof_reference":"new-reviewed-proof","new_guardian_confirmed":True,"expires_at":"2090-01-01T00:00:00Z","review_reference":"synthetic-transfer-control-review"}
    url = f"/api/v1/identity/guardians/{row['id']}/transfer"
    assert client.post(url,headers=next_guardian,json=body).status_code == 403
    assert client.post(url,headers=reviewer,json=body).status_code == 403
    confirmation = client.post(f"/api/v1/identity/guardians/{row['id']}/confirm-transfer",headers=next_guardian,json={"expected_revision":2,"proof_reference":"new-reviewed-proof","age":32,"terms_version":"W02-1"})
    assert confirmation.status_code == 200, confirmation.text
    assert client.get("/api/v1/identity/context",headers=next_guardian).json()["accessible_patients"] == []
    transition = client.post(url,headers=reviewer,json=body)
    assert transition.status_code == 200, transition.text
    assert client.get("/api/v1/patient/dashboard_status",headers=guardian).status_code == 403
    new_context = client.get("/api/v1/identity/context",headers=next_guardian).json()
    assert new_context["accessible_patients"][0]["patient_id"] == pid
    assert new_context["accessible_patients"][0]["display_name"] == "Synthetic Child"
    listed = client.get(f"/api/v1/patient/consents?patient_id={pid}",headers=next_guardian)
    assert not any(item["effective_access"] for item in listed.json()["items"])
    assert transition.json()["history"][0]["actor_user_id"] == child["user"]["id"]


def test_adult_conversion_preserves_patient_and_parent_account_history(client):
    child, guardian, reviewer, row = verified_guardian(client,suffix="conversion")
    pid = row["patient_id"]
    recorded = client.post("/api/v1/patient/submit_scale",headers=guardian,json={"scale_type":"SNAP_IV","answers":[0]*26,"respondent_type":"parent"})
    assert recorded.status_code == 201
    adult, adult_headers = account_only(client,"independent-adult@example.com")
    body = {"expected_revision":2,"adult_user_id":adult["user"]["id"],"adult_confirmed":True,"age":19,"review_reference":"synthetic-adult-control-and-age-review"}
    url = f"/api/v1/identity/guardians/{row['id']}/adult-conversion"
    assert client.post(url,headers=reviewer,json=body).status_code == 403
    confirmation = client.post(f"/api/v1/identity/guardians/{row['id']}/confirm-adult-conversion",headers=adult_headers,json={"expected_revision":2,"proof_reference":"adult-age-and-control-proof","age":19,"terms_version":"W02-1"})
    assert confirmation.status_code == 200, confirmation.text
    converted = client.post(url,headers=reviewer,json=body)
    assert converted.status_code == 200, converted.text
    parent = client.get("/api/v1/auth/me",headers=guardian).json()
    assert parent["full_name"] == "Synthetic Person" and parent["patient_profile"] is None
    adult_profile = client.get("/api/v1/auth/me",headers=adult_headers).json()["patient_profile"]
    assert adult_profile["id"] == pid and adult_profile["patient_type"] == "adult"
    report = client.get("/api/v1/patient/comprehensive_report",headers=adult_headers).json()
    assert report["latest_scale"]["id"] == recorded.json()["id"]
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient import Patient
    with SessionLocal() as db:
        assert db.get(Patient,pid).user_id == child["user"]["id"]


def test_patient_initiated_care_requires_doctor_confirmation(client):
    doctor, clinician = register(client,"patient-invite-doctor@example.com","researcher")
    patient, owner = register(client,"patient-invite-owner@example.com")
    qualify(doctor["user"]["id"])
    invitation = client.post("/api/v1/care/relationships/invitations",headers=owner,json={"target_email":doctor["user"]["email"],"scope":["care"],"purpose":"clinical_sharing"})
    assert invitation.status_code == 201, invitation.text
    row = invitation.json()
    assert row["patient_confirmed"] and not row["doctor_confirmed"] and row["status"] == "pending"
    assert client.get(f"/api/v1/care/doctor/patient/{row['patient_id']}/messages",headers=clinician).status_code == 403
    accepted = client.post(f"/api/v1/care/relationships/{row['id']}/accept",headers=clinician,json={"expected_revision":1})
    assert accepted.status_code == 200 and accepted.json()["status"] == "active"


def test_non_test_schema_check_is_read_only_and_requires_reviewed_migration(client,tmp_path):
    from sqlalchemy import create_engine, inspect
    from backend.app.db.identity_migration import require_identity_schema, schema_plan
    old = create_engine(f"sqlite:///{(tmp_path / 'unreviewed.db').as_posix()}")
    before = inspect(old).get_table_names()
    import pytest
    with pytest.raises(RuntimeError,match="reviewed"):
        require_identity_schema(old)
    plan = schema_plan(old)
    assert plan["requires_explicit_review"] and plan["statements"]
    assert inspect(old).get_table_names() == before
    old.dispose()


def test_explicit_external_consent_sends_only_minimized_structured_data(client,monkeypatch):
    import json
    from io import BytesIO
    patient, owner = register(client,"minimal-ai@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    response = client.post("/api/v1/patient/consents",headers=owner,json={"patient_id":pid,"purpose":"external_ai","scope":["profile","assessment","tracking"],"terms_version":"W02-1"})
    assert response.status_code == 201
    from backend.app.services import ai_service
    monkeypatch.setattr(ai_service.settings,"DEEPSEEK_API_KEY","synthetic-only-key")
    calls = []
    def provider(request,**kwargs):
        payload = request.data.decode()
        calls.append(payload)
        assert "Synthetic Person" not in payload and "private-transcript-marker" not in payload
        return BytesIO(json.dumps({"model":"synthetic-model","choices":[{"message":{"content":"synthetic structured advice"}}]}).encode())
    monkeypatch.setattr(ai_service,"urlopen",provider)
    chat = client.post("/api/v1/ai/chat",headers=owner,json={"message":"private-transcript-marker","conversation":[{"role":"user","content":"private-transcript-marker"}],"context_scope":"general"})
    assert chat.status_code == 200,chat.text
    assert chat.json()["provider"] == "deepseek" and len(calls) == 1
    assert client.post(f"/api/v1/patient/consents/{response.json()['id']}/withdraw",headers=owner,json={"expected_revision":1}).status_code == 200
    assert client.post("/api/v1/ai/chat",headers=owner,json={"message":"test","conversation":[],"context_scope":"general"}).json()["provider"] == "local"
    assert len(calls) == 1


def test_qualification_withdrawal_survives_old_business_restore(client,sqlite_database_path,tmp_path):
    doctor, clinician, _, _, pid, _ = active_care(client,suffix="qualification-restore")
    from backend.app.db.session import SessionLocal, engine
    from backend.app.models.identity import DoctorQualification
    from backend.app.services import authorization_ledger as ledger
    from sqlalchemy import select
    backup_path = tmp_path / "before-qualification-revoke.db"
    with sqlite3.connect(sqlite_database_path) as business, sqlite3.connect(backup_path) as backup:
        business.backup(backup)
    with SessionLocal() as db:
        qualification = db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == doctor["user"]["id"]))
        assert hasattr(qualification,"ledger_key"), "Institutional credential needs an independent authority head"
        ledger.deny(qualification)
        qualification.status = "revoked"
        db.commit()
    engine.dispose()
    with sqlite3.connect(backup_path) as backup, sqlite3.connect(sqlite_database_path) as business:
        backup.backup(business)
    assert client.get(f"/api/v1/care/doctor/patient/{pid}/messages",headers=clinician).status_code == 403


def test_unassigned_guardian_proof_not_visible_to_any_institution_reviewer(client):
    _, guardian = register(client,"unassigned-guardian@example.com",child=True)
    reviewer, headers = register(client,"unassigned-reviewer@example.com","researcher")
    qualify(reviewer["user"]["id"],reviewer=True,assign_guardians=False)
    context = client.get("/api/v1/identity/context",headers=guardian).json()
    row = context["guardian_relationships"][0]
    queue = client.get("/api/v1/identity/guardians/review_queue",headers=headers)
    assert queue.status_code == 200
    assert queue.json()["items"] == [], "Unassigned guardian evidence must not cross institution boundaries"
    response = client.post(f"/api/v1/identity/guardians/{row['id']}/review",headers=headers,json={"expected_revision":1,"status":"verified","review_reference":"unassigned-claim","expires_at":"2090-01-01T00:00:00Z"})
    assert response.status_code == 403
    assert context["demonstration_only"] is True


def test_cached_care_response_rechecks_authority_before_release(client,monkeypatch):
    _, clinician, _, _, pid, row = active_care(client,suffix="response-race")
    body = _scoped_message_body(client,clinician,pid,row,"race-read","Synthetic content")
    assert client.post("/api/v1/care/shared-messages",headers=clinician,json=body).status_code == 201
    from backend.app.services import care_message_service as messages
    original = messages._ack
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.services import authorization_ledger as ledger
    calls = []
    def revoke_before_return(message):
        calls.append(message.id)
        with SessionLocal() as db:
            relationship = db.get(CareRelationship,row["id"])
            ledger.deny(relationship)
            relationship.status = "revoked"
            db.commit()
        return original(message)
    monkeypatch.setattr(messages,"_ack",revoke_before_return)
    response = client.get(f"/api/v1/care/shared-messages?patient_id={pid}&relationship_id={row['id']}",headers=clinician)
    assert response.status_code == 403,response.text
    assert len(calls) == 1
    assert "Synthetic content" not in response.text


def test_mid_request_revocation_blocks_business_write(client,monkeypatch):
    _, clinician, _, _, pid, row = active_care(client,suffix="write-race")
    body = _scoped_message_body(client,clinician,pid,row,"race-write","must not persist")
    from backend.app.services import care_message_service as messages
    original = messages.send_message
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.models.shared_message import SharedCareMessage
    from backend.app.models.event import CareEvent
    from backend.app.services import authorization_ledger as ledger
    from sqlalchemy import select
    calls = []
    def revoke_before_commit(db,user,payload):
        provisional = original(db,user,payload)
        calls.append(provisional[0]["message_id"])
        with SessionLocal() as authority_db:
            relationship = authority_db.get(CareRelationship,row["id"])
            # The independent denial must block the already-flushed business
            # transaction even before a revoker's business commit succeeds.
            ledger.deny(relationship)
        return provisional
    monkeypatch.setattr(messages,"send_message",revoke_before_commit)
    response = client.post("/api/v1/care/shared-messages",headers=clinician,json=body)
    assert response.status_code == 403,response.text
    assert len(calls) == 1
    with SessionLocal() as db:
        assert db.scalar(select(SharedCareMessage.id).where(SharedCareMessage.client_message_id == "race-write")) is None
        assert db.scalar(select(CareEvent.id).where(CareEvent.dedupe_key == "shared_message:race-write")) is None


def _scoped_message_body(client,headers,patient_id,relationship,key,content):
    context = client.get(f"/api/v1/care/shared-messages/relationships?patient_id={patient_id}",headers=headers)
    assert context.status_code == 200,context.text
    original = next(item for item in context.json()["items"] if item["relationship_id"] == relationship["id"])
    return {"patient_id":patient_id,"relationship_id":relationship["id"],"client_message_id":key,
        "content":content,"confirmed":True,"send_context":original["send_context"]}


def test_findviz_cache_response_rechecks_after_mounted_work(client,monkeypatch):
    _, clinician, _, _, pid, row = active_care(client,suffix="findviz-race")
    assert client.post("/api/v1/imaging/session",headers=clinician,json={"patient_id":pid}).status_code == 200
    from findviz.viz.io.cache import Cache
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.services import authorization_ledger as ledger
    def revoke_during_cache_check(cache):
        with SessionLocal() as db:
            relationship = db.get(CareRelationship,row["id"])
            ledger.deny(relationship)
            relationship.status = "revoked"
            db.commit()
        return False
    monkeypatch.setattr(Cache,"exists",revoke_during_cache_check)
    result = client.get("/findviz/check_cache",headers={"X-Findviz-Patient-Id":str(pid)})
    assert result.status_code == 403, result.text


def test_external_consent_withdrawn_during_provider_response_stays_local(client,monkeypatch):
    import json
    from io import BytesIO
    patient, owner = register(client,"ai-response-race@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    grant = client.post("/api/v1/patient/consents",headers=owner,json={"patient_id":pid,"purpose":"external_ai","scope":["profile","assessment","tracking"],"terms_version":"W02-1"}).json()
    from backend.app.services import ai_service, authorization_ledger as ledger
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import ConsentRecord
    monkeypatch.setattr(ai_service.settings,"DEEPSEEK_API_KEY","synthetic-only-key")
    def provider(request,**kwargs):
        with SessionLocal() as db:
            consent = db.get(ConsentRecord,grant["id"])
            ledger.deny(consent)
            consent.status = "withdrawn"
            db.commit()
        return BytesIO(json.dumps({"model":"synthetic","choices":[{"message":{"content":"stale remote advice must not publish"}}]}).encode())
    monkeypatch.setattr(ai_service,"urlopen",provider)
    response = client.post("/api/v1/ai/chat",headers=owner,json={"message":"test","conversation":[],"context_scope":"general"})
    assert response.status_code == 200
    assert response.json()["provider"] == "local"
    assert "stale remote advice" not in response.text


def test_withdrawing_basic_use_blocks_new_processing_but_keeps_own_history(client):
    patient, owner = register(client,"withdraw-basic@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    listed = client.get(f"/api/v1/patient/consents?patient_id={pid}",headers=owner).json()["items"]
    basic = next(item for item in listed if item["purpose"] == "basic_use")
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=owner,json={"expected_revision":basic["revision"]}).status_code == 200
    response = client.post("/api/v1/patient/submit_scale",headers=owner,json={"scale_type":"ASRS","answers":[0]*18,"respondent_type":"self"})
    assert response.status_code == 403,response.text
    assert client.post("/api/v1/ai/chat",headers=owner,json={"message":"test","conversation":[],"context_scope":"general"}).status_code == 403
    assert client.post(f"/api/v1/model/predict_mock?patient_id={pid}",headers=owner).status_code == 403
    assert client.get("/api/v1/patient/comprehensive_report",headers=owner).status_code == 200
    fresh = client.post("/api/v1/patient/consents",headers=owner,json={"patient_id":pid,"purpose":"basic_use","scope":["profile","assessment","tracking","care","imaging"],"terms_version":"W02-1"})
    assert fresh.status_code == 201
    assert client.post("/api/v1/patient/submit_scale",headers=owner,json={"scale_type":"ASRS","answers":[0]*18,"respondent_type":"self"}).status_code == 201


def test_new_guardian_needs_own_basic_consent_before_new_assessment(client):
    _, guardian, reviewer, row = verified_guardian(client,suffix="fresh-basic")
    new, next_guardian = account_only(client,"fresh-basic-new@example.com")
    confirmation = {"expected_revision":2,"proof_reference":"new-basic-proof","terms_version":"W02-1","age":35}
    assert client.post(f"/api/v1/identity/guardians/{row['id']}/confirm-transfer",headers=next_guardian,json=confirmation).status_code == 200
    body = {"expected_revision":2,"new_guardian_user_id":new["user"]["id"],"new_guardian_confirmed":True,"proof_reference":"new-basic-proof","expires_at":"2090-01-01T00:00:00Z","review_reference":"reviewed-new-basic"}
    assert client.post(f"/api/v1/identity/guardians/{row['id']}/transfer",headers=reviewer,json=body).status_code == 200
    payload = {"scale_type":"SNAP_IV","answers":[0]*26,"respondent_type":"guardian"}
    assert client.post("/api/v1/patient/submit_scale",headers=next_guardian,json=payload).status_code == 403
    assert client.get("/api/v1/patient/comprehensive_report",headers=next_guardian).status_code == 200
    assert client.post("/api/v1/patient/consents",headers=next_guardian,json={"patient_id":row["patient_id"],"purpose":"basic_use","scope":["profile","assessment","tracking","care","imaging"],"terms_version":"W02-1"}).status_code == 201
    assert client.post("/api/v1/patient/submit_scale",headers=next_guardian,json=payload).status_code == 201


def test_legacy_enhanced_security_consent_summary_never_assumes_optional_agreement(client):
    patient, _ = register(client,"single-consent-source@example.com")
    from backend.app.services.enhanced_security_service import EnhancedSecurityService
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        service = EnhancedSecurityService(db)
        assert service.check_consent_status(patient["user"]["patient_profile"]["id"],"ai_analysis")["has_consent"] is False
        assert service.check_consent_status(patient["user"]["patient_profile"]["id"],"research_use")["has_consent"] is False


def test_basic_withdrawal_before_provider_dispatch_never_attempts_remote(client,monkeypatch):
    patient, owner = register(client,"ai-basic-dispatch@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    assert client.post("/api/v1/patient/consents",headers=owner,json={"patient_id":pid,"purpose":"external_ai","scope":["profile","assessment","tracking"],"terms_version":"W02-1"}).status_code == 201
    from backend.app.services import ai_service, authorization_ledger as ledger
    from backend.app.db.session import SessionLocal
    from backend.app.models.consent import ConsentRecord
    from sqlalchemy import select
    original = ai_service._build_chat_messages
    def withdraw_before_dispatch(**kwargs):
        with SessionLocal() as db:
            basic = db.scalar(select(ConsentRecord).where(ConsentRecord.patient_id == pid,ConsentRecord.purpose == "basic_use"))
            ledger.deny(basic)
            basic.status = "withdrawn"
            db.commit()
        return original(**kwargs)
    monkeypatch.setattr(ai_service.settings,"DEEPSEEK_API_KEY","synthetic-only-key")
    monkeypatch.setattr(ai_service,"_build_chat_messages",withdraw_before_dispatch)
    calls = []
    def forbidden(*args,**kwargs):
        calls.append(True)
        raise AssertionError("Provider called after basic processing consent was withdrawn")
    monkeypatch.setattr(ai_service,"urlopen",forbidden)
    response = client.post("/api/v1/ai/chat",headers=owner,json={"message":"test","conversation":[],"context_scope":"general"})
    assert response.status_code == 403
    assert calls == []


def test_external_consent_preserves_local_high_risk_message_guard(client,monkeypatch):
    patient, owner = register(client,"ai-safety-guard@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    assert client.post("/api/v1/patient/consents",headers=owner,json={"patient_id":pid,"purpose":"external_ai","scope":["profile","assessment","tracking"],"terms_version":"W02-1"}).status_code == 201
    from backend.app.services import ai_service
    monkeypatch.setattr(ai_service.settings,"DEEPSEEK_API_KEY","synthetic-only-key")
    calls = []
    def forbidden(*args,**kwargs):
        calls.append(True)
        raise AssertionError("Local high-risk message guard must run before minimization")
    monkeypatch.setattr(ai_service,"urlopen",forbidden)
    result = client.post("/api/v1/ai/chat",headers=owner,json={"message":"我想自杀","conversation":[],"context_scope":"general"})
    assert result.status_code == 200
    assert result.json()["model"] == "safety-guard"
    assert calls == []


def test_regrant_appends_original_actor_scope_terms_and_expiry_material(client):
    patient, owner = register(client,"append-consent@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    first = client.post("/api/v1/patient/consents",headers=owner,json={"patient_id":pid,"purpose":"external_ai","scope":["assessment"],"terms_version":"W02-1","expires_at":"2090-01-01T00:00:00Z"}).json()
    second = client.post("/api/v1/patient/consents",headers=owner,json={"patient_id":pid,"purpose":"external_ai","scope":["tracking"],"terms_version":"W02-1"}).json()
    assert second["id"] != first["id"], "Each new grant needs its own persistent immutable material"
    from backend.app.db.session import SessionLocal
    from backend.app.models.consent import ConsentRecord
    from backend.app.services.consent_service import has_consent
    with SessionLocal() as db:
        historic = db.get(ConsentRecord,first["id"])
        assert historic.scope == ["assessment"] and historic.expires_at.year == 2090
        assert historic.grantor_user_id == first["grantor_user_id"] and historic.actor_identity_basis == first["actor_identity_basis"]
        assert not has_consent(db,pid,"external_ai",scope={"assessment"})
    assert client.post(f"/api/v1/patient/consents/{second['id']}/withdraw",headers=owner,json={"expected_revision":second["revision"]}).status_code == 200
    with SessionLocal() as db:
        assert not has_consent(db,pid,"external_ai")


def test_ai_enhanced_new_get_computation_requires_basic_consent(client,monkeypatch):
    _, clinician, _, owner, pid, _ = active_care(client,suffix="enhanced-basic")
    basic = next(item for item in client.get(f"/api/v1/patient/consents?patient_id={pid}",headers=owner).json()["items"] if item["purpose"] == "basic_use")
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=owner,json={"expected_revision":basic["revision"]}).status_code == 200
    from backend.app.services.intervention_service import InterventionService
    calls = []
    original = InterventionService.generate_intervention_plan
    def generate(*args,**kwargs):
        calls.append(True)
        return original(*args,**kwargs)
    monkeypatch.setattr(InterventionService,"generate_intervention_plan",generate)
    response = client.get(f"/api/v1/ai-enhanced/patient/{pid}/intervention_plans",headers=clinician)
    assert response.status_code == 403,response.text
    assert calls == []


def test_old_request_cannot_borrow_basic_consent_regrant(client,monkeypatch):
    _, clinician, patient, owner, pid, relationship = active_care(client,suffix="revision-race")
    body = _scoped_message_body(client,clinician,pid,relationship,"revision-old","old request")
    from backend.app.services import care_message_service as messages
    from backend.app.db.session import SessionLocal
    from backend.app.services.consent_service import prepare_grant
    from backend.app.services import authorization_ledger as ledger
    from backend.app.models.shared_message import SharedCareMessage
    from sqlalchemy import select
    original = messages.send_message
    calls = []
    def regrant_during_request(db,user,payload):
        calls.append(True)
        with SessionLocal() as authority_db:
            fresh = prepare_grant(authority_db,patient_id=pid,actor_id=patient["user"]["id"],purpose="basic_use",scope=["profile","assessment","tracking","care","imaging"])
            authority_db.commit()
            ledger.publish(fresh)
        return original(db,user,payload)
    monkeypatch.setattr(messages,"send_message",regrant_during_request)
    response = client.post("/api/v1/care/shared-messages",headers=clinician,json=body)
    assert response.status_code in [403,409],response.text
    assert calls == [True]
    with SessionLocal() as db:
        assert db.scalar(select(SharedCareMessage.id).where(SharedCareMessage.client_message_id == "revision-old")) is None


def test_anomaly_post_requires_current_basic_processing_consent(client):
    patient, owner = register(client,"anomaly-basic@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    basic = next(row for row in client.get(f"/api/v1/patient/consents?patient_id={pid}",headers=owner).json()["items"] if row["purpose"] == "basic_use" and row["effective_access"])
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=owner,json={"expected_revision":basic["revision"]}).status_code == 200
    response = client.post("/api/v1/ai-enhanced/scale/anomaly_detection",headers=owner,json={"scale_type":"ASRS","answers":[0]*18})
    assert response.status_code == 403,response.text


def test_doctor_patient_email_projects_current_guardian_without_rebinding_history(client):
    child, guardian, reviewer, row = verified_guardian(client,suffix="current-contact")
    new, next_guardian = account_only(client,"current-contact-next@example.com")
    assert client.post(f"/api/v1/identity/guardians/{row['id']}/confirm-transfer",headers=next_guardian,json={"expected_revision":2,"proof_reference":"contact-proof","terms_version":"W02-1","age":35}).status_code == 200
    assert client.post(f"/api/v1/identity/guardians/{row['id']}/transfer",headers=reviewer,json={"expected_revision":2,"new_guardian_user_id":new["user"]["id"],"new_guardian_confirmed":True,"proof_reference":"contact-proof","review_reference":"contact-reviewed","expires_at":"2090-01-01T00:00:00Z"}).status_code == 200
    doctor, clinician = register(client,"current-contact-doctor@example.com","researcher")
    qualify(doctor["user"]["id"])
    invitation = client.post("/api/v1/care/relationships/invitations",headers=next_guardian,json={"target_email":doctor["user"]["email"],"scope":["profile","assessment","tracking","care","imaging"]}).json()
    accepted = client.post(f"/api/v1/care/relationships/{invitation['id']}/accept",headers=clinician,json={"expected_revision":1})
    assert accepted.status_code == 200, accepted.text
    patients = client.get("/api/v1/doctor/my_patients",headers=clinician)
    assert patients.status_code == 200,patients.text
    assert patients.json()["items"][0]["patient_email"] == new["user"]["email"]
    report = client.get(f"/api/v1/doctor/patient/{row['patient_id']}/report",headers=clinician)
    assert report.status_code == 200 and report.json()["patient_email"] == new["user"]["email"]
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient import Patient
    with SessionLocal() as db:
        assert db.get(Patient,row["patient_id"]).user_id == child["user"]["id"]


def test_disabled_actor_before_model_upload_never_writes_patient_file(client,monkeypatch):
    patient, owner = register(client,"upload-disabled-actor@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    from pathlib import Path
    from backend.app.api.routes import model_inference
    from backend.app.core.config import settings
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    original = model_inference.read_upload_bytes_limited
    async def disable_after_read(*args,**kwargs):
        contents = await original(*args,**kwargs)
        with SessionLocal() as db:
            db.get(User,patient["user"]["id"]).is_active = False
            db.commit()
        return contents
    monkeypatch.setattr(model_inference,"read_upload_bytes_limited",disable_after_read)
    response = client.post(f"/api/v1/model/predict_fmri?patient_id={pid}",headers=owner,files={"timeseries_file":("tiny.csv",b"1,2\n3,4\n","text/csv")})
    assert response.status_code == 403,response.text
    assert not [item for item in Path(settings.UPLOAD_ROOT).rglob("*") if item.is_file()],"An account disabled before the write must not leave a patient file"


def test_model_upload_cannot_borrow_regranted_basic_consent(client,monkeypatch):
    patient, owner = register(client,"upload-regranted-basic@example.com")
    pid = patient["user"]["patient_profile"]["id"]
    from pathlib import Path
    from backend.app.api.routes import model_inference
    from backend.app.core.config import settings
    from backend.app.db.session import SessionLocal
    from backend.app.services.consent_service import prepare_grant
    from backend.app.services import authorization_ledger as ledger
    original = model_inference.read_upload_bytes_limited
    async def rotate_after_read(*args,**kwargs):
        contents = await original(*args,**kwargs)
        with SessionLocal() as db:
            grant = prepare_grant(db,patient_id=pid,actor_id=patient["user"]["id"],purpose="basic_use",scope=["profile","assessment","tracking","care","imaging"])
            db.commit()
            ledger.publish(grant)
        return contents
    monkeypatch.setattr(model_inference,"read_upload_bytes_limited",rotate_after_read)
    response = client.post(f"/api/v1/model/predict_fmri?patient_id={pid}",headers=owner,files={"timeseries_file":("tiny.csv",b"1,2\n3,4\n","text/csv")})
    assert response.status_code in [403,409],response.text
    assert not [item for item in Path(settings.UPLOAD_ROOT).rglob("*") if item.is_file()],"A stale upload must not borrow a new basic consent to write a patient file"
