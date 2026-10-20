"""Working-time mathematics and actual immutable institutional persistence."""
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, text

from backend.tests.test_service_coverage import coverage_body, institutional_actor, versions_route


@pytest.mark.parametrize("start,minutes,expected", [
    ("2026-10-16T08:00:00+00:00", 120, "2026-10-19T02:00:00+00:00"),
    ("2026-10-16T03:30:00+00:00", 60, "2026-10-16T05:30:00+00:00"),
    ("2026-10-17T01:00:00+00:00", 120, "2026-10-19T03:00:00+00:00"),
    ("2026-10-16T08:59:59.123456+00:00", 1, "2026-10-19T01:00:59.123456+00:00"),
])
def test_actual_working_time_skips_lunch_nights_and_weekends(start, minutes, expected):
    from backend.app.services.service_coverage_service import working_deadline
    assert working_deadline(datetime.fromisoformat(start), coverage_body()["working_periods"], minutes).isoformat() == expected


def test_coverage_records_authenticate_routing_and_cannot_be_updated_or_deleted(client):
    doctor, _ = institutional_actor(client, "immutable-doctor")
    _, reviewer = institutional_actor(client, "immutable-reviewer", reviewer=True)
    result = client.post(versions_route(doctor["user"]["id"]), headers=reviewer, json=coverage_body())
    assert result.status_code == 201, result.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.service_coverage import ServiceCoverageVersion
    from backend.app.core.record_envelope import RecordIntegrityError
    for remove in (False, True):
        with SessionLocal() as db:
            row = db.scalar(select(ServiceCoverageVersion))
            if remove:
                db.delete(row)
            else:
                row.version += 1
            with pytest.raises(ValueError, match="immutable"):
                db.flush()
            db.rollback()
    with SessionLocal() as db:
        db.execute(text("UPDATE service_coverage_versions SET reviewer_user_id = doctor_user_id"))
        db.commit()
    with SessionLocal() as db:
        with pytest.raises(RecordIntegrityError):
            row = db.scalar(select(ServiceCoverageVersion))
            from backend.app.services.service_coverage_service import coverage_response
            coverage_response(row)


def test_current_config_does_not_depend_on_environment_flag_and_old_authority_is_not_replaced(client):
    doctor, doctor_headers = institutional_actor(client, "live-doctor")
    _, reviewer = institutional_actor(client, "live-reviewer", reviewer=True)
    result = client.post(versions_route(doctor["user"]["id"]), headers=reviewer, json=coverage_body())
    assert result.status_code == 201, result.text
    value = client.get("/api/v1/care/doctor/service-coverage", headers=doctor_headers)
    assert value.status_code == 200 and value.json()["status"] == "configured", value.text
    assert value.json()["coverage"]["id"] == result.json()["id"]
    assert value.json()["institutional_admission_status"] == "not_verified_by_configuration"
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import InstitutionMembership
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        row = db.scalar(select(InstitutionMembership).where(InstitutionMembership.user_id == result.json()["reviewer_user_id"]))
        ledger.deny(row)
    changed = client.get("/api/v1/care/doctor/service-coverage", headers=doctor_headers)
    assert changed.status_code == 200, changed.text
    assert changed.json()["status"] == "not_configured" and changed.json()["reason"] == "coverage_authority_changed"


def test_coverage_schema_rejects_overlaps_fake_clock_and_empty_real_process(client):
    doctor, _ = institutional_actor(client, "strict-doctor")
    _, reviewer = institutional_actor(client, "strict-reviewer", reviewer=True)
    base = coverage_body()
    for change in ({"effective_from": datetime.now(timezone.utc).isoformat()}, {"timezone": "UTC"},
            {"approved_process_reference": " "}, {"escalation_instructions": " "}, {"expected_response_working_minutes": True},
            {"working_periods": [{"weekday": 0, "start": "09:00", "end": "12:00"}, {"weekday": 0, "start": "11:00", "end": "13:00"}]}):
        response = client.post(versions_route(doctor["user"]["id"]), headers=reviewer, json={**base, **change})
        assert response.status_code == 422, response.text


def test_actual_consumer_binds_original_schedule_and_new_version_does_not_rewrite_old_attention(client):
    from backend.tests.test_assessment_consumers import complete_assessment, drain
    from backend.tests.test_submission_cognitive_evidence import cognitive_submission
    owner, doctor, session, pid = complete_assessment(client, doctor=True)
    _, reviewer = institutional_actor(client, "consumer-reviewer", reviewer=True)
    doctor_id = session["responsible_doctor_id"]
    first = client.post(versions_route(doctor_id), headers=reviewer, json=coverage_body())
    assert first.status_code == 201, first.text
    assert drain() == 8
    old = client.get(f"/api/v1/care/patient/attention?patient_id={pid}", headers=owner).json()["items"][0]
    assert old["response_coverage"]["status"] == "configured"
    assert old["response_coverage"]["coverage"]["version"] == 1
    assert datetime.fromisoformat(old["expected_response_at"]).tzinfo is not None
    later = {**coverage_body("second-schedule", previous=1), "expected_response_working_minutes": 60}
    second = client.post(versions_route(doctor_id), headers=reviewer, json=later)
    assert second.status_code == 201, second.text
    current = client.get(f"/api/v1/care/attention/{old['id']}", headers=doctor)
    assert current.status_code == 200, current.text
    assert current.json()["attention"]["response_coverage"] == old["response_coverage"]
    assert current.json()["attention"]["expected_response_at"] == old["expected_response_at"]
    assert current.json()["attention"]["current_service_coverage"]["coverage"]["version"] == 2
    template = client.get(f"/api/v1/care/assessment-templates?patient_id={pid}", headers=doctor).json()["items"][0]
    draft = client.post("/api/v1/care/doctor/assessments", headers=doctor,
        json={"patient_id": pid, "template_id": template["id"], "template_version": template["version"], "background": {}})
    assert draft.status_code == 201, draft.text
    published = client.post(f"/api/v1/care/assessments/{draft.json()['id']}/publish", headers=doctor,
        json={"expected_version": draft.json()["version"]})
    assert published.status_code == 200, published.text
    _, _, item, _, body = cognitive_submission(client, "flanker", context=(owner, published.json(), pid))
    body["task_id"] = item["patient_task_id"]
    body["submission_id"] = "coverage-new-attention-" + body["run_id"]
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    saved = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert saved.status_code == 201, saved.text
    assert drain() == 2
    actual = client.get(f"/api/v1/care/patient/attention?patient_id={pid}", headers=owner)
    assert actual.status_code == 200, actual.text
    new = next(row for row in actual.json()["items"] if row["assessment_id"] == published.json()["id"])
    assert new["response_coverage"]["coverage"]["version"] == 2
    assert next(row for row in actual.json()["items"] if row["id"] == old["id"])["expected_response_at"] == old["expected_response_at"]
