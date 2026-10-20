from __future__ import annotations

import hashlib
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from backend.app.services.identity_access import require_patient_access, recheck_request_authority
from backend.app.api.deps import get_db, require_roles
from backend.app.core.config import settings
from backend.app.models.model_prediction import ModelPrediction
from backend.app.models.patient import Patient
from backend.app.models.upload import Upload
from backend.app.models.user import User, UserRole
from backend.app.core.record_provenance import record_storage_info
from backend.app.services.imaging_storage_service import require_imaging_storage,stamp_storage_context,save_storage_transaction
from backend.app.schemas.model_inference import TimeseriesPredictionResponse
from backend.app.services.hgst_runtime.service import (
    HGSTBundleMissingError,
    HGSTInferenceError,
    HGSTUnavailableError,
    HGSTModelNotAdmittedError,
    MOCK_SOURCE_TYPE,
    predict_with_mode,
    resolve_inference_mode,
)
from backend.app.services.model_admission_service import inspect_hgst_admission
from backend.app.services.upload_storage import (
    UploadTooLargeError,
    UploadValidationError,
    read_upload_bytes_limited,
    store_timeseries_upload,
)


router = APIRouter(prefix="/model", tags=["model-inference"])
MODEL_DISCLAIMER = "Screening support only; not a medical diagnosis."
MOCK_DISCLAIMER = "Demonstration output only; not a medical diagnosis."


def _discard_new_upload(stored):
    target=Path(stored.stored_path).resolve()
    if target.parent != Path(settings.UPLOAD_ROOT).expanduser().resolve():
        raise RuntimeError('Upload cleanup target escaped the configured root.')
    target.unlink(missing_ok=True)


@router.get('/admission')
def model_admission(current_user: User = Depends(require_roles(UserRole.RESEARCHER, UserRole.PATIENT))):
    # Global model metadata only. No patient data, raw image session or path is disclosed.
    return {**inspect_hgst_admission(), 'inference_mode': resolve_inference_mode()}


def _get_patient_for_researcher_or_self(
    db: Session,
    patient_id: int,
    current_user: User,
) -> Patient:
    return require_patient_access(db,current_user,patient_id,"imaging")


def _prediction_response(
    record: ModelPrediction,
    patient_id: int,
    *,
    is_demo: bool,
    disclaimer: str,
) -> TimeseriesPredictionResponse:
    return TimeseriesPredictionResponse(
        prediction_id=record.id,
        storage_integrity=record_storage_info(record),
        storage_context=record.storage_context,
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
        source_admission_status=('demonstration_only' if is_demo else
            ((record.storage_context or {}).get('input') or {}).get('model_registration_status', 'not_recorded')),
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
    """Persist and run a mode-aware time-series inference request.

    模式由 USE_MOCK_MODEL 决定（real / auto / mock，见 hgst_runtime.service）：
    - real（默认）      ：真实 HGST，缺失依赖/权重时 503，绝不静默降级；
    - auto              ：真实优先，不可用时降级为带标识的演示 Mock（200，is_demo=true）；
    - mock（true）      ：恒为演示 Mock（真上传、假结果，is_demo=true）。
    """

    _get_patient_for_researcher_or_self(db, patient_id, current_user)
    require_imaging_storage(db,patient_id)
    try:
        file_bytes = await read_upload_bytes_limited(
            timeseries_file,
            max_bytes=settings.UPLOAD_MAX_BYTES,
        )
        stored = store_timeseries_upload(
            file_bytes=file_bytes,
            file_name=timeseries_file.filename or "",
            upload_root=Path(settings.UPLOAD_ROOT),
            max_bytes=settings.UPLOAD_MAX_BYTES,
            authorization_check=lambda:recheck_request_authority(db),
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
    try:
        db.flush()
    except Exception as exc:
        db.rollback()
        _discard_new_upload(stored)
        raise HTTPException(503,'上传保存事务未完成。') from exc

    def mark_failed(note: str) -> None:
        upload.status = "failed"
        upload.note = note[:1000]
        try:
            save_storage_transaction(db,upload,current_user,action='model_upload_failed')
        except Exception:
            _discard_new_upload(stored)
            raise

    try:
        result = await run_in_threadpool(predict_with_mode, file_bytes, stored.original_name)
    except (HGSTUnavailableError, HGSTBundleMissingError, HGSTModelNotAdmittedError) as exc:
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

    # source_type == 'mock' 的记录即演示（is_demo=true），DB 中保留该标识以便报告页展示免责；
    # 真实推理统一按既有口径存 fmri_hgst。
    is_demo = result.source_type == MOCK_SOURCE_TYPE
    if not is_demo:
        current=inspect_hgst_admission()
        if (current.get('model_version_id')!=getattr(result,'model_registry_version_id',None)
                or current.get('registry_revision')!=getattr(result,'model_registry_revision',None)
                or current.get('status')!=getattr(result,'model_admission_status',None)
                or current.get('artifact',{}).get('sha256')!=getattr(result,'model_artifact_sha256',None)
                or not current.get('real_inference_allowed')):
            mark_failed('实际注册模型指针已变化或准入失效。')
            raise HTTPException(503,'实际模型版本或准入已变化，请重新发起分析。')
    db_source_type = MOCK_SOURCE_TYPE if is_demo else "fmri_hgst"

    prediction = ModelPrediction(
        patient_id=patient_id,
        upload_id=upload.id,
        file_name=result.file_name,
        prediction_label=result.prediction_label,
        probability=result.probability,
        probability_control=result.probability_control,
        source_type=db_source_type,
        roi_dim_used=result.roi_dim_used,
        timepoints=result.timepoints,
        model_name=result.model_name,
        model_version=(str(result.model_registry_version_id)+':'+current['model_version']
            if not is_demo and result.model_registry_version_id is not None else result.model_version),
        summary_text=result.summary_text,
    )
    db.add(prediction)
    upload.status = "completed"
    upload.note = None
    stamp_storage_context(db,prediction,current_user,input_context={
        'kind':'uploaded_timeseries','upload_id':upload.id,'sha256':stored.file_hash,'size_bytes':stored.file_size,
        'model_registration_status':'demonstration_only' if is_demo else ('legacy_accepted' if current['status']=='legacy_accepted' else 'active'),
        'model_input_contract_status':'not_applicable' if is_demo else current['input_contract_status'],
        'model_artifact_sha256':getattr(result,'model_artifact_sha256',None),
        'model_version_id':getattr(result,'model_registry_version_id',None),'registry_revision':getattr(result,'model_registry_revision',None),
        'model_input_contract_digest':getattr(result,'model_input_contract_digest',None),
    })
    try:
        save_storage_transaction(db,prediction,current_user,action='model_prediction_saved')
    except Exception:
        _discard_new_upload(stored)
        raise
    db.refresh(prediction)

    return _prediction_response(
        prediction,
        patient_id,
        is_demo=is_demo,
        disclaimer=MOCK_DISCLAIMER if is_demo else MODEL_DISCLAIMER,
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
    require_imaging_storage(db,patient_id)
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
    stamp_storage_context(db,record,current_user,input_context={'kind':'deterministic_demo','sha256':seed,'raw_input_present':False})
    save_storage_transaction(db,record,current_user,action='model_demonstration_saved')
    db.refresh(record)

    return _prediction_response(
        record,
        patient_id,
        is_demo=True,
        disclaimer=MOCK_DISCLAIMER,
    )
