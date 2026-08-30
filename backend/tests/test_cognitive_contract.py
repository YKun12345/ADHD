from __future__ import annotations

from typing import Any


CANONICAL_TYPES = (
    "reaction",
    "simple_reaction",
    "stroop",
    "trail",
    "flanker",
    "nback",
    "digit",
)


def register_patient(client) -> dict[str, str]:
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "cognitive@example.com",
            "password": "Cognitive#2026",
            "full_name": "Cognitive Patient",
            "role": "patient",
            "consent_agreed": True,
            "patient_profile": {
                "age": 20,
                "gender": "female",
                "patient_type": "adult",
            },
        },
    )
    assert response.status_code == 201, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def canonical_result(test_type: str) -> dict[str, Any]:
    raw_results = {
        "reaction": {
            "average_reaction_time_ms": 430,
            "accuracy": 92,
            "false_starts": 1,
        },
        "simple_reaction": {
            "average_reaction_time_ms": 310,
            "accuracy": 100,
        },
        "stroop": {"average_reaction_time_ms": 760, "accuracy": 88},
        "trail": {"elapsed_ms": 12_000, "errors": 1, "accuracy": 95},
        "flanker": {"average_reaction_time_ms": 650, "accuracy": 90},
        "nback": {"accuracy": 82},
        "digit": {"highest_span": 6, "accuracy": 85},
    }
    return {
        "test_name": test_type,
        "status_text": "completed",
        "finished_at": "2026-08-30T08:00:00Z",
        "metrics": [{"label": "accuracy", "value": f"{raw_results[test_type].get('accuracy', 100)}%"}],
        "raw_result": raw_results[test_type],
    }


def test_unknown_cognitive_type_is_rejected(client) -> None:
    headers = register_patient(client)

    response = client.post(
        "/api/v1/patient/submit_cognitive_test",
        headers=headers,
        json={"test_type": "unknown-task", "result_json": canonical_result("reaction")},
    )

    assert response.status_code == 422


def test_legacy_alias_and_fields_are_normalized(client) -> None:
    headers = register_patient(client)

    response = client.post(
        "/api/v1/patient/submit_cognitive_test",
        headers=headers,
        json={
            "test_type": "gonogo",
            "result_json": {
                "avg_reaction_ms": 455.5,
                "correct_rate": 0.91,
                "false_starts": 2,
            },
        },
    )

    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["test_type"] == "reaction"
    assert payload["result_json"]["raw_result"] == {
        "average_reaction_time_ms": 455.5,
        "accuracy": 91.0,
        "false_starts": 2,
    }


def test_comprehensive_report_contains_all_seven_tasks(client) -> None:
    headers = register_patient(client)
    for test_type in CANONICAL_TYPES:
        response = client.post(
            "/api/v1/patient/submit_cognitive_test",
            headers=headers,
            json={"test_type": test_type, "result_json": canonical_result(test_type)},
        )
        assert response.status_code == 201, response.text

    response = client.get("/api/v1/patient/comprehensive_report", headers=headers)

    assert response.status_code == 200, response.text
    cognitive = response.json()["cognitive_profile"]
    assert [item["test_type"] for item in cognitive["latest_tests"]] == list(CANONICAL_TYPES)
    assert cognitive["radar_scores"]["reaction_speed"] > 0


def test_simple_reaction_alone_drives_reaction_speed(client) -> None:
    headers = register_patient(client)
    response = client.post(
        "/api/v1/patient/submit_cognitive_test",
        headers=headers,
        json={
            "test_type": "simple_reaction",
            "result_json": canonical_result("simple_reaction"),
        },
    )
    assert response.status_code == 201, response.text

    report = client.get("/api/v1/patient/comprehensive_report", headers=headers)

    assert report.status_code == 200, report.text
    cognitive = report.json()["cognitive_profile"]
    assert cognitive["radar_scores"]["reaction_speed"] > 0
    assert [item["test_type"] for item in cognitive["latest_tests"]] == ["simple_reaction"]


def test_miniprogram_digit_span_fields_drive_working_memory(client) -> None:
    headers = register_patient(client)

    response = client.post(
        "/api/v1/patient/submit_cognitive_test",
        headers=headers,
        json={
            "test_type": "digit",
            "result_json": {
                "test_name": "数字广度",
                "status_text": "已完成",
                "finished_at": "2026-08-30T08:00:00Z",
                "metrics": [
                    {"label": "顺背最大跨度", "value": "7"},
                    {"label": "倒背最大跨度", "value": "5"},
                ],
                "raw_result": {
                    "forward_max_span": 7,
                    "backward_max_span": 5,
                    "accuracy": 0.85,
                },
            },
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["result_json"]["raw_result"]["highest_span"] == 7

    report = client.get("/api/v1/patient/comprehensive_report", headers=headers)

    assert report.status_code == 200, report.text
    assert report.json()["cognitive_profile"]["radar_scores"]["working_memory"] > 0


def test_preexisting_legacy_type_rows_appear_under_canonical_types(client) -> None:
    headers = register_patient(client)

    from sqlalchemy import select

    from backend.app.db.session import SessionLocal
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.models.patient import Patient
    from backend.app.models.user import User

    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == "cognitive@example.com"))
        assert user is not None
        patient = db.scalar(select(Patient).where(Patient.user_id == user.id))
        assert patient is not None
        db.add_all(
            [
                CognitiveTest(
                    patient_id=patient.id,
                    test_type="gonogo",
                    result_json={"avg_reaction_ms": 420, "correct_rate": 0.9},
                ),
                CognitiveTest(
                    patient_id=patient.id,
                    test_type="digit_span",
                    result_json={
                        "forward_max_span": 6,
                        "backward_max_span": 4,
                        "accuracy": 0.8,
                    },
                ),
            ]
        )
        db.commit()

    report = client.get("/api/v1/patient/comprehensive_report", headers=headers)

    assert report.status_code == 200, report.text
    cognitive = report.json()["cognitive_profile"]
    assert [item["test_type"] for item in cognitive["latest_tests"]] == [
        "reaction",
        "digit",
    ]
    assert cognitive["radar_scores"]["reaction_speed"] > 0
    assert cognitive["radar_scores"]["working_memory"] > 0
