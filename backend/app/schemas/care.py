from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PatientTaskCreateRequest(BaseModel):
    task_type: Literal["scale", "cognitive", "tracking", "report_review"]
    task_title: str = Field(min_length=1, max_length=120)
    task_description: str | None = Field(default=None, max_length=1000)
    target_page: str | None = Field(default=None, max_length=120)
    target_payload_json: str | None = None
    priority: int = Field(default=1, ge=1, le=5)


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
    created_at: datetime
    completed_at: datetime | None = None


class PatientTaskListResponse(BaseModel):
    items: list[PatientTaskResponse]


class CareMessageCreateRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class CareMessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    patient_id: int
    sender_user_id: int
    sender_role: str
    message_type: str
    content: str
    created_at: datetime
    related_task_id: int | None = None


class CareMessageListResponse(BaseModel):
    items: list[CareMessageResponse]


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
