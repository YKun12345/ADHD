from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


def normalize_activities(value: object) -> list[str] | None:
    if value is None:
        return None
    values = value.split(",") if isinstance(value, str) else value
    if not isinstance(values, list):
        raise ValueError("活动标签必须是字符串数组")
    normalized: list[str] = []
    for item in values:
        if not isinstance(item, str):
            raise ValueError("活动标签必须是字符串")
        tag = item.strip()
        if not tag:
            continue
        if "," in tag or len(tag) > 32:
            raise ValueError("单个活动标签不能含逗号且最多 32 个字符")
        if tag not in normalized:
            normalized.append(tag)
    if len(normalized) > 20 or len(",".join(normalized)) > 500:
        raise ValueError("活动标签数量或总长度超过限制")
    return normalized or None


class TrackingLogBase(BaseModel):
    day_index: int = Field(ge=1, le=14)
    mood_tag: Optional[str] = Field(default=None, max_length=32)
    focus_minutes: Optional[int] = Field(default=None, ge=0, le=1440)
    note: Optional[str] = Field(default=None, max_length=500)
    test_score: Optional[float] = None
    activities: Optional[list[str]] = None

    @field_validator("activities", mode="before")
    @classmethod
    def validate_activities(cls, value: object) -> list[str] | None:
        return normalize_activities(value)

    # Medication tracking
    is_medication: Optional[bool] = False
    medication_dosage: Optional[str] = None

    # 5 core ratings (1-5 scale)
    attention_rating: Optional[int] = Field(default=None, ge=1, le=5)
    hyperactivity_rating: Optional[int] = Field(default=None, ge=1, le=5)
    impulsivity_rating: Optional[int] = Field(default=None, ge=1, le=5)
    emotion_rating: Optional[int] = Field(default=None, ge=1, le=5)
    task_completion_rating: Optional[int] = Field(default=None, ge=1, le=5)

    # Life items
    sleep_quality: Optional[str] = None
    appetite_quality: Optional[str] = None
    has_conflict: Optional[bool] = False
    was_criticized: Optional[bool] = False
    side_effects: Optional[str] = Field(default=None, max_length=200)

    # Extended notes
    special_events: Optional[str] = Field(default=None, max_length=1000)
    highlights: Optional[str] = Field(default=None, max_length=1000)


class TrackingLogCreate(TrackingLogBase):
    pass


class TrackingLogUpdate(BaseModel):
    mood_tag: Optional[str] = None
    focus_minutes: Optional[int] = None
    note: Optional[str] = None
    test_score: Optional[float] = None
    activities: Optional[list[str]] = None

    @field_validator("activities", mode="before")
    @classmethod
    def validate_activities(cls, value: object) -> list[str] | None:
        return normalize_activities(value)

    is_medication: Optional[bool] = None
    medication_dosage: Optional[str] = None

    attention_rating: Optional[int] = None
    hyperactivity_rating: Optional[int] = None
    impulsivity_rating: Optional[int] = None
    emotion_rating: Optional[int] = None
    task_completion_rating: Optional[int] = None

    sleep_quality: Optional[str] = None
    appetite_quality: Optional[str] = None
    has_conflict: Optional[bool] = None
    was_criticized: Optional[bool] = None
    side_effects: Optional[str] = None

    special_events: Optional[str] = None
    highlights: Optional[str] = None


class TrackingLogResponse(TrackingLogBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    patient_id: int
    created_at: datetime


class DashboardStatusResponse(BaseModel):
    current_day: int
    completed_days: list[int]
    total_days: int = 14
    logs: list[TrackingLogResponse]
    next_task: Optional[str] = "daily_log"


class TrackingSummaryResponse(BaseModel):
    total_days: int = 14
    completed_days: list[int]
    completed_count: int
    current_day: int
    latest_day_index: int | None = None
    completion_status: str
    consecutive_missed_days: int = 0
    average_mood: float | None = None
    average_focus_minutes: float | None = None
    latest_mood_text: str | None = None
    latest_note_excerpt: str | None = None
