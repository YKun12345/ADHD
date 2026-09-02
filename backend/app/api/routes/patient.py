from datetime import datetime
from statistics import mean

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.api.deps import get_db, require_roles
from backend.app.models.cognitive_test import CognitiveTest
from backend.app.models.imaging_visualization import ImagingVisualization
from backend.app.models.model_prediction import ModelPrediction
from backend.app.models.patient import Patient
from backend.app.models.scale_result import ScaleResult
from backend.app.models.tracking_log import TrackingLog
from backend.app.models.user import User, UserRole
from backend.app.schemas.cognitive import (
    CognitiveProfileResponse,
    CognitiveTestReportItem,
    CognitiveTestResponse,
    CognitiveTestSubmitRequest,
)
from backend.app.schemas.imaging import ImagingVisualizationResponse
from backend.app.schemas.model_inference import ModelPredictionReportResponse
from backend.app.schemas.scale import (
    PatientReportResponse,
    ScaleResultResponse,
    ScaleSubmitRequest,
)
from backend.app.schemas.tracking import (
    DashboardStatusResponse,
    TrackingLogCreate,
    TrackingLogResponse,
    TrackingSummaryResponse,
)
from backend.app.services.security_service import (
    capture_cognitive_test_cipher,
    capture_scale_result_cipher,
    capture_tracking_log_cipher,
)
from backend.app.services.cognitive_contract import (
    CANONICAL_COGNITIVE_TYPES,
    canonical_test_type,
    normalize_result_json,
)


router = APIRouter(prefix="/patient", tags=["patient"])


ASRS_PART_A_THRESHOLDS = {0: 2, 1: 2, 2: 2, 3: 3, 4: 2, 5: 3}
MOOD_TEXT_MAP = {
    "5": "状态很好",
    "4": "整体不错",
    "3": "状态一般",
    "2": "有些吃力",
    "1": "状态低落",
}


def _scaled_mean(values: list[int], scale_max: int) -> float:
    if not values:
        return 0.0
    return round((mean(values) / scale_max) * 20, 1)


def _asrs_scores(answers: list[int]) -> tuple[dict[str, float], dict[str, float], str]:
    part_a_positive = sum(
        1 for index, threshold in ASRS_PART_A_THRESHOLDS.items() if answers[index] >= threshold
    )

    sub_scores = {
        "part_a_positive": float(part_a_positive),
        "attention_deficit": round(sum(answers[:9]), 1),
        "hyperactivity_impulsivity": round(sum(answers[9:]), 1),
    }
    radar_scores = {
        "attention_control": _scaled_mean([answers[i] for i in [0, 1, 2, 8]], 4),
        "organization": _scaled_mean([answers[i] for i in [3, 4, 5, 6]], 4),
        "task_activation": _scaled_mean([answers[i] for i in [7, 9, 10]], 4),
        "hyperactivity": _scaled_mean([answers[i] for i in [11, 12, 13]], 4),
        "impulsivity": _scaled_mean([answers[i] for i in [14, 15, 16, 17]], 4),
    }

    if part_a_positive >= 4:
        risk_level = "high"
    elif sum(answers) >= 32:
        risk_level = "medium"
    else:
        risk_level = "low"

    return sub_scores, radar_scores, risk_level


def _snap_scores(answers: list[int]) -> tuple[dict[str, float], dict[str, float], str]:
    attention = answers[:9]
    hyper = answers[9:18]
    odd = answers[18:26]

    attention_mean = round(mean(attention), 2)
    hyper_mean = round(mean(hyper), 2)
    odd_mean = round(mean(odd), 2)

    sub_scores = {
        "attention_mean": attention_mean,
        "hyperactivity_mean": hyper_mean,
        "oppositional_mean": odd_mean,
    }
    radar_scores = {
        "attention_control": _scaled_mean(attention[:5], 3),
        "organization": _scaled_mean(attention[5:], 3),
        "hyperactivity": _scaled_mean(hyper[:5], 3),
        "impulsivity": _scaled_mean(hyper[5:], 3),
        "emotional_regulation": _scaled_mean(odd, 3),
    }

    if attention_mean >= 1.78 or hyper_mean >= 1.78:
        risk_level = "high"
    elif attention_mean >= 1.2 or hyper_mean >= 1.2 or odd_mean >= 1.2:
        risk_level = "medium"
    else:
        risk_level = "low"

    return sub_scores, radar_scores, risk_level


def _build_summary(scale_type: str, risk_level: str) -> str:
    if scale_type == "ASRS":
        if risk_level == "high":
            return "成人量表提示核心注意控制与执行启动困难较明显，建议尽快结合认知测试与医生访谈进一步评估。"
        if risk_level == "medium":
            return "成人量表提示存在一定注意维持与组织规划波动，建议结合认知测试和14天追踪继续观察。"
        return "成人量表结果整体风险较低，但仍建议结合日常功能表现与后续任务结果综合判断。"

    if risk_level == "high":
        return "儿童量表提示注意缺陷或多动冲动表现较突出，建议结合家校观察和专业评估进一步确认。"
    if risk_level == "medium":
        return "儿童量表提示存在一定症状倾向，建议继续完成认知测试与14天追踪并关注多场景表现。"
    return "儿童量表结果整体风险较低，但仍建议结合不同情境下的行为表现持续观察。"


def _build_recommendations(scale_type: str, risk_level: str) -> list[str]:
    common = [
        "建议继续完成认知测试与14天追踪，以形成更稳定的多模态评估基线。",
        "量表结果仅用于辅助筛查，不替代医生面对面诊断。",
    ]
    if scale_type == "ASRS":
        role_specific = [
            "尝试使用固定时间块、任务拆分和提醒工具来降低执行启动成本。",
            "优先记录学习或工作中最容易分心的场景，为后续干预提供线索。",
        ]
    else:
        role_specific = [
            "建议由家长与教师共同观察并记录孩子在家庭与学校中的差异表现。",
            "可优先关注课堂专注、作业完成和情绪对立等高频场景。",
        ]

    if risk_level == "high":
        role_specific.insert(0, "建议尽快预约专业医生或心理评估师进行进一步诊断。")

    return role_specific + common


def _to_scale_response(scale_result: ScaleResult) -> ScaleResultResponse:
    score_json = scale_result.score_json or {}
    return ScaleResultResponse(
        id=scale_result.id,
        scale_type=scale_result.scale_type,
        respondent_type=score_json.get("respondent_type", "self"),
        total_score=scale_result.total_score,
        risk_level=scale_result.risk_level,
        radar_scores=score_json.get("radar_scores", {}),
        sub_scores=score_json.get("sub_scores", {}),
        summary=score_json.get("summary", ""),
        recommendations=score_json.get("recommendations", []),
        created_at=scale_result.created_at,
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


def _to_model_prediction_response(record: ModelPrediction | None) -> ModelPredictionReportResponse | None:
    if record is None:
        return None

    probability_control = record.probability_control
    if probability_control is None:
        probability_control = round(max(0.0, min(1.0, 1 - float(record.probability or 0))), 4)

    summary_text = record.summary_text
    if not summary_text:
        summary_text = (
            f"基于时间序列影像分析，当前模型输出标签为 {record.prediction_label}，"
            f"对应概率为 {round(float(record.probability or 0) * 100, 1)}%。"
        )

    return ModelPredictionReportResponse(
        prediction_id=record.id,
        upload_id=record.upload_id,
        file_name=record.file_name,
        prediction_label=record.prediction_label,
        probability=record.probability,
        probability_control=probability_control,
        source_type=record.source_type,
        roi_dim_used=record.roi_dim_used,
        timepoints=record.timepoints,
        model_name=record.model_name,
        model_version=record.model_version,
        summary_text=summary_text,
        is_demo=record.source_type == "mock",
        disclaimer=(
            "Demonstration output only; not a medical diagnosis."
            if record.source_type == "mock"
            else "Screening support only; not a medical diagnosis."
        ),
        created_at=record.created_at,
    )


def _clamp_score(value: float, minimum: float = 0.0, maximum: float = 20.0) -> float:
    return round(max(minimum, min(maximum, value)), 1)


def _inverse_time_score(value: float | None, fast: float, slow: float) -> float:
    if value is None:
        return 0.0
    if fast >= slow:
        return 0.0
    ratio = (slow - value) / (slow - fast)
    return _clamp_score(ratio * 20.0)


def _accuracy_score(value: float | None) -> float:
    if value is None:
        return 0.0
    return _clamp_score((value / 100.0) * 20.0)


def _digit_span_score(span: float | None) -> float:
    if span is None:
        return 0.0
    return _clamp_score(((span - 3.0) / 5.0) * 20.0)


def _extract_float(raw: dict, key: str) -> float | None:
    value = raw.get(key)
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _extract_latest_cognitive_profile(
    db: Session,
    patient_id: int,
) -> CognitiveProfileResponse | None:
    records = db.scalars(
        select(CognitiveTest)
        .where(CognitiveTest.patient_id == patient_id)
        .order_by(CognitiveTest.created_at.desc(), CognitiveTest.id.desc())
    ).all()

    if not records:
        return None

    latest_by_type: dict[str, CognitiveTest] = {}
    for record in records:
        try:
            normalized_type = canonical_test_type(record.test_type)
        except (AttributeError, ValueError):
            continue
        if normalized_type not in latest_by_type:
            latest_by_type[normalized_type] = record

    reaction = latest_by_type.get("reaction")
    simple_reaction = latest_by_type.get("simple_reaction")
    stroop = latest_by_type.get("stroop")
    trail = latest_by_type.get("trail")
    flanker = latest_by_type.get("flanker")
    nback = latest_by_type.get("nback")
    digit = latest_by_type.get("digit")

    def raw_result(record: CognitiveTest | None) -> dict:
        if record is None:
            return {}
        normalized = normalize_result_json(record.test_type, record.result_json or {})
        return normalized.get("raw_result", {})

    reaction_raw = raw_result(reaction)
    simple_reaction_raw = raw_result(simple_reaction)
    stroop_raw = raw_result(stroop)
    trail_raw = raw_result(trail)
    flanker_raw = raw_result(flanker)
    nback_raw = raw_result(nback)
    digit_raw = raw_result(digit)
    reaction_speed_raw = simple_reaction_raw or reaction_raw

    reaction_speed = _clamp_score(
        (
            _inverse_time_score(_extract_float(reaction_speed_raw, "average_reaction_time_ms"), 250, 900) * 0.45
            + _inverse_time_score(_extract_float(stroop_raw, "average_reaction_time_ms"), 500, 1800) * 0.2
            + _inverse_time_score(_extract_float(flanker_raw, "average_reaction_time_ms"), 400, 1600) * 0.2
            + _inverse_time_score(_extract_float(trail_raw, "elapsed_ms"), 6000, 40000) * 0.15
        )
    )

    attention_control = _clamp_score(
        (
            _accuracy_score(_extract_float(stroop_raw, "accuracy")) * 0.4
            + _accuracy_score(_extract_float(flanker_raw, "accuracy")) * 0.35
            + (
                _inverse_time_score(_extract_float(trail_raw, "elapsed_ms"), 6000, 40000) * 0.5
                + _clamp_score(20 - (_extract_float(trail_raw, "errors") or 0) * 4) * 0.5
            ) * 0.25
        )
    )

    inhibitory_control = _clamp_score(
        (
            _accuracy_score(_extract_float(stroop_raw, "accuracy")) * 0.45
            + _accuracy_score(_extract_float(flanker_raw, "accuracy")) * 0.45
            + _clamp_score(20 - (_extract_float(reaction_raw, "false_starts") or 0) * 4) * 0.1
        )
    )

    working_memory = _clamp_score(
        (
            _digit_span_score(_extract_float(digit_raw, "highest_span")) * 0.55
            + _accuracy_score(_extract_float(nback_raw, "accuracy")) * 0.45
        )
    )

    radar_scores = {
        "reaction_speed": reaction_speed,
        "attention_control": attention_control,
        "inhibitory_control": inhibitory_control,
        "working_memory": working_memory,
    }

    average_score = round(mean(radar_scores.values()), 1)
    if average_score >= 15:
        level_text = "整体表现稳定"
    elif average_score >= 10:
        level_text = "能力水平中等"
    else:
        level_text = "存在可继续训练的空间"

    summary = (
        f"当前认知测试聚合结果显示：反应速度 {reaction_speed}/20，"
        f"注意控制 {attention_control}/20，抑制控制 {inhibitory_control}/20，"
        f"工作记忆 {working_memory}/20。平台判定为“{level_text}”。"
        "这些分值用于项目内长期追踪，不替代医生诊断。"
    )

    def build_item(record: CognitiveTest | None) -> CognitiveTestReportItem | None:
        if record is None:
            return None
        result_json = normalize_result_json(record.test_type, record.result_json or {})
        metrics = result_json.get("metrics") or []
        key_metric = metrics[0]["value"] if metrics and isinstance(metrics[0], dict) and "value" in metrics[0] else "--"
        finished_at = result_json.get("finished_at")
        parsed_finished_at = None
        if isinstance(finished_at, str):
            try:
                parsed_finished_at = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
            except ValueError:
                parsed_finished_at = None
        normalized_type = canonical_test_type(record.test_type)
        return CognitiveTestReportItem(
            test_type=normalized_type,
            test_name=result_json.get("test_name") or normalized_type,
            status_text=result_json.get("status_text") or "已记录",
            key_metric=str(key_metric),
            finished_at=parsed_finished_at,
        )

    latest_tests = [
        item
        for item in [
            build_item(latest_by_type.get(test_type))
            for test_type in CANONICAL_COGNITIVE_TYPES
        ]
        if item is not None
    ]

    return CognitiveProfileResponse(
        radar_scores=radar_scores,
        summary=summary,
        latest_tests=latest_tests,
    )


def _extract_tracking_summary(
    db: Session,
    patient_id: int,
    total_days: int = 14,
) -> TrackingSummaryResponse:
    logs = db.scalars(
        select(TrackingLog)
        .where(TrackingLog.patient_id == patient_id)
        .order_by(TrackingLog.day_index.asc(), TrackingLog.created_at.asc())
    ).all()

    completed_days = sorted({log.day_index for log in logs})
    completed_count = len(completed_days)
    current_day = max(completed_days) + 1 if completed_days else 1
    latest_log = logs[-1] if logs else None

    mood_values = [
        int(log.mood_tag)
        for log in logs
        if isinstance(log.mood_tag, str) and log.mood_tag.isdigit()
    ]
    focus_values = [log.focus_minutes for log in logs if log.focus_minutes is not None]

    latest_logged_day = completed_days[-1] if completed_days else None
    if completed_count >= total_days:
        completion_status = "completed"
    elif completed_count == 0:
        completion_status = "not_started"
    elif completed_count >= max(1, total_days // 2):
        completion_status = "in_progress"
    else:
        completion_status = "building_baseline"

    consecutive_missed_days = 0
    if latest_logged_day and latest_logged_day < total_days:
        consecutive_missed_days = total_days - latest_logged_day

    latest_note_excerpt = None
    if latest_log and latest_log.note:
        latest_note_excerpt = latest_log.note.strip()[:80]

    return TrackingSummaryResponse(
        total_days=total_days,
        completed_days=completed_days,
        completed_count=completed_count,
        current_day=current_day,
        latest_day_index=latest_logged_day,
        completion_status=completion_status,
        consecutive_missed_days=consecutive_missed_days,
        average_mood=round(mean(mood_values), 1) if mood_values else None,
        average_focus_minutes=round(mean(focus_values), 1) if focus_values else None,
        latest_mood_text=MOOD_TEXT_MAP.get(latest_log.mood_tag) if latest_log and latest_log.mood_tag else None,
        latest_note_excerpt=latest_note_excerpt,
    )


@router.post("/submit_scale", response_model=ScaleResultResponse, status_code=status.HTTP_201_CREATED)
def submit_scale(
    payload: ScaleSubmitRequest,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> ScaleResultResponse:
    patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="未找到患者档案，请重新登录或先完善个人信息。",
        )

    if payload.scale_type == "ASRS":
        if len(payload.answers) != 18 or any(answer < 0 or answer > 4 for answer in payload.answers):
            raise HTTPException(status_code=400, detail="ASRS 量表需要 18 题，且每题分值必须在 0 到 4 之间。")
        sub_scores, radar_scores, risk_level = _asrs_scores(payload.answers)
    else:
        if len(payload.answers) != 26 or any(answer < 0 or answer > 3 for answer in payload.answers):
            raise HTTPException(status_code=400, detail="SNAP-IV 量表需要 26 题，且每题分值必须在 0 到 3 之间。")
        sub_scores, radar_scores, risk_level = _snap_scores(payload.answers)

    summary = _build_summary(payload.scale_type, risk_level)
    recommendations = _build_recommendations(payload.scale_type, risk_level)

    scale_result = ScaleResult(
        patient_id=patient.id,
        scale_type=payload.scale_type,
        score_json={
            "answers": payload.answers,
            "respondent_type": payload.respondent_type,
            "sub_scores": sub_scores,
            "radar_scores": radar_scores,
            "summary": summary,
            "recommendations": recommendations,
        },
        total_score=float(sum(payload.answers)),
        risk_level=risk_level,
    )
    db.add(scale_result)
    db.commit()
    db.refresh(scale_result)
    capture_scale_result_cipher(db, patient, scale_result)
    db.commit()

    return _to_scale_response(scale_result)


@router.post(
    "/submit_cognitive_test",
    response_model=CognitiveTestResponse,
    status_code=status.HTTP_201_CREATED,
)
def submit_cognitive_test(
    payload: CognitiveTestSubmitRequest,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> CognitiveTestResponse:
    patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Patient profile not found for current user.",
        )

    record = CognitiveTest(
        patient_id=patient.id,
        test_type=payload.test_type,
        result_json=payload.result_json,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    capture_cognitive_test_cipher(db, patient, record)
    db.commit()

    return CognitiveTestResponse(
        id=record.id,
        test_type=record.test_type,
        result_json=record.result_json,
        created_at=record.created_at,
    )


@router.get("/dashboard_status", response_model=DashboardStatusResponse)
def get_dashboard_status(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> DashboardStatusResponse:
    patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
    if patient is None:
        raise HTTPException(status_code=400, detail="未找到患者档案")

    logs = db.scalars(
        select(TrackingLog)
        .where(TrackingLog.patient_id == patient.id)
        .order_by(TrackingLog.day_index.asc())
    ).all()

    completed_days = [log.day_index for log in logs]
    current_day = max(completed_days) + 1 if completed_days else 1

    return DashboardStatusResponse(
        current_day=current_day,
        completed_days=completed_days,
        total_days=14,
        logs=[TrackingLogResponse.model_validate(log) for log in logs],
    )


@router.post("/submit_daily_log", response_model=TrackingLogResponse, status_code=201)
def submit_daily_log(
    payload: TrackingLogCreate,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> TrackingLogResponse:
    patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
    if patient is None:
        raise HTTPException(status_code=400, detail="未找到患者档案")

    existing = db.scalar(
        select(TrackingLog).where(
            TrackingLog.patient_id == patient.id, TrackingLog.day_index == payload.day_index
        )
    )

    stored_activities = ",".join(payload.activities) if payload.activities else None

    if existing:
        existing.mood_tag = payload.mood_tag
        existing.focus_minutes = payload.focus_minutes
        existing.note = payload.note
        existing.test_score = payload.test_score
        existing.activities = stored_activities
        existing.is_medication = payload.is_medication
        existing.medication_dosage = payload.medication_dosage
        existing.attention_rating = payload.attention_rating
        existing.hyperactivity_rating = payload.hyperactivity_rating
        existing.impulsivity_rating = payload.impulsivity_rating
        existing.emotion_rating = payload.emotion_rating
        existing.task_completion_rating = payload.task_completion_rating
        existing.sleep_quality = payload.sleep_quality
        existing.appetite_quality = payload.appetite_quality
        existing.has_conflict = payload.has_conflict
        existing.was_criticized = payload.was_criticized
        existing.side_effects = payload.side_effects
        existing.special_events = payload.special_events
        existing.highlights = payload.highlights
        db.commit()
        db.refresh(existing)
        capture_tracking_log_cipher(db, patient, existing)
        db.commit()
        return TrackingLogResponse.model_validate(existing)

    new_log = TrackingLog(
        patient_id=patient.id,
        day_index=payload.day_index,
        mood_tag=payload.mood_tag,
        focus_minutes=payload.focus_minutes,
        note=payload.note,
        test_score=payload.test_score,
        activities=stored_activities,
        is_medication=payload.is_medication,
        medication_dosage=payload.medication_dosage,
        attention_rating=payload.attention_rating,
        hyperactivity_rating=payload.hyperactivity_rating,
        impulsivity_rating=payload.impulsivity_rating,
        emotion_rating=payload.emotion_rating,
        task_completion_rating=payload.task_completion_rating,
        sleep_quality=payload.sleep_quality,
        appetite_quality=payload.appetite_quality,
        has_conflict=payload.has_conflict,
        was_criticized=payload.was_criticized,
        side_effects=payload.side_effects,
        special_events=payload.special_events,
        highlights=payload.highlights,
    )
    db.add(new_log)
    db.commit()
    db.refresh(new_log)
    capture_tracking_log_cipher(db, patient, new_log)
    db.commit()
    return TrackingLogResponse.model_validate(new_log)

@router.get("/comprehensive_report", response_model=PatientReportResponse)
def get_comprehensive_report(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> PatientReportResponse:
    patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))

    latest_scale = None
    latest_imaging = None
    latest_model_prediction = None
    cognitive_profile = None
    tracking_summary = None
    patient_type = None
    if patient is not None:
        patient_type = patient.patient_type.value
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

    return PatientReportResponse(
        patient_name=current_user.full_name,
        patient_type=patient_type,
        latest_scale=_to_scale_response(latest_scale) if latest_scale else None,
        cognitive_profile=cognitive_profile,
        tracking_summary=tracking_summary,
        latest_imaging_visualization=_to_imaging_response(latest_imaging),
        latest_model_prediction=_to_model_prediction_response(latest_model_prediction),
    )
