from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import Annotated, Literal


class AgentActionResolve(BaseModel):
    model_config = ConfigDict(extra='forbid')
    patient_id: int = Field(gt=0, strict=True)
    expected_action_digest: str = Field(pattern=r'^[a-f0-9]{64}$')


class AgentMessageConsent(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: Literal['Xingzai-current-message-1', 'Xingzai-selected-dialogue-1']
    confirmed: bool = Field(strict=True)


class AgentRunCreate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    client_run_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_.:-]+$')
    patient_id: int = Field(gt=0, strict=True)
    intent: Literal['question', 'assessment_summary', 'cycle_summary', 'review_questions', 'plan_draft', 'reply_draft', 'profile_fields'] = 'question'
    assessment_id: int | None = Field(default=None, gt=0, strict=True)
    cycle_id: int | None = Field(default=None, gt=0, strict=True)
    message: str = Field(min_length=1, max_length=4000)
    expected_context_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    run_context: str = Field(min_length=20, max_length=65536)
    external_message_consent: AgentMessageConsent | None = None
    context_run_ids: list[Annotated[int, Field(gt=0, strict=True)]] | None = Field(default=None, max_length=2)

    @field_validator('context_run_ids')
    @classmethod
    def unique_context_runs(cls, value):
        if value is not None and len(value) != len(set(value)):
            raise ValueError('Select each completed conversation once.')
        return value


class ArtifactDecisionCreate(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    client_decision_id:str=Field(min_length=1,max_length=64,pattern=r'^[A-Za-z0-9_.:-]+$')
    patient_id:int=Field(gt=0,strict=True)
    artifact_id:int=Field(gt=0,strict=True)
    expected_previous_version:int=Field(ge=0,strict=True)
    decision_context:str=Field(min_length=20,max_length=131072)
    decision:Literal['adopt','edit','reject']
    content:dict | None=None
    reason:str=Field(min_length=1,max_length=2000)
    confirmed:bool=Field(strict=True)
    confirmed_fields:list[str] | None=Field(default=None,max_length=5)
