from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator
from backend.app.services.cognitive_contract import reject_legacy_assessment_claims

from backend.app.schemas.cognitive import CognitiveProfileResponse
from backend.app.schemas.imaging import ImagingVisualizationResponse
from backend.app.schemas.model_inference import ModelPredictionReportResponse
from backend.app.schemas.tracking import TrackingSummaryResponse


class ScaleSubmitRequest(BaseModel):
    patient_id: int | None = Field(default=None,gt=0,strict=True)
    scale_type: Literal["ASRS", "SNAP_IV"]
    answers: list[int] = Field(min_length=1)
    respondent_type: Literal["self", "parent", "guardian", "teacher"] = "self"

    @model_validator(mode="before")
    @classmethod
    def no_new_context(cls,value):
        reject_legacy_assessment_claims(value)
        return value


class ScaleResultResponse(BaseModel):
    id: int
    scale_type: Literal["ASRS", "SNAP_IV"]
    respondent_type: str
    total_score: float
    risk_level: str
    radar_scores: dict[str, float]
    sub_scores: dict[str, float]
    summary: str
    recommendations: list[str]
    created_at: datetime
    assessment_id: int | None = None
    assessment_item_id: int | None = None
    task_attempt_id: int | None = None
    legacy: bool = True
    storage_integrity: dict | None = None


class PatientReportResponse(BaseModel):
    imaging_history_status: Literal['ready','no_records','storage_upgrade_required','conversion_required','not_authorized'] = 'no_records'
    patient_name: str
    patient_type: str | None
    latest_scale: ScaleResultResponse | None
    cognitive_profile: CognitiveProfileResponse | None = None
    tracking_summary: TrackingSummaryResponse | None = None
    latest_imaging_visualization: ImagingVisualizationResponse | None = None
    latest_model_prediction: ModelPredictionReportResponse | None = None
