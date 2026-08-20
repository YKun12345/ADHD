"""
异常模式自动标记系统

实现量表和认知测试中的异常回答模式检测：
1. 矛盾作答检测 - 识别逻辑矛盾的回答
2. 规律性作答检测 - 识别机械性规律回答模式
3. 过快作答检测 - 识别不合理的快速回答
4. 极端作答检测 - 识别极端倾向的回答模式
5. 一致性检测 - 识别回答内部不一致
"""

from __future__ import annotations

import math
import statistics
from collections import Counter
from dataclasses import dataclass
from enum import Enum
from typing import Any

import numpy as np


class AnomalyType(str, Enum):
    CONTRADICTION = "contradiction"  # 矛盾作答
    PATTERN = "pattern"  # 规律性作答
    SPEED = "speed"  # 过快作答
    EXTREME = "extreme"  # 极端作答
    INCONSISTENCY = "inconsistency"  # 不一致作答
    RANDOM = "random"  # 随机作答


class Severity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass
class AnomalyResult:
    """异常检测结果"""
    anomaly_type: AnomalyType
    severity: Severity
    confidence: float  # 0-1
    description: str
    affected_questions: list[int]
    details: dict[str, Any]


@dataclass
class ScaleAnomalyReport:
    """量表异常报告"""
    has_anomaly: bool
    anomalies: list[AnomalyResult]
    overall_reliability: float  # 0-1，整体可信度
    recommendation: str
    should_flag_for_review: bool


class AnomalyDetectionService:
    """异常模式自动标记服务"""

    # ASRS量表的矛盾对
    ASRS_CONTRADICTION_PAIRS = [
        (0, 7),  # 注意力控制 vs 任务启动
        (1, 8),  # 持续注意力 vs 听觉注意力
        (3, 10), # 组织管理 vs 任务启动
        (11, 14), # 多动 vs 冲动
    ]

    # SNAP-IV量表的矛盾对
    SNAP_CONTRADICTION_PAIRS = [
        (0, 9),   # 注意力 vs 多动
        (2, 11),  # 注意力 vs 多动
        (5, 14),  # 注意力 vs 多动
    ]

    def detect_scale_anomalies(
        self,
        scale_type: str,
        answers: list[int],
        response_times: list[float] | None = None,
        question_difficulties: list[float] | None = None,
    ) -> ScaleAnomalyReport:
        """
        检测量表回答中的异常模式

        参数：
        - scale_type: 量表类型 (ASRS, SNAP_IV)
        - answers: 回答列表
        - response_times: 每题回答时间(ms)
        - question_difficulties: 题目难度列表

        返回：
        - 异常检测报告
        """
        anomalies = []

        # 1. 矛盾作答检测
        contradiction_anomaly = self._detect_contradictions(scale_type, answers)
        if contradiction_anomaly:
            anomalies.append(contradiction_anomaly)

        # 2. 规律性作答检测
        pattern_anomaly = self._detect_patterns(answers)
        if pattern_anomaly:
            anomalies.append(pattern_anomaly)

        # 3. 过快作答检测
        if response_times:
            speed_anomaly = self._detect_speed_anomalies(response_times, answers)
            if speed_anomaly:
                anomalies.append(speed_anomaly)

        # 4. 极端作答检测
        extreme_anomaly = self._detect_extreme_responses(answers)
        if extreme_anomaly:
            anomalies.append(extreme_anomaly)

        # 5. 一致性检测
        consistency_anomaly = self._detect_inconsistencies(answers)
        if consistency_anomaly:
            anomalies.append(consistency_anomaly)

        # 6. 随机作答检测
        random_anomaly = self._detect_random_responses(answers)
        if random_anomaly:
            anomalies.append(random_anomaly)

        # 计算整体可信度
        reliability = self._calculate_reliability(anomalies, len(answers))

        # 判断是否需要人工复核
        should_flag = any(
            a.severity in [Severity.HIGH, Severity.MEDIUM] and a.confidence > 0.7
            for a in anomalies
        )

        # 生成建议
        recommendation = self._generate_recommendation(anomalies, reliability)

        return ScaleAnomalyReport(
            has_anomaly=len(anomalies) > 0,
            anomalies=anomalies,
            overall_reliability=reliability,
            recommendation=recommendation,
            should_flag_for_review=should_flag,
        )

    def _detect_contradictions(
        self,
        scale_type: str,
        answers: list[int],
    ) -> AnomalyResult | None:
        """检测矛盾作答"""
        if scale_type == "ASRS":
            pairs = self.ASRS_CONTRADICTION_PAIRS
        elif scale_type == "SNAP_IV":
            pairs = self.SNAP_CONTRADICTION_PAIRS
        else:
            return None

        contradictions = []
        details = []

        for i, j in pairs:
            if i < len(answers) and j < len(answers):
                # 检查是否回答差异过大（如一个0分一个4分）
                diff = abs(answers[i] - answers[j])
                if diff >= 3:  # 差异过大
                    contradictions.extend([i, j])
                    details.append({
                        "question_pair": [i, j],
                        "answers": [answers[i], answers[j]],
                        "difference": diff,
                    })

        if contradictions:
            confidence = min(1.0, len(contradictions) / (len(pairs) * 2))
            severity = Severity.HIGH if confidence > 0.6 else Severity.MEDIUM

            return AnomalyResult(
                anomaly_type=AnomalyType.CONTRADICTION,
                severity=severity,
                confidence=confidence,
                description=f"检测到{len(contradictions)//2}对矛盾作答，回答逻辑不一致",
                affected_questions=list(set(contradictions)),
                details={"contradiction_pairs": details},
            )

        return None

    def _detect_patterns(self, answers: list[int]) -> AnomalyResult | None:
        """检测规律性作答（如全选同一选项）"""
        if len(answers) < 5:
            return None

        # 统计各选项频率
        counter = Counter(answers)
        total = len(answers)

        # 检查是否有选项占比过高
        for value, count in counter.items():
            ratio = count / total
            if ratio > 0.8:  # 超过80%选择同一选项
                confidence = ratio
                severity = Severity.HIGH if ratio > 0.9 else Severity.MEDIUM

                return AnomalyResult(
                    anomaly_type=AnomalyType.PATTERN,
                    severity=severity,
                    confidence=confidence,
                    description=f"检测到规律性作答，{ratio:.0%}的题目选择了同一选项",
                    affected_questions=[i for i, a in enumerate(answers) if a == value],
                    details={
                        "dominant_value": value,
                        "dominant_ratio": ratio,
                        "distribution": dict(counter),
                    },
                )

        # 检查交替模式（如0,4,0,4,0,4）
        if len(answers) >= 6:
            alternating_count = 0
            for i in range(2, len(answers)):
                if answers[i] == answers[i-2] and answers[i] != answers[i-1]:
                    alternating_count += 1

            alternating_ratio = alternating_count / (len(answers) - 2)
            if alternating_ratio > 0.7:
                return AnomalyResult(
                    anomaly_type=AnomalyType.PATTERN,
                    severity=Severity.MEDIUM,
                    confidence=alternating_ratio,
                    description="检测到交替规律作答模式",
                    affected_questions=list(range(len(answers))),
                    details={"alternating_ratio": alternating_ratio},
                )

        return None

    def _detect_speed_anomalies(
        self,
        response_times: list[float],
        answers: list[int],
    ) -> AnomalyResult | None:
        """检测过快作答"""
        if len(response_times) < 3:
            return None

        # 计算统计指标
        mean_time = statistics.mean(response_times)
        std_time = statistics.stdev(response_times) if len(response_times) > 1 else 0

        # 检测过快回答（低于平均值2个标准差或低于500ms）
        fast_threshold = max(500, mean_time - 2 * std_time)
        fast_questions = [
            i for i, t in enumerate(response_times)
            if t < fast_threshold
        ]

        if fast_questions:
            fast_ratio = len(fast_questions) / len(response_times)
            confidence = min(1.0, fast_ratio * 2)

            severity = Severity.HIGH if fast_ratio > 0.5 else Severity.MEDIUM

            return AnomalyResult(
                anomaly_type=AnomalyType.SPEED,
                severity=severity,
                confidence=confidence,
                description=f"检测到{len(fast_questions)}道题目回答过快（<{fast_threshold:.0f}ms）",
                affected_questions=fast_questions,
                details={
                    "fast_threshold_ms": fast_threshold,
                    "mean_response_time_ms": mean_time,
                    "fast_ratio": fast_ratio,
                    "fast_questions_times": [response_times[i] for i in fast_questions],
                },
            )

        return None

    def _detect_extreme_responses(self, answers: list[int]) -> AnomalyResult | None:
        """检测极端作答"""
        if len(answers) < 5:
            return None

        # 统计极端回答（0或最高分）
        max_value = max(answers) if answers else 4
        extreme_values = [0, max_value]
        extreme_count = sum(1 for a in answers if a in extreme_values)
        extreme_ratio = extreme_count / len(answers)

        if extreme_ratio > 0.7:  # 超过70%极端回答
            # 检查是正向极端还是负向极端
            zero_count = sum(1 for a in answers if a == 0)
            max_count = sum(1 for a in answers if a == max_value)

            extreme_type = "全否定" if zero_count > max_count else "全肯定"

            return AnomalyResult(
                anomaly_type=AnomalyType.EXTREME,
                severity=Severity.MEDIUM,
                confidence=extreme_ratio,
                description=f"检测到{extreme_type}倾向，{extreme_ratio:.0%}为极端回答",
                affected_questions=[i for i, a in enumerate(answers) if a in extreme_values],
                details={
                    "extreme_ratio": extreme_ratio,
                    "zero_ratio": zero_count / len(answers),
                    "max_ratio": max_count / len(answers),
                    "extreme_type": extreme_type,
                },
            )

        return None

    def _detect_inconsistencies(self, answers: list[int]) -> AnomalyResult | None:
        """检测回答不一致性"""
        if len(answers) < 8:
            return None

        # 将量表分为前后两半，检查是否一致
        mid = len(answers) // 2
        first_half = answers[:mid]
        second_half = answers[mid:]

        # 计算两半的平均分差异
        mean_first = statistics.mean(first_half)
        mean_second = statistics.mean(second_half)

        # 计算标准差
        std_all = statistics.stdev(answers) if len(answers) > 1 else 1

        # 如果两半差异超过2个标准差，认为不一致
        if std_all > 0 and abs(mean_first - mean_second) > 2 * std_all:
            inconsistency_score = abs(mean_first - mean_second) / std_all
            confidence = min(1.0, inconsistency_score / 4)

            return AnomalyResult(
                anomaly_type=AnomalyType.INCONSISTENCY,
                severity=Severity.MEDIUM,
                confidence=confidence,
                description="检测到回答前后不一致，前半部分与后半部分差异较大",
                affected_questions=list(range(len(answers))),
                details={
                    "first_half_mean": mean_first,
                    "second_half_mean": mean_second,
                    "inconsistency_score": inconsistency_score,
                    "std_dev": std_all,
                },
            )

        return None

    def _detect_random_responses(self, answers: list[int]) -> AnomalyResult | None:
        """检测随机作答"""
        if len(answers) < 10:
            return None

        # 计算信息熵
        counter = Counter(answers)
        total = len(answers)
        entropy = 0.0
        for count in counter.values():
            p = count / total
            if p > 0:
                entropy -= p * math.log2(p)

        # 计算最大可能熵
        max_entropy = math.log2(len(counter)) if counter else 1

        # 如果熵接近最大值，可能是随机作答
        if max_entropy > 0:
            entropy_ratio = entropy / max_entropy

            # 检查自相关性（随机序列自相关性低）
            autocorr = self._calculate_autocorrelation(answers)

            # 随机作答特征：高熵 + 低自相关
            if entropy_ratio > 0.9 and abs(autocorr) < 0.2:
                confidence = (entropy_ratio + (1 - abs(autocorr))) / 2

                return AnomalyResult(
                    anomaly_type=AnomalyType.RANDOM,
                    severity=Severity.HIGH,
                    confidence=confidence,
                    description="检测到可能的随机作答模式",
                    affected_questions=list(range(len(answers))),
                    details={
                        "entropy_ratio": entropy_ratio,
                        "autocorrelation": autocorr,
                        "distribution": dict(counter),
                    },
                )

        return None

    def _calculate_autocorrelation(self, series: list[int]) -> float:
        """计算一阶自相关系数"""
        if len(series) < 3:
            return 0.0

        n = len(series)
        mean_val = statistics.mean(series)

        # 计算分子和分母
        numerator = sum(
            (series[i] - mean_val) * (series[i+1] - mean_val)
            for i in range(n-1)
        )
        denominator = sum((x - mean_val) ** 2 for x in series)

        if denominator == 0:
            return 0.0

        return numerator / denominator

    def _calculate_reliability(
        self,
        anomalies: list[AnomalyResult],
        total_questions: int,
    ) -> float:
        """计算整体可信度"""
        if total_questions == 0:
            return 1.0

        # 基础可信度
        reliability = 1.0

        # 根据异常严重程度扣分
        for anomaly in anomalies:
            if anomaly.severity == Severity.HIGH:
                reliability -= 0.3 * anomaly.confidence
            elif anomaly.severity == Severity.MEDIUM:
                reliability -= 0.15 * anomaly.confidence
            else:  # LOW
                reliability -= 0.05 * anomaly.confidence

        return max(0.0, min(1.0, reliability))

    def _generate_recommendation(
        self,
        anomalies: list[AnomalyResult],
        reliability: float,
    ) -> str:
        """生成异常检测建议"""
        if not anomalies:
            return "未检测到明显异常模式，量表回答可信度较高。"

        high_severity = [a for a in anomalies if a.severity == Severity.HIGH]
        medium_severity = [a for a in anomalies if a.severity == Severity.MEDIUM]

        recommendations = []

        if high_severity:
            anomaly_names = [a.anomaly_type.value for a in high_severity]
            recommendations.append(
                f"检测到高风险异常（{', '.join(anomaly_names)}），建议重新评估或人工复核。"
            )

        if reliability < 0.6:
            recommendations.append(
                f"量表可信度较低（{reliability:.0%}），结果需谨慎解读。"
            )

        if medium_severity:
            recommendations.append(
                "存在中等风险异常，建议结合其他评估工具综合判断。"
            )

        if not recommendations:
            recommendations.append("存在轻微异常，整体可信度尚可。")

        return " ".join(recommendations)


def detect_cognitive_test_anomalies(
    test_type: str,
    results: dict[str, Any],
    historical_results: list[dict[str, Any]] | None = None,
) -> list[AnomalyResult]:
    """
    检测认知测试结果中的异常

    参数：
    - test_type: 测试类型
    - results: 当前测试结果
    - historical_results: 历史测试结果

    返回：
    - 异常列表
    """
    anomalies = []

    # 检测反应时间异常
    if test_type in ["reaction", "stroop", "flanker"]:
        rt = results.get("average_reaction_time_ms")
        if rt is not None:
            if rt < 150:  # 反应过快，可能是预判
                anomalies.append(AnomalyResult(
                    anomaly_type=AnomalyType.SPEED,
                    severity=Severity.MEDIUM,
                    confidence=0.8,
                    description="反应时间过快，可能存在预判行为",
                    affected_questions=[],
                    details={"reaction_time_ms": rt, "threshold_ms": 150},
                ))
            elif rt > 3000:  # 反应过慢
                anomalies.append(AnomalyResult(
                    anomaly_type=AnomalyType.SPEED,
                    severity=Severity.LOW,
                    confidence=0.6,
                    description="反应时间偏慢，可能存在注意力分散",
                    affected_questions=[],
                    details={"reaction_time_ms": rt, "threshold_ms": 3000},
                ))

    # 检测准确率异常
    accuracy = results.get("accuracy")
    if accuracy is not None:
        if accuracy < 0.2:  # 准确率过低
            anomalies.append(AnomalyResult(
                anomaly_type=AnomalyType.RANDOM,
                severity=Severity.HIGH,
                confidence=0.9,
                description="准确率过低，可能为随机作答",
                affected_questions=[],
                details={"accuracy": accuracy, "threshold": 0.2},
            ))
        elif accuracy > 0.99:  # 准确率过高
            anomalies.append(AnomalyResult(
                anomaly_type=AnomalyType.PATTERN,
                severity=Severity.MEDIUM,
                confidence=0.7,
                description="准确率异常高，可能存在策略性作答",
                affected_questions=[],
                details={"accuracy": accuracy, "threshold": 0.99},
            ))

    # 与历史数据对比
    if historical_results and len(historical_results) >= 3:
        # 检测表现突变
        historical_accuracy = [h.get("accuracy", 0.5) for h in historical_results if h.get("accuracy")]
        if historical_accuracy and accuracy is not None:
            mean_historical = statistics.mean(historical_accuracy)
            std_historical = statistics.stdev(historical_accuracy) if len(historical_accuracy) > 1 else 0.1

            if std_historical > 0:
                z_score = abs(accuracy - mean_historical) / std_historical
                if z_score > 3:  # 3个标准差之外
                    anomalies.append(AnomalyResult(
                        anomaly_type=AnomalyType.INCONSISTENCY,
                        severity=Severity.MEDIUM,
                        confidence=min(1.0, z_score / 5),
                        description="与历史表现差异较大，可能存在状态波动",
                        affected_questions=[],
                        details={
                            "current_accuracy": accuracy,
                            "historical_mean": mean_historical,
                            "z_score": z_score,
                        },
                    ))

    return anomalies