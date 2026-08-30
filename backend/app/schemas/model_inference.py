from datetime import datetime

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


class TimeseriesPredictionResponse(ModelPredictionReportResponse):
    patient_id: int
