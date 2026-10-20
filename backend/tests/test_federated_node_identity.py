from datetime import datetime,timezone
import base64
from backend.tests.w02_helpers import register,qualify


def test_node_channel_uses_original_public_key_and_one_time_challenge_without_user_jwt(client):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat
    from backend.app.services.cognitive_contract import canonical_digest
    private=Ed25519PrivateKey.generate();pem=private.public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo).decode()
    dac,headers=register(client,'node-channel-dac@example.com','researcher');qualify(dac['user']['id'],reviewer=True)
    enrolled=client.post('/api/v1/federated/nodes/enrollment',headers=headers,json={'client_request_id':'signed-node-enroll',
        'institution_id':'synthetic-institution','name':'独立签名节点','public_key_pem':pem,'compatibility':'flower-1.23/secaggplus-v1'})
    assert enrolled.status_code==201,enrolled.text
    node=enrolled.json();channel='/api/v1/federated/node-channel'
    assert client.get(channel+'/'+node['id']+'/challenge').status_code==403
    approved=client.post('/api/v1/federated/nodes/'+node['id']+'/approve',headers=headers,json={
        'client_request_id':'signed-node-approve','expected_revision':node['revision'],'confirmed':True,'reason':'明确批准合成本机节点'})
    assert approved.status_code==200,approved.text
    challenge=client.get(channel+'/'+node['id']+'/challenge')
    assert challenge.status_code==200,challenge.text
    challenge=challenge.json()
    body={'client_request_id':'node-heartbeat-1','node_id':node['id'],'challenge':challenge['challenge'],
        'sequence':challenge['next_sequence'],'observed_at':datetime.now(timezone.utc).isoformat(),'compatibility':'flower-1.23/secaggplus-v1'}
    invalid=client.post(channel+'/heartbeat',json={**body,'signature':base64.b64encode(b'wrong'*13).decode()})
    assert invalid.status_code==403,invalid.text
    body['signature']=base64.b64encode(private.sign(canonical_digest(body).encode())).decode()
    saved=client.post(channel+'/heartbeat',json=body)
    assert saved.status_code==200,saved.text
    assert saved.json()['result']['identity_verified'] is True
    assert saved.json()['actor_user_id'] is None
    assert client.post(channel+'/heartbeat',json=body).json()==saved.json()
    replay={**body,'client_request_id':'different-client-same-challenge'};replay.pop('signature')
    replay['signature']=base64.b64encode(private.sign(canonical_digest(replay).encode())).decode()
    assert client.post(channel+'/heartbeat',json=replay).status_code==409
    revoked=client.post('/api/v1/federated/nodes/'+node['id']+'/revoke',headers=headers,json={
        'client_request_id':'signed-node-revoke','expected_revision':approved.json()['result']['revision'],'confirmed':True,'reason':'停止这个节点的新请求'})
    assert revoked.status_code==200,revoked.text
    assert client.get(channel+'/'+node['id']+'/challenge').status_code==403
    assert client.post(channel+'/heartbeat',json=body).json()==saved.json()
