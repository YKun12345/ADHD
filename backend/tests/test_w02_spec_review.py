"""Independent W02 contract counterexamples; synthetic isolated HTTP only."""
import pytest

from backend.tests.test_authorization_edges import active_care, account_only, verified_guardian
from backend.tests.w02_helpers import register, qualify, invite


def test_care_only_relationship_does_not_claim_active_after_withdraw_before_response(client, monkeypatch):
    doctor, clinician, _, owner, patient_id, relationship = active_care(
        client, suffix="spec-care-only-late-withdraw", scope=["care"]
    )
    from backend.app.services import care_relationship_service
    original = care_relationship_service.require_patient_access
    withdrawn = []

    def withdraw_after_effective_check(db, user, requested_patient_id, scope="profile", *, record=True, relationship_id=None):
        patient = original(db, user, requested_patient_id, scope, record=record, relationship_id=relationship_id)
        requested_scope = {scope} if isinstance(scope, str) else set(scope)
        if requested_patient_id == patient_id and user.id == doctor["user"]["id"] and requested_scope == {"care"} and not withdrawn:
            response = client.post(
                f"/api/v1/care/relationships/{relationship['id']}/revoke", headers=owner,
                json={"expected_revision": relationship["revision"]},
            )
            assert response.status_code == 200, response.text
            withdrawn.append(True)
        return patient

    monkeypatch.setattr(care_relationship_service, "require_patient_access", withdraw_after_effective_check)
    response = client.get("/api/v1/care/relationships", headers=clinician)
    assert withdrawn == [True]
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/messages", headers=clinician).status_code == 403
    assert response.status_code in {403, 409} or (
        response.status_code == 200 and
        not next(item for item in response.json()["items"] if item["id"] == relationship["id"])["effective_access"]
    ), response.text


def test_care_only_relationship_does_not_claim_verified_clinical_access_after_qualification_denial(client, monkeypatch):
    doctor, clinician, _, _, patient_id, relationship = active_care(
        client, suffix="spec-care-only-late-qualification", scope=["care"]
    )
    from backend.app.services import care_relationship_service, authorization_ledger
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification
    from sqlalchemy import select
    original = care_relationship_service.require_patient_access
    denied = []

    def deny_qualification_after_effective_check(db, user, requested_patient_id, scope="profile", *, record=True, relationship_id=None):
        patient = original(db, user, requested_patient_id, scope, record=record, relationship_id=relationship_id)
        requested_scope = {scope} if isinstance(scope, str) else set(scope)
        if requested_patient_id == patient_id and user.id == doctor["user"]["id"] and requested_scope == {"care"} and not denied:
            with SessionLocal() as authority_db:
                qualification = authority_db.scalar(select(DoctorQualification).where(
                    DoctorQualification.user_id == doctor["user"]["id"]
                ))
                authorization_ledger.deny(qualification)
                authority_db.commit()
            denied.append(True)
        return patient

    monkeypatch.setattr(care_relationship_service, "require_patient_access", deny_qualification_after_effective_check)
    response = client.get("/api/v1/care/relationships", headers=clinician)
    assert denied == [True]
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/messages", headers=clinician).status_code == 403
    assert response.status_code in {403, 409} or (
        response.status_code == 200 and
        not next(item for item in response.json()["items"] if item["id"] == relationship["id"])["effective_access"]
    ), response.text


def test_care_only_relationship_head_denial_survives_partial_withdraw_failure_before_response(client, monkeypatch):
    doctor, clinician, _, owner, patient_id, relationship = active_care(
        client, suffix="spec-care-only-partial-withdraw", scope=["care"]
    )
    from backend.app.services import care_relationship_service, consent_service
    original = care_relationship_service.require_patient_access
    failed_withdrawal = []

    def fail_consent_withdrawal(*args, **kwargs):
        raise RuntimeError("synthetic consent transaction unavailable")

    def withdraw_after_effective_check(db, user, requested_patient_id, scope="profile", *, record=True, relationship_id=None):
        patient = original(db, user, requested_patient_id, scope, record=record, relationship_id=relationship_id)
        requested_scope = {scope} if isinstance(scope, str) else set(scope)
        if requested_patient_id == patient_id and user.id == doctor["user"]["id"] and requested_scope == {"care"} and not failed_withdrawal:
            monkeypatch.setattr(consent_service, "prepare_withdraw", fail_consent_withdrawal)
            with pytest.raises(RuntimeError, match="synthetic consent transaction unavailable"):
                client.post(
                    f"/api/v1/care/relationships/{relationship['id']}/revoke", headers=owner,
                    json={"expected_revision": relationship["revision"]},
                )
            failed_withdrawal.append(True)
        return patient

    monkeypatch.setattr(care_relationship_service, "require_patient_access", withdraw_after_effective_check)
    response = client.get("/api/v1/care/relationships", headers=clinician)
    assert failed_withdrawal == [True]
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/messages", headers=clinician).status_code == 403
    assert response.status_code in {403, 409} or (
        response.status_code == 200 and
        not next(item for item in response.json()["items"] if item["id"] == relationship["id"])["effective_access"]
    ), response.text

def consent_items(client, headers, patient_id):
    response = client.get(f"/api/v1/patient/consents?patient_id={patient_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["items"]


def withdraw_basic(client, owner, patient_id):
    basic = next(item for item in consent_items(client, owner, patient_id) if item["purpose"] == "basic_use" and item["effective_access"])
    response = client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=owner, json={"expected_revision": basic["revision"]})
    assert response.status_code == 200, response.text


def test_new_guardian_basic_consent_preserves_original_author_and_terms(client):
    _, guardian, reviewer, relationship = verified_guardian(client, suffix="spec-author-history")
    patient_id = relationship["patient_id"]
    original = next(row for row in consent_items(client, guardian, patient_id) if row["purpose"] == "basic_use")
    new_user, new_guardian = account_only(client, "spec-successor@example.com")
    confirmation = {"expected_revision": relationship["revision"], "proof_reference": "synthetic-new-controller", "terms_version": "W02-1", "age": 35}
    response = client.post(f"/api/v1/identity/guardians/{relationship['id']}/confirm-transfer", headers=new_guardian, json=confirmation)
    assert response.status_code == 200, response.text
    transfer = {"expected_revision": relationship["revision"], "new_guardian_user_id": new_user["user"]["id"], "new_guardian_confirmed": True, "proof_reference": confirmation["proof_reference"], "expires_at": "2090-01-01T00:00:00Z", "review_reference": "synthetic-control-review"}
    response = client.post(f"/api/v1/identity/guardians/{relationship['id']}/transfer", headers=reviewer, json=transfer)
    assert response.status_code == 200, response.text
    response = client.post("/api/v1/patient/consents", headers=new_guardian, json={"patient_id": patient_id, "purpose": "basic_use", "scope": ["profile", "assessment", "tracking", "care", "imaging"], "terms_version": "W02-1"})
    assert response.status_code == 201, response.text
    rows = consent_items(client, new_guardian, patient_id)
    historical = next(row for row in rows if row["id"] == original["id"])
    for key in ("grantor_user_id", "actor_identity_basis", "scope", "terms_version", "expires_at"):
        assert historical[key] == original[key], f"The new actor overwrote historical {key}: {rows}"
    assert not historical["effective_access"]
    assert response.json()["id"] != original["id"]
    assert response.json()["grantor_user_id"] == new_user["user"]["id"]


def test_same_actor_scope_regrant_preserves_history_and_only_latest_grant_can_be_withdrawn(client):
    patient, owner = register(client, "spec-purpose-history@example.com")
    patient_id = patient["user"]["patient_profile"]["id"]
    def grant(scope, expiry):
        response = client.post("/api/v1/patient/consents", headers=owner, json={"patient_id": patient_id, "purpose": "external_ai", "scope": scope, "terms_version": "W02-1", "expires_at": expiry})
        assert response.status_code == 201, response.text
        return response.json()
    first = grant(["profile"], "2090-01-01T00:00:00Z")
    second = grant(["assessment"], "2091-01-01T00:00:00Z")
    rows = [row for row in consent_items(client, owner, patient_id) if row["purpose"] == "external_ai"]
    original = next(row for row in rows if row["id"] == first["id"])
    assert original["scope"] == first["scope"] and original["expires_at"] == first["expires_at"], rows
    assert len([row for row in rows if row["effective_access"]]) == 1
    assert not original["effective_access"]
    assert second["id"] != first["id"]
    replay = client.post(f"/api/v1/patient/consents/{first['id']}/withdraw", headers=owner, json={"expected_revision": first["revision"]})
    assert replay.status_code == 409, replay.text
    assert next(row for row in consent_items(client, owner, patient_id) if row["id"] == second["id"])["effective_access"]
    current = client.post(f"/api/v1/patient/consents/{second['id']}/withdraw", headers=owner, json={"expected_revision": second["revision"]})
    assert current.status_code == 200, current.text
    assert not any(row["effective_access"] for row in consent_items(client, owner, patient_id) if row["purpose"] == "external_ai")


@pytest.mark.parametrize("action", ["transfer", "adult-conversion"])
def test_newly_confirmed_doctor_contact_uses_current_actor_after_identity_transition(client, action):
    old_user, _, reviewer, relationship = verified_guardian(client, suffix="spec-current-contact")
    patient_id = relationship["patient_id"]
    new_user, controller = account_only(client, "spec-current-controller@example.com")
    confirmation = {"expected_revision": relationship["revision"], "proof_reference": "synthetic-current-controller-proof", "terms_version": "W02-1", "age": 32 if action == "transfer" else 19}
    response = client.post(f"/api/v1/identity/guardians/{relationship['id']}/confirm-{action}", headers=controller, json=confirmation)
    assert response.status_code == 200, response.text
    transition = {"expected_revision": relationship["revision"], "review_reference": "synthetic-current-controller-review", "expires_at": "2090-01-01T00:00:00Z"}
    if action == "transfer":
        transition.update({"new_guardian_user_id": new_user["user"]["id"], "new_guardian_confirmed": True, "proof_reference": confirmation["proof_reference"]})
    else:
        transition.update({"adult_user_id": new_user["user"]["id"], "adult_confirmed": True, "age": confirmation["age"]})
    response = client.post(f"/api/v1/identity/guardians/{relationship['id']}/{action}", headers=reviewer, json=transition)
    assert response.status_code == 200, response.text
    response = client.post("/api/v1/patient/consents", headers=controller, json={"patient_id": patient_id, "purpose": "basic_use", "scope": ["profile", "assessment", "tracking", "care", "imaging"], "terms_version": "W02-1"})
    assert response.status_code == 201, response.text
    doctor, clinician = register(client, "spec-new-contact-doctor@example.com", "researcher")
    qualify(doctor["user"]["id"])
    response = client.post("/api/v1/care/relationships/invitations", headers=controller, json={"patient_id": patient_id, "target_email": doctor["user"]["email"], "scope": ["profile", "assessment", "tracking", "care", "imaging"]})
    assert response.status_code == 201, response.text
    invitation = response.json()
    response = client.post(f"/api/v1/care/relationships/{invitation['id']}/accept", headers=clinician, json={"expected_revision": invitation["revision"]})
    assert response.status_code == 200, response.text
    patients = client.get("/api/v1/doctor/my_patients", headers=clinician)
    assert patients.status_code == 200, patients.text
    current_patient = next(row for row in patients.json()["items"] if row["patient_id"] == patient_id)
    report = client.get(f"/api/v1/doctor/patient/{patient_id}/report", headers=clinician)
    assert report.status_code == 200, report.text
    assert current_patient["patient_email"] == new_user["user"]["email"], current_patient
    assert report.json()["patient_email"] == new_user["user"]["email"], report.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient import Patient
    with SessionLocal() as db:
        assert db.get(Patient, patient_id).user_id == old_user["user"]["id"]


@pytest.mark.parametrize("endpoint,actor", [
    ("adaptive_difficulty/stroop", "owner"),
    ("multimodal_insights", "clinician"),
    ("trend_predictions", "owner"),
    ("care_alerts", "owner"),
    ("intervention_plans", "clinician"),
    ("intervention_effect/mindfulness", "clinician"),
    ("intervention_dashboard", "clinician"),
    ("smart_reminder", "owner"),
])
def test_basic_withdrawal_blocks_fresh_enhanced_processing_get(client, endpoint, actor):
    _, clinician, _, owner, patient_id, _ = active_care(client, suffix="spec-compute")
    withdraw_basic(client, owner, patient_id)
    response = client.get(f"/api/v1/ai-enhanced/patient/{patient_id}/{endpoint}", headers=owner if actor == "owner" else clinician)
    assert response.status_code == 403, (endpoint, response.text)
    assert client.get("/api/v1/patient/comprehensive_report", headers=owner).status_code == 200


def test_basic_withdrawal_blocks_enhanced_personalized_task_persistence(client):
    _, clinician, _, owner, patient_id, _ = active_care(client, suffix="spec-message")
    withdraw_basic(client, owner, patient_id)
    response = client.post(f"/api/v1/ai-enhanced/researcher/send_message/{patient_id}", headers=clinician, json={"patient_id": patient_id, "message_type": "instruction", "content": "must-not-persist-after-basic-withdrawal", "tone": "gentle"})
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient_task import PatientTask
    from sqlalchemy import select
    with SessionLocal() as db:
        assert db.scalar(select(PatientTask.id).where(PatientTask.patient_id == patient_id, PatientTask.task_description == "must-not-persist-after-basic-withdrawal")) is None
    assert response.status_code == 403, response.text


def test_basic_withdrawal_blocks_enhanced_care_summary_generation(client):
    _, clinician, _, owner, patient_id, _ = active_care(client, suffix="spec-care-summary")
    withdraw_basic(client, owner, patient_id)
    response = client.get(f"/api/v1/ai-enhanced/researcher/patient_care_summary/{patient_id}", headers=clinician)
    assert response.status_code == 403, response.text


def test_basic_withdrawal_blocks_new_supplied_answer_anomaly_processing(client, monkeypatch):
    patient, owner = register(client, "spec-anomaly-processing@example.com")
    patient_id = patient["user"]["patient_profile"]["id"]
    withdraw_basic(client, owner, patient_id)
    from backend.app.api.routes import ai_enhanced
    calls = []
    original = ai_enhanced.check_scale_anomalies
    def observe_processing(**kwargs):
        calls.append(True)
        return original(**kwargs)
    monkeypatch.setattr(ai_enhanced, "check_scale_anomalies", observe_processing)
    response = client.post("/api/v1/ai-enhanced/scale/anomaly_detection", headers=owner, json={"scale_type": "ASRS", "answers": [0] * 18})
    assert response.status_code == 403, response.text
    assert not calls


def test_withdrawn_clinical_consent_relationship_response_does_not_claim_effective_active(client):
    _, clinician, _, owner, patient_id, relationship = active_care(client, suffix="spec-effective")
    consent = next(row for row in consent_items(client, owner, patient_id) if row["purpose"] == "clinical_sharing")
    response = client.post(f"/api/v1/patient/consents/{consent['id']}/withdraw", headers=owner, json={"expected_revision": consent["revision"]})
    assert response.status_code == 200, response.text
    response = client.get("/api/v1/care/relationships", headers=owner)
    row = next(row for row in response.json()["items"] if row["id"] == relationship["id"])
    assert row["effective_access"] is False
    assert row.get("effective_status", row["status"]) != "active", row
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/messages", headers=clinician).status_code == 403


def test_inflight_ai_request_cannot_borrow_new_basic_grant_after_withdrawal(client, monkeypatch):
    patient, owner = register(client, "spec-inflight-new-grant@example.com")
    patient_id = patient["user"]["patient_profile"]["id"]
    basic = next(row for row in consent_items(client, owner, patient_id) if row["purpose"] == "basic_use" and row["effective_access"])
    from backend.app.api.routes import ai
    from backend.app.db.session import SessionLocal
    from backend.app.models.consent import ConsentRecord
    from backend.app.models.ai_chat_log import AIChatLog
    from backend.app.services import authorization_ledger as ledger
    from backend.app.services.consent_service import prepare_grant, prepare_withdraw
    from sqlalchemy import select
    def rotate_authority_then_return_old_artifact(**kwargs):
        with SessionLocal() as db:
            previous = db.get(ConsentRecord, basic["id"])
            prepare_withdraw(db, previous, patient["user"]["id"], previous.actor_identity_basis)
            db.commit()
            successor = prepare_grant(db, patient_id=patient_id, actor_id=patient["user"]["id"], purpose="basic_use", scope=["profile", "assessment", "tracking", "care", "imaging"])
            db.commit()
            ledger.publish(successor)
        return "stale-artifact-from-original-authority", "fallback-template", True
    monkeypatch.setattr(ai, "generate_chat_reply", rotate_authority_then_return_old_artifact)
    response = client.post("/api/v1/ai/chat", headers=owner, json={"message": "synthetic-original-run", "conversation": [], "context_scope": "general"})
    with SessionLocal() as db:
        logs = db.scalars(select(AIChatLog).where(AIChatLog.patient_id == patient_id)).all()
        assert not any(log.content == "stale-artifact-from-original-authority" for log in logs), response.text
    assert response.status_code in {403, 409}, response.text
    assert any(row["purpose"] == "basic_use" and row["effective_access"] for row in consent_items(client, owner, patient_id))


def test_inflight_remote_output_cannot_borrow_regranted_external_consent(client, monkeypatch):
    import json
    from io import BytesIO
    patient, owner = register(client, "spec-inflight-external@example.com")
    patient_id = patient["user"]["patient_profile"]["id"]
    response = client.post("/api/v1/patient/consents", headers=owner, json={"patient_id": patient_id, "purpose": "external_ai", "scope": ["profile", "assessment", "tracking"], "terms_version": "W02-1"})
    assert response.status_code == 201, response.text
    consent = response.json()
    from backend.app.services import ai_service, authorization_ledger as ledger
    from backend.app.services.consent_service import prepare_grant, prepare_withdraw
    from backend.app.db.session import SessionLocal
    from backend.app.models.consent import ConsentRecord
    from backend.app.models.ai_chat_log import AIChatLog
    from sqlalchemy import select
    monkeypatch.setattr(ai_service.settings, "DEEPSEEK_API_KEY", "synthetic-test-only-key")
    def rotate_external_before_remote_return(*args, **kwargs):
        with SessionLocal() as db:
            previous = db.get(ConsentRecord, consent["id"])
            prepare_withdraw(db, previous, patient["user"]["id"], previous.actor_identity_basis)
            db.commit()
            successor = prepare_grant(db, patient_id=patient_id, actor_id=patient["user"]["id"], purpose="external_ai", scope=["profile", "assessment", "tracking"])
            db.commit()
            ledger.publish(successor)
        body = {"model": "synthetic-remote-model", "choices": [{"message": {"content": "stale-remote-from-original-external-authority"}}]}
        return BytesIO(json.dumps(body).encode())
    monkeypatch.setattr(ai_service, "urlopen", rotate_external_before_remote_return)
    response = client.post("/api/v1/ai/chat", headers=owner, json={"message": "synthetic-question", "conversation": [], "context_scope": "general"})
    assert "stale-remote-from-original-external-authority" not in response.text, response.text
    assert response.status_code in {200, 403, 409}, response.text
    if response.status_code == 200:
        assert response.json()["provider"] == "local"
    with SessionLocal() as db:
        logs = db.scalars(select(AIChatLog).where(AIChatLog.patient_id == patient_id)).all()
        assert not any(log.content == "stale-remote-from-original-external-authority" for log in logs)


def test_multi_patient_response_keeps_all_receipts_after_commit_recheck(client, monkeypatch):
    _, clinician, _, _, first_patient_id, first_relationship = active_care(client, suffix="spec-multi-receipt")
    second_patient, second_owner = register(client, "spec-second-receipt@example.com")
    second_patient_id = second_patient["user"]["patient_profile"]["id"]
    invitation = invite(client, clinician, second_patient, second_patient_id)
    response = client.post(f"/api/v1/care/relationships/{invitation['id']}/accept", headers=second_owner, json={"expected_revision": invitation["revision"]})
    assert response.status_code == 200, response.text
    from backend.app.api.routes import doctor
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.services import authorization_ledger as ledger
    original = doctor._build_patient_item
    observed = []
    def revoke_first_patient_after_commit_recheck(db, patient):
        if not observed:
            db.commit()
            request = db.info["authorization_request"]
            observed.append({receipt[1] for receipt in request.state.authorization_receipts})
            with SessionLocal() as authority_db:
                row = authority_db.get(CareRelationship, first_relationship["id"])
                ledger.deny(row)
                row.status = "revoked"
                authority_db.commit()
        return original(db, patient)
    monkeypatch.setattr(doctor, "_build_patient_item", revoke_first_patient_after_commit_recheck)
    response = client.get("/api/v1/doctor/my_patients", headers=clinician)
    assert observed == [{first_patient_id, second_patient_id}], observed
    assert response.status_code == 403, response.text


@pytest.mark.parametrize("alias", ["driver", "parent_alias", "file_uri"])
def test_authorization_ledger_rejects_business_database_path_aliases(client, sqlite_database_path, monkeypatch, alias):
    from fastapi import HTTPException
    from backend.app.core.config import settings
    from backend.app.services.authorization_ledger import _path
    path = sqlite_database_path.resolve()
    if alias == "driver":
        database_url = f"sqlite+pysqlite:///{path.as_posix()}"
    elif alias == "file_uri":
        from sqlalchemy import create_engine
        database_url = f"sqlite:///file:/{path.as_posix()}?uri=true"
        probe = create_engine(database_url)
        try:
            with probe.connect() as db:
                actual = db.exec_driver_sql("PRAGMA database_list").all()[0][2]
            assert path.samefile(actual), "The negative fixture must actually point to the same business file."
        finally:
            probe.dispose()
    else:
        database_url = f"sqlite:///{path.parent.as_posix()}/../{path.parent.name}/{path.name}"
    monkeypatch.setattr(settings, "SQLALCHEMY_DATABASE_URI", database_url)
    monkeypatch.setattr(settings, "AUTHORIZATION_LEDGER_PATH", str(path))
    with pytest.raises(HTTPException) as error:
        _path()
    assert error.value.status_code == 503


@pytest.mark.parametrize("age_field", ["missing", "null"])
def test_new_adult_profile_registration_requires_age_without_restricting_account_only(client, age_field):
    profile = {"patient_type": "adult", "display_name": "Synthetic Adult"}
    if age_field == "null":
        profile["age"] = None
    response = client.post("/api/v1/auth/register", json={"email": "spec-missing-age@example.com", "password": "Synthetic123!", "full_name": "Synthetic New Adult", "role": "patient", "consent_agreed": True, "patient_profile": profile})
    assert response.status_code in {400, 422}, response.text
    _, new_controller = account_only(client, "spec-account-without-age@example.com")
    assert client.get("/api/v1/auth/me", headers=new_controller).json()["patient_profile"] is None


def test_guardian_review_rechecks_institutional_authority_before_grant_commit(client, monkeypatch):
    _, guardian = register(client, "spec-review-race-child@example.com", child=True)
    reviewer, reviewer_headers = register(client, "spec-review-race-institution@example.com", "researcher")
    qualify(reviewer["user"]["id"], reviewer=True)
    relationship = client.get("/api/v1/identity/context", headers=guardian).json()["guardian_relationships"][0]
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import GuardianRelationship, InstitutionMembership
    from backend.app.services import authorization_ledger as ledger
    from sqlalchemy import select
    original_deny = ledger.deny
    revoked = []
    def revoke_reviewer_after_initial_check(row):
        if isinstance(row, GuardianRelationship) and not revoked:
            with SessionLocal() as db:
                membership = db.scalar(select(InstitutionMembership).where(InstitutionMembership.user_id == reviewer["user"]["id"], InstitutionMembership.role == "reviewer"))
                original_deny(membership)
                membership.status = "revoked"
                db.commit()
                revoked.append(True)
        return original_deny(row)
    monkeypatch.setattr(ledger, "deny", revoke_reviewer_after_initial_check)
    response = client.post(f"/api/v1/identity/guardians/{relationship['id']}/review", headers=reviewer_headers, json={"expected_revision": relationship["revision"], "status": "verified", "expires_at": "2090-01-01T00:00:00Z", "review_reference": "synthetic-raced-institutional-review"})
    access_response = client.get("/api/v1/patient/dashboard_status", headers=guardian)
    assert revoked == [True]
    assert response.status_code in {403, 409}, {"review": response.status_code, "child_access": access_response.status_code}
    assert access_response.status_code == 403


def test_guardian_review_queue_rechecks_reviewer_before_releasing_child_proof(client, monkeypatch):
    register(client, "spec-review-queue-child@example.com", child=True)
    reviewer, reviewer_headers = register(client, "spec-review-queue-institution@example.com", "researcher")
    qualify(reviewer["user"]["id"], reviewer=True)
    from backend.app.api.routes import identity
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import InstitutionMembership
    from backend.app.services import authorization_ledger as ledger
    from sqlalchemy import select
    original = identity.guardian_response
    revoked = []
    def revoke_reviewer_before_proof_serialization(db, row):
        if not revoked:
            with SessionLocal() as authority_db:
                membership = authority_db.scalar(select(InstitutionMembership).where(InstitutionMembership.user_id == reviewer["user"]["id"], InstitutionMembership.role == "reviewer"))
                ledger.deny(membership)
                membership.status = "revoked"
                authority_db.commit()
                revoked.append(True)
        return original(db, row)
    monkeypatch.setattr(identity, "guardian_response", revoke_reviewer_before_proof_serialization)
    response = client.get("/api/v1/identity/guardians/review_queue", headers=reviewer_headers)
    assert revoked == [True]
    assert response.status_code in {403, 409}, response.text
    assert "synthetic-proof-ref" not in response.text


def test_guardian_review_queue_success_prohibits_sensitive_response_caching(client):
    register(client, "spec-no-store-child@example.com", child=True)
    reviewer, reviewer_headers = register(client, "spec-no-store-institution@example.com", "researcher")
    qualify(reviewer["user"]["id"], reviewer=True)
    response = client.get("/api/v1/identity/guardians/review_queue", headers=reviewer_headers)
    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["proof_reference"] == "synthetic-proof-ref"
    assert "no-store" in response.headers.get("cache-control", ""), dict(response.headers)


def test_identity_context_does_not_claim_guardian_access_suspended_before_response(client, monkeypatch):
    _, guardian, reviewer, relationship = verified_guardian(client, suffix="spec-context-guardian")
    from backend.app.api.routes import identity
    original = identity.guardian_response
    suspended = []
    def suspend_before_context_serialization(db, row):
        if not suspended:
            result = client.post(f"/api/v1/identity/guardians/{relationship['id']}/suspend", headers=reviewer, json={"expected_revision": relationship["revision"], "review_reference": "synthetic-context-suspension"})
            assert result.status_code == 200, result.text
            suspended.append(True)
        return original(db, row)
    monkeypatch.setattr(identity, "guardian_response", suspend_before_context_serialization)
    response = client.get("/api/v1/identity/context", headers=guardian)
    assert suspended == [True]
    assert client.get("/api/v1/patient/dashboard_status", headers=guardian).status_code == 403
    assert response.status_code in {200, 403, 409}, response.text
    if response.status_code == 200:
        assert response.json()["accessible_patients"] == [], response.text
    fresh = client.get("/api/v1/identity/context", headers=guardian)
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["accessible_patients"] == []
    historical = fresh.json()["guardian_relationships"][0]
    assert historical["proof_reference"] == "synthetic-proof-ref"
    assert historical["history"][-1]["action"] == "suspend"


def test_identity_context_does_not_claim_doctor_qualification_revoked_before_response(client, monkeypatch):
    doctor, clinician = register(client, "spec-context-doctor@example.com", "researcher")
    qualify(doctor["user"]["id"])
    from backend.app.api.routes import identity
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification
    from backend.app.services import authorization_ledger as ledger
    from sqlalchemy import select
    original = identity.doctor_qualification
    revoked = []
    def revoke_before_returning_qualification(db, user_id):
        qualification = original(db, user_id)
        if qualification and not revoked:
            with SessionLocal() as authority_db:
                current = authority_db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == user_id))
                ledger.deny(current)
                current.status = "revoked"
                authority_db.commit()
                revoked.append(True)
        return qualification
    monkeypatch.setattr(identity, "doctor_qualification", revoke_before_returning_qualification)
    response = client.get("/api/v1/identity/context", headers=clinician)
    assert revoked == [True]
    assert client.get("/api/v1/doctor/my_patients", headers=clinician).status_code == 403
    assert response.status_code in {200, 403, 409}, response.text
    if response.status_code == 200:
        assert response.json()["doctor_qualification"]["status"] != "verified", response.text
        assert "doctor" not in response.json()["identities"], response.text
    fresh = client.get("/api/v1/identity/context", headers=clinician)
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["doctor_qualification"]["status"] == "unverified"
    assert "doctor" not in fresh.json()["identities"]
