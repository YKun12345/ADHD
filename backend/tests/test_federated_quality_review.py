"""Narrow quality-review counterexamples; only synthetic identities/temp stores."""
import base64
from datetime import datetime, timezone

from backend.tests.w02_helpers import register, qualify
from backend.tests.test_federated_control_review import _project, _action


BASE = '/api/v1/federated'


def test_quality_unsubmitted_consent_cannot_borrow_reapproved_project(client):
    dac, headers = register(client, 'quality-consent-dac@example.com', 'researcher')
    qualify(dac['user']['id'], reviewer=True)
    patient, ph = register(client, 'quality-consent-patient@example.com')
    project, _ = _project(client, headers, 'quality-consent-project')
    approved = _action(client, headers, f"/projects/{project['id']}/approve", 'quality-consent-approve', project['revision'])
    assert approved.status_code == 200, approved.text
    project = approved.json()['result']
    # Freeze the exact project revision that was displayed before going offline.
    original = {'client_request_id': 'quality-delayed-original',
        'patient_id': patient['user']['patient_profile']['id'], 'project_id': project['id'],
        'purpose': 'research', 'scope': ['assessment'], 'terms_version': 'W02-1', 'expires_at': None,
        'expected_project_revision': project['revision']}
    context = client.get(BASE + f"/projects/{project['id']}/consent", headers=ph,
        params={'patient_id': original['patient_id']})
    assert context.status_code == 200, context.text
    reapproved = _action(client, headers, f"/projects/{project['id']}/approve", 'quality-consent-reapprove', project['revision'])
    assert reapproved.status_code == 200, reapproved.text
    assert reapproved.json()['result']['revision'] > project['revision']
    delayed = client.post(BASE + f"/projects/{project['id']}/consent", headers=ph, json=original)
    assert delayed.status_code == 409, delayed.text
    legacy = {key: value for key, value in original.items() if key != 'expected_project_revision'}
    assert client.post(BASE + f"/projects/{project['id']}/consent", headers=ph, json=legacy).status_code == 422
    unified = {key: value for key, value in original.items() if key != 'client_request_id'}
    assert client.post('/api/v1/patient/consents', headers=ph, json=unified).status_code == 409
    context = client.get(BASE + f"/projects/{project['id']}/consent", headers=ph,
        params={'patient_id': original['patient_id']})
    assert context.status_code == 200 and context.json()['items'] == [], context.text
    fresh = {**original, 'client_request_id': 'quality-fresh-original',
        'expected_project_revision': reapproved.json()['result']['revision']}
    accepted = client.post(BASE + f"/projects/{project['id']}/consent", headers=ph, json=fresh)
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()['original_request'] == fresh
    assert accepted.json()['result']['project_revision'] == fresh['expected_project_revision']


def test_quality_runtime_status_rechecks_original_node_approver(client):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    from sqlalchemy import select
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import InstitutionMembership
    from backend.app.services import authorization_ledger as ledger
    from backend.app.services.cognitive_contract import canonical_digest

    dac, headers = register(client, 'quality-node-dac@example.com', 'researcher')
    qualify(dac['user']['id'], reviewer=True)
    observer, oh = register(client, 'quality-node-observer@example.com', 'researcher')
    qualify(observer['user']['id'], reviewer=True)
    private = Ed25519PrivateKey.generate()
    pem = private.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
    enrolled = client.post(BASE + '/nodes/enrollment', headers=headers, json={
        'client_request_id': 'quality-node-enroll', 'institution_id': 'synthetic-institution',
        'name': '合成状态反例', 'public_key_pem': pem, 'compatibility': 'flower-1.23/secaggplus-v1'})
    assert enrolled.status_code == 201, enrolled.text
    node = enrolled.json()
    approved = _action(client, headers, f"/nodes/{node['id']}/approve", 'quality-node-approve', node['revision'])
    assert approved.status_code == 200, approved.text
    challenge = client.get(BASE + f"/node-channel/{node['id']}/challenge")
    assert challenge.status_code == 200, challenge.text
    challenge = challenge.json()
    body = {'client_request_id': 'quality-node-heartbeat', 'node_id': node['id'],
        'challenge': challenge['challenge'], 'sequence': challenge['next_sequence'],
        'observed_at': datetime.now(timezone.utc).isoformat(), 'compatibility': 'flower-1.23/secaggplus-v1'}
    body['signature'] = base64.b64encode(private.sign(canonical_digest(body).encode())).decode()
    saved = client.post(BASE + '/node-channel/heartbeat', json=body)
    assert saved.status_code == 200, saved.text
    # Independent original DAC withdrawal, solely inside this test's temp DB.
    with SessionLocal() as db:
        membership = db.scalar(select(InstitutionMembership).where(InstitutionMembership.user_id == dac['user']['id']))
        ledger.deny(membership)
        membership.status = 'revoked'
        db.commit()
    assert client.get(BASE + f"/node-channel/{node['id']}/challenge").status_code == 403
    # A historical signed ACK remains historical; it does not re-admit the node.
    assert client.post(BASE + '/node-channel/heartbeat', json=body).json() == saved.json()
    listing = client.get(BASE + '/projects', headers=oh)
    assert listing.status_code == 200, listing.text
    status = next(row for row in listing.json()['nodes'] if row['id'] == node['id'])
    assert status['identity_verified'] is False, status
    from backend.app.models.federated import FederatedAuditEvent, FederatedNodeRuntime
    with SessionLocal() as db:
        before = (len(db.scalars(select(FederatedAuditEvent)).all()),
            db.get(FederatedNodeRuntime, node['id']).version)

    def query(target, bad_signature=False):
        body = {'query_id': 'quality-read-only-query', 'node_id': node['id'],
            'target_client_request_id': target, 'requested_at': datetime.now(timezone.utc).isoformat()}
        signature = private.sign(b'wrong-domain' if bad_signature else canonical_digest(body).encode())
        body['signature'] = base64.b64encode(signature).decode()
        return client.post(BASE + '/node-channel/submissions/query', json=body)

    recovered = query('quality-node-heartbeat')
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()['operation_receipt'] == saved.json()
    assert query('quality-node-heartbeat', bad_signature=True).status_code == 403
    assert query('quality-node-never-committed').status_code == 404
    assert query('quality-node-enroll').status_code == 403
    with SessionLocal() as db:
        after = (len(db.scalars(select(FederatedAuditEvent)).all()),
            db.get(FederatedNodeRuntime, node['id']).version)
    assert after == before


def test_quality_heartbeat_cli_recovers_only_after_explicit_rejection_archive(tmp_path, monkeypatch, capsys):
    import importlib.util
    import json
    from pathlib import Path
    import sys
    from urllib.error import HTTPError, URLError
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption
    import pytest

    path = Path(__file__).resolve().parents[2] / 'tools' / 'federated-node-heartbeat.py'
    spec = importlib.util.spec_from_file_location('quality_heartbeat_cli', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    private = Ed25519PrivateKey.generate()
    (tmp_path / 'private.pem').write_bytes(private.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    (tmp_path / 'manifest.json').write_text(json.dumps({'mode': 'synthetic_research_only', 'synthetic': True,
        'node_id': 'quality-cli-node', 'private_key_file': 'private.pem'}), encoding='utf8')
    args = ['heartbeat', '--node-directory', str(tmp_path), '--api-base', 'http://127.0.0.1:8000/api/v1']
    calls = []
    mode = ['offline']

    def request(base, route, body=None):
        calls.append((route, body))
        if body is None:
            return {'node_id': 'quality-cli-node', 'protocol': 'ed25519-sha256-canonical-v1',
                'challenge': 'synthetic-challenge', 'next_sequence': 1}
        signed = {key: value for key, value in body.items() if key != 'signature'}
        import hashlib
        private.public_key().verify(base64.b64decode(body['signature'], validate=True),
            hashlib.sha256(module.canonical(signed)).hexdigest().encode())
        if route.endswith('/submissions/query'):
            raise HTTPError(base + route, 404, 'synthetic original not found', {}, None)
        if mode[0] == 'offline':
            raise URLError('synthetic offline before server receives original')
        if mode[0] == 'expired':
            raise HTTPError(base + route, 403, 'synthetic original challenge expired', {}, None)
        return {'id': 'a' * 32, 'actor_user_id': None, 'client_request_id': body['client_request_id'],
            'submission_status': 'committed', 'original_request': body,
            'result': {'node_id': body['node_id'], 'sequence': body['sequence'], 'identity_verified': True}}

    monkeypatch.setattr(module, 'request', request)
    monkeypatch.setattr(sys, 'argv', args)
    with pytest.raises(URLError):
        module.main()
    pending = tmp_path / 'heartbeat-original.json'
    frozen = pending.read_bytes()
    body = json.loads(frozen)['request']
    assert module.main() == 3
    assert pending.read_bytes() == frozen
    assert len([row for row in calls if row[0].endswith('/heartbeat')]) == 1
    monkeypatch.setattr(sys, 'argv', args + ['--archive-rejected-original'])
    with pytest.raises(ValueError, match='actual original write rejection'):
        module.main()
    assert pending.read_bytes() == frozen
    mode[0] = 'expired'
    monkeypatch.setattr(sys, 'argv', args + ['--retry-original'])
    with pytest.raises(HTTPError):
        module.main()
    assert json.loads(pending.read_text())['last_write_rejection'] == 403
    assert json.loads(pending.read_text())['request'] == body
    monkeypatch.setattr(sys, 'argv', args + ['--archive-rejected-original'])
    assert module.main() == 0
    archived = list((tmp_path / 'heartbeat-archives').glob('*.json'))
    assert len(archived) == 1 and json.loads(archived[0].read_text())['request'] == body
    assert not pending.exists()
    assert len([row for row in calls if row[1] is None]) == 1
    assert len([row for row in calls if row[0].endswith('/heartbeat')]) == 2
    # A separate explicit invocation creates a fresh original after archival.
    mode[0] = 'success'
    monkeypatch.setattr(sys, 'argv', args)
    assert module.main() == 0
    assert not pending.exists()
    assert len([row for row in calls if row[1] is None]) == 2
    capsys.readouterr()
