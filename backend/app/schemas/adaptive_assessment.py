"""
自适应评估相关Schema
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class AdaptiveDifficultyResponse(BaseModel):
    """自适应难度响应"""

    test_type: str = Field(..., description="测试类型")
    difficulty_level: str = Field(..., description="难度等级")
    parameters: dict[str, Any] = Field(default_factory=dict, description="难度参数")
    reason: str = Field(default="", description="调整原因")
    confidence: float = Field(default=0.5, ge=0.0, le=1.0, description="置信度")


class AnomalyDetectionRequest(BaseModel):
    """异常检测请求"""

    scale_type: str = Field(..., description="量表类型 (ASRS, SNAP_IV)")
    answers: list[int] = Field(..., description="回答列表")
    response_times: list[float] | None = Field(default=None, description="每题回答时间(ms)")
    question_difficulties: list[float] | None = Field(default=None, description="题目难度列表")


class AnomalyDetail(BaseModel):
    """异常详情"""

    anomaly_type: str = Field(..., description="异常类型")
    severity: str = Field(..., description="严重程度")
    confidence: float = Field(..., ge=0.0, le=1.0, description="置信度")
    description: str = Field(..., description="描述")
    affected_questions: list[int] = Field(default_factory=list, description="受影响的题目")
    details: dict[str, Any] = Field(default_factory=dict, description="详细信息")


class AnomalyDetectionResponse(BaseModel):
    """异常检测响应"""

    has_anomaly: bool = Field(..., description="是否有异常")
    anomalies: list[AnomalyDetail] = Field(default_factory=list, description="异常列表")
    overall_reliability: float = Field(..., ge=0.0, le=1.0, description="整体可信度")
    recommendation: str = Field(default="", description="建议")
    should_flag_for_review: bool = Field(default=False, description="是否需要人工复核")
