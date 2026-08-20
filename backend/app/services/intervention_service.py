"""
干预闭环追踪系统

提供以下功能：
1. 干预方案数字化 - 将AI建议转化为可执行的每日任务
2. 干预效果评估 - 追踪执行后的行为/情绪变化
3. 医患异步沟通 - 研究人员可发送个性化消息/任务
4. 闭环反馈调整 - 基于效果动态调整干预方案
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any

import numpy as np
from sqlalchemy import select, func
from sqlalchemy.orm import Session


class InterventionType(str, Enum):
    MINDFULNESS = "mindfulness"  # 正念冥想
    PHYSICAL_ACTIVITY = "physical_activity"  # 体育活动
    COGNITIVE_TRAINING = "cognitive_training"  # 认知训练
    SLEEP_HYGIENE = "sleep_hygiene"  # 睡眠卫生
    SOCIAL_ENGAGEMENT = "social_engagement"  # 社交活动
    TASK_BREAKDOWN = "task_breakdown"  # 任务分解
    ENVIRONMENT_OPTIMIZATION = "environment_optimization"  # 环境优化
    MEDICATION_REMINDER = "medication_reminder"  # 用药提醒


class InterventionStatus(str, Enum):
    SUGGESTED = "suggested"  # AI建议
    ACCEPTED = "accepted"  # 患者接受
    IN_PROGRESS = "in_progress"  # 执行中
    COMPLETED = "completed"  # 已完成
    SKIPPED = "skipped"  # 跳过
    DISCONTINUED = "discontinued"  # 中止


@dataclass
class InterventionPlan:
    """干预方案"""

    intervention_type: InterventionType
    title: str
    description: str
    daily_tasks: list[dict[str, Any]]
    duration_days: int
    difficulty_level: str  # "easy", "moderate", "challenging"
    expected_outcome: str
    evidence_level: str  # "strong", "moderate", "preliminary"


@dataclass
class InterventionEffect:
    """干预效果评估"""

    intervention_type: InterventionType
    adherence_rate: float  # 依从率 0-1
    mood_change: float  # 心情变化
    focus_change: float  # 专注度变化
    effectiveness_score: float  # 综合效果分 0-1
    recommendation: str  # 继续/调整/停止


class InterventionService:
    """干预闭环追踪服务"""

    def __init__(self, db: Session):
        self.db = db

    # =========================================================
    # 1. 干预方案数字化
    # =========================================================

    def generate_intervention_plan(
        self,
        patient_id: int,
        focus_area: str | None = None,
    ) -> list[InterventionPlan]:
        """
        基于患者数据生成个性化干预方案

        参数：
        - patient_id: 患者ID
        - focus_area: 重点关注领域（如 "attention", "mood", "hyperactivity"）

        返回：
        - 推荐的干预方案列表
        """
        # 分析患者当前状态
        patient_profile = self._analyze_patient_profile(patient_id)

        # 根据主要问题推荐干预
        plans = []

        # 1. 如果情绪问题突出，推荐正念冥想
        if patient_profile.get("mood_risk", 0) > 0.6:
            plans.append(self._create_mindfulness_plan(patient_profile))

        # 2. 如果专注力问题突出，推荐认知训练
        if patient_profile.get("focus_risk", 0) > 0.6:
            plans.append(self._create_cognitive_training_plan(patient_profile))

        # 3. 如果睡眠问题存在，推荐睡眠卫生
        if patient_profile.get("sleep_issues", False):
            plans.append(self._create_sleep_hygiene_plan(patient_profile))

        # 4. 如果社交活动少，推荐社交参与
        if patient_profile.get("social_isolation", False):
            plans.append(self._create_social_engagement_plan(patient_profile))

        # 5. 如果任务启动困难，推荐任务分解
        if patient_profile.get("task_initiation_difficulty", False):
            plans.append(self._create_task_breakdown_plan(patient_profile))

        # 6. 体育活动总是推荐
        plans.append(self._create_physical_activity_plan(patient_profile))

        return plans[:4]  # 最多返回4个方案

    def _analyze_patient_profile(self, patient_id: int) -> dict[str, Any]:
        """分析患者当前状态"""
        from backend.app.models.scale_result import ScaleResult
        from backend.app.models.cognitive_test import CognitiveTest
        from backend.app.models.tracking_log import TrackingLog

        profile = {
            "mood_risk": 0.0,
            "focus_risk": 0.0,
            "sleep_issues": False,
            "social_isolation": False,
            "task_initiation_difficulty": False,
            "activity_level": "moderate",
        }

        # 分析追踪数据
        recent_logs = self.db.scalars(
            select(TrackingLog)
            .where(TrackingLog.patient_id == patient_id)
            .order_by(TrackingLog.created_at.desc())
            .limit(14)
        ).all()

        if recent_logs:
            # 心情风险
            mood_values = []
            focus_values = []
            activities = []

            for log in recent_logs:
                if log.mood_tag:
                    try:
                        mood_values.append(float(log.mood_tag))
                    except (ValueError, TypeError):
                        pass
                if log.focus_minutes is not None:
                    try:
                        focus_values.append(float(log.focus_minutes))
                    except (ValueError, TypeError):
                        pass
                if log.activities:
                    activities.extend(log.activities.split(","))

            if mood_values:
                avg_mood = np.mean(mood_values)
                profile["mood_risk"] = 1.0 - (avg_mood / 5.0)

            if focus_values:
                avg_focus = np.mean(focus_values)
                profile["focus_risk"] = 1.0 - min(1.0, avg_focus / 60.0)  # 60分钟为理想值

            # 活动分析
            activity_counts = {}
            for act in activities:
                act = act.strip()
                if act:
                    activity_counts[act] = activity_counts.get(act, 0) + 1

            # 检测睡眠问题
            if "睡眠" in activity_counts or "休息" in activity_counts:
                # 如果经常提到睡眠，可能有睡眠问题
                profile["sleep_issues"] = activity_counts.get("睡眠", 0) >= 2

            # 检测社交孤立
            social_activities = ["社交", "朋友", "聚会", "聊天"]
            social_count = sum(activity_counts.get(act, 0) for act in social_activities)
            profile["social_isolation"] = social_count < 2

            # 检测活动水平
            total_activities = sum(activity_counts.values())
            if total_activities < 5:
                profile["activity_level"] = "low"
            elif total_activities > 15:
                profile["activity_level"] = "high"

        # 分析量表数据
        latest_scale = self.db.scalar(
            select(ScaleResult)
            .where(ScaleResult.patient_id == patient_id)
            .order_by(ScaleResult.created_at.desc())
            .limit(1)
        )

        if latest_scale and latest_scale.score_json:
            radar_scores = latest_scale.score_json.get("radar_scores", {})
            if radar_scores.get("task_activation", 0) > 15:  # 高分表示困难
                profile["task_initiation_difficulty"] = True

        return profile

    def _create_mindfulness_plan(self, profile: dict) -> InterventionPlan:
        """创建正念冥想方案"""
        difficulty = "easy" if profile.get("mood_risk", 0) > 0.8 else "moderate"

        return InterventionPlan(
            intervention_type=InterventionType.MINDFULNESS,
            title="每日正念冥想练习",
            description="通过简短的正念练习，帮助调节情绪、减轻焦虑，提升自我觉察能力。",
            daily_tasks=[
                {
                    "title": "3分钟呼吸空间",
                    "description": "找一个安静的地方，闭眼专注呼吸3分钟，注意气息进出。",
                    "duration_minutes": 3,
                    "time_of_day": "morning",
                },
                {
                    "title": "身体扫描",
                    "description": "从头到脚逐步关注身体各部位的感觉，释放紧张。",
                    "duration_minutes": 5,
                    "time_of_day": "evening",
                },
                {
                    "title": "情绪觉察日记",
                    "description": "记录今天的情绪变化，不做评判，只是观察。",
                    "duration_minutes": 2,
                    "time_of_day": "night",
                },
            ],
            duration_days=14,
            difficulty_level=difficulty,
            expected_outcome="情绪稳定性提升，焦虑感降低，自我调节能力增强",
            evidence_level="strong",
        )

    def _create_cognitive_training_plan(self, profile: dict) -> InterventionPlan:
        """创建认知训练方案"""
        return InterventionPlan(
            intervention_type=InterventionType.COGNITIVE_TRAINING,
            title="注意力与工作记忆训练",
            description="通过游戏化的认知练习，逐步提升注意力控制和工作记忆能力。",
            daily_tasks=[
                {
                    "title": "专注力热身",
                    "description": "进行5分钟的简单注意力集中练习，如数呼吸或观察物体。",
                    "duration_minutes": 5,
                    "time_of_day": "morning",
                },
                {
                    "title": "N-Back训练",
                    "description": "完成一轮N-Back工作记忆训练，挑战自己的记忆极限。",
                    "duration_minutes": 10,
                    "time_of_day": "afternoon",
                },
                {
                    "title": "任务切换练习",
                    "description": "进行Stroop或Flanker任务，练习注意力切换和抑制控制。",
                    "duration_minutes": 8,
                    "time_of_day": "evening",
                },
            ],
            duration_days=21,
            difficulty_level="moderate",
            expected_outcome="注意力持续时间增加，工作记忆容量提升，任务切换更灵活",
            evidence_level="strong",
        )

    def _create_sleep_hygiene_plan(self, profile: dict) -> InterventionPlan:
        """创建睡眠卫生方案"""
        return InterventionPlan(
            intervention_type=InterventionType.SLEEP_HYGIENE,
            title="睡眠质量优化计划",
            description="通过建立规律的睡眠习惯和环境优化，改善睡眠质量。",
            daily_tasks=[
                {
                    "title": "固定就寝时间",
                    "description": "每天在同一时间准备睡觉，误差不超过30分钟。",
                    "duration_minutes": 0,
                    "time_of_day": "night",
                },
                {
                    "title": "睡前放松仪式",
                    "description": "睡前30分钟停止使用电子设备，进行轻度阅读或伸展。",
                    "duration_minutes": 15,
                    "time_of_day": "night",
                },
                {
                    "title": "睡眠环境检查",
                    "description": "确保卧室安静、黑暗、温度适宜。",
                    "duration_minutes": 2,
                    "time_of_day": "night",
                },
            ],
            duration_days=14,
            difficulty_level="easy",
            expected_outcome="入睡时间缩短，睡眠质量提升，日间精力改善",
            evidence_level="strong",
        )

    def _create_social_engagement_plan(self, profile: dict) -> InterventionPlan:
        """创建社交参与方案"""
        return InterventionPlan(
            intervention_type=InterventionType.SOCIAL_ENGAGEMENT,
            title="社交活动参与计划",
            description="逐步增加社交互动，建立支持网络，减少孤立感。",
            daily_tasks=[
                {
                    "title": "主动问候",
                    "description": "每天主动向至少1个人打招呼或发送问候消息。",
                    "duration_minutes": 2,
                    "time_of_day": "morning",
                },
                {
                    "title": "社交活动",
                    "description": "每周参加至少2次社交活动，可以是线上或线下。",
                    "duration_minutes": 30,
                    "time_of_day": "afternoon",
                },
                {
                    "title": "分享今日亮点",
                    "description": "和朋友或家人分享今天的一件有趣或开心的事。",
                    "duration_minutes": 5,
                    "time_of_day": "evening",
                },
            ],
            duration_days=14,
            difficulty_level="moderate",
            expected_outcome="社交互动增加，支持网络建立，情绪状态改善",
            evidence_level="moderate",
        )

    def _create_task_breakdown_plan(self, profile: dict) -> InterventionPlan:
        """创建任务分解方案"""
        return InterventionPlan(
            intervention_type=InterventionType.TASK_BREAKDOWN,
            title="任务分解与启动训练",
            description="学习将大任务拆解为小步骤，降低启动难度，提升完成率。",
            daily_tasks=[
                {
                    "title": "任务清单整理",
                    "description": "列出今天要做的3件事，每件不超过30分钟。",
                    "duration_minutes": 5,
                    "time_of_day": "morning",
                },
                {
                    "title": "2分钟启动规则",
                    "description": "对任何任务，先做2分钟，降低心理阻力。",
                    "duration_minutes": 2,
                    "time_of_day": "anytime",
                },
                {
                    "title": "完成回顾",
                    "description": "回顾今天完成的任务，记录成就感。",
                    "duration_minutes": 3,
                    "time_of_day": "evening",
                },
            ],
            duration_days=14,
            difficulty_level="easy",
            expected_outcome="任务启动更容易，完成率提升，拖延减少",
            evidence_level="moderate",
        )

    def _create_physical_activity_plan(self, profile: dict) -> InterventionPlan:
        """创建体育活动方案"""
        activity_level = profile.get("activity_level", "moderate")

        if activity_level == "low":
            duration = 10
            difficulty = "easy"
        elif activity_level == "high":
            duration = 30
            difficulty = "challenging"
        else:
            duration = 20
            difficulty = "moderate"

        return InterventionPlan(
            intervention_type=InterventionType.PHYSICAL_ACTIVITY,
            title="每日体育活动",
            description="规律的身体活动有助于提升注意力、改善情绪，对ADHD症状有积极影响。",
            daily_tasks=[
                {
                    "title": "晨间伸展",
                    "description": "进行5分钟的简单伸展运动，唤醒身体。",
                    "duration_minutes": 5,
                    "time_of_day": "morning",
                },
                {
                    "title": "主要运动",
                    "description": f"进行{duration}分钟的有氧运动，如快走、跑步、游泳或骑车。",
                    "duration_minutes": duration,
                    "time_of_day": "afternoon",
                },
                {
                    "title": "活动记录",
                    "description": "记录今天的运动类型和时长，感受运动后的状态变化。",
                    "duration_minutes": 2,
                    "time_of_day": "evening",
                },
            ],
            duration_days=14,
            difficulty_level=difficulty,
            expected_outcome="注意力提升，情绪改善，精力增加，睡眠质量改善",
            evidence_level="strong",
        )

    # =========================================================
    # 2. 干预效果评估
    # =========================================================

    def evaluate_intervention_effect(
        self,
        patient_id: int,
        intervention_type: InterventionType,
        lookback_days: int = 14,
    ) -> InterventionEffect:
        """
        评估特定干预的效果

        通过对比执行干预前后的心情和专注度变化
        """
        from backend.app.models.tracking_log import TrackingLog
        from backend.app.models.patient_task import PatientTask

        # 获取干预执行情况
        intervention_tasks = self.db.scalars(
            select(PatientTask)
            .where(
                PatientTask.patient_id == patient_id,
                PatientTask.task_type == intervention_type.value,
                PatientTask.status == "completed",
            )
            .order_by(PatientTask.created_at.desc())
            .limit(lookback_days)
        ).all()

        total_tasks = len(intervention_tasks)
        completed_tasks = sum(1 for t in intervention_tasks if t.status == "completed")
        adherence_rate = completed_tasks / total_tasks if total_tasks > 0 else 0

        # 获取干预前后的情绪和专注度数据
        cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
        logs = self.db.scalars(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= cutoff,
            )
            .order_by(TrackingLog.created_at.asc())
        ).all()

        mood_change = 0.0
        focus_change = 0.0

        if len(logs) >= 7:
            # 分为前半段和后半段
            mid = len(logs) // 2
            early_logs = logs[:mid]
            late_logs = logs[mid:]

            early_mood = [
                float(log.mood_tag)
                for log in early_logs
                if log.mood_tag and log.mood_tag.isdigit()
            ]
            late_mood = [
                float(log.mood_tag)
                for log in late_logs
                if log.mood_tag and log.mood_tag.isdigit()
            ]

            early_focus = [
                float(log.focus_minutes)
                for log in early_logs
                if log.focus_minutes is not None
            ]
            late_focus = [
                float(log.focus_minutes)
                for log in late_logs
                if log.focus_minutes is not None
            ]

            if early_mood and late_mood:
                mood_change = np.mean(late_mood) - np.mean(early_mood)

            if early_focus and late_focus:
                focus_change = np.mean(late_focus) - np.mean(early_focus)

        # 计算综合效果分
        effectiveness_score = (
            adherence_rate * 0.3
            + max(0, mood_change / 4.0) * 0.35  # 心情提升贡献
            + max(0, focus_change / 60.0) * 0.35  # 专注度提升贡献
        )

        # 生成建议
        if effectiveness_score > 0.6 and adherence_rate > 0.7:
            recommendation = "效果良好，建议继续执行当前方案。"
        elif effectiveness_score > 0.4:
            recommendation = "有一定效果，建议微调方案后继续。"
        elif adherence_rate < 0.5:
            recommendation = "依从性不足，建议降低难度或简化任务。"
        else:
            recommendation = "效果不明显，建议更换干预方案。"

        return InterventionEffect(
            intervention_type=intervention_type,
            adherence_rate=adherence_rate,
            mood_change=mood_change,
            focus_change=focus_change,
            effectiveness_score=effectiveness_score,
            recommendation=recommendation,
        )

    # =========================================================
    # 3. 医患异步沟通
    # =========================================================

    def create_personalized_message(
        self,
        researcher_id: int,
        patient_id: int,
        message_type: str,  # "encouragement", "instruction", "check_in", "intervention_update"
        custom_content: str | None = None,
    ) -> dict[str, Any]:
        """
        研究人员为患者创建个性化消息

        支持多种消息类型，自动生成或自定义内容
        """
        from backend.app.models.patient import Patient
        from backend.app.models.user import User

        patient = self.db.get(Patient, patient_id)
        if not patient:
            raise ValueError("Patient not found")

        user = self.db.get(User, patient.user_id)
        patient_name = user.full_name if user else "患者"

        # 获取患者当前状态
        profile = self._analyze_patient_profile(patient_id)

        # 根据消息类型生成内容
        if custom_content:
            content = custom_content
        else:
            content = self._generate_message_content(message_type, patient_name, profile)

        # 创建消息记录
        from backend.app.models.patient_task import PatientTask

        message_task = PatientTask(
            patient_id=patient_id,
            researcher_id=researcher_id,
            task_type="message",
            title=f"来自研究人员的消息：{message_type}",
            description=content,
            status="pending",
        )

        self.db.add(message_task)
        self.db.commit()
        self.db.refresh(message_task)

        return {
            "message_id": message_task.id,
            "patient_id": patient_id,
            "patient_name": patient_name,
            "type": message_type,
            "content": content,
            "created_at": message_task.created_at.isoformat() if message_task.created_at else None,
        }

    def _generate_message_content(
        self, message_type: str, patient_name: str, profile: dict
    ) -> str:
        """根据消息类型生成内容"""
        if message_type == "encouragement":
            if profile.get("mood_risk", 0) > 0.6:
                return f"{patient_name}，最近注意到你可能有些疲惫，想让你知道你的努力我们都看到了。继续保持，每一步都很重要。"
            else:
                return f"{patient_name}，你的追踪记录一直很稳定，这种坚持非常棒！继续保持这种节奏。"

        elif message_type == "check_in":
            return f"{patient_name}，想关心一下你最近怎么样了。如果有什么困难或需要帮助的地方，随时告诉我们。"

        elif message_type == "instruction":
            return f"{patient_name}，根据你最近的数据，我为你准备了一些新的练习建议。请查看任务列表，选择适合你的开始执行。"

        elif message_type == "intervention_update":
            return f"{patient_name}，你最近的干预练习完成得很好！根据效果评估，建议继续当前方案，同时可以尝试增加一些变化。"

        else:
            return f"{patient_name}，希望你一切都好。记得按时记录，这对我们的分析很重要。"

    # =========================================================
    # 4. 闭环反馈调整
    # =========================================================

    def get_intervention_recommendations(
        self,
        patient_id: int,
    ) -> dict[str, Any]:
        """
        基于干预效果动态调整方案

        返回当前干预的效果评估和调整建议
        """
        # 评估各类干预效果
        effects = []
        for intervention_type in InterventionType:
            effect = self.evaluate_intervention_effect(patient_id, intervention_type)
            if effect.adherence_rate > 0 or effect.effectiveness_score > 0:
                effects.append(effect)

        # 排序：效果好的优先
        effects.sort(key=lambda e: e.effectiveness_score, reverse=True)

        # 生成调整建议
        recommendations = []

        for effect in effects[:3]:
            recommendations.append({
                "intervention_type": effect.intervention_type.value,
                "adherence_rate": f"{effect.adherence_rate:.0%}",
                "effectiveness_score": f"{effect.effectiveness_score:.2f}",
                "mood_change": f"{effect.mood_change:+.1f}",
                "focus_change": f"{effect.focus_change:+.0f}分钟",
                "recommendation": effect.recommendation,
            })

        # 如果没有有效干预，推荐新方案
        if not recommendations:
            plans = self.generate_intervention_plan(patient_id)
            recommendations = [
                {
                    "intervention_type": plan.intervention_type.value,
                    "title": plan.title,
                    "description": plan.description,
                    "evidence_level": plan.evidence_level,
                    "action": "建议开始新的干预方案",
                }
                for plan in plans[:2]
            ]

        return {
            "patient_id": patient_id,
            "current_effects": recommendations,
            "overall_trend": self._compute_overall_trend(patient_id),
        }

    def _compute_overall_trend(self, patient_id: int) -> str:
        """计算整体干预趋势"""
        from backend.app.models.tracking_log import TrackingLog

        logs = self.db.scalars(
            select(TrackingLog)
            .where(TrackingLog.patient_id == patient_id)
            .order_by(TrackingLog.created_at.desc())
            .limit(14)
        ).all()

        if len(logs) < 7:
            return "数据不足"

        mood_values = [
            float(log.mood_tag)
            for log in logs
            if log.mood_tag and log.mood_tag.isdigit()
        ]

        if len(mood_values) < 5:
            return "数据不足"

        # 计算趋势
        x = np.arange(len(mood_values))
        coeffs = np.polyfit(x, mood_values, 1)
        slope = coeffs[0]

        if slope > 0.1:
            return "情绪呈上升趋势，干预可能有效"
        elif slope < -0.1:
            return "情绪呈下降趋势，建议调整干预方案"
        else:
            return "情绪状态稳定"


def get_intervention_dashboard(db: Session, patient_id: int) -> dict[str, Any]:
    """为研究人员提供患者干预仪表盘"""
    service = InterventionService(db)

    # 生成干预方案
    plans = service.generate_intervention_plan(patient_id)

    # 获取效果评估
    recommendations = service.get_intervention_recommendations(patient_id)

    return {
        "patient_id": patient_id,
        "recommended_plans": [
            {
                "type": plan.intervention_type.value,
                "title": plan.title,
                "description": plan.description,
                "duration_days": plan.duration_days,
                "difficulty": plan.difficulty_level,
                "evidence_level": plan.evidence_level,
                "daily_tasks": plan.daily_tasks,
            }
            for plan in plans
        ],
        "effectiveness": recommendations,
    }
