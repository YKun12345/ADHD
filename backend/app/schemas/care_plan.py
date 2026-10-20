from datetime import date
from pydantic import BaseModel, ConfigDict, Field, model_validator


class PlanPublication(BaseModel):
    model_config = ConfigDict(extra='forbid')
    client_plan_version_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_.:-]+$')
    patient_id: int = Field(gt=0, strict=True)
    assessment_id: int = Field(gt=0, strict=True)
    expected_assessment_version: int = Field(gt=0, strict=True)
    expected_previous_version: int = Field(ge=0, strict=True)
    expected_plan_revision: int = Field(ge=0, strict=True)
    source_report_id: int = Field(gt=0, strict=True)
    input_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    plan_context: str = Field(min_length=20, max_length=65536)
    title: str = Field(min_length=1, max_length=120)
    instructions: str = Field(min_length=1, max_length=4000)
    start_date: date
    end_date: date
    confirmed: bool = Field(strict=True)
    source_ai_decision_id: int | None = Field(default=None,gt=0,strict=True)

    @model_validator(mode='after')
    def actual_schedule(self):
        if not self.confirmed or not self.title.strip() or not self.instructions.strip() or not 0 <= (self.end_date - self.start_date).days <= 365:
            raise ValueError('An actual doctor, real bounded dates and instructions are required.')
        return self


class PlanReceipt(BaseModel):
    model_config = ConfigDict(extra='forbid')
    client_acknowledgement_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_.:-]+$')
    patient_id: int = Field(gt=0, strict=True)
    assessment_id: int = Field(gt=0, strict=True)
    plan_version_id: int = Field(gt=0, strict=True)
    acknowledgement_context: str = Field(min_length=20, max_length=65536)
    confirmed: bool = Field(strict=True)

    @model_validator(mode='after')
    def received_only(self):
        if self.confirmed is not True:
            raise ValueError('The actual user must confirm receiving this plan version.')
        return self
