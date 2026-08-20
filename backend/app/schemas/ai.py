from typing import Literal

from pydantic import BaseModel, Field


class AIConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class AIChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    conversation: list[AIConversationTurn] = Field(default_factory=list)
    context_scope: Literal["general", "report", "tracking"] = "general"


class AIChatResponse(BaseModel):
    reply: str
    model: str
    provider: str = "qwen"
    disclaimer: str
    used_context: list[str] = Field(default_factory=list)
    degraded: bool = False


class AIExplainReportRequest(BaseModel):
    focus: str | None = Field(default=None, max_length=200)


class AIExplainReportResponse(BaseModel):
    headline: str
    plain_summary: str
    key_findings: list[str] = Field(default_factory=list)
    next_actions: list[str] = Field(default_factory=list)
    disclaimer: str
    model: str
    provider: str = "qwen"
    degraded: bool = False


class AIReminderRequest(BaseModel):
    tone: Literal["gentle", "encouraging", "neutral"] = "gentle"


class AIReminderResponse(BaseModel):
    should_remind: bool
    title: str
    message: str
    action_label: str
    completion_status: str
    disclaimer: str
    model: str
    provider: str = "qwen"
    degraded: bool = False


class AIStatusResponse(BaseModel):
    configured: bool
    provider: str = "qwen"
    chat_model: str
    reminder_model: str
    fallback_available: bool = True
    message: str
