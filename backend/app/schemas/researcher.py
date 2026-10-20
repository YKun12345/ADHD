from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

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
    patient_name: str | None
    patient_email: EmailStr | None
    patient_type: str | None
    allowed_scope: list[str] = Field(default_factory=list)
    latest_scale_type: str | None = None
    latest_scale_risk_level: str | None = None
    latest_scale_total_score: float | None = None
    weekly_report_count: int | None = None
    completed_tracking_days: int | None = 0
    current_tracking_day: int | None = 1
    completion_status: str | None = "not_started"
    cognitive_test_count: int | None = 0
    has_imaging: bool | None = False
    next_step_text: str | None = None
    created_at: datetime | None


class ResearcherPatientListResponse(BaseModel):
    total: int
    items: list[ResearcherPatientItem]


class ResearcherPatientReportResponse(BaseModel):
    imaging_history_status: Literal['ready','no_records','storage_upgrade_required','conversion_required','not_authorized'] = 'not_authorized'
    patient_id: int
    patient_name: str | None
    patient_email: EmailStr | None
    patient_type: str | None
    allowed_scope: list[str] = Field(default_factory=list)
    latest_scale: ScaleResultResponse | None = None
    cognitive_profile: CognitiveProfileResponse | None = None
    tracking_summary: TrackingSummaryResponse | None = None
    tracking_logs: list[TrackingLogResponse] | None = []
    care_summary: list[str] = []
    suggested_actions: list[str] = []
    latest_imaging_visualization: ImagingVisualizationResponse | None = None
    latest_model_prediction: ModelPredictionReportResponse | None = None


class ResearcherDashboardStats(BaseModel):
    patient_count: int
    pending_imaging_count: int | None
    weekly_report_count: int | None
    scope_patient_counts: dict[str,int] = Field(default_factory=dict)
