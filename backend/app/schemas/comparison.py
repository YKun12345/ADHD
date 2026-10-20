"""Read-only comparison output; no client supplied evidence or clinical claims."""
from typing import Literal

from pydantic import BaseModel, Field


class ComparisonReason(BaseModel):
    code: str
    message: str
    severity: Literal['limited', 'not_comparable']


class ResultComparison(BaseModel):
    rule_version: str
    patient_id: int
    status: Literal['comparable', 'limited', 'not_comparable']
    status_label: str
    left: dict
    right: dict
    interval_days: float | None
    reasons: list[ComparisonReason] = Field(default_factory=list)
    numeric_changes: list[dict] = Field(default_factory=list)
    treatment_effect_conclusion_allowed: Literal[False] = False
    interpretation: str


class FollowupSummary(BaseModel):
    rule_version: str
    patient_id: int
    as_of_date: str
    calendar_timezone: str
    cycles: list[dict]
    measurements: list[dict]
    comparisons: list[ResultComparison]
    coverage: dict
    reported_events: list[dict]
    next_steps: list[dict]
    limitations: list[str]
    truncated: dict
    treatment_effect_conclusion_allowed: Literal[False] = False
