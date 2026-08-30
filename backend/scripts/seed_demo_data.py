"""一键生成演示用后端数据（seed demo data）。

用法（在 src 根目录执行）：
    .venv/Scripts/python.exe -m backend.scripts.seed_demo_data

创建独立演示账号并填充全套样本数据：
    - adult@demo.com  成人 ASRS 高风险（ADHD）
    - child@demo.com  儿童 SNAP-IV 低风险（Control）
    - doctor@demo.com 研究者（NORMAL，绑定上述两名患者）
所有账号密码均为 Demo#2026（仅演示用）。
"""

from __future__ import annotations

from backend.app.api.routes.patient import (
    _asrs_scores,
    _build_recommendations,
    _build_summary,
    _snap_scores,
)
from backend.app.core.security import get_password_hash
from backend.app.db.session import SessionLocal
from backend.app.models.cognitive_test import CognitiveTest
from backend.app.models.imaging_visualization import ImagingVisualization
from backend.app.models.model_prediction import ModelPrediction
from backend.app.models.patient import Patient, PatientType
from backend.app.models.scale_result import ScaleResult
from backend.app.models.tracking_log import TrackingLog
from backend.app.models.user import User, UserRole, UserSubrole

PASSWORD = "Demo#2026"

ADULT_EMAIL = "adult@demo.com"
CHILD_EMAIL = "child@demo.com"
DOCTOR_EMAIL = "doctor@demo.com"


def _tracking_logs() -> list[dict]:
    logs = []
    for day in range(1, 15):
        logs.append({
            "day_index": day,
            "mood_tag": str(3 + (day % 3)),
            "focus_minutes": 35 + (day % 4) * 10,
            "note": f"第 {day} 天生活记录",
            "test_score": round(0.6 + (day % 5) * 0.08, 2),
            "activities": "阅读、写作业",
            "is_medication": day % 2 == 0,
            "medication_dosage": "0.3mg" if day % 2 == 0 else None,
            "attention_rating": 3 + (day % 2),
            "hyperactivity_rating": 2 + (day % 3),
            "impulsivity_rating": 2 + (day % 3),
            "emotion_rating": 3 + (day % 2),
            "task_completion_rating": 3 + (day % 2),
            "sleep_quality": "好" if day % 2 == 0 else "一般",
            "appetite_quality": "正常",
            "has_conflict": day == 5,
            "was_criticized": day == 5,
            "side_effects": None,
            "special_events": None,
            "highlights": None,
        })
    return logs


def _seed_scale(db, patient_id: int, scale_type: str, answers: list[int], respondent_type: str) -> None:
    if scale_type == "ASRS":
        sub_scores, radar_scores, risk_level = _asrs_scores(answers)
    else:
        sub_scores, radar_scores, risk_level = _snap_scores(answers)

    summary = _build_summary(scale_type, risk_level)
    recommendations = _build_recommendations(scale_type, risk_level)

    db.add(ScaleResult(
        patient_id=patient_id,
        scale_type=scale_type,
        score_json={
            "answers": answers,
            "respondent_type": respondent_type,
            "sub_scores": sub_scores,
            "radar_scores": radar_scores,
            "summary": summary,
            "recommendations": recommendations,
        },
        total_score=float(sum(answers)),
        risk_level=risk_level,
    ))


def _seed_cognitive(db, patient_id: int) -> None:
    tests = [
        ("reaction", {"avg_reaction_ms": 412.5, "correct_rate": 0.91}),
        ("stroop", {"total_trials": 24, "correct": 21, "wrong": 3}),
        ("trail", {"duration_s": 58.2, "errors": 2}),
        ("flanker", {"total_trials": 24, "correct": 20, "wrong": 4}),
        ("nback", {"n": 2, "accuracy": 0.78}),
        ("digit", {"max_span": 6}),
    ]
    for test_type, result_json in tests:
        db.add(CognitiveTest(patient_id=patient_id, test_type=test_type, result_json=result_json))


def _seed_imaging(db, patient_id: int, researcher_id: int) -> None:
    db.add(ImagingVisualization(
        patient_id=patient_id,
        researcher_id=researcher_id,
        visualization_type="nifti",
        func_file_name="func.nii.gz",
        anat_file_name="anat.nii.gz",
        summary_text="已完成 NIfTI 脑区剖面可视化，用于影像浏览与结构对照。",
        slice_interpretation="功能像与解剖像已配准，脑区剖面展示正常。",
    ))
    db.add(ImagingVisualization(
        patient_id=patient_id,
        researcher_id=researcher_id,
        visualization_type="gifti",
        left_func_file_name="lh.func.gii",
        right_func_file_name="rh.func.gii",
        summary_text="已完成 GIfTI 3D 脑表面可视化，完成左右半球功能-表面联合展示。",
        surface_interpretation="左右半球功能表面已加载，供复核。",
    ))


def _seed_prediction(db, patient_id: int, label: str) -> None:
    prob = 0.72 if label == "ADHD" else 0.24
    db.add(ModelPrediction(
        patient_id=patient_id,
        file_name="demo_fmri.1D",
        prediction_label=label,
        probability=prob,
        probability_control=round(1 - prob, 4),
        source_type="mock",
        roi_dim_used=90,
        timepoints=120,
        model_name="DemoMock",
        model_version="mock-2026-08",
        summary_text=f"演示数据：标签 {label}，ADHD 概率约 {prob:.2%}。",
    ))


def seed_demo_data() -> None:
    with SessionLocal() as db:
        doctor = db.query(User).filter(User.email == DOCTOR_EMAIL).one_or_none()
        if doctor is None:
            doctor = User(
                email=DOCTOR_EMAIL,
                full_name="演示医师",
                password_hash=get_password_hash(PASSWORD),
                role=UserRole.RESEARCHER,
                subrole=UserSubrole.NORMAL,
                consent_agreed=True,
                is_active=True,
            )
            db.add(doctor)
            db.flush()

        def ensure_patient(email: str, name: str, age: int, gender: str, ptype: PatientType) -> int:
            user = db.query(User).filter(User.email == email).one_or_none()
            if user is None:
                user = User(
                    email=email,
                    full_name=name,
                    password_hash=get_password_hash(PASSWORD),
                    role=UserRole.PATIENT,
                    consent_agreed=True,
                    is_active=True,
                )
                db.add(user)
                db.flush()

            patient = db.query(Patient).filter(Patient.user_id == user.id).one_or_none()
            if patient is None:
                patient = Patient(
                    user_id=user.id,
                    age=age,
                    gender=gender,
                    patient_type=ptype,
                    assigned_researcher_id=doctor.id,
                )
                db.add(patient)
                db.flush()
            else:
                patient.assigned_researcher_id = doctor.id
            return patient.id

        adult_id = ensure_patient(ADULT_EMAIL, "演示成人患者", 20, "male", PatientType.ADULT)
        child_id = ensure_patient(CHILD_EMAIL, "演示儿童患者", 9, "female", PatientType.CHILD)

        # 成人 ASRS 高风险（18 题，多数 3~4 分）
        _seed_scale(db, adult_id, "ASRS",
                    [3, 4, 3, 3, 4, 3, 3, 3, 4, 3, 3, 3, 4, 3, 4, 3, 3, 3],
                    "self")
        # 儿童 SNAP-IV 低风险（26 题，多数 0~1 分）
        _seed_scale(db, child_id, "SNAP_IV",
                    [1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1,
                     0, 0, 0, 1, 0, 0, 1, 0],
                    "parent")

        _seed_cognitive(db, adult_id)
        _seed_cognitive(db, child_id)

        for log in _tracking_logs():
            db.add(TrackingLog(patient_id=adult_id, **log))
            db.add(TrackingLog(patient_id=child_id, **log))

        _seed_imaging(db, adult_id, doctor.id)
        _seed_imaging(db, child_id, doctor.id)

        _seed_prediction(db, adult_id, "ADHD")
        _seed_prediction(db, child_id, "Control")

        db.commit()

    print("Seed demo data OK.")
    print(f"  {ADULT_EMAIL} / {PASSWORD}  (成人 ASRS 高风险)")
    print(f"  {CHILD_EMAIL} / {PASSWORD}  (儿童 SNAP-IV 低风险)")
    print(f"  {DOCTOR_EMAIL} / {PASSWORD}  (研究者)")


if __name__ == "__main__":
    seed_demo_data()
