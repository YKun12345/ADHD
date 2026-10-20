"""Explicit local working periods and supplied institutional instructions."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class WorkingPeriod(BaseModel):
    model_config = ConfigDict(extra="forbid")
    weekday: int = Field(ge=0, le=6, strict=True)
    start: str = Field(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")
    end: str = Field(pattern=r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$")

    @model_validator(mode="after")
    def real_period(self):
        if self.start >= self.end:
            raise ValueError("Working periods must have a positive same-day duration.")
        return self


class ServiceCoverageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_coverage_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    expected_previous_version: int = Field(ge=0, strict=True)
    institution_id: str = Field(min_length=1, max_length=64)
    timezone: Literal["Asia/Shanghai"]
    working_periods: list[WorkingPeriod] = Field(min_length=1, max_length=28)
    expected_response_working_minutes: int = Field(gt=0, le=10080, strict=True)
    approved_process_reference: str = Field(min_length=1, max_length=255)
    escalation_instructions: str = Field(min_length=1, max_length=4000)
    configuration_context: str | None = Field(default=None, min_length=20, max_length=65536)

    @field_validator("institution_id", "approved_process_reference", "escalation_instructions")
    @classmethod
    def actual_text(cls, value):
        if not value.strip():
            raise ValueError("Actual institutional scope and supplied process instructions are required.")
        return value

    @model_validator(mode="after")
    def no_overlap(self):
        periods = sorted(self.working_periods, key=lambda value: (value.weekday, value.start, value.end))
        if any(a.weekday == b.weekday and a.end > b.start for a, b in zip(periods, periods[1:])):
            raise ValueError("Working periods cannot overlap or duplicate the same time.")
        return self
