from typing import Literal
from pydantic import BaseModel,ConfigDict,Field


class CandidateCreate(BaseModel):
    model_config=ConfigDict(extra='forbid')
    family:str=Field(default='hgst',min_length=1,max_length=64,pattern=r'^[A-Za-z0-9_.-]+$')
    version:str=Field(min_length=1,max_length=64,pattern=r'^[A-Za-z0-9_.-]+$')
    artifact_file:str=Field(min_length=1,max_length=255)
    artifact_sha256:str=Field(pattern=r'^[a-f0-9]{64}$')
    input_contract_digest:str=Field(pattern=r'^[a-f0-9]{64}$')
    purpose:Literal['research_only','screening_support']
    code_source:str=Field(min_length=1,max_length=2000)
    weight_source:str=Field(min_length=1,max_length=2000)
    training_data_source:str=Field(min_length=1,max_length=2000)
    training_metadata:dict=Field(default_factory=dict)


class RegistryAction(BaseModel):
    model_config=ConfigDict(extra='forbid')
    client_action_id:str=Field(min_length=1,max_length=64,pattern=r'^[A-Za-z0-9_.:-]+$')
    version_id:int=Field(gt=0,strict=True)
    action:Literal['review','load_proof','activate','rollback']
    expected_registry_revision:int=Field(ge=1,strict=True)
    reason:str=Field(min_length=1,max_length=2000)
    evidence:dict=Field(default_factory=dict)
    confirmed:bool=Field(strict=True)
