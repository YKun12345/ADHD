"""Object binding is checked by actual ORM/API reads after raw SQL corruption."""
from backend.tests.w04_legacy_submission_counterexamples import test_new_scale_ciphertext_cannot_be_transplanted_between_patients


def test_same_patient_cross_record_ciphertext_replacement_is_rejected(client):
    from backend.tests.w02_helpers import register
    _, headers = register(client,"w04-same-patient-cipher@example.com")
    first = client.post("/api/v1/patient/submit_scale",headers=headers,json={"scale_type":"ASRS","answers":[0]*18})
    second = client.post("/api/v1/patient/submit_scale",headers=headers,json={"scale_type":"ASRS","answers":[4]*18})
    assert first.status_code == second.status_code == 201
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        donor = db.connection().exec_driver_sql("SELECT score_json FROM scale_results WHERE id=?",(first.json()["id"],)).scalar_one()
        db.connection().exec_driver_sql("UPDATE scale_results SET score_json=? WHERE id=?",(donor,second.json()["id"]))
        db.commit()
    response = client.get("/api/v1/patient/comprehensive_report",headers=headers)
    assert response.status_code in {409,503}, response.text


def test_binding_rejects_previous_version_replay(client):
    from backend.tests.w02_helpers import register
    from sqlalchemy import select
    _, headers = register(client,"w04-version-replay@example.com")
    response = client.post("/api/v1/patient/submit_scale",headers=headers,json={"scale_type":"ASRS","answers":[0]*18})
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    with SessionLocal() as db:
        old = db.connection().exec_driver_sql("SELECT total_score FROM scale_results WHERE id=?",(response.json()["id"],)).scalar_one()
        row = db.get(ScaleResult,response.json()["id"])
        row.total_score = 1
        db.commit()
        db.connection().exec_driver_sql("UPDATE scale_results SET total_score=? WHERE id=?",(old,row.id))
        db.commit()
    response = client.get("/api/v1/patient/comprehensive_report",headers=headers)
    assert response.status_code in {409,503}, response.text


def test_new_bound_row_cannot_be_downgraded_using_legacy_marker_and_valid_v1_bytes(client):
    from backend.tests.w02_helpers import register
    from backend.app.core.data_encryption import encrypt_value
    _,headers = register(client,"w04-format-downgrade@example.com")
    created = client.post("/api/v1/patient/submit_scale",headers=headers,json={"scale_type":"ASRS","answers":[0]*18})
    assert created.status_code == 201
    assert created.json()["legacy"] is True and created.json()["storage_integrity"]["format"] == "aesgcm:v2"
    # Valid old-format synthetic bytes represent reusable stored legacy samples.
    # The corruption changes plaintext format markers too, without a new seal.
    raw = (encrypt_value({"answers":[4]*18},"scale_results.score_json"),encrypt_value(72,"scale_results.total_score"),encrypt_value("high","scale_results.risk_level"))
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        db.connection().exec_driver_sql("UPDATE scale_results SET score_json=?,total_score=?,risk_level=?,envelope_status='legacy',record_schema_version=1 WHERE id=?",(*raw,created.json()["id"]))
        db.commit()
    response = client.get("/api/v1/patient/comprehensive_report",headers=headers)
    assert response.status_code in {409,503},response.text


def test_missing_origin_proof_cannot_make_a_new_bound_record_readable_as_legacy(client):
    from backend.tests.w02_helpers import register
    from backend.app.core.data_encryption import encrypt_value
    from backend.app.db.session import engine
    from sqlalchemy import inspect
    _, headers = register(client, "w04-missing-origin@example.com")
    created = client.post("/api/v1/patient/submit_scale", headers=headers, json={"scale_type":"ASRS", "answers":[0]*18})
    assert created.status_code == 201
    assert "record_origin" in {row["name"] for row in inspect(engine).get_columns("scale_results")}, "Stored object-bound provenance is required independently of editable format markers."
    raw = (encrypt_value({"answers":[4]*18},"scale_results.score_json"), encrypt_value(72,"scale_results.total_score"), encrypt_value("high","scale_results.risk_level"))
    with engine.begin() as db:
        db.exec_driver_sql("UPDATE scale_results SET score_json=?,total_score=?,risk_level=?,envelope_status='legacy',record_schema_version=1,record_origin=NULL WHERE id=?", (*raw, created.json()["id"]))
    response = client.get("/api/v1/patient/comprehensive_report", headers=headers)
    assert response.status_code in {409,503}, response.text

