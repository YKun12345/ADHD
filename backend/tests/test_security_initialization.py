from __future__ import annotations

from copy import deepcopy

import pytest
from sqlalchemy import select

from backend.tests.test_security_regressions import actors


def client_result():
    return {
        "test_name": "Go/No-Go",
        "status_text": "completed",
        "raw_result": {
            "accuracy": 80,
            "average_reaction_time_ms": 420,
            "correct_trials": 20,
            "total_trials": 25,
        },
        "metrics": [
            {"label": "accuracy", "value": "99%"},
            {"label": "reaction time", "value": "6 ms"},
        ],
    }


@pytest.mark.parametrize("metrics", [
    client_result()["metrics"],
    ["99%", 6, True],
    {"accuracy": 80, "average_reaction_time_ms": 420},
])
def test_cognitive_audit_uses_explicit_values_with_display_metrics(client, metrics):
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.services.security_service import _extract_cognitive_dimensions

    payload = client_result()
    payload.update(metrics=metrics, protocol_schema_version=6)
    record = CognitiveTest(test_type="reaction", result_json=payload)

    assert _extract_cognitive_dimensions(record) == {
        "performance_score": 0,
        "accuracy_score": 80,
        "latency_score": 420,
    }


def test_display_strings_are_not_guessed_as_cognitive_audit_values(client):
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.services.security_service import _extract_cognitive_dimensions

    record = CognitiveTest(test_type="reaction", result_json={
        "protocol_schema_version": 6,
        "metrics": client_result()["metrics"],
    })
    assert _extract_cognitive_dimensions(record) == {
        "performance_score": 0,
        "accuracy_score": 0,
        "latency_score": 0,
    }


@pytest.mark.parametrize("preexisting", [True, False], ids=["backfill", "new-submission"])
def test_security_initialization_and_cognitive_audit_with_client_payload(client, actors, preexisting):
    from backend.app.db.session import SessionLocal
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.models.security import SecurityCipherRecord

    original = client_result()
    if preexisting:
        with SessionLocal() as db:
            record = CognitiveTest(patient_id=actors["patient_id"], test_type="reaction",
                                   result_json=deepcopy(original))
            db.add(record)
            db.commit()
            record_id = record.id

    initialized = client.post("/api/v1/security/system/init", headers=actors["dac"]["headers"])
    assert initialized.status_code == 200, initialized.text
    assert initialized.json()["is_initialized"] is True

    if not preexisting:
        submitted = client.post("/api/v1/patient/submit_cognitive_test",
                                headers=actors["patient"]["headers"],
                                json={"test_type": "reaction", "result_json": original})
        assert submitted.status_code == 201, submitted.text
        record_id = submitted.json()["id"]
        original = submitted.json()["result_json"]

    status = client.get("/api/v1/security/system/status", headers=actors["dac"]["headers"])
    assert status.json()["is_initialized"] is True
    assert status.json()["cipher_record_count"] == 1

    repeated = client.post("/api/v1/security/system/init", headers=actors["dac"]["headers"])
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["cipher_record_count"] == 1
    with SessionLocal() as db:
        assert db.get(CognitiveTest, record_id).result_json == original
        evidence = db.scalars(select(SecurityCipherRecord)).all()
        assert len(evidence) == 1
        assert evidence[0].source_record_id == record_id

    audited = client.post("/api/v1/security/dac/temporal_audits", headers=actors["dac"]["headers"],
                          json={"patient_id": actors["patient_id"], "source_type": "cognitive"})
    assert audited.status_code == 200, audited.text
    result = audited.json()
    assert result["verification_passed"] is True
    assert result["decrypted_stats"]["record_count"] == 1
    assert result["decrypted_stats"]["stats"]["accuracy_score"]["sum"] == 80
    assert result["decrypted_stats"]["stats"]["latency_score"]["sum"] == 420
