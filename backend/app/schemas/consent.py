from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field

Scope = Literal["profile", "assessment", "tracking", "care", "imaging"]


class ConsentCreate(BaseModel):
    patient_id: int = Field(gt=0)
    purpose: Literal["basic_use", "clinical_sharing", "external_ai", "research"]
    scope: list[Scope] = Field(min_length=1, max_length=5)
    terms_version: Literal["W02-1"]
    target_user_id: int | None = Field(default=None, gt=0)
    project_id: int | None = Field(default=None, gt=0)
    expected_project_revision: int | None = Field(default=None, gt=0)
    expires_at: datetime | None = None


