"""
认知测试自适应难度调整服务

实现认知测试的智能难度调整：
1. 基于表现的实时难度调整
2. n-back、Stroop等测试的自适应算法
3. 精准定位认知边界
4. 减少测试疲劳，提高测量效率
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from enum import Enum
from typing import Any

import numpy as np
from sqlalchemy.orm import Session


class CognitiveTestType(str, Enum):
    NBACK = "nback"  # n-back工作记忆测试
    STROOP = "stroop"  # Stroop注意控制测试
    REACTION = "reaction"  # 反应时测试
    FLANKER = "flanker"  # Flanker干扰抑制测试
    TRAIL = "trail"  # 连线测试


@dataclass
class DifficultyLevel:
    """难度级别参数"""
    level: int  # 难度等级(1-10)
    parameters: dict[str, Any]  # 该难度的具体参数
    success_rate_target: float  # 目标正确率
    information_weight: float  # 信息量权重


@dataclass
class TestPerformance:
    """测试表现数据"""
    accuracy: float  # 正确率
    reaction_time: float  # 平均反应时间(ms)
    consistency: float  # 一致性得分
    difficulty_level: int  # 当前难度
    trials_completed: int  # 完成的试次数


@dataclass
class AdaptiveState:
    """自适应测试状态"""
    patient_id: int
    test_type: CognitiveTestType
    current_difficulty: int  # 当前难度等级
    ability_estimate: float  # 能力估计
    performance_history: list[TestPerformance]  # 表现历史
    target_trials: int  # 目标试次数
    completed_trials: int  # 已完成试次数
    is_completed: bool = False


@dataclass
class TestTrial:
    """测试试次"""
    trial_id: str
    difficulty_level: int
    stimulus: dict[str, Any]  # 刺激参数
    correct_response: str  # 正确反应
    time_limit: float  # 时间限制(ms)


@dataclass
class AdaptiveTestResult:
    """自适应测试结果"""
    patient_id: int
    test_type: CognitiveTestType
    final_ability: float
    final_difficulty: int
    overall_accuracy: float
    average_reaction_time: float
    cognitive_profile: dict[str, float]  # 认知能力画像
    difficulty_curve: list[int]  # 难度变化曲线
    recommendations: list[str]


class AdaptiveCognitiveTestService:
    """认知测试自适应难度调整服务"""

    # n-back测试难度配置
    NBACK_DIFFICULTIES = {
        1: DifficultyLevel(
            level=1,
            parameters={"n": 1, "stimulus_duration": 2000, "delay": 2000, "grid_size": 3},
            success_rate_target=0.85,
            information_weight=1.0,
        ),
        2: DifficultyLevel(
            level=2,
            parameters={"n": 1, "stimulus_duration": 1500, "delay": 1500, "grid_size": 3},
            success_rate_target=0.80,
            information_weight=1.2,
        ),
        3: DifficultyLevel(
            level=3,
            parameters={"n": 2, "stimulus_duration": 2000, "delay": 2000, "grid_size": 3},
            success_rate_target=0.75,
            information_weight=1.5,
        ),
        4: DifficultyLevel(
            level=4,
            parameters={"n": 2, "stimulus_duration": 1500, "delay": 1500, "grid_size": 3},
            success_rate_target=0.70,
            information_weight=1.8,
        ),
        5: DifficultyLevel(
            level=5,
            parameters={"n": 3, "stimulus_duration": 2000, "delay": 2000, "grid_size": 4},
            success_rate_target=0.65,
            information_weight=2.0,
        ),
    }

    # Stroop测试难度配置
    STROOP_DIFFICULTIES = {
        1: DifficultyLevel(
            level=1,
            parameters={
                "congruent_ratio": 1.0,  # 100%一致条件
                "stimulus_duration": 2000,
                "colors": ["red", "blue"],
            },
            success_rate_target=0.90,
            information_weight=1.0,
        ),
        2: DifficultyLevel(
            level=2,
            parameters={
                "congruent_ratio": 0.7,  # 70%一致，30%不一致
                "stimulus_duration": 1800,
                "colors": ["red", "blue", "green"],
            },
            success_rate_target=0.85,
            information_weight=1.3,
        ),
        3: DifficultyLevel(
            level=3,
            parameters={
                "congruent_ratio": 0.5,  # 50%一致，50%不一致
                "stimulus_duration": 1500,
                "colors": ["red", "blue", "green", "yellow"],
            },
            success_rate_target=0.80,
            information_weight=1.6,
        ),
        4: DifficultyLevel(
            level=4,
            parameters={
                "congruent_ratio": 0.3,  # 30%一致，70%不一致
                "stimulus_duration": 1200,
                "colors": ["red", "blue", "green", "yellow", "purple"],
            },
            success_rate_target=0.75,
            information_weight=2.0,
        ),
        5: DifficultyLevel(
            level=5,
            parameters={
                "congruent_ratio": 0.1,  # 10%一致，90%不一致
                "stimulus_duration": 1000,
                "colors": ["red", "blue", "green", "yellow", "purple", "orange"],
            },
            success_rate_target=0.70,
            information_weight=2.5,
        ),
    }

    def __init__(self, db: Session):
        self.db = db

    def start_adaptive_test(
        self,
        patient_id: int,
        test_type: CognitiveTestType,
        initial_difficulty: int = 3,
    ) -> TestTrial:
        """开始自适应认知测试"""
        # 初始化自适应状态
        adaptive_state = AdaptiveState(
            patient_id=patient_id,
            test_type=test_type,
            current_difficulty=initial_difficulty,
            ability_estimate=0.0,
            performance_history=[],
            target_trials=20,  # 目标20个试次
            completed_trials=0,
        )

        # 保存状态
        self._save_adaptive_state(adaptive_state)

        # 生成第一个试次
        first_trial = self._generate_trial(adaptive_state)
        return first_trial

    def submit_trial_result(
        self,
        patient_id: int,
        trial_id: str,
        is_correct: bool,
        reaction_time: float,
    ) -> TestTrial | AdaptiveTestResult:
        """提交试次结果并返回下一试次或最终结果"""
        # 获取自适应状态
        adaptive_state = self._load_adaptive_state(patient_id)
        if not adaptive_state:
            raise ValueError("未找到测试状态，请重新开始测试。")

        # 记录表现
        performance = TestPerformance(
            accuracy=1.0 if is_correct else 0.0,
            reaction_time=reaction_time,
            consistency=self._calculate_consistency(adaptive_state),
            difficulty_level=adaptive_state.current_difficulty,
            trials_completed=1,
        )
        adaptive_state.performance_history.append(performance)
        adaptive_state.completed_trials += 1

        # 更新难度
        self._adjust_difficulty(adaptive_state)

        # 更新能力估计
        self._update_ability_estimate(adaptive_state, is_correct, reaction_time)

        # 检查是否完成
        if self._should_terminate_test(adaptive_state):
            result = self._generate_test_result(adaptive_state)
            self._save_test_result(result)
            return result

        # 生成下一试次
        next_trial = self._generate_trial(adaptive_state)
        self._save_adaptive_state(adaptive_state)
        return next_trial

    def _adjust_difficulty(self, adaptive_state: AdaptiveState) -> None:
        """基于表现调整难度"""
        if len(adaptive_state.performance_history) < 3:
            return  # 需要足够的数据

        # 获取最近3次的表现
        recent_performances = adaptive_state.performance_history[-3:]
        recent_accuracy = np.mean([p.accuracy for p in recent_performances])
        recent_rt = np.mean([p.reaction_time for p in recent_performances])

        # 获取当前难度配置
        difficulty_config = self._get_difficulty_config(
            adaptive_state.test_type, adaptive_state.current_difficulty
        )
        if not difficulty_config:
            return

        target_accuracy = difficulty_config.success_rate_target

        # 基于正确率调整难度
        if recent_accuracy > target_accuracy + 0.15:
            # 表现远超目标，增加难度
            adaptive_state.current_difficulty = min(
                adaptive_state.current_difficulty + 1,
                self._get_max_difficulty(adaptive_state.test_type)
            )
        elif recent_accuracy < target_accuracy - 0.15:
            # 表现远低于目标，降低难度
            adaptive_state.current_difficulty = max(adaptive_state.current_difficulty - 1, 1)

        # 基于反应时间的微调
        if recent_rt < 300:  # 反应过快，可能在猜测
            adaptive_state.current_difficulty = min(
                adaptive_state.current_difficulty + 1,
                self._get_max_difficulty(adaptive_state.test_type)
            )
        elif recent_rt > 2000:  # 反应过慢，可能难度过高
            adaptive_state.current_difficulty = max(adaptive_state.current_difficulty - 1, 1)

    def _update_ability_estimate(
        self,
        adaptive_state: AdaptiveState,
        is_correct: bool,
        reaction_time: float,
    ) -> None:
        """更新能力估计（基于IRT模型）"""
        # 简化的能力估计更新
        difficulty = adaptive_state.current_difficulty
        ability = adaptive_state.ability_estimate

        # 正确回答增加能力估计
        if is_correct:
            # 难度越高，正确回答带来的能力提升越大
            ability_gain = 0.1 * difficulty / 5.0
            adaptive_state.ability_estimate += ability_gain
        else:
            # 错误回答降低能力估计
            ability_loss = 0.05 * difficulty / 5.0
            adaptive_state.ability_estimate -= ability_loss

        # 考虑反应时间的影响
        expected_rt = self._get_expected_reaction_time(difficulty)
        rt_ratio = reaction_time / expected_rt

        if rt_ratio < 0.5:  # 反应过快
            adaptive_state.ability_estimate -= 0.05
        elif rt_ratio > 2.0:  # 反应过慢
            adaptive_state.ability_estimate -= 0.03

        # 限制能力估计范围
        adaptive_state.ability_estimate = max(-3.0, min(3.0, adaptive_state.ability_estimate))

    def _generate_trial(self, adaptive_state: AdaptiveState) -> TestTrial:
        """生成测试试次"""
        difficulty_config = self._get_difficulty_config(
            adaptive_state.test_type, adaptive_state.current_difficulty
        )
        if not difficulty_config:
            difficulty_config = self._get_difficulty_config(adaptive_state.test_type, 3)

        trial_id = f"{adaptive_state.test_type.value}_{adaptive_state.completed_trials + 1}"

        if adaptive_state.test_type == CognitiveTestType.NBACK:
            stimulus = self._generate_nback_stimulus(difficulty_config.parameters)
            correct_response = "match" if random.random() < 0.3 else "no_match"
        elif adaptive_state.test_type == CognitiveTestType.STROOP:
            stimulus = self._generate_stroop_stimulus(difficulty_config.parameters)
            correct_response = "color"  # 说出颜色
        else:
            stimulus = {"type": "generic", "difficulty": adaptive_state.current_difficulty}
            correct_response = "respond"

        return TestTrial(
            trial_id=trial_id,
            difficulty_level=adaptive_state.current_difficulty,
            stimulus=stimulus,
            correct_response=correct_response,
            time_limit=difficulty_config.parameters.get("stimulus_duration", 2000),
        )

    def _generate_nback_stimulus(self, params: dict[str, Any]) -> dict[str, Any]:
        """生成n-back刺激"""
        grid_size = params.get("grid_size", 3)
        n = params.get("n", 1)

        # 随机生成位置
        position = {
            "x": random.randint(0, grid_size - 1),
            "y": random.randint(0, grid_size - 1),
        }

        return {
            "type": "nback",
            "position": position,
            "grid_size": grid_size,
            "n": n,
            "stimulus_duration": params.get("stimulus_duration", 2000),
            "delay": params.get("delay", 2000),
        }

    def _generate_stroop_stimulus(self, params: dict[str, Any]) -> dict[str, Any]:
        """生成Stroop刺激"""
        colors = params.get("colors", ["red", "blue", "green"])
        congruent_ratio = params.get("congruent_ratio", 0.5)

        # 决定是否为一致条件
        is_congruent = random.random() < congruent_ratio

        # 选择文字颜色
        text_color = random.choice(colors)
        # 选择语义
        if is_congruent:
            semantic_color = text_color
        else:
            available_colors = [c for c in colors if c != text_color]
            semantic_color = random.choice(available_colors) if available_colors else text_color

        return {
            "type": "stroop",
            "text": semantic_color.upper(),
            "display_color": text_color,
            "is_congruent": is_congruent,
            "stimulus_duration": params.get("stimulus_duration", 1500),
            "colors": colors,
        }

    def _calculate_consistency(self, adaptive_state: AdaptiveState) -> float:
        """计算表现一致性"""
        if len(adaptive_state.performance_history) < 2:
            return 1.0

        # 计算反应时间的一致性（变异系数的倒数）
        recent_rts = [p.reaction_time for p in adaptive_state.performance_history[-5:]]
        if len(recent_rts) < 2:
            return 1.0

        mean_rt = np.mean(recent_rts)
        std_rt = np.std(recent_rts)

        if mean_rt == 0:
            return 1.0

        cv = std_rt / mean_rt  # 变异系数
        consistency = 1.0 / (1.0 + cv)  # 一致性得分

        return max(0.0, min(1.0, consistency))

    def _get_expected_reaction_time(self, difficulty: int) -> float:
        """获取预期反应时间"""
        # 难度越高，预期反应时间越长
        base_rt = 500  # 基础反应时间(ms)
        difficulty_factor = 1.0 + (difficulty - 1) * 0.2
        return base_rt * difficulty_factor

    def _should_terminate_test(self, adaptive_state: AdaptiveState) -> bool:
        """判断是否应该终止测试"""
        # 条件1：达到目标试次数
        if adaptive_state.completed_trials >= adaptive_state.target_trials:
            return True

        # 条件2：连续5次在最低难度且正确率>90%
        if adaptive_state.current_difficulty <= 1:
            recent_performances = adaptive_state.performance_history[-5:]
            if len(recent_performances) >= 5:
                recent_accuracy = np.mean([p.accuracy for p in recent_performances])
                if recent_accuracy > 0.9:
                    return True

        # 条件3：连续5次在最高难度且正确率<50%
        max_difficulty = self._get_max_difficulty(adaptive_state.test_type)
        if adaptive_state.current_difficulty >= max_difficulty:
            recent_performances = adaptive_state.performance_history[-5:]
            if len(recent_performances) >= 5:
                recent_accuracy = np.mean([p.accuracy for p in recent_performances])
                if recent_accuracy < 0.5:
                    return True

        return False

    def _generate_test_result(self, adaptive_state: AdaptiveState) -> AdaptiveTestResult:
        """生成测试结果"""
        # 计算整体表现
        all_performances = adaptive_state.performance_history
        overall_accuracy = np.mean([p.accuracy for p in all_performances])
        average_reaction_time = np.mean([p.reaction_time for p in all_performances])

        # 生成认知能力画像
        cognitive_profile = self._generate_cognitive_profile(adaptive_state)

        # 提取难度曲线
        difficulty_curve = [p.difficulty_level for p in all_performances]

        # 生成建议
        recommendations = self._generate_recommendations(
            adaptive_state, overall_accuracy, average_reaction_time
        )

        return AdaptiveTestResult(
            patient_id=adaptive_state.patient_id,
            test_type=adaptive_state.test_type,
            final_ability=adaptive_state.ability_estimate,
            final_difficulty=adaptive_state.current_difficulty,
            overall_accuracy=overall_accuracy,
            average_reaction_time=average_reaction_time,
            cognitive_profile=cognitive_profile,
            difficulty_curve=difficulty_curve,
            recommendations=recommendations,
        )

    def _generate_cognitive_profile(self, adaptive_state: AdaptiveState) -> dict[str, float]:
        """生成认知能力画像"""
        profile = {}

        # 基于最终能力估计
        profile["overall_ability"] = adaptive_state.ability_estimate

        # 基于难度曲线分析
        difficulty_curve = [p.difficulty_level for p in adaptive_state.performance_history]
        if len(difficulty_curve) >= 3:
            # 分析难度适应速度
            early_avg = np.mean(difficulty_curve[:len(difficulty_curve)//3])
            late_avg = np.mean(difficulty_curve[-len(difficulty_curve)//3:])
            profile["adaptation_speed"] = (late_avg - early_avg) / max(early_avg, 1)

        # 基于反应时间分析
        reaction_times = [p.reaction_time for p in adaptive_state.performance_history]
        profile["processing_speed"] = 1000.0 / np.mean(reaction_times)  # 速度指标

        # 基于一致性分析
        consistencies = [p.consistency for p in adaptive_state.performance_history]
        profile["consistency"] = np.mean(consistencies)

        return profile

    def _generate_recommendations(
        self,
        adaptive_state: AdaptiveState,
        accuracy: float,
        reaction_time: float,
    ) -> list[str]:
        """生成个性化建议"""
        recommendations = []

        if adaptive_state.test_type == CognitiveTestType.NBACK:
            if accuracy < 0.6:
                recommendations.append("工作记忆需要加强，建议每天练习5分钟的记忆游戏")
            if reaction_time > 1500:
                recommendations.append("信息处理速度较慢，可以尝试快速阅读练习")

        elif adaptive_state.test_type == CognitiveTestType.STROOP:
            if accuracy < 0.7:
                recommendations.append("注意力控制需要改善，建议练习专注力冥想")
            if adaptive_state.ability_estimate < -1:
                recommendations.append("抑制控制能力较弱，可以尝试延迟满足训练")

        # 通用建议
        if adaptive_state.ability_estimate < -0.5:
            recommendations.append("建议增加认知训练的频率，每周至少3次")

        return recommendations[:3]

    def _get_difficulty_config(
        self,
        test_type: CognitiveTestType,
        difficulty: int,
    ) -> DifficultyLevel | None:
        """获取难度配置"""
        if test_type == CognitiveTestType.NBACK:
            return self.NBACK_DIFFICULTIES.get(difficulty)
        elif test_type == CognitiveTestType.STROOP:
            return self.STROOP_DIFFICULTIES.get(difficulty)
        else:
            # 通用难度配置
            return DifficultyLevel(
                level=difficulty,
                parameters={"difficulty": difficulty},
                success_rate_target=0.75,
                information_weight=1.0,
            )

    def _get_max_difficulty(self, test_type: CognitiveTestType) -> int:
        """获取最大难度等级"""
        if test_type == CognitiveTestType.NBACK:
            return len(self.NBACK_DIFFICULTIES)
        elif test_type == CognitiveTestType.STROOP:
            return len(self.STROOP_DIFFICULTIES)
        else:
            return 5

    def _save_adaptive_state(self, state: AdaptiveState) -> None:
        """保存自适应状态"""
        pass

    def _load_adaptive_state(self, patient_id: int) -> AdaptiveState | None:
        """加载自适应状态"""
        return AdaptiveState(
            patient_id=patient_id,
            test_type=CognitiveTestType.NBACK,
            current_difficulty=3,
            ability_estimate=0.0,
            performance_history=[],
            target_trials=20,
            completed_trials=0,
        )

    def _save_test_result(self, result: AdaptiveTestResult) -> None:
        """保存测试结果"""
        pass