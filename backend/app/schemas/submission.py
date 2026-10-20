from datetime import datetime
from typing import Any,Literal
from pydantic import BaseModel,Field,model_validator
from backend.app.schemas.assessment import StrictRequest,DeviceMetadata,InputMetadata,TimingMetadata,PracticeMetadata,AssistanceMetadata


class PracticeRecord(StrictRequest):
    attempt: int = Field(gt=0,le=3)
    trials: list[dict[str,Any]] = Field(max_length=100)


class CompletionMetadata(StrictRequest):
    device: DeviceMetadata
    input: InputMetadata
    timing: TimingMetadata
    practice: PracticeMetadata
    assistance: AssistanceMetadata
    interrupted_count: int = Field(ge=0,le=100000)
    practice_records: list[PracticeRecord] = Field(max_length=3)


class ScaleContent(StrictRequest):
    scale_type: Literal['ASRS','SNAP_IV']
    answers: list[int] = Field(min_length=1,max_length=26)
    recall_window: Literal['P6M']
    content_digest: str = Field(min_length=1,max_length=64)


class CognitiveContent(StrictRequest):
    test_type: str = Field(min_length=1,max_length=64)
    result_json: dict[str,Any]
    execution_metadata: CompletionMetadata


class SubmissionCreate(StrictRequest):
    submission_id: str = Field(pattern=r'^[A-Za-z0-9_.:-]{1,64}$')
    kind: Literal['scale','cognitive']
    patient_id: int = Field(gt=0)
    assessment_id: int = Field(gt=0)
    assessment_item_id: int = Field(gt=0)
    attempt_id: int = Field(gt=0)
    run_id: str = Field(pattern=r'^[A-Za-z0-9_.:-]{1,64}$')
    task_id: int | None = Field(gt=0)
    protocol_id: str = Field(min_length=1,max_length=96)
    protocol_schema_version: int = Field(gt=0)
    config_digest: str = Field(min_length=1,max_length=64)
    template_digest: str = Field(min_length=1,max_length=64)
    actor_user_id: int = Field(gt=0)
    performer_kind: Literal['user','patient']
    performer_user_id: int | None = Field(gt=0)
    performer_patient_id: int | None = Field(gt=0)
    respondent_user_id: int | None = Field(gt=0)
    respondent_kind: Literal['self','primary_guardian'] | None
    submitter_user_id: int = Field(gt=0)
    content: ScaleContent | CognitiveContent

    @model_validator(mode='after')
    def matching_content_kind(self):
        if self.kind == 'scale' and not isinstance(self.content,ScaleContent) or self.kind == 'cognitive' and not isinstance(self.content,CognitiveContent):
            raise ValueError('The submission kind must match its typed real content.')
        return self


class SubmissionAck(BaseModel):
    submission_id: str
    patient_id: int
    assessment_id: int
    assessment_item_id: int
    attempt_id: int
    run_id: str
    task_id: int | None
    canonical_digest: str
    submission_status: Literal['committed'] = 'committed'
    result: dict
    execution_status: str
    quality_status: str
    quality_reasons: list[str]
    quality_rule_version: str
    comparability_status: str
    comparability_reasons: list[str]
    acceptance_status: str
    assessment_status: str
    assessment_version: int
    item_version: int
    committed_at: datetime
