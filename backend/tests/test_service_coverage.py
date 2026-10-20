"""W05 coverage RED probes; only disposable synthetic stores and real HTTP.

Production coverage is intentionally not implemented in this preparation window.
These tests freeze the agreed institutional API and expose its absence. The
deadline probe isolates the real persisted attention timestamp representation;
it neither inserts a coverage approval nor replaces the production consumer.
"""
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from backend.tests.test_assessment_consumers import complete_assessment, drain
from backend.tests.test_submission_cognitive_evidence import cognitive_submission
from backend.tests.w02_helpers import register


INSTITUTION = "synthetic-institution"


def institutional_actor(client, suffix, *, institution=INSTITUTION, reviewer=False):
    """Publish actual synthetic credential heads in the disposable test ledger."""
    data, headers = register(client, f"coverage-{suffix}@example.com", "researcher")
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification, InstitutionMembership
    from backend.app.services import authorization_ledger as ledger

    with SessionLocal() as db:
        rows = [InstitutionMembership(user_id=data["user"]["id"], institution_id=institution,
            role="reviewer" if reviewer else "clinician", status="verified",
            verification_reference="synthetic-coverage-reviewed",
            expires_at=datetime.now(timezone.utc) + timedelta(days=30))]
        if not reviewer:
            rows.append(DoctorQualification(user_id=data["user"]["id"], institution_id=institution,
                status="verified", verification_reference="synthetic-coverage-doctor-reviewed",
                expires_at=datetime.now(timezone.utc) + timedelta(days=30)))
        db.add_all(rows)
        db.flush()
        for row in rows:
            ledger.reserve(row)
        db.commit()
        for row in rows:
            ledger.publish(row)
    return data, headers


def coverage_body(key="coverage-original-one", *, previous=0, institution=INSTITUTION):
    return {"client_coverage_id":key, "expected_previous_version":previous,
        "institution_id":institution, "timezone":"Asia/Shanghai",
        "working_periods":[{"weekday":day, "start":"09:00", "end":"12:00"}
            for day in range(5)] + [{"weekday":day, "start":"13:00", "end":"17:00"}
            for day in range(5)],
        "expected_response_working_minutes":120,
        "approved_process_reference":"synthetic-existing-process-reference",
        "escalation_instructions":"合成演练既有流程原文：联系本人既有医疗团队；本配置没有录入电话号码或替班人。"}


def versions_route(doctor_user_id):
    return f"/api/v1/identity/service-coverage/{doctor_user_id}/versions"


def test_verified_reviewer_records_immutable_versions_and_original_retry(client):
    doctor, _ = institutional_actor(client, "version-doctor")
    _, reviewer = institutional_actor(client, "version-reviewer", reviewer=True)
    route = versions_route(doctor["user"]["id"])
    original = coverage_body()
    first = client.post(route, headers=reviewer, json=original)
    assert first.status_code == 201, "Coverage version creation API is missing: " + first.text
    first_value = first.json()
    assert first_value["version"] == 1
    assert first_value["institution_id"] == INSTITUTION
    assert first_value["doctor_user_id"] == doctor["user"]["id"]
    assert first_value["timezone"] == "Asia/Shanghai"
    assert first_value["expected_response_working_minutes"] == 120
    assert first_value["approved_process_reference"] == original["approved_process_reference"]
    assert first_value["escalation_instructions"] == original["escalation_instructions"]
    assert datetime.fromisoformat(first_value["effective_from"].replace("Z", "+00:00")).tzinfo is not None
    retry = client.post(route, headers=reviewer, json=original)
    assert retry.status_code == 200 and retry.json() == first_value, retry.text
    changed = deepcopy(original)
    changed["expected_response_working_minutes"] = 60
    assert client.post(route, headers=reviewer, json=changed).status_code == 409
    second_body = coverage_body("coverage-original-two", previous=1)
    second_body["expected_response_working_minutes"] = 60
    second = client.post(route, headers=reviewer, json=second_body)
    assert second.status_code == 201 and second.json()["version"] == 2, second.text
    history = client.get(route, headers=reviewer, params={"institution_id":INSTITUTION})
    assert history.status_code == 200, history.text
    rows = {row["version"]:row for row in history.json()["items"]}
    assert rows[1] == first_value and rows[2] == second.json()


@pytest.mark.parametrize("writer", ["unverified_role", "doctor", "other_institution_reviewer"])
def test_only_verified_reviewer_of_actual_doctor_institution_can_configure(client, writer):
    doctor, clinician = institutional_actor(client, "restricted-doctor")
    if writer == "unverified_role":
        _, headers = register(client, "coverage-raw-role@example.com", "researcher")
    elif writer == "doctor":
        headers = clinician
    else:
        _, headers = institutional_actor(client, "other-reviewer",
            institution="synthetic-other-institution", reviewer=True)
    response = client.post(versions_route(doctor["user"]["id"]), headers=headers, json=coverage_body())
    assert response.status_code == 403, "Institutional coverage permission API is missing: " + response.text


def test_actual_doctor_without_configuration_gets_explicit_unknown_coverage(client):
    _, doctor = institutional_actor(client, "unconfigured-doctor")
    response = client.get("/api/v1/care/doctor/service-coverage", headers=doctor)
    assert response.status_code == 200, "Current doctor coverage API is missing: " + response.text
    value = response.json()
    assert value["status"] == "not_configured"
    assert value["emergency_process"] == "not_configured"
    assert value.get("expected_response_at") is None
    assert value.get("working_periods") in (None, [])


def test_existing_clinical_attention_truthfully_has_no_coverage_or_deadline(client):
    owner, doctor, session, patient_id = complete_assessment(client, doctor=True)
    assert drain() == 8
    actual = client.get("/api/v1/care/doctor/work_queue", headers=doctor)
    assert actual.status_code == 200, actual.text
    row = next(row for row in actual.json()["items"] if row["assessment_id"] == session["id"])
    assert row["owner_kind"] == "doctor" and row["responsible_doctor_id"] == session["responsible_doctor_id"]
    assert row["response_coverage"]["status"] == "not_configured"
    assert row["expected_response_at"] is None
    own = client.get(f"/api/v1/care/patient/attention?patient_id={patient_id}", headers=owner)
    assert own.status_code == 200, own.text
    assert next(value for value in own.json()["items"] if value["id"] == row["id"])["expected_response_at"] is None


def test_existing_self_attention_has_no_fake_doctor_or_coverage_deadline(client):
    owner, _, _, _, body = cognitive_submission(client, "flanker")
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    saved = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert saved.status_code == 201 and saved.json()["quality_status"] == "limited", saved.text
    assert drain() == 2
    actual = client.get(f"/api/v1/care/patient/attention?patient_id={body['patient_id']}", headers=owner)
    assert actual.status_code == 200, actual.text
    row = actual.json()["items"][0]
    assert row["owner_kind"] == "patient_self" and row["responsible_doctor_id"] is None
    assert row["relationship_id"] is None and row["expected_response_at"] is None
    assert row["response_coverage"]["status"] == "not_configured"


def test_nonempty_utc_deadline_authenticates_after_flush_commit_and_new_session(client):
    _, _, session, _ = complete_assessment(client, doctor=True)
    assert drain() == 8
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    from backend.app.services.attention_service import state_values, verify_attention

    # Only stage this currently supported mutable state in the disposable DB.
    # No mocked timezone, fabricated coverage version or raw ciphertext edit.
    with SessionLocal() as db:
        row = db.scalar(select(AttentionItem).where(AttentionItem.assessment_id == session["id"]))
        attention_id = row.id
        row.expected_response_at = datetime(2026, 10, 16, 9, 0, tzinfo=timezone.utc)
        row.version += 1
        snapshot = state_values(row)
        row.state_snapshot = snapshot
        db.flush()
        verify_attention(row)
        db.commit()
    with SessionLocal() as db:
        actual = db.get(AttentionItem, attention_id)
        assert state_values(actual) == snapshot, (
            "A real UTC deadline changes authenticated state after SQLite commit and reload: "
            f"{state_values(actual)!r} != {snapshot!r}")
        verify_attention(actual)
