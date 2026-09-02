from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PatientTaskCreateRequest(BaseModel):
    task_type: Literal["scale", "cognitive", "tracking", "report_review"]
    task_title: str = Field(min_length=1, max_length=120)
    task_description: str = Field(min_length=1, max_length=1000)
    target_page: str | None = Field(default=None, max_length=120)
    target_payload_json: str | None = None
    priority: int = Field(default=1, ge=1, le=5)
    due_at: datetime | None = None

    @field_validator("task_title")
    @classmethod
    def validate_task_title(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("任务标题不能为空")
        return normalized

    @field_validator("task_description")
    @classmethod
    def validate_task_description(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("任务说明不能为空")
        return normalized

    @field_validator("target_page", "target_payload_json")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None

    @field_validator("due_at")
    @classmethod
    def validate_due_at(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        normalized = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        if normalized <= datetime.now(timezone.utc):
            raise ValueError("截止时间必须晚于当前时间")
        return value


class PatientTaskResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    patient_id: int
    researcher_id: int
    task_type: str
    status: str
    priority: int
    task_title: str
    task_description: str | None = None
    target_page: str | None = None
    target_payload_json: str | None = None
    due_at: datetime | None = None
    researcher_name: str = "医生"
    created_at: datetime
    completed_at: datetime | None = None


class PatientTaskListResponse(BaseModel):
    items: list[PatientTaskResponse]


class CareMessageCreateRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    client_message_id: str = Field(
        min_length=8,
        max_length=64,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("消息内容不能为空")
        return normalized


class CareMessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    patient_id: int
    sender_user_id: int
    sender_role: str
    message_type: str
    content: str
    client_message_id: str | None = None
    created_at: datetime
    related_task_id: int | None = None
    sender_name: str = ""
    read_at: datetime | None = None


class CareMessageListResponse(BaseModel):
    items: list[CareMessageResponse]


class CareSummaryResponse(BaseModel):
    unread_message_count: int = 0
    pending_task_count: int = 0


class ReadReceiptResponse(BaseModel):
    updated_count: int = 0


class AIChatLogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    patient_id: int
    session_id: str | None = None
    role: str
    scope: str
    content: str
    created_at: datetime


class AIChatLogListResponse(BaseModel):
    items: list[AIChatLogResponse]
