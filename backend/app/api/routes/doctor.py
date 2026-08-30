from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from backend.app.api.deps import get_db, require_roles
from backend.app.api.routes.patient import (
    _extract_latest_cognitive_profile,
    _extract_tracking_summary,
    _to_model_prediction_response,
    _to_scale_response,
)
from backend.app.models.cognitive_test import CognitiveTest
from backend.app.models.imaging_visualization import ImagingVisualization
from backend.app.models.model_prediction import ModelPrediction
from backend.app.models.patient import Patient
from backend.app.models.scale_result import ScaleResult
from backend.app.models.tracking_log import TrackingLog
from backend.app.models.user import User, UserRole
from backend.app.schemas.imaging import (
    ImagingVisualizationResponse,
    SaveImagingVisualizationRequest,
)
from backend.app.schemas.researcher import (
    BindPatientByEmailRequest,
    ResearcherDashboardStats,
    ResearcherPatientItem,
    ResearcherPatientListResponse,
    ResearcherPatientReportResponse,
)
from backend.app.schemas.tracking import TrackingLogResponse


router = APIRouter(prefix="/doctor", tags=["doctor"])


def _build_imaging_summary(payload: SaveImagingVisualizationRequest) -> str:
    if payload.visualization_type == "nifti":
        extras = []
        if payload.anat_file_name:
            extras.append("解剖影像")
        if payload.mask_file_name:
            extras.append("脑掩膜")
        extra_text = f"，并联合加载{'、'.join(extras)}" if extras else ""
        func_name = payload.func_file_name or "功能影像"
        return f"已完成 NIfTI 脑区剖面可视化，基于 {func_name}{extra_text} 进行了影像浏览与结构对照。"

    left_name = payload.left_func_file_name or "左半球功能文件"
    right_name = payload.right_func_file_name or "右半球功能文件"
    return (
        f"已完成 GIfTI 3D 脑表面可视化，基于 {left_name} 与 {right_name} "
        "完成左右半球功能-表面联合展示。"
    )


def _to_imaging_response(record: ImagingVisualization | None) -> ImagingVisualizationResponse | None:
    if record is None:
        return None

    return ImagingVisualizationResponse(
        id=record.id,
        visualization_type=record.visualization_type,
        func_file_name=record.func_file_name,
        anat_file_name=record.anat_file_name,
        mask_file_name=record.mask_file_name,
        left_func_file_name=record.left_func_file_name,
        left_mesh_file_name=record.left_mesh_file_name,
        right_func_file_name=record.right_func_file_name,
        right_mesh_file_name=record.right_mesh_file_name,
        slice_screenshot_name=record.slice_screenshot_name,
        slice_screenshot_data=record.slice_screenshot_data,
        surface_screenshot_name=record.surface_screenshot_name,
        surface_screenshot_data=record.surface_screenshot_data,
        slice_interpretation=record.slice_interpretation,
        surface_interpretation=record.surface_interpretation,
        summary_text=record.summary_text,
        notes=record.notes,
        created_at=record.created_at,
    )


def _build_next_step_text(
    latest_scale: ScaleResult | None,
    cognitive_test_count: int,
    completed_tracking_days: int,
    has_imaging: bool,
) -> str:
    if latest_scale is None:
        return "建议先补充行为量表，建立患者基线。"
    if cognitive_test_count == 0:
        return "建议补充认知测试，完善执行功能证据。"
    if completed_tracking_days < 7:
        return "建议继续完成14天追踪，形成动态行为链条。"
    if not has_imaging:
        return "可补充影像分析，形成更完整的客观证据层。"
    return "建议进入综合分析页，联动查看量表、追踪与影像结果。"


def _build_care_summary(
    latest_scale: ScaleResult | None,
    cognitive_profile,
    tracking_summary,
    has_imaging: bool,
) -> list[str]:
    items: list[str] = []

    if latest_scale is not None:
        summary = (latest_scale.score_json or {}).get("summary")
        if isinstance(summary, str) and summary.strip():
            items.append(summary.strip())

    if cognitive_profile is not None and cognitive_profile.summary:
        items.append(cognitive_profile.summary.strip())

    if tracking_summary is not None:
        if tracking_summary.completed_count == 0:
            items.append("当前14天追踪尚未启动，暂时缺少连续生活场景证据。")
        else:
            items.append(
                f"14天追踪已完成 {tracking_summary.completed_count}/{tracking_summary.total_days} 天，"
                f"当前更适合结合趋势结果进行随访判断。"
            )

    if not has_imaging:
        items.append("影像层证据尚未补充，可进一步进入影像分析与可视化流程。")

    deduped: list[str] = []
    for item in items:
        if item and item not in deduped:
            deduped.append(item)
    return deduped[:3]


def _build_suggested_actions(
    latest_scale: ScaleResult | None,
    cognitive_test_count: int,
    tracking_summary,
    has_imaging: bool,
) -> list[str]:
    actions: list[str] = []

    if latest_scale is None:
        actions.append("先补充行为量表，建立基础症状画像。")
    if cognitive_test_count == 0:
        actions.append("补做认知测试，完善客观执行功能指标。")
    if tracking_summary is not None and tracking_summary.completed_count < tracking_summary.total_days:
        actions.append("继续完成14天追踪，增强动态证据连续性。")
    if not has_imaging:
        actions.append("上传并分析影像数据，形成客观证据补充。")
    else:
        actions.append("进入脑影像可视化模块，对照综合报告复核结果。")

    deduped: list[str] = []
    for item in actions:
        if item not in deduped:
            deduped.append(item)
    return deduped[:4]


def _build_patient_item(db: Session, patient: Patient) -> ResearcherPatientItem:
    latest_scale = db.scalar(
        select(ScaleResult)
        .where(ScaleResult.patient_id == patient.id)
        .order_by(ScaleResult.created_at.desc(), ScaleResult.id.desc())
    )
    cognitive_test_count = db.scalar(
        select(func.count(CognitiveTest.id)).where(CognitiveTest.patient_id == patient.id)
    ) or 0
    tracking_summary = _extract_tracking_summary(db, patient.id)
    has_imaging = db.scalar(
        select(func.count(ImagingVisualization.id)).where(ImagingVisualization.patient_id == patient.id)
    ) > 0

    return ResearcherPatientItem(
        patient_id=patient.id,
        patient_name=patient.user.full_name,
        patient_email=patient.user.email,
        patient_type=patient.patient_type.value,
        latest_scale_type=latest_scale.scale_type if latest_scale else None,
        latest_scale_risk_level=latest_scale.risk_level if latest_scale else None,
        latest_scale_total_score=latest_scale.total_score if latest_scale else None,
        completed_tracking_days=tracking_summary.completed_count,
        current_tracking_day=tracking_summary.current_day,
        completion_status=tracking_summary.completion_status,
        cognitive_test_count=cognitive_test_count,
        has_imaging=has_imaging,
        next_step_text=_build_next_step_text(
            latest_scale,
            cognitive_test_count,
            tracking_summary.completed_count,
            has_imaging,
        ),
        created_at=patient.created_at,
    )


@router.post("/bind_patient", response_model=ResearcherPatientItem)
def bind_patient_by_email(
    payload: BindPatientByEmailRequest,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> ResearcherPatientItem:
    patient_user = db.scalar(
        select(User).where(
            User.email == payload.patient_email,
            User.role == UserRole.PATIENT,
        )
    )
    if patient_user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="未找到该邮箱对应的患者账号。",
        )

    patient = db.scalar(select(Patient).where(Patient.user_id == patient_user.id))
    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="该患者尚未完善档案，暂时无法绑定。",
        )

    if patient.assigned_researcher_id and patient.assigned_researcher_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该患者已绑定其他研究人员。",
        )

    patient.assigned_researcher_id = current_user.id
    db.commit()
    db.refresh(patient)

    return _build_patient_item(db, patient)


@router.get("/my_patients", response_model=ResearcherPatientListResponse)
def get_my_patients(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> ResearcherPatientListResponse:
    patients = db.scalars(
        select(Patient)
        .where(Patient.assigned_researcher_id == current_user.id)
        .order_by(Patient.created_at.desc(), Patient.id.desc())
    ).all()

    items = [_build_patient_item(db, patient) for patient in patients]
    return ResearcherPatientListResponse(total=len(items), items=items)


@router.get("/dashboard_stats", response_model=ResearcherDashboardStats)
def get_dashboard_stats(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> ResearcherDashboardStats:
    # 1. 当前就诊者总数
    patient_count = db.scalar(
        select(func.count(Patient.id)).where(Patient.assigned_researcher_id == current_user.id)
    ) or 0

    # 2. 待分析影像数 (已绑定但未上传影像的患者)
    pending_imaging_count = db.scalar(
        select(func.count(Patient.id))
        .outerjoin(ImagingVisualization, Patient.id == ImagingVisualization.patient_id)
        .where(
            Patient.assigned_researcher_id == current_user.id,
            ImagingVisualization.id.is_(None)
        )
    ) or 0

    # 3. 本周报告数 (过去7天内的量表结果)
    last_week = datetime.now(timezone.utc) - timedelta(days=7)
    weekly_report_count = db.scalar(
        select(func.count(ScaleResult.id))
        .join(Patient, ScaleResult.patient_id == Patient.id)
        .where(
            Patient.assigned_researcher_id == current_user.id,
            ScaleResult.created_at >= last_week
        )
    ) or 0

    return ResearcherDashboardStats(
        patient_count=patient_count,
        pending_imaging_count=pending_imaging_count,
        weekly_report_count=weekly_report_count
    )


@router.post(
    "/patient/{patient_id}/imaging_visualization",
    response_model=ImagingVisualizationResponse,
    status_code=status.HTTP_201_CREATED,
)
def save_patient_imaging_visualization(
    patient_id: int,
    payload: SaveImagingVisualizationRequest,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> ImagingVisualizationResponse:
    patient = db.get(Patient, patient_id)
    if patient is None or patient.assigned_researcher_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="未找到该患者，或该患者不属于当前研究人员。",
        )

    if payload.visualization_type not in {"nifti", "gifti"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="影像可视化类型仅支持 nifti 或 gifti。",
        )

    summary_text = _build_imaging_summary(payload)
    record = db.scalar(
        select(ImagingVisualization)
        .where(ImagingVisualization.patient_id == patient.id)
        .order_by(ImagingVisualization.created_at.desc(), ImagingVisualization.id.desc())
    )

    if record is None:
        record = ImagingVisualization(
            patient_id=patient.id,
            researcher_id=current_user.id,
            visualization_type=payload.visualization_type,
            summary_text=summary_text,
        )
        db.add(record)
    else:
        record.researcher_id = current_user.id
        record.visualization_type = payload.visualization_type
        record.summary_text = summary_text

    record.func_file_name = payload.func_file_name or record.func_file_name
    record.anat_file_name = payload.anat_file_name or record.anat_file_name
    record.mask_file_name = payload.mask_file_name or record.mask_file_name
    record.left_func_file_name = payload.left_func_file_name or record.left_func_file_name
    record.left_mesh_file_name = payload.left_mesh_file_name or record.left_mesh_file_name
    record.right_func_file_name = payload.right_func_file_name or record.right_func_file_name
    record.right_mesh_file_name = payload.right_mesh_file_name or record.right_mesh_file_name
    record.slice_screenshot_name = payload.slice_screenshot_name or record.slice_screenshot_name
    record.slice_screenshot_data = payload.slice_screenshot_data or record.slice_screenshot_data
    record.surface_screenshot_name = payload.surface_screenshot_name or record.surface_screenshot_name
    record.surface_screenshot_data = payload.surface_screenshot_data or record.surface_screenshot_data
    record.slice_interpretation = payload.slice_interpretation or record.slice_interpretation
    record.surface_interpretation = payload.surface_interpretation or record.surface_interpretation
    if payload.notes is not None:
        record.notes = payload.notes

    db.commit()
    db.refresh(record)

    return _to_imaging_response(record)


@router.get("/patient/{patient_id}/report", response_model=ResearcherPatientReportResponse)
def get_patient_report_details(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> ResearcherPatientReportResponse:
    patient = db.get(Patient, patient_id)
    if patient is None or patient.assigned_researcher_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="未找到该患者，或该患者不属于当前研究人员。",
        )

    latest_scale = db.scalar(
        select(ScaleResult)
        .where(ScaleResult.patient_id == patient.id)
        .order_by(ScaleResult.created_at.desc(), ScaleResult.id.desc())
    )
    latest_imaging = db.scalar(
        select(ImagingVisualization)
        .where(ImagingVisualization.patient_id == patient.id)
        .order_by(ImagingVisualization.created_at.desc(), ImagingVisualization.id.desc())
    )
    latest_model_prediction = db.scalar(
        select(ModelPrediction)
        .where(ModelPrediction.patient_id == patient.id)
        .order_by(ModelPrediction.created_at.desc(), ModelPrediction.id.desc())
    )
    cognitive_profile = _extract_latest_cognitive_profile(db, patient.id)
    tracking_summary = _extract_tracking_summary(db, patient.id)
    tracking_logs = db.scalars(
        select(TrackingLog)
        .where(TrackingLog.patient_id == patient.id)
        .order_by(TrackingLog.day_index.asc(), TrackingLog.created_at.asc())
    ).all()
    cognitive_test_count = db.scalar(
        select(func.count(CognitiveTest.id)).where(CognitiveTest.patient_id == patient.id)
    ) or 0
    has_imaging = latest_imaging is not None

    return ResearcherPatientReportResponse(
        patient_id=patient.id,
        patient_name=patient.user.full_name,
        patient_email=patient.user.email,
        patient_type=patient.patient_type.value,
        latest_scale=_to_scale_response(latest_scale) if latest_scale else None,
        cognitive_profile=cognitive_profile,
        tracking_summary=tracking_summary,
        tracking_logs=[TrackingLogResponse.from_orm(log) for log in tracking_logs],
        care_summary=_build_care_summary(
            latest_scale,
            cognitive_profile,
            tracking_summary,
            has_imaging,
        ),
        suggested_actions=_build_suggested_actions(
            latest_scale,
            cognitive_test_count,
            tracking_summary,
            has_imaging,
        ),
        latest_imaging_visualization=_to_imaging_response(latest_imaging),
        latest_model_prediction=_to_model_prediction_response(latest_model_prediction),
    )
