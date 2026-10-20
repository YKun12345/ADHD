from datetime import datetime
from pydantic import Field
from backend.app.schemas.federated import StrictRequest


class NodeHeartbeat(StrictRequest):
    client_request_id:str=Field(min_length=1,max_length=64)
    node_id:str=Field(min_length=1,max_length=64)
    challenge:str=Field(min_length=80,max_length=2000)
    sequence:int=Field(ge=1,strict=True)
    observed_at:datetime
    compatibility:str=Field(min_length=1,max_length=255)
    signature:str=Field(min_length=80,max_length=128)


class NodeOriginalQuery(StrictRequest):
    node_id:str=Field(min_length=1,max_length=64)
    target_client_request_id:str=Field(min_length=1,max_length=64)
    query_id:str=Field(min_length=1,max_length=64)
    requested_at:datetime
    signature:str=Field(min_length=80,max_length=128)
