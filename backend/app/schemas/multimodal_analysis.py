"""
多模态分析相关Schema
"""

from __future__ import annotations


from pydantic import BaseModel, Field


class CorrelationInsight(BaseModel):
    """关联洞察"""

    dimension_a: str = Field(..., description="维度A")
    dimension_b: str = Field(..., description="维度B")
    correlation: float = Field(..., ge=-1.0, le=1.0, description="相关系数")
    significance: str = Field(default="medium", description="显著性")
    description: str = Field(default="", description="描述")


class TrendPrediction(BaseModel):
    """趋势预测"""

    metric: str = Field(..., description="指标名称")
    current_value: float = Field(..., description="当前值")
    predicted_value: float = Field(..., description="预测值")
    trend_direction: str = Field(..., description="趋势方向 (improving/stable/declining)")
    confidence: float = Field(..., ge=0.0, le=1.0, description="置信度")
    prediction_horizon_days: int = Field(default=7, description="预测时间范围(天)")


class SubtypeClassification(BaseModel):
    """亚型分类"""

    subtype: str = Field(..., description="ADHD亚型")
    probability: float = Field(..., ge=0.0, le=1.0, description="概率")
    indicators: list[str] = Field(default_factory=list, description="关键指标")


class MultimodalInsightsResponse(BaseModel):
    """多模态洞察响应"""

    patient_id: int = Field(..., description="患者ID")
    analysis_period_days: int = Field(default=30, description="分析周期(天)")
    correlations: list[CorrelationInsight] = Field(default_factory=list, description="关联分析")
    trend_predictions: list[TrendPrediction] = Field(default_factory=list, description="趋势预测")
    subtype_classification: SubtypeClassification | None = Field(default=None, description="亚型分类")
    summary: str = Field(default="", description="综合摘要")
    generated_at: str = Field(default="", description="生成时间")


class TrendPredictionResponse(BaseModel):
    """趋势预测响应"""

    patient_id: int = Field(..., description="患者ID")
    predictions: list[TrendPrediction] = Field(default_factory=list, description="预测列表")
    overall_trend: str = Field(default="stable", description="整体趋势")
    recommendations: list[str] = Field(default_factory=list, description="建议列表")
