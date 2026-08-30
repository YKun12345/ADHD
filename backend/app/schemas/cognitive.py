from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, model_validator

from backend.app.services.cognitive_contract import (
    canonical_test_type,
    normalize_result_json,
)


class CognitiveTestSubmitRequest(BaseModel):
    test_type: str = Field(min_length=1, max_length=64)
    result_json: dict[str, Any]

    @model_validator(mode="after")
    def normalize_cognitive_payload(self) -> "CognitiveTestSubmitRequest":
        self.test_type = canonical_test_type(self.test_type)
        self.result_json = normalize_result_json(self.test_type, self.result_json)
        return self


class CognitiveTestResponse(BaseModel):
    id: int
    test_type: str
    result_json: dict[str, Any]
    created_at: datetime


class CognitiveTestReportItem(BaseModel):
    test_type: str
    test_name: str
    status_text: str
    key_metric: str
    finished_at: datetime | None = None


class CognitiveProfileResponse(BaseModel):
    radar_scores: dict[str, float]
    summary: str
    latest_tests: list[CognitiveTestReportItem]
