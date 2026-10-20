"""A new explicit responsibility must not silently depend on the old doctor's grant."""
from backend.tests.test_responsibility_transfers import accepted_transfer


def test_withdrawing_original_doctor_after_accepted_handover_preserves_new_scope_but_not_old_arrangements(client):
    owner, previous, incoming, session, relation, source, identifier, _, _ = accepted_transfer(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.models.care_transfer import CareTransferWorkItem
    from backend.app.models.attention import AttentionItem
    from backend.app.services.care_authority_reconciliation import reconcile_once
    from backend.app.services.care_transfer_maintenance import maintain_once
    from sqlalchemy import select
    with SessionLocal() as db:
        prior = db.scalar(select(CareRelationship).where(CareRelationship.patient_id == session['patient_id'],
            CareRelationship.doctor_user_id == session['responsible_doctor_id']))
        prior_id, revision = prior.id, prior.revision
    revoked = client.post(f'/api/v1/care/relationships/{prior_id}/revoke', headers=owner,
        json={'expected_revision': revision})
    assert revoked.status_code == 200, revoked.text
    assert reconcile_once(SessionLocal) >= 1
    assert maintain_once(SessionLocal) == 0
    detail = client.get(f'/api/v1/care/transferred-work/{identifier}', headers=incoming)
    assert detail.status_code == 200 and 'acknowledge' in detail.json()['allowed_actions'], detail.text
    action = client.post('/api/v1/care/transferred-work-actions', headers=incoming, json={
        'patient_id': session['patient_id'], 'work_item_id': identifier, 'client_action_id': 'new-doctor-independent-scope',
        'expected_version': 1, 'action': 'acknowledge', 'reason': None, 'action_context': detail.json()['action_context'], 'confirmed': True})
    assert action.status_code == 201, action.text
    with SessionLocal() as db:
        assert db.get(CareTransferWorkItem, identifier).status == 'acknowledged'
        assert db.get(AttentionItem, source['source_id']).suspension_reason == 'responsibility_transferred'
    old = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert old.status_code == 200 and old.json()['status'] == 'suspended'
    assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=previous).status_code == 403
