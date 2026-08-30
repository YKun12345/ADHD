"""
计算机自适应测试(CAT)服务

实现智能量表自适应调整功能：
1. 基于项目反应理论(IRT)的题目难度估计
2. 动态调整后续问题难度和方向
3. 最大化信息量的题目选择策略
4. 减少评估疲劳，提高测量精度
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Any

from sqlalchemy.orm import Session


class ScaleType(str, Enum):
    ASRS = "ASRS"  # 成人ADHD自评量表
    SNAP_IV = "SNAP_IV"  # 儿童ADHD评定量表


@dataclass
class IRTParameters:
    """IRT三参数逻辑斯蒂模型参数"""
    difficulty: float  # b参数：题目难度
    discrimination: float  # a参数：题目区分度
    guessing: float  # c参数：猜测参数


@dataclass
class ItemInfo:
    """题目信息"""
    item_id: str
    dimension: str
    text: str
    options: list[dict[str, Any]]
    irt_params: IRTParameters
    is_used: bool = False


@dataclass
class CATState:
    """CAT测试状态"""
    patient_id: int
    scale_type: ScaleType
    current_theta: float  # 当前能力估计
    theta_se: float  # 能力估计的标准误
    items_used: list[str]  # 已使用的题目ID
    responses: list[dict[str, Any]]  # 用户回答记录
    current_dimension: str  # 当前评估维度
    dimension_scores: dict[str, float]  # 各维度得分
    is_completed: bool = False


@dataclass
class CATQuestion:
    """CAT题目响应"""
    question_id: str
    dimension: str
    text: str
    options: list[dict[str, Any]]
    question_number: int
    total_estimated: int
    confidence_level: float  # 当前估计置信度


@dataclass
class CATResult:
    """CAT测试结果"""
    patient_id: int
    scale_type: ScaleType
    total_score: float
    dimension_scores: dict[str, float]
    risk_level: str
    theta_estimate: float
    standard_error: float
    items_administered: int
    completion_reason: str
    recommendations: list[str]


class AdaptiveScaleService:
    """计算机自适应测试服务"""

    # ASRS量表题目IRT参数（基于文献和临床数据）
    ASRS_ITEMS = {
        "attention_control": [
            ItemInfo(
                item_id="asrs_1",
                dimension="attention_control",
                text="在完成工作或家务时，您有多经常忽略细节而犯错？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=0.2, discrimination=1.1, guessing=0.1),
            ),
            ItemInfo(
                item_id="asrs_2",
                dimension="attention_control",
                text="您有多经常在持续注意力任务中感到困难？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=0.5, discrimination=1.3, guessing=0.1),
            ),
            ItemInfo(
                item_id="asrs_3",
                dimension="attention_control",
                text="您有多经常在听别人说话时显得心不在焉？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=-0.1, discrimination=0.9, guessing=0.15),
            ),
        ],
        "organization": [
            ItemInfo(
                item_id="asrs_4",
                dimension="organization",
                text="您有多经常难以组织任务和活动？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=0.3, discrimination=1.2, guessing=0.1),
            ),
            ItemInfo(
                item_id="asrs_5",
                dimension="organization",
                text="您有多经常回避需要持续脑力劳动的任务？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=0.6, discrimination=1.0, guessing=0.12),
            ),
        ],
        "hyperactivity": [
            ItemInfo(
                item_id="asrs_6",
                dimension="hyperactivity",
                text="您有多经常坐立不安或感到烦躁？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=0.0, discrimination=1.4, guessing=0.08),
            ),
            ItemInfo(
                item_id="asrs_7",
                dimension="hyperactivity",
                text="您有多经常在不适当的场合过度活跃？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=0.8, discrimination=1.1, guessing=0.1),
            ),
        ],
        "impulsivity": [
            ItemInfo(
                item_id="asrs_8",
                dimension="impulsivity",
                text="您有多经常在别人话还没说完就插嘴？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=0.4, discrimination=1.2, guessing=0.1),
            ),
            ItemInfo(
                item_id="asrs_9",
                dimension="impulsivity",
                text="您有多经常难以等待轮到自己？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=0.2, discrimination=1.3, guessing=0.12),
            ),
        ],
        "emotional_regulation": [
            ItemInfo(
                item_id="asrs_10",
                dimension="emotional_regulation",
                text="您有多经常感到情绪波动很大？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=0.1, discrimination=1.1, guessing=0.1),
            ),
            ItemInfo(
                item_id="asrs_11",
                dimension="emotional_regulation",
                text="您有多经常因为小事而感到沮丧或愤怒？",
                options=[
                    {"value": 0, "text": "从不", "score": 0},
                    {"value": 1, "text": "很少", "score": 1},
                    {"value": 2, "text": "有时", "score": 2},
                    {"value": 3, "text": "经常", "score": 3},
                    {"value": 4, "text": "总是", "score": 4},
                ],
                irt_params=IRTParameters(difficulty=0.5, discrimination=1.0, guessing=0.15),
            ),
        ],
    }

    def __init__(self, db: Session):
        self.db = db

    def start_adaptive_scale(
        self,
        patient_id: int,
        scale_type: ScaleType = ScaleType.ASRS,
    ) -> CATQuestion:
        """开始自适应量表评估"""
        # 初始化CAT状态
        cat_state = CATState(
            patient_id=patient_id,
            scale_type=scale_type,
            current_theta=0.0,  # 初始能力估计为0（平均水平）
            theta_se=2.0,  # 初始标准误较大
            items_used=[],
            responses=[],
            current_dimension="attention_control",
            dimension_scores={},
        )

        # 保存初始状态
        self._save_cat_state(cat_state)

        # 选择第一道题目
        first_question = self._select_next_question(cat_state)
        return first_question

    def submit_answer(
        self,
        patient_id: int,
        question_id: str,
        answer_value: int,
    ) -> CATQuestion | CATResult:
        """提交答案并返回下一题或结果"""
        # 获取CAT状态
        cat_state = self._load_cat_state(patient_id)
        if not cat_state:
            raise ValueError("未找到CAT测试状态，请重新开始评估。")

        # 记录回答
        response = {
            "question_id": question_id,
            "answer_value": answer_value,
            "timestamp": self._get_current_timestamp(),
        }
        cat_state.responses.append(response)
        cat_state.items_used.append(question_id)

        # 更新能力估计
        self._update_theta_estimate(cat_state, question_id, answer_value)

        # 检查是否结束测试
        if self._should_terminate(cat_state):
            result = self._generate_result(cat_state)
            self._save_cat_result(result)
            return result

        # 选择下一题
        next_question = self._select_next_question(cat_state)
        self._save_cat_state(cat_state)
        return next_question

    def _update_theta_estimate(
        self,
        cat_state: CATState,
        item_id: str,
        response: int,
    ) -> None:
        """使用极大似然估计更新能力参数"""
        # 找到对应题目
        item = self._find_item_by_id(item_id)
        if not item:
            return

        # IRT三参数逻辑斯蒂模型
        a = item.irt_params.discrimination
        b = item.irt_params.difficulty
        c = item.irt_params.guessing

        theta = cat_state.current_theta

        # 计算概率
        exp_term = math.exp(a * (theta - b))
        p = c + (1 - c) * exp_term / (1 + exp_term)

        # 计算信息量
        info = self._compute_item_information(a, b, c, theta)

        # 更新能力估计（简化的贝叶斯更新）
        if response > 0:  # 正确回答
            cat_state.current_theta += 0.3 * (1 - p) / max(p, 0.01)
        else:  # 错误回答
            cat_state.current_theta -= 0.3 * p / max(1 - p, 0.01)

        # 限制theta范围
        cat_state.current_theta = max(-3.0, min(3.0, cat_state.current_theta))

        # 更新标准误
        cat_state.theta_se = 1.0 / math.sqrt(max(info, 0.01))

        # 更新维度得分
        dimension = item.dimension
        if dimension not in cat_state.dimension_scores:
            cat_state.dimension_scores[dimension] = 0.0
        # 加权更新维度得分
        weight = info / (len(cat_state.responses) + 1)
        cat_state.dimension_scores[dimension] = (
            cat_state.dimension_scores[dimension] * (1 - weight) + response * weight
        )

    def _compute_item_information(
        self,
        a: float,
        b: float,
        c: float,
        theta: float,
    ) -> float:
        """计算题目信息量"""
        exp_term = math.exp(a * (theta - b))
        p = c + (1 - c) * exp_term / (1 + exp_term)

        # 三参数逻辑斯蒂模型的信息量公式
        info = (a ** 2) * ((p - c) ** 2) / ((1 - c) ** 2) * (1 - p) / p
        return max(info, 0.0)

    def _select_next_question(self, cat_state: CATState) -> CATQuestion:
        """选择信息量最大的下一题"""
        available_items = self._get_available_items(cat_state)

        if not available_items:
            # 如果没有可用题目，返回默认题目
            return self._create_fallback_question(cat_state)

        # 计算每个题目的信息量
        item_infos = []
        for item in available_items:
            info = self._compute_item_information(
                item.irt_params.discrimination,
                item.irt_params.difficulty,
                item.irt_params.guessing,
                cat_state.current_theta,
            )
            item_infos.append((item, info))

        # 按信息量排序，选择最大的
        item_infos.sort(key=lambda x: x[1], reverse=True)
        best_item = item_infos[0][0]

        # 标记为已使用
        best_item.is_used = True

        # 计算预估总题数
        estimated_total = self._estimate_total_questions(cat_state)

        return CATQuestion(
            question_id=best_item.item_id,
            dimension=best_item.dimension,
            text=best_item.text,
            options=best_item.options,
            question_number=len(cat_state.responses) + 1,
            total_estimated=estimated_total,
            confidence_level=max(0.0, 1.0 - cat_state.theta_se / 2.0),
        )

    def _get_available_items(self, cat_state: CATState) -> list[ItemInfo]:
        """获取可用题目列表"""
        all_items = []
        for dimension_items in self.ASRS_ITEMS.values():
            all_items.extend(dimension_items)

        # 过滤已使用的题目
        available = [item for item in all_items if item.item_id not in cat_state.items_used]

        # 如果当前维度题目用完，切换到其他维度
        if not available:
            current_dim_items = self.ASRS_ITEMS.get(cat_state.current_dimension, [])
            if all(item.item_id in cat_state.items_used for item in current_dim_items):
                # 切换到下一个维度
                dimensions = list(self.ASRS_ITEMS.keys())
                current_idx = dimensions.index(cat_state.current_dimension)
                next_dim = dimensions[(current_idx + 1) % len(dimensions)]
                cat_state.current_dimension = next_dim

                # 重新获取可用题目
                available = [
                    item for item in all_items if item.item_id not in cat_state.items_used
                ]

        return available

    def _should_terminate(self, cat_state: CATState) -> bool:
        """判断是否应该终止测试"""
        # 条件1：标准误足够小（测量精度足够）
        if cat_state.theta_se < 0.3:
            return True

        # 条件2：已回答足够多的题目
        if len(cat_state.responses) >= 12:  # 最多12题
            return True

        # 条件3：所有维度都有足够信息
        dimensions_with_data = len([
            dim for dim, score in cat_state.dimension_scores.items() if score > 0
        ])
        total_dimensions = len(self.ASRS_ITEMS)
        if dimensions_with_data >= total_dimensions * 0.8 and len(cat_state.responses) >= 8:
            return True

        return False

    def _estimate_total_questions(self, cat_state: CATState) -> int:
        """估计总题数"""
        # 基于当前精度估计还需要多少题
        current_info = 1.0 / (cat_state.theta_se ** 2)
        target_info = 25.0  # 目标信息量（对应SE=0.2）

        if current_info >= target_info:
            return len(cat_state.responses)

        # 估计每题平均信息量
        avg_info_per_item = current_info / max(len(cat_state.responses), 1)
        remaining_items = int((target_info - current_info) / max(avg_info_per_item, 0.1))

        return min(len(cat_state.responses) + remaining_items, 12)

    def _generate_result(self, cat_state: CATState) -> CATResult:
        """生成CAT测试结果"""
        # 计算总分（基于IRT能力估计）
        total_score = self._theta_to_score(cat_state.current_theta)

        # 计算各维度得分
        dimension_scores = {}
        for dimension, score in cat_state.dimension_scores.items():
            dimension_scores[dimension] = min(4.0, max(0.0, score))

        # 确定风险等级
        risk_level = self._determine_risk_level(total_score, dimension_scores)

        # 生成建议
        recommendations = self._generate_recommendations(dimension_scores, risk_level)

        # 确定完成原因
        if cat_state.theta_se < 0.3:
            completion_reason = "测量精度已达标"
        elif len(cat_state.responses) >= 12:
            completion_reason = "已达到最大题数"
        else:
            completion_reason = "各维度评估完成"

        return CATResult(
            patient_id=cat_state.patient_id,
            scale_type=cat_state.scale_type,
            total_score=total_score,
            dimension_scores=dimension_scores,
            risk_level=risk_level,
            theta_estimate=cat_state.current_theta,
            standard_error=cat_state.theta_se,
            items_administered=len(cat_state.responses),
            completion_reason=completion_reason,
            recommendations=recommendations,
        )

    def _theta_to_score(self, theta: float) -> float:
        """将IRT能力参数转换为传统分数"""
        # 将theta(-3到3)映射到0-78分（ASRS满分）
        normalized = (theta + 3) / 6  # 映射到0-1
        return normalized * 78

    def _determine_risk_level(self, total_score: float, dimension_scores: dict[str, float]) -> str:
        """确定风险等级"""
        if total_score >= 48:  # 高风险阈值
            return "high"
        elif total_score >= 36:  # 中风险阈值
            return "medium"
        elif total_score >= 24:  # 低风险阈值
            return "low"
        else:
            return "minimal"

    def _generate_recommendations(
        self,
        dimension_scores: dict[str, float],
        risk_level: str,
    ) -> list[str]:
        """基于结果生成个性化建议"""
        recommendations = []

        # 按维度得分排序
        sorted_dims = sorted(dimension_scores.items(), key=lambda x: x[1], reverse=True)

        for dimension, score in sorted_dims[:2]:  # 关注最突出的两个维度
            if score >= 2.5:  # 中等以上问题
                if dimension == "attention_control":
                    recommendations.append("建议尝试番茄工作法，将任务分解为25分钟的小段")
                elif dimension == "organization":
                    recommendations.append("可以使用待办事项清单，每天早上花5分钟规划当天任务")
                elif dimension == "hyperactivity":
                    recommendations.append("安排定期的运动时间，如散步或轻度有氧运动")
                elif dimension == "impulsivity":
                    recommendations.append("在做决定前尝试'暂停3秒'的技巧")
                elif dimension == "emotional_regulation":
                    recommendations.append("学习简单的呼吸练习来管理情绪波动")

        if risk_level in ["high", "medium"]:
            recommendations.append("建议咨询专业医生进行进一步评估")

        return recommendations[:3]  # 最多返回3条建议

    def _find_item_by_id(self, item_id: str) -> ItemInfo | None:
        """根据ID查找题目"""
        for dimension_items in self.ASRS_ITEMS.values():
            for item in dimension_items:
                if item.item_id == item_id:
                    return item
        return None

    def _create_fallback_question(self, cat_state: CATState) -> CATQuestion:
        """创建备用题目"""
        return CATQuestion(
            question_id="fallback_1",
            dimension=cat_state.current_dimension,
            text="请评估您在这个方面的困难程度",
            options=[
                {"value": 0, "text": "没有困难"},
                {"value": 1, "text": "轻微困难"},
                {"value": 2, "text": "中等困难"},
                {"value": 3, "text": "较大困难"},
                {"value": 4, "text": "极大困难"},
            ],
            question_number=len(cat_state.responses) + 1,
            total_estimated=10,
            confidence_level=0.5,
        )

    def _save_cat_state(self, cat_state: CATState) -> None:
        """保存CAT状态"""
        pass

    def _load_cat_state(self, patient_id: int) -> CATState | None:
        """加载CAT状态"""
        return CATState(
            patient_id=patient_id,
            scale_type=ScaleType.ASRS,
            current_theta=0.0,
            theta_se=2.0,
            items_used=[],
            responses=[],
            current_dimension="attention_control",
            dimension_scores={},
        )

    def _save_cat_result(self, result: CATResult) -> None:
        """保存CAT结果"""
        pass

    def _get_current_timestamp(self) -> str:
        """获取当前时间戳"""
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()