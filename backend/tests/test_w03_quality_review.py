"""Independent W03 quality review: real API, temporary stores only.

Set APP_ENV=test and an empty provider key before pytest collection.
This file does not import product modules until the isolated client exists.
"""
from copy import deepcopy

import pytest

from backend.tests.test_assessment_sessions import actor, created, create, start
from backend.tests.test_authorization_edges import active_care


@pytest.mark.parametrize("claimed_source", ["self_report", "guardian_report"])
def test_quality_doctor_background_cannot_claim_doctor_as_self_or_guardian_reporter(client, claimed_source):
    _, clinician, _, _, pid, _ = active_care(client, suffix="quality-source")
    response = create(client, clinician, pid, doctor=True, background={
        "sleep": {"status": "provided", "value": "Synthetic patient feedback", "source": claimed_source, "confirmed": True}
    })
    assert response.status_code == 422, response.text


def test_quality_doctor_background_retains_actual_recorder_and_patient_feedback_source(client):
    doctor, clinician, _, _, pid, _ = active_care(client, suffix="quality-background-positive")
    response = create(client, clinician, pid, doctor=True, background={
        "sleep": {"status": "provided", "value": "Synthetic patient feedback", "source": "patient_report", "confirmed": True}
    })
    assert response.status_code == 201, response.text
    field = response.json()["background"]["sleep"]
    assert field["source"] == "patient_report"
    assert field["recorded_by_user_id"] == field["confirmed_by_user_id"] == doctor["user"]["id"]


@pytest.mark.parametrize("endpoint", ["detail", "list"])
def test_quality_profile_receipt_denied_after_read_serialization_discloses_no_background(client, monkeypatch, endpoint):
    doctor, clinician, _, owner, pid, relationship = active_care(client, suffix="quality-read-race")
    session = created(client, owner, pid, background={
        "sleep": {"status": "provided", "value": "SYNTHETIC PRIVATE BACKGROUND", "source": "self_report", "confirmed": True}
    })
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.services import assessment_service, authorization_ledger as ledger

    original = assessment_service.session_response
    fired = []

    def deny_after_body(db, row, user):
        body = original(db, row, user)
        if user.id == doctor["user"]["id"] and not fired:
            assert body.background["sleep"]["value"] == "SYNTHETIC PRIVATE BACKGROUND"
            with SessionLocal() as authority_db:
                ledger.deny(authority_db.get(CareRelationship, relationship["id"]))
            fired.append(True)
        return body

    monkeypatch.setattr(assessment_service, "session_response", deny_after_body)
    route = f"/api/v1/care/assessments/{session['id']}" if endpoint == "detail" else f"/api/v1/care/assessments?patient_id={pid}"
    response = client.get(route, headers=clinician)
    assert fired == [True]
    assert response.status_code == 403, response.text
    assert "SYNTHETIC PRIVATE BACKGROUND" not in response.text


def test_quality_stale_item_start_returns_conflict_without_another_attempt_or_version_increment(client):
    _, owner, pid = actor(client, suffix="quality-cas")
    session = created(client, owner, pid)
    item = session["items"][1]
    first = start(client, owner, item, pid)
    assert first.status_code == 201, first.text
    stale = start(client, owner, item, pid)
    assert stale.status_code == 409, stale.text
    actual = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()["items"][1]
    assert actual["version"] == item["version"] + 1
    assert actual["attempts"] == [first.json()]
    assert actual["execution_status"] == "in_progress"
    assert actual["quality_status"] == "pending_validation"
    assert actual["acceptance_status"] == "not_required"


@pytest.mark.parametrize("field,value", [("actor_user_id", 999), ("performer_user_id", 999), ("submitter_user_id", 999), ("run_id", "borrowed")])
def test_quality_client_cannot_add_attempt_identity_or_reuse_a_run(client, field, value):
    _, owner, pid = actor(client, suffix="quality-forged-identity")
    item = created(client, owner, pid)["items"][0]
    response = start(client, owner, item, pid, **{field: value})
    assert response.status_code == 422, response.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.assessment import TaskAttempt
    from sqlalchemy import select
    with SessionLocal() as db:
        assert db.scalar(select(TaskAttempt.id)) is None


def test_quality_orm_cannot_rewrite_attempt_owner_after_creation(client):
    _, owner, pid = actor(client, suffix="quality-immutable")
    _, _, other_pid = actor(client, suffix="quality-immutable-other")
    session = created(client, owner, pid)
    first = start(client, owner, session["items"][1], pid)
    assert first.status_code == 201, first.text
    frozen = deepcopy(first.json())
    from backend.app.db.session import SessionLocal
    from backend.app.models.assessment import TaskAttempt
    with SessionLocal() as db:
        row = db.get(TaskAttempt, frozen["id"])
        row.patient_id = other_pid
        with pytest.raises(ValueError, match="immutable"):
            db.commit()
        db.rollback()
    actual = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert actual.status_code == 200, actual.text
    assert actual.json()["items"][1]["attempts"] == [frozen]


def test_quality_production_setting_preserves_read_history_but_disallows_synthetic_start(client, monkeypatch):
    _, owner, pid = actor(client, suffix="quality-production")
    session = created(client, owner, pid)
    from backend.app.core.config import settings
    monkeypatch.setattr(settings, "APP_ENV", "production")
    read = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert read.status_code == 200, read.text
    assert read.json()["allowed_actions"] == []
    assert all(item["allowed_actions"] == [] for item in read.json()["items"])
    assert start(client, owner, session["items"][1], pid).status_code == 403
