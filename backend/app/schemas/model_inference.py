from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class ModelPredictionReportResponse(BaseModel):
    prediction_id: int
    upload_id: int | None = None
    file_name: str
    prediction_label: str
    probability: float
    probability_control: float | None = None
    source_type: str
    roi_dim_used: int | None = None
    timepoints: int | None = None
    model_name: str | None = None
    model_version: str | None = None
    summary_text: str | None = None
    is_demo: bool
    disclaimer: str
    created_at: datetime
    source_admission_status: Literal['not_recorded', 'demonstration_only', 'active', 'legacy_accepted'] = 'not_recorded'
    professional_review_status: Literal['not_recorded'] = 'not_recorded'
    version_status: Literal['legacy_unversioned'] = 'legacy_unversioned'
    storage_integrity: dict | None = None
    storage_context: dict | None = None


class TimeseriesPredictionResponse(ModelPredictionReportResponse):
    patient_id: int
