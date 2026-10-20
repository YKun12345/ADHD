"""Actual sender and authority come from the authenticated account, never JSON."""
from pydantic import BaseModel, ConfigDict, Field, field_validator


class SharedMessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patient_id: int = Field(gt=0,strict=True)
    relationship_id: int = Field(gt=0,strict=True)
    client_message_id: str = Field(min_length=1,max_length=64,pattern=r"^[A-Za-z0-9_.:-]+$")
    content: str = Field(min_length=1,max_length=2000)
    send_context: str = Field(min_length=50,max_length=32768)
    reply_to_message_id: int | None = Field(default=None,gt=0,strict=True)
    confirmed: bool = Field(default=False,strict=True)
    source_ai_decision_id: int | None = Field(default=None,gt=0,strict=True)

    @field_validator("content")
    @classmethod
    def actual_content(cls,value):
        if not value.strip():
            raise ValueError("A shared message requires actual content.")
        return value
