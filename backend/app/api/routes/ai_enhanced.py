"""
AI赋能优化 - API路由

提供以下新API端点：
1. 自适应难度调整
2. 异常回答检测
3. 多模态分析
4. 智能预警
5. 干预方案管理
6. 自然语言查询
7. 智能提醒
8. 安全审计
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.api.deps import get_db, require_roles
from backend.app.models.user import User, UserRole
from backend.app.schemas.adaptive_assessment import (
    AdaptiveDifficultyResponse,
    AnomalyDetectionRequest,
    AnomalyDetectionResponse,
)
from backend.app.schemas.multimodal_analysis import (
    MultimodalInsightsResponse,
    TrendPredictionResponse,
    TrendPrediction as TrendPredictionOut,
)
from backend.app.schemas.smart_dashboard import (
    SmartDashboardResponse,
    PatientAlertResponse,
    PatientAlert,
)
from backend.app.schemas.intervention import (
    InterventionTask,
    InterventionPlanResponse,
    InterventionEffectResponse,
    PersonalizedMessageRequest,
    PersonalizedMessageResponse,
)
from backend.app.services.adaptive_assessment_service import (
    get_adaptive_difficulty_for_frontend,
    check_scale_anomalies,
    AdaptiveAssessmentService,
)
from backend.app.services.multimodal_analysis_service import (
    get_patient_insights_summary,
    MultimodalAnalysisService,
)
from backend.app.services.personalized_ai_service import (
    PersonalizedAIService,
    get_personalized_care_summary,
)
from backend.app.services.smart_dashboard_service import (
    get_smart_dashboard_data,
    SmartDashboardService,
)
from backend.app.services.intervention_service import (
    InterventionService,
    get_intervention_dashboard,
    InterventionType,
)
from backend.app.services.smart_reminder_service import SmartReminderService
from backend.app.services.natural_language_query_service import NaturalLanguageQueryService
from backend.app.services.enhanced_security_service import EnhancedSecurityService, AuditAction


router = APIRouter(prefix="/ai-enhanced", tags=["ai-enhanced"])


# =========================================================
# 1. 自适应评估路由
# =========================================================

@router.get("/patient/{patient_id}/adaptive_difficulty/{test_type}", response_model=AdaptiveDifficultyResponse)
def get_adaptive_difficulty(
    patient_id: int,
    test_type: str,
    current_user: User = Depends(require_roles(UserRole.PATIENT, UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> AdaptiveDifficultyResponse:
    """
    获取认知测试的自适应难度配置

    根据患者历史表现动态调整测试难度
    """
    # 权限检查
    if current_user.role == UserRole.PATIENT:
        from backend.app.models.patient import Patient
        patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
        if not patient or patient.id != patient_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="您只能访问自己的数据。",
            )

    try:
        difficulty_data = get_adaptive_difficulty_for_frontend(db, patient_id, test_type)
        return AdaptiveDifficultyResponse(**difficulty_data)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取自适应难度失败：{str(e)}",
        )


@router.post("/scale/anomaly_detection", response_model=AnomalyDetectionResponse)
def detect_scale_anomalies(
    request: AnomalyDetectionRequest,
    current_user: User = Depends(require_roles(UserRole.PATIENT, UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> AnomalyDetectionResponse:
    """
    检测量表回答中的异常模式

    自动识别矛盾作答、规律性作答、过快作答等异常
    """
    try:
        result = check_scale_anomalies(
            scale_type=request.scale_type,
            answers=request.answers,
            response_times=request.response_times,
        )
        return AnomalyDetectionResponse(**result)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"异常检测失败：{str(e)}",
        )


# =========================================================
# 2. 多模态分析路由
# =========================================================

@router.get("/patient/{patient_id}/multimodal_insights", response_model=MultimodalInsightsResponse)
def get_multimodal_insights(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> MultimodalInsightsResponse:
    """
    获取患者的多模态分析洞察

    包含跨维度关联、趋势预测、亚型分类
    """
    # 检查研究人员权限
    from backend.app.models.patient import Patient
    patient = db.get(Patient, patient_id)
    if not patient or patient.assigned_researcher_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该患者不属于当前研究人员。",
        )

    try:
        insights = get_patient_insights_summary(db, patient_id)
        return MultimodalInsightsResponse(**insights)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取多模态洞察失败：{str(e)}",
        )


@router.get("/patient/{patient_id}/trend_predictions", response_model=list[TrendPredictionResponse])
def get_trend_predictions(
    patient_id: int,
    forecast_days: int = 3,
    current_user: User = Depends(require_roles(UserRole.PATIENT, UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> list[TrendPredictionResponse]:
    """
    获取患者的情绪/专注度趋势预测

    基于历史数据预测未来趋势
    """
    # 权限检查
    if current_user.role == UserRole.PATIENT:
        from backend.app.models.patient import Patient
        patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
        if not patient or patient.id != patient_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="您只能访问自己的数据。",
            )

    try:
        service = MultimodalAnalysisService(db)
        predictions = service.predict_mood_focus_trends(patient_id, forecast_days)

        result = []
        for p in predictions:
            points = p.predictions or []
            first = float(points[0]["value"]) if points else 0.0
            last = float(points[-1]["value"]) if points else 0.0
            conf = (
                sum(float(pt.get("confidence", 0.5)) for pt in points) / len(points)
                if points
                else 0.5
            )
            result.append(
                TrendPredictionResponse(
                    patient_id=patient_id,
                    predictions=[
                        TrendPredictionOut(
                            metric=p.metric,
                            current_value=first,
                            predicted_value=last,
                            trend_direction=p.trend_direction,
                            confidence=min(1.0, max(0.0, conf)),
                            prediction_horizon_days=max(len(points), forecast_days),
                        )
                    ],
                    overall_trend=p.trend_direction,
                    recommendations=[p.recommendation] if p.recommendation else [],
                )
            )
        return result
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取趋势预测失败：{str(e)}",
        )


# =========================================================
# 3. 个性化AI助手路由
# =========================================================

@router.get("/patient/{patient_id}/care_alerts")
def get_care_alerts(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.PATIENT, UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> dict:
    """
    获取患者的关怀提醒

    检测是否需要主动关怀（连续低心情、专注度下降等）
    """
    # 权限检查
    if current_user.role == UserRole.PATIENT:
        from backend.app.models.patient import Patient
        patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
        if not patient or patient.id != patient_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="您只能访问自己的数据。",
            )

    try:
        service = PersonalizedAIService(db)
        alerts = service.check_care_alerts(patient_id)
        reminder = service.generate_personalized_reminder(patient_id)

        return {
            "patient_id": patient_id,
            "alerts": [
                {
                    "type": a.alert_type,
                    "priority": a.priority,
                    "message": a.message,
                    "suggested_actions": a.suggested_actions,
                    "tone": a.tone,
                }
                for a in alerts if a.should_alert
            ],
            "personalized_reminder": reminder,
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取关怀提醒失败：{str(e)}",
        )


@router.get("/researcher/patient_care_summary/{patient_id}")
def get_patient_care_summary(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> dict:
    """
    为研究人员提供患者的个性化关怀摘要
    """
    # 检查研究人员权限
    from backend.app.models.patient import Patient
    patient = db.get(Patient, patient_id)
    if not patient or patient.assigned_researcher_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该患者不属于当前研究人员。",
        )

    try:
        return get_personalized_care_summary(db, patient_id)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取关怀摘要失败：{str(e)}",
        )


# =========================================================
# 4. 智能预警仪表盘路由
# =========================================================

@router.get("/researcher/smart_dashboard", response_model=SmartDashboardResponse)
def get_smart_dashboard(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> SmartDashboardResponse:
    """
    获取研究人员的智能仪表盘

    包含预警列表、批量洞察、关键指标
    """
    try:
        data = get_smart_dashboard_data(db, current_user.id)
        summary = data.get("summary", {})
        alerts = data.get("alerts", [])

        return SmartDashboardResponse(
            total_patients=summary.get("patient_count", 0),
            active_patients=summary.get("active_tracking_count", 0),
            alerts_count=len(alerts),
            high_priority_alerts=sum(
                1 for a in alerts if a.get("severity") in ("critical", "warning")
            ),
            metrics=[
                {"name": "患者总数", "value": summary.get("patient_count", 0), "description": "负责的患者数量"},
                {"name": "高风险患者", "value": summary.get("high_risk_count", 0), "description": "存在高风险评分的患者"},
                {"name": "需关注患者", "value": summary.get("needs_attention_count", 0), "description": "有活跃预警的患者"},
                {"name": "活跃追踪", "value": summary.get("active_tracking_count", 0), "description": "近7天有记录的患者"},
                {"name": "已完成追踪", "value": summary.get("completed_tracking_count", 0), "description": "完成14天追踪的患者"},
                {"name": "本周报告", "value": summary.get("weekly_reports_count", 0), "description": "本周产生评估报告数"},
            ],
            recent_alerts=[
                PatientAlert(
                    patient_id=a.get("patient_id"),
                    patient_name=a.get("patient_name", ""),
                    alert_type=a.get("type", ""),
                    severity=a.get("severity", "low"),
                    message=a.get("title", ""),
                    recommended_action=a.get("suggested_action", ""),
                )
                for a in alerts[:5]
            ],
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取智能仪表盘失败：{str(e)}",
        )


@router.get("/researcher/patient_alerts", response_model=list[PatientAlertResponse])
def get_patient_alerts(
    lookback_days: int = 14,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> list[PatientAlertResponse]:
    """
    获取研究人员负责的患者预警列表

    按优先级排序
    """
    try:
        service = SmartDashboardService(db)
        alerts = service.get_patient_alerts(current_user.id, lookback_days)

        return [
            PatientAlertResponse(
                patient_id=a.patient_id,
                patient_name=a.patient_name,
                alert_type=a.alert_type,
                severity=a.severity,
                title=a.title,
                description=a.description,
                suggested_action=a.suggested_action,
                priority_score=a.priority_score,
            )
            for a in alerts
        ]
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取患者预警失败：{str(e)}",
        )


# =========================================================
# 5. 干预方案管理路由
# =========================================================

@router.get("/patient/{patient_id}/intervention_plans", response_model=list[InterventionPlanResponse])
def get_intervention_plans(
    patient_id: int,
    focus_area: str | None = None,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> list[InterventionPlanResponse]:
    """
    为患者生成个性化干预方案

    基于患者数据推荐适合的干预措施
    """
    # 检查研究人员权限
    from backend.app.models.patient import Patient
    patient = db.get(Patient, patient_id)
    if not patient or patient.assigned_researcher_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该患者不属于当前研究人员。",
        )

    try:
        from datetime import date, timedelta

        service = InterventionService(db)
        plans = service.generate_intervention_plan(patient_id, focus_area)

        result = []
        for plan in plans:
            start = date.today()
            result.append(
                InterventionPlanResponse(
                    patient_id=patient_id,
                    intervention_type=plan.intervention_type.value,
                    title=plan.title,
                    description=plan.description,
                    goals=plan.expected_outcome.split("；") if plan.expected_outcome else [],
                    tasks=[
                        InterventionTask(
                            title=t.get("title", ""),
                            description=t.get("description", ""),
                            task_type=plan.intervention_type.value,
                            estimated_minutes=int(t.get("duration_minutes", 15) or 15),
                        )
                        for t in (plan.daily_tasks or [])
                    ],
                    start_date=start.isoformat(),
                    end_date=(start + timedelta(days=plan.duration_days or 14)).isoformat(),
                )
            )
        return result
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"生成干预方案失败：{str(e)}",
        )


@router.get("/patient/{patient_id}/intervention_effect/{intervention_type}", response_model=InterventionEffectResponse)
def get_intervention_effect(
    patient_id: int,
    intervention_type: str,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> InterventionEffectResponse:
    """
    评估特定干预的效果

    对比执行前后的情绪和专注度变化
    """
    # 检查研究人员权限
    from backend.app.models.patient import Patient
    patient = db.get(Patient, patient_id)
    if not patient or patient.assigned_researcher_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该患者不属于当前研究人员。",
        )

    try:
        service = InterventionService(db)
        try:
            itype = InterventionType(intervention_type)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"无效的干预类型：{intervention_type}",
            )

        effect = service.evaluate_intervention_effect(patient_id, itype)

        return InterventionEffectResponse(
            patient_id=patient_id,
            plan_id=0,
            task_completion_rate=effect.adherence_rate,
            adherence_score=effect.adherence_rate,
            mood_change=effect.mood_change,
            focus_change=effect.focus_change,
            effectiveness_rating=(
                "high"
                if effect.effectiveness_score >= 0.6
                else "moderate"
                if effect.effectiveness_score >= 0.4
                else "low"
            ),
            insights=[],
            recommendations=[effect.recommendation] if effect.recommendation else [],
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"评估干预效果失败：{str(e)}",
        )


@router.get("/patient/{patient_id}/intervention_dashboard")
def get_patient_intervention_dashboard(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> dict:
    """
    获取患者干预仪表盘

    包含推荐方案和效果评估
    """
    # 检查研究人员权限
    from backend.app.models.patient import Patient
    patient = db.get(Patient, patient_id)
    if not patient or patient.assigned_researcher_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该患者不属于当前研究人员。",
        )

    try:
        return get_intervention_dashboard(db, patient_id)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取干预仪表盘失败：{str(e)}",
        )


@router.post("/researcher/send_message/{patient_id}", response_model=PersonalizedMessageResponse)
def send_personalized_message(
    patient_id: int,
    request: PersonalizedMessageRequest,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> PersonalizedMessageResponse:
    """
    研究人员向患者发送个性化消息

    支持鼓励、指导、关怀等多种消息类型
    """
    # 检查研究人员权限
    from backend.app.models.patient import Patient
    patient = db.get(Patient, patient_id)
    if not patient or patient.assigned_researcher_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该患者不属于当前研究人员。",
        )

    try:
        service = InterventionService(db)
        result = service.create_personalized_message(
            researcher_id=current_user.id,
            patient_id=patient_id,
            message_type=request.message_type,
            custom_content=request.content,
        )

        return PersonalizedMessageResponse(
            message_id=result.get("message_id"),
            patient_id=patient_id,
            sender_id=current_user.id,
            content=result.get("content", ""),
            message_type=request.message_type,
            tone=request.tone,
            sent_at=result.get("created_at") or datetime.now(timezone.utc).isoformat(),
            is_read=False,
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"发送消息失败：{str(e)}",
        )


# =========================================================
# 6. 智能提醒路由
# =========================================================

@router.get("/patient/{patient_id}/smart_reminder")
def get_smart_reminder(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> dict:
    """
    获取智能提醒

    基于患者行为模式生成个性化提醒
    """
    # 权限检查
    from backend.app.models.patient import Patient
    patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
    if not patient or patient.id != patient_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="您只能访问自己的数据。",
        )

    try:
        service = SmartReminderService(db)
        reminder = service.generate_smart_reminder(patient_id)
        rewards = service.get_streak_rewards(patient_id)
        weekly_summary = service.generate_weekly_summary(patient_id)

        return {
            "reminder": {
                "should_remind": reminder.should_remind,
                "reminder_type": reminder.reminder_type,
                "title": reminder.title,
                "message": reminder.message,
                "scheduled_time": reminder.scheduled_time.isoformat(),
                "priority": reminder.priority,
                "streak_info": reminder.streak_info,
            },
            "rewards": [
                {
                    "streak_days": r.streak_days,
                    "reward_type": r.reward_type,
                    "title": r.title,
                    "description": r.description,
                    "unlocked": r.unlocked,
                }
                for r in rewards
            ],
            "weekly_summary": weekly_summary,
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取智能提醒失败：{str(e)}",
        )


# =========================================================
# 7. 自然语言查询路由
# =========================================================

@router.post("/researcher/natural_language_query")
def natural_language_query(
    query_text: str,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> dict:
    """
    自然语言数据查询

    支持中文自然语言查询患者数据
    """
    try:
        service = NaturalLanguageQueryService(db)
        result = service.process_query(current_user.id, query_text)

        return {
            "success": result.success,
            "answer": result.answer,
            "data": result.data,
            "query_description": result.query_sql,
            "confidence": result.confidence,
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"查询处理失败：{str(e)}",
        )


# =========================================================
# 8. 安全审计路由
# =========================================================

@router.get("/researcher/audit_logs")
def get_audit_logs(
    patient_id: int | None = None,
    action: str | None = None,
    limit: int = 50,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> dict:
    """
    获取审计日志

    查看数据访问记录
    """
    try:
        service = EnhancedSecurityService(db)

        # 记录本次访问
        service.log_access(
            actor_user_id=current_user.id,
            actor_role=current_user.role.value,
            action=AuditAction.VIEW_DASHBOARD,
            resource_type="audit_logs",
            details={"query_params": {"patient_id": patient_id, "action": action, "limit": limit}},
        )

        # 获取审计日志
        audit_action = None
        if action:
            try:
                audit_action = AuditAction(action)
            except ValueError:
                pass

        logs = service.get_audit_logs(
            user_id=current_user.id,
            patient_id=patient_id,
            action=audit_action,
            limit=limit,
        )

        return {
            "logs": [
                {
                    "id": log.id,
                    "timestamp": log.timestamp.isoformat(),
                    "action": getattr(log.action, "value", log.action),
                    "resource_type": log.resource_type,
                    "resource_id": log.resource_id,
                    "patient_id": log.patient_id,
                    "details": log.details,
                }
                for log in logs
            ],
            "total": len(logs),
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取审计日志失败：{str(e)}",
        )


@router.get("/researcher/compliance_report")
def get_compliance_report(
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> dict:
    """
    获取合规报告

    包含知情同意状态、数据生命周期、访问统计
    """
    try:
        service = EnhancedSecurityService(db)
        report = service.generate_compliance_report(current_user.id)

        return {
            "report_date": report["report_date"].isoformat(),
            "total_patients": report["total_patients"],
            "consent_status": report["consent_status"],
            "data_status": report["data_status"],
            "access_statistics": report["access_statistics"],
            "compliance_score": report["compliance_score"],
            "recommendations": report["recommendations"],
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"获取合规报告失败：{str(e)}",
        )