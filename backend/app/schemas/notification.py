from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class NotificationRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')


class WechatBindRequest(NotificationRequest):
    code: str = Field(min_length=1, max_length=256)


class NotificationPermissionResult(NotificationRequest):
    result: Literal['accept', 'reject', 'ban', 'filter', 'failed']


class NotificationRevokeRequest(NotificationRequest):
    expected_binding_revision: int = Field(ge=1)
