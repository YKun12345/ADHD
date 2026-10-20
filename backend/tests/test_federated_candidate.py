"""Synthetic-only F05 numeric and publication boundaries."""
import hashlib
import io
import json
import os
import subprocess
from pathlib import Path
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest


def test_numeric_classifier_requires_exact_safe_float32_arrays(tmp_path):
    from federated_runtime.candidate_pack import CandidateRejected, load_aggregate
    path = tmp_path / 'arrays.npz'
    values = {'linear1.weight': np.zeros((256, 90), np.float32),
              'linear1.bias': np.zeros(256, np.float32),
              'linear2.weight': np.zeros((2, 256), np.float32),
              'linear2.bias': np.zeros(2, np.float32)}
    np.savez(path, **values)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert len(load_aggregate(path, digest, 90)[0]) == 4
    with pytest.raises(CandidateRejected, match='SHA-256'):
        load_aggregate(path, '0' * 64, 90)
    values['linear2.bias'][0] = np.nan
    np.savez(path, **values)
    with pytest.raises(CandidateRejected, match='finite float32'):
        load_aggregate(path, hashlib.sha256(path.read_bytes()).hexdigest(), 90)
    values['linear2.bias'] = np.array([{'arbitrary': 1}], dtype=object)
    np.savez(path, **values)
    with pytest.raises(CandidateRejected, match='safe numeric'):
        load_aggregate(path, hashlib.sha256(path.read_bytes()).hexdigest(), 90)


def test_actual_old_hgst_given_state_pack_and_service_preview_without_training(client, tmp_path):
    """This checks serialization/inference only, not a federated round claim."""
    root = Path(__file__).resolve().parents[2]
    directory = tmp_path / 'fresh-given-state'
    result = subprocess.run([str(root / '.codex-tmp/python310-compat-f00/python.exe'), '-B',
                str(root / 'federated_runtime/tests/candidate_pack_smoke.py'), '--directory', str(directory),
                '--legacy-site-packages', str(root / '.venv-hgst/Lib/site-packages')],
                cwd=root, capture_output=True, text=True, timeout=90,
                env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
    assert result.returncode == 0, result.stderr
    summary = json.loads(result.stdout)
    assert summary['actual_federated_training_performed'] is False
    assert summary['encoder_exactly_preserved'] is True
    assert summary['given_classifier_exactly_preserved'] is True
    from backend.app.services.federated_candidate_service import _legacy
    roi = directory / 'synthetic-roi.npz'
    preview = _legacy({'operation': 'preview', 'candidate_path': str(directory / 'candidate.pt'),
                       'candidate_sha256': summary['candidate_sha256'], 'roi_path': str(roi),
                       'roi_sha256': hashlib.sha256(roi.read_bytes()).hexdigest()})
    assert len(preview['predictions']) == 2
    assert preview['artifact_sha256'] == summary['candidate_sha256']
    assert preview['clinical_activation_allowed'] is False


def test_candidate_api_never_grants_project_member_dac_rights(client):
    from backend.tests.w02_helpers import register
    _, headers = register(client, 'candidate-outsider@example.com', 'researcher')
    result = client.get('/api/v1/federated/projects/987654/models', headers=headers)
    assert result.status_code in {403, 404}
    result = client.post('/api/v1/federated/projects/987654/models/1/publish', headers=headers,
                         json={'client_request_id': 'outsider-publish', 'expected_revision': 1,
                               'confirmed': True, 'reason': 'synthetic negative'})
    assert result.status_code in {403, 404}


def test_worker_candidate_rejects_stale_or_absent_lease(client):
    from backend.app.db.session import SessionLocal
    from backend.app.services.federated_candidate_service import prepare_candidate
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        prepare_candidate(SessionLocal, 'absent-experiment', 'foreign-lease')
    assert error.value.status_code == 404


def _publication_fixture(client, monkeypatch, tmp_path):
    """RBAC fixture only: no claim that mocked rounds were actually trained."""
    from backend.tests.w02_helpers import register, qualify
    dac, dh = register(client, 'f05-dac@example.com', 'researcher')
    member, mh = register(client, 'f05-member@example.com', 'researcher')
    _, oh = register(client, 'f05-other@example.com', 'researcher')
    qualify(dac['user']['id'], reviewer=True)
    qualify(member['user']['id'])
    expiry = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    root = '/api/v1/federated'
    created = client.post(root + '/projects', headers=dh, json={
        'client_request_id': 'f05-project', 'institution_id': 'synthetic-institution', 'name': 'F05 mock RBAC fixture',
        'purpose': 'synthetic unit authorization fixture; not actual training', 'mode': 'synthetic',
        'data_contract': 'synthetic-only', 'expires_at': expiry})
    assert created.status_code == 201, created.text
    pid = created.json()['id']
    approved = client.post(root + f'/projects/{pid}/approve', headers=dh, json={
        'client_request_id': 'f05-approve', 'expected_revision': created.json()['revision'],
        'confirmed': True, 'reason': 'synthetic authorization fixture'})
    assert approved.status_code == 200, approved.text
    grant = client.post(root + f'/projects/{pid}/members', headers=dh, json={
        'client_request_id': 'f05-member', 'expected_revision': approved.json()['result']['revision'],
        'confirmed': True, 'reason': 'synthetic member', 'user_id': member['user']['id'],
        'permissions': ['view', 'experiment'], 'expires_at': expiry})
    assert grant.status_code == 200, grant.text
    from backend.app.core.config import settings
    artifact_root = tmp_path / 'f05-artifacts'
    artifact_root.mkdir()
    artifact = artifact_root / 'mock-rbac-only.pt'
    artifact.write_bytes(b'unit-RBAC-fixture-never-deserialized')
    monkeypatch.setattr(settings, 'MODEL_REGISTRY_ARTIFACT_ROOT', str(artifact_root))
    metadata = {'schema': 'federated-candidate/v1', 'synthetic': True, 'encoder_origin': 'unit_mock_no_training',
                'encoder_provenance_verified': False, 'encoder_dp_protected': False, 'secure_rng': False,
                'privacy': {'unit_mock': True}, 'validation': {'unit_mock': True}, 'completed_rounds': 0,
                'mode': 'dp_secagg', 'r03_equivalence_verified': False, 'protection_scope': 'classifier_only',
                'experiment_id': 'f05-unit-experiment', 'configuration_digest': None}
    registered = client.post('/api/v1/model/registry/candidates', headers=dh, json={
        'version': 'f05-unit-candidate', 'artifact_file': artifact.name,
        'artifact_sha256': hashlib.sha256(artifact.read_bytes()).hexdigest(), 'input_contract_digest': 'a' * 64,
        'purpose': 'research_only', 'code_source': 'mock unit fixture', 'weight_source': 'mock unit fixture',
        'training_data_source': 'none; no training', 'training_metadata': metadata})
    assert registered.status_code == 201, registered.text
    mid = registered.json()['id']
    from backend.app.models.federated_experiment import FederatedExperiment, FederatedModelVersion
    from backend.app.models.user import User
    from backend.app.services import federated_control_service as control
    from backend.app.services import federated_experiment_service as experiments
    from backend.app.services import federated_candidate_service as candidates
    from backend.app.db.session import SessionLocal
    from backend.app.services.cognitive_contract import canonical_digest
    with SessionLocal() as db:
        user = db.get(User, dac['user']['id'])
        experiment = FederatedExperiment(id='f05-unit-experiment', project_id=pid, actor_user_id=member['user']['id'],
            status='completed', institution_id='synthetic-institution', version=1, active_slot=None,
            lease_owner=None, lease_expires_at=None, sealed_payload='')
        configuration = {'unit_mock_no_training': True}
        values = {'configuration': configuration, 'configuration_digest': canonical_digest(configuration),
                  'candidate_model_version_id': mid}
        experiments._put(experiment, values, advance=False)
        db.add(experiment)
        head, state, _ = control._head(db, experiment.institution_id, lock=True)
        control._append(db, user, head, state, experiment, 'unit_mock_experiment', experiment.id,
                        {'client_request_id': 'f05-unit-experiment'}, {}, pid)
        bound = FederatedModelVersion(id=mid, project_id=pid, experiment_id=experiment.id,
                    institution_id=experiment.institution_id, version=1, sealed_payload='')
        bound.put({'project_id': pid, 'experiment_id': experiment.id, 'model_version_id': mid,
                   'artifact_sha256': registered.json()['artifact_sha256']})
        db.add(bound)
        head, state, _ = control._head(db, experiment.institution_id, lock=True)
        control._append(db, user, head, state, bound, 'unit_mock_candidate', str(mid),
                        {'client_request_id': 'f05-unit-candidate'}, {}, pid)
    monkeypatch.setattr(candidates, '_sources', lambda *args, **kwargs: (None, {}))
    monkeypatch.setattr(candidates, '_committed', lambda *args, **kwargs: ([], [], {}))
    return pid, mid, dh, mh, oh, registered.json()


def test_explicit_dac_publish_and_member_preview_do_not_activate_clinical_pointer(client, monkeypatch, tmp_path):
    pid, mid, dh, mh, oh, version = _publication_fixture(client, monkeypatch, tmp_path)
    root = f'/api/v1/federated/projects/{pid}/models'
    listed = client.get(root, headers=mh)
    assert listed.status_code == 200, listed.text
    assert listed.json()['items'][0]['revision'] == 1
    assert listed.json()['items'][0]['published'] is False
    request = {'client_request_id': 'f05-publish', 'expected_revision': 1, 'confirmed': True, 'reason': 'unit mock publication'}
    assert client.post(root + f'/{mid}/publish', headers=mh, json=request).status_code == 403
    assert client.get(root, headers=oh).status_code == 403
    before = client.post(root + f'/{mid}/preview', headers=mh,
                         files={'file': ('synthetic.npz', b'not-loaded')}, data={'confirmed_synthetic': 'true'})
    assert before.status_code == 409, before.text
    published = client.post(root + f'/{mid}/publish', headers=dh, json=request)
    assert published.status_code == 200, published.text
    assert published.json()['result']['published'] is True
    assert client.post(root + f'/{mid}/publish', headers=dh, json=request).json() == published.json()
    original = client.get('/api/v1/federated/submissions/f05-publish', headers=dh)
    assert original.json()['original_request'] == request
    from backend.app.services import federated_candidate_service as candidates
    calls = []
    def mock_inference(request):
        calls.append(request)
        return {'artifact_sha256': request['candidate_sha256'], 'input_sha256': request['roi_sha256'],
                'predictions': [], 'synthetic': True, 'research_only': True, 'clinical_activation_allowed': False}
    monkeypatch.setattr(candidates, '_legacy', mock_inference)
    inferred = client.post(root + f'/{mid}/preview', headers=mh,
                           files={'file': ('synthetic.npz', b'unit-mock-not-real-inference')},
                           data={'confirmed_synthetic': 'true'})
    assert inferred.status_code == 200, inferred.text
    assert inferred.json()['model_version_id'] == mid
    assert len(calls) == 1
    refused = client.post('/api/v1/model/registry/actions', headers=dh, json={
        'client_action_id': 'f05-cannot-activate', 'version_id': mid, 'action': 'activate',
        'expected_registry_revision': 1, 'reason': 'negative synthetic activation', 'confirmed': True, 'evidence': {}})
    assert refused.status_code == 409, refused.text
    pointer = client.get('/api/v1/model/registry', headers=dh).json()['pointer']
    assert pointer['active_version_id'] is None
    from fastapi import HTTPException
    def source_revoked(*args, **kwargs):
        raise HTTPException(403, 'unit-original-admission-revoked')
    monkeypatch.setattr(candidates, '_sources', source_revoked)
    after = client.post(root + f'/{mid}/preview', headers=mh,
                        files={'file': ('synthetic.npz', b'not-loaded')}, data={'confirmed_synthetic': 'true'})
    assert after.status_code == 403
    assert len(calls) == 1


def test_candidate_worker_rejects_finished_experiment_even_if_lease_name_matches(client, monkeypatch, tmp_path):
    pid, mid, dh, mh, oh, _ = _publication_fixture(client, monkeypatch, tmp_path)
    from backend.app.services.federated_candidate_service import prepare_candidate
    from backend.app.db.session import SessionLocal
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        prepare_candidate(SessionLocal, 'f05-unit-experiment', 'foreign-lease')
    assert error.value.status_code == 409


def _mock_preparer_fixture(client, monkeypatch, tmp_path):
    """Mock only already-completed training and package result for DB checks."""
    pid, base_id, dh, mh, oh, base = _publication_fixture(client, monkeypatch, tmp_path)
    from backend.app.db.session import SessionLocal
    from backend.app.models.federated_experiment import FederatedExperiment
    from backend.app.models.user import User
    from backend.app.services import federated_control_service as control
    from backend.app.services import federated_experiment_service as experiments
    from backend.app.services import federated_candidate_service as candidates
    from backend.app.services.cognitive_contract import canonical_digest
    with SessionLocal() as db:
        original = db.get(FederatedExperiment, 'f05-unit-experiment')
        actor_id = original.actor_user_id
        row = FederatedExperiment(id='f05-prepare-unit', project_id=pid, actor_user_id=actor_id,
                institution_id='synthetic-institution', status='validating', version=1, active_slot=1,
                lease_owner='f05-unit-owner', lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=3),
                sealed_payload='')
        configuration = {'rounds': 1, 'mode': 'dp_secagg', 'unit_mock_no_training': True}
        values = {'configuration': configuration, 'configuration_digest': canonical_digest(configuration),
                  'candidate_model_version_id': None, 'source_credentials': [], 'sources': {}}
        experiments._put(row, values, advance=False)
        db.add(row)
        head, state, _ = control._head(db, row.institution_id, lock=True)
        control._append(db, db.get(User, actor_id), head, state, row, 'unit_mock_validating', row.id,
                        {'client_request_id': 'f05-unit-validating'}, {}, pid)
    sources = {'nodes': [{'encoder_origin': 'unit_mock_no_training', 'encoder_parameters_sha256': 'e' * 64}],
               'base_version_id': base_id, 'base_sha256': base['artifact_sha256'], 'base_path': 'unit-mock-no-load',
               'base_review_id': None, 'input_contract_digest': 'a' * 64}
    monkeypatch.setattr(candidates, '_sources', lambda db, *args, **kwargs: (db.get(User, actor_id), sources))
    aggregates = [{'path': 'unit-mocked-numeric-only', 'sha256': 'b' * 64, 'parameters_sha256': 'c' * 64}]
    rounds = [{'round': 1, 'mock_not_actual_training': True}]
    monkeypatch.setattr(candidates, '_committed', lambda *args, **kwargs: (aggregates, rounds, {'unit_mock': True}))
    calls = []
    def mock_pack(request):
        calls.append(request)
        path = Path(request['output_path'])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'unit-mock-package-for-db-boundary-no-training-or-inference')
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        return {'artifact_sha256': sha, 'aggregate_parameters_sha256': 'c' * 64,
                'round_parameter_digests': ['c' * 64], 'encoder_parameters_sha256': 'e' * 64,
                'input_contract_digest': 'a' * 64, 'encoder_origin': 'unit_mock_no_training',
                'validation': {'artifact_sha256': sha, 'status': 'synthetic_load_and_inference_passed',
                               'unit_mock_not_actual_inference': True}}
    monkeypatch.setattr(candidates, '_legacy', mock_pack)
    return pid, base_id, dh, mh, calls, mock_pack


def test_mocked_candidate_registration_is_idempotent_and_never_finishes_worker_state(client, monkeypatch, tmp_path):
    pid, base_id, dh, mh, calls, _ = _mock_preparer_fixture(client, monkeypatch, tmp_path)
    from backend.app.db.session import SessionLocal
    from backend.app.services.federated_candidate_service import prepare_candidate
    from backend.app.services import federated_experiment_service as experiments
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        prepare_candidate(SessionLocal, 'f05-prepare-unit', 'wrong-owner')
    assert error.value.status_code == 409
    assert calls == []
    result = prepare_candidate(SessionLocal, 'f05-prepare-unit', 'f05-unit-owner')
    assert result['model_version_id'] != base_id
    assert prepare_candidate(SessionLocal, 'f05-prepare-unit', 'f05-unit-owner') == result
    assert len(calls) == 1
    with SessionLocal() as db:
        row, body = experiments._load(db, 'f05-prepare-unit')
        assert row.status == 'validating'
        assert row.lease_owner == 'f05-unit-owner'
        assert body['candidate_model_version_id'] is None
    assert client.get('/api/v1/model/registry', headers=dh).json()['pointer']['active_version_id'] is None


def test_stop_during_mock_pack_refuses_registration_after_isolated_return(client, monkeypatch, tmp_path):
    pid, base_id, dh, mh, calls, mock_pack = _mock_preparer_fixture(client, monkeypatch, tmp_path)
    from backend.app.db.session import SessionLocal
    from backend.app.services import federated_candidate_service as candidates
    from backend.app.models.federated_experiment import FederatedModelVersion
    from sqlalchemy import select
    from fastapi import HTTPException
    def stop_while_packaging(request):
        packed = mock_pack(request)
        stopped = client.post('/api/v1/federated/experiments/f05-prepare-unit/stop', headers=mh, json={
            'client_request_id': 'f05-stop-during-pack', 'expected_revision': 1, 'confirmed': True,
            'reason': 'stop must win before registration'})
        assert stopped.status_code == 200, stopped.text
        assert stopped.json()['result']['status'] == 'stopping'
        return packed
    monkeypatch.setattr(candidates, '_legacy', stop_while_packaging)
    with pytest.raises(HTTPException) as error:
        candidates.prepare_candidate(SessionLocal, 'f05-prepare-unit', 'f05-unit-owner')
    assert error.value.status_code == 409
    with SessionLocal() as db:
        assert db.scalar(select(FederatedModelVersion).where(FederatedModelVersion.experiment_id == 'f05-prepare-unit')) is None


def test_committed_contract_refuses_missing_budget_changed_arrays_and_excess_epsilon(client, monkeypatch, tmp_path):
    """Numeric/receipt rules with a mocked authenticated witness, no training."""
    from types import SimpleNamespace
    from fastapi import HTTPException
    from backend.app.models.federated_experiment import FederatedRound
    from backend.app.services import federated_candidate_service as candidates
    from federated_runtime.candidate_pack import load_aggregate
    from federated_runtime.hgst_features import CLASSIFIER_NAMES, canonical_json
    path = tmp_path / 'given-committed-arrays.npz'
    np.savez(path, **dict(zip(CLASSIFIER_NAMES, [np.zeros(shape, np.float32) for shape in
             ((256, 90), (256,), (2, 256), (2,))])))
    array_bytes = path.read_bytes()
    sha = hashlib.sha256(array_bytes).hexdigest()
    _, parameters_sha = load_aggregate(path, sha, 90)
    receipt_path = tmp_path / 'unit-receipt.json'
    receipt = {'schema': 'federated-round-receipt/v1', 'experiment_id': 'unit', 'round': 1,
               'attempt': 'unit-attempt', 'status': 'completed', 'applied': True, 'mode': 'dp_secagg',
               'synthetic_only': True, 'dp_enabled': True, 'secagg_enabled': True,
               'candidate_sha256': 'a' * 64, 'aggregate_sha256': sha,
               'aggregate_parameters_sha256': parameters_sha, 'base_parameters_sha256': 'b' * 64,
               'initialization': 'fresh_public_seed_1729_original_mlp', 'classifier_input_dim': 90,
               'parameter_names': list(CLASSIFIER_NAMES)}
    receipt_path.write_bytes(canonical_json(receipt))
    payload = {'experiment_id': 'unit', 'round_number': 1, 'attempt': 'unit-attempt',
               'status': 'aggregate_committed', 'receipt_path': str(receipt_path),
               'receipt_sha256': hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
               'aggregate_path': str(path), 'aggregate_sha256': sha,
               'aggregate_parameters_sha256': parameters_sha, 'base_parameters_sha256': 'b' * 64,
               'runtime_manifest': {'experiment_id': 'unit', 'round': 1, 'attempt': 'unit-attempt',
                                    'candidate_sha256': 'a' * 64, 'synthetic_only': True, 'mode': 'dp_secagg'}}
    round_row = SimpleNamespace(round_number=1, attempt='unit-attempt', payload=payload)
    nodes = [{'node_id': f'node-{n}', 'institution_id': f'institution-{n}',
              'protection_namespace': f'scope-{n}', 'feature_dimension': 90} for n in range(3)]
    values = {'configuration': {'rounds': 1, 'mode': 'dp_secagg'}, 'completed_rounds': 1,
              'sources': {'base_sha256': 'a' * 64, 'nodes': nodes},
              'last_committed_parameters': {'path': str(path), 'sha256': sha,
                                           'parameters_sha256': parameters_sha, 'round': 1}}
    ledgers = []
    class MockWitnessDB:
        def scalars(self, statement):
            entity = statement.column_descriptions[0]['entity']
            return SimpleNamespace(all=lambda: [round_row] if entity is FederatedRound else ledgers)
    db = MockWitnessDB()
    monkeypatch.setattr(candidates.control, '_object', lambda db, row: row.payload)
    monkeypatch.setattr(candidates.experiments, '_histories', lambda db: [])
    monkeypatch.setattr(candidates.experiments, 'account', lambda histories: {'accountant': 'rdp', 'epsilon': 1.})
    experiment = SimpleNamespace(id='unit')
    with pytest.raises(HTTPException) as missing:
        candidates._committed(db, experiment, values)
    assert missing.value.status_code == 409
    for node in nodes:
        reservation = {'identity': f"unit:1:unit-attempt:{node['node_id']}", 'experiment_id': 'unit',
                       'node_id': node['node_id'], 'round': 1, 'attempt': 'unit-attempt',
                       'status': 'spent_or_partly_spent', 'noise_multiplier': 2., 'sample_rate': .125,
                       'planned_steps': 2, 'actual_history': [[2., .125, 2]]}
        ledgers.append(SimpleNamespace(institution_id=node['institution_id'], protection_namespace=node['protection_namespace'],
            payload={'protection_namespace': node['protection_namespace'], 'reservations': [reservation],
                     'node_anchors': {node['node_id']: {'signed_events': ['mock-already-authenticated-witness']}}}))
    assert len(candidates._committed(db, experiment, values)[0]) == 1
    ledgers[0].payload['reservations'][0]['actual_history'] = [[2., .125, 1]]
    with pytest.raises(HTTPException):
        candidates._committed(db, experiment, values)
    ledgers[0].payload['reservations'][0]['actual_history'] = [[2., .125, 2]]
    path.write_bytes(array_bytes + b'changed-after-commit')
    with pytest.raises(HTTPException):
        candidates._committed(db, experiment, values)
    path.write_bytes(array_bytes)
    monkeypatch.setattr(candidates.experiments, 'account', lambda histories: {'accountant': 'rdp', 'epsilon': 11.})
    with pytest.raises(HTTPException):
        candidates._committed(db, experiment, values)
    # Explicit control mode may reuse numeric validation, never protection flags
    # or a made-up privacy spend. The old DP history remains independent.
    values['configuration']['mode'] = 'synthetic_plaintext'
    payload['runtime_manifest']['mode'] = 'synthetic_plaintext'
    receipt.update(mode='synthetic_plaintext', dp_enabled=False, secagg_enabled=False)
    receipt_path.write_bytes(canonical_json(receipt))
    payload['receipt_sha256'] = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
    ledgers.clear()
    control_privacy = candidates._committed(db, experiment, values)[2]
    assert control_privacy['protection_applied'] is False
    assert control_privacy['reservation_count'] == 0
    receipt['dp_enabled'] = True
    receipt_path.write_bytes(canonical_json(receipt))
    payload['receipt_sha256'] = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
    with pytest.raises(HTTPException):
        candidates._committed(db, experiment, values)
