"""Independent W05 remainder spec probes; synthetic fixture stores only."""
from sqlalchemy import select

from backend.tests.test_attention_action_routes import created_attention
from backend.tests.test_attention_lifecycle import action_body
from backend.tests.test_responsibility_transfers import real_transfer_source


def withdraw_basic(client, owner):
    consents = client.get('/api/v1/patient/consents', headers=owner)
    assert consents.status_code == 200, consents.text
    basic = next(row for row in consents.json()['items'] if row['purpose'] == 'basic_use')
    response = client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=owner,
        json={'expected_revision': basic['revision']})
    assert response.status_code == 200, response.text


def test_spec_self_attention_committed_original_query_survives_basic_withdrawal(client):
    owner, row, view = created_attention(client)
    body = action_body(view, 'independent-self-original-history', 'acknowledge')
    saved = client.post(f"/api/v1/care/attention/{row['id']}/actions", headers=owner, json=body)
    assert saved.status_code == 201, saved.text
    withdraw_basic(client, owner)
    history = client.get(f"/api/v1/care/attention/{row['id']}/history", headers=owner)
    assert history.status_code == 200 and history.json()['items'] == [saved.json()], history.text
    # This GET must recover the same retained fact, not authorize a new action.
    queried = client.get('/api/v1/care/attention-actions/' + body['client_action_id'], headers=owner)
    assert queried.status_code == 200, queried.text
    assert queried.json() == saved.json()
    assert client.post(f"/api/v1/care/attention/{row['id']}/actions", headers=owner,
        json={**body, 'client_action_id': 'independent-new-self-action'}).status_code == 403


def test_spec_doctor_attention_committed_original_query_retains_current_clinical_history(client):
    owner, previous, _, session, _, source = real_transfer_source(client)
    view = client.get(f"/api/v1/care/attention/{source['source_id']}", headers=previous)
    assert view.status_code == 200, view.text
    body = action_body(view.json(), 'independent-clinical-original-history', 'acknowledge')
    saved = client.post(f"/api/v1/care/attention/{source['source_id']}/actions", headers=previous, json=body)
    assert saved.status_code == 201, saved.text
    withdraw_basic(client, owner)
    history = client.get(f"/api/v1/care/attention/{source['source_id']}/history", headers=previous)
    assert history.status_code == 200 and history.json()['items'] == [saved.json()], history.text
    queried = client.get('/api/v1/care/attention-actions/' + body['client_action_id'], headers=previous)
    assert queried.status_code == 200, queried.text
    assert queried.json() == saved.json()
    # Historical read permission still excludes a different doctor and cannot
    # borrow republished original qualification or current processing permission.
    assert client.post(f"/api/v1/care/attention/{source['source_id']}/actions", headers=previous,
        json={**body, 'client_action_id': 'independent-new-clinical-action'}).status_code == 403
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        qualification = db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == session['responsible_doctor_id']))
        ledger.deny(qualification)
        db.commit()
        ledger.publish(qualification)
    denied = client.get('/api/v1/care/attention-actions/' + body['client_action_id'], headers=previous)
    assert denied.status_code in {403, 409}, denied.text


def test_spec_working_deadline_consumes_exact_real_periods_without_losing_microseconds(client):
    from datetime import datetime, timezone
    from backend.app.services.service_coverage_service import working_deadline
    periods = [{'weekday': day, 'start': start, 'end': end}
        for day in range(5) for start, end in [('09:00', '12:00'), ('13:00', '17:00')]]
    start = datetime(2026, 10, 16, 8, 59, 59, 123456, tzinfo=timezone.utc)  # Friday 16:59:59.123456 Shanghai.
    assert working_deadline(start, periods, 2) == datetime(2026, 10, 19, 1, 1, 59, 123456, tzinfo=timezone.utc)
    assert working_deadline(datetime(2026, 10, 19, 4, tzinfo=timezone.utc), periods, 60) == datetime(2026, 10, 19, 6, tzinfo=timezone.utc)


def test_spec_first_work_action_never_borrows_republished_receiving_head(client):
    from backend.tests.test_responsibility_transfers import accepted_transfer
    owner, _, incoming, session, relation, _, identifier, _, _ = accepted_transfer(client)
    view = client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming)
    assert view.status_code == 200, view.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.models.care_transfer import CareTransferWorkItem, CareTransferWorkAction
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        row = db.get(CareRelationship, relation['id'])
        ledger.deny(row)
        db.commit()
        ledger.publish(row)
    payload = {'patient_id': session['patient_id'], 'work_item_id': identifier,
        'client_action_id': 'independent-first-work-action-regrant', 'expected_version': 1,
        'action': 'acknowledge', 'reason': None, 'action_context': view.json()['action_context'], 'confirmed': True}
    rejected = client.post('/api/v1/care/transferred-work-actions', headers=incoming, json=payload)
    assert rejected.status_code in {403, 409}, rejected.text
    with SessionLocal() as db:
        assert db.get(CareTransferWorkItem, identifier).status == 'open'
        assert db.scalar(select(CareTransferWorkAction)) is None
    # The lawful patient retains the original accepted responsibility fact.
    assert client.get(f'/api/v1/care/transferred-work/{identifier}', headers=owner).status_code == 200


def test_spec_decision_context_cannot_authorize_patient_as_actual_accepting_doctor(client):
    from backend.tests.test_responsibility_transfers import proposed
    owner, _, incoming, session, relation, source = real_transfer_source(client)
    request, _ = proposed(client, owner, session, relation, source, client_id='independent-actor-bound-request')
    view = client.get(f"/api/v1/care/responsibility-transfers/{request['id']}", headers=incoming)
    assert view.status_code == 200, view.text
    payload = {'patient_id': session['patient_id'], 'transfer_id': request['id'],
        'client_decision_id': 'independent-wrong-actor-first-decision', 'expected_version': 1,
        'decision': 'accept', 'reason': None, 'decision_context': view.json()['decision_context'], 'confirmed': True}
    rejected = client.post('/api/v1/care/responsibility-transfer-decisions', headers=owner, json=payload)
    assert rejected.status_code == 403, rejected.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_transfer import CareTransferDecision, CareTransferWorkItem
    from backend.app.models.attention import AttentionItem
    with SessionLocal() as db:
        assert db.scalar(select(CareTransferDecision)) is None
        assert db.scalar(select(CareTransferWorkItem)) is None
        assert db.get(AttentionItem, source['source_id']).status == 'open'


def test_spec_successor_original_queries_do_not_borrow_republished_clinical_relationship(client):
    from backend.tests.test_responsibility_transfers import accepted_transfer
    owner, _, incoming, session, relation, _, identifier, decision, _ = accepted_transfer(client)
    view = client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming)
    body = {'patient_id': session['patient_id'], 'work_item_id': identifier,
        'client_action_id': 'independent-clinical-head-history', 'expected_version': 1,
        'action': 'acknowledge', 'reason': None, 'action_context': view.json()['action_context'], 'confirmed': True}
    saved = client.post('/api/v1/care/transferred-work-actions', headers=incoming, json=body)
    assert saved.status_code == 201, saved.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        row = db.get(CareRelationship, relation['id'])
        ledger.deny(row)
        db.commit()
        ledger.publish(row)
    for path in ('/api/v1/care/transferred-work-actions/' + body['client_action_id'],
        '/api/v1/care/responsibility-transfer-decisions/' + decision['client_decision_id']):
        denied = client.get(path, headers=incoming)
        assert denied.status_code in {403, 409}, denied.text
    assert client.get(f'/api/v1/care/transferred-work/{identifier}', headers=owner).status_code == 200


def test_spec_attention_original_query_does_not_borrow_republished_clinical_relationship(client):
    owner, previous, _, _, _, source = real_transfer_source(client)
    view = client.get(f"/api/v1/care/attention/{source['source_id']}", headers=previous)
    body = action_body(view.json(), 'independent-attention-clinical-head', 'acknowledge')
    saved = client.post(f"/api/v1/care/attention/{source['source_id']}/actions", headers=previous, json=body)
    assert saved.status_code == 201, saved.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.models.attention import AttentionItem
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        identifier = db.get(AttentionItem, source['source_id']).relationship_id
        row = db.get(CareRelationship, identifier)
        ledger.deny(row)
        db.commit()
        ledger.publish(row)
    denied = client.get('/api/v1/care/attention-actions/' + body['client_action_id'], headers=previous)
    assert denied.status_code in {403, 409}, denied.text
    assert client.get(f"/api/v1/care/attention/{source['source_id']}/history", headers=owner).status_code == 200
