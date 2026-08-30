from __future__ import annotations

import json
import re
from dataclasses import dataclass
from statistics import mean
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.api.routes.patient import (
    _extract_latest_cognitive_profile,
    _to_imaging_response,
    _to_model_prediction_response,
    _to_scale_response,
)
from backend.app.core.config import settings
from backend.app.models.imaging_visualization import ImagingVisualization
from backend.app.models.model_prediction import ModelPrediction
from backend.app.models.patient import Patient
from backend.app.models.scale_result import ScaleResult
from backend.app.models.tracking_log import TrackingLog
from backend.app.models.user import User


AI_DISCLAIMER = "AI内容仅用于健康教育和追踪辅助，不能替代医生诊断或处方建议。"
AI_LOCAL_MODE_NOTE = "当前先使用本地辅助模式，回答会基于你现有的报告和追踪数据生成。"

SCALE_LABELS = {
    "attention_control": "注意控制",
    "organization": "组织管理",
    "task_activation": "任务启动",
    "hyperactivity": "多动表现",
    "impulsivity": "冲动控制",
    "emotional_regulation": "情绪调节",
}

COGNITIVE_LABELS = {
    "reaction_speed": "反应速度",
    "attention_control": "注意控制",
    "inhibitory_control": "抑制控制",
    "working_memory": "工作记忆",
}

MOOD_LABELS = {
    "5": "状态很好",
    "4": "整体不错",
    "3": "状态一般",
    "2": "有些吃力",
    "1": "状态低落",
}

HIGH_RISK_KEYWORDS = (
    "自杀",
    "轻生",
    "不想活",
    "结束生命",
    "伤害自己",
    "自残",
    "割腕",
    "伤人",
    "杀人",
)

AI_BASE_IDENTITY_PROMPT = """
你是“智绘脑图 AI 助手”，服务于 ADHD 筛查、报告解读和 14 天追踪场景。
你的定位不是医生替身，而是一个数据驱动、温和克制、可解释的健康辅助助手。
你的目标是：
1. 帮用户把量表、认知测试和追踪数据翻译成通俗中文。
2. 提供小步、可执行、不过度承诺的建议。
3. 降低用户的羞耻感和压力，不使用指责语气。
4. 对数据不足的地方明确说“不足以判断”，不要硬编结论。
""".strip()

AI_SAFETY_PROMPT = """
安全边界：
1. 不能给出确诊结论，不能替代医生诊断。
2. 不能直接给药物处方、剂量、停药或换药建议。
3. 不要使用“肯定是”“一定有”“严重异常”这类绝对化表述。
4. 如果用户出现自伤、伤人、轻生、极端绝望等高风险信号，停止常规分析，立即切换到安全支持话术，建议尽快联系家属、医生或当地紧急支持资源。
""".strip()

AI_GROUNDING_PROMPT = """
数据使用规则：
1. 优先基于系统提供的结构化数据回答，不要凭空捏造患者经历。
2. 可以做合理归纳，但要避免把推测说成事实。
3. 不要逐字复述原始 JSON，不要暴露内部字段名。
4. 如果缺少量表、认知测试或追踪数据，要直接说明当前依据不足。
""".strip()

AI_STYLE_PROMPT = """
表达风格：
1. 默认使用简洁、温和、具体的中文。
2. 先解释“看到了什么”，再说“这意味着什么”，最后给“下一步建议”。
3. 正常回答尽量控制在 3 段内，建议不超过 3 条。
4. 少用术语；必须用术语时，要顺手解释成人话。
5. 不要输出 Markdown 语法，不要使用标题符号、星号、反引号或列表标记。
""".strip()

CHAT_SCOPE_PROMPTS = {
    "general": """
当前任务模式：综合陪伴与问答。
优先回答用户当前问题；如果能结合报告和追踪数据，就结合，但不要为了引用数据而打断自然对话。
如果用户是在要计划，优先给“今天就能开始”的建议。
""".strip(),
    "report": """
当前任务模式：报告解读。
优先解释最近量表、认知测试和追踪之间的对应关系。
回答时突出“最值得关注的 1-2 个点”和“先做哪一步”，避免泛泛而谈。
""".strip(),
    "tracking": """
当前任务模式：14 天追踪分析与提醒。
优先关注连续漏填、情绪波动、专注时长变化和最近几天的日志记录。
提醒要像陪跑，而不是催促；允许鼓励，但不要鸡汤化。
""".strip(),
}

REPORT_SYSTEM_PROMPT = """
你现在要生成“患者/家属可直接阅读”的报告解读。
输出目标：
1. 先给一句整体判断，语气克制。
2. 再给 2-3 个关键发现，必须和数据有关。
3. 再给 2-3 条下一步建议，必须能执行。
4. 始终保留免责声明。
严格输出 JSON 对象，字段为：
headline, plain_summary, key_findings, next_actions, disclaimer
""".strip()

REMINDER_SYSTEM_PROMPT = """
你现在要生成一条简短提醒。
输出目标：
1. 提醒语气温和，不指责。
2. 允许共情，但不要说教。
3. 文案要短，适合卡片展示。
严格输出 JSON 对象，字段为：
title, message, action_label
""".strip()


@dataclass
class AIProviderResult:
    content: str
    model: str
    provider: str = "qwen"


class AIProviderError(RuntimeError):
    pass


def _normalize_content(content: object) -> str:
    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
                continue
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(part.strip() for part in parts if part and part.strip()).strip()

    return ""


def _normalize_display_text(text: str) -> str:
    cleaned = _strip_markdown_fences(text)
    cleaned = re.sub(r"\[(.*?)\]\((.*?)\)", r"\1", cleaned)
    cleaned = re.sub(r"(?<!\*)\*\*(.*?)\*\*(?!\*)", r"\1", cleaned)
    cleaned = re.sub(r"__(.*?)__", r"\1", cleaned)
    cleaned = re.sub(r"(?<!\*)\*(.*?)\*(?!\*)", r"\1", cleaned)
    cleaned = re.sub(r"(?<!_)_(.*?)_(?!_)", r"\1", cleaned)
    cleaned = re.sub(r"`([^`]*)`", r"\1", cleaned)
    cleaned = re.sub(r"^\s{0,3}#{1,6}\s*", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s{0,3}>\s?", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*[-*+]\s+", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*\d+\.\s+", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _strip_markdown_fences(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def _parse_json_object(text: str) -> dict:
    cleaned = _strip_markdown_fences(text)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        snippet = cleaned[start : end + 1]
        parsed = json.loads(snippet)
        if isinstance(parsed, dict):
            return parsed

    raise ValueError("AI response is not a valid JSON object.")


def _is_high_risk_message(message: str) -> bool:
    text = message.strip().lower()
    return any(keyword in text for keyword in HIGH_RISK_KEYWORDS)


def _high_risk_reply() -> str:
    return (
        "我很重视你现在说的这些。如果你有伤害自己或他人的想法，请先不要一个人扛着，"
        "立刻联系家人、医生或当地紧急支持；如果风险已经很强，请马上前往最近的急诊或拨打当地急救电话。"
        "如果你愿意，也可以先告诉我你现在身边有没有可信任的人。"
    )


class QwenChatClient:
    @property
    def configured(self) -> bool:
        return bool(settings.QWEN_API_KEY and settings.QWEN_BASE_URL)

    def chat(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float = 0.4,
        max_tokens: int = 800,
    ) -> AIProviderResult:
        if not self.configured:
            raise AIProviderError("Qwen API key is not configured.")

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        request_body = json.dumps(payload).encode("utf-8")
        request = Request(
            settings.QWEN_BASE_URL,
            data=request_body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {settings.QWEN_API_KEY}",
            },
            method="POST",
        )

        try:
            with urlopen(request, timeout=settings.QWEN_TIMEOUT_SECONDS) as response:
                body = response.read().decode("utf-8")
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise AIProviderError(f"Qwen request failed with {exc.code}: {detail}") from exc
        except URLError as exc:
            raise AIProviderError(f"Qwen service is unreachable: {exc.reason}") from exc

        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as exc:
            raise AIProviderError("Qwen returned an invalid JSON payload.") from exc

        choices = parsed.get("choices") or []
        if not choices:
            raise AIProviderError("Qwen returned no completion choices.")

        message = choices[0].get("message") or {}
        content = _normalize_content(message.get("content"))
        if not content:
            raise AIProviderError("Qwen returned an empty message.")

        return AIProviderResult(
            content=_normalize_display_text(content),
            model=str(parsed.get("model") or model),
        )


qwen_client = QwenChatClient()


def _split_activities(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def _safe_round_average(values: list[int | float]) -> float | None:
    if not values:
        return None
    return round(mean(values), 1)


def _rank_labels(
    scores: dict[str, float] | None,
    label_map: dict[str, str],
    *,
    reverse: bool = True,
    top_n: int = 2,
) -> list[str]:
    if not scores:
        return []
    return [
        label_map.get(key, key)
        for key, _ in sorted(scores.items(), key=lambda item: item[1], reverse=reverse)[:top_n]
    ]


def _patient_audience_prompt(snapshot: dict) -> str:
    patient_profile = snapshot.get("patient_profile") or {}
    patient_type = patient_profile.get("patient_type")
    latest_scale = snapshot.get("latest_scale") or {}
    respondent_type = latest_scale.get("respondent_type")

    if patient_type == "child" or respondent_type in {"parent", "guardian", "teacher"}:
        return (
            "受众适配：当前更偏儿童/家长协同场景。"
            "如果涉及日常建议，请尽量写成家长和孩子都能执行的表述，避免成人自我管理语气。"
        )

    return "受众适配：当前更偏成人自助管理场景，可以直接对患者本人说话。"


def _build_snapshot_brief(snapshot: dict) -> dict:
    patient_profile = snapshot.get("patient_profile") or {}
    latest_scale = snapshot.get("latest_scale") or {}
    cognitive_profile = snapshot.get("cognitive_profile") or {}
    latest_model_prediction = snapshot.get("latest_model_prediction") or {}
    tracking = snapshot.get("tracking") or {}

    top_scale_signals = _rank_labels(latest_scale.get("radar_scores"), SCALE_LABELS, reverse=True)
    low_cognitive_signals = _rank_labels(
        cognitive_profile.get("radar_scores"), COGNITIVE_LABELS, reverse=False
    )

    return {
        "patient": {
            "name": patient_profile.get("name"),
            "age": patient_profile.get("age"),
            "gender": patient_profile.get("gender"),
            "patient_type": patient_profile.get("patient_type"),
        },
        "latest_scale": {
            "scale_type": latest_scale.get("scale_type"),
            "risk_level": latest_scale.get("risk_level"),
            "summary": latest_scale.get("summary"),
            "top_signals": top_scale_signals,
        }
        if latest_scale
        else None,
        "cognitive_profile": {
            "summary": cognitive_profile.get("summary"),
            "relative_weaker_areas": low_cognitive_signals,
        }
        if cognitive_profile
        else None,
        "latest_model_prediction": {
            "prediction_label": latest_model_prediction.get("prediction_label"),
            "probability": latest_model_prediction.get("probability"),
            "model_name": latest_model_prediction.get("model_name"),
            "summary_text": latest_model_prediction.get("summary_text"),
        }
        if latest_model_prediction
        else None,
        "tracking": {
            "completed_count": tracking.get("completed_count"),
            "current_day": tracking.get("current_day"),
            "completion_status": tracking.get("completion_status"),
            "consecutive_missed_days": tracking.get("consecutive_missed_days"),
            "average_mood": tracking.get("average_mood"),
            "average_focus_minutes": tracking.get("average_focus_minutes"),
        },
    }


def _tracking_summary(logs: list[TrackingLog], total_days: int = 14) -> dict:
    completed_days = sorted({log.day_index for log in logs})
    completed_count = len(completed_days)
    current_day = max(completed_days) + 1 if completed_days else 1
    latest_logged_day = min(max(completed_days), total_days) if completed_days else 0

    missed_streak = 0
    for day in range(min(current_day - 1, total_days), 0, -1):
        if day in completed_days:
            break
        missed_streak += 1

    mood_values = [int(log.mood_tag) for log in logs if (log.mood_tag or "").isdigit()]
    focus_values = [log.focus_minutes for log in logs if log.focus_minutes is not None]
    recent_logs = []
    for log in logs[-5:]:
        recent_logs.append(
            {
                "day_index": log.day_index,
                "mood_tag": log.mood_tag,
                "mood_text": MOOD_LABELS.get(log.mood_tag or "", "状态未标记"),
                "focus_minutes": log.focus_minutes,
                "note": (log.note or "")[:160],
                "activities": _split_activities(log.activities),
                "created_at": log.created_at.isoformat() if log.created_at else None,
            }
        )

    missing_days = [
        day for day in range(1, min(current_day, total_days + 1)) if day not in completed_days
    ]

    if completed_count >= total_days:
        completion_status = "completed"
    elif missed_streak >= 3:
        completion_status = "stalled"
    elif completed_count == 0:
        completion_status = "not_started"
    else:
        completion_status = "in_progress"

    return {
        "total_days": total_days,
        "completed_days": completed_days,
        "completed_count": completed_count,
        "current_day": current_day,
        "latest_logged_day": latest_logged_day,
        "missing_days": missing_days,
        "consecutive_missed_days": missed_streak,
        "average_mood": _safe_round_average(mood_values),
        "average_focus_minutes": _safe_round_average(focus_values),
        "recent_logs": recent_logs,
        "completion_status": completion_status,
    }


def build_patient_snapshot(db: Session, current_user: User) -> dict:
    patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
    if patient is None:
        return {
            "patient_profile": {
                "name": current_user.full_name,
            },
            "latest_scale": None,
            "cognitive_profile": None,
            "latest_imaging_visualization": None,
            "latest_model_prediction": None,
            "tracking": _tracking_summary([]),
        }

    latest_scale = db.scalar(
        select(ScaleResult)
        .where(ScaleResult.patient_id == patient.id)
        .order_by(ScaleResult.created_at.desc(), ScaleResult.id.desc())
    )
    latest_imaging = db.scalar(
        select(ImagingVisualization)
        .where(ImagingVisualization.patient_id == patient.id)
        .order_by(ImagingVisualization.created_at.desc(), ImagingVisualization.id.desc())
    )
    latest_model_prediction = db.scalar(
        select(ModelPrediction)
        .where(ModelPrediction.patient_id == patient.id)
        .order_by(ModelPrediction.created_at.desc(), ModelPrediction.id.desc())
    )
    logs = db.scalars(
        select(TrackingLog)
        .where(TrackingLog.patient_id == patient.id)
        .order_by(TrackingLog.day_index.asc(), TrackingLog.created_at.asc())
    ).all()
    cognitive_profile = _extract_latest_cognitive_profile(db, patient.id)

    return {
        "patient_profile": {
            "name": current_user.full_name,
            "age": patient.age,
            "gender": patient.gender,
            "patient_type": patient.patient_type.value,
        },
        "latest_scale": _to_scale_response(latest_scale).model_dump(mode="json")
        if latest_scale
        else None,
        "cognitive_profile": cognitive_profile.model_dump(mode="json") if cognitive_profile else None,
        "latest_imaging_visualization": _to_imaging_response(latest_imaging).model_dump(mode="json")
        if latest_imaging
        else None,
        "latest_model_prediction": _to_model_prediction_response(latest_model_prediction).model_dump(mode="json")
        if latest_model_prediction
        else None,
        "tracking": _tracking_summary(logs),
    }


def _scope_labels(scope: str, snapshot: dict) -> list[str]:
    labels: list[str] = []
    if scope == "report":
        if (
            snapshot.get("latest_scale")
            or snapshot.get("cognitive_profile")
            or snapshot.get("latest_model_prediction")
        ):
            labels.append("report")
    elif scope == "tracking":
        labels.append("tracking")
    else:
        if (
            snapshot.get("latest_scale")
            or snapshot.get("cognitive_profile")
            or snapshot.get("latest_model_prediction")
        ):
            labels.append("report")
        if snapshot.get("tracking", {}).get("completed_count", 0):
            labels.append("tracking")
    return labels


def _trim_conversation(conversation: list[dict[str, str]], max_turns: int = 6) -> list[dict[str, str]]:
    filtered = []
    for turn in conversation[-max_turns:]:
        role = turn.get("role")
        content = (turn.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        filtered.append({"role": role, "content": content[:3000]})
    return filtered


def _chat_task_prompt(context_scope: str, user_message: str) -> str:
    scope_prompt = CHAT_SCOPE_PROMPTS.get(context_scope, CHAT_SCOPE_PROMPTS["general"])
    return (
        f"{scope_prompt}\n"
        "当前用户这轮最在意的问题如下，请优先回应这个问题本身："
        f"\n{user_message.strip()}"
    )


def _build_chat_messages(
    *,
    user_message: str,
    conversation: list[dict[str, str]],
    context_scope: str,
    snapshot: dict,
) -> list[dict[str, str]]:
    context_payload = {
        "scope": context_scope,
        "snapshot_brief": _build_snapshot_brief(snapshot),
        "snapshot": snapshot,
    }

    messages: list[dict[str, str]] = [
        {"role": "system", "content": AI_BASE_IDENTITY_PROMPT},
        {"role": "system", "content": AI_SAFETY_PROMPT},
        {"role": "system", "content": AI_GROUNDING_PROMPT},
        {"role": "system", "content": AI_STYLE_PROMPT},
        {"role": "system", "content": _patient_audience_prompt(snapshot)},
        {"role": "system", "content": _chat_task_prompt(context_scope, user_message)},
        {
            "role": "system",
            "content": (
                "以下是当前患者的结构化上下文，仅用于本轮回答。"
                "请优先使用 snapshot_brief 做总结，需要时再参考 snapshot 细节。"
                f"\n{json.dumps(context_payload, ensure_ascii=False)}"
            ),
        },
    ]
    messages.extend(_trim_conversation(conversation))
    messages.append({"role": "user", "content": user_message.strip()})
    return messages


def _fallback_general_reply(snapshot: dict) -> str:
    tracking = snapshot.get("tracking") or {}
    completed = tracking.get("completed_count", 0)
    current_day = tracking.get("current_day", 1)

    if snapshot.get("latest_scale"):
        scale_summary = snapshot["latest_scale"].get("summary") or "最近量表已经生成。"
    else:
        scale_summary = "你还没有可解读的量表结果。"

    if completed:
        tracking_summary = f"14 天追踪目前完成了 {completed}/14 天，下一步建议先补第 {current_day} 天。"
    else:
        tracking_summary = "14 天追踪还没开始，建议先记录今天的状态。"

    return (
        f"{AI_LOCAL_MODE_NOTE}"
        f"{scale_summary}{tracking_summary}"
    )


def build_fallback_chat_reply(message: str, context_scope: str, snapshot: dict, reason: str) -> str:
    if _is_high_risk_message(message):
        return _high_risk_reply()

    if context_scope == "report":
        report = heuristic_report_explanation(snapshot)
        return (
            f"{report['headline']}。{report['plain_summary']}"
            f"接下来可以先做这几步：{'；'.join(report['next_actions'][:2])}。"
            f"{reason}"
        )

    if context_scope == "tracking":
        reminder = heuristic_tracking_reminder(snapshot, tone="gentle")
        return (
            f"{reminder['title']}。{reminder['message']}"
            f"{reason}"
        )

    return _fallback_general_reply(snapshot)


def _scale_signal_text(scale_snapshot: dict | None) -> tuple[str, list[str], list[str]]:
    if not scale_snapshot:
        return (
            "目前还没有量表结果，暂时不能做完整报告解读。",
            [],
            ["先完成量表后再看 AI 解读。"],
        )

    radar_scores = scale_snapshot.get("radar_scores") or {}
    sorted_items = sorted(radar_scores.items(), key=lambda item: item[1], reverse=True)
    highlighted = [SCALE_LABELS.get(key, key) for key, _ in sorted_items[:2]]
    findings = []
    if highlighted:
        findings.append(
            f"量表里 {highlighted[0]}{' 和 ' + highlighted[1] if len(highlighted) > 1 else ''} 的波动更明显，说明这些场景更值得优先关注。"
        )

    summary = scale_snapshot.get("summary") or "最近量表提示存在一定功能波动。"
    recommendations = list(scale_snapshot.get("recommendations") or [])
    return summary, findings, recommendations


def _cognitive_signal_text(cognitive_snapshot: dict | None) -> tuple[list[str], list[str]]:
    if not cognitive_snapshot:
        return [], []

    radar_scores = cognitive_snapshot.get("radar_scores") or {}
    sorted_items = sorted(radar_scores.items(), key=lambda item: item[1])
    weak_areas = [COGNITIVE_LABELS.get(key, key) for key, _ in sorted_items[:2]]
    findings = []
    if weak_areas:
        findings.append(
            f"认知测试里 {weak_areas[0]}{' 和 ' + weak_areas[1] if len(weak_areas) > 1 else ''} 相对吃力，做任务时更容易觉得脑子转得慢或维持不住。"
        )

    actions = []
    if weak_areas:
        actions.append(f"安排任务时优先照顾 {weak_areas[0]} 相关负荷，先拆小再开始。")
    return findings, actions


def _tracking_signal_text(tracking_snapshot: dict) -> tuple[list[str], list[str]]:
    findings: list[str] = []
    actions: list[str] = []

    completed_count = tracking_snapshot.get("completed_count", 0)
    average_focus = tracking_snapshot.get("average_focus_minutes")
    missed_days = tracking_snapshot.get("consecutive_missed_days", 0)

    if completed_count:
        findings.append(f"14 天追踪目前完成 {completed_count}/14 天，已经能看到一些日常波动。")
    if average_focus is not None:
        findings.append(f"最近记录中的平均专注时长约 {average_focus} 分钟。")
    if missed_days >= 2:
        actions.append("如果最近几天断档了，不用补很多，先把今天这一条记上。")
    else:
        actions.append("继续连贯记录 3 到 5 天，趋势会比单次记录更有参考价值。")

    return findings, actions


def heuristic_report_explanation(snapshot: dict) -> dict:
    scale_summary, scale_findings, scale_actions = _scale_signal_text(snapshot.get("latest_scale"))
    cognitive_findings, cognitive_actions = _cognitive_signal_text(snapshot.get("cognitive_profile"))
    tracking_findings, tracking_actions = _tracking_signal_text(snapshot.get("tracking") or {})

    findings = (scale_findings + cognitive_findings + tracking_findings)[:3]
    actions = []
    for item in scale_actions + cognitive_actions + tracking_actions:
        if item and item not in actions:
            actions.append(item)
        if len(actions) >= 3:
            break

    if not actions:
        actions = [
            "继续完成量表、认知测试和 14 天追踪，结论会更稳定。",
            "把最容易分心的具体场景记下来，方便后续针对性调整。",
        ]

    return {
        "headline": "这是一次偏生活化的辅助解读",
        "plain_summary": scale_summary,
        "key_findings": findings or ["目前数据还不够丰富，建议先继续补充记录。"],
        "next_actions": actions,
        "disclaimer": AI_DISCLAIMER,
    }


def heuristic_tracking_reminder(snapshot: dict, tone: str = "gentle") -> dict:
    tracking = snapshot.get("tracking") or {}
    current_day = tracking.get("current_day", 1)
    completed_count = tracking.get("completed_count", 0)
    missed_streak = tracking.get("consecutive_missed_days", 0)
    completion_status = tracking.get("completion_status", "in_progress")

    if completion_status == "completed":
        return {
            "should_remind": False,
            "title": "14 天追踪已经完成",
            "message": "这段时间的记录已经很完整了，可以去 AI 助手里看看整体总结。",
            "action_label": "查看 AI 助手",
            "completion_status": completion_status,
            "disclaimer": AI_DISCLAIMER,
        }

    if completed_count == 0:
        return {
            "should_remind": True,
            "title": "今天就从第 1 天开始吧",
            "message": "不用追求写很多，先把今天的情绪和专注情况记一条就够了。",
            "action_label": "去记录今天",
            "completion_status": completion_status,
            "disclaimer": AI_DISCLAIMER,
        }

    if missed_streak >= 3:
        message = "已经断了几天也没关系，今天先补 1 条，我们先把节奏找回来。"
        if tone == "encouraging":
            message = "你不是掉队了，只是节奏乱了一点。今天先补 1 条，我们马上重新接上。"
        return {
            "should_remind": True,
            "title": f"已经连续 {missed_streak} 天没有记录了",
            "message": message,
            "action_label": "先记今天",
            "completion_status": completion_status,
            "disclaimer": AI_DISCLAIMER,
        }

    return {
        "should_remind": True,
        "title": f"第 {current_day} 天追踪还没完成",
        "message": "现在花 1 分钟记一下，会比晚上回想时更轻松也更准确。",
        "action_label": "去记录今天",
        "completion_status": completion_status,
        "disclaimer": AI_DISCLAIMER,
    }


def _provider_or_fallback_report(snapshot: dict, focus: str | None) -> tuple[dict, str, bool]:
    fallback = heuristic_report_explanation(snapshot)
    if not qwen_client.configured:
        return fallback, "fallback-template", True

    prompt = {
        "focus": focus or "latest_report",
        "brief": _build_snapshot_brief(snapshot),
        "snapshot": snapshot,
        "output_schema": {
            "headline": "一句简短标题",
            "plain_summary": "一段通俗总结，80-140字左右",
            "key_findings": ["2-3条与数据相关的发现"],
            "next_actions": ["2-3条今天或本周能执行的建议"],
            "disclaimer": AI_DISCLAIMER,
        },
        "writing_rules": [
            "优先解释数据，不要空泛安慰。",
            "可以提到趋势、波动、优先级，但不要说确诊。",
            "如果数据不足，要明确承认依据不足。",
            "建议必须小步可执行，不要给笼统口号。",
        ],
    }

    result = qwen_client.chat(
        model=settings.QWEN_CHAT_MODEL,
        messages=[
            {"role": "system", "content": AI_BASE_IDENTITY_PROMPT},
            {"role": "system", "content": AI_SAFETY_PROMPT},
            {"role": "system", "content": AI_GROUNDING_PROMPT},
            {"role": "system", "content": AI_STYLE_PROMPT},
            {"role": "system", "content": _patient_audience_prompt(snapshot)},
            {"role": "system", "content": REPORT_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
        ],
        temperature=0.3,
        max_tokens=1500,
    )

    parsed = _parse_json_object(result.content)
    response = {
        "headline": _normalize_display_text(str(parsed.get("headline") or fallback["headline"])),
        "plain_summary": _normalize_display_text(
            str(parsed.get("plain_summary") or fallback["plain_summary"])
        ),
        "key_findings": [
            _normalize_display_text(str(item).strip())
            for item in (parsed.get("key_findings") or fallback["key_findings"])
            if str(item).strip()
        ][:3],
        "next_actions": [
            _normalize_display_text(str(item).strip())
            for item in (parsed.get("next_actions") or fallback["next_actions"])
            if str(item).strip()
        ][:3],
        "disclaimer": _normalize_display_text(str(parsed.get("disclaimer") or AI_DISCLAIMER)),
    }
    return response, result.model, False


def generate_report_explanation(snapshot: dict, focus: str | None) -> tuple[dict, str, bool]:
    try:
        return _provider_or_fallback_report(snapshot, focus)
    except Exception:
        fallback = heuristic_report_explanation(snapshot)
        return fallback, "fallback-template", True


def _provider_or_fallback_reminder(snapshot: dict, tone: str) -> tuple[dict, str, bool]:
    fallback = heuristic_tracking_reminder(snapshot, tone=tone)
    if not qwen_client.configured:
        return fallback, "fallback-template", True

    prompt = {
        "task": "根据 14 天追踪完成情况，生成一条温和简短的提醒文案。",
        "rules": [
            "语气温和，不指责。",
            "控制在 80 字内。",
            "输出严格 JSON 对象，字段为 title, message, action_label。",
        ],
        "tone": tone,
        "tracking": snapshot.get("tracking"),
    }

    result = qwen_client.chat(
        model=settings.QWEN_REMINDER_MODEL,
        messages=[
            {"role": "system", "content": REMINDER_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
        ],
        temperature=0.4,
        max_tokens=350,
    )
    parsed = _parse_json_object(result.content)
    response = {
        "should_remind": fallback["should_remind"],
        "title": _normalize_display_text(str(parsed.get("title") or fallback["title"])),
        "message": _normalize_display_text(str(parsed.get("message") or fallback["message"])),
        "action_label": _normalize_display_text(
            str(parsed.get("action_label") or fallback["action_label"])
        ),
        "completion_status": fallback["completion_status"],
        "disclaimer": AI_DISCLAIMER,
    }
    return response, result.model, False


def generate_tracking_reminder(snapshot: dict, tone: str) -> tuple[dict, str, bool]:
    try:
        return _provider_or_fallback_reminder(snapshot, tone)
    except Exception:
        fallback = heuristic_tracking_reminder(snapshot, tone=tone)
        return fallback, "fallback-template", True


def generate_chat_reply(
    *,
    message: str,
    conversation: list[dict[str, str]],
    context_scope: str,
    snapshot: dict,
) -> tuple[str, str, bool]:
    if _is_high_risk_message(message):
        return _high_risk_reply(), "safety-guard", True

    if not qwen_client.configured:
        return (
            build_fallback_chat_reply(
                message,
                context_scope,
                snapshot,
                reason="当前先使用本地辅助模式。",
            ),
            "fallback-template",
            True,
        )

    try:
        messages = _build_chat_messages(
            user_message=message,
            conversation=conversation,
            context_scope=context_scope,
            snapshot=snapshot,
        )
        result = qwen_client.chat(
            model=settings.QWEN_CHAT_MODEL,
            messages=messages,
            temperature=0.45,
            max_tokens=800,
        )
        return result.content, result.model, False
    except Exception:
        return (
            build_fallback_chat_reply(
                message,
                context_scope,
                snapshot,
                reason="当前先使用本地辅助模式。",
            ),
            "fallback-template",
            True,
        )


def ai_status_message() -> str:
    if qwen_client.configured:
        return "千问模型已配置，AI 助手可以直接调用大模型。"
    return "AI 网关已接入，当前先使用本地辅助模式。"


def used_context_for_scope(scope: str, snapshot: dict) -> list[str]:
    return _scope_labels(scope, snapshot)
