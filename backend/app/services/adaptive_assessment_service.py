"""
智能评估增强服务

提供以下功能：
1. 计算机自适应测试 (CAT) - 动态调整量表题目
2. 认知测试自适应难度 - 根据历史表现调整测试参数
3. 异常回答模式检测 - 自动识别矛盾/规律性作答
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session


@dataclass
class AdaptiveDifficulty:
    """自适应难度配置"""

    nback_match_probability: float = 0.35
    nback_grid_size: int = 3
    nback_back_distance: int = 2
    stroop_total_trials: int = 8
    stroop_color_count: int = 4
    reaction_min_delay_ms: int = 1200
    reaction_max_delay_ms: int = 1800
    digit_span_start_length: int = 5
    difficulty_level: str = "normal"  # easy, normal, hard


@dataclass
class AnomalyDetectionResult:
    """异常检测结果"""

    has_anomaly: bool
    anomaly_type: str | None  # "contradiction", "pattern", "speed", "random"
    confidence: float
    description: str
    affected_questions: list[int]
    severity: str  # "low", "medium", "high"


class AdaptiveAssessmentService:
    """智能评估增强服务"""

    def __init__(self, db: Session):
        self.db = db

    # =========================================================
    # 1. 计算机自适应测试 (CAT) - 基于IRT模型
    # =========================================================

    def compute_cat_next_question(
        self,
        scale_type: str,
        answered_questions: list[dict[str, Any]],
        all_questions: list[dict[str, Any]],
        current_ability: float = 0.0,
    ) -> dict[str, Any] | None:
        """
        基于项目反应理论 (IRT) 计算下一题

        参数：
        - scale_type: 量表类型 (ASRS, SNAP_IV)
        - answered_questions: 已回答题目列表 [{question_id, answer, difficulty, discrimination}]
        - all_questions: 所有可用题目
        - current_ability: 当前能力估计值 (theta)

        返回：
        - 下一题信息，包含题目ID、预估难度、信息量
        """
        answered_ids = {q["question_id"] for q in answered_questions}

        if len(answered_ids) >= self._get_min_questions(scale_type):
            return None  # 已达到最小题目数，可以结束

        available = [q for q in all_questions if q["question_id"] not in answered_ids]

        if not available:
            return None

        # 使用最大信息量准则选择下一题
        best_question = None
        max_info = -1.0

        for q in available:
            info = self._irt_information(
                theta=current_ability,
                difficulty=q.get("difficulty", 0.0),
                discrimination=q.get("discrimination", 1.0),
            )
            if info > max_info:
                max_info = info
                best_question = q

        if best_question:
            return {
                "question_id": best_question["question_id"],
                "question_text": best_question.get("text", ""),
                "information_value": round(max_info, 4),
                "estimated_difficulty": best_question.get("difficulty", 0.0),
                "remaining_questions": len(available) - 1,
            }
        return None

    def update_ability_estimate(
        self,
        current_ability: float,
        answered_questions: list[dict[str, Any]],
    ) -> float:
        """
        使用边际最大似然估计 (MLE) 更新能力值 theta

        基于已回答题目更新对患者能力的估计
        """
        if not answered_questions:
            return current_ability

        # 简化的能力估计：基于正确率和题目难度
        total_info = 0.0
        weighted_sum = 0.0

        for q in answered_questions:
            difficulty = q.get("difficulty", 0.0)
            discrimination = q.get("discrimination", 1.0)
            answer = q.get("answer", 0)

            # 将答案转换为0-1范围（正确率）
            p_correct = min(1.0, max(0.0, answer / 4.0))

            info = self._irt_information(current_ability, difficulty, discrimination)
            weighted_sum += info * (p_correct - 0.5)
            total_info += info

        if total_info > 0:
            # Newton-Raphson 更新步长
            delta = weighted_sum / total_info
            new_ability = current_ability + delta
            # 限制在合理范围内 [-3, 3]
            return max(-3.0, min(3.0, new_ability))

        return current_ability

    def _irt_information(self, theta: float, difficulty: float, discrimination: float) -> float:
        """计算IRT信息量 I(θ) = a² * P(θ) * Q(θ)"""
        z = discrimination * (theta - difficulty)
        p = 1.0 / (1.0 + math.exp(-z))  # logistic函数
        q = 1.0 - p
        return (discrimination**2) * p * q

    def _get_min_questions(self, scale_type: str) -> int:
        """获取各量表的最小题目数"""
        min_questions = {
            "ASRS": 6,  # ASRS简版最少6题
            "SNAP_IV": 9,  # SNAP-IV注意力维度最少9题
        }
        return min_questions.get(scale_type, 6)

    # =========================================================
    # 2. 认知测试自适应难度
    # =========================================================

    def compute_adaptive_difficulty(
        self,
        patient_id: int,
        test_type: str,
        lookback_days: int = 30,
    ) -> AdaptiveDifficulty:
        """
        基于患者历史表现计算自适应难度

        参数：
        - patient_id: 患者ID
        - test_type: 测试类型 (nback, stroop, reaction, digit)
        - lookback_days: 回溯天数

        返回：
        - 自适应难度配置
        """
        from backend.app.models.cognitive_test import CognitiveTest

        # 获取历史测试记录
        cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
        history = self.db.scalars(
            select(CognitiveTest)
            .where(
                CognitiveTest.patient_id == patient_id,
                CognitiveTest.test_type == test_type,
                CognitiveTest.created_at >= cutoff,
            )
            .order_by(CognitiveTest.created_at.desc())
            .limit(10)
        ).all()

        if not history:
            return AdaptiveDifficulty()  # 默认难度

        # 分析历史表现
        performances = []
        for test in history:
            result = test.result_json or {}
            perf = self._extract_performance(test_type, result)
            if perf is not None:
                performances.append(perf)

        if not performances:
            return AdaptiveDifficulty()

        avg_performance = np.mean(performances)
        trend = self._compute_trend(performances)

        # 根据表现和趋势调整难度
        return self._adjust_difficulty(test_type, avg_performance, trend)

    def _extract_performance(self, test_type: str, result: dict) -> float | None:
        """从测试结果中提取性能指标 (0-1范围)"""
        if test_type == "nback":
            accuracy = result.get("accuracy", 0)
            return accuracy  # 0-1
        elif test_type == "stroop":
            accuracy = result.get("accuracy", 0)
            rt = result.get("average_reaction_time_ms", 1500)
            # 综合准确率和反应时
            rt_score = max(0, 1 - (rt - 500) / 1500)  # 500ms=1.0, 2000ms=0.0
            return accuracy * 0.7 + rt_score * 0.3
        elif test_type == "reaction":
            rt = result.get("average_reaction_time_ms", 600)
            return max(0, 1 - (rt - 200) / 800)  # 200ms=1.0, 1000ms=0.0
        elif test_type == "digit":
            correct = result.get("correct_rounds", 0)
            highest = result.get("highest_span", 5)
            return min(1.0, (correct / 8.0 + highest / 12.0) / 2)
        return None

    def _compute_trend(self, performances: list[float]) -> float:
        """计算性能趋势（斜率）"""
        if len(performances) < 2:
            return 0.0
        x = np.arange(len(performances))
        coeffs = np.polyfit(x, performances, 1)
        return float(coeffs[0])  # 斜率

    def _adjust_difficulty(self, test_type: str, avg_performance: float, trend: float) -> AdaptiveDifficulty:
        """根据平均表现和趋势调整难度"""
        # 确定难度等级
        if avg_performance >= 0.8 and trend >= 0:
            level = "hard"
        elif avg_performance >= 0.6:
            level = "normal"
        else:
            level = "easy"

        # 根据测试类型设置具体参数
        if test_type == "nback":
            if level == "hard":
                return AdaptiveDifficulty(
                    nback_match_probability=0.40,
                    nback_grid_size=4,
                    nback_back_distance=3,
                    difficulty_level="hard",
                )
            elif level == "easy":
                return AdaptiveDifficulty(
                    nback_match_probability=0.30,
                    nback_grid_size=3,
                    nback_back_distance=2,
                    difficulty_level="easy",
                )
        elif test_type == "stroop":
            if level == "hard":
                return AdaptiveDifficulty(
                    stroop_total_trials=12,
                    stroop_color_count=6,
                    difficulty_level="hard",
                )
            elif level == "easy":
                return AdaptiveDifficulty(
                    stroop_total_trials=6,
                    stroop_color_count=4,
                    difficulty_level="easy",
                )
        elif test_type == "reaction":
            if level == "hard":
                return AdaptiveDifficulty(
                    reaction_min_delay_ms=800,
                    reaction_max_delay_ms=1200,
                    difficulty_level="hard",
                )
            elif level == "easy":
                return AdaptiveDifficulty(
                    reaction_min_delay_ms=1500,
                    reaction_max_delay_ms=2500,
                    difficulty_level="easy",
                )
        elif test_type == "digit":
            if level == "hard":
                return AdaptiveDifficulty(digit_span_start_length=7, difficulty_level="hard")
            elif level == "easy":
                return AdaptiveDifficulty(digit_span_start_length=4, difficulty_level="easy")

        return AdaptiveDifficulty(difficulty_level=level)

    # =========================================================
    # 3. 异常回答模式检测
    # =========================================================

    def detect_answer_anomalies(
        self,
        scale_type: str,
        answers: list[int],
        response_times: list[float] | None = None,
    ) -> list[AnomalyDetectionResult]:
        """
        检测量表回答中的异常模式

        参数：
        - scale_type: 量表类型
        - answers: 回答列表
        - response_times: 各题作答时间（毫秒），可选

        返回：
        - 异常检测结果列表
        """
        anomalies = []

        # 1. 检测规律性作答（如全选同一选项）
        pattern_anomaly = self._detect_pattern_answering(answers)
        if pattern_anomaly:
            anomalies.append(pattern_anomaly)

        # 2. 检测矛盾作答
        contradiction_anomaly = self._detect_contradictions(scale_type, answers)
        if contradiction_anomaly:
            anomalies.append(contradiction_anomaly)

        # 3. 检测作答速度异常
        if response_times:
            speed_anomaly = self._detect_speed_anomaly(response_times)
            if speed_anomaly:
                anomalies.append(speed_anomaly)

        # 4. 检测随机作答模式
        random_anomaly = self._detect_random_answering(answers)
        if random_anomaly:
            anomalies.append(random_anomaly)

        return anomalies

    def _detect_pattern_answering(self, answers: list[int]) -> AnomalyDetectionResult | None:
        """检测规律性作答（如全选同一选项）"""
        if len(answers) < 5:
            return None

        # 统计各选项频率
        from collections import Counter

        counter = Counter(answers)
        most_common_count = counter.most_common(1)[0][1]
        ratio = most_common_count / len(answers)

        if ratio >= 0.8:
            most_common_value = counter.most_common(1)[0][0]
            return AnomalyDetectionResult(
                has_anomaly=True,
                anomaly_type="pattern",
                confidence=min(1.0, ratio),
                description=f"检测到规律性作答：{ratio:.0%}的题目选择了同一选项（值={most_common_value}），可能为随意作答。",
                affected_questions=[i for i, a in enumerate(answers) if a == most_common_value],
                severity="high" if ratio >= 0.9 else "medium",
            )
        return None

    def _detect_contradictions(self, scale_type: str, answers: list[int]) -> AnomalyDetectionResult | None:
        """检测矛盾作答"""
        if scale_type == "ASRS" and len(answers) >= 18:
            # ASRS相关题目对比
            contradiction_pairs = [
                (0, 8),   # 注意力相关
                (3, 4),   # 组织管理相关
                (11, 12), # 多动相关
                (14, 15), # 冲动相关
            ]

            contradictions = []
            for i, j in contradiction_pairs:
                if i < len(answers) and j < len(answers):
                    # 如果差异超过2个等级，视为矛盾
                    if abs(answers[i] - answers[j]) >= 2:
                        contradictions.append((i, j))

            if len(contradictions) >= 2:
                affected = []
                for i, j in contradictions:
                    affected.extend([i, j])

                return AnomalyDetectionResult(
                    has_anomaly=True,
                    anomaly_type="contradiction",
                    confidence=min(1.0, len(contradictions) / 4),
                    description=f"检测到{len(contradictions)}处矛盾作答，相关题目回答差异过大。",
                    affected_questions=sorted(set(affected)),
                    severity="high" if len(contradictions) >= 3 else "medium",
                )

        return None

    def _detect_speed_anomaly(self, response_times: list[float]) -> AnomalyDetectionResult | None:
        """检测作答速度异常（过快或过慢）"""
        if len(response_times) < 5:
            return None

        avg_time = np.mean(response_times)
        std_time = np.std(response_times)

        # 检测过快作答（平均<2秒）
        if avg_time < 2000:
            fast_count = sum(1 for t in response_times if t < 1500)
            fast_ratio = fast_count / len(response_times)

            if fast_ratio >= 0.5:
                return AnomalyDetectionResult(
                    has_anomaly=True,
                    anomaly_type="speed",
                    confidence=min(1.0, fast_ratio),
                    description=f"检测到过快作答：平均{avg_time/1000:.1f}秒/题，{fast_ratio:.0%}的题目在1.5秒内完成。",
                    affected_questions=[i for i, t in enumerate(response_times) if t < 1500],
                    severity="high" if fast_ratio >= 0.8 else "medium",
                )

        return None

    def _detect_random_answering(self, answers: list[int]) -> AnomalyDetectionResult | None:
        """检测随机作答模式（熵值过高）"""
        if len(answers) < 10:
            return None

        from collections import Counter

        counter = Counter(answers)
        total = len(answers)

        # 计算香农熵
        entropy = 0.0
        for count in counter.values():
            p = count / total
            if p > 0:
                entropy -= p * math.log2(p)

        # 最大可能熵
        max_entropy = math.log2(len(counter)) if counter else 0

        if max_entropy > 0:
            normalized_entropy = entropy / max_entropy

            # 如果熵值接近最大值（>0.95），可能是随机作答
            if normalized_entropy > 0.95:
                return AnomalyDetectionResult(
                    has_anomaly=True,
                    anomaly_type="random",
                    confidence=normalized_entropy,
                    description=f"检测到随机作答模式：回答分布过于均匀（熵值={normalized_entropy:.3f}），可能为随机选择。",
                    affected_questions=[],
                    severity="medium",
                )

        return None


def get_adaptive_difficulty_for_frontend(
    db: Session,
    patient_id: int,
    test_type: str,
) -> dict[str, Any]:
    """
    为前端提供自适应难度配置

    返回前端可以直接使用的难度参数
    """
    service = AdaptiveAssessmentService(db)
    difficulty = service.compute_adaptive_difficulty(patient_id, test_type)

    return {
        "test_type": test_type,
        "difficulty_level": difficulty.difficulty_level,
        "params": {
            "nback": {
                "matchProbability": difficulty.nback_match_probability,
                "gridSize": difficulty.nback_grid_size,
                "backDistance": difficulty.nback_back_distance,
            },
            "stroop": {
                "totalTrials": difficulty.stroop_total_trials,
                "colorCount": difficulty.stroop_color_count,
            },
            "reaction": {
                "minDelayMs": difficulty.reaction_min_delay_ms,
                "maxDelayMs": difficulty.reaction_max_delay_ms,
            },
            "digit": {
                "startLength": difficulty.digit_span_start_length,
            },
        }.get(test_type, {}),
    }


def check_scale_anomalies(
    scale_type: str,
    answers: list[int],
    response_times: list[float] | None = None,
) -> dict[str, Any]:
    """
    为API提供异常检测接口

    返回前端和研究人员端可用的异常报告
    """
    service = AdaptiveAssessmentService(None)  # 不需要数据库
    anomalies = service.detect_answer_anomalies(scale_type, answers, response_times)

    return {
        "has_anomaly": any(a.has_anomaly for a in anomalies),
        "total_anomalies": len(anomalies),
        "anomalies": [
            {
                "type": a.anomaly_type,
                "confidence": a.confidence,
                "description": a.description,
                "affected_questions": a.affected_questions,
                "severity": a.severity,
            }
            for a in anomalies
        ],
        "recommendation": _generate_anomaly_recommendation(anomalies),
    }


def _generate_anomaly_recommendation(anomalies: list[AnomalyDetectionResult]) -> str:
    """根据异常检测结果生成建议"""
    if not anomalies:
        return "回答模式正常，无需特别关注。"

    high_severity = [a for a in anomalies if a.severity == "high"]
    if high_severity:
        return f"检测到{len(high_severity)}个高严重性异常，建议研究人员复核此量表结果。"

    return f"检测到{len(anomalies)}个轻微异常，建议关注但无需立即干预。"
