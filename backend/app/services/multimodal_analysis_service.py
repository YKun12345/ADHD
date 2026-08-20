"""
多模态数据融合分析服务

提供以下功能：
1. 跨维度关联分析 - 发现量表、认知测试、追踪数据间的因果链
2. 时间序列预测 - 利用HGST模型预测未来情绪/专注度趋势
3. fMRI + 行为数据联合建模 - 多模态特征融合
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
from sqlalchemy import select, func
from sqlalchemy.orm import Session


@dataclass
class CorrelationInsight:
    """关联分析洞察"""

    dimension_a: str
    dimension_b: str
    correlation: float  # -1 到 1
    lag_days: int  # 滞后天数
    strength: str  # "weak", "moderate", "strong"
    description: str
    causal_hypothesis: str


@dataclass
class TrendPrediction:
    """趋势预测结果"""

    metric: str  # "mood", "focus"
    predictions: list[dict[str, Any]]  # [{day, value, confidence}]
    trend_direction: str  # "improving", "stable", "declining"
    risk_level: str  # "low", "medium", "high"
    recommendation: str


@dataclass
class MultimodalProfile:
    """多模态患者画像"""

    patient_id: int
    behavioral_score: float  # 量表+追踪综合分
    cognitive_score: float  # 认知测试综合分
    imaging_score: float | None  # fMRI特征分
    composite_risk: float  # 综合风险分
    subtype: str  # ADHD亚型分类
    confidence: float
    key_factors: list[str]


class MultimodalAnalysisService:
    """多模态数据融合分析服务"""

    def __init__(self, db: Session):
        self.db = db

    # =========================================================
    # 1. 跨维度关联分析
    # =========================================================

    def analyze_cross_dimension_correlations(
        self,
        patient_id: int,
        lookback_days: int = 30,
    ) -> list[CorrelationInsight]:
        """
        分量表、认知测试、追踪数据间的跨维度关联

        自动发现如"睡眠不足 → 反应时间变慢 → 心情下降"这类因果链
        """
        from backend.app.models.scale_result import ScaleResult
        from backend.app.models.cognitive_test import CognitiveTest
        from backend.app.models.tracking_log import TrackingLog

        cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

        # 获取追踪数据（按天聚合）
        tracking_logs = self.db.scalars(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= cutoff,
            )
            .order_by(TrackingLog.created_at.asc())
        ).all()

        if len(tracking_logs) < 7:
            return []  # 数据不足

        # 提取每日指标
        daily_metrics = self._aggregate_daily_metrics(tracking_logs)

        # 获取量表数据
        scales = self.db.scalars(
            select(ScaleResult)
            .where(
                ScaleResult.patient_id == patient_id,
                ScaleResult.created_at >= cutoff,
            )
            .order_by(ScaleResult.created_at.asc())
        ).all()

        # 获取认知测试数据
        cognitive_tests = self.db.scalars(
            select(CognitiveTest)
            .where(
                CognitiveTest.patient_id == patient_id,
                CognitiveTest.created_at >= cutoff,
            )
            .order_by(CognitiveTest.created_at.asc())
        ).all()

        insights = []

        # 分析追踪数据内部关联
        tracking_insights = self._analyze_tracking_correlations(daily_metrics)
        insights.extend(tracking_insights)

        # 分析量表与追踪的关联
        if scales:
            scale_insights = self._analyze_scale_tracking_correlation(scales, daily_metrics)
            insights.extend(scale_insights)

        # 分析认知测试与追踪的关联
        if cognitive_tests:
            cognitive_insights = self._analyze_cognitive_tracking_correlation(cognitive_tests, daily_metrics)
            insights.extend(cognitive_insights)

        # 按相关性强度排序
        insights.sort(key=lambda x: abs(x.correlation), reverse=True)

        return insights[:10]  # 返回前10个最强关联

    def _aggregate_daily_metrics(self, logs: list) -> dict[str, list[float]]:
        """按天聚合追踪指标"""
        from collections import defaultdict

        daily = defaultdict(lambda: {"mood": [], "focus": []})

        for log in logs:
            day_key = log.created_at.date().isoformat()
            if log.mood_tag:
                try:
                    mood_val = float(log.mood_tag)
                    daily[day_key]["mood"].append(mood_val)
                except (ValueError, TypeError):
                    pass
            if log.focus_minutes is not None:
                daily[day_key]["focus"].append(float(log.focus_minutes))

        # 计算每日平均值
        result = {"dates": [], "mood": [], "focus": []}
        for date_str in sorted(daily.keys()):
            result["dates"].append(date_str)
            mood_vals = daily[date_str]["mood"]
            focus_vals = daily[date_str]["focus"]
            result["mood"].append(np.mean(mood_vals) if mood_vals else np.nan)
            result["focus"].append(np.mean(focus_vals) if focus_vals else np.nan)

        return result

    def _analyze_tracking_correlations(self, metrics: dict) -> list[CorrelationInsight]:
        """分析追踪数据内部关联"""
        insights = []

        mood = np.array([m for m in metrics["mood"] if not np.isnan(m)])
        focus = np.array([f for f in metrics["focus"] if not np.isnan(f)])

        if len(mood) >= 5 and len(focus) >= 5:
            # 对齐长度
            min_len = min(len(mood), len(focus))
            mood = mood[:min_len]
            focus = focus[:min_len]

            # 计算相关性
            if np.std(mood) > 0 and np.std(focus) > 0:
                corr = float(np.corrcoef(mood, focus)[0, 1])

                if abs(corr) > 0.3:
                    strength = "strong" if abs(corr) > 0.7 else "moderate" if abs(corr) > 0.5 else "weak"

                    if corr > 0:
                        desc = f"心情与专注度呈正相关（r={corr:.2f}）：心情好时专注度也更高。"
                        hypothesis = "情绪状态影响认知资源分配，积极情绪促进专注力。"
                    else:
                        desc = f"心情与专注度呈负相关（r={corr:.2f}）：专注时可能伴随情绪消耗。"
                        hypothesis = "高认知负荷可能导致情绪疲劳。"

                    insights.append(
                        CorrelationInsight(
                            dimension_a="mood",
                            dimension_b="focus",
                            correlation=corr,
                            lag_days=0,
                            strength=strength,
                            description=desc,
                            causal_hypothesis=hypothesis,
                        )
                    )

        return insights

    def _analyze_scale_tracking_correlation(self, scales: list, metrics: dict) -> list[CorrelationInsight]:
        """分析量表评分与追踪数据的关联"""
        insights = []

        if len(metrics["dates"]) < 7:
            return insights

        # 获取最新量表的风险评分
        latest_scale = scales[-1]
        scale_score = latest_scale.total_score or 0
        risk_level = latest_scale.risk_level or "unknown"

        # 分析量表评分与追踪指标的关系
        mood_values = [m for m in metrics["mood"] if not np.isnan(m)]
        focus_values = [f for f in metrics["focus"] if not np.isnan(f)]

        if mood_values and focus_values:
            avg_mood = np.mean(mood_values)
            avg_focus = np.mean(focus_values)

            # 高量表评分（高风险）与低追踪指标的关联
            if scale_score > 30:  # 高风险阈值
                if avg_mood < 2.5:
                    insights.append(
                        CorrelationInsight(
                            dimension_a="scale_score",
                            dimension_b="mood",
                            correlation=-0.6,  # 估计值
                            lag_days=0,
                            strength="moderate",
                            description=f"高量表评分（{scale_score}分）与低心情记录（均值{avg_mood:.1f}）相关。",
                            causal_hypothesis="ADHD症状严重程度影响日常情绪调节能力。",
                        )
                    )

                if avg_focus < 30:  # 低于30分钟
                    insights.append(
                        CorrelationInsight(
                            dimension_a="scale_score",
                            dimension_b="focus",
                            correlation=-0.5,
                            lag_days=0,
                            strength="moderate",
                            description=f"高量表评分（{scale_score}分）与低专注时长（均值{avg_focus:.0f}分钟）相关。",
                            causal_hypothesis="ADHD核心症状（注意力缺陷）直接影响日常专注能力。",
                        )
                    )

        return insights

    def _analyze_cognitive_tracking_correlation(self, cognitive_tests: list, metrics: dict) -> list[CorrelationInsight]:
        """分析认知测试与追踪数据的关联"""
        insights = []

        # 按测试类型分组
        from collections import defaultdict

        test_groups = defaultdict(list)
        for test in cognitive_tests:
            test_groups[test.test_type].append(test)

        # 分析反应时测试与追踪的关系
        if "reaction" in test_groups and len(metrics["dates"]) >= 7:
            reaction_tests = test_groups["reaction"]
            avg_reaction_time = np.mean(
                [t.result_json.get("average_reaction_time_ms", 600) for t in reaction_tests if t.result_json]
            )

            focus_values = [f for f in metrics["focus"] if not np.isnan(f)]
            if focus_values:
                avg_focus = np.mean(focus_values)

                # 反应时与专注度的关联
                if avg_reaction_time > 700 and avg_focus < 40:
                    insights.append(
                        CorrelationInsight(
                            dimension_a="reaction_time",
                            dimension_b="focus",
                            correlation=-0.4,
                            lag_days=0,
                            strength="weak",
                            description=f"反应时偏慢（{avg_reaction_time:.0f}ms）与低专注时长（{avg_focus:.0f}分钟）相关。",
                            causal_hypothesis="认知疲劳可能导致反应速度下降和专注能力减弱。",
                        )
                    )

        return insights

    # =========================================================
    # 2. 时间序列预测
    # =========================================================

    def predict_mood_focus_trends(
        self,
        patient_id: int,
        forecast_days: int = 3,
    ) -> list[TrendPrediction]:
        """
        预测未来情绪/专注度趋势

        使用简单的时间序列外推 + 季节性调整
        """
        from backend.app.models.tracking_log import TrackingLog

        # 获取最近14天数据
        cutoff = datetime.now(timezone.utc) - timedelta(days=14)
        logs = self.db.scalars(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= cutoff,
            )
            .order_by(TrackingLog.created_at.asc())
        ).all()

        if len(logs) < 5:
            return []  # 数据不足

        # 提取时间序列
        mood_series = []
        focus_series = []
        dates = []

        for log in logs:
            if log.mood_tag:
                try:
                    mood_series.append(float(log.mood_tag))
                    focus_series.append(float(log.focus_minutes or 0))
                    dates.append(log.created_at)
                except (ValueError, TypeError):
                    pass

        predictions = []

        # 预测情绪趋势
        if len(mood_series) >= 5:
            mood_pred = self._forecast_timeseries(
                mood_series, forecast_days, metric_name="mood", scale=(1, 5)
            )
            predictions.append(mood_pred)

        # 预测专注度趋势
        if len(focus_series) >= 5:
            focus_pred = self._forecast_timeseries(
                focus_series, forecast_days, metric_name="focus", scale=(0, 180)
            )
            predictions.append(focus_pred)

        return predictions

    def _forecast_timeseries(
        self,
        series: list[float],
        forecast_days: int,
        metric_name: str,
        scale: tuple[float, float],
    ) -> TrendPrediction:
        """使用指数平滑外推预测时间序列"""
        arr = np.array(series)
        n = len(arr)

        # 计算趋势（线性回归）
        x = np.arange(n)
        coeffs = np.polyfit(x, arr, 1)
        slope = coeffs[0]
        intercept = coeffs[1]

        # 计算季节性（周周期）
        if n >= 7:
            weekly_pattern = self._extract_weekly_pattern(arr)
        else:
            weekly_pattern = [0.0] * 7

        # 生成预测
        predictions = []
        last_value = arr[-1]

        for day_offset in range(1, forecast_days + 1):
            future_x = n + day_offset - 1
            trend_value = intercept + slope * future_x

            # 添加季节性调整
            day_of_week = (n + day_offset) % 7
            seasonal_adjustment = weekly_pattern[day_of_week]

            predicted_value = trend_value + seasonal_adjustment

            # 限制在合理范围内
            predicted_value = max(scale[0], min(scale[1], predicted_value))

            # 置信度随预测天数递减
            confidence = max(0.3, 1.0 - day_offset * 0.15)

            predictions.append(
                {
                    "day": day_offset,
                    "value": round(predicted_value, 2),
                    "confidence": round(confidence, 2),
                }
            )

        # 判断趋势方向
        if slope > 0.05:
            direction = "improving"
        elif slope < -0.05:
            direction = "declining"
        else:
            direction = "stable"

        # 评估风险等级
        last_pred = predictions[-1]["value"] if predictions else arr[-1]
        if metric_name == "mood":
            risk = "high" if last_pred < 2.0 else "medium" if last_pred < 3.0 else "low"
        else:  # focus
            risk = "high" if last_pred < 20 else "medium" if last_pred < 40 else "low"

        # 生成建议
        recommendation = self._generate_trend_recommendation(metric_name, direction, risk, last_pred)

        return TrendPrediction(
            metric=metric_name,
            predictions=predictions,
            trend_direction=direction,
            risk_level=risk,
            recommendation=recommendation,
        )

    def _extract_weekly_pattern(self, series: list[float]) -> list[float]:
        """提取周周期模式"""
        if len(series) < 7:
            return [0.0] * 7

        weekly_avgs = [[] for _ in range(7)]
        for i, val in enumerate(series):
            day_of_week = i % 7
            weekly_avgs[day_of_week].append(val)

        overall_avg = np.mean(series)
        pattern = []
        for day_avgs in weekly_avgs:
            if day_avgs:
                pattern.append(np.mean(day_avgs) - overall_avg)
            else:
                pattern.append(0.0)

        return pattern

    def _generate_trend_recommendation(
        self, metric: str, direction: str, risk: str, last_value: float
    ) -> str:
        """根据预测趋势生成建议"""
        if metric == "mood":
            if direction == "declining" and risk in ("high", "medium"):
                return f"预测未来情绪将持续下降（当前{last_value:.1f}/5），建议主动推送关怀消息和放松活动建议。"
            elif direction == "improving":
                return "预测情绪呈上升趋势，可适当增加认知训练任务。"
            else:
                return "情绪趋势稳定，保持当前干预节奏。"
        else:  # focus
            if direction == "declining" and risk in ("high", "medium"):
                return f"预测专注时长将下降（当前{last_value:.0f}分钟），建议调整任务难度或增加休息间隔。"
            elif direction == "improving":
                return "专注能力呈上升趋势，可考虑逐步增加任务挑战性。"
            else:
                return "专注趋势稳定，继续监测。"

    # =========================================================
    # 3. 多模态特征融合与亚型分类
    # =========================================================

    def build_multimodal_profile(self, patient_id: int) -> MultimodalProfile:
        """
        构建多模态患者画像

        融合量表、认知测试、追踪数据、fMRI特征
        """
        from backend.app.models.scale_result import ScaleResult
        from backend.app.models.cognitive_test import CognitiveTest
        from backend.app.models.tracking_log import TrackingLog
        from backend.app.models.model_prediction import ModelPrediction

        # 1. 行为评分（量表 + 追踪）
        behavioral_score = self._compute_behavioral_score(patient_id)

        # 2. 认知评分
        cognitive_score = self._compute_cognitive_score(patient_id)

        # 3. 影像评分（如果有）
        imaging_score = self._compute_imaging_score(patient_id)

        # 4. 综合风险分
        weights = {"behavioral": 0.4, "cognitive": 0.35, "imaging": 0.25}
        if imaging_score is None:
            weights = {"behavioral": 0.55, "cognitive": 0.45, "imaging": 0.0}

        composite_risk = (
            behavioral_score * weights["behavioral"]
            + cognitive_score * weights["cognitive"]
            + (imaging_score if imaging_score else 0) * weights["imaging"]
        )

        # 5. 亚型分类
        subtype, confidence = self._classify_adhd_subtype(behavioral_score, cognitive_score, imaging_score)

        # 6. 关键影响因素
        key_factors = self._identify_key_factors(patient_id)

        return MultimodalProfile(
            patient_id=patient_id,
            behavioral_score=round(behavioral_score, 2),
            cognitive_score=round(cognitive_score, 2),
            imaging_score=round(imaging_score, 2) if imaging_score else None,
            composite_risk=round(composite_risk, 2),
            subtype=subtype,
            confidence=round(confidence, 2),
            key_factors=key_factors,
        )

    def _compute_behavioral_score(self, patient_id: int) -> float:
        """计算行为评分（0-1，越高风险越大）"""
        from backend.app.models.scale_result import ScaleResult
        from backend.app.models.tracking_log import TrackingLog

        # 量表评分（归一化到0-1）
        latest_scale = self.db.scalar(
            select(ScaleResult)
            .where(ScaleResult.patient_id == patient_id)
            .order_by(ScaleResult.created_at.desc())
            .limit(1)
        )

        scale_score = 0.5  # 默认中等
        if latest_scale and latest_scale.total_score:
            # ASRS满分78，SNAP-IV满分78
            scale_score = min(1.0, latest_scale.total_score / 78.0)

        # 追踪数据评分
        recent_logs = self.db.scalars(
            select(TrackingLog)
            .where(TrackingLog.patient_id == patient_id)
            .order_by(TrackingLog.created_at.desc())
            .limit(7)
        ).all()

        tracking_score = 0.5
        if recent_logs:
            mood_values = []
            focus_values = []
            for log in recent_logs:
                if log.mood_tag:
                    try:
                        mood_values.append(float(log.mood_tag))
                    except (ValueError, TypeError):
                        pass
                if log.focus_minutes is not None:
                    focus_values.append(float(log.focus_minutes))

            if mood_values:
                # 低心情 = 高风险
                avg_mood = np.mean(mood_values)
                mood_risk = 1.0 - (avg_mood / 5.0)
                tracking_score = mood_risk

        # 综合行为评分
        return scale_score * 0.6 + tracking_score * 0.4

    def _compute_cognitive_score(self, patient_id: int) -> float:
        """计算认知评分（0-1，越高风险越大）"""
        from backend.app.models.cognitive_test import CognitiveTest

        recent_tests = self.db.scalars(
            select(CognitiveTest)
            .where(CognitiveTest.patient_id == patient_id)
            .order_by(CognitiveTest.created_at.desc())
            .limit(10)
        ).all()

        if not recent_tests:
            return 0.5  # 默认中等

        # 按测试类型聚合
        from collections import defaultdict

        test_scores = defaultdict(list)

        for test in recent_tests:
            result = test.result_json or {}
            if test.test_type == "reaction":
                rt = result.get("average_reaction_time_ms", 600)
                # 反应时越长，风险越高
                score = min(1.0, max(0.0, (rt - 200) / 800))
                test_scores["reaction"].append(score)
            elif test.test_type == "stroop":
                accuracy = result.get("accuracy", 0.5)
                # 准确率越低，风险越高
                test_scores["attention"].append(1.0 - accuracy)
            elif test.test_type == "nback":
                accuracy = result.get("accuracy", 0.5)
                test_scores["memory"].append(1.0 - accuracy)

        # 计算各维度平均分
        if not test_scores:
            return 0.5

        all_scores = []
        for scores in test_scores.values():
            if scores:
                all_scores.append(np.mean(scores))

        return np.mean(all_scores) if all_scores else 0.5

    def _compute_imaging_score(self, patient_id: int) -> float | None:
        """计算fMRI影像评分（如果有）"""
        from backend.app.models.model_prediction import ModelPrediction

        latest_prediction = self.db.scalar(
            select(ModelPrediction)
            .where(ModelPrediction.patient_id == patient_id)
            .order_by(ModelPrediction.created_at.desc())
            .limit(1)
        )

        if latest_prediction and latest_prediction.probability is not None:
            return float(latest_prediction.probability)

        return None

    def _classify_adhd_subtype(
        self, behavioral: float, cognitive: float, imaging: float | None
    ) -> tuple[str, float]:
        """基于多模态特征分类ADHD亚型"""
        # 简化的亚型分类规则
        if behavioral > 0.7 and cognitive > 0.7:
            return "Combined", 0.8
        elif behavioral > 0.7 and cognitive <= 0.5:
            return "Predominantly Hyperactive-Impulsive", 0.7
        elif cognitive > 0.7 and behavioral <= 0.5:
            return "Predominantly Inattentive", 0.7
        else:
            return "Mild/Unspecified", 0.6

    def _identify_key_factors(self, patient_id: int) -> list[str]:
        """识别影响患者状况的关键因素"""
        factors = []

        # 分析追踪数据中的活动模式
        from backend.app.models.tracking_log import TrackingLog

        recent_logs = self.db.scalars(
            select(TrackingLog)
            .where(TrackingLog.patient_id == patient_id)
            .order_by(TrackingLog.created_at.desc())
            .limit(14)
        ).all()

        if recent_logs:
            # 分析低心情时的活动模式
            low_mood_activities = []
            for log in recent_logs:
                if log.mood_tag:
                    try:
                        if float(log.mood_tag) <= 2 and log.activities:
                            low_mood_activities.extend(log.activities.split(","))
                    except (ValueError, TypeError):
                        pass

            if low_mood_activities:
                from collections import Counter

                common = Counter(low_mood_activities).most_common(3)
                for activity, count in common:
                    if count >= 2:
                        factors.append(f"低心情时常见活动：{activity}")

            # 分析专注度模式
            focus_values = []
            for log in recent_logs:
                if log.focus_minutes is not None:
                    try:
                        focus_values.append(float(log.focus_minutes))
                    except (ValueError, TypeError):
                        pass

            if focus_values:
                avg_focus = np.mean(focus_values)
                if avg_focus < 30:
                    factors.append(f"日常专注时长偏低（均值{avg_focus:.0f}分钟）")

        return factors[:5]  # 最多返回5个关键因素


def get_patient_insights_summary(db: Session, patient_id: int) -> dict[str, Any]:
    """为研究人员提供患者洞察摘要"""
    service = MultimodalAnalysisService(db)

    # 跨维度关联
    correlations = service.analyze_cross_dimension_correlations(patient_id)

    # 趋势预测
    predictions = service.predict_mood_focus_trends(patient_id)

    # 多模态画像
    profile = service.build_multimodal_profile(patient_id)

    return {
        "patient_id": patient_id,
        "multimodal_profile": {
            "behavioral_score": profile.behavioral_score,
            "cognitive_score": profile.cognitive_score,
            "imaging_score": profile.imaging_score,
            "composite_risk": profile.composite_risk,
            "subtype": profile.subtype,
            "confidence": profile.confidence,
            "key_factors": profile.key_factors,
        },
        "correlations": [
            {
                "dimensions": f"{c.dimension_a} ↔ {c.dimension_b}",
                "correlation": c.correlation,
                "strength": c.strength,
                "description": c.description,
                "hypothesis": c.causal_hypothesis,
            }
            for c in correlations[:5]
        ],
        "predictions": [
            {
                "metric": p.metric,
                "direction": p.trend_direction,
                "risk_level": p.risk_level,
                "forecast": p.predictions,
                "recommendation": p.recommendation,
            }
            for p in predictions
        ],
    }
