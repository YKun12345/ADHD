from __future__ import annotations

from typing import Any

import pytest


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


def test_retry_of_same_run_returns_original_record_without_overwriting(client) -> None:
    headers = register_patient(client)
    result = canonical_result("reaction")
    result["test_run_id"] = "wx-repeat-1"
    first = client.post(
        "/api/v1/patient/submit_cognitive_test", headers=headers,
        json={"test_type": "gonogo", "result_json": result},
    )
    result["raw_result"]["accuracy"] = 1
    retry = client.post(
        "/api/v1/patient/submit_cognitive_test", headers=headers,
        json={"test_type": "reaction", "result_json": result},
    )
    assert first.status_code == retry.status_code == 201
    assert retry.json()["id"] == first.json()["id"]
    assert retry.json()["result_json"]["raw_result"]["accuracy"] == 92


def test_concurrent_retries_insert_one_run(client) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from sqlalchemy import func, select
    from backend.app.db.session import SessionLocal
    from backend.app.models.cognitive_test import CognitiveTest

    headers = register_patient(client)
    result = canonical_result("reaction")
    result["test_run_id"] = "wx-concurrent-1"

    def submit():
        return client.post(
            "/api/v1/patient/submit_cognitive_test", headers=headers,
            json={"test_type": "reaction", "result_json": result},
        )

    with ThreadPoolExecutor(max_workers=4) as executor:
        responses = list(executor.map(lambda _: submit(), range(4)))
    assert all(response.status_code == 201 for response in responses)
    assert len({response.json()["id"] for response in responses}) == 1
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CognitiveTest)) == 1


def test_run_id_is_scoped_to_task_and_legacy_submissions_remain_distinct(client) -> None:
    headers = register_patient(client)
    ids = []
    for test_type, run_id in [
        ("reaction", "wx-shared-1"), ("stroop", "wx-shared-1"),
        ("reaction", "wx-other-2"), ("reaction", None), ("reaction", None),
    ]:
        result = canonical_result(test_type)
        if run_id is not None:
            result["test_run_id"] = run_id
        response = client.post(
            "/api/v1/patient/submit_cognitive_test", headers=headers,
            json={"test_type": test_type, "result_json": result},
        )
        assert response.status_code == 201, response.text
        ids.append(response.json()["id"])
    assert len(set(ids)) == 5


@pytest.mark.parametrize("run_id", ["", " ", "x" * 65, 123, {}, None])
def test_invalid_supplied_run_id_is_rejected(client, run_id) -> None:
    headers = register_patient(client)
    result = canonical_result("reaction")
    result["test_run_id"] = run_id
    response = client.post(
        "/api/v1/patient/submit_cognitive_test", headers=headers,
        json={"test_type": "reaction", "result_json": result},
    )
    assert response.status_code == 422


def continuous_trail_result(elapsed_ms: int) -> dict[str, Any]:
    result = canonical_result("trail")
    result.update({
        "schema_version": 2,
        "protocol_id": "continuous-mobile-v4",
        "protocol_schema_version": 6,
        "actual_trials": 60,
    })
    result["raw_result"].update({
        "elapsed_ms": elapsed_ms,
        "stages": [
            {"part": "A", "elapsedMs": 30_000, "errors": 1, "nodeCount": 30},
            {"part": "B", "elapsedMs": elapsed_ms - 30_000, "errors": 0, "nodeCount": 30},
        ],
    })
    return result


def test_extended_trail_reports_objective_stages_and_protocol(client) -> None:
    headers = register_patient(client)
    result = continuous_trail_result(90_000)
    response = client.post(
        "/api/v1/patient/submit_cognitive_test", headers=headers,
        json={"test_type": "trail", "result_json": result},
    )
    assert response.status_code == 201
    report = client.get("/api/v1/patient/comprehensive_report", headers=headers).json()
    profile = report["cognitive_profile"]
    item = profile["latest_tests"][0]
    assert "continuous-mobile-v4" in item["status_text"]
    assert "客观记录" in item["status_text"]
    assert "90.0 秒" in item["key_metric"]
    assert "A 30.0 秒" in item["key_metric"]
    assert "B 60.0 秒" in item["key_metric"]
    assert "30节点" in item["key_metric"]
    assert "不纳入" in profile["summary"]
    assert profile["radar_scores"]["reaction_speed"] == 0
    assert profile["radar_scores"]["attention_control"] == 0


def test_extended_trail_duration_does_not_penalize_other_task_scores(client) -> None:
    headers = register_patient(client)
    for test_type in ["reaction", "stroop", "flanker", "nback", "digit"]:
        response = client.post(
            "/api/v1/patient/submit_cognitive_test", headers=headers,
            json={"test_type": test_type, "result_json": canonical_result(test_type)},
        )
        assert response.status_code == 201
    profiles = []
    for duration in [31_000, 150_000]:
        response = client.post(
            "/api/v1/patient/submit_cognitive_test", headers=headers,
            json={"test_type": "trail", "result_json": continuous_trail_result(duration)},
        )
        assert response.status_code == 201
        profiles.append(client.get(
            "/api/v1/patient/comprehensive_report", headers=headers,
        ).json()["cognitive_profile"])
    assert profiles[0]["radar_scores"] == profiles[1]["radar_scores"]
    assert profiles[1]["radar_scores"]["reaction_speed"] > 15


def test_legacy_trail_keeps_existing_composite_scores(client) -> None:
    headers = register_patient(client)
    response = client.post(
        "/api/v1/patient/submit_cognitive_test", headers=headers,
        json={"test_type": "trail", "result_json": canonical_result("trail")},
    )
    assert response.status_code == 201
    profile = client.get(
        "/api/v1/patient/comprehensive_report", headers=headers,
    ).json()["cognitive_profile"]
    assert profile["radar_scores"]["reaction_speed"] == 2.5
    assert profile["radar_scores"]["attention_control"] == 4.1


def test_report_keeps_legacy_metadata_that_was_not_validated_on_submission(client) -> None:
    from sqlalchemy import select
    from backend.app.db.session import SessionLocal
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.models.patient import Patient
    from backend.app.models.user import User

    headers = register_patient(client)
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == "cognitive@example.com"))
        patient = db.scalar(select(Patient).where(Patient.user_id == user.id))
        result = canonical_result("reaction")
        result["test_run_id"] = None
        db.add(CognitiveTest(patient_id=patient.id, test_type="reaction", result_json=result))
        db.commit()
    report = client.get("/api/v1/patient/comprehensive_report", headers=headers)
    assert report.status_code == 200
    assert report.json()["cognitive_profile"]["latest_tests"][0]["test_type"] == "reaction"


def test_existing_sqlite_schema_upgrade_preserves_records_and_adds_durable_unique(client, tmp_path, monkeypatch) -> None:
    from sqlalchemy import create_engine, inspect
    from sqlalchemy.exc import IntegrityError
    from backend.app.db import init_db

    engine = create_engine(f"sqlite:///{(tmp_path / 'legacy-cognitive.db').as_posix()}")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE cognitive_tests (id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL, "
            "test_type VARCHAR(64) NOT NULL, result_json JSON NOT NULL, created_at DATETIME NOT NULL)"
        )
        connection.exec_driver_sql(
            "INSERT INTO cognitive_tests VALUES (1, 1, 'trail', '{}', '2026-01-01')"
        )
    monkeypatch.setattr(init_db, "engine", engine)
    init_db._ensure_cognitive_test_run_id_column()
    init_db._ensure_cognitive_test_run_id_column()
    assert "test_run_id" in {column["name"] for column in inspect(engine).get_columns("cognitive_tests")}
    with engine.begin() as connection:
        assert connection.exec_driver_sql("SELECT test_run_id FROM cognitive_tests WHERE id = 1").scalar() is None
        connection.exec_driver_sql(
            "INSERT INTO cognitive_tests VALUES (2, 1, 'trail', '{}', '2026-01-01', 'wx-unique-1')"
        )
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.exec_driver_sql(
            "INSERT INTO cognitive_tests VALUES (3, 1, 'trail', '{}', '2026-01-01', 'wx-unique-1')"
        )
    with engine.begin() as connection:
        assert connection.exec_driver_sql("SELECT COUNT(*) FROM cognitive_tests").scalar() == 2
    engine.dispose()
