"""Real selected-source races, original authority and critical transaction failures."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

from sqlalchemy import event, func, select

from backend.tests.test_responsibility_transfers import real_transfer_source, proposed, accepted_transfer


def decision_body(client, headers, request, *, action='accept', identifier='original-decision'):
    detail = client.get(f"/api/v1/care/responsibility-transfers/{request['id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    return {'patient_id': request['patient_id'], 'transfer_id': request['id'], 'client_decision_id': identifier,
        'expected_version': 1, 'decision': action, 'reason': None if action == 'accept' else '合成用户实际决定撤销。',
        'decision_context': detail.json()['decision_context'], 'confirmed': True}


def test_first_request_post_cannot_borrow_a_republished_receiving_authority(client):
    owner, _, _, session, relation, source = real_transfer_source(client)
    body = {'patient_id': session['patient_id'], 'receiving_relationship_id': relation['id'], 'sources': [source], 'reason': None}
    context = client.post('/api/v1/care/responsibility-transfers/preflight', headers=owner, json=body)
    assert context.status_code == 200, context.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.models.care_transfer import CareTransferRequest
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        row = db.get(CareRelationship, relation['id']); ledger.deny(row); db.commit(); ledger.publish(row)
    response = client.post('/api/v1/care/responsibility-transfers', headers=owner, json={**body,
        'client_transfer_id': 'never-posted-before-regrant', 'request_context': context.json()['request_context'], 'confirmed': True})
    assert response.status_code in {403, 409}, response.text
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CareTransferRequest)) == 0


def test_source_change_requires_new_user_confirmation_and_cancel_releases_its_actual_claim(client):
    owner, previous, incoming, session, relation, source = real_transfer_source(client)
    request, _ = proposed(client, owner, session, relation, source)
    decision = decision_body(client, incoming, request)
    detail = client.get(f"/api/v1/care/attention/{source['source_id']}", headers=previous).json()
    changed = client.post('/api/v1/care/attention-actions', headers=previous, json={'patient_id': session['patient_id'],
        'attention_id': source['source_id'], 'client_action_id': 'original-doctor-changed-source', 'expected_version': 1,
        'action': 'acknowledge', 'reason': None, 'action_context': detail['action_context'], 'confirmed': True})
    assert changed.status_code == 201, changed.text
    denied = client.post('/api/v1/care/responsibility-transfer-decisions', headers=incoming, json=decision)
    assert denied.status_code == 409, denied.text
    current = client.get(f"/api/v1/care/responsibility-transfers/{request['id']}", headers=incoming)
    assert current.status_code == 200 and current.json()['allowed_actions'] == ['reject'], current.text
    cancelled = client.post('/api/v1/care/responsibility-transfer-decisions', headers=owner,
        json=decision_body(client, owner, request, action='cancel', identifier='actual-owner-cancel'))
    assert cancelled.status_code == 201 and cancelled.json()['work_item_ids'] == [], cancelled.text
    source['expected_version'] = 2
    next_request, _ = proposed(client, owner, session, relation, source, client_id='fresh-list-after-cancel')
    assert next_request['sources'][0]['claim_revision'] == 2
    assert client.post('/api/v1/care/responsibility-transfer-decisions', headers=incoming,
        json=decision_body(client, incoming, next_request, identifier='fresh-actual-acceptance')).status_code == 201


def test_concurrent_actual_user_cancel_and_receiving_doctor_accept_have_one_final_winner(client):
    owner, _, incoming, session, relation, source = real_transfer_source(client)
    request, _ = proposed(client, owner, session, relation, source)
    accept = decision_body(client, incoming, request)
    cancel = decision_body(client, owner, request, action='cancel', identifier='actual-cancel-race')
    ready = Barrier(2)
    def submit(arguments):
        headers, body = arguments; ready.wait(timeout=10)
        return client.post('/api/v1/care/responsibility-transfer-decisions', headers=headers, json=body)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(submit, [(incoming, accept), (owner, cancel)]))
    assert sorted(response.status_code for response in responses) == [201, 409], [r.text for r in responses]
    winner = next(r.json() for r in responses if r.status_code == 201)
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_transfer import CareTransferDecision, CareTransferWorkItem
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CareTransferDecision)) == 1
        assert db.scalar(select(func.count()).select_from(CareTransferWorkItem)) == (1 if winner['decision'] == 'accept' else 0)


def test_critical_final_commit_failure_rolls_back_source_pause_work_and_decision_and_recovers_original(client, monkeypatch):
    owner, _, incoming, session, relation, source = real_transfer_source(client)
    request, _ = proposed(client, owner, session, relation, source)
    decision = decision_body(client, incoming, request)
    from backend.app.services import care_transfer_service as service
    original = service.make_decision
    def fail_after_facts(db, *args):
        result = original(db, *args)
        def fail(*_):
            raise OSError('synthetic final handover commit unavailable')
        event.listen(db, 'before_commit', fail, once=True)
        return result
    monkeypatch.setattr(service, 'make_decision', fail_after_facts)
    response = client.post('/api/v1/care/responsibility-transfer-decisions', headers=incoming, json=decision)
    assert response.status_code == 503 and 'work_item_ids' not in response.text, response.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_transfer import CareTransferWorkItem, CareTransferDecision
    from backend.app.models.attention import AttentionItem
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CareTransferDecision)) == 0
        assert db.scalar(select(func.count()).select_from(CareTransferWorkItem)) == 0
        assert db.get(AttentionItem, source['source_id']).status == 'open'
    monkeypatch.setattr(service, 'make_decision', original)
    saved = client.post('/api/v1/care/responsibility-transfer-decisions', headers=incoming, json=decision)
    assert saved.status_code == 201, saved.text
    assert client.get('/api/v1/care/responsibility-transfer-decisions/' + decision['client_decision_id'], headers=incoming).json() == saved.json()


def test_critical_audit_failure_discloses_no_context_and_preserves_original_pending_state(client, monkeypatch):
    owner, _, incoming, session, relation, source = real_transfer_source(client)
    request, _ = proposed(client, owner, session, relation, source)
    decision = decision_body(client, incoming, request)
    from backend.app.services import security_service
    original = security_service._append_audit_log
    def fail(db, **kwargs):
        if kwargs['action'].startswith('care_transfer'):
            raise OSError('synthetic critical transfer audit failure')
        return original(db, **kwargs)
    monkeypatch.setattr(security_service, '_append_audit_log', fail)
    response = client.post('/api/v1/care/responsibility-transfer-decisions', headers=incoming, json=decision)
    assert response.status_code == 503, response.text
    read = client.get(f"/api/v1/care/responsibility-transfers/{request['id']}", headers=incoming)
    assert read.status_code == 503 and 'decision_context' not in read.text
    monkeypatch.setattr(security_service, '_append_audit_log', original)
    detail = client.get(f"/api/v1/care/responsibility-transfers/{request['id']}", headers=incoming)
    assert detail.json()['status'] == 'pending_acceptance'


def test_accepted_successor_gets_actual_new_coverage_and_independent_original_deadline_observation(client):
    from backend.tests.test_service_coverage import institutional_actor, coverage_body, versions_route
    def coverage(incoming, relation):
        _, reviewer = institutional_actor(client, 'successor-window-reviewer', reviewer=True)
        body = coverage_body('successor-actual-coverage')
        configured = client.post(versions_route(relation['doctor_user_id']), headers=reviewer, json=body)
        assert configured.status_code == 201, configured.text
    owner, _, incoming, session, relation, source, identifier, _, _ = accepted_transfer(client, before_accept=coverage)
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_transfer import CareTransferWorkItem
    from backend.app.models.attention import AttentionItem
    from backend.app.services.care_transfer_access import utc
    from backend.app.services.care_transfer_maintenance import maintain_once
    with SessionLocal() as db:
        old = db.get(AttentionItem, source['source_id']); work = db.get(CareTransferWorkItem, identifier)
        assert old.expected_response_at is None and work.expected_response_at is not None
        deadline = utc(work.expected_response_at)
    assert maintain_once(SessionLocal, clock=lambda: deadline - timedelta(seconds=1)) == 0
    assert maintain_once(SessionLocal, clock=lambda: deadline + timedelta(seconds=1)) == 1
    assert maintain_once(SessionLocal, clock=lambda: deadline + timedelta(seconds=2)) == 0
    detail = client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming)
    assert detail.status_code == 200, detail.text
    actual = detail.json()['work']
    assert actual['status'] == 'open' and actual['version'] == 1
    assert actual['overdue_observation']['original_deadline'] == deadline.isoformat()
    assert actual['overdue_observation']['external_delivery_status'] == 'not_configured'
