from __future__ import annotations

from pathlib import Path

from sqlalchemy import select

from backend.tests.test_cognitive_contract import register_patient


def patient_identity(client) -> tuple[dict[str, str], int]:
    headers = register_patient(client)
    profile = client.get("/api/v1/auth/me", headers=headers)
    assert profile.status_code == 200, profile.text
    return headers, profile.json()["patient_profile"]["id"]


def upload_rows():
    from backend.app.db.session import SessionLocal
    from backend.app.models.upload import Upload

    with SessionLocal() as db:
        return list(db.scalars(select(Upload).order_by(Upload.id)).all())


def prediction_rows():
    from backend.app.db.session import SessionLocal
    from backend.app.models.model_prediction import ModelPrediction

    with SessionLocal() as db:
        return list(db.scalars(select(ModelPrediction).order_by(ModelPrediction.id)).all())


def test_empty_upload_is_rejected_without_database_row(client) -> None:
    headers, patient_id = patient_identity(client)

    response = client.post(
        f"/api/v1/model/predict_fmri?patient_id={patient_id}",
        headers=headers,
        files={"timeseries_file": ("empty.csv", b"", "text/csv")},
    )

    assert response.status_code == 400
    assert upload_rows() == []


def test_invalid_extension_is_rejected_without_database_row(client) -> None:
    headers, patient_id = patient_identity(client)

    response = client.post(
        f"/api/v1/model/predict_fmri?patient_id={patient_id}",
        headers=headers,
        files={"timeseries_file": ("scan.exe", b"1,2,3", "application/octet-stream")},
    )

    assert response.status_code == 400
    assert upload_rows() == []


def test_oversized_upload_is_rejected_without_database_row(client) -> None:
    headers, patient_id = patient_identity(client)

    response = client.post(
        f"/api/v1/model/predict_fmri?patient_id={patient_id}",
        headers=headers,
        files={"timeseries_file": ("large.csv", b"1" * 65, "text/csv")},
    )

    assert response.status_code == 413
    assert upload_rows() == []


def test_valid_upload_is_persisted_and_linked_to_real_prediction(client, monkeypatch) -> None:
    from backend.app.api.routes import model_inference
    from backend.app.services.hgst_runtime.service import HGSTPredictionResult

    headers, patient_id = patient_identity(client)
    monkeypatch.setattr(
        model_inference,
        "predict_timeseries_file",
        lambda file_bytes, file_name: HGSTPredictionResult(
            prediction_label="Control",
            probability=0.2,
            probability_control=0.8,
            roi_dim_used=3,
            timepoints=2,
            file_name=file_name,
            model_name="TestHGST",
            model_version="test-1",
            source_type="timeseries_hgst",
            summary_text="Test inference result.",
        ),
    )

    response = client.post(
        f"/api/v1/model/predict_fmri?patient_id={patient_id}",
        headers=headers,
        files={"timeseries_file": ("subject.csv", b"1,2,3\n4,5,6", "text/csv")},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["source_type"] == "fmri_hgst"
    assert payload["is_demo"] is False
    assert payload["upload_id"] is not None
    assert "not a medical diagnosis" in payload["disclaimer"]

    rows = upload_rows()
    assert len(rows) == 1
    upload = rows[0]
    assert upload.status == "completed"
    assert upload.file_name == "subject.csv"
    assert upload.file_size == 11
    assert len(upload.file_hash) == 64
    stored_path = Path(upload.stored_path).resolve()
    assert stored_path.exists()
    assert stored_path.name != "subject.csv"
    assert stored_path.read_bytes() == b"1,2,3\n4,5,6"

    predictions = prediction_rows()
    assert len(predictions) == 1
    assert predictions[0].upload_id == upload.id
    assert predictions[0].source_type == "fmri_hgst"


def test_real_inference_failure_does_not_fall_back_to_mock(client, monkeypatch) -> None:
    from backend.app.api.routes import model_inference
    from backend.app.services.hgst_runtime.service import HGSTUnavailableError

    headers, patient_id = patient_identity(client)

    def unavailable(file_bytes: bytes, file_name: str):
        raise HGSTUnavailableError("real model unavailable")

    monkeypatch.setattr(model_inference, "predict_timeseries_file", unavailable)

    response = client.post(
        f"/api/v1/model/predict_fmri?patient_id={patient_id}",
        headers=headers,
        files={"timeseries_file": ("subject.csv", b"1,2,3", "text/csv")},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "real model unavailable"
    assert prediction_rows() == []
    rows = upload_rows()
    assert len(rows) == 1
    assert rows[0].status == "failed"
    assert "real model unavailable" in rows[0].note


def test_mock_response_is_explicitly_marked_as_demo(client) -> None:
    headers, patient_id = patient_identity(client)

    response = client.post(
        f"/api/v1/model/predict_mock?patient_id={patient_id}&file_name=demo.csv",
        headers=headers,
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["source_type"] == "mock"
    assert payload["is_demo"] is True
    assert payload["upload_id"] is None
    assert "not a medical diagnosis" in payload["disclaimer"]
