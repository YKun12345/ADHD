from datetime import date
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class NextDates(BaseModel):
    model_config = ConfigDict(extra='forbid')
    start_date: date
    end_date: date


class FollowupPlan(NextDates):
    title: str = Field(min_length=1,max_length=120)
    instructions: str = Field(min_length=1,max_length=4000)


class CycleReviewCreate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    client_cycle_review_id: str = Field(min_length=1,max_length=64,pattern=r'^[A-Za-z0-9_.:-]+$')
    patient_id: int = Field(gt=0,strict=True)
    cycle_id: int = Field(gt=0,strict=True)
    expected_previous_version: int = Field(ge=0,strict=True)
    input_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    review_context: str = Field(min_length=20,max_length=196608)
    decision: Literal['continue','adjust','end','next_round']
    body: str = Field(min_length=1,max_length=8000)
    limitations: str = Field(min_length=1,max_length=2000)
    reason: str = Field(min_length=1,max_length=2000)
    followup_plan: FollowupPlan | None = None
    next_cycle: NextDates | None = None
    confirmed: bool = Field(strict=True)
    source_ai_decision_id: int | None = Field(default=None,gt=0,strict=True)

    @model_validator(mode='after')
    def explicit_decision(self):
        if not self.confirmed or any(not value.strip() for value in (self.body,self.limitations,self.reason)):
            raise ValueError('An actual confirmed reason, body and limitations are required.')
        if (self.decision in {'continue','adjust'}) != (self.followup_plan is not None):
            raise ValueError('Continue or adjust requires an actual future plan; other decisions do not publish one.')
        return self
