from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr

from backend.app.schemas.cognitive import CognitiveProfileResponse
from backend.app.schemas.imaging import ImagingVisualizationResponse
from backend.app.schemas.model_inference import ModelPredictionReportResponse
from backend.app.schemas.scale import ScaleResultResponse
from backend.app.schemas.tracking import TrackingLogResponse, TrackingSummaryResponse


class BindPatientByEmailRequest(BaseModel):
    patient_email: EmailStr


class ResearcherPatientItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    patient_id: int
    patient_name: str
    patient_email: EmailStr
    patient_type: str
    latest_scale_type: str | None = None
    latest_scale_risk_level: str | None = None
    latest_scale_total_score: float | None = None
    completed_tracking_days: int = 0
    current_tracking_day: int = 1
    completion_status: str = "not_started"
    cognitive_test_count: int = 0
    has_imaging: bool = False
    next_step_text: str | None = None
    created_at: datetime


class ResearcherPatientListResponse(BaseModel):
    total: int
    items: list[ResearcherPatientItem]


class ResearcherPatientReportResponse(BaseModel):
    patient_id: int
    patient_name: str
    patient_email: EmailStr
    patient_type: str
    latest_scale: ScaleResultResponse | None = None
    cognitive_profile: CognitiveProfileResponse | None = None
    tracking_summary: TrackingSummaryResponse | None = None
    tracking_logs: list[TrackingLogResponse] = []
    care_summary: list[str] = []
    suggested_actions: list[str] = []
    latest_imaging_visualization: ImagingVisualizationResponse | None = None
    latest_model_prediction: ModelPredictionReportResponse | None = None


class ResearcherDashboardStats(BaseModel):
    patient_count: int
    pending_imaging_count: int
    weekly_report_count: int
