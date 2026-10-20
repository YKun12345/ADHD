"""Actual actor, authority and result status are server facts."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AttentionActionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_action_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    expected_version: int = Field(gt=0, strict=True)
    action: Literal["acknowledge", "resolve", "close_with_reason"]
    reason: str | None = Field(default=None, max_length=2000)
    action_context: str = Field(min_length=20, max_length=65536)
    confirmed: bool = Field(strict=True)

    @field_validator("reason")
    @classmethod
    def actual_reason(cls, value):
        if value is not None and not value.strip():
            raise ValueError("A supplied explanation must contain actual nonempty text.")
        return value

    @model_validator(mode="after")
    def explicit_action(self):
        if self.confirmed is not True:
            raise ValueError("The actual actor must explicitly confirm this attention action.")
        if self.action in {"resolve", "close_with_reason"} and self.reason is None:
            raise ValueError("Resolving or closing attention requires an actual explanation.")
        return self
