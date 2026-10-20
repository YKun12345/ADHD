from pydantic import BaseModel,ConfigDict,Field


class ImagingReportPublish(BaseModel):
    model_config=ConfigDict(extra='forbid')
    client_publication_id:str=Field(min_length=1,max_length=64,pattern=r'^[A-Za-z0-9_.:-]+$')
    patient_id:int=Field(gt=0,strict=True)
    prediction_id:int=Field(gt=0,strict=True)
    expected_previous_version:int=Field(ge=1,strict=True)
    input_digest:str=Field(pattern=r'^[a-f0-9]{64}$')
    publication_context:str=Field(min_length=20,max_length=65536)
    body:str=Field(min_length=1,max_length=8000)
    limitations:str=Field(min_length=1,max_length=4000)
    confirmed:bool=Field(strict=True)
