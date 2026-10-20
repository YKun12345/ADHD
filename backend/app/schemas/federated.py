from datetime import datetime
from typing import Literal
from copy import deepcopy
from pydantic import BaseModel,Field,ConfigDict,PrivateAttr,model_validator
from backend.app.schemas.consent import ConsentCreate


class StrictRequest(BaseModel):
    model_config=ConfigDict(extra='forbid')
    _request_snapshot:dict=PrivateAttr(default_factory=dict)

    @model_validator(mode='wrap')
    @classmethod
    def preserve_original(cls,value,handler):
        result=handler(value)
        # ACKs retain the actual JSON (including Z versus +00:00 and omitted
        # optional fields), rather than a reconstructed Pydantic serialization.
        result._request_snapshot=deepcopy(value) if isinstance(value,dict) else result.model_dump(mode='json',exclude_unset=True)
        return result


class ProjectCreate(StrictRequest):
    client_request_id:str=Field(min_length=1,max_length=64)
    institution_id:str=Field(min_length=1,max_length=64)
    name:str=Field(min_length=1,max_length=255)
    purpose:str=Field(min_length=4,max_length=2000)
    mode:Literal['synthetic']='synthetic'
    data_contract:str=Field(min_length=1,max_length=255)
    expires_at:datetime


class ControlAction(StrictRequest):
    client_request_id:str=Field(min_length=1,max_length=64)
    expected_revision:int=Field(ge=1)
    confirmed:Literal[True]
    reason:str=Field(min_length=1,max_length=2000)


class MemberAction(ControlAction):
    user_id:int=Field(gt=0)
    permissions:list[Literal['view','experiment','manage']]=Field(min_length=1,max_length=3)
    expires_at:datetime


class NodeEnrollment(StrictRequest):
    client_request_id:str=Field(min_length=1,max_length=64)
    node_id:str|None=Field(default=None,min_length=1,max_length=64,pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
    institution_id:str=Field(min_length=1,max_length=64)
    name:str=Field(min_length=1,max_length=255)
    public_key_pem:str=Field(min_length=32,max_length=1000)
    compatibility:str=Field(min_length=1,max_length=255)


class ProjectNodeAction(ControlAction):
    node_id:str=Field(min_length=1,max_length=64)


class ConsentWithdraw(StrictRequest):
    client_request_id:str=Field(min_length=1,max_length=64)
    patient_id:int=Field(gt=0)
    consent_id:int=Field(gt=0)
    expected_revision:int=Field(ge=1)


class ResearchConsentCreate(ConsentCreate,StrictRequest):
    model_config=ConfigDict(extra='forbid')
    client_request_id:str=Field(min_length=1,max_length=64)
    purpose:Literal['research']='research'
    project_id:int=Field(gt=0)
    expected_project_revision:int=Field(gt=0,strict=True)
    target_user_id:None=None
