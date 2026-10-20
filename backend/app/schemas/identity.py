from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field

from backend.app.schemas.consent import Scope, ConsentCreate


class RevisionRequest(BaseModel):
    expected_revision: int = Field(ge=1)


class GuardianSelfConfirmation(RevisionRequest):
    confirmed: Literal[True]
    guardian_age: int = Field(ge=18, le=120)
    declaration_version: Literal["guardian-self-declaration-2026-10-19"]


class RelationshipInvitation(BaseModel):
    target_email: str = Field(min_length=3, max_length=255)
    patient_id: int | None = Field(default=None, gt=0)
    scope: list[Scope] = Field(default=["profile", "assessment", "tracking", "care", "imaging"], min_length=1, max_length=5)
    purpose: Literal["clinical_sharing"] = "clinical_sharing"
    expires_at: datetime | None = None


class GuardianChange(RevisionRequest):
    review_reference: str = Field(min_length=1, max_length=255)
    expires_at: datetime | None = None
    status: Literal["verified", "rejected"] | None = None
    new_guardian_user_id: int | None = Field(default=None, gt=0)
    proof_reference: str | None = Field(default=None, min_length=1, max_length=255)
    new_guardian_confirmed: Literal[True] | None = None
    adult_user_id: int | None = Field(default=None, gt=0)
    adult_confirmed: Literal[True] | None = None
    age: int | None = Field(default=None, ge=18, le=120)


class IdentityConfirm(RevisionRequest):
    proof_reference: str = Field(min_length=1, max_length=255)
    terms_version: Literal["W02-1"]
    age: int = Field(ge=18, le=120)
