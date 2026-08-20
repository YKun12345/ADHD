"""
智能打卡提醒系统

实现基于AI的个性化打卡提醒功能：
1. 学习患者最佳记录时段
2. 在"容易忘记"的时间点推送个性化提醒
3. 基于历史行为模式优化提醒时机
4. 连续打卡奖励机制
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session


@dataclass
class ReminderTiming:
    """提醒时机建议"""
    optimal_hour: int  # 最佳提醒小时(0-23)
    confidence: float  # 置信度 0-1
    reason: str  # 推荐理由
    backup_hours: list[int]  # 备选提醒时间


@dataclass
class SmartReminder:
    """智能提醒"""
    should_remind: bool
    reminder_type: str  # "optimal_time", "streak_risk", "completion_push"
    title: str
    message: str
    scheduled_time: datetime
    priority: int  # 1-5，5最高
    streak_info: dict[str, Any] | None = None


@dataclass
class StreakReward:
    """连续打卡奖励"""
    streak_days: int
    reward_type: str  # "insight", "deep_analysis", "badge"
    title: str
    description: str
    unlocked: bool


class SmartReminderService:
    """智能打卡提醒服务"""

    # 连续打卡奖励配置
    STREAK_REWARDS = {
        3: StreakReward(
            streak_days=3,
            reward_type="badge",
            title="初学者徽章",
            description="连续记录3天，养成好习惯的开始！",
            unlocked=True,
        ),
        7: StreakReward(
            streak_days=7,
            reward_type="insight",
            title="一周洞察报告",
            description="解锁专属的一周行为模式分析报告",
            unlocked=True,
        ),
        14: StreakReward(
            streak_days=14,
            reward_type="deep_analysis",
            title="深度分析解锁",
            description="完成14天追踪，解锁AI深度分析功能",
            unlocked=True,
        ),
        21: StreakReward(
            streak_days=21,
            reward_type="badge",
            title="习惯养成者徽章",
            description="连续记录21天，习惯已经形成！",
            unlocked=True,
        ),
        30: StreakReward(
            streak_days=30,
            reward_type="insight",
            title="月度趋势报告",
            description="解锁完整的月度趋势分析和个性化建议",
            unlocked=True,
        ),
    }

    def __init__(self, db: Session):
        self.db = db

    def analyze_optimal_reminder_time(
        self,
        patient_id: int,
        lookback_days: int = 30,
    ) -> ReminderTiming:
        """
        分析患者的最佳提醒时间

        基于历史记录时间，找出患者最活跃的记录时段
        """
        from backend.app.models.tracking_log import TrackingLog

        cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
        logs = self.db.scalars(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= cutoff,
            )
            .order_by(TrackingLog.created_at.asc())
        ).all()

        if not logs:
            # 无历史数据时返回默认建议
            return ReminderTiming(
                optimal_hour=20,  # 晚上8点
                confidence=0.3,
                reason="暂无历史数据，建议晚上记录当天情况",
                backup_hours=[12, 21],
            )

        # 统计各小时的记录频率
        hour_counts = Counter()
        for log in logs:
            hour = log.created_at.hour
            hour_counts[hour] += 1

        # 找出最活跃的时段
        if hour_counts:
            # 按频率排序
            sorted_hours = sorted(hour_counts.items(), key=lambda x: x[1], reverse=True)

            optimal_hour = sorted_hours[0][0]
            total_records = sum(hour_counts.values())
            optimal_ratio = sorted_hours[0][1] / total_records

            # 计算置信度
            confidence = min(1.0, optimal_ratio * 2 + len(logs) / 30)

            # 生成推荐理由
            if 6 <= optimal_hour <= 11:
                time_desc = "上午"
            elif 12 <= optimal_hour <= 17:
                time_desc = "下午"
            elif 18 <= optimal_hour <= 22:
                time_desc = "晚上"
            else:
                time_desc = "深夜"

            reason = f"您通常在{time_desc}（{optimal_hour}:00左右）记录最活跃"

            # 备选时间（次活跃时段）
            backup_hours = [h for h, _ in sorted_hours[1:4]]

            return ReminderTiming(
                optimal_hour=optimal_hour,
                confidence=confidence,
                reason=reason,
                backup_hours=backup_hours,
            )

        return ReminderTiming(
            optimal_hour=20,
            confidence=0.3,
            reason="分析数据不足，使用默认建议时间",
            backup_hours=[12, 21],
        )

    def generate_smart_reminder(
        self,
        patient_id: int,
        current_time: datetime | None = None,
    ) -> SmartReminder:
        """
        生成智能提醒

        综合考虑：
        1. 最佳记录时间
        2. 当前连续打卡状态
        3. 最近的记录情况
        4. 是否需要推送奖励
        """
        if current_time is None:
            current_time = datetime.now(timezone.utc)

        # 获取最佳提醒时间
        timing = self.analyze_optimal_reminder_time(patient_id)

        # 获取当前打卡状态
        streak_info = self._get_streak_status(patient_id)

        # 判断是否需要提醒
        should_remind, reminder_type = self._should_remind_now(
            patient_id, current_time, timing, streak_info
        )

        if not should_remind:
            return SmartReminder(
                should_remind=False,
                reminder_type="none",
                title="",
                message="",
                scheduled_time=current_time,
                priority=0,
                streak_info=streak_info,
            )

        # 生成个性化提醒内容
        title, message, priority = self._generate_reminder_content(
            reminder_type, timing, streak_info
        )

        # 计划提醒时间
        scheduled_time = self._calculate_scheduled_time(current_time, timing)

        return SmartReminder(
            should_remind=True,
            reminder_type=reminder_type,
            title=title,
            message=message,
            scheduled_time=scheduled_time,
            priority=priority,
            streak_info=streak_info,
        )

    def _get_streak_status(self, patient_id: int) -> dict[str, Any]:
        """获取连续打卡状态"""
        from backend.app.models.tracking_log import TrackingLog

        # 获取最近30天的记录
        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        logs = self.db.scalars(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= cutoff,
            )
            .order_by(TrackingLog.created_at.desc())
        ).all()

        if not logs:
            return {
                "current_streak": 0,
                "longest_streak": 0,
                "total_days": 0,
                "consecutive_missed": 0,
                "completion_rate": 0.0,
                "next_reward": None,
            }

        # 计算连续打卡天数
        completed_days = sorted({log.day_index for log in logs}, reverse=True)
        current_streak = 0
        consecutive_missed = 0

        # 从最新一天往前计算连续打卡
        if completed_days:
            expected_day = max(completed_days)
            for day in range(expected_day, 0, -1):
                if day in completed_days:
                    current_streak += 1
                else:
                    break

        # 计算连续漏填天数
        current_day = max(completed_days) + 1 if completed_days else 1
        for day in range(current_day - 1, 0, -1):
            if day in completed_days:
                break
            consecutive_missed += 1

        # 计算最长连续打卡
        longest_streak = self._calculate_longest_streak(completed_days)

        # 计算完成率
        expected_days = min(30, current_day - 1)
        completion_rate = len(completed_days) / max(expected_days, 1)

        # 查找下一个奖励
        next_reward = None
        for days in sorted(self.STREAK_REWARDS.keys()):
            if current_streak < days:
                next_reward = {
                    "days_needed": days - current_streak,
                    "reward": self.STREAK_REWARDS[days],
                }
                break

        return {
            "current_streak": current_streak,
            "longest_streak": longest_streak,
            "total_days": len(completed_days),
            "consecutive_missed": consecutive_missed,
            "completion_rate": completion_rate,
            "next_reward": next_reward,
        }

    def _calculate_longest_streak(self, completed_days: list[int]) -> int:
        """计算最长连续打卡天数"""
        if not completed_days:
            return 0

        sorted_days = sorted(completed_days)
        longest = 1
        current = 1

        for i in range(1, len(sorted_days)):
            if sorted_days[i] == sorted_days[i-1] + 1:
                current += 1
                longest = max(longest, current)
            else:
                current = 1

        return longest

    def _should_remind_now(
        self,
        patient_id: int,
        current_time: datetime,
        timing: ReminderTiming,
        streak_info: dict[str, Any],
    ) -> tuple[bool, str]:
        """判断当前是否应该提醒"""
        current_hour = current_time.hour

        # 检查今天是否已经记录
        today_logs = self._get_today_records(patient_id)
        if today_logs > 0:
            return False, "none"

        # 规则1：连续漏填3天以上，高优先级提醒
        if streak_info["consecutive_missed"] >= 3:
            return True, "streak_risk"

        # 规则2：接近最佳记录时间（±1小时）
        if abs(current_hour - timing.optimal_hour) <= 1:
            return True, "optimal_time"

        # 规则3：晚上9点后仍未记录，推送完成提醒
        if current_hour >= 21:
            return True, "completion_push"

        # 规则4：连续漏填2天，下午提醒
        if streak_info["consecutive_missed"] >= 2 and current_hour >= 14:
            return True, "completion_push"

        return False, "none"

    def _get_today_records(self, patient_id: int) -> int:
        """获取今天的记录数量"""
        from backend.app.models.tracking_log import TrackingLog

        today_start = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )

        count = self.db.scalar(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= today_start,
            )
        )

        return 1 if count else 0

    def _generate_reminder_content(
        self,
        reminder_type: str,
        timing: ReminderTiming,
        streak_info: dict[str, Any],
    ) -> tuple[str, str, int]:
        """生成提醒内容"""
        current_streak = streak_info["current_streak"]
        consecutive_missed = streak_info["consecutive_missed"]

        if reminder_type == "streak_risk":
            if consecutive_missed >= 5:
                title = "我们很想念你的记录"
                message = (
                    f"已经{consecutive_missed}天没有记录了，没关系，"
                    "今天先补一条就好。每一笔记录都很有价值。"
                )
                priority = 5
            else:
                title = "别让记录断掉哦"
                message = (
                    f"已经连续{consecutive_missed}天没有记录了，"
                    "今天花1分钟记一下，我们重新开始。"
                )
                priority = 4

        elif reminder_type == "optimal_time":
            if current_streak > 0:
                title = f"记录时间到！已连续{current_streak}天"
                message = (
                    f"现在是您通常记录的时间（{timing.optimal_hour}:00左右），"
                    f"继续保持{current_streak}天的连续记录吧！"
                )
            else:
                title = "今天的记录时间到了"
                message = (
                    f"现在是您通常记录的时间（{timing.optimal_hour}:00左右），"
                    "花1分钟记录一下今天的状态吧。"
                )
            priority = 3

        elif reminder_type == "completion_push":
            if current_streak >= 7:
                title = "今天的记录还没完成"
                message = (
                    f"你已经连续记录{current_streak}天了，"
                    "今天也不要错过哦，保持连续记录可以获得专属奖励！"
                )
            else:
                title = "今天还没有记录"
                message = (
                    "睡前花1分钟记录一下今天的情绪和专注情况吧，"
                    "这对了解自己的状态很有帮助。"
                )
            priority = 2

        else:
            title = "记录提醒"
            message = "今天还没有记录，花1分钟记录一下吧。"
            priority = 1

        # 添加奖励预告
        if streak_info["next_reward"]:
            reward_info = streak_info["next_reward"]
            days_needed = reward_info["days_needed"]
            reward_title = reward_info["reward"].title

            if days_needed <= 3:
                message += f" 再坚持{days_needed}天就能解锁「{reward_title}」！"

        return title, message, priority

    def _calculate_scheduled_time(
        self,
        current_time: datetime,
        timing: ReminderTiming,
    ) -> datetime:
        """计算计划提醒时间"""
        # 如果当前时间接近最佳时间，立即提醒
        if abs(current_time.hour - timing.optimal_hour) <= 1:
            return current_time

        # 否则安排在最佳时间
        scheduled = current_time.replace(
            hour=timing.optimal_hour,
            minute=0,
            second=0,
            microsecond=0,
        )

        # 如果已经过了最佳时间，安排到明天
        if scheduled <= current_time:
            scheduled += timedelta(days=1)

        return scheduled

    def get_streak_rewards(self, patient_id: int) -> list[StreakReward]:
        """获取已解锁的连续打卡奖励"""
        streak_info = self._get_streak_status(patient_id)
        current_streak = streak_info["current_streak"]

        unlocked_rewards = []
        for days, reward in self.STREAK_REWARDS.items():
            if current_streak >= days:
                unlocked_rewards.append(reward)

        return unlocked_rewards

    def check_new_reward_unlock(
        self,
        patient_id: int,
        previous_streak: int,
        current_streak: int,
    ) -> StreakReward | None:
        """检查是否解锁了新奖励"""
        for days, reward in self.STREAK_REWARDS.items():
            if previous_streak < days <= current_streak:
                return reward

        return None

    def generate_weekly_summary(
        self,
        patient_id: int,
    ) -> dict[str, Any]:
        """生成周度总结报告"""
        from backend.app.models.tracking_log import TrackingLog

        # 获取最近7天的记录
        cutoff = datetime.now(timezone.utc) - timedelta(days=7)
        logs = self.db.scalars(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= cutoff,
            )
            .order_by(TrackingLog.created_at.asc())
        ).all()

        if not logs:
            return {
                "period": "最近7天",
                "completion_rate": 0.0,
                "average_mood": None,
                "average_focus": None,
                "mood_trend": "unknown",
                "focus_trend": "unknown",
                "top_activities": [],
                "insights": ["本周暂无记录数据"],
            }

        # 计算基础统计
        completed_days = len(set(log.day_index for log in logs))
        completion_rate = completed_days / 7

        # 计算平均心情和专注度
        mood_values = []
        focus_values = []
        activities = []

        for log in logs:
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
                activities.extend([a.strip() for a in log.activities.split(",") if a.strip()])

        avg_mood = np.mean(mood_values) if mood_values else None
        avg_focus = np.mean(focus_values) if focus_values else None

        # 计算趋势
        mood_trend = self._calculate_trend(mood_values)
        focus_trend = self._calculate_trend(focus_values)

        # 统计常见活动
        activity_counts = Counter(activities)
        top_activities = [act for act, _ in activity_counts.most_common(5)]

        # 生成洞察
        insights = self._generate_weekly_insights(
            completion_rate, avg_mood, avg_focus, mood_trend, focus_trend
        )

        return {
            "period": "最近7天",
            "completion_rate": round(completion_rate, 2),
            "average_mood": round(avg_mood, 2) if avg_mood else None,
            "average_focus": round(avg_focus, 1) if avg_focus else None,
            "mood_trend": mood_trend,
            "focus_trend": focus_trend,
            "top_activities": top_activities,
            "insights": insights,
        }

    def _calculate_trend(self, values: list[float]) -> str:
        """计算趋势方向"""
        if len(values) < 3:
            return "unknown"

        # 简单线性回归
        x = np.arange(len(values))
        coeffs = np.polyfit(x, values, 1)
        slope = coeffs[0]

        if slope > 0.1:
            return "improving"
        elif slope < -0.1:
            return "declining"
        else:
            return "stable"

    def _generate_weekly_insights(
        self,
        completion_rate: float,
        avg_mood: float | None,
        avg_focus: float | None,
        mood_trend: str,
        focus_trend: str,
    ) -> list[str]:
        """生成周度洞察"""
        insights = []

        # 完成率洞察
        if completion_rate >= 0.8:
            insights.append("本周记录非常规律，继续保持！")
        elif completion_rate >= 0.5:
            insights.append("本周记录情况一般，试着设置固定记录时间。")
        else:
            insights.append("本周记录较少，建议从今天开始重新养成记录习惯。")

        # 心情趋势洞察
        if mood_trend == "improving":
            insights.append("心情呈上升趋势，继续保持积极的状态！")
        elif mood_trend == "declining":
            insights.append("最近心情有所下降，注意适当休息和放松。")

        # 专注度趋势洞察
        if focus_trend == "improving":
            insights.append("专注能力在提升，可以适当增加挑战性任务。")
        elif focus_trend == "declining":
            insights.append("专注度有所下降，建议增加休息间隔或调整任务难度。")

        # 具体数值洞察
        if avg_mood and avg_mood < 2.5:
            insights.append("本周平均心情偏低，建议关注情绪管理。")
        elif avg_mood and avg_mood > 4.0:
            insights.append("本周心情整体很好，保持这种积极状态！")

        if avg_focus and avg_focus < 20:
            insights.append("本周专注时长较短，可以尝试番茄工作法。")
        elif avg_focus and avg_focus > 60:
            insights.append("本周专注能力很强，但也要注意适当休息。")

        return insights[:3]  # 最多返回3条洞察