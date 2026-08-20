from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class TrackingLogBase(BaseModel):
    day_index: int
    mood_tag: Optional[str] = None
    focus_minutes: Optional[int] = None
    note: Optional[str] = None
    test_score: Optional[float] = None
    activities: Optional[str] = None

    # Medication tracking
    is_medication: Optional[bool] = False
    medication_dosage: Optional[str] = None

    # 5 core ratings (1-5 scale)
    attention_rating: Optional[int] = None
    hyperactivity_rating: Optional[int] = None
    impulsivity_rating: Optional[int] = None
    emotion_rating: Optional[int] = None
    task_completion_rating: Optional[int] = None

    # Life items
    sleep_quality: Optional[str] = None
    appetite_quality: Optional[str] = None
    has_conflict: Optional[bool] = False
    was_criticized: Optional[bool] = False
    side_effects: Optional[str] = None

    # Extended notes
    special_events: Optional[str] = None
    highlights: Optional[str] = None


class TrackingLogCreate(TrackingLogBase):
    pass


class TrackingLogUpdate(BaseModel):
    mood_tag: Optional[str] = None
    focus_minutes: Optional[int] = None
    note: Optional[str] = None
    test_score: Optional[float] = None
    activities: Optional[str] = None

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
    id: int
    patient_id: int
    created_at: datetime

    class Config:
        from_attributes = True


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
