from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from backend.app.schemas.cognitive import CognitiveProfileResponse
from backend.app.schemas.imaging import ImagingVisualizationResponse
from backend.app.schemas.model_inference import ModelPredictionReportResponse
from backend.app.schemas.tracking import TrackingSummaryResponse


class ScaleSubmitRequest(BaseModel):
    scale_type: Literal["ASRS", "SNAP_IV"]
    answers: list[int] = Field(min_length=1)
    respondent_type: Literal["self", "parent", "guardian", "teacher"] = "self"


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


class PatientReportResponse(BaseModel):
    patient_name: str
    patient_type: str | None
    latest_scale: ScaleResultResponse | None
    cognitive_profile: CognitiveProfileResponse | None = None
    tracking_summary: TrackingSummaryResponse | None = None
    latest_imaging_visualization: ImagingVisualizationResponse | None = None
    latest_model_prediction: ModelPredictionReportResponse | None = None
