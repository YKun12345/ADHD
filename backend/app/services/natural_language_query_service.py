"""
自然语言数据查询服务

实现研究人员的自然语言数据查询功能：
1. 支持中文自然语言查询
2. 自动解析查询意图
3. 转换为数据库查询
4. 生成人性化回答
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from backend.app.models.patient import Patient
from backend.app.models.scale_result import ScaleResult


@dataclass
class QueryIntent:
    """查询意图"""
    intent_type: str  # "patient_search", "trend_analysis", "comparison", "summary"
    entities: dict[str, Any]  # 提取的实体
    time_range: dict[str, Any] | None  # 时间范围
    metrics: list[str]  # 关注的指标
    filters: dict[str, Any]  # 过滤条件


@dataclass
class QueryResult:
    """查询结果"""
    success: bool
    answer: str  # 自然语言回答
    data: dict[str, Any] | None  # 结构化数据
    query_sql: str | None  # 生成的查询说明
    confidence: float  # 置信度


class NaturalLanguageQueryService:
    """自然语言数据查询服务"""

    # 时间关键词映射
    TIME_KEYWORDS = {
        "今天": 1,
        "昨天": 1,
        "最近三天": 3,
        "最近一周": 7,
        "最近两周": 14,
        "最近一个月": 30,
        "本周": 7,
        "上周": 7,
        "本月": 30,
    }

    # 指标关键词映射
    METRIC_KEYWORDS = {
        "心情": "mood",
        "情绪": "mood",
        "专注": "focus",
        "注意力": "focus",
        "专注度": "focus",
        "反应时": "reaction_time",
        "反应时间": "reaction_time",
        "准确率": "accuracy",
        "得分": "score",
        "量表": "scale",
        "认知": "cognitive",
    }

    # 比较关键词
    COMPARISON_KEYWORDS = ["最高", "最低", "最好", "最差", "最多", "最少", "前", "后"]

    def __init__(self, db: Session):
        self.db = db

    def process_query(
        self,
        researcher_id: int,
        query_text: str,
    ) -> QueryResult:
        """
        处理自然语言查询

        参数：
        - researcher_id: 研究人员ID
        - query_text: 查询文本

        返回：
        - 查询结果
        """
        try:
            # 1. 解析查询意图
            intent = self._parse_intent(query_text)

            # 2. 验证权限和数据范围
            if not self._validate_researcher_access(researcher_id, intent):
                return QueryResult(
                    success=False,
                    answer="抱歉，您没有权限查询这些数据，或者查询范围超出了您的患者列表。",
                    data=None,
                    query_sql=None,
                    confidence=0.0,
                )

            # 3. 执行查询
            result_data = self._execute_query(researcher_id, intent)

            # 4. 生成自然语言回答
            answer = self._generate_answer(intent, result_data)

            return QueryResult(
                success=True,
                answer=answer,
                data=result_data,
                query_sql=self._describe_query(intent),
                confidence=0.8,
            )

        except Exception as e:
            return QueryResult(
                success=False,
                answer=f"抱歉，我无法理解您的查询：{str(e)}。请尝试用更简单的方式描述，比如'最近两周情绪最差的5个患者'。",
                data=None,
                query_sql=None,
                confidence=0.0,
            )

    def _parse_intent(self, query_text: str) -> QueryIntent:
        """解析查询意图"""
        query = query_text.lower().strip()

        # 提取时间范围
        time_range = self._extract_time_range(query)

        # 提取指标
        metrics = self._extract_metrics(query)

        # 提取比较条件
        comparison = self._extract_comparison(query)

        # 判断意图类型
        intent_type = self._classify_intent(query, metrics, comparison)

        # 提取患者相关实体
        entities = self._extract_entities(query)

        # 提取过滤条件
        filters = self._extract_filters(query)

        return QueryIntent(
            intent_type=intent_type,
            entities=entities,
            time_range=time_range,
            metrics=metrics,
            filters=filters,
        )

    def _extract_time_range(self, query: str) -> dict[str, Any] | None:
        """提取时间范围"""
        for keyword, days in self.TIME_KEYWORDS.items():
            if keyword in query:
                end_date = datetime.now(timezone.utc)
                start_date = end_date - timedelta(days=days)
                return {
                    "start": start_date,
                    "end": end_date,
                    "days": days,
                    "keyword": keyword,
                }

        # 尝试提取具体日期范围
        date_pattern = r'(\d{1,2})月(\d{1,2})日?到(\d{1,2})月(\d{1,2})日?'
        match = re.search(date_pattern, query)
        if match:
            start_month, start_day, end_month, end_day = map(int, match.groups())
            year = datetime.now().year
            try:
                start_date = datetime(year, start_month, start_day, tzinfo=timezone.utc)
                end_date = datetime(year, end_month, end_day, tzinfo=timezone.utc)
                return {
                    "start": start_date,
                    "end": end_date,
                    "days": (end_date - start_date).days,
                    "keyword": f"{start_month}月{start_day}日到{end_month}月{end_day}日",
                }
            except ValueError:
                pass

        return None

    def _extract_metrics(self, query: str) -> list[str]:
        """提取关注的指标"""
        found_metrics = []
        for keyword, metric in self.METRIC_KEYWORDS.items():
            if keyword in query:
                if metric not in found_metrics:
                    found_metrics.append(metric)

        return found_metrics

    def _extract_comparison(self, query: str) -> dict[str, Any] | None:
        """提取比较条件"""
        for keyword in self.COMPARISON_KEYWORDS:
            if keyword in query:
                # 提取数字
                numbers = re.findall(r'\d+', query)
                limit = int(numbers[0]) if numbers else 5

                return {
                    "type": keyword,
                    "limit": limit,
                }

        return None

    def _extract_limit(self, query: str) -> int | None:
        """提取数量限制"""
        # 匹配 "前N个"、"N个"、"N位" 等模式
        patterns = [
            r'前(\d+)个',
            r'(\d+)个',
            r'(\d+)位',
            r'(\d+)名',
        ]

        for pattern in patterns:
            match = re.search(pattern, query)
            if match:
                return int(match.group(1))

        return None

    def _classify_intent(
        self,
        query: str,
        metrics: list[str],
        comparison: dict[str, Any] | None,
    ) -> str:
        """分类查询意图"""
        # 患者搜索类
        if any(word in query for word in ["患者", "谁", "哪些人"]):
            return "patient_search"

        # 趋势分析类
        if any(word in query for word in ["趋势", "变化", "发展"]):
            return "trend_analysis"

        # 比较类
        if comparison or any(word in query for word in ["比较", "对比", "差异"]):
            return "comparison"

        # 统计汇总类
        if any(word in query for word in ["统计", "汇总", "总计", "平均"]):
            return "summary"

        # 默认为患者搜索
        return "patient_search"

    def _extract_entities(self, query: str) -> dict[str, Any]:
        """提取实体"""
        entities = {}

        # 提取风险等级
        if "高风险" in query:
            entities["risk_level"] = "high"
        elif "中风险" in query:
            entities["risk_level"] = "medium"
        elif "低风险" in query:
            entities["risk_level"] = "low"

        # 提取患者类型
        if "儿童" in query:
            entities["patient_type"] = "child"
        elif "成人" in query:
            entities["patient_type"] = "adult"

        return entities

    def _extract_filters(self, query: str) -> dict[str, Any]:
        """提取过滤条件"""
        filters = {}

        # 提取量表类型
        if "ASRS" in query or "成人量表" in query:
            filters["scale_type"] = "ASRS"
        elif "SNAP" in query or "儿童量表" in query:
            filters["scale_type"] = "SNAP_IV"

        return filters

    def _validate_researcher_access(
        self,
        researcher_id: int,
        intent: QueryIntent,
    ) -> bool:
        """验证研究人员访问权限"""
        # 检查研究人员是否有患者
        patient_count = self.db.scalar(
            select(func.count(Patient.id))
            .where(Patient.assigned_researcher_id == researcher_id)
        )

        return patient_count > 0

    def _execute_query(
        self,
        researcher_id: int,
        intent: QueryIntent,
    ) -> dict[str, Any]:
        """执行查询"""
        # 获取研究人员的患者列表
        patients = self.db.scalars(
            select(Patient)
            .where(Patient.assigned_researcher_id == researcher_id)
            .order_by(Patient.created_at.desc())
        ).all()

        if intent.intent_type == "patient_search":
            return self._execute_patient_search(patients, intent)
        elif intent.intent_type == "trend_analysis":
            return self._execute_trend_analysis(patients, intent)
        elif intent.intent_type == "comparison":
            return self._execute_comparison(patients, intent)
        elif intent.intent_type == "summary":
            return self._execute_summary(patients, intent)
        else:
            return self._execute_patient_search(patients, intent)

    def _execute_patient_search(
        self,
        patients: list[Patient],
        intent: QueryIntent,
    ) -> dict[str, Any]:
        """执行患者搜索查询"""
        from backend.app.models.user import User

        results = []

        for patient in patients:
            user = self.db.get(User, patient.user_id)
            if not user:
                continue

            # 获取最新量表结果
            latest_scale = self.db.scalar(
                select(ScaleResult)
                .where(ScaleResult.patient_id == patient.id)
                .order_by(ScaleResult.created_at.desc())
                .limit(1)
            )

            # 应用过滤条件
            if intent.entities.get("risk_level"):
                if not latest_scale or latest_scale.risk_level != intent.entities["risk_level"]:
                    continue

            if intent.entities.get("patient_type"):
                if patient.patient_type.value != intent.entities["patient_type"]:
                    continue

            if intent.filters.get("scale_type"):
                if not latest_scale or latest_scale.scale_type != intent.filters["scale_type"]:
                    continue

            # 获取追踪数据
            tracking_summary = self._get_patient_tracking_summary(
                patient.id, intent.time_range
            )

            results.append({
                "patient_id": patient.id,
                "patient_name": user.full_name,
                "patient_type": patient.patient_type.value,
                "age": patient.age,
                "risk_level": latest_scale.risk_level if latest_scale else "unknown",
                "scale_score": latest_scale.total_score if latest_scale else None,
                "scale_type": latest_scale.scale_type if latest_scale else None,
                "tracking_summary": tracking_summary,
            })

        # 应用排序和限制
        comparison = intent.entities.get("comparison") or {"type": "前", "limit": 5}

        if comparison["type"] in ["最高", "最好", "最多"]:
            # 按量表分数降序
            results.sort(key=lambda x: x["scale_score"] or 0, reverse=True)
        elif comparison["type"] in ["最低", "最差", "最少"]:
            # 按量表分数升序
            results.sort(key=lambda x: x["scale_score"] or 0, reverse=False)

        limit = comparison.get("limit", 5)
        results = results[:limit]

        return {
            "query_type": "patient_search",
            "total_patients": len(results),
            "patients": results,
        }

    def _execute_trend_analysis(
        self,
        patients: list[Patient],
        intent: QueryIntent,
    ) -> dict[str, Any]:
        """执行趋势分析查询"""
        from backend.app.models.tracking_log import TrackingLog

        time_range = intent.time_range
        if not time_range:
            # 默认最近14天
            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=14)
            time_range = {"start": start_date, "end": end_date, "days": 14}

        trends = []

        for patient in patients:
            logs = self.db.scalars(
                select(TrackingLog)
                .where(
                    TrackingLog.patient_id == patient.id,
                    TrackingLog.created_at >= time_range["start"],
                    TrackingLog.created_at <= time_range["end"],
                )
                .order_by(TrackingLog.created_at.asc())
            ).all()

            if logs:
                mood_values = []
                focus_values = []

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

                if mood_values or focus_values:
                    trends.append({
                        "patient_id": patient.id,
                        "mood_values": mood_values,
                        "focus_values": focus_values,
                        "mood_trend": self._calculate_trend_direction(mood_values),
                        "focus_trend": self._calculate_trend_direction(focus_values),
                    })

        return {
            "query_type": "trend_analysis",
            "time_range": time_range,
            "trends": trends,
        }

    def _execute_comparison(
        self,
        patients: list[Patient],
        intent: QueryIntent,
    ) -> dict[str, Any]:
        """执行比较查询"""
        return self._execute_patient_search(patients, intent)

    def _execute_summary(
        self,
        patients: list[Patient],
        intent: QueryIntent,
    ) -> dict[str, Any]:
        """执行统计汇总查询"""
        total_patients = len(patients)
        risk_distribution = {"high": 0, "medium": 0, "low": 0}
        scale_scores = []
        mood_values = []
        focus_values = []

        for patient in patients:
            # 量表统计
            latest_scale = self.db.scalar(
                select(ScaleResult)
                .where(ScaleResult.patient_id == patient.id)
                .order_by(ScaleResult.created_at.desc())
                .limit(1)
            )

            if latest_scale:
                risk_level = latest_scale.risk_level
                if risk_level in risk_distribution:
                    risk_distribution[risk_level] += 1
                if latest_scale.total_score:
                    scale_scores.append(latest_scale.total_score)

            # 追踪数据统计
            tracking_summary = self._get_patient_tracking_summary(
                patient.id, intent.time_range
            )
            if tracking_summary.get("avg_mood"):
                mood_values.append(tracking_summary["avg_mood"])
            if tracking_summary.get("avg_focus"):
                focus_values.append(tracking_summary["avg_focus"])

        return {
            "query_type": "summary",
            "total_patients": total_patients,
            "risk_distribution": risk_distribution,
            "avg_scale_score": sum(scale_scores) / len(scale_scores) if scale_scores else None,
            "avg_mood": sum(mood_values) / len(mood_values) if mood_values else None,
            "avg_focus": sum(focus_values) / len(focus_values) if focus_values else None,
        }

    def _get_patient_tracking_summary(
        self,
        patient_id: int,
        time_range: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """获取患者追踪摘要"""
        from backend.app.models.tracking_log import TrackingLog

        if not time_range:
            time_range = {
                "start": datetime.now(timezone.utc) - timedelta(days=14),
                "end": datetime.now(timezone.utc),
            }

        logs = self.db.scalars(
            select(TrackingLog)
            .where(
                TrackingLog.patient_id == patient_id,
                TrackingLog.created_at >= time_range["start"],
                TrackingLog.created_at <= time_range["end"],
            )
        ).all()

        if not logs:
            return {"completed_days": 0, "avg_mood": None, "avg_focus": None}

        mood_values = []
        focus_values = []

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

        return {
            "completed_days": len(set(log.day_index for log in logs)),
            "avg_mood": sum(mood_values) / len(mood_values) if mood_values else None,
            "avg_focus": sum(focus_values) / len(focus_values) if focus_values else None,
        }

    def _calculate_trend_direction(self, values: list[float]) -> str:
        """计算趋势方向"""
        if len(values) < 2:
            return "unknown"

        # 简单比较前后平均值
        mid = len(values) // 2
        first_half = values[:mid]
        second_half = values[mid:]

        if not first_half or not second_half:
            return "unknown"

        first_avg = sum(first_half) / len(first_half)
        second_avg = sum(second_half) / len(second_half)

        diff = second_avg - first_avg
        if diff > 0.3:
            return "improving"
        elif diff < -0.3:
            return "declining"
        else:
            return "stable"

    def _generate_answer(
        self,
        intent: QueryIntent,
        result_data: dict[str, Any],
    ) -> str:
        """生成自然语言回答"""
        if intent.intent_type == "patient_search":
            return self._generate_patient_search_answer(intent, result_data)
        elif intent.intent_type == "trend_analysis":
            return self._generate_trend_answer(intent, result_data)
        elif intent.intent_type == "summary":
            return self._generate_summary_answer(intent, result_data)
        else:
            return self._generate_patient_search_answer(intent, result_data)

    def _generate_patient_search_answer(
        self,
        intent: QueryIntent,
        result_data: dict[str, Any],
    ) -> str:
        """生成患者搜索回答"""
        patients = result_data.get("patients", [])
        total = result_data.get("total_patients", 0)

        if total == 0:
            return "没有找到符合条件的患者。"

        # 构建描述
        conditions = []
        if intent.entities.get("risk_level"):
            risk_desc = {"high": "高风险", "medium": "中风险", "low": "低风险"}
            conditions.append(risk_desc.get(intent.entities["risk_level"], intent.entities["risk_level"]))

        if intent.entities.get("patient_type"):
            type_desc = {"child": "儿童", "adult": "成人"}
            conditions.append(type_desc.get(intent.entities["patient_type"], intent.entities["patient_type"]))

        condition_text = "、".join(conditions) if conditions else "所有"

        # 构建患者列表
        patient_list = []
        for i, patient in enumerate(patients, 1):
            name = patient["patient_name"]
            risk = patient.get("risk_level", "未知")
            score = patient.get("scale_score")

            desc = f"{i}. {name}"
            if risk != "未知":
                desc += f"（{risk}风险"
                if score:
                    desc += f"，得分{score}"
                desc += "）"
            patient_list.append(desc)

        answer = f"找到{total}位{condition_text}患者：\n" + "\n".join(patient_list)

        return answer

    def _generate_trend_answer(
        self,
        intent: QueryIntent,
        result_data: dict[str, Any],
    ) -> str:
        """生成趋势分析回答"""
        trends = result_data.get("trends", [])
        time_range = result_data.get("time_range", {})

        if not trends:
            return "在指定时间范围内没有找到足够的追踪数据。"

        time_desc = time_range.get("keyword", "最近一段时间")

        # 统计趋势
        mood_improving = sum(1 for t in trends if t.get("mood_trend") == "improving")
        mood_declining = sum(1 for t in trends if t.get("mood_trend") == "declining")
        focus_improving = sum(1 for t in trends if t.get("focus_trend") == "improving")
        focus_declining = sum(1 for t in trends if t.get("focus_trend") == "declining")

        answer = f"{time_desc}的追踪趋势分析：\n"

        if mood_improving > 0:
            answer += f"- {mood_improving}位患者的心情呈上升趋势\n"
        if mood_declining > 0:
            answer += f"- {mood_declining}位患者的心情呈下降趋势\n"
        if focus_improving > 0:
            answer += f"- {focus_improving}位患者的专注度在提升\n"
        if focus_declining > 0:
            answer += f"- {focus_declining}位患者的专注度在下降\n"

        return answer

    def _generate_summary_answer(
        self,
        intent: QueryIntent,
        result_data: dict[str, Any],
    ) -> str:
        """生成统计汇总回答"""
        total = result_data.get("total_patients", 0)
        risk_dist = result_data.get("risk_distribution", {})
        avg_score = result_data.get("avg_scale_score")

        answer = "患者统计汇总：\n"
        answer += f"- 总患者数：{total}人\n"

        if risk_dist:
            answer += f"- 风险分布：高风险{risk_dist.get('high', 0)}人，"
            answer += f"中风险{risk_dist.get('medium', 0)}人，"
            answer += f"低风险{risk_dist.get('low', 0)}人\n"

        if avg_score:
            answer += f"- 平均量表得分：{avg_score:.1f}分\n"

        return answer

    def _describe_query(self, intent: QueryIntent) -> str:
        """描述生成的查询"""
        descriptions = []

        if intent.time_range:
            descriptions.append(f"时间范围：{intent.time_range.get('keyword', '自定义')}")

        if intent.entities:
            for key, value in intent.entities.items():
                descriptions.append(f"{key}：{value}")

        if intent.metrics:
            descriptions.append(f"指标：{', '.join(intent.metrics)}")

        return "; ".join(descriptions) if descriptions else "查询所有数据"
