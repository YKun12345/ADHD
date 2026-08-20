from pydantic import BaseModel, ConfigDict, EmailStr, Field


class PatientProfileCreate(BaseModel):
    age: int | None = Field(default=None, ge=1, le=120)
    gender: str | None = Field(default=None, max_length=32)
    patient_type: str | None = Field(default=None, pattern="^(adult|child)$")


class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    full_name: str = Field(min_length=2, max_length=100)
    role: str = Field(pattern="^(patient|researcher)$")
    subrole: str | None = Field(default=None, pattern="^(normal|dac)$")
    staff_id: str | None = Field(default=None, min_length=3, max_length=64)
    consent_agreed: bool = False
    patient_profile: PatientProfileCreate | None = None


class UserLogin(BaseModel):
    identifier: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=128)
    role: str | None = Field(default=None, pattern="^(patient|researcher)$")
    subrole: str | None = Field(default=None, pattern="^(normal|dac)$")


class PatientProfileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
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
