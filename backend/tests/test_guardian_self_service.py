"""Guardian declaration enables ordinary child use without institutional review."""
from backend.tests.w02_helpers import register


def child_registration(client, suffix='self-service-child', **guardian_changes):
    guardian = {'age': 35, 'relation': 'parent', 'confirmed': True, **guardian_changes}
    return client.post('/api/v1/auth/register', json={
        'email': suffix + '@example.com', 'password': 'Synthetic#2026',
        'full_name': 'Synthetic Guardian', 'role': 'patient', 'consent_agreed': True,
        'patient_profile': {'display_name': 'Synthetic Child', 'patient_type': 'child', 'age': 10},
        'guardian': guardian,
    })


def test_child_registration_is_usable_without_institution_or_proof_number(client, monkeypatch):
    response = child_registration(client)
    assert response.status_code == 201, response.text
    saved = response.json(); headers = {'Authorization': 'Bearer ' + saved['access_token']}
    context = client.get('/api/v1/identity/context', headers=headers)
    assert context.status_code == 200, context.text
    data = context.json(); assert len(data['accessible_patients']) == 1
    row = data['guardian_relationships'][0]
    assert row['status'] == 'confirmed' and row['institution_id'] is None and row['effective_access']
    assert data['accessible_patients'][0]['guardian_status'] == 'confirmed'
    pid = data['accessible_patients'][0]['patient_id']
    consents = client.get(f'/api/v1/patient/consents?patient_id={pid}', headers=headers)
    assert consents.status_code == 200, consents.text
    assert any(r['purpose'] == 'basic_use' and r['effective_access'] for r in consents.json()['items'])
    from backend.app.core.config import settings
    from backend.tests.test_assessment_sessions import start
    monkeypatch.setattr(settings, 'APP_ENV', 'development')
    registry = client.get(f'/api/v1/care/assessment-templates?patient_id={pid}', headers=headers)
    assert registry.status_code == 200, registry.text
    template = registry.json()['items'][0]
    assert template['age_group'] == 'child' and template['can_create_self']
    created = client.post('/api/v1/care/patient/assessments', headers=headers, json={
        'patient_id': pid, 'template_id': template['id'], 'template_version': template['version'], 'background': {}})
    assert created.status_code == 201, created.text
    session = created.json()
    for item in session['items'][:2]:
        attempt = start(client, headers, item, pid)
        assert attempt.status_code == 201, attempt.text
        assert attempt.json()['actor_user_id'] == saved['user']['id']
        assert attempt.json()['performer_patient_id'] == (pid if item['kind'] == 'cognitive' else None)
    _, other = register(client, 'self-service-other@example.com')
    assert client.get(f'/api/v1/care/assessment-templates?patient_id={pid}', headers=other).status_code == 403
    assert not any(r['purpose'] in {'research', 'external_ai', 'clinical_sharing'} for r in consents.json()['items'])


def test_child_still_requires_adult_guardian_and_explicit_declaration(client):
    for i, changes in enumerate([{'age': 17}, {'confirmed': False}, {'relation': 'friend'}]):
        assert child_registration(client, 'self-service-invalid-' + str(i), **changes).status_code == 422


def legacy_pending(client):
    owner = client.post('/api/v1/auth/register', json={'email': 'legacy-guardian@example.com',
        'password': 'Synthetic#2026', 'full_name': 'Synthetic Guardian', 'role': 'patient',
        'consent_agreed': True, 'account_only': True}).json()
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import GuardianRelationship, PatientAccess
    from backend.app.models.patient import Patient, PatientType
    from backend.app.services import authorization_ledger as ledger
    from backend.app.services.consent_service import prepare_pending_basic
    with SessionLocal() as db:
        p = Patient(user_id=owner['user']['id'], display_name='Synthetic Child', age=10, patient_type=PatientType.CHILD)
        db.add(p); db.flush()
        g = GuardianRelationship(patient_id=p.id, guardian_user_id=owner['user']['id'], guardian_age=35,
            relation='parent', proof_reference='legacy-declaration', confirmed=True, status='pending')
        db.add(g); db.flush(); ledger.reserve(g)
        a = PatientAccess(patient_id=p.id, user_id=owner['user']['id'], access_kind='guardian',
            guardian_relationship_id=g.id, status='pending')
        db.add(a); db.flush(); ledger.reserve(a)
        prepare_pending_basic(db, p.id, owner['user']['id']); db.commit()
        return {'Authorization': 'Bearer ' + owner['access_token']}, g.id, p.id


def declaration(revision=1):
    return {'expected_revision': revision, 'confirmed': True, 'guardian_age': 35,
        'declaration_version': 'guardian-self-declaration-2026-10-19'}


def test_legacy_pending_requires_own_confirmation_and_no_institution(client):
    owner, gid, pid = legacy_pending(client)
    _, stranger = register(client, 'legacy-stranger@example.com')
    url = f'/api/v1/identity/guardians/{gid}/confirm-relationship'
    assert client.post(url, headers=stranger, json=declaration()).status_code == 403
    before = client.get('/api/v1/identity/context', headers=owner).json()
    assert before['accessible_patients'] == []
    saved = client.post(url, headers=owner, json=declaration())
    assert saved.status_code == 200, saved.text
    assert saved.json()['status'] == 'confirmed' and saved.json()['effective_access']
    assert client.get(f'/api/v1/care/assessment-templates?patient_id={pid}', headers=owner).status_code == 200
    assert client.post(url, headers=owner, json=declaration()).status_code == 409


def test_owner_can_pause_and_restore_without_restoring_withdrawn_purposes(client):
    saved = child_registration(client, 'owner-lifecycle', proof_reference='own declaration')
    assert saved.status_code == 201, saved.text
    owner = {'Authorization': 'Bearer ' + saved.json()['access_token']}
    ctx = client.get('/api/v1/identity/context', headers=owner).json()
    row = ctx['guardian_relationships'][0]; pid = row['patient_id']; base = f"/api/v1/identity/guardians/{row['id']}"
    paused = client.post(base + '/suspend', headers=owner, json={'expected_revision': row['revision'], 'review_reference': '本人暂停'})
    assert paused.status_code == 200, paused.text
    assert client.get('/api/v1/identity/context', headers=owner).json()['accessible_patients'] == []
    restored = client.post(base + '/restore', headers=owner, json={'expected_revision': paused.json()['revision'], 'review_reference': '本人恢复'})
    assert restored.status_code == 200, restored.text
    assert restored.json()['status'] == 'confirmed' and restored.json()['effective_access']
    records = client.get(f'/api/v1/patient/consents?patient_id={pid}', headers=owner).json()['items']
    assert not any(r['purpose'] == 'basic_use' and r['effective_access'] for r in records)


def test_transfer_needs_both_authenticated_accounts_and_does_not_inherit_consent(client):
    saved = child_registration(client, 'owner-transfer')
    assert saved.status_code == 201, saved.text
    owner = {'Authorization': 'Bearer ' + saved.json()['access_token']}
    row = client.get('/api/v1/identity/context', headers=owner).json()['guardian_relationships'][0]
    response = client.post('/api/v1/auth/register', json={'email': 'next-guardian@example.com',
        'password': 'Synthetic#2026', 'full_name': 'Synthetic Next Guardian', 'role': 'patient',
        'consent_agreed': True, 'account_only': True})
    assert response.status_code == 201, response.text
    successor = response.json(); incoming = {'Authorization': 'Bearer ' + successor['access_token']}
    url = f"/api/v1/identity/guardians/{row['id']}"
    body = {'expected_revision': row['revision'], 'review_reference': '双方确认',
        'new_guardian_user_id': successor['user']['id'], 'new_guardian_confirmed': True, 'proof_reference': '本人接任确认'}
    assert client.post(url + '/transfer', headers=owner, json=body).status_code == 403
    confirmed = client.post(url + '/confirm-transfer', headers=incoming,
        json={'expected_revision': row['revision'], 'proof_reference': '本人接任确认', 'terms_version': 'W02-1', 'age': 36})
    assert confirmed.status_code == 200, confirmed.text
    transferred = client.post(url + '/transfer', headers=owner, json=body)
    assert transferred.status_code == 200, transferred.text
    assert client.get('/api/v1/identity/context', headers=owner).json()['accessible_patients'] == []
    context = client.get('/api/v1/identity/context', headers=incoming).json()
    assert context['accessible_patients'][0]['patient_id'] == row['patient_id']
    assert context['guardian_relationships'][0]['status'] == 'confirmed'
    consents = client.get(f"/api/v1/patient/consents?patient_id={row['patient_id']}", headers=incoming).json()['items']
    assert not any(r['effective_access'] for r in consents)


def test_optional_independent_verification_does_not_remove_own_basic_use(client):
    from backend.tests.w02_helpers import qualify
    saved = child_registration(client, 'optional-independent-review')
    assert saved.status_code == 201, saved.text
    owner = {'Authorization': 'Bearer ' + saved.json()['access_token']}
    row = client.get('/api/v1/identity/context', headers=owner).json()['guardian_relationships'][0]
    reviewer, headers = register(client, 'optional-reviewer@example.com', 'researcher')
    qualify(reviewer['user']['id'], reviewer=True)
    result = client.post(f"/api/v1/identity/guardians/{row['id']}/review", headers=headers,
        json={'expected_revision': row['revision'], 'status': 'verified', 'review_reference': '独立核验', 'expires_at': '2090-01-01T00:00:00Z'})
    assert result.status_code == 200, result.text
    consents = client.get(f"/api/v1/patient/consents?patient_id={row['patient_id']}", headers=owner).json()['items']
    assert any(r['purpose'] == 'basic_use' and r['effective_access'] for r in consents)
