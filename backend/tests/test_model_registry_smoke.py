import hashlib,hmac,json
from datetime import datetime,timezone,timedelta
from backend.tests.w02_helpers import register,qualify


def test_registered_candidate_needs_separate_reviews_and_every_signed_instance_before_pointer_activation(client,monkeypatch,tmp_path):
    from backend.app.core.config import settings
    from backend.app.services.cognitive_contract import canonical_digest
    from backend.app.services.model_admission_service import inspect_hgst_admission
    root=tmp_path/'synthetic-models';root.mkdir();artifact=root/'synthetic.pt';artifact.write_bytes(b'synthetic-never-deserialized-model')
    monkeypatch.setattr(settings,'MODEL_REGISTRY_ARTIFACT_ROOT',str(root))
    monkeypatch.setattr(settings,'MODEL_REGISTRY_REQUIRED_INSTANCES','synthetic-instance')
    secret='synthetic-instance-proof-key-at-least-32-bytes'
    monkeypatch.setattr(settings,'MODEL_REGISTRY_INSTANCE_KEYS_JSON',json.dumps({'synthetic-instance':secret}))
    user,headers=register(client,'registry-reviewer@example.com','researcher');qualify(user['user']['id'],reviewer=True)
    candidate=client.post('/api/v1/model/registry/candidates',headers=headers,json={'version':'synthetic-1','artifact_file':artifact.name,
        'artifact_sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(),'input_contract_digest':'a'*64,'purpose':'screening_support',
        'code_source':'synthetic-code-reference','weight_source':'synthetic-weight-reference','training_data_source':'synthetic-only'})
    assert candidate.status_code==201,candidate.text
    v=candidate.json();base={'version_id':v['id'],'expected_registry_revision':1,'reason':'合成测试中逐项核对。','confirmed':True}
    denied=client.post('/api/v1/model/registry/actions',headers=headers,json={**base,'client_action_id':'premature','action':'activate'})
    assert denied.status_code==409,denied.text
    review={key:{'status':'verified','reference':'synthetic-reference-'+key} for key in ['code_license','weight_license','training_data_permission','intended_use','input_contract']}
    checked=client.post('/api/v1/model/registry/actions',headers=headers,json={**base,'client_action_id':'review','action':'review','evidence':review})
    assert checked.status_code==201,checked.text
    base['expected_registry_revision']=checked.json()['registry_revision']
    denied=client.post('/api/v1/model/registry/actions',headers=headers,json={**base,'client_action_id':'still-not-loaded','action':'activate'})
    assert denied.status_code==409,denied.text
    proof={'instance_id':'synthetic-instance','version_id':v['id'],'artifact_sha256':v['artifact_sha256'],'input_contract_digest':'a'*64,
        'loaded_at':datetime.now(timezone.utc).isoformat(),'loaded':True,'numeric_equivalence_verified':True}
    proof['signature']=hmac.new(secret.encode(),canonical_digest(proof).encode(),hashlib.sha256).hexdigest()
    saved=client.post('/api/v1/model/registry/actions',headers=headers,json={**base,'client_action_id':'synthetic-signed-proof','action':'load_proof','evidence':proof})
    assert saved.status_code==201,saved.text
    base['expected_registry_revision']=saved.json()['registry_revision']
    activated=client.post('/api/v1/model/registry/actions',headers=headers,json={**base,'client_action_id':'synthetic-only-activation','action':'activate'})
    assert activated.status_code==201,activated.text
    monkeypatch.setattr(settings,'MODEL_REGISTRY_ENABLED',True)
    assert inspect_hgst_admission()['model_version_id']==v['id']
    # Loading is a cutover precondition, not a fifteen-minute model lease.
    # Source/credential/file revocation checks must still execute on each read.
    from backend.app.services import model_registry_service as registry
    later=datetime.now(timezone.utc)+timedelta(minutes=16)
    class LaterClock:
        fromisoformat=staticmethod(datetime.fromisoformat)
        @staticmethod
        def now(tz=None):return later if tz else later.replace(tzinfo=None)
    monkeypatch.setattr(registry,'datetime',LaterClock)
    assert inspect_hgst_admission()['real_inference_allowed'] is True
    still_old=client.post('/api/v1/model/registry/actions',headers=headers,json={**base,'expected_registry_revision':activated.json()['registry_revision'],'client_action_id':'old-readiness-cannot-cut-over-again','action':'rollback'})
    assert still_old.status_code==409,still_old.text
    artifact.write_bytes(b'changed-synthetic-bytes')
    assert inspect_hgst_admission()['real_inference_allowed'] is False
