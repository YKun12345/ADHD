from datetime import datetime,timedelta,timezone
import hashlib
from backend.tests.w02_helpers import register,qualify


def test_real_experiment_draft_is_durable_and_cannot_start_without_admission(client,monkeypatch,tmp_path):
    from backend.app.core.config import settings
    actor,headers=register(client,'experiment-dac@example.com','researcher');qualify(actor['user']['id'],reviewer=True)
    base='/api/v1/federated'
    created=client.post(base+'/projects',headers=headers,json={'client_request_id':'experiment-project','institution_id':'synthetic-institution',
        'name':'持久实验控制','purpose':'只验证真实合成实验状态','mode':'synthetic','data_contract':'synthetic-roi-v1',
        'expires_at':(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()})
    assert created.status_code==201,created.text
    project=created.json()
    approved=client.post(base+f"/projects/{project['id']}/approve",headers=headers,json={'client_request_id':'experiment-project-approved',
        'expected_revision':project['revision'],'confirmed':True,'reason':'只开放合成草稿'})
    assert approved.status_code==200,approved.text
    root=tmp_path/'not-admitted-candidates';root.mkdir();artifact=root/'unverified.pt';artifact.write_bytes(b'not-a-valid-model-never-loaded')
    monkeypatch.setattr(settings,'MODEL_REGISTRY_ARTIFACT_ROOT',str(root))
    registered=client.post('/api/v1/model/registry/candidates',headers=headers,json={'version':'unverified-experiment-only','artifact_file':artifact.name,
        'artifact_sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(),'input_contract_digest':'a'*64,'purpose':'research_only',
        'code_source':'unverified','weight_source':'synthetic-invalid-no-load','training_data_source':'synthetic-only'})
    assert registered.status_code==201,registered.text
    request={'client_request_id':'experiment-draft-1','base_model_version_id':registered.json()['id'],
        'node_ids':['not-admitted-a','not-admitted-b','not-admitted-c'],'rounds':1,'mode':'dp_secagg'}
    draft=client.post(base+f"/projects/{project['id']}/experiments",headers=headers,json=request)
    assert draft.status_code==201,draft.text
    denied_plaintext=client.post(base+f"/projects/{project['id']}/experiments",headers=headers,json={
        **request,'client_request_id':'plaintext-cannot-borrow-patient-consent','mode':'synthetic_plaintext','consent_record_ids':[123]})
    assert denied_plaintext.status_code==422,denied_plaintext.text
    experiment=draft.json()['result'];eid=experiment['id']
    assert experiment['status']=='draft'
    assert client.post(base+f"/projects/{project['id']}/experiments",headers=headers,json=request).json()==draft.json()
    action={'client_request_id':'experiment-start-before-admission','expected_revision':experiment['revision'],'confirmed':True,'reason':'必要反例'}
    assert client.post(base+f'/experiments/{eid}/start',headers=headers,json=action).status_code==409
    failed_preflight=client.post(base+f'/experiments/{eid}/preflight',headers=headers,json={**action,'client_request_id':'experiment-invalid-preflight'})
    assert failed_preflight.status_code==409,failed_preflight.text
    cancelled=client.post(base+f'/experiments/{eid}/stop',headers=headers,json={**action,'client_request_id':'cancel-unstarted-draft'})
    assert cancelled.status_code==200,cancelled.text
    assert cancelled.json()['result']['status']=='cancelled'
    assert client.get(base+f'/experiments/{eid}/rounds',headers=headers).json()['items']==[]
    _,other_headers=register(client,'not-member-experiment@example.com','researcher')
    assert client.get(base+f'/experiments/{eid}',headers=other_headers).status_code==403
