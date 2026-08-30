from __future__ import annotations

import hashlib
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from backend.app.api.deps import get_db, require_roles
from backend.app.core.config import settings
from backend.app.models.model_prediction import ModelPrediction
from backend.app.models.patient import Patient
from backend.app.models.upload import Upload
from backend.app.models.user import User, UserRole
from backend.app.schemas.model_inference import TimeseriesPredictionResponse
from backend.app.services.hgst_runtime.service import (
    HGSTBundleMissingError,
    HGSTInferenceError,
    HGSTUnavailableError,
    predict_timeseries_file,
)
from backend.app.services.upload_storage import (
    UploadTooLargeError,
    UploadValidationError,
    store_timeseries_upload,
)


router = APIRouter(prefix="/model", tags=["model-inference"])
MODEL_DISCLAIMER = "Screening support only; not a medical diagnosis."
MOCK_DISCLAIMER = "Demonstration output only; not a medical diagnosis."


def _get_patient_for_researcher_or_self(
    db: Session,
    patient_id: int,
    current_user: User,
) -> Patient:
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Patient not found.",
        )

    if current_user.role == UserRole.RESEARCHER:
        if patient.assigned_researcher_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="The patient is not assigned to the current researcher.",
            )
    elif current_user.role == UserRole.PATIENT:
        if patient.user_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Patients may access only their own data.",
            )
    else:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The current role cannot access model inference.",
        )

    return patient


def _prediction_response(
    record: ModelPrediction,
    patient_id: int,
    *,
    is_demo: bool,
    disclaimer: str,
) -> TimeseriesPredictionResponse:
    return TimeseriesPredictionResponse(
        prediction_id=record.id,
        upload_id=record.upload_id,
        patient_id=patient_id,
        file_name=record.file_name,
        prediction_label=record.prediction_label,
        probability=record.probability,
        probability_control=record.probability_control,
        source_type=record.source_type,
        roi_dim_used=record.roi_dim_used,
        timepoints=record.timepoints,
        model_name=record.model_name,
        model_version=record.model_version,
        summary_text=record.summary_text,
        is_demo=is_demo,
        disclaimer=disclaimer,
        created_at=record.created_at,
    )


@router.post("/predict_fmri", response_model=TimeseriesPredictionResponse)
async def predict_fmri(
    patient_id: int,
    timeseries_file: UploadFile = File(...),
    current_user: User = Depends(require_roles(UserRole.RESEARCHER, UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> TimeseriesPredictionResponse:
    """Persist and run a real HGST-compatible time-series inference request."""

    _get_patient_for_researcher_or_self(db, patient_id, current_user)
    file_bytes = await timeseries_file.read()
    try:
        stored = store_timeseries_upload(
            file_bytes=file_bytes,
            file_name=timeseries_file.filename or "",
            upload_root=Path(settings.UPLOAD_ROOT),
            max_bytes=settings.UPLOAD_MAX_BYTES,
        )
    except UploadTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=str(exc),
        ) from exc
    except UploadValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    upload = Upload(
        patient_id=patient_id,
        uploader_id=current_user.id,
        file_name=stored.original_name,
        source_type=stored.source_type,
        file_size=stored.file_size,
        file_hash=stored.file_hash,
        status="uploaded",
        stored_path=str(stored.stored_path),
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)

    def mark_failed(note: str) -> None:
        upload.status = "failed"
        upload.note = note[:1000]
        db.commit()

    try:
        result = predict_timeseries_file(file_bytes, stored.original_name)
    except (HGSTUnavailableError, HGSTBundleMissingError) as exc:
        mark_failed(str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except HGSTInferenceError as exc:
        mark_failed(str(exc))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        mark_failed(str(exc))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"fMRI inference failed: {exc}",
        ) from exc

    prediction = ModelPrediction(
        patient_id=patient_id,
        upload_id=upload.id,
        file_name=result.file_name,
        prediction_label=result.prediction_label,
        probability=result.probability,
        probability_control=result.probability_control,
        source_type="fmri_hgst",
        roi_dim_used=result.roi_dim_used,
        timepoints=result.timepoints,
        model_name=result.model_name,
        model_version=result.model_version,
        summary_text=result.summary_text,
    )
    db.add(prediction)
    upload.status = "completed"
    upload.note = None
    db.commit()
    db.refresh(prediction)

    return _prediction_response(
        prediction,
        patient_id,
        is_demo=False,
        disclaimer=MODEL_DISCLAIMER,
    )


@router.post("/predict_mock", response_model=TimeseriesPredictionResponse)
def predict_mock(
    patient_id: int,
    file_name: str = "demo_fmri.1D",
    current_user: User = Depends(require_roles(UserRole.RESEARCHER, UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> TimeseriesPredictionResponse:
    """Create a visibly labelled deterministic demonstration result."""

    _get_patient_for_researcher_or_self(db, patient_id, current_user)
    safe_file_name = (Path(file_name).name or "demo_fmri.1D")[:255]
    seed = hashlib.sha256(f"{patient_id}:{safe_file_name}".encode()).hexdigest()
    probability = round(0.65 + (int(seed[:8], 16) % 100) / 1000, 3)
    probability = round(min(max(probability, 0.6), 0.9), 3)
    probability_control = round(1 - probability, 3)
    label = "ADHD" if probability >= 0.5 else "Control"

    record = ModelPrediction(
        patient_id=patient_id,
        upload_id=None,
        file_name=safe_file_name,
        prediction_label=label,
        probability=probability,
        probability_control=probability_control,
        source_type="mock",
        roi_dim_used=90,
        timepoints=120,
        model_name="DemoMock",
        model_version="mock-2026-08",
        summary_text=(
            f"Demonstration inference: label {label}, ADHD probability {probability:.2%}. "
            "This deterministic result is for integration demonstrations only."
        ),
    )
    db.add(record)
    db.commit()
    db.refresh(record)

    return _prediction_response(
        record,
        patient_id,
        is_demo=True,
        disclaimer=MOCK_DISCLAIMER,
    )
