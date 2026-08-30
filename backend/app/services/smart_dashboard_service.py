"""
智能预警仪表盘服务

为研究人员提供：
1. 患者风险预警排序
2. 依从性下降检测
3. 数据异常标记
4. 批量洞察生成
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
from sqlalchemy import select, func
from sqlalchemy.orm import Session


@dataclass
class PatientAlert:
    """患者预警"""

    patient_id: int
    patient_name: str
    alert_type: str  # "compliance_drop", "data_anomaly", "risk_increase", "streak_miss"
    severity: str  # "critical", "warning", "info"
    title: str
    description: str
    suggested_action: str
    priority_score: float  # 0-100，用于排序


@dataclass
class BatchInsight:
    """批量洞察"""

    insight_type: str
    title: str
    description: str
    affected_patients: list[int]
    count: int
    trend: str  # "increasing", "stable", "decreasing"


class SmartDashboardService:
    """智能预警仪表盘服务"""

    def __init__(self, db: Session):
        self.db = db

    # =========================================================
    # 1. 患者风险预警排序
    # =========================================================

    def get_patient_alerts(
        self,
        researcher_id: int,
        lookback_days: int = 14,
    ) -> list[PatientAlert]:
        """
        获取研究人员负责的所有患者的预警列表

        按优先级排序，帮助研究人员快速定位需要关注的患者
        """
        from backend.app.models.patient import Patient
        from backend.app.models.user import User

        # 获取研究人员负责的所有患者
        patients = self.db.scalars(
            select(Patient)
            .where(Patient.assigned_researcher_id == researcher_id)
            .order_by(Patient.created_at.desc())
        ).all()

        all_alerts = []

        for patient in patients:
            user = self.db.get(User, patient.user_id)
            patient_name = user.full_name if user else f"Patient #{patient.id}"

            # 检查各类预警
            compliance_alerts = self._check_compliance(patient.id, patient_name, lookback_days)
            anomaly_alerts = self._check_data_anomalies(patient.id, patient_name, lookback_days)
            risk_alerts = self._check_risk_increase(patient.id, patient_name, lookback_days)

            all_alerts.extend(compliance_alerts)
            all_alerts.extend(anomaly_alerts)
            all_alerts.extend(risk_alerts)

        # 按优先级排序
        all_alerts.sort(key=lambda a: a.priority_score, reverse=True)

        return all_alerts[:50]  # 返回前50个预警

    def _check_compliance(self, patient_id: int, patient_name: str, lookback_days: int) -> list[PatientAlert]:
        """检查依从性下降"""
        from backend.app.models.tracking_log import TrackingLog

        alerts = []
        cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

        # 获取追踪记录
        logs = self.db.scalars(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= cutoff,
            )
            .order_by(TrackingLog.created_at.asc())
        ).all()

        if not logs:
            # 完全没有记录
            alerts.append(
                PatientAlert(
                    patient_id=patient_id,
                    patient_name=patient_name,
                    alert_type="compliance_drop",
                    severity="critical",
                    title="完全未开始追踪",
                    description=f"{patient_name}在过去{lookback_days}天内没有任何追踪记录。",
                    suggested_action="建议主动联系患者，了解是否遇到使用困难。",
                    priority_score=90.0,
                )
            )
            return alerts

        # 检查连续漏填
        completed_days = {log.day_index for log in logs}
        current_day = max(completed_days) + 1 if completed_days else 1

        missed_streak = 0
        for day in range(min(current_day - 1, 14), 0, -1):
            if day in completed_days:
                break
            missed_streak += 1

        if missed_streak >= 3:
            severity = "critical" if missed_streak >= 5 else "warning"
            priority = 85.0 if missed_streak >= 5 else 70.0

            alerts.append(
                PatientAlert(
                    patient_id=patient_id,
                    patient_name=patient_name,
                    alert_type="streak_miss",
                    severity=severity,
                    title=f"连续{missed_streak}天未记录",
                    description=f"{patient_name}已连续{missed_streak}天未进行追踪记录。",
                    suggested_action="建议发送个性化提醒或安排随访。",
                    priority_score=priority,
                )
            )

        # 检查完成率下降
        expected_days = min(lookback_days, 14)
        actual_days = len(completed_days)
        completion_rate = actual_days / expected_days if expected_days > 0 else 0

        if completion_rate < 0.3:
            alerts.append(
                PatientAlert(
                    patient_id=patient_id,
                    patient_name=patient_name,
                    alert_type="compliance_drop",
                    severity="warning",
                    title=f"追踪完成率偏低（{completion_rate:.0%}）",
                    description=f"过去{lookback_days}天仅完成{actual_days}/{expected_days}天记录。",
                    suggested_action="评估是否存在使用障碍，考虑简化记录流程。",
                    priority_score=60.0,
                )
            )

        return alerts

    def _check_data_anomalies(self, patient_id: int, patient_name: str, lookback_days: int) -> list[PatientAlert]:
        """检查数据异常"""
        from backend.app.models.tracking_log import TrackingLog
        from backend.app.models.scale_result import ScaleResult

        alerts = []

        # 检查量表回答异常
        recent_scales = self.db.scalars(
            select(ScaleResult)
            .where(ScaleResult.patient_id == patient_id)
            .order_by(ScaleResult.created_at.desc())
            .limit(3)
        ).all()

        for scale in recent_scales:
            if scale.score_json:
                anomaly_indicators = scale.score_json.get("anomaly_indicators", [])
                if anomaly_indicators:
                    alerts.append(
                        PatientAlert(
                            patient_id=patient_id,
                            patient_name=patient_name,
                            alert_type="data_anomaly",
                            severity="warning",
                            title="量表回答存在异常模式",
                            description=f"{patient_name}的{scale.scale_type}量表检测到异常回答模式：{', '.join(anomaly_indicators[:2])}。",
                            suggested_action="建议复核该量表结果的有效性。",
                            priority_score=65.0,
                        )
                    )

        # 检查追踪数据异常（如专注时长异常高/低）
        logs = self.db.scalars(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= datetime.now(timezone.utc) - timedelta(days=lookback_days),
            )
        ).all()

        focus_values = [float(log.focus_minutes) for log in logs if log.focus_minutes is not None]

        if len(focus_values) >= 5:
            mean_focus = np.mean(focus_values)
            std_focus = np.std(focus_values)

            # 检测异常值（超过2个标准差）
            outliers = [f for f in focus_values if abs(f - mean_focus) > 2 * std_focus]
            if len(outliers) >= 2:
                alerts.append(
                    PatientAlert(
                        patient_id=patient_id,
                        patient_name=patient_name,
                        alert_type="data_anomaly",
                        severity="info",
                        title="专注时长数据波动较大",
                        description=f"{patient_name}的专注时长记录波动较大（标准差{std_focus:.1f}分钟），可能存在记录不准确的情况。",
                        suggested_action="建议与患者确认记录方式是否正确。",
                        priority_score=40.0,
                    )
                )

        return alerts

    def _check_risk_increase(self, patient_id: int, patient_name: str, lookback_days: int) -> list[PatientAlert]:
        """检查风险评分上升"""
        from backend.app.models.scale_result import ScaleResult

        alerts = []

        # 获取最近的量表结果
        recent_scales = self.db.scalars(
            select(ScaleResult)
            .where(ScaleResult.patient_id == patient_id)
            .order_by(ScaleResult.created_at.desc())
            .limit(5)
        ).all()

        if len(recent_scales) >= 2:
            latest = recent_scales[0]
            previous = recent_scales[1]

            if latest.total_score and previous.total_score:
                score_change = latest.total_score - previous.total_score
                change_rate = score_change / previous.total_score if previous.total_score > 0 else 0

                # 风险评分上升超过20%
                if change_rate > 0.2:
                    severity = "critical" if latest.risk_level == "high" else "warning"
                    priority = 80.0 if severity == "critical" else 65.0

                    alerts.append(
                        PatientAlert(
                            patient_id=patient_id,
                            patient_name=patient_name,
                            alert_type="risk_increase",
                            severity=severity,
                            title=f"量表风险评分上升{change_rate:.0%}",
                            description=f"{patient_name}的{latest.scale_type}评分从{previous.total_score}上升到{latest.total_score}。",
                            suggested_action="建议尽快安排专业评估或随访。",
                            priority_score=priority,
                        )
                    )

        return alerts

    # =========================================================
    # 2. 批量洞察生成
    # =========================================================

    def generate_batch_insights(self, researcher_id: int) -> list[BatchInsight]:
        """
        为研究人员生成批量洞察

        自动分析所有患者的数据模式，生成可操作的洞察
        """
        from backend.app.models.patient import Patient

        patients = self.db.scalars(
            select(Patient).where(Patient.assigned_researcher_id == researcher_id)
        ).all()

        patient_ids = [p.id for p in patients]

        if not patient_ids:
            return []

        insights = []

        # 1. 整体依从性趋势
        compliance_insight = self._analyze_overall_compliance(patient_ids)
        if compliance_insight:
            insights.append(compliance_insight)

        # 2. 高风险患者集中度
        risk_insight = self._analyze_risk_concentration(patient_ids)
        if risk_insight:
            insights.append(risk_insight)

        # 3. 认知测试完成情况
        cognitive_insight = self._analyze_cognitive_completion(patient_ids)
        if cognitive_insight:
            insights.append(cognitive_insight)

        # 4. 追踪完成进度
        tracking_insight = self._analyze_tracking_progress(patient_ids)
        if tracking_insight:
            insights.append(tracking_insight)

        return insights

    def _analyze_overall_compliance(self, patient_ids: list[int]) -> BatchInsight | None:
        """分析整体依从性"""
        from backend.app.models.tracking_log import TrackingLog

        cutoff = datetime.now(timezone.utc) - timedelta(days=7)

        # 统计过去7天有记录的患者数
        active_patients = self.db.scalars(
            select(TrackingLog.patient_id)
            .where(
                TrackingLog.patient_id.in_(patient_ids),
                TrackingLog.created_at >= cutoff,
            )
            .distinct()
        ).all()

        active_count = len(active_patients)
        total_count = len(patient_ids)
        active_rate = active_count / total_count if total_count > 0 else 0

        if active_rate < 0.5:
            return BatchInsight(
                insight_type="compliance",
                title="整体依从性偏低",
                description=f"过去7天仅{active_count}/{total_count}名患者有追踪记录（{active_rate:.0%}）。",
                affected_patients=[pid for pid in patient_ids if pid not in active_patients],
                count=total_count - active_count,
                trend="decreasing",
            )

        return None

    def _analyze_risk_concentration(self, patient_ids: list[int]) -> BatchInsight | None:
        """分析高风险患者集中度"""
        from backend.app.models.scale_result import ScaleResult

        # 获取每个患者最新的量表风险等级
        high_risk_patients = []

        for pid in patient_ids:
            latest_scale = self.db.scalar(
                select(ScaleResult)
                .where(ScaleResult.patient_id == pid)
                .order_by(ScaleResult.created_at.desc())
                .limit(1)
            )

            if latest_scale and latest_scale.risk_level == "high":
                high_risk_patients.append(pid)

        high_risk_rate = len(high_risk_patients) / len(patient_ids) if patient_ids else 0

        if high_risk_rate > 0.3:
            return BatchInsight(
                insight_type="risk",
                title="高风险患者占比较高",
                description=f"当前{len(high_risk_patients)}名患者（{high_risk_rate:.0%}）量表评估为高风险。",
                affected_patients=high_risk_patients,
                count=len(high_risk_patients),
                trend="stable",
            )

        return None

    def _analyze_cognitive_completion(self, patient_ids: list[int]) -> BatchInsight | None:
        """分析认知测试完成情况"""
        from backend.app.models.cognitive_test import CognitiveTest

        # 统计完成认知测试的患者数
        tested_patients = self.db.scalars(
            select(CognitiveTest.patient_id)
            .where(CognitiveTest.patient_id.in_(patient_ids))
            .distinct()
        ).all()

        tested_count = len(tested_patients)
        total_count = len(patient_ids)
        test_rate = tested_count / total_count if total_count > 0 else 0

        if test_rate < 0.6:
            return BatchInsight(
                insight_type="cognitive",
                title="认知测试完成率不足",
                description=f"仅{tested_count}/{total_count}名患者完成了认知测试（{test_rate:.0%}）。",
                affected_patients=[pid for pid in patient_ids if pid not in tested_patients],
                count=total_count - tested_count,
                trend="stable",
            )

        return None

    def _analyze_tracking_progress(self, patient_ids: list[int]) -> BatchInsight | None:
        """分析追踪完成进度"""
        from backend.app.models.tracking_log import TrackingLog

        # 统计完成14天追踪的患者数
        completed_patients = []

        for pid in patient_ids:
            completed_days = self.db.scalars(
                select(TrackingLog.day_index)
                .where(TrackingLog.patient_id == pid)
                .distinct()
            ).all()

            if len(completed_days) >= 14:
                completed_patients.append(pid)

        completed_count = len(completed_patients)
        total_count = len(patient_ids)
        completion_rate = completed_count / total_count if total_count > 0 else 0

        if completion_rate < 0.3:
            in_progress = total_count - completed_count
            return BatchInsight(
                insight_type="tracking",
                title="14天追踪完成率较低",
                description=f"仅{completed_count}/{total_count}名患者完成了14天追踪，{in_progress}名仍在进行中。",
                affected_patients=[pid for pid in patient_ids if pid not in completed_patients],
                count=in_progress,
                trend="stable",
            )

        return None

    # =========================================================
    # 3. 研究人员仪表盘统计
    # =========================================================

    def get_dashboard_summary(self, researcher_id: int) -> dict[str, Any]:
        """
        获取研究人员仪表盘摘要

        包含关键指标和预警统计
        """
        from backend.app.models.patient import Patient
        from backend.app.models.scale_result import ScaleResult
        from backend.app.models.tracking_log import TrackingLog

        # 患者总数
        patient_count = self.db.scalar(
            select(func.count(Patient.id)).where(Patient.assigned_researcher_id == researcher_id)
        ) or 0

        # 获取所有患者ID
        patient_ids = list(self.db.scalars(
            select(Patient.id).where(Patient.assigned_researcher_id == researcher_id)
        ))

        if not patient_ids:
            return {
                "patient_count": 0,
                "high_risk_count": 0,
                "needs_attention_count": 0,
                "active_tracking_count": 0,
                "completed_tracking_count": 0,
                "weekly_reports_count": 0,
                "top_alerts": [],
            }

        # 高风险患者数
        high_risk_count = 0
        for pid in patient_ids:
            latest_scale = self.db.scalar(
                select(ScaleResult)
                .where(ScaleResult.patient_id == pid)
                .order_by(ScaleResult.created_at.desc())
                .limit(1)
            )
            if latest_scale and latest_scale.risk_level == "high":
                high_risk_count += 1

        # 需要关注的患者（有活跃预警）
        alerts = self.get_patient_alerts(researcher_id, lookback_days=7)
        needs_attention = len(set(a.patient_id for a in alerts if a.severity in ("critical", "warning")))

        # 活跃追踪患者（过去7天有记录）
        cutoff = datetime.now(timezone.utc) - timedelta(days=7)
        active_tracking = len(
            self.db.scalars(
                select(TrackingLog.patient_id)
                .where(
                    TrackingLog.patient_id.in_(patient_ids),
                    TrackingLog.created_at >= cutoff,
                )
                .distinct()
            ).all()
        )

        # 完成追踪患者
        completed_tracking = 0
        for pid in patient_ids:
            completed_days = len(
                self.db.scalars(
                    select(TrackingLog.day_index)
                    .where(TrackingLog.patient_id == pid)
                    .distinct()
                ).all()
            )
            if completed_days >= 14:
                completed_tracking += 1

        # 本周报告数
        week_cutoff = datetime.now(timezone.utc) - timedelta(days=7)
        weekly_reports = self.db.scalar(
            select(func.count(ScaleResult.id))
            .where(
                ScaleResult.patient_id.in_(patient_ids),
                ScaleResult.created_at >= week_cutoff,
            )
        ) or 0

        return {
            "patient_count": patient_count,
            "high_risk_count": high_risk_count,
            "needs_attention_count": needs_attention,
            "active_tracking_count": active_tracking,
            "completed_tracking_count": completed_tracking,
            "weekly_reports_count": weekly_reports,
            "top_alerts": [
                {
                    "patient_name": a.patient_name,
                    "type": a.alert_type,
                    "severity": a.severity,
                    "title": a.title,
                }
                for a in alerts[:5]
            ],
        }


def get_smart_dashboard_data(db: Session, researcher_id: int) -> dict[str, Any]:
    """为研究人员提供智能仪表盘数据"""
    service = SmartDashboardService(db)

    return {
        "summary": service.get_dashboard_summary(researcher_id),
        "alerts": [
            {
                "patient_id": a.patient_id,
                "patient_name": a.patient_name,
                "type": a.alert_type,
                "severity": a.severity,
                "title": a.title,
                "description": a.description,
                "suggested_action": a.suggested_action,
                "priority_score": a.priority_score,
            }
            for a in service.get_patient_alerts(researcher_id)
        ],
        "insights": [
            {
                "type": i.insight_type,
                "title": i.title,
                "description": i.description,
                "affected_count": i.count,
                "trend": i.trend,
            }
            for i in service.generate_batch_insights(researcher_id)
        ],
    }
