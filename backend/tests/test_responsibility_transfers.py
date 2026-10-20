"""An accepted invitation is not a completed handover of concrete responsibility."""
from sqlalchemy import select, text

from backend.tests.test_assessment_consumers import drain
from backend.tests.test_submission_context import scale_submission
from backend.tests.test_submission_cognitive_evidence import cognitive_submission
from backend.tests.w02_helpers import register, qualify


def real_transfer_source(client, *, withdraw_original=False):
    owner, original_doctor, session, _, _, scale = scale_submission(client, doctor=True, suffix='transfer-source')
    _, _, item, _, body = cognitive_submission(client, 'flanker', context=(owner, session, scale['patient_id']))
    body['task_id'] = item['patient_task_id']
    body['content']['execution_metadata']['interrupted_count'] = 1
    saved = client.post('/api/v1/care/submissions', headers=owner, json=body)
    assert saved.status_code == 201, saved.text
    assert drain() == 2
    next_doctor, incoming = register(client, 'transfer-next-doctor@example.com', 'researcher')
    qualify(next_doctor['user']['id'])
    own = client.get('/api/v1/auth/me', headers=owner).json()
    invited = client.post('/api/v1/care/relationships/invitations', headers=incoming,
        json={'target_email': own['email'], 'purpose': 'clinical_sharing', 'scope': ['profile', 'assessment', 'care']})
    assert invited.status_code == 201, invited.text
    accepted = client.post(f"/api/v1/care/relationships/{invited.json()['id']}/accept", headers=owner,
        json={'expected_revision': invited.json()['revision']})
    assert accepted.status_code == 200, accepted.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.models.attention import AttentionItem
    if withdraw_original:
        with SessionLocal() as db:
            prior = db.scalar(select(CareRelationship).where(CareRelationship.patient_id == scale['patient_id'],
                CareRelationship.doctor_user_id == session['responsible_doctor_id']))
            identifier, revision = prior.id, prior.revision
        withdrawn = client.post(f'/api/v1/care/relationships/{identifier}/revoke', headers=owner, json={'expected_revision': revision})
        assert withdrawn.status_code == 200, withdrawn.text
        assert drain() >= 1
    with SessionLocal() as db:
        attention = db.scalar(select(AttentionItem).where(AttentionItem.assessment_id == session['id']))
        source = {'source_type': 'attention', 'source_id': attention.id, 'expected_version': attention.version}
    return owner, original_doctor, incoming, session, accepted.json(), source


def proposed(client, owner, session, relationship, source, client_id='original-transfer-request'):
    body = {'patient_id': session['patient_id'], 'receiving_relationship_id': relationship['id'], 'sources': [source], 'reason': '合成明确交接这一个关注事项。'}
    check = client.post('/api/v1/care/responsibility-transfers/preflight', headers=owner, json=body)
    assert check.status_code == 200, check.text
    payload = {**body, 'client_transfer_id': client_id, 'request_context': check.json()['request_context'], 'confirmed': True}
    result = client.post('/api/v1/care/responsibility-transfers', headers=owner, json=payload)
    assert result.status_code == 201, result.text
    return result.json(), payload


def accepted_transfer(client, before_accept=None):
    owner, previous, incoming, session, relation, source = real_transfer_source(client)
    request, payload = proposed(client, owner, session, relation, source)
    if before_accept:
        before_accept(incoming, relation)
    detail = client.get(f"/api/v1/care/responsibility-transfers/{request['id']}", headers=incoming)
    decision = {'patient_id': session['patient_id'], 'transfer_id': request['id'], 'client_decision_id': 'actual-acceptance',
        'expected_version': 1, 'decision': 'accept', 'reason': None, 'decision_context': detail.json()['decision_context'], 'confirmed': True}
    result = client.post('/api/v1/care/responsibility-transfer-decisions', headers=incoming, json=decision)
    assert result.status_code == 201, result.text
    return owner, previous, incoming, session, relation, source, result.json()['work_item_ids'][0], decision, result.json()


def test_successor_work_has_real_actual_actor_actions_and_original_ack_after_later_versions(client):
    owner, previous, incoming, session, relation, source, identifier, decision, decision_ack = accepted_transfer(client)
    path = f'/api/v1/care/transferred-work/{identifier}'
    detail = client.get(path, headers=incoming)
    assert detail.status_code == 200, detail.text
    assert detail.json()['allowed_actions'] == ['acknowledge', 'close_with_reason']
    assert detail.json()['original_evidence']['evidence']['server_result']['kind'] == 'cognitive'
    assert client.get(path, headers=previous).status_code == 403
    assert client.get(path, headers=owner).json()['allowed_actions'] == []
    body = {'patient_id': session['patient_id'], 'work_item_id': identifier, 'client_action_id': 'successor-ack-original',
        'expected_version': 1, 'action': 'acknowledge', 'reason': None, 'action_context': detail.json()['action_context'], 'confirmed': True}
    assert client.post('/api/v1/care/transferred-work-actions', headers=owner, json=body).status_code == 403
    saved = client.post('/api/v1/care/transferred-work-actions', headers=incoming, json=body)
    assert saved.status_code == 201 and saved.json()['status'] == 'acknowledged', saved.text
    assert client.post('/api/v1/care/transferred-work-actions', headers=incoming, json={**body, 'client_action_id': 'stale-next'}).status_code == 409
    second = client.get(path, headers=incoming).json()
    resolved = client.post('/api/v1/care/transferred-work-actions', headers=incoming, json={**body,
        'client_action_id': 'successor-actual-resolution', 'expected_version': 2, 'action': 'resolve',
        'reason': '合成接收医生实际核对后处理说明。', 'action_context': second['action_context']})
    assert resolved.status_code == 201 and resolved.json()['status'] == 'resolved', resolved.text
    assert client.post('/api/v1/care/transferred-work-actions', headers=incoming, json=body).json() == saved.json()
    history = client.get(path + '/history', headers=owner)
    assert history.status_code == 200 and [row['actor_user_id'] for row in history.json()['items']] == [decision_ack['actor_user_id']] * 2
    assert client.get('/api/v1/care/transferred-work-actions/successor-ack-original', headers=incoming).json() == saved.json()
    assert client.post('/api/v1/care/responsibility-transfer-decisions', headers=incoming, json=decision).json() == decision_ack


def test_new_receiving_authority_revocation_is_persisted_without_resuming_old_work(client):
    owner, previous, incoming, session, relation, source, identifier, _, _ = accepted_transfer(client)
    detail = client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming)
    assert detail.status_code == 200, detail.text
    revoked = client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=owner,
        json={'expected_revision': relation['revision']})
    assert revoked.status_code == 200, revoked.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_transfer import CareTransferWorkItem
    from backend.app.models.attention import AttentionItem
    from backend.app.services import care_transfer_maintenance as maintenance
    assert maintenance.maintain_once(SessionLocal, limit=50) == 1
    with SessionLocal() as db:
        row = db.get(CareTransferWorkItem, identifier)
        assert row.status == 'suspended' and row.responsible_doctor_id == relation['doctor_user_id']
        assert db.get(AttentionItem, source['source_id']).suspension_reason == 'responsibility_transferred'
    assert maintenance.maintain_once(SessionLocal, limit=50) == 0
    history = client.get(f'/api/v1/care/transferred-work/{identifier}', headers=owner)
    assert history.status_code == 200 and history.json()['work']['suspension_observation']['human_action'] is False
    assert client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming).status_code == 403


def test_only_explicit_owner_request_and_actual_recipient_acceptance_create_successor_work(client):
    owner, original_doctor, incoming, session, relationship, source = real_transfer_source(client)
    options = client.get(f"/api/v1/care/responsibility-transfers/options?patient_id={session['patient_id']}", headers=owner)
    assert options.status_code == 200, options.text
    request, payload = proposed(client, owner, session, relationship, source)
    assert request['status'] == 'pending_acceptance' and request['version'] == 1
    work = client.get('/api/v1/care/transferred-work', headers=incoming)
    assert work.status_code == 200 and work.json()['items'] == [], work.text
    detail = client.get(f"/api/v1/care/responsibility-transfers/{request['id']}", headers=incoming)
    assert detail.status_code == 200 and 'accept' in detail.json()['allowed_actions'], detail.text
    decision = {'patient_id': session['patient_id'], 'transfer_id': request['id'], 'client_decision_id': 'actual-recipient-acceptance',
        'expected_version': 1, 'decision': 'accept', 'reason': None, 'decision_context': detail.json()['decision_context'], 'confirmed': True}
    saved = client.post('/api/v1/care/responsibility-transfer-decisions', headers=incoming, json=decision)
    assert saved.status_code == 201 and saved.json()['status'] == 'accepted', saved.text
    actual = client.get('/api/v1/care/transferred-work', headers=incoming)
    assert actual.status_code == 200 and len(actual.json()['items']) == 1, actual.text
    assert actual.json()['items'][0]['original_attention_id'] == source['source_id']
    assert actual.json()['items'][0]['status'] == 'open'
    from backend.app.db.session import SessionLocal
    from backend.app.models.attention import AttentionItem
    with SessionLocal() as db:
        old = db.get(AttentionItem, source['source_id'])
        assert old.status == 'suspended' and old.responsible_doctor_id == session['responsible_doctor_id']
    unchanged = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert unchanged.status_code == 200 and all(row['acceptance_status'] == 'pending_review' for row in unchanged.json()['items'])
    retry = client.post('/api/v1/care/responsibility-transfers', headers=owner, json=payload)
    assert retry.status_code == 200 and retry.json() == request, retry.text
    assert client.get('/api/v1/care/transferred-work', headers=original_doctor).json()['items'] == []


def test_revoked_original_scope_does_not_block_a_fresh_explicit_handover_or_reactivate_old_doctor(client):
    owner, original_doctor, incoming, session, relationship, source = real_transfer_source(client, withdraw_original=True)
    assert client.get('/api/v1/care/doctor/work_queue', headers=original_doctor).json()['items'] == []
    request, _ = proposed(client, owner, session, relationship, source)
    detail = client.get(f"/api/v1/care/responsibility-transfers/{request['id']}", headers=incoming)
    assert detail.status_code == 200, detail.text
    result = client.post('/api/v1/care/responsibility-transfer-decisions', headers=incoming, json={
        'patient_id': session['patient_id'], 'transfer_id': request['id'], 'client_decision_id': 'accept-fresh-user-scope',
        'expected_version': 1, 'decision': 'accept', 'reason': None, 'decision_context': detail.json()['decision_context'], 'confirmed': True})
    assert result.status_code == 201, result.text
    work = client.get('/api/v1/care/transferred-work', headers=incoming)
    assert work.status_code == 200 and len(work.json()['items']) == 1, work.text
    history = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert history.status_code == 200 and history.json()['status'] == 'suspended', history.text
    assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=original_doctor).status_code == 403


def test_successor_read_and_processing_authenticate_the_selected_root_source_after_acceptance(client):
    owner, _, incoming, session, relation, source, identifier, _, _ = accepted_transfer(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_transfer import CareTransferWorkItem
    from backend.app.services import care_transfer_work_service as service
    from backend.app.models.user import User
    from backend.app.core.record_envelope import RecordIntegrityError
    import pytest
    with SessionLocal() as db:
        db.execute(text('UPDATE care_events SET aggregate_id=aggregate_id+1000 WHERE event_id='
            '(SELECT source_event_id FROM attention_items WHERE id=:identifier)'), {'identifier': source['source_id']})
        db.commit()
    with SessionLocal() as db:
        # Do not let a valid new grant hide a corrupt original evidence event.
        with pytest.raises(RecordIntegrityError):
            from backend.app.services.care_transfer_access import verify_work
            verify_work(db, db.get(CareTransferWorkItem, identifier))
        with pytest.raises(RecordIntegrityError):
            service.detail(db, db.get(User, relation['doctor_user_id']), identifier)


def test_service_revalidates_explicit_confirmation_even_when_an_internal_caller_copies_a_model(client):
    _, _, incoming, session, relation, source, identifier, _, _ = accepted_transfer(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.schemas.care_transfer import TransferWorkActionCreate
    from backend.app.services import care_transfer_work_service as service
    from fastapi import HTTPException
    import pytest
    detail = client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming).json()
    valid = TransferWorkActionCreate(patient_id=session['patient_id'], work_item_id=identifier,
        client_action_id='never-confirmed-internal-copy', expected_version=1, action='acknowledge', reason=None,
        action_context=detail['action_context'], confirmed=True)
    with SessionLocal() as db:
        with pytest.raises(HTTPException) as failure:
            service.act(db, db.get(User, relation['doctor_user_id']), valid.model_copy(update={'confirmed': False}))
        assert failure.value.status_code == 422


def test_doctor_history_does_not_borrow_a_republished_qualification_for_an_old_acceptance(client):
    owner, _, incoming, session, relation, source, identifier, _, _ = accepted_transfer(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        row = db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == relation['doctor_user_id']))
        ledger.deny(row); db.commit(); ledger.publish(row)
    denied = client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming)
    assert denied.status_code in {403, 409}, denied.text
    assert client.get('/api/v1/care/transferred-work', headers=incoming).json()['items'] == []
    assert client.get(f'/api/v1/care/transferred-work/{identifier}', headers=owner).status_code == 200


def test_basic_withdrawal_stops_new_successor_processing_but_retains_lawful_clinical_history(client):
    owner, _, incoming, session, relation, source, identifier, _, _ = accepted_transfer(client)
    basic = next(row for row in client.get('/api/v1/patient/consents', headers=owner).json()['items'] if row['purpose'] == 'basic_use')
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=owner, json={'expected_revision': basic['revision']}).status_code == 200
    detail = client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming)
    assert detail.status_code == 200 and detail.json()['allowed_actions'] == [], detail.text
    assert client.get(f'/api/v1/care/transferred-work/{identifier}/history', headers=incoming).status_code == 200


def test_original_acceptance_ack_cannot_invent_missing_work_after_database_corruption(client):
    _, _, incoming, session, relation, source, identifier, decision, _ = accepted_transfer(client)
    from backend.app.db.session import SessionLocal
    from backend.app.services.care_transfer_access import decision_ack
    from backend.app.models.care_transfer import CareTransferDecision
    from backend.app.core.record_envelope import RecordIntegrityError
    import pytest
    with SessionLocal() as db:
        db.execute(text('DELETE FROM care_transfer_work_items WHERE id=:identifier'), {'identifier': identifier})
        db.commit()
    with SessionLocal() as db:
        row = db.scalar(select(CareTransferDecision).where(CareTransferDecision.client_decision_id == decision['client_decision_id']))
        with pytest.raises(RecordIntegrityError):
            decision_ack(db, row)


def test_original_id_queries_remain_lawful_history_after_basic_withdrawal_without_permitting_new_processing(client):
    owner, _, incoming, session, relation, source, identifier, decision, decision_ack = accepted_transfer(client)
    detail = client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming).json()
    action = {'patient_id': session['patient_id'], 'work_item_id': identifier, 'client_action_id': 'query-committed-history',
        'expected_version': 1, 'action': 'acknowledge', 'reason': None, 'action_context': detail['action_context'], 'confirmed': True}
    saved = client.post('/api/v1/care/transferred-work-actions', headers=incoming, json=action)
    assert saved.status_code == 201, saved.text
    request_ack = client.get('/api/v1/care/responsibility-transfers/submissions/original-transfer-request', headers=owner).json()
    basic = next(row for row in client.get('/api/v1/patient/consents', headers=owner).json()['items'] if row['purpose'] == 'basic_use')
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=owner, json={'expected_revision': basic['revision']}).status_code == 200
    queried = client.get('/api/v1/care/responsibility-transfers/submissions/original-transfer-request', headers=owner)
    assert queried.status_code == 200 and queried.json() == request_ack, queried.text
    queried = client.get('/api/v1/care/responsibility-transfer-decisions/' + decision['client_decision_id'], headers=incoming)
    assert queried.status_code == 200 and queried.json() == decision_ack, queried.text
    queried = client.get('/api/v1/care/transferred-work-actions/' + action['client_action_id'], headers=incoming)
    assert queried.status_code == 200 and queried.json() == saved.json(), queried.text
    assert client.post('/api/v1/care/transferred-work-actions', headers=incoming, json={**action, 'client_action_id': 'new-post-after-basic-withdrawal'}).status_code == 403
    assert client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=owner,
        json={'expected_revision': relation['revision']}).status_code == 200
    assert client.get('/api/v1/care/responsibility-transfers/submissions/original-transfer-request', headers=owner).status_code == 200
    assert client.get('/api/v1/care/transferred-work-actions/' + action['client_action_id'], headers=incoming).status_code == 403
