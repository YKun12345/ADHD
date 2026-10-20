from datetime import datetime, timedelta, timezone
from backend.tests.w02_helpers import register, qualify


def test_project_members_nodes_and_own_consent_share_current_authority(client):
    dac, dh = register(client, 'fed-dac@example.com', 'researcher')
    qualify(dac['user']['id'], reviewer=True)
    doctor, doctorh = register(client, 'fed-doctor@example.com', 'researcher')
    qualify(doctor['user']['id'])
    outsider, oh = register(client, 'fed-outsider@example.com', 'researcher')
    patient, ph = register(client, 'fed-patient@example.com')
    patient2, ph2 = register(client, 'fed-patient-other@example.com')
    pid = patient['user']['patient_profile']['id']
    base = '/api/v1/federated'
    body = {'client_request_id':'project-1', 'institution_id':'synthetic-institution',
            'name':'合成研究', 'purpose':'合成流程验证，不处理真实患者资料', 'mode':'synthetic',
            'data_contract':'synthetic-roi-v1', 'expires_at':(datetime.now(timezone.utc)+timedelta(days=2)).isoformat()}
    assert client.post(base+'/projects', headers=doctorh, json=body).status_code == 403
    created = client.post(base+'/projects', headers=dh, json=body)
    assert created.status_code == 201, created.text
    project = created.json(); project_id = project['id']
    assert client.get(base+'/submissions/project-1',headers=dh).json()['original_request']==body
    assert client.post(base+'/projects',headers=dh,json=body).json()['id'] == project_id
    def action(route, request_id, revision, **extra):
        return client.post(base+route,headers=dh,json={'client_request_id':request_id,'expected_revision':revision,
            'confirmed':True,'reason':'合成权限检查',**extra})
    approved = action(f'/projects/{project_id}/approve','approve-1',project['revision'])
    assert approved.status_code == 200, approved.text
    project = approved.json()['result']
    other_dac, other_dach = register(client,'fed-other-dac@example.com','researcher')
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import InstitutionMembership
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        other_membership=InstitutionMembership(user_id=other_dac['user']['id'],institution_id='other-synthetic-institution',
            role='reviewer',status='verified',verification_reference='synthetic-independent-DAC')
        db.add(other_membership);db.flush();ledger.reserve(other_membership);db.commit();ledger.publish(other_membership)
    assert client.get(base+f'/projects/{project_id}',headers=other_dach).status_code==403
    assert client.post(base+f'/projects/{project_id}/approve',headers=other_dach,json={
        'client_request_id':'foreign-approve','expected_revision':project['revision'],'confirmed':True,'reason':'越界反例'}).status_code==403
    assert client.get(base+'/submissions/project-1',headers=other_dach).status_code==403
    member = action(f'/projects/{project_id}/members','member-1',project['revision'],user_id=doctor['user']['id'],
                    permissions=['view','experiment'],expires_at=body['expires_at'])
    assert member.status_code == 200, member.text
    assert client.get(base+f'/projects/{project_id}',headers=doctorh).status_code == 200
    assert client.get(base+f'/projects/{project_id}',headers=oh).status_code == 403
    assert client.get(base+f'/projects/{project_id}/consent',headers=doctorh,params={'patient_id':pid}).status_code == 403
    context = client.get(base+f'/projects/{project_id}/consent',headers=ph,params={'patient_id':pid})
    assert context.status_code == 200, context.text
    granted = client.post(base+f'/projects/{project_id}/consent',headers=ph,json={
        'client_request_id':'patient-grant-1','patient_id':pid,'purpose':'research','scope':['assessment'],'project_id':project_id,'expected_project_revision':project['revision'],'terms_version':'W02-1'})
    assert granted.status_code == 201, granted.text
    assert client.post(base+f'/projects/{project_id}/consent',headers=ph,json=granted.json()['original_request']).json()==granted.json()
    consent = granted.json()['result']
    assert client.get(base+f'/projects/{project_id}/consent',headers=ph,params={'patient_id':pid}).json()['items'][-1]['effective_access'] is True
    assert client.get(base+f'/projects/{project_id}/consent',headers=ph2,params={'patient_id':pid}).status_code == 403
    from backend.app.db.session import SessionLocal
    from backend.app.services.identity_access import require_research_access
    with SessionLocal() as db:
        assert require_research_access(db,doctor['user']['id'],pid,project_id,'assessment')
    withdrawn = client.post(base+f'/projects/{project_id}/consent/withdraw',headers=ph,json={
        'client_request_id':'patient-withdraw-1','patient_id':pid,'consent_id':consent['id'],'expected_revision':consent['revision']})
    assert withdrawn.status_code == 200, withdrawn.text
    assert withdrawn.json()['result']['status']=='withdrawn'
    import pytest
    from fastapi import HTTPException
    with SessionLocal() as db, pytest.raises(HTTPException):
        require_research_access(db,doctor['user']['id'],pid,project_id,'assessment')
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    pem=Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.PEM,PublicFormat.SubjectPublicKeyInfo).decode()
    node = client.post(base+'/nodes/enrollment',headers=dh,json={'client_request_id':'node-1',
        'institution_id':'synthetic-institution','name':'合成独立节点','public_key_pem':pem,'compatibility':'flower-1.23/secaggplus-v1'})
    assert node.status_code == 201, node.text
    node = node.json()
    ok=action(f"/nodes/{node['id']}/approve",'node-approve-1',node['revision'])
    assert ok.status_code == 200, ok.text
    project=client.get(base+f'/projects/{project_id}',headers=dh).json()
    linked=action(f'/projects/{project_id}/nodes','node-link-1',project['revision'],node_id=node['id'])
    assert linked.status_code == 200, linked.text
    assert linked.json()['result']['weight'] == 1
    revoked=action(f"/nodes/{node['id']}/revoke",'node-revoke-1',ok.json()['result']['revision'])
    assert revoked.status_code == 200, revoked.text
    state=client.get(base+f'/projects/{project_id}',headers=doctorh).json()
    assert state['nodes'][0]['effective_status'] == 'revoked'
    audit=client.get(base+f'/projects/{project_id}/audit',headers=dh)
    assert audit.status_code == 200, audit.text
    assert audit.json()['integrity'] == 'verified'
    original=client.get(base+'/submissions/node-revoke-1',headers=dh)
    assert original.status_code == 200 and original.json()['result'] == revoked.json()['result']
    project=client.get(base+f'/projects/{project_id}',headers=dh).json()
    revoked_project=action(f'/projects/{project_id}/revoke','project-revoke-1',project['revision'])
    assert revoked_project.status_code==200,revoked_project.text
    assert client.get(base+f'/projects/{project_id}',headers=doctorh).status_code==403
    assert client.get(base+'/submissions/patient-grant-1',headers=ph).json()==granted.json()
    assert client.post(base+f'/projects/{project_id}/consent',headers=ph,json={
        **granted.json()['original_request'],'client_request_id':'after-project-revoke'}).status_code==403
    # Missing extension cannot silently turn this project into a legacy W02 project.
    from sqlalchemy import text
    with SessionLocal() as db:
        db.execute(text('DELETE FROM federated_projects WHERE id=:id'),{'id':project_id});db.commit()
    assert client.post('/api/v1/patient/consents',headers=ph,json={
        'patient_id':pid,'project_id':project_id,'purpose':'research','scope':['assessment'],'terms_version':'W02-1'}).status_code==503


def test_institution_object_envelope_cannot_be_moved_or_downgraded(client):
    import pytest
    from backend.app.core.federated_envelope import FederatedBinding,seal,open_sealed
    from backend.app.core.record_envelope import RecordIntegrityError
    binding=FederatedBinding('institution-a','federated_projects','42')
    ciphertext=seal({'synthetic':'private-config'},binding)
    assert open_sealed(ciphertext,binding)=={'synthetic':'private-config'}
    for mismatch in (FederatedBinding('institution-b','federated_projects','42'),
        FederatedBinding('institution-a','federated_projects','43'),
        FederatedBinding('institution-a','federated_projects','42',field='other'),
        FederatedBinding('institution-a','federated_projects','42',data_version=2)):
        with pytest.raises(RecordIntegrityError):open_sealed(ciphertext,mismatch)
    with pytest.raises(RecordIntegrityError):open_sealed('{"legacy":"plain"}',binding)
    from backend.app.db.federated_migration import schema_plan
    from backend.app.db.session import engine
    assert schema_plan(engine)['statements']==[]
    assert schema_plan(engine)['statements']==[]
