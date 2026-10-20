"""Explicit W04 preflight; intentionally excluded from default W02 collection."""
from copy import deepcopy

from backend.tests.test_cognitive_contract import register_patient, canonical_result


def test_same_run_exact_retry_returns_original_record(client):
    headers = register_patient(client)
    result = canonical_result("reaction")
    result["test_run_id"] = "same-run-exact"
    payload = {"test_type": "reaction", "result_json": result}
    first = client.post("/api/v1/patient/submit_cognitive_test", headers=headers, json=payload)
    retry = client.post("/api/v1/patient/submit_cognitive_test", headers=headers, json=payload)
    assert first.status_code == retry.status_code == 201
    assert retry.json()["id"] == first.json()["id"]
    assert retry.json()["result_json"]["raw_result"]["accuracy"] == 92


def test_same_run_changed_content_is_conflict(client):
    headers = register_patient(client)
    result = canonical_result("reaction")
    result["test_run_id"] = "same-run-conflict"
    first = client.post("/api/v1/patient/submit_cognitive_test", headers=headers, json={"test_type": "reaction", "result_json": result})
    assert first.status_code == 201, first.text
    result["raw_result"]["accuracy"] = 1
    conflict = client.post("/api/v1/patient/submit_cognitive_test", headers=headers, json={"test_type": "reaction", "result_json": result})
    assert conflict.status_code == 409, conflict.text


def test_same_run_changed_protocol_version_is_conflict(client):
    headers = register_patient(client)
    result = canonical_result("stroop")
    result.update(test_run_id="same-run-protocol", source="miniprogram", protocol_id="continuous-mobile-v4", protocol_schema_version=1)
    first = client.post("/api/v1/patient/submit_cognitive_test", headers=headers, json={"test_type": "stroop", "result_json": result})
    assert first.status_code == 201, first.text
    changed = deepcopy(result)
    changed["protocol_schema_version"] = 2
    conflict = client.post("/api/v1/patient/submit_cognitive_test", headers=headers, json={"test_type": "stroop", "result_json": changed})
    assert conflict.status_code == 409, conflict.text


def test_same_run_equivalent_gonogo_alias_is_an_exact_retry(client):
    headers = register_patient(client)
    result = canonical_result("reaction")
    result["test_run_id"] = "same-run-equivalent-alias"
    first = client.post("/api/v1/patient/submit_cognitive_test", headers=headers, json={"test_type": "reaction", "result_json": result})
    alias = client.post("/api/v1/patient/submit_cognitive_test", headers=headers, json={"test_type": "gonogo", "result_json": result})
    assert first.status_code == alias.status_code == 201
    assert first.json()["id"] == alias.json()["id"]
    assert alias.json()["test_type"] == "reaction"


def test_new_scale_ciphertext_cannot_be_transplanted_between_patients(client):
    from backend.tests.w02_helpers import register
    first, owner_a = register(client, "w04-cipher-owner-a@example.com")
    _, owner_b = register(client, "w04-cipher-owner-b@example.com")
    a = client.post("/api/v1/patient/submit_scale", headers=owner_a, json={"scale_type": "ASRS", "respondent_type": "self", "answers": [0] * 18})
    b = client.post("/api/v1/patient/submit_scale", headers=owner_b, json={"scale_type": "ASRS", "respondent_type": "self", "answers": [4] * 18})
    assert a.status_code == b.status_code == 201
    assert a.json()["total_score"] == 0 and b.json()["total_score"] == 72
    from backend.app.db.session import SessionLocal
    # Synthetic persistence corruption, not an API authorization bypass. Copy
    # raw ciphertext so ORM conversion cannot encrypt the test input again.
    with SessionLocal() as db:
        donor = db.connection().exec_driver_sql("SELECT score_json,total_score,risk_level FROM scale_results WHERE id=?", (b.json()["id"],)).fetchone()
        db.connection().exec_driver_sql("UPDATE scale_results SET score_json=?,total_score=?,risk_level=? WHERE id=?", (*donor, a.json()["id"]))
        db.commit()
    report = client.get("/api/v1/patient/comprehensive_report", headers=owner_a)
    assert report.status_code in {409, 503}, {
        "status": report.status_code,
        "recipient_patient_id": first["user"]["patient_profile"]["id"],
        "original_recipient_total": a.json()["total_score"],
        "donor_total": b.json()["total_score"],
        "returned_recipient_total": report.json().get("latest_scale", {}).get("total_score"),
    }
