"""Only the server-signed observation that was actually displayed can be acknowledged."""
from pydantic import BaseModel, ConfigDict, Field


class AgentCompanionObservation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    patient_id: int = Field(gt=0, strict=True)
    observation_context: str = Field(min_length=20, max_length=131072, strict=True)
