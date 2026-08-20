from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from backend.app.api.deps import get_db, require_roles
from backend.app.models.model_prediction import ModelPrediction
from backend.app.models.patient import Patient
from backend.app.models.user import User, UserRole
from backend.app.schemas.model_inference import TimeseriesPredictionResponse
from backend.app.services.hgst_runtime.service import (
    HGSTBundleMissingError,
    HGSTInferenceError,
    HGSTUnavailableError,
    predict_timeseries_file,
)


router = APIRouter(prefix="/model", tags=["model-inference"])


def _get_patient_for_researcher_or_self(
    db: Session, patient_id: int, current_user: User
) -> Patient:
    """获取患者，检查研究人员绑定或患者本人"""
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="未找到该患者。",
        )

    if current_user.role == UserRole.RESEARCHER:
        if patient.assigned_researcher_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="该患者不属于当前研究人员。",
            )
    elif current_user.role == UserRole.PATIENT:
        if patient.user_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="您只能访问自己的数据。",
            )
    else:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前角色无权访问此功能。",
        )

    return patient


@router.post("/predict_fmri", response_model=TimeseriesPredictionResponse)
async def predict_fmri(
    patient_id: int,
    timeseries_file: UploadFile = File(...),
    current_user: User = Depends(require_roles(UserRole.RESEARCHER, UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> TimeseriesPredictionResponse:
    """
    fMRI 时间序列预测接口

    接受 fMRI 时间序列文件（.1D 或 .csv），使用 HGST 模型进行 ADHD 风险预测。

    参数：
    - patient_id: 患者ID
    - timeseries_file: fMRI 时间序列文件（.1D 或 .csv 格式）
    """
    _get_patient_for_researcher_or_self(db, patient_id, current_user)

    if not timeseries_file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请上传时间序列文件。",
        )

    suffix = timeseries_file.filename.lower().rsplit(".", 1)[-1] if "." in timeseries_file.filename else ""
    if suffix not in {"1d", "csv"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="当前仅支持上传 .1D 或 .csv 格式的 fMRI 时间序列文件。",
        )

    file_bytes = await timeseries_file.read()
    if not file_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="上传的时间序列文件为空。",
        )

    try:
        result = predict_timeseries_file(file_bytes, timeseries_file.filename)
    except HGSTUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except HGSTBundleMissingError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except HGSTInferenceError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"fMRI 推理失败：{exc}",
        ) from exc

    prediction = ModelPrediction(
        patient_id=patient_id,
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
    db.commit()
    db.refresh(prediction)

    return TimeseriesPredictionResponse(
        prediction_id=prediction.id,
        patient_id=patient_id,
        file_name=result.file_name,
        prediction_label=result.prediction_label,
        probability=result.probability,
        probability_control=result.probability_control,
        source_type=result.source_type,
        roi_dim_used=result.roi_dim_used,
        timepoints=result.timepoints,
        model_name=result.model_name,
        model_version=result.model_version,
        summary_text=result.summary_text,
        created_at=prediction.created_at,
    )
