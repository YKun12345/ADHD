"""Independent W02 quality checks; all HTTP stores come from test-only fixtures."""

import pytest

from backend.tests.w02_helpers import register, qualify
from backend.tests.test_authorization_edges import active_care, verified_guardian


def test_pending_guardian_context_rechecks_login_account_before_own_proof_response(client, monkeypatch):
    guardian_user, guardian = register(client, "quality-pending-context@example.com", child=True)
    from backend.app.api.routes import identity
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User

    original = identity.guardian_response
    disabled = []

    def disable_account_before_serializing_proof(db, row):
        if not disabled:
            disabled.append(True)
            with SessionLocal() as authority_db:
                authority_db.get(User, guardian_user["user"]["id"]).is_active = False
                authority_db.commit()
        return original(db, row)

    monkeypatch.setattr(identity, "guardian_response", disable_account_before_serializing_proof)
    response = client.get("/api/v1/identity/context", headers=guardian)
    assert disabled
    # An active account may read its retained proof; a disabled login may not release it.
    assert response.status_code in {401, 403}, response.text
    assert "synthetic-proof-ref" not in response.text
    assert client.get("/api/v1/identity/context", headers=guardian).status_code == 401


def test_report_authority_without_care_scope_remains_reachable_from_doctor_list(client):
    _, clinician, _, _, patient_id, _ = active_care(
        client, suffix="quality-partial-report", scope=["profile", "assessment", "tracking", "imaging"]
    )
    report = client.get(f"/api/v1/doctor/patient/{patient_id}/report", headers=clinician)
    assert report.status_code == 200, report.text
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/messages", headers=clinician).status_code == 403
    patients = client.get("/api/v1/doctor/my_patients", headers=clinician)
    assert patients.status_code == 200, patients.text
    assert patient_id in [row["patient_id"] for row in patients.json()["items"]], patients.text
    dashboard = client.get("/api/v1/doctor/dashboard_stats", headers=clinician)
    assert dashboard.status_code == 200, dashboard.text
    assert dashboard.json()["patient_count"] == 1, dashboard.text


def test_doctor_initiated_pending_child_invitation_exposes_no_unconfirmed_child_name(client):
    child, guardian, _, relationship = verified_guardian(client, suffix="quality-pending-child")
    doctor, clinician = register(client, "quality-pending-clinician@example.com", role="researcher")
    qualify(doctor["user"]["id"])
    response = client.post("/api/v1/care/relationships/invitations", headers=clinician, json={
        "target_email": child["user"]["email"], "patient_id": relationship["patient_id"],
        "scope": ["profile", "assessment", "tracking", "care", "imaging"],
        "purpose": "clinical_sharing",
    })
    assert response.status_code == 201, response.text
    pending = response.json()
    assert pending["status"] == "pending" and not pending["patient_confirmed"]
    assert client.get(f"/api/v1/doctor/patient/{relationship['patient_id']}/report", headers=clinician).status_code == 403
    assert "Synthetic Child" not in response.text, response.text
    listed = client.get("/api/v1/care/relationships", headers=clinician)
    assert listed.status_code == 200, listed.text
    assert "Synthetic Child" not in listed.text, listed.text
    accepted = client.post(f"/api/v1/care/relationships/{pending['id']}/accept", headers=guardian,
                           json={"expected_revision": pending["revision"]})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["patient_name"] == "Synthetic Child"


def test_active_care_only_relationship_does_not_expand_into_profile_name(client):
    _, clinician, _, _, patient_id, _ = active_care(client, suffix="quality-care-name", scope=["care"])
    response = client.get("/api/v1/care/relationships", headers=clinician)
    assert response.status_code == 200, response.text
    assert "Synthetic Adult" not in response.text, response.text
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/messages", headers=clinician).status_code == 200
    assert client.get(f"/api/v1/doctor/patient/{patient_id}/report", headers=clinician).status_code == 403


def test_active_profile_only_relationship_preserves_list_contact_but_not_assessment_score(client):
    _, clinician, _, owner, patient_id, _ = active_care(client, suffix="quality-profile-score", scope=["profile"])
    scale = client.post("/api/v1/patient/submit_scale", headers=owner,
                        json={"scale_type": "ASRS", "answers": [4] * 18})
    assert scale.status_code == 201, scale.text
    assert scale.json()["total_score"] == 72
    response = client.get("/api/v1/doctor/my_patients", headers=clinician)
    assert response.status_code == 200, response.text
    item = next((row for row in response.json()["items"] if row["patient_id"] == patient_id), None)
    assert item is not None, response.text
    assert item["patient_name"] == "Synthetic Adult"
    assert item["latest_scale_total_score"] is None, item
    assert item["latest_scale_risk_level"] is None, item
    assert item["latest_scale_type"] is None, item
    assert item["completed_tracking_days"] is None, item
    assert item["cognitive_test_count"] is None, item
    assert item["has_imaging"] is None, item


def test_assessment_only_list_returns_actual_score_without_profile_or_other_evidence(client):
    _, clinician, _, owner, patient_id, _ = active_care(client, suffix="quality-assessment-profile", scope=["assessment"])
    scale = client.post("/api/v1/patient/submit_scale", headers=owner,
                        json={"scale_type": "ASRS", "answers": [4] * 18})
    assert scale.status_code == 201, scale.text
    response = client.get("/api/v1/doctor/my_patients", headers=clinician)
    assert response.status_code == 200, response.text
    item = next((row for row in response.json()["items"] if row["patient_id"] == patient_id), None)
    assert item is not None, response.text
    assert item["latest_scale_total_score"] == 72, item
    assert item["latest_scale_type"] == "ASRS", item
    assert item["patient_name"] is None, item
    assert item["patient_email"] is None, item
    assert item["patient_type"] is None, item
    assert item["created_at"] is None, item
    assert item["completed_tracking_days"] is None, item
    assert item["has_imaging"] is None, item
    assert item["allowed_scope"] == ["assessment"], item


def test_disabled_account_only_actor_cannot_persist_new_identity_confirmation(client, monkeypatch):
    _, _, _, relationship = verified_guardian(client, suffix="quality-disabled-confirmation")
    from backend.tests.test_authorization_edges import account_only
    new_user, prospective = account_only(client, "quality-disabled-new-identity@example.com")
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.models.identity import IdentityConfirmation
    from sqlalchemy.orm import Session
    from sqlalchemy import select
    original_commit = Session.commit
    disabled = []

    def disable_actor_before_confirmation_commit(db):
        if not disabled and any(isinstance(row, IdentityConfirmation) for row in db.new):
            disabled.append(True)
            with SessionLocal() as authority_db:
                authority_db.get(User, new_user["user"]["id"]).is_active = False
                original_commit(authority_db)
        return original_commit(db)

    monkeypatch.setattr(Session, "commit", disable_actor_before_confirmation_commit)
    response = client.post(f"/api/v1/identity/guardians/{relationship['id']}/confirm-transfer", headers=prospective,
                           json={"expected_revision": relationship["revision"], "proof_reference": "synthetic-no-disabled-controller",
                                 "terms_version": "W02-1", "age": 35})
    assert disabled
    assert response.status_code in {401, 403}, response.text
    with SessionLocal() as db:
        assert db.scalar(select(IdentityConfirmation.id).where(IdentityConfirmation.user_id == new_user["user"]["id"])) is None


@pytest.mark.parametrize("scope", ["profile", "assessment", "tracking", "imaging"])
def test_single_report_scope_returns_real_selected_evidence_and_redacts_other_scopes(client, scope):
    doctor, clinician, _, owner, patient_id, _ = active_care(client, suffix=f"quality-report-{scope}", scope=[scope])
    scale = client.post("/api/v1/patient/submit_scale", headers=owner,
                        json={"scale_type": "ASRS", "answers": [4] * 18})
    assert scale.status_code == 201, scale.text
    tracking = client.post("/api/v1/patient/submit_daily_log", headers=owner,
                           json={"day_index": 1, "focus_minutes": 37, "note": "synthetic-quality-tracking-note"})
    assert tracking.status_code == 201, tracking.text
    # Explicit synthetic report fixture; no image file or inference model is opened.
    from backend.app.db.session import SessionLocal
    from backend.app.models.imaging_visualization import ImagingVisualization
    with SessionLocal() as db:
        db.add(ImagingVisualization(patient_id=patient_id, researcher_id=doctor["user"]["id"],
                                    visualization_type="nifti", summary_text="synthetic-quality-imaging-summary",
                                    notes="synthetic-quality-imaging-notes"))
        db.commit()
    response = client.get(f"/api/v1/doctor/patient/{patient_id}/report", headers=clinician)
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["allowed_scope"] == [scope], report
    if scope == "profile":
        assert report["patient_name"] == "Synthetic Adult", report
    else:
        assert report["patient_name"] is None, report
        assert report["patient_email"] is None, report
        assert report["patient_type"] is None, report
    if scope == "assessment":
        assert report["latest_scale"]["total_score"] == 72, report
    else:
        assert report["latest_scale"] is None, report
        assert report["cognitive_profile"] is None, report
    if scope == "tracking":
        assert report["tracking_summary"]["completed_count"] == 1, report
        assert report["tracking_logs"][0]["note"] == "synthetic-quality-tracking-note", report
    else:
        assert report["tracking_summary"] is None, report
        assert report["tracking_logs"] is None, report
        assert "synthetic-quality-tracking-note" not in response.text
    if scope == "imaging":
        assert report["latest_imaging_visualization"]["notes"] == "synthetic-quality-imaging-notes", report
    else:
        assert report["latest_imaging_visualization"] is None, report
        assert report["latest_model_prediction"] is None, report
        assert "synthetic-quality-imaging-notes" not in response.text
    assert report["care_summary"] == [] and report["suggested_actions"] == [], report


def test_care_only_late_deny_cannot_leave_positive_state_but_retains_fresh_lawful_history(client, monkeypatch):
    doctor, clinician, _, owner, patient_id, relationship = active_care(
        client, suffix="quality-late-deny-history", scope=["care"]
    )
    from backend.app.services import care_relationship_service, consent_service
    original = care_relationship_service.require_patient_access
    denied = []

    def unavailable_business_withdraw(*args, **kwargs):
        raise RuntimeError("synthetic business withdrawal cannot commit")

    def deny_after_positive_authority_check(db, user, selected_patient_id, scope="profile", *, record=True, relationship_id=None):
        options = {"record": record}
        if relationship_id is not None:
            options["relationship_id"] = relationship_id
        patient = original(db, user, selected_patient_id, scope, **options)
        requested = {scope} if isinstance(scope, str) else set(scope)
        if not denied and selected_patient_id == patient_id and user.id == doctor["user"]["id"] and requested == {"care"}:
            monkeypatch.setattr(consent_service, "prepare_withdraw", unavailable_business_withdraw)
            with pytest.raises(RuntimeError, match="synthetic business withdrawal cannot commit"):
                client.post(f"/api/v1/care/relationships/{relationship['id']}/revoke", headers=owner,
                            json={"expected_revision": relationship["revision"]})
            denied.append(True)
        return patient

    monkeypatch.setattr(care_relationship_service, "require_patient_access", deny_after_positive_authority_check)
    late = client.get("/api/v1/care/relationships", headers=clinician)
    assert denied == [True]
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/messages", headers=clinician).status_code == 403
    assert late.status_code in {403, 409} or (
        late.status_code == 200 and not next(row for row in late.json()["items"] if row["id"] == relationship["id"])["effective_access"]
    ), late.text
    for actor in (owner, clinician):
        fresh = client.get("/api/v1/care/relationships", headers=actor)
        assert fresh.status_code == 200, fresh.text
        historical = next(row for row in fresh.json()["items"] if row["id"] == relationship["id"])
        assert historical["effective_access"] is False, historical
        assert historical["effective_status"] == "denied", historical
        assert "no-store" in fresh.headers.get("cache-control", ""), fresh.headers
    assert client.get("/api/v1/patient/comprehensive_report", headers=owner).status_code == 200


def test_old_denied_relationship_cannot_borrow_effective_state_from_new_accepted_relationship(client, monkeypatch):
    doctor, clinician, _, owner, patient_id, old = active_care(
        client, suffix="quality-distinct-relationship-state", scope=["care"]
    )
    from backend.app.services import consent_service

    def unavailable_business_withdraw(*args, **kwargs):
        raise RuntimeError("synthetic interrupted relationship withdrawal")

    with monkeypatch.context() as withdrawal_patch:
        withdrawal_patch.setattr(consent_service, "prepare_withdraw", unavailable_business_withdraw)
        with pytest.raises(RuntimeError, match="synthetic interrupted relationship withdrawal"):
            client.post(f"/api/v1/care/relationships/{old['id']}/revoke", headers=owner,
                        json={"expected_revision": old["revision"]})
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/messages", headers=clinician).status_code == 403
    invitation = client.post("/api/v1/care/relationships/invitations", headers=owner,
                             json={"target_email": doctor["user"]["email"], "patient_id": patient_id,
                                   "scope": ["care"], "purpose": "clinical_sharing"})
    assert invitation.status_code == 201, invitation.text
    new = invitation.json()
    accepted = client.post(f"/api/v1/care/relationships/{new['id']}/accept", headers=clinician,
                           json={"expected_revision": new["revision"]})
    assert accepted.status_code == 200, accepted.text
    assert new["id"] != old["id"]
    assert client.get(f"/api/v1/care/doctor/patient/{patient_id}/messages", headers=clinician).status_code == 200
    response = client.get("/api/v1/care/relationships", headers=clinician)
    assert response.status_code == 200, response.text
    rows = {row["id"]: row for row in response.json()["items"]}
    assert rows[new["id"]]["effective_access"] is True, rows
    assert rows[old["id"]]["effective_access"] is False, rows
    assert rows[old["id"]]["effective_status"] == "denied", rows
