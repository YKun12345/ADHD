"""
智能仪表盘相关Schema
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class PatientAlert(BaseModel):
    """患者预警"""

    patient_id: int = Field(..., description="患者ID")
    patient_name: str = Field(..., description="患者姓名")
    alert_type: str = Field(..., description="预警类型")
    severity: str = Field(..., description="严重程度")
    message: str = Field(..., description="预警消息")
    triggered_at: str = Field(..., description="触发时间")
    is_read: bool = Field(default=False, description="是否已读")
    recommended_action: str = Field(default="", description="建议行动")


class DashboardMetric(BaseModel):
    """仪表盘指标"""

    name: str = Field(..., description="指标名称")
    value: float | int | str = Field(..., description="指标值")
    change_percent: float | None = Field(default=None, description="变化百分比")
    trend: str = Field(default="stable", description="趋势")
    description: str = Field(default="", description="描述")


class SmartDashboardResponse(BaseModel):
    """智能仪表盘响应"""

    total_patients: int = Field(..., description="总患者数")
    active_patients: int = Field(..., description="活跃患者数")
    alerts_count: int = Field(..., description="预警数量")
    high_priority_alerts: int = Field(..., description="高优先级预警数")
    metrics: list[DashboardMetric] = Field(default_factory=list, description="关键指标")
    recent_alerts: list[PatientAlert] = Field(default_factory=list, description="最近预警")
    generated_at: str = Field(default="", description="生成时间")


class PatientAlertResponse(BaseModel):
    """患者预警列表响应"""

    alerts: list[PatientAlert] = Field(default_factory=list, description="预警列表")
    total_count: int = Field(..., description="总数")
    unread_count: int = Field(..., description="未读数")
    page: int = Field(default=1, description="页码")
    page_size: int = Field(default=20, description="每页大小")
