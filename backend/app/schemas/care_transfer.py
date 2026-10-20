"""No actor, responsibility or authorization is inferred from client JSON."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class TransferSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_type: Literal["attention", "transferred_work"]
    source_id: int = Field(gt=0, strict=True)
    expected_version: int = Field(gt=0, strict=True)


class TransferPreflight(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patient_id: int = Field(gt=0, strict=True)
    receiving_relationship_id: int = Field(gt=0, strict=True)
    sources: list[TransferSource] = Field(min_length=1, max_length=10)
    reason: str | None = Field(default=None, max_length=2000)

    @field_validator("sources")
    @classmethod
    def unique_sources(cls, values):
        if len({(value.source_type, value.source_id) for value in values}) != len(values):
            raise ValueError("Each concrete source can occur only once.")
        return sorted(values, key=lambda value: (value.source_type, value.source_id))

    @field_validator("reason")
    @classmethod
    def actual_reason(cls, value):
        if value is not None and not value.strip():
            raise ValueError("A supplied reason must contain actual text.")
        return value


class TransferRequestCreate(TransferPreflight):
    client_transfer_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    request_context: str = Field(min_length=20, max_length=65536)
    confirmed: bool = Field(strict=True)

    @model_validator(mode="after")
    def explicit_confirmation(self):
        if self.confirmed is not True:
            raise ValueError("The actual user must confirm the concrete recipient and object list.")
        return self


class TransferDecisionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patient_id: int = Field(gt=0, strict=True)
    transfer_id: int = Field(gt=0, strict=True)
    client_decision_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    expected_version: int = Field(gt=0, strict=True)
    decision: Literal["accept", "reject", "cancel"]
    reason: str | None = Field(default=None, max_length=2000)
    decision_context: str = Field(min_length=20, max_length=65536)
    confirmed: bool = Field(strict=True)

    @model_validator(mode="after")
    def actual_decision(self):
        if not self.confirmed or (self.reason is not None and not self.reason.strip()) or (self.decision != "accept" and self.reason is None):
            raise ValueError("Confirm the actual decision; rejection or cancellation requires a real explanation.")
        return self


class TransferWorkActionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patient_id: int = Field(gt=0, strict=True)
    work_item_id: int = Field(gt=0, strict=True)
    client_action_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:-]+$")
    expected_version: int = Field(gt=0, strict=True)
    action: Literal["acknowledge", "resolve", "close_with_reason"]
    reason: str | None = Field(default=None, max_length=2000)
    action_context: str = Field(min_length=20, max_length=65536)
    confirmed: bool = Field(strict=True)

    @model_validator(mode="after")
    def actual_action(self):
        if not self.confirmed or (self.reason is not None and not self.reason.strip()) or (self.action != "acknowledge" and self.reason is None):
            raise ValueError("Confirm the actual action; resolution or closure requires a real explanation.")
        return self
