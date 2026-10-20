"""Child guardian authority and subsequent explicit handovers use actual new scope."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from backend.tests.test_assessment_sessions import actor, created
from backend.tests.test_assessment_consumers import drain
from backend.tests.test_responsibility_transfers import proposed, accepted_transfer
from backend.tests.test_submission_cognitive_evidence import cognitive_submission
from backend.tests.test_transfer_transactions import decision_body
from backend.tests.w02_helpers import register, qualify, invite


def new_relation(client, owner_data, owner, pid, suffix):
    doctor, headers = register(client, suffix + '@example.com', 'researcher')
    qualify(doctor['user']['id'])
    pending = invite(client, headers, owner_data, pid)
    response = client.post(f"/api/v1/care/relationships/{pending['id']}/accept", headers=owner,
        json={'expected_revision': pending['revision']})
    assert response.status_code == 200, response.text
    return headers, response.json()


def test_actual_verified_child_guardian_authorizes_selected_attention_and_expiry_pauses_new_responsibility(client):
    data, owner, pid = actor(client, child=True, suffix='transfer-child-guardian')
    previous, prior_relation = new_relation(client, data, owner, pid, 'transfer-child-original')
    draft = created(client, previous, pid, child=True, doctor=True)
    response = client.post(f"/api/v1/care/assessments/{draft['id']}/publish", headers=previous, json={'expected_version': draft['version']})
    assert response.status_code == 200, response.text
    session = response.json()
    _, _, item, attempt, body = cognitive_submission(client, 'flanker', context=(owner, session, pid))
    body['task_id'] = item['patient_task_id']; body['content']['execution_metadata']['interrupted_count'] = 1
    assert client.post('/api/v1/care/submissions', headers=owner, json=body).status_code == 201
    assert drain() == 2
    incoming, relation = new_relation(client, data, owner, pid, 'transfer-child-receiver')
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    from backend.app.models.identity import GuardianRelationship
    from backend.app.models.care_transfer import CareTransferWorkItem
    with SessionLocal() as db:
        attention = db.scalar(select(AttentionItem).where(AttentionItem.assessment_id == session['id']))
        source = {'source_type': 'attention', 'source_id': attention.id, 'expected_version': attention.version}
    request, _ = proposed(client, owner, session, relation, source)
    assert request['author_user_id'] == data['user']['id']
    assert 'guardian' in request['author_identity_basis']
    saved = client.post('/api/v1/care/responsibility-transfer-decisions', headers=incoming, json=decision_body(client, incoming, request))
    assert saved.status_code == 201, saved.text
    identifier = saved.json()['work_item_ids'][0]
    assert attempt['actor_user_id'] == data['user']['id'] and attempt['performer_patient_id'] == pid
    with SessionLocal() as db:
        guardian = db.scalar(select(GuardianRelationship).where(GuardianRelationship.patient_id == pid))
        guardian.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1); db.commit()
    from backend.app.services.care_transfer_maintenance import maintain_once
    assert maintain_once(SessionLocal) == 1
    with SessionLocal() as db:
        assert db.get(CareTransferWorkItem, identifier).status == 'suspended'
    assert client.get(f'/api/v1/care/transferred-work/{identifier}', headers=owner).status_code == 403
    assert client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming).status_code == 403


def test_a_withdrawn_successor_can_be_explicitly_handed_to_a_third_actual_accepting_doctor(client):
    owner, _, incoming, session, relation, source, identifier, _, _ = accepted_transfer(client)
    assert client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=owner,
        json={'expected_revision': relation['revision']}).status_code == 200
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_transfer import CareTransferWorkItem
    from backend.app.services.care_transfer_maintenance import maintain_once
    assert maintain_once(SessionLocal) == 1
    with SessionLocal() as db:
        row = db.get(CareTransferWorkItem, identifier)
        next_source = {'source_type': 'transferred_work', 'source_id': row.id, 'expected_version': row.version}
    own_data = {'user': client.get('/api/v1/auth/me', headers=owner).json()}
    final_doctor, final_relation = new_relation(client, own_data, owner, session['patient_id'], 'transfer-third-actual-doctor')
    next_request, _ = proposed(client, owner, session, final_relation, next_source, client_id='explicit-second-handover')
    saved = client.post('/api/v1/care/responsibility-transfer-decisions', headers=final_doctor,
        json=decision_body(client, final_doctor, next_request, identifier='third-doctor-actual-acceptance'))
    assert saved.status_code == 201, saved.text
    current = client.get('/api/v1/care/transferred-work', headers=final_doctor)
    assert current.status_code == 200 and len(current.json()['items']) == 1, current.text
    final = current.json()['items'][0]
    assert final['source_type'] == 'transferred_work' and final['source_id'] == identifier
    assert final['original_attention_id'] == source['source_id'] and final['from_doctor_user_id'] == relation['doctor_user_id']
    assert final['status'] == 'open' and final['responsible_doctor_id'] == final_relation['doctor_user_id']
    assert client.get(f"/api/v1/care/transferred-work/{final['id']}", headers=incoming).status_code == 403
