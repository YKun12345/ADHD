"""Client observations are accepted; ownership and state are server assigned."""
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class BackgroundField(StrictRequest):
    status: Literal["provided", "unknown", "skipped"]
    value: Any = None
    source: Literal["self_report", "guardian_report", "patient_report"]
    confirmed: bool = False

    @model_validator(mode="after")
    def require_real_confirmation(self):
        if self.status == "provided" and (self.value is None or not self.confirmed):
            raise ValueError("Provided background needs an actual value and confirmation.")
        if self.status != "provided" and self.value is not None:
            raise ValueError("Unknown or skipped background must remain null.")
        return self


class AssessmentCreateRequest(StrictRequest):
    patient_id: int = Field(gt=0)
    template_id: str = Field(min_length=1, max_length=64)
    template_version: str = Field(min_length=1, max_length=64)
    previous_assessment_id: int | None = Field(default=None, gt=0)
    background: dict[str, BackgroundField] = Field(default_factory=dict, max_length=40)
    source_ai_decision_id: int | None = Field(default=None, gt=0)
    client_assessment_id: str | None = Field(default=None,min_length=1,max_length=64,pattern=r'^[A-Za-z0-9_.:-]+$')

    @model_validator(mode='after')
    def paired_adoption(self):
        if (self.source_ai_decision_id is None) != (self.client_assessment_id is None):
            raise ValueError('An adopted background requires its exact source decision and unique target ID.')
        return self


class AssessmentPublishRequest(StrictRequest):
    expected_version: int = Field(gt=0)


class DeviceMetadata(StrictRequest):
    platform: str = Field(min_length=1, max_length=64)
    device_type: str = Field(min_length=1, max_length=64)
    viewport_width: int | None = Field(default=None, gt=0, le=20000)
    viewport_height: int | None = Field(default=None, gt=0, le=20000)
    device_model: str | None = Field(default=None, max_length=128)
    environment: str | None = Field(default=None, max_length=256)
    layout_digest: str | None = Field(default=None, max_length=128)


class InputMetadata(StrictRequest):
    method: Literal["touch", "mouse", "keyboard", "unknown"]


class TimingMetadata(StrictRequest):
    clock_source: str = Field(min_length=1, max_length=64)
    unit: Literal["ms", "unknown"]
    display_refresh_hz: float | None = Field(default=None, gt=0, le=1000)
    calibrated: bool = False


class PracticeMetadata(StrictRequest):
    completed: bool
    attempts: int = Field(ge=0, le=100)
    exposure_count: int = Field(ge=0, le=100000)


class AssistanceMetadata(StrictRequest):
    provided: bool
    kind: str = Field(min_length=1, max_length=64)


class TaskAttemptCreateRequest(StrictRequest):
    repeat_report_id: int | None = Field(default=None, gt=0)
    expected_item_version: int = Field(gt=0)
    protocol_id: str = Field(min_length=1, max_length=96)
    protocol_schema_version: int = Field(ge=1, le=1000000)
    config_digest: str = Field(min_length=1, max_length=64)
    performer_patient_id: int | None = Field(gt=0)
    respondent_kind: Literal["self", "primary_guardian"] | None = None
    confirmed: bool
    device: DeviceMetadata
    input: InputMetadata
    timing: TimingMetadata
    practice: PracticeMetadata
    assistance: AssistanceMetadata
    recall_window: Literal["P6M"] | None = None


class TaskAttemptResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    assessment_id: int
    assessment_item_id: int
    patient_id: int
    run_id: str
    actor_user_id: int
    performer_patient_id: int | None
    performer_user_id: int | None
    performer_kind: str
    respondent_user_id: int | None
    respondent_kind: str | None
    submitter_user_id: int
    age_at_attempt: int
    age_group: str
    protocol_id: str
    protocol_schema_version: int
    config_digest: str
    config_snapshot: dict
    template_digest: str
    metadata: dict
    recall_window: str | None
    authorization_snapshot: list
    execution_status: str
    quality_status: str
    acceptance_status: str
    created_at: datetime
    submission_id: str | None = None
    result: dict | None = None
    quality_reasons: list[str] = Field(default_factory=list)


class AssessmentItemResponse(BaseModel):
    repeat_request: dict | None = None
    id: int
    assessment_id: int
    patient_id: int
    key: str
    kind: str
    instrument: str
    title: str
    respondent_kind: str | None
    protocol_id: str
    protocol_schema_version: int
    config_digest: str
    config: dict
    recall_window: str | None
    content_digest: str | None
    execution_status: str
    quality_status: str
    acceptance_status: str
    version: int
    patient_task_id: int | None
    attempts: list[TaskAttemptResponse]
    allowed_actions: list[str]


class AssessmentSessionResponse(BaseModel):
    usage_scope: str = "reference_assessment"
    usage_notice: str = ""
    suspension_reason: str | None = None
    id: int
    patient_id: int
    source: str
    responsible_doctor_id: int | None
    created_by_user_id: int
    template_id: str
    template_version: str
    template_digest: str
    age_at_assessment: int
    age_group: str
    previous_assessment_id: int | None
    status: str
    version: int
    demonstration_only: bool
    background: dict
    background_visibility: str = "shared"
    source_ai_decision_id: int | None = None
    authorization_snapshot: list
    created_at: datetime
    published_at: datetime | None
    items: list[AssessmentItemResponse]
    allowed_actions: list[str]
    blockers: list[str]


class AssessmentListResponse(BaseModel):
    items: list[AssessmentSessionResponse]
