"""Bounded self-report data; no clinical recommendations or client identity claims."""
from datetime import date, datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.app.schemas.tracking import normalize_activities


class CareCycleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patient_id: int = Field(gt=0)
    client_cycle_id: str = Field(min_length=1,max_length=64,pattern=r"^[A-Za-z0-9_.:-]+$")
    start_date: date
    end_date: date
    cycle_type: Literal["self","professional"] = "self"

    @model_validator(mode="after")
    def bounded_dates(self):
        if not 0 <= (self.end_date-self.start_date).days <= 365:
            raise ValueError("Cycles require 1 to 366 inclusive real calendar days.")
        return self


class DailyRecordContent(BaseModel):
    model_config = ConfigDict(extra="forbid",allow_inf_nan=False)
    mood_tag: str | None = Field(default=None,max_length=32)
    focus_minutes: int | None = Field(default=None,ge=0,le=1440,strict=True)
    note: str | None = Field(default=None,max_length=500)
    test_score: float | None = None
    activities: list[str] | None = None
    is_medication: bool | None = None
    medication_dosage: str | None = Field(default=None,max_length=200)
    attention_rating: int | None = Field(default=None,ge=1,le=5,strict=True)
    hyperactivity_rating: int | None = Field(default=None,ge=1,le=5,strict=True)
    impulsivity_rating: int | None = Field(default=None,ge=1,le=5,strict=True)
    emotion_rating: int | None = Field(default=None,ge=1,le=5,strict=True)
    task_completion_rating: int | None = Field(default=None,ge=1,le=5,strict=True)
    sleep_quality: str | None = Field(default=None,max_length=64)
    appetite_quality: str | None = Field(default=None,max_length=64)
    has_conflict: bool | None = None
    was_criticized: bool | None = None
    side_effects: str | None = Field(default=None,max_length=200)
    special_events: str | None = Field(default=None,max_length=1000)
    highlights: str | None = Field(default=None,max_length=1000)

    @field_validator("activities",mode="before")
    @classmethod
    def valid_activities(cls,value):
        return normalize_activities(value)

    @model_validator(mode="after")
    def actual_observation(self):
        if not any(value is not None and value != "" for value in self.model_dump().values()):
            raise ValueError("At least one actual self-reported observation is required; missing is not zero.")
        return self


class DailyRecordCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patient_id: int = Field(gt=0)
    cycle_id: int = Field(gt=0)
    record_date: date
    client_submission_id: str = Field(min_length=1,max_length=64,pattern=r"^[A-Za-z0-9_.:-]+$")
    expected_revision: int = Field(default=0,ge=0,strict=True)
    recorded_at: datetime | None = None
    content: DailyRecordContent

    @field_validator("recorded_at")
    @classmethod
    def aware_original_time(cls,value):
        if value is not None:
            if value.tzinfo is None or value.utcoffset() is None:
                raise ValueError("The original reported time requires an explicit timezone or must remain unknown.")
            return value.astimezone(timezone.utc)
        return value
