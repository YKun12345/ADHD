"""Independent W03 foundation checks against real HTTP and isolated persistence.

APP_ENV=test and provider key empty must be set before pytest collection.
Product modules import only after the existing temporary client fixture runs.
"""
import json
from pathlib import Path

import pytest

from backend.tests.test_assessment_sessions import actor, created, create, start
from backend.tests.test_authorization_edges import active_care
from backend.tests.w02_helpers import register, qualify, grant_synthetic_patient_authority


def publish(client, clinician, draft):
    response = client.post(f"/api/v1/care/assessments/{draft['id']}/publish", headers=clinician,
                           json={"expected_version": draft["version"]})
    assert response.status_code == 200, response.text
    return response.json()


def test_spec_registry_matches_unapproved_source_snapshot_and_all_twelve_configs(client):
    from backend.app.services.assessment_templates import templates, digest
    snapshot = json.loads((Path(__file__).resolve().parents[2] / "docs/evidence/w03-template-source-snapshot.json").read_text(encoding="utf-8"))
    frozen = templates()
    assert len(frozen) == 2
    for template in frozen:
        assert template["professional_approval"] is None
        assert template["source_status"] == "project_legacy_unverified"
        assert template["license_status"] == "not_verified"
        assert template["allowed_report_types"] == []
        scale = template["items"][0]
        source_scale = next(row for row in snapshot["scales"] if row["age_group"] == template["age_group"])
        assert scale["content_digest"] == source_scale["content_sha256"]
        assert scale["recall_window"] == "P6M"
        assert len(scale["config"]["questions"]) == source_scale["questions"]
        for definition in template["items"][1:]:
            source = next(row for row in snapshot["cognitive_configs"] if (row["age_group"], row["task_id"]) == (template["age_group"], definition["key"]))
            assert definition["config"] == source["config"]
            assert definition["config_digest"] == source["project_config_sha256"] == digest(source["config"])


def test_spec_under_six_child_has_no_engineering_template_or_false_create_permission(client):
    _, guardian, pid = actor(client, child=True, suffix="spec-young")
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient import Patient
    with SessionLocal() as db:
        db.get(Patient, pid).age = 5
        db.commit()
    response = client.get(f"/api/v1/care/assessment-templates?patient_id={pid}", headers=guardian)
    assert response.status_code == 200, response.text
    assert response.json()["items"] == []
    assert "no_applicable_engineering_age_template" in response.json()["blockers"]
    assert response.json()["can_create"] is False
    assert create(client, guardian, pid, child=True).status_code == 422


def test_spec_active_original_doctor_relationship_cannot_borrow_regrant_for_launch(client):
    doctor, clinician, _, owner, pid, relation = active_care(client, suffix="spec-original-launch")
    draft = created(client, clinician, pid, doctor=True)
    active = publish(client, clinician, draft)
    first = start(client, owner, active["items"][1], pid)
    assert first.status_code == 201, first.text
    revoke = client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=owner,
                         json={"expected_revision": relation["revision"]})
    assert revoke.status_code == 200, revoke.text
    grant_synthetic_patient_authority(pid, doctor["user"]["id"])
    read = client.get(f"/api/v1/care/assessments/{active['id']}", headers=owner)
    assert read.status_code == 200, read.text
    current = read.json()["items"][1]
    assert current["attempts"] == [first.json()]
    assert current["allowed_actions"] == []
    assert start(client, owner, current, pid).status_code == 403
    assert read.json()["status"] == "active"  # W05 durable suspension is explicitly pending.
    fresh = created(client, clinician, pid, doctor=True)
    new_active = publish(client, clinician, fresh)
    assert start(client, owner, new_active["items"][1], pid).status_code == 201


@pytest.mark.parametrize("kind", ["scale", "cognitive"])
def test_spec_attempt_authority_denied_after_item_update_rolls_back_attempt_and_version(client, monkeypatch, kind):
    _, owner, pid = actor(client, suffix="spec-attempt-race")
    session = created(client, owner, pid)
    item = next(row for row in session["items"] if row["kind"] == kind)
    from backend.app.services import assessment_service, authorization_ledger as ledger
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import ConsentRecord
    from backend.app.models.assessment import AssessmentItem, TaskAttempt
    from sqlalchemy import select
    original = assessment_service._commit
    fired = []

    def deny_before_commit(db):
        if not fired:
            with SessionLocal() as authority_db:
                basic = authority_db.scalar(select(ConsentRecord).where(ConsentRecord.patient_id == pid, ConsentRecord.purpose == "basic_use"))
                ledger.deny(basic)
            fired.append(True)
        return original(db)

    monkeypatch.setattr(assessment_service, "_commit", deny_before_commit)
    response = start(client, owner, item, pid)
    assert response.status_code == 403, response.text
    assert fired == [True]
    with SessionLocal() as db:
        assert db.scalar(select(TaskAttempt.id)) is None
        stored = db.get(AssessmentItem, item["id"])
        assert stored.version == item["version"]
        assert stored.execution_status == "not_started"


def test_spec_publish_authority_denied_after_cas_rolls_back_publication_and_seven_tasks(client, monkeypatch):
    doctor, clinician, _, _, pid, _ = active_care(client, suffix="spec-publish-race")
    draft = created(client, clinician, pid, doctor=True)
    from backend.app.services import assessment_service, authorization_ledger as ledger
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification
    from backend.app.models.assessment import AssessmentSession
    from backend.app.models.patient_task import PatientTask
    from sqlalchemy import select
    original = assessment_service._commit
    fired = []

    def deny_before_commit(db):
        if not fired:
            with SessionLocal() as authority_db:
                qualification = authority_db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == doctor["user"]["id"]))
                ledger.deny(qualification)
            fired.append(True)
        return original(db)

    monkeypatch.setattr(assessment_service, "_commit", deny_before_commit)
    response = client.post(f"/api/v1/care/assessments/{draft['id']}/publish", headers=clinician,
                           json={"expected_version": draft["version"]})
    assert response.status_code == 403, response.text
    assert fired == [True]
    with SessionLocal() as db:
        row = db.get(AssessmentSession, draft["id"])
        assert row.status == "draft" and row.published_at is None and row.version == draft["version"]
        assert db.scalar(select(PatientTask.id)) is None


def test_spec_template_positive_permission_cannot_return_after_basic_head_deny(client, monkeypatch):
    _, owner, pid = actor(client, suffix="spec-template-race")
    from backend.app.services import assessment_service, authorization_ledger as ledger
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import ConsentRecord
    from sqlalchemy import select
    original = assessment_service.template_response

    def deny_after_body(db, user, patient):
        body = original(db, user, patient)
        assert body["can_create_self"] is True
        with SessionLocal() as authority_db:
            basic = authority_db.scalar(select(ConsentRecord).where(ConsentRecord.patient_id == pid, ConsentRecord.purpose == "basic_use"))
            ledger.deny(basic)
        return body

    monkeypatch.setattr(assessment_service, "template_response", deny_after_body)
    response = client.get(f"/api/v1/care/assessment-templates?patient_id={pid}", headers=owner)
    assert response.status_code == 403, response.text


def test_spec_private_draft_not_visible_to_other_authorized_doctor_or_previous_reference(client):
    _, clinician, _, owner, pid, _ = active_care(client, suffix="spec-draft-other")
    draft = created(client, clinician, pid, doctor=True)
    other, other_headers = register(client, "w03-spec-other-doctor@example.com", "researcher")
    grant_synthetic_patient_authority(pid, other["user"]["id"])
    for headers in (owner, other_headers):
        assert client.get(f"/api/v1/care/assessments/{draft['id']}", headers=headers).status_code == 403
        listing = client.get(f"/api/v1/care/assessments?patient_id={pid}", headers=headers)
        assert listing.status_code == 200, listing.text
        assert draft["id"] not in {row["id"] for row in listing.json()["items"]}
        assert create(client, headers, pid, doctor=headers == other_headers, previous_assessment_id=draft["id"]).status_code == 403
    active = publish(client, clinician, draft)
    assert client.get(f"/api/v1/care/assessments/{active['id']}", headers=other_headers).status_code == 200


def test_spec_sharing_self_batch_preserves_original_attempt_source_and_identity(client):
    owner_data, owner, pid = actor(client, suffix="spec-self-share")
    session = created(client, owner, pid)
    first = start(client, owner, session["items"][0], pid)
    assert first.status_code == 201, first.text
    doctor, clinician = register(client, "w03-spec-share-doctor@example.com", "researcher")
    grant_synthetic_patient_authority(pid, doctor["user"]["id"])
    shared = client.get(f"/api/v1/care/assessments/{session['id']}", headers=clinician)
    assert shared.status_code == 200, shared.text
    body = shared.json()
    assert body["source"] == "self" and body["responsible_doctor_id"] is None
    assert body["created_by_user_id"] == owner_data["user"]["id"]
    assert body["items"][0]["attempts"] == [first.json()]
    assert all(row["acceptance_status"] == "not_required" and row["patient_task_id"] is None for row in body["items"])
    assert body["allowed_actions"] == []
    assert all(row["allowed_actions"] == [] for row in body["items"])


def test_spec_no_store_for_successful_creation_read_list_registry_and_attempt(client):
    _, owner, pid = actor(client, suffix="spec-no-store")
    response = create(client, owner, pid)
    assert response.status_code == 201, response.text
    session = response.json()
    replies = [response, client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner),
               client.get(f"/api/v1/care/assessments?patient_id={pid}", headers=owner),
               client.get(f"/api/v1/care/assessment-templates?patient_id={pid}", headers=owner),
               start(client, owner, session["items"][0], pid)]
    assert all(reply.status_code in {200, 201} for reply in replies)
    assert all(reply.headers.get("cache-control") == "no-store" for reply in replies)


def test_spec_list_unfiltered_unites_self_and_current_doctor_assessment_authority(client):
    doctor, clinician, own_pid = actor(client, suffix="spec-dual-authority")
    qualify(doctor["user"]["id"])
    own = created(client, clinician, own_pid)
    _, _, target_pid = actor(client, suffix="spec-dual-target")
    grant_synthetic_patient_authority(target_pid, doctor["user"]["id"])
    assigned = created(client, clinician, target_pid, doctor=True)
    scoped = client.get(f"/api/v1/care/assessments?patient_id={target_pid}", headers=clinician)
    assert scoped.status_code == 200 and assigned["id"] in {row["id"] for row in scoped.json()["items"]}
    listing = client.get("/api/v1/care/assessments", headers=clinician)
    assert listing.status_code == 200, listing.text
    assert {own["id"], assigned["id"]} <= {row["id"] for row in listing.json()["items"]}, listing.text


def test_spec_list_union_does_not_expand_care_only_or_unrelated_assessment_scope(client):
    doctor, clinician, own_pid = actor(client, suffix="spec-union-scope")
    qualify(doctor["user"]["id"])
    own = created(client, clinician, own_pid)
    care_data, care_owner, care_pid = actor(client, suffix="spec-union-care")
    care_session = created(client, care_owner, care_pid)
    invitation = client.post("/api/v1/care/relationships/invitations", headers=clinician, json={
        "patient_id": care_pid, "target_email": care_data["user"]["email"], "scope": ["care"], "purpose": "clinical_sharing"})
    assert invitation.status_code == 201, invitation.text
    accepted = client.post(f"/api/v1/care/relationships/{invitation.json()['id']}/accept", headers=care_owner,
                           json={"expected_revision": invitation.json()["revision"]})
    assert accepted.status_code == 200, accepted.text
    _, unrelated_owner, unrelated_pid = actor(client, suffix="spec-union-unrelated")
    unrelated = created(client, unrelated_owner, unrelated_pid)
    listing = client.get("/api/v1/care/assessments", headers=clinician)
    assert listing.status_code == 200, listing.text
    assert {row["id"] for row in listing.json()["items"]} == {own["id"]}
    for session in (care_session, unrelated):
        assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=clinician).status_code == 403


def test_spec_list_union_denied_doctor_qualification_keeps_only_own_history(client):
    doctor, clinician, own_pid = actor(client, suffix="spec-union-denied")
    qualify(doctor["user"]["id"])
    own = created(client, clinician, own_pid)
    _, _, target_pid = actor(client, suffix="spec-union-denied-target")
    grant_synthetic_patient_authority(target_pid, doctor["user"]["id"])
    assigned = created(client, clinician, target_pid, doctor=True)
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification
    from backend.app.services import authorization_ledger as ledger
    from sqlalchemy import select
    with SessionLocal() as db:
        ledger.deny(db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == doctor["user"]["id"])))
    listing = client.get("/api/v1/care/assessments", headers=clinician)
    assert listing.status_code == 200, listing.text
    assert {row["id"] for row in listing.json()["items"]} == {own["id"]}
    assert client.get(f"/api/v1/care/assessments/{assigned['id']}", headers=clinician).status_code == 403
