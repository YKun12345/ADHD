from typing import Literal
from pydantic import Field
from backend.app.schemas.federated import StrictRequest


class ExperimentCreate(StrictRequest):
    client_request_id:str=Field(min_length=1,max_length=64)
    base_model_version_id:int=Field(gt=0,strict=True)
    node_ids:list[str]=Field(min_length=3,max_length=3)
    rounds:int=Field(default=1,ge=1,le=5,strict=True)
    mode:Literal['dp_secagg','synthetic_plaintext']='dp_secagg'
    consent_record_ids:list[int]=Field(default_factory=list,max_length=64)


PRESET={'capacity':64,'sample_rate':0.125,'logical_steps':2,'noise_multiplier':2.0,
        'max_grad_norm':1.0,'delta':1e-5,'max_epsilon':10.0,'max_rounds':5,
        'optimizer':'SGD_no_momentum','adjacency':'fixed_public_slot_real_vs_zero_placeholder',
        'expected_batch_size':8,'accountant':'rdp','composition':'conservative_sequential_all_institutions',
        'secure_rng':False,'mode':'synthetic_research_only','encoder_dp_protected':False}
