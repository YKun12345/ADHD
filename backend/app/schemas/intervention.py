"""
干预方案相关Schema
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class InterventionTask(BaseModel):
    """干预任务"""

    task_id: int | None = Field(default=None, description="任务ID")
    title: str = Field(..., description="任务标题")
    description: str = Field(default="", description="任务描述")
    task_type: str = Field(..., description="任务类型")
    frequency: str = Field(default="daily", description="频率")
    estimated_minutes: int = Field(default=15, description="预计时长(分钟)")
    is_completed: bool = Field(default=False, description="是否完成")
    due_date: str | None = Field(default=None, description="截止日期")


class InterventionPlanResponse(BaseModel):
    """干预方案响应"""

    plan_id: int | None = Field(default=None, description="方案ID")
    patient_id: int = Field(..., description="患者ID")
    intervention_type: str = Field(..., description="干预类型")
    title: str = Field(..., description="方案标题")
    description: str = Field(default="", description="方案描述")
    goals: list[str] = Field(default_factory=list, description="目标列表")
    tasks: list[InterventionTask] = Field(default_factory=list, description="任务列表")
    start_date: str = Field(..., description="开始日期")
    end_date: str | None = Field(default=None, description="结束日期")
    status: str = Field(default="active", description="状态")
    progress_percent: float = Field(default=0.0, ge=0.0, le=100.0, description="进度百分比")


class InterventionEffectResponse(BaseModel):
    """干预效果响应"""

    plan_id: int = Field(..., description="方案ID")
    patient_id: int = Field(..., description="患者ID")
    evaluation_period_days: int = Field(default=30, description="评估周期(天)")
    task_completion_rate: float = Field(..., ge=0.0, le=1.0, description="任务完成率")
    mood_change: float | None = Field(default=None, description="心情变化")
    focus_change: float | None = Field(default=None, description="专注度变化")
    adherence_score: float = Field(..., ge=0.0, le=1.0, description="依从性评分")
    effectiveness_rating: str = Field(default="moderate", description="效果评级")
    insights: list[str] = Field(default_factory=list, description="洞察列表")
    recommendations: list[str] = Field(default_factory=list, description="建议列表")


class PersonalizedMessageRequest(BaseModel):
    """个性化消息请求"""

    patient_id: int = Field(..., description="患者ID")
    message_type: str = Field(default="encouragement", description="消息类型")
    content: str = Field(..., description="消息内容")
    tone: str = Field(default="supportive", description="语气风格")
    include_insights: bool = Field(default=False, description="是否包含洞察")


class PersonalizedMessageResponse(BaseModel):
    """个性化消息响应"""

    message_id: int | None = Field(default=None, description="消息ID")
    patient_id: int = Field(..., description="患者ID")
    sender_id: int = Field(..., description="发送者ID")
    content: str = Field(..., description="消息内容")
    message_type: str = Field(..., description="消息类型")
    tone: str = Field(..., description="语气风格")
    sent_at: str = Field(..., description="发送时间")
    is_read: bool = Field(default=False, description="是否已读")
