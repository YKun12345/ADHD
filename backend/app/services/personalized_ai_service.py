"""
AI助手个性化对话升级服务

提供以下功能：
1. 个性化对话风格 - 根据患者年龄、文化程度调整语气和专业度
2. 主动关怀机制 - AI检测连续低心情记录时主动推送关怀
3. 智能提醒优化 - 基于患者行为模式推送个性化提醒
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session


@dataclass
class PersonalizationConfig:
    """个性化配置"""

    communication_style: str  # "child_friendly", "professional_gentle", "casual"
    vocabulary_level: str  # "simple", "moderate", "advanced"
    emoji_usage: bool
    sentence_length: str  # "short", "medium", "long"
    encouragement_frequency: str  # "high", "medium", "low"
    detail_level: str  # "brief", "moderate", "detailed"


@dataclass
class CareAlert:
    """关怀提醒"""

    should_alert: bool
    alert_type: str  # "mood_decline", "focus_drop", "streak_miss", "improvement"
    priority: str  # "high", "medium", "low"
    message: str
    suggested_actions: list[str]
    tone: str  # "empathetic", "encouraging", "celebratory"


class PersonalizedAIService:
    """AI助手个性化对话升级服务"""

    def __init__(self, db: Session):
        self.db = db

    # =========================================================
    # 1. 个性化对话风格适配
    # =========================================================

    def get_personalization_config(self, patient_id: int) -> PersonalizationConfig:
        """
        根据患者信息生成个性化配置

        考虑因素：
        - 年龄（儿童/青少年/成人）
        - 患者类型（自评/家长代评）
        - 历史互动模式
        """
        from backend.app.models.patient import Patient

        patient = self.db.get(Patient, patient_id)
        if not patient:
            return self._default_config()

        patient_type = patient.patient_type.value if patient.patient_type else "adult"
        age = patient.age

        # 根据患者类型和年龄确定风格
        if patient_type == "child" or (age and age < 12):
            return PersonalizationConfig(
                communication_style="child_friendly",
                vocabulary_level="simple",
                emoji_usage=True,
                sentence_length="short",
                encouragement_frequency="high",
                detail_level="brief",
            )
        elif patient_type == "adolescent" or (age and 12 <= age < 18):
            return PersonalizationConfig(
                communication_style="casual",
                vocabulary_level="moderate",
                emoji_usage=True,
                sentence_length="medium",
                encouragement_frequency="medium",
                detail_level="moderate",
            )
        else:
            return PersonalizationConfig(
                communication_style="professional_gentle",
                vocabulary_level="advanced",
                emoji_usage=False,
                sentence_length="medium",
                encouragement_frequency="low",
                detail_level="detailed",
            )

    def _default_config(self) -> PersonalizationConfig:
        """默认配置"""
        return PersonalizationConfig(
            communication_style="professional_gentle",
            vocabulary_level="moderate",
            emoji_usage=False,
            sentence_length="medium",
            encouragement_frequency="medium",
            detail_level="moderate",
        )

    def adapt_system_prompt(self, base_prompt: str, config: PersonalizationConfig) -> str:
        """
        根据个性化配置调整系统提示词
        """
        style_instructions = []

        # 沟通风格
        if config.communication_style == "child_friendly":
            style_instructions.extend([
                "使用适合儿童的简单语言，避免专业术语。",
                "可以用比喻和故事来解释概念。",
                "语气温暖、鼓励，像一个友善的大哥哥/大姐姐。",
            ])
        elif config.communication_style == "casual":
            style_instructions.extend([
                "使用轻松自然的对话语气，像朋友聊天。",
                "可以适当使用网络用语，但要积极正面。",
                "避免说教感，多用'我觉得''你可以试试'这样的表达。",
            ])
        else:  # professional_gentle
            style_instructions.extend([
                "使用专业但温和的语气，保持尊重和理解。",
                "可以使用专业术语，但要解释清楚。",
                "表达要准确、有条理，但不冷冰冰。",
            ])

        # 词汇和句子
        if config.vocabulary_level == "simple":
            style_instructions.append("使用日常口语词汇，避免书面语。")
        elif config.vocabulary_level == "advanced":
            style_instructions.append("可以使用更精确的词汇和完整句式。")

        # 表情符号
        if config.emoji_usage:
            style_instructions.append("适当使用表情符号增加亲和力，但不要过度。")
        else:
            style_instructions.append("不要使用表情符号。")

        # 鼓励频率
        if config.encouragement_frequency == "high":
            style_instructions.append("频繁给予正面鼓励和肯定。")
        elif config.encouragement_frequency == "low":
            style_instructions.append("保持客观中立，必要时才给予鼓励。")

        # 细节程度
        if config.detail_level == "brief":
            style_instructions.append("回答要简洁，控制在3句话以内。")
        elif config.detail_level == "detailed":
            style_instructions.append("可以提供更详细的解释和分析。")

        style_block = "\n".join(f"- {inst}" for inst in style_instructions)

        return f"{base_prompt}\n\n个性化风格指南：\n{style_block}"

    # =========================================================
    # 2. 主动关怀机制
    # =========================================================

    def check_care_alerts(self, patient_id: int) -> list[CareAlert]:
        """
        检测是否需要主动关怀

        检测条件：
        - 连续3天以上心情低落（≤2）
        - 专注时长持续下降
        - 连续漏填追踪
        - 显著改善（值得庆祝）
        """
        from backend.app.models.tracking_log import TrackingLog

        alerts = []

        # 获取最近14天追踪数据
        cutoff = datetime.now(timezone.utc) - timedelta(days=14)
        logs = self.db.scalars(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= cutoff,
            )
            .order_by(TrackingLog.created_at.asc())
        ).all()

        if not logs:
            return alerts

        # 1. 检测连续低心情
        mood_alert = self._check_mood_decline(logs)
        if mood_alert:
            alerts.append(mood_alert)

        # 2. 检测专注度下降
        focus_alert = self._check_focus_decline(logs)
        if focus_alert:
            alerts.append(focus_alert)

        # 3. 检测连续漏填
        streak_alert = self._check_streak_miss(logs)
        if streak_alert:
            alerts.append(streak_alert)

        # 4. 检测显著改善
        improvement_alert = self._check_improvement(logs)
        if improvement_alert:
            alerts.append(improvement_alert)

        return alerts

    def _check_mood_decline(self, logs: list) -> CareAlert | None:
        """检测连续低心情"""
        recent_logs = logs[-5:]  # 最近5条记录

        low_mood_count = 0
        for log in recent_logs:
            if log.mood_tag:
                try:
                    if float(log.mood_tag) <= 2:
                        low_mood_count += 1
                except (ValueError, TypeError):
                    pass

        if low_mood_count >= 3:
            return CareAlert(
                should_alert=True,
                alert_type="mood_decline",
                priority="high",
                message="检测到最近几天心情持续低落，想关心一下你最近怎么样了。",
                suggested_actions=[
                    "推荐尝试5分钟深呼吸或冥想练习",
                    "建议做一些轻松的户外活动，哪怕只是散步10分钟",
                    "如果持续感到不适，建议和信任的人聊聊",
                ],
                tone="empathetic",
            )

        return None

    def _check_focus_decline(self, logs: list) -> CareAlert | None:
        """检测专注度持续下降"""
        if len(logs) < 5:
            return None

        focus_values = []
        for log in logs[-7:]:  # 最近7条
            if log.focus_minutes is not None:
                try:
                    focus_values.append(float(log.focus_minutes))
                except (ValueError, TypeError):
                    pass

        if len(focus_values) < 3:
            return None

        # 检查是否持续下降
        if len(focus_values) >= 3:
            recent_avg = sum(focus_values[-3:]) / 3
            earlier_avg = sum(focus_values[:3]) / min(3, len(focus_values[:3]))

            if recent_avg < earlier_avg * 0.6:  # 下降超过40%
                return CareAlert(
                    should_alert=True,
                    alert_type="focus_drop",
                    priority="medium",
                    message="注意到你最近的专注时长有所下降，可能是时候调整一下节奏了。",
                    suggested_actions=[
                        "试试番茄工作法：专注25分钟，休息5分钟",
                        "检查一下最近的睡眠质量是否影响了专注力",
                        "可以把大任务拆分成小步骤，降低启动难度",
                    ],
                    tone="encouraging",
                )

        return None

    def _check_streak_miss(self, logs: list) -> CareAlert | None:
        """检测连续漏填"""
        if not logs:
            return None

        last_log = logs[-1]
        days_since_last = (datetime.now(timezone.utc) - last_log.created_at.replace(tzinfo=timezone.utc)).days

        if days_since_last >= 3:
            return CareAlert(
                should_alert=True,
                alert_type="streak_miss",
                priority="medium",
                message=f"已经{days_since_last}天没记录了，没关系，今天先补一条就好。",
                suggested_actions=[
                    "不用补很多天，先把今天的记上",
                    "设置一个每天固定时间的提醒",
                    "记录不用很详细，简单记一下心情和专注情况就够了",
                ],
                tone="empathetic",
            )

        return None

    def _check_improvement(self, logs: list) -> CareAlert | None:
        """检测显著改善（值得庆祝）"""
        if len(logs) < 7:
            return None

        recent_logs = logs[-7:]
        earlier_logs = logs[:7] if len(logs) >= 14 else logs[:len(logs)//2]

        # 计算心情趋势
        recent_moods = []
        earlier_moods = []

        for log in recent_logs:
            if log.mood_tag:
                try:
                    recent_moods.append(float(log.mood_tag))
                except (ValueError, TypeError):
                    pass

        for log in earlier_logs:
            if log.mood_tag:
                try:
                    earlier_moods.append(float(log.mood_tag))
                except (ValueError, TypeError):
                    pass

        if recent_moods and earlier_moods:
            recent_avg = sum(recent_moods) / len(recent_moods)
            earlier_avg = sum(earlier_moods) / len(earlier_moods)

            if recent_avg - earlier_avg >= 1.0:  # 心情提升1分以上
                return CareAlert(
                    should_alert=True,
                    alert_type="improvement",
                    priority="low",
                    message="最近心情状态有明显好转，继续保持！",
                    suggested_actions=[
                        "记录一下是什么让你感觉变好的",
                        "把有效的方法坚持下去",
                        "这种进步值得肯定，给自己一点奖励",
                    ],
                    tone="celebratory",
                )

        return None

    # =========================================================
    # 3. 个性化提醒生成
    # =========================================================

    def generate_personalized_reminder(
        self,
        patient_id: int,
        reminder_type: str = "tracking",
    ) -> dict[str, Any]:
        """
        生成个性化提醒

        基于患者的历史行为模式和当前状态
        """
        config = self.get_personalization_config(patient_id)
        alerts = self.check_care_alerts(patient_id)

        # 获取追踪状态
        from backend.app.models.tracking_log import TrackingLog

        logs = self.db.scalars(
            select(TrackingLog)
            .where(TrackingLog.patient_id == patient_id)
            .order_by(TrackingLog.created_at.desc())
            .limit(14)
        ).all()

        completed_days = len(set(log.day_index for log in logs))
        current_day = max((log.day_index for log in logs), default=0) + 1

        # 根据个性化配置生成提醒文案
        if config.communication_style == "child_friendly":
            title = self._child_friendly_title(completed_days, current_day, alerts)
            message = self._child_friendly_message(completed_days, current_day, alerts)
        elif config.communication_style == "casual":
            title = self._casual_title(completed_days, current_day, alerts)
            message = self._casual_message(completed_days, current_day, alerts)
        else:
            title = self._professional_title(completed_days, current_day, alerts)
            message = self._professional_message(completed_days, current_day, alerts)

        return {
            "title": title,
            "message": message,
            "has_care_alert": any(a.should_alert for a in alerts),
            "care_alerts": [
                {
                    "type": a.alert_type,
                    "message": a.message,
                    "actions": a.suggested_actions,
                }
                for a in alerts if a.should_alert
            ],
            "personalization": {
                "style": config.communication_style,
                "emoji_usage": config.emoji_usage,
            },
        }

    def _child_friendly_title(self, completed: int, current: int, alerts: list[CareAlert]) -> str:
        """儿童友好的标题"""
        if any(a.alert_type == "improvement" for a in alerts):
            return "太棒了！你最近表现很好！"
        elif completed == 0:
            return "今天是开始的第一天！"
        elif completed >= 14:
            return "你完成了全部记录，真厉害！"
        else:
            return f"今天是第{current}天，加油！"

    def _child_friendly_message(self, completed: int, current: int, alerts: list[CareAlert]) -> str:
        """儿童友好的消息"""
        mood_alert = next((a for a in alerts if a.alert_type == "mood_decline"), None)
        if mood_alert:
            return "最近是不是有点不开心？没关系，跟我们说说，或者画一幅画表达一下心情吧！"

        if completed == 0:
            return "先选一个今天的心情表情，再选一选今天做了什么，就完成啦！"
        elif completed < 7:
            return f"已经记录了{completed}天，继续加油，快完成一半啦！"
        else:
            return f"已经记录了{completed}天，还差{14-completed}天就完成啦！"

    def _casual_title(self, completed: int, current: int, alerts: list[CareAlert]) -> str:
        """轻松风格的标题"""
        if any(a.alert_type == "improvement" for a in alerts):
            return "最近状态不错哦"
        elif any(a.alert_type == "mood_decline" for a in alerts):
            return "最近还好吗？"
        elif completed >= 14:
            return "14天打卡完成！"
        else:
            return f"Day {current} 打卡"

    def _casual_message(self, completed: int, current: int, alerts: list[CareAlert]) -> str:
        """轻松风格的消息"""
        focus_alert = next((a for a in alerts if a.alert_type == "focus_drop"), None)
        if focus_alert:
            return "感觉最近专注时间有点短，是不是太累了？记得适当休息哦。"

        if completed == 0:
            return "花1分钟记一下今天的状态，顺便看看最近的进展。"
        elif completed < 7:
            return f"已经坚持了{completed}天，继续记录会让数据更有参考价值。"
        else:
            return f"还差{14-completed}天就完成啦，保持住！"

    def _professional_title(self, completed: int, current: int, alerts: list[CareAlert]) -> str:
        """专业风格的标题"""
        if any(a.alert_type == "improvement" for a in alerts):
            return "近期追踪数据显示积极趋势"
        elif any(a.alert_type == "mood_decline" for a in alerts):
            return "追踪提醒：近期情绪记录提示需要关注"
        elif completed >= 14:
            return "14天追踪已完成"
        else:
            return f"第{current}天追踪提醒"

    def _professional_message(self, completed: int, current: int, alerts: list[CareAlert]) -> str:
        """专业风格的消息"""
        streak_alert = next((a for a in alerts if a.alert_type == "streak_miss"), None)
        if streak_alert:
            days = (datetime.now(timezone.utc) - alerts[0].priority) if alerts else 3
            return f"已有数日未记录，建议尽快补充，连续记录有助于生成更准确的趋势分析。"

        if completed == 0:
            return "建议开始14天追踪，每日记录情绪和专注情况，为后续分析提供数据基础。"
        elif completed < 7:
            return f"已完成{completed}/14天，继续记录将有助于建立更完整的日常行为基线。"
        else:
            return f"已完成{completed}/14天，建议保持记录节奏直至完成全部周期。"


def get_personalized_care_summary(db: Session, patient_id: int) -> dict[str, Any]:
    """
    为研究人员提供患者的个性化关怀摘要

    帮助研究人员了解哪些患者需要额外关注
    """
    service = PersonalizedAIService(db)
    alerts = service.check_care_alerts(patient_id)
    config = service.get_personalization_config(patient_id)

    return {
        "patient_id": patient_id,
        "personalization_config": {
            "communication_style": config.communication_style,
            "vocabulary_level": config.vocabulary_level,
        },
        "active_alerts": [
            {
                "type": a.alert_type,
                "priority": a.priority,
                "message": a.message,
                "suggested_actions": a.suggested_actions,
            }
            for a in alerts if a.should_alert
        ],
        "needs_attention": any(a.priority == "high" for a in alerts),
    }
