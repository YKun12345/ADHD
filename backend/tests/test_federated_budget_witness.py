import hashlib
from uuid import uuid4
import pytest
from backend.tests.w02_helpers import register,qualify


def test_central_witness_keeps_unknown_cost_across_projects_and_rejects_local_reset(client):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.services import federated_budget_service as budget
    from backend.app.services import federated_experiment_service as experiments
    from backend.app.core.record_envelope import RecordIntegrityError
    from federated_runtime.hgst_features import canonical_json
    private=Ed25519PrivateKey.generate();public=private.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw)
    actor,headers=register(client,'central-budget-dac@example.com','researcher');qualify(actor['user']['id'],reviewer=True)
    enrolled=client.post('/api/v1/federated/nodes/enrollment',headers=headers,json={'client_request_id':'budget-node-enrollment',
        'node_id':'budget-node','institution_id':'synthetic-institution','name':'合成预算节点',
        'public_key_pem':private.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo).decode(),'compatibility':'flower-1.23/secaggplus-v1'})
    assert enrolled.status_code==201,enrolled.text
    approved=client.post('/api/v1/federated/nodes/budget-node/approve',headers=headers,json={
        'client_request_id':'budget-node-approved','expected_revision':enrolled.json()['revision'],'confirmed':True,'reason':'只核对合成签名预算见证'})
    assert approved.status_code==200,approved.text
    node={'node_id':'budget-node','institution_id':'synthetic-institution','protection_namespace':'stable-synthetic-scope'}
    attempt=str(uuid4());epoch=str(uuid4())
    event={'schema':'federated-privacy-event/v1','namespace':node['protection_namespace'],'node_id':node['node_id'],
        'public_key_sha256':hashlib.sha256(public).hexdigest(),'ledger_epoch':epoch,'sequence':1,'previous_sha256':'0'*64,
        'event':'reserved','token':str(uuid4()),'experiment_id':'first-project-experiment','round':1,'attempt':attempt,'history':[[2.0,.125,2]]}
    signed={'payload':event,'signature_hex':private.sign(canonical_json(event)).hex()}
    snapshot={'namespace':node['protection_namespace'],'ledger_epoch':epoch,'ledger_sequence':1,
        'ledger_head_sha256':hashlib.sha256(canonical_json(signed)).hexdigest(),'signed_events':[signed]}
    with SessionLocal() as db:
        user=db.get(User,actor['user']['id'])
        budget.reserve(db,user,'first-project-experiment',1,attempt,node)
        assert budget.observe(db,node,snapshot) is True
        assert budget.observe(db,node,snapshot) is False
        assert sum(h[2] for h in experiments._histories(db))==2
        # New project/attempt cannot reset or refund the first uncertain attempt.
        budget.reserve(db,user,'second-project-experiment',1,str(uuid4()),node)
        assert sum(h[2] for h in experiments._histories(db))==4
        with pytest.raises(RecordIntegrityError):
            budget.observe(db,node,{'namespace':node['protection_namespace'],'ledger_epoch':str(uuid4()),
                'ledger_sequence':0,'ledger_head_sha256':'0'*64,'signed_events':[]})
        assert sum(h[2] for h in experiments._histories(db))==4
