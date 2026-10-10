from __future__ import annotations

from copy import deepcopy

import pytest

from backend.tests.test_cognitive_contract import canonical_result, register_patient


def protocol_result(test_type, source, protocol_id, version=1, age_group="unspecified"):
    result = canonical_result(test_type)
    result.update(source=source, protocol_id=protocol_id, protocol_schema_version=version, age_group=age_group)
    return result


def submit(client, headers, test_type, result):
    response = client.post("/api/v1/patient/submit_cognitive_test", headers=headers,
                           json={"test_type": test_type, "result_json": result})
    assert response.status_code == 201, response.text
    return response.json()


def test_web_simple_reaction_is_not_gonogo(client):
    headers = register_patient(client)
    result = protocol_result("simple_reaction", "patient_web", "patient-web-preview-v1")
    result["raw_result"].update(target_rounds=5, completed_rounds=5, false_starts=2)
    saved = submit(client, headers, "reaction", result)
    assert saved["test_type"] == "simple_reaction"
    assert saved["result_json"]["source"] == "patient_web"


def test_report_separates_protocol_source_version_and_age(client):
    headers = register_patient(client)
    variants = [("patient_web", "patient-web-preview-v1", 1, "unspecified"),
                ("miniprogram", "continuous-mobile-v4", 6, "adult"),
                ("miniprogram", "continuous-mobile-v4", 6, "child"),
                ("miniprogram", "continuous-mobile-v4", 7, "adult")]
    for source, protocol, version, age in variants:
        submit(client, headers, "trail", protocol_result("trail", source, protocol, version, age))
    last = protocol_result("trail", *variants[-1])
    last["raw_result"]["elapsed_ms"] = 98_000
    submit(client, headers, "trail", last)
    profile = client.get("/api/v1/patient/comprehensive_report", headers=headers).json()["cognitive_profile"]
    assert len(profile["latest_tests"]) == 4
    assert len({item["series_id"] for item in profile["latest_tests"]}) == 4
    assert len(profile["protocol_profiles"]) == 4
    active = profile["protocol_profiles"][0]
    assert profile["active_protocol_key"] == active["protocol_key"]
    assert profile["radar_scores"] == active["radar_scores"]
    assert active["age_group"] == "adult"
    assert active["protocol_schema_version"] == 7
    assert all(len(group["latest_tests"]) == 1 for group in profile["protocol_profiles"])


def test_mixed_protocol_does_not_feed_active_radar(client):
    headers = register_patient(client)
    submit(client, headers, "stroop", protocol_result("stroop", "patient_web", "patient-web-preview-v1"))
    submit(client, headers, "digit", protocol_result("digit", "miniprogram", "continuous-mobile-v4", 6, "adult"))
    profile = client.get("/api/v1/patient/comprehensive_report", headers=headers).json()["cognitive_profile"]
    assert len(profile["protocol_profiles"]) == 2
    assert profile["radar_scores"]["reaction_speed"] == 0
    assert profile["radar_scores"]["attention_control"] == 0
    assert profile["radar_scores"]["working_memory"] > 0
    assert "协议" in profile["summary"]


def test_historical_web_reaction_is_identified_without_rewriting_record(client):
    from sqlalchemy import select
    from backend.app.db.session import SessionLocal
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.models.patient import Patient
    from backend.app.models.user import User

    headers = register_patient(client)
    original = {"raw_result": {"target_rounds": 5, "completed_rounds": 5,
                "average_reaction_time_ms": 310, "fastest_reaction_time_ms": 290, "false_starts": 1}}
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == "cognitive@example.com"))
        patient = db.scalar(select(Patient).where(Patient.user_id == user.id))
        record = CognitiveTest(patient_id=patient.id, test_type="reaction", result_json=deepcopy(original))
        db.add(record)
        db.commit()
        record_id = record.id
    profile = client.get("/api/v1/patient/comprehensive_report", headers=headers).json()["cognitive_profile"]
    item = profile["latest_tests"][0]
    assert item["test_type"] == "simple_reaction"
    assert item["stored_test_type"] == "reaction"
    assert item["source"] == "patient_web"
    assert item["protocol_inferred"] is True
    with SessionLocal() as db:
        record = db.get(CognitiveTest, record_id)
        assert record.test_type == "reaction"
        assert record.result_json == original


def test_ambiguous_legacy_result_is_not_assigned_known_protocol(client):
    headers = register_patient(client)
    saved = submit(client, headers, "reaction", canonical_result("reaction"))
    result = saved["result_json"]
    assert result["source"] == "unknown"
    assert result["protocol_id"] == "legacy-unversioned"
    assert result["protocol_schema_version"] == 0


@pytest.mark.parametrize("metadata", [
    {"protocol_schema_version": True}, {"protocol_schema_version": -1},
    {"protocol_schema_version": 1.5}, {"source": []}, {"protocol_id": "bad|key"},
    {"age_group": "invented"},
    {"source": "patient_web", "protocol_id": "continuous-mobile-v4"},
])
def test_invalid_explicit_protocol_metadata_is_rejected(client, metadata):
    headers = register_patient(client)
    result = canonical_result("reaction")
    result.update(metadata)
    response = client.post("/api/v1/patient/submit_cognitive_test", headers=headers,
                           json={"test_type": "reaction", "result_json": result})
    assert response.status_code == 422


def test_nonstring_age_metadata_raises_validation_error():
    from backend.app.services.cognitive_contract import validate_protocol_metadata
    with pytest.raises(ValueError, match="age_group"):
        validate_protocol_metadata({"age_group": []})


def test_historical_malformed_metadata_remains_readable():
    from backend.app.services.cognitive_contract import normalize_result_json
    result = normalize_result_json("digit", {
        "source": [], "protocol_id": {}, "protocol_schema_version": True, "age_group": [],
        "raw_result": {"forward_max_span": 6, "backward_max_span": 4},
    })
    assert result["source"] == "unknown"
    assert result["protocol_id"] == "legacy-unversioned"
    assert result["protocol_schema_version"] == 0
    assert result["age_group"] == "unknown"
