"""Narrow F01 review counterexamples; all persistence uses the client temp stores."""
from datetime import datetime, timedelta, timezone

from backend.tests.w02_helpers import register, qualify


BASE = '/api/v1/federated'


def _action(client, headers, path, client_id, revision, **extra):
    return client.post(BASE + path, headers=headers, json={
        'client_request_id': client_id, 'expected_revision': revision,
        'confirmed': True, 'reason': '独立F01合成边界检查', **extra,
    })


def _project(client, headers, client_id='review-project', expires_at=None):
    body = {
        'client_request_id': client_id, 'institution_id': 'synthetic-institution',
        'name': 'F01范围审查', 'purpose': '只用合成数据检查控制权限', 'mode': 'synthetic',
        'data_contract': 'synthetic-roi-v1',
        'expires_at': expires_at or (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
    }
    response = client.post(BASE + '/projects', headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json(), body


def test_review_non_utc_project_remains_readable_after_creation(client):
    dac, headers = register(client, 'review-timezone@example.com', 'researcher')
    qualify(dac['user']['id'], reviewer=True)
    expiry = (datetime.now(timezone(timedelta(hours=8))) + timedelta(days=2)).isoformat()
    project, body = _project(client, headers, expires_at=expiry)
    original = client.get(BASE + '/submissions/review-project', headers=headers)
    assert original.status_code == 200, original.text
    assert original.json()['original_request'] == body
    result = client.get(BASE + f"/projects/{project['id']}", headers=headers)
    assert result.status_code == 200, result.text
    approved = _action(client, headers, f"/projects/{project['id']}/approve", 'review-timezone-approve', project['revision'])
    assert approved.status_code == 200, approved.text
    patient, ph = register(client, 'review-timezone-patient@example.com')
    consent = client.post('/api/v1/patient/consents', headers=ph, json={
        'patient_id': patient['user']['patient_profile']['id'], 'purpose': 'research',
        'project_id': project['id'], 'expected_project_revision':approved.json()['result']['revision'], 'scope': ['assessment'], 'terms_version': 'W02-1',
        'expires_at': (datetime.now(timezone(timedelta(hours=8))) + timedelta(days=1)).isoformat(),
    })
    assert consent.status_code == 201, consent.text
    assert consent.json()['effective_access'] is True


def _institution(user_id, institution, role='reviewer'):
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import InstitutionMembership
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        row = InstitutionMembership(user_id=user_id, institution_id=institution,
            role=role, status='verified', verification_reference='independent-synthetic-review')
        db.add(row)
        db.flush()
        ledger.reserve(row)
        db.commit()
        ledger.publish(row)
        return row.id


def _node(client, headers, institution='synthetic-institution', client_id='review-node'):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    pem = Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
    result = client.post(BASE + '/nodes/enrollment', headers=headers, json={
        'client_request_id': client_id, 'institution_id': institution, 'name': '合成独立节点',
        'public_key_pem': pem, 'compatibility': 'flower-1.23/secaggplus-v1',
    })
    assert result.status_code == 201, result.text
    node = result.json()
    approved = _action(client, headers, f"/nodes/{node['id']}/approve", client_id+'-approve', node['revision'])
    assert approved.status_code == 200, approved.text
    return approved.json()['result']


def test_review_cross_institution_acceptance_and_revocation_are_scoped(client):
    dac, ah = register(client, 'review-a@example.com', 'researcher')
    qualify(dac['user']['id'], reviewer=True)
    node_dac, bh = register(client, 'review-b@example.com', 'researcher')
    _institution(node_dac['user']['id'], 'synthetic-b')
    foreign_dac, ch = register(client, 'review-c@example.com', 'researcher')
    _institution(foreign_dac['user']['id'], 'synthetic-c')
    doctor, dh = register(client, 'review-doctor@example.com', 'researcher')
    qualify(doctor['user']['id'])
    project, body = _project(client, ah)
    pid = project['id']
    approved = _action(client, ah, f'/projects/{pid}/approve', 'review-project-approve', project['revision'])
    assert approved.status_code == 200, approved.text
    project = approved.json()['result']
    for headers in (bh, ch, dh):
        assert client.get(BASE + f'/projects/{pid}', headers=headers).status_code == 403
        assert _action(client, headers, f'/projects/{pid}/approve', 'review-forbidden-approve', project['revision']).status_code == 403
        assert _action(client, headers, f'/projects/{pid}/members', 'review-forbidden-member', project['revision'],
            user_id=doctor['user']['id'], permissions=['view'], expires_at=body['expires_at']).status_code == 403
    node = _node(client, bh, 'synthetic-b')
    for headers in (ah, ch, dh):
        assert _action(client, headers, f"/nodes/{node['id']}/revoke", 'review-forbidden-node-revoke', node['revision']).status_code == 403
    invited = _action(client, ah, f'/projects/{pid}/nodes', 'review-node-invite', project['revision'], node_id=node['id'])
    assert invited.status_code == 200, invited.text
    link = invited.json()['result']
    assert link['status'] == 'pending'
    listing = client.get(BASE + '/projects', headers=bh)
    assert listing.status_code == 200, listing.text
    assert listing.json()['projects'] == []
    assert listing.json()['node_invitations'][0]['id'] == link['id']
    assert 'members' not in listing.json()['node_invitations'][0]
    for headers in (ah, ch, dh):
        assert _action(client, headers, f"/projects/{pid}/nodes/{link['id']}/approve", 'review-forbidden-invite-approve', link['revision']).status_code == 403
    accepted = _action(client, bh, f"/projects/{pid}/nodes/{link['id']}/approve", 'review-invite-accept', link['revision'])
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()['result']['status'] == 'approved'
    assert client.get(BASE + f'/projects/{pid}', headers=bh).status_code == 403
    assert client.get(BASE + '/submissions/review-invite-accept', headers=ah).status_code == 403
    assert _action(client, bh, f"/projects/{pid}/nodes/{link['id']}/approve", 'review-invite-accept', link['revision']).json() == accepted.json()
    assert _action(client, bh, f"/projects/{pid}/nodes/{link['id']}/approve", 'review-invite-accept', link['revision'], reason='不同请求').status_code == 409
    assert _action(client, ch, f"/projects/{pid}/nodes/{link['id']}/revoke", 'review-forbidden-invite-revoke', accepted.json()['result']['revision']).status_code == 403
    revoked = _action(client, bh, f"/projects/{pid}/nodes/{link['id']}/revoke", 'review-invite-revoke', accepted.json()['result']['revision'])
    assert revoked.status_code == 200, revoked.text
    detail = client.get(BASE + f'/projects/{pid}', headers=ah)
    assert detail.json()['nodes'][0]['effective_status'] == 'revoked'
    reinvited = _action(client, ah, f'/projects/{pid}/nodes', 'review-relink-revoked', project['revision'], node_id=node['id'])
    assert reinvited.status_code == 200, reinvited.text
    assert reinvited.json()['result']['status'] == 'pending'
    assert reinvited.json()['result']['id'] == link['id']
    assert reinvited.json()['result']['revision'] > revoked.json()['result']['revision']
    assert client.get(BASE + '/submissions/review-invite-revoke', headers=bh).json() == revoked.json()
    assert _action(client, bh, f"/projects/{pid}/nodes/{link['id']}/approve", 'review-invite-accept', link['revision']).json() == accepted.json()
    assert client.get(BASE + f'/projects/{pid}', headers=ah).json()['nodes'][0]['effective_status'] == 'pending'


def test_review_explicit_project_reapproval_does_not_reactivate_old_member_or_consent(client):
    from sqlalchemy import select
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import InstitutionMembership
    from backend.app.models.consent import ConsentRecord
    from backend.app.services import authorization_ledger as ledger
    from backend.app.services.identity_access import require_research_access
    from fastapi import HTTPException
    import pytest
    dac, ah = register(client, 'review-regrant-dac@example.com', 'researcher')
    qualify(dac['user']['id'], reviewer=True)
    member, mh = register(client, 'review-regrant-member@example.com', 'researcher')
    qualify(member['user']['id'])
    patient, ph = register(client, 'review-regrant-patient@example.com')
    patient_id = patient['user']['patient_profile']['id']
    project, body = _project(client, ah)
    pid = project['id']
    approved = _action(client, ah, f'/projects/{pid}/approve', 'review-original-approve', project['revision'])
    assert approved.status_code == 200, approved.text
    project = approved.json()['result']
    granted = _action(client, ah, f'/projects/{pid}/members', 'review-original-member', project['revision'],
        user_id=member['user']['id'], permissions=['view'], expires_at=body['expires_at'])
    assert granted.status_code == 200, granted.text
    consent_body = {'patient_id': patient_id, 'purpose': 'research', 'project_id': pid,
        'expected_project_revision':project['revision'],'scope': ['assessment'], 'terms_version': 'W02-1'}
    consent = client.post('/api/v1/patient/consents', headers=ph, json=consent_body)
    assert consent.status_code == 201, consent.text
    node = _node(client, ah)
    linked = _action(client, ah, f'/projects/{pid}/nodes', 'review-original-node-link', project['revision'], node_id=node['id'])
    assert linked.status_code == 200, linked.text
    assert linked.json()['result']['status'] == 'approved'
    # Even unchanged institutional credentials must not lend a newer project
    # approval revision to earlier member, consent, or whitelist grants.
    same_dac_reapproval = _action(client, ah, f'/projects/{pid}/approve', 'review-same-dac-reapprove', project['revision'])
    assert same_dac_reapproval.status_code == 200, same_dac_reapproval.text
    project = same_dac_reapproval.json()['result']
    assert client.get(BASE + f'/projects/{pid}', headers=ah).json()['nodes'][0]['effective_status'] == 'authority_invalid'
    assert client.get(BASE + f'/projects/{pid}', headers=mh).status_code == 403
    context = client.get(BASE + f'/projects/{pid}/consent', headers=ph, params={'patient_id': patient_id})
    assert context.json()['items'][-1]['effective_access'] is False
    renewed_member = _action(client, ah, f'/projects/{pid}/members', 'review-renewed-member', project['revision'],
        user_id=member['user']['id'], permissions=['view'], expires_at=body['expires_at'])
    assert renewed_member.status_code == 200, renewed_member.text
    consent_body['expected_project_revision']=project['revision']
    consent = client.post('/api/v1/patient/consents', headers=ph, json=consent_body)
    assert consent.status_code == 201, consent.text
    with SessionLocal() as db:
        assert require_research_access(db, member['user']['id'], patient_id, pid, 'assessment')
        reviewer = db.scalar(select(InstitutionMembership).where(InstitutionMembership.user_id == dac['user']['id']))
        ledger.deny(reviewer)
        reviewer.status = 'revoked'
        db.commit()
    _institution(dac['user']['id'], 'synthetic-institution')
    context = client.get(BASE + f'/projects/{pid}/consent', headers=ph, params={'patient_id': patient_id})
    assert context.status_code == 200, context.text
    assert context.json()['items'][-1]['effective_access'] is False
    assert client.get(BASE + f'/projects/{pid}', headers=mh).status_code == 403
    assert client.post('/api/v1/patient/consents', headers=ph, json=consent_body).status_code == 403
    reapproved = _action(client, ah, f'/projects/{pid}/approve', 'review-new-approve', project['revision'])
    assert reapproved.status_code == 200, reapproved.text
    assert reapproved.json()['result']['revision'] > project['revision']
    context = client.get(BASE + f'/projects/{pid}/consent', headers=ph, params={'patient_id': patient_id})
    assert context.status_code == 200, context.text
    assert context.json()['items'][-1]['effective_access'] is False
    assert client.get(BASE + f'/projects/{pid}', headers=mh).status_code == 403
    with SessionLocal() as db, pytest.raises(HTTPException):
        require_research_access(db, member['user']['id'], patient_id, pid, 'assessment')
    # Replacing the project authority does not create a new canonical grant.
    with SessionLocal() as db:
        assert len(db.scalars(select(ConsentRecord).where(ConsentRecord.project_id == pid)).all()) == 2
    # The unified withdrawal endpoint remains available for the original record.
    withdrawn = client.post(f"/api/v1/patient/consents/{consent.json()['id']}/withdraw", headers=ph,
        json={'expected_revision': consent.json()['revision']})
    assert withdrawn.status_code == 200, withdrawn.text
    assert withdrawn.json()['effective_access'] is False


def test_review_independent_audit_anchor_refuses_deleted_business_history(client):
    from sqlalchemy import text
    from backend.app.db.session import SessionLocal
    dac, ah = register(client, 'review-anchor@example.com', 'researcher')
    qualify(dac['user']['id'], reviewer=True)
    project, _ = _project(client, ah)
    pid = project['id']
    assert client.get(BASE + f'/projects/{pid}/audit', headers=ah).json()['integrity'] == 'verified'
    # Only this test's temporary business DB is changed; the independent ledger remains.
    with SessionLocal() as db:
        db.execute(text('DELETE FROM federated_audit_events'))
        db.execute(text('DELETE FROM federated_audit_heads'))
        db.commit()
    assert client.get(BASE + f'/projects/{pid}', headers=ah).status_code == 503
    body = {'client_request_id': 'review-rebuild-head', 'institution_id': 'synthetic-institution',
        'name': '不能重建审计头', 'purpose': '删除业务备份后仍须拒绝', 'mode': 'synthetic',
        'data_contract': 'synthetic-roi-v1',
        'expires_at': (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()}
    assert client.post(BASE + '/projects', headers=ah, json=body).status_code == 503


def test_review_expiry_denies_old_member_node_authority_and_project_grants(client, monkeypatch):
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import InstitutionMembership
    from backend.app.services import authorization_ledger as ledger, identity_access
    from fastapi import HTTPException
    import pytest
    now = datetime.now(timezone.utc)
    dac, ah = register(client, 'review-expiry-dac@example.com', 'researcher')
    qualify(dac['user']['id'], reviewer=True)
    member, mh = register(client, 'review-expiry-member@example.com', 'researcher')
    qualify(member['user']['id'])
    patient, ph = register(client, 'review-expiry-patient@example.com')
    patient_id = patient['user']['patient_profile']['id']
    node_dac, nh = register(client, 'review-expiry-node-dac@example.com', 'researcher')
    with SessionLocal() as db:
        credential = InstitutionMembership(user_id=node_dac['user']['id'], institution_id='synthetic-institution',
            role='reviewer', status='verified', verification_reference='synthetic-expiring-reviewer',
            expires_at=now + timedelta(hours=1))
        db.add(credential)
        db.flush()
        ledger.reserve(credential)
        db.commit()
        ledger.publish(credential)
    project, _ = _project(client, ah, expires_at=(now + timedelta(days=2)).isoformat())
    pid = project['id']
    approved = _action(client, ah, f'/projects/{pid}/approve', 'review-expiry-approve', project['revision'])
    assert approved.status_code == 200, approved.text
    project = approved.json()['result']
    granted = _action(client, ah, f'/projects/{pid}/members', 'review-expiry-member-grant', project['revision'],
        user_id=member['user']['id'], permissions=['view'], expires_at=(now + timedelta(hours=1)).isoformat())
    assert granted.status_code == 200, granted.text
    node = _node(client, nh)
    linked = _action(client, ah, f'/projects/{pid}/nodes', 'review-expiry-link', project['revision'], node_id=node['id'])
    assert linked.status_code == 200, linked.text
    consent_body = {'client_request_id': 'review-expiry-consent', 'patient_id': patient_id,
        'purpose': 'research', 'project_id': pid,'expected_project_revision':project['revision'], 'scope': ['assessment'], 'terms_version': 'W02-1'}
    consent = client.post(BASE + f'/projects/{pid}/consent', headers=ph, json=consent_body)
    assert consent.status_code == 201, consent.text

    class ReviewClock(datetime):
        instant = None

        @classmethod
        def now(cls, tz=None):
            return cls.instant.astimezone(tz) if tz else cls.instant.replace(tzinfo=None)

    ReviewClock.instant = now + timedelta(hours=2)
    monkeypatch.setattr(identity_access, 'datetime', ReviewClock)
    assert client.get(BASE + f'/projects/{pid}', headers=mh).status_code == 403
    with SessionLocal() as db, pytest.raises(HTTPException):
        identity_access.require_research_access(db, member['user']['id'], patient_id, pid, 'assessment')
    detail = client.get(BASE + f'/projects/{pid}', headers=ah)
    assert detail.status_code == 200, detail.text
    assert detail.json()['nodes'][0]['effective_status'] == 'authority_invalid'
    assert _action(client, nh, f"/nodes/{node['id']}/approve", 'review-expired-node-reapprove', node['revision']).status_code == 403

    ReviewClock.instant = now + timedelta(days=3)
    context = client.get(BASE + f'/projects/{pid}/consent', headers=ph, params={'patient_id': patient_id})
    assert context.status_code == 200, context.text
    assert context.json()['items'][-1]['effective_access'] is False
    assert client.post(BASE + f'/projects/{pid}/consent', headers=ph,
        json={**consent_body, 'client_request_id': 'review-expired-project-new-consent'}).status_code == 403
    assert _action(client, ah, f'/projects/{pid}/approve', 'review-expired-project-reapprove', project['revision']).status_code == 409
    withdrawn = client.post(BASE + f'/projects/{pid}/consent/withdraw', headers=ph, json={
        'client_request_id': 'review-expired-project-withdraw', 'patient_id': patient_id,
        'consent_id': consent.json()['result']['id'], 'expected_revision': consent.json()['result']['revision'],
    })
    assert withdrawn.status_code == 200, withdrawn.text
    assert withdrawn.json()['result']['status'] == 'withdrawn'
