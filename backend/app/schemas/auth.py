from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator
from typing import Literal


class PatientProfileCreate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=100)
    age: int | None = Field(default=None, ge=1, le=120)
    gender: str | None = Field(default=None, max_length=32)
    patient_type: str | None = Field(default=None, pattern="^(adult|child)$")


class GuardianCreate(BaseModel):
    age: int = Field(ge=18, le=120)
    relation: Literal["parent", "legal_guardian"]
    proof_reference: str = Field(default="监护人本人声明", min_length=1, max_length=255)
    confirmed: Literal[True]


class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    full_name: str = Field(min_length=2, max_length=100)
    role: str = Field(pattern="^(patient|researcher)$")
    subrole: str | None = Field(default=None, pattern="^(normal|dac)$")
    staff_id: str | None = Field(default=None, min_length=3, max_length=64)
    consent_agreed: bool = False
    patient_profile: PatientProfileCreate | None = None
    guardian: GuardianCreate | None = None
    account_only: bool = False

    @model_validator(mode="after")
    def validate_identities(self):
        profile = self.patient_profile
        if self.account_only:
            if self.role != "patient" or profile is not None or self.guardian is not None:
                raise ValueError("Account-only registration cannot include patient or guardian authority.")
            return self
        if profile and profile.patient_type == "child":
            if profile.age is None or not 1 <= profile.age <= 17 or not profile.display_name or not profile.display_name.strip() or self.guardian is None:
                raise ValueError("Child registration needs age 1..17, child display name and confirmed guardian evidence.")
        elif profile and profile.patient_type == "adult":
            if profile.age is None or not 18 <= profile.age <= 120:
                raise ValueError("Adult patient age must be 18..120.")
            if self.guardian is not None:
                raise ValueError("Adult self registration cannot include guardian authority.")
        return self


class UserLogin(BaseModel):
    identifier: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=128)
    role: str | None = Field(default=None, pattern="^(patient|researcher)$")
    subrole: str | None = Field(default=None, pattern="^(normal|dac)$")


class PatientProfileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    display_name: str | None = None
    age: int | None = None
    gender: str | None = None
    patient_type: str


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    staff_id: str | None = None
    full_name: str
    role: str
    subrole: str | None = None
    consent_agreed: bool
    is_active: bool
    patient_profile: PatientProfileRead | None = None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead
