from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, model_validator

from backend.app.services.cognitive_contract import (
    result_test_type,
    validate_protocol_metadata,
    normalize_result_json,
    validate_test_run_id,
)


class CognitiveTestSubmitRequest(BaseModel):
    test_type: str = Field(min_length=1, max_length=64)
    result_json: dict[str, Any]

    @model_validator(mode="after")
    def normalize_cognitive_payload(self) -> "CognitiveTestSubmitRequest":
        if "test_run_id" in self.result_json:
            validate_test_run_id(self.result_json["test_run_id"])
        validate_protocol_metadata(self.result_json)
        self.test_type = result_test_type(self.test_type, self.result_json)
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
    stored_test_type: str = ""
    source: str = "unknown"
    protocol_id: str = "legacy-unversioned"
    protocol_label: str = "历史未标注协议"
    protocol_schema_version: int = 0
    age_group: str = "unknown"
    protocol_inferred: bool = False
    protocol_key: str = ""
    series_id: str = ""


class CognitiveProtocolProfile(BaseModel):
    protocol_key: str
    source: str
    protocol_id: str
    protocol_label: str
    protocol_schema_version: int
    age_group: str
    radar_scores: dict[str, float]
    summary: str
    latest_tests: list[CognitiveTestReportItem]


class CognitiveProfileResponse(BaseModel):
    radar_scores: dict[str, float]
    summary: str
    latest_tests: list[CognitiveTestReportItem]
    active_protocol_key: str = ""
    protocol_profiles: list[CognitiveProtocolProfile] = Field(default_factory=list)
