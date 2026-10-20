"""Control-plane tests with an injected runtime, never evidence of actual training.

Implementation sequence: durable CAS claim and stale-attempt recovery; reserve
before invoking the isolated runtime; fresh gates and signed budget observation;
validate and commit four numeric arrays; candidate-only completion; lifecycle.
Failure cases retain the previous aggregate and all conservative reservations.
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from backend.tests.w02_helpers import register, qualify


@pytest.fixture
def queued_experiment(client, monkeypatch, tmp_path):
    from backend.app.core.config import settings
    from backend.app.db.session import SessionLocal
    from backend.app.models.federated_experiment import FederatedExperiment
    from backend.app.services import federated_control_service as control
    from backend.app.services import federated_experiment_service as experiments
    actor, headers = register(client, 'worker-dac@example.com', 'researcher')
    qualify(actor['user']['id'], reviewer=True)
    created = client.post('/api/v1/federated/projects', headers=headers, json={
        'client_request_id': 'worker-project', 'institution_id': 'synthetic-institution',
        'name': 'Worker control test', 'purpose': 'Injected runtime only',
        'mode': 'synthetic', 'data_contract': 'synthetic-roi-v1',
        'expires_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()})
    assert created.status_code == 201, created.text
    project = created.json()
    identifier = uuid4().hex
    nodes = [{'node_id': f'injected-{i}', 'institution_id': 'synthetic-institution',
              'protection_namespace': f'injected-scope-{i}', 'index': i,
              'directory': str(tmp_path / f'node-{i}'), 'public_key_pem': 'injected',
              'feature_dimension': 90, 'classifier_parameters': [
                  {'name': name, 'shape': shape, 'dtype': 'float32'} for name, shape in
                  zip(('linear1.weight','linear1.bias','linear2.weight','linear2.bias'),
                      ([256,90],[256],[2,256],[2]))]} for i in (1,2,3)]
    sources = {'nodes': nodes, 'base_path': str(tmp_path / 'base.pt'),
               'base_sha256': 'a'*64, 'credentials': []}
    with SessionLocal() as db:
        head, state, _ = control._head(db, 'synthetic-institution', lock=True)
        row = FederatedExperiment(id=identifier, project_id=project['id'],
            institution_id='synthetic-institution', actor_user_id=actor['user']['id'],
            status='queued', version=1, active_slot=1, lease_owner=None,
            lease_expires_at=None, sealed_payload='')
        config = {'base_model_version_id': 1, 'node_ids': [n['node_id'] for n in nodes],
                  'rounds': 2, 'mode': 'dp_secagg', 'privacy': dict(experiments.PRESET),
                  'consent_record_ids': []}
        values = {'configuration': config, 'configuration_digest': experiments.canonical_digest(config),
            'sources': sources, 'source_credentials': [], 'completed_rounds': 0,
            'last_committed_parameters': None, 'candidate_model_version_id': None,
            'last_error': None, 'preflight': {'status':'passed'}}
        experiments._put(row, values, advance=False)
        db.add(row)
        control._append(db, SimpleNamespace(id=actor['user']['id']), head, state, row,
            'experiment_start', identifier, {'client_request_id':'injected-start'},
            {'status':'queued'}, project['id'])
    monkeypatch.setattr(settings, 'FEDERATED_RUNTIME_ROOT', str(tmp_path/'runtime'))
    monkeypatch.setattr(experiments, 'worker_sources', lambda db, row, values: sources, raising=False)
    monkeypatch.setattr(experiments, 'account', lambda histories: {'epsilon':len(histories)*.01,'accountant':'rdp','delta':1e-5})
    return SimpleNamespace(id=identifier, factory=SessionLocal, sources=sources,
                           actor_id=actor['user']['id'], headers=headers, client=client)


def test_queued_experiment_has_a_durable_single_owner_and_expired_claim_resumes(queued_experiment):
    from importlib.util import find_spec
    assert find_spec('backend.app.workers.federated_worker') is not None, 'Queued experiments have no consumer'
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    first = worker.FederatedWorkerRuntime(queued_experiment.factory, owner='worker-one')
    other = worker.FederatedWorkerRuntime(queued_experiment.factory, owner='worker-two')
    assert first.claim_once() == queued_experiment.id
    assert other.claim_once() is None
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'running' and row.lease_owner == 'worker-one'
        assert row.active_slot == 1
    first._change(queued_experiment.id, 'test-expire',
                  lambda row, values: setattr(row, 'lease_expires_at', datetime.now(timezone.utc)-timedelta(seconds=1)),
                  require_lease=False)
    assert other.claim_once() == queued_experiment.id
    with pytest.raises(worker.LeaseLost):
        first._change(queued_experiment.id, 'stale-writer', lambda row, values: values.update(completed_rounds=5))


def test_runtime_failure_retains_all_central_reservations_and_never_completes(queued_experiment):
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    called = []
    def runtime(manifest, authorize, pulse):
        with queued_experiment.factory() as db:
            assert len(experiments._histories(db)) == 3
        called.append(manifest)
        raise TimeoutError('injected no-node-reply')
    instance = worker.FederatedWorkerRuntime(queued_experiment.factory, runtime=runtime)
    assert instance.run_once() is True
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'failed'
        assert row.active_slot is None and values['completed_rounds'] == 0
        assert values['last_committed_parameters'] is None
        assert len(experiments._histories(db)) == 3
    assert len(called) == 1 and called[0]['mode'] == 'dp_secagg'


def test_stop_during_injected_runtime_aborts_before_commit_and_keeps_budget(queued_experiment):
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    def runtime(manifest, authorize, pulse):
        current = queued_experiment.client.get('/api/v1/federated/experiments/'+queued_experiment.id,
                                              headers=queued_experiment.headers).json()
        response = queued_experiment.client.post('/api/v1/federated/experiments/'+queued_experiment.id+'/stop',
            headers=queued_experiment.headers, json={'client_request_id':'stop-active-worker',
                'expected_revision':current['revision'], 'confirmed':True,'reason':'Injected stop'})
        assert response.status_code == 200, response.text
        pulse()
        pytest.fail('A stop request must interrupt the active round')
    instance = worker.FederatedWorkerRuntime(queued_experiment.factory, runtime=runtime)
    instance.run_once()
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'cancelled' and values['completed_rounds'] == 0
        assert len(experiments._histories(db)) == 3


def _injected_numeric_receipt(manifest, authorize, pulse):
    """Four constant arrays only. No optimizer, gradients, DP or SecAgg is run."""
    import hashlib
    import json
    from pathlib import Path
    import numpy as np
    from backend.app.workers import federated_worker as worker
    directory = Path(manifest['output_directory'])
    directory.mkdir()
    arrays = {name:np.full(descriptor['shape'], manifest['round'], dtype=np.float32)
              for name,descriptor in zip(worker.NAMES,manifest['nodes'][0]['classifier_parameters'])}
    aggregate = directory/'aggregate-classifier.npz'
    np.savez(aggregate, **arrays)
    descriptions = [{'name':name, 'shape':list(arrays[name].shape), 'dtype':'float32',
                     'sha256':hashlib.sha256(arrays[name].tobytes()).hexdigest()} for name in worker.NAMES]
    receipt = {'schema':'federated-round-receipt/v1', 'experiment_id':manifest['experiment_id'],
        'round':manifest['round'], 'attempt':manifest['attempt'], 'mode':'dp_secagg',
        'synthetic_only':True, 'applied':True, 'status':'completed', 'dp_enabled':True,
        'secagg_enabled':True, 'candidate_sha256':manifest['candidate_sha256'],
        'base_parameters_sha256':manifest.get('base_parameters_sha256','b'*64),
        'aggregate_path':str(aggregate), 'aggregate_sha256':hashlib.sha256(aggregate.read_bytes()).hexdigest(),
        'aggregate_parameters_sha256':hashlib.sha256(worker._canonical(descriptions)).hexdigest(),
        'receipt_path':str(directory/'receipt.json'),
        'node_receipts':[{'node_id':node['node_id'],'pid':100+node['index'],'privacy':{'injected':True}}
                         for node in manifest['nodes']], 'protocol_phases':[[{}, {}, {}] for _ in range(4)]}
    (directory/'receipt.json').write_text(json.dumps(receipt), encoding='utf8')
    return receipt


def test_two_numeric_rounds_commit_atomically_and_only_candidate_can_complete(queued_experiment, monkeypatch):
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    observations = []
    candidates = []
    def prepare(factory, identifier, owner):
        with factory() as db:
            row, values = experiments._load(db, identifier)
            assert row.status == 'validating' and row.lease_owner == owner
            assert values['completed_rounds'] == 2
        candidates.append(identifier)
        return {'model_version_id':123}
    instance = worker.FederatedWorkerRuntime(queued_experiment.factory, runtime=_injected_numeric_receipt,
                                             candidate_preparer=prepare)
    monkeypatch.setattr(instance, '_observe', lambda node,privacy:observations.append(node['node_id']))
    assert instance.run_once() is True
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'completed' and row.active_slot is None
        assert values['completed_rounds'] == 2 and values['candidate_model_version_id'] == 123
        result = experiments.rounds(db, SimpleNamespace(id=queued_experiment.actor_id), row.id)
        assert [item['status'] for item in result['items']] == ['aggregate_committed']*2
        assert result['items'][1]['base_parameters_sha256'] == result['items'][0]['aggregate_parameters_sha256']
        assert len(experiments._histories(db)) == 6
    assert len(observations) == 6 and candidates == [queued_experiment.id]
    assert instance.run_once() is False


def test_candidate_failure_retains_both_committed_rounds_and_budget(queued_experiment, monkeypatch):
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    def reject(*args):
        raise ValueError('Injected compatibility failure')
    instance = worker.FederatedWorkerRuntime(queued_experiment.factory, runtime=_injected_numeric_receipt,
                                             candidate_preparer=reject)
    monkeypatch.setattr(instance, '_observe', lambda node,privacy:None)
    instance.run_once()
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'failed' and values['completed_rounds'] == 2
        assert values['last_committed_parameters']['round'] == 2
        assert values['candidate_model_version_id'] is None
        assert len(experiments._histories(db)) == 6


def test_service_shutdown_keeps_resumable_round_and_never_refunds(queued_experiment, monkeypatch):
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    instance = None
    def shutdown(manifest, authorize, pulse):
        instance._stop.set()
        pulse()
    instance = worker.FederatedWorkerRuntime(queued_experiment.factory, runtime=shutdown)
    instance.run_once()
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'running' and row.active_slot == 1
        assert worker.control._utc(row.lease_expires_at) < worker._now()
        assert len(experiments._histories(db)) == 3
    successor = worker.FederatedWorkerRuntime(queued_experiment.factory, owner='successor')
    assert successor.claim_once() == queued_experiment.id
    with queued_experiment.factory() as db:
        rounds = experiments.rounds(db, SimpleNamespace(id=queued_experiment.actor_id), queued_experiment.id)['items']
        assert len(rounds) == 1 and rounds[0]['status'] == 'aborted'
        assert len(experiments._histories(db)) == 3


def test_revoked_source_at_final_commit_rejects_inflight_numeric_aggregate(queued_experiment, monkeypatch):
    from fastapi import HTTPException
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    def runtime(manifest, authorize, pulse):
        receipt = _injected_numeric_receipt(manifest, authorize, pulse)
        def revoked(*args):
            raise HTTPException(403, 'Injected original grant withdrawn')
        monkeypatch.setattr(experiments, 'worker_sources', revoked)
        return receipt
    instance = worker.FederatedWorkerRuntime(queued_experiment.factory, runtime=runtime)
    monkeypatch.setattr(instance, '_observe', lambda node,privacy:None)
    instance.run_once()
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'failed' and values['completed_rounds'] == 0
        assert values['last_committed_parameters'] is None
        assert len(experiments._histories(db)) == 3


def test_signed_gate_binds_attempt_and_rejects_replay_before_publication(queued_experiment, monkeypatch):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    from backend.app.core.record_envelope import RecordIntegrityError
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    instance = worker.FederatedWorkerRuntime(queued_experiment.factory)
    assert instance.claim_once() == queued_experiment.id
    private = Ed25519PrivateKey.generate()
    node = queued_experiment.sources['nodes'][0]
    node['public_key_pem'] = private.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
    round_id, manifest, sources, _ = instance._new_round(queued_experiment.id)
    monkeypatch.setattr(instance, '_observe', lambda node,privacy:None)
    event = {'schema':'federated-node-reply/v1', 'node_id':node['node_id'], 'institution_id':node['institution_id'], 'index':1,
        'kind':'gate_request', 'action':'node_start', 'seq':1, 'experiment_id':queued_experiment.id,
        'round':1, 'attempt':manifest['attempt'], 'base_parameters_sha256':'b'*64, 'privacy':{}}
    signed = {**event, 'signature_hex':private.sign(worker._canonical(event)).hex()}
    assert instance._gate(queued_experiment.id, manifest, sources, signed) is True
    with pytest.raises(RecordIntegrityError, match='replayed'):
        instance._gate(queued_experiment.id, manifest, sources, signed)
    other_attempt = {**event, 'seq':2, 'attempt':str(uuid4())}
    with pytest.raises(RecordIntegrityError, match='another attempt'):
        instance._gate(queued_experiment.id, manifest, sources,
                       {**other_attempt,'signature_hex':private.sign(worker._canonical(other_attempt)).hex()})
    with queued_experiment.factory() as db:
        result = experiments.rounds(db, SimpleNamespace(id=queued_experiment.actor_id), queued_experiment.id)['items']
        assert result[0]['status'] == 'roster_locked' and result[0]['gate_sequences'][node['node_id']] == 1
        assert experiments._load(db, queued_experiment.id)[1]['completed_rounds'] == 0


def test_restart_resumes_only_after_last_committed_round_and_keeps_aborted_cost(queued_experiment, monkeypatch):
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    calls = []
    first = None
    def interrupted(manifest, authorize, pulse):
        calls.append((manifest['round'], manifest['attempt']))
        if manifest['round'] == 2:
            first._stop.set()
            pulse()
        return _injected_numeric_receipt(manifest, authorize, pulse)
    first = worker.FederatedWorkerRuntime(queued_experiment.factory, runtime=interrupted)
    monkeypatch.setattr(first, '_observe', lambda node,privacy:None)
    first.run_once()
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'running' and values['completed_rounds'] == 1
        first_committed = dict(values['last_committed_parameters'])
        assert len(experiments._histories(db)) == 6
    def resumed(manifest, authorize, pulse):
        calls.append((manifest['round'], manifest['attempt']))
        assert manifest['round'] == 2
        assert manifest['base_parameters_path'] == first_committed['path']
        assert manifest['base_parameters_sha256'] == first_committed['parameters_sha256']
        return _injected_numeric_receipt(manifest, authorize, pulse)
    successor = worker.FederatedWorkerRuntime(queued_experiment.factory, runtime=resumed,
                                              candidate_preparer=lambda *args:{'model_version_id':456})
    monkeypatch.setattr(successor, '_observe', lambda node,privacy:None)
    successor.run_once()
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'completed' and values['completed_rounds'] == 2
        assert values['candidate_model_version_id'] == 456
        assert len(experiments._histories(db)) == 9
        rounds = experiments.rounds(db, SimpleNamespace(id=queued_experiment.actor_id), queued_experiment.id)['items']
        assert len([r for r in rounds if r['status'] == 'aggregate_committed']) == 2
        assert len([r for r in rounds if r['status'] == 'aborted']) == 1
    assert [number for number,attempt in calls] == [1,2,2]
    assert len({attempt for number,attempt in calls}) == 3


def test_budget_exhaustion_stops_before_any_runtime_and_keeps_prior_reservations(queued_experiment, monkeypatch):
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    monkeypatch.setattr(experiments, 'account', lambda histories:{'epsilon':len(histories)*4, 'accountant':'rdp'})
    instance = worker.FederatedWorkerRuntime(queued_experiment.factory,
        runtime=lambda *args:pytest.fail('Exhausted budget must never start computation'))
    instance.run_once()
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'budget_exhausted' and values['completed_rounds'] == 0
        assert row.active_slot is None and len(experiments._histories(db)) == 2


def _set_plaintext_control(queued_experiment):
    from backend.app.services import federated_control_service as control
    from backend.app.services import federated_experiment_service as experiments
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        head, state, _ = control._head(db, row.institution_id, lock=True)
        values['configuration']['mode'] = 'synthetic_plaintext'
        values['configuration_digest'] = experiments.canonical_digest(values['configuration'])
        experiments._put(row, values)
        control._append(db, SimpleNamespace(id=queued_experiment.actor_id), head, state, row,
            'unit_explicit_plaintext', row.id, {'client_request_id':'unit-explicit-plain'}, {}, row.project_id)


def _injected_plaintext_receipt(manifest, authorize, pulse):
    """Unprotected constant-array test fixture, never actual training."""
    import json
    from pathlib import Path
    assert manifest['mode'] == 'synthetic_plaintext'
    receipt = _injected_numeric_receipt(manifest, authorize, pulse)
    receipt.update(mode='synthetic_plaintext', dp_enabled=False, secagg_enabled=False,
                   protocol_phases=[[{}, {}, {}]])
    Path(receipt['receipt_path']).write_text(json.dumps(receipt), encoding='utf8')
    return receipt


def test_explicit_synthetic_plaintext_control_never_claims_or_reserves_dp(queued_experiment, monkeypatch):
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    _set_plaintext_control(queued_experiment)
    instance = worker.FederatedWorkerRuntime(queued_experiment.factory, runtime=_injected_plaintext_receipt,
        candidate_preparer=lambda *args:{'model_version_id':789})
    monkeypatch.setattr(instance, '_observe', lambda *args:pytest.fail('Plaintext must not fabricate DP spending'))
    instance.run_once()
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'completed' and values['completed_rounds'] == 2
        assert experiments._histories(db) == []
        assert values['configuration']['mode'] == 'synthetic_plaintext'


def test_protected_experiment_refuses_unprotected_numeric_receipt(queued_experiment, monkeypatch):
    from backend.app.workers import federated_worker as worker
    from backend.app.services import federated_experiment_service as experiments
    def substituted(manifest, authorize, pulse):
        return _injected_plaintext_receipt({**manifest, 'mode':'synthetic_plaintext'}, authorize, pulse)
    instance = worker.FederatedWorkerRuntime(queued_experiment.factory, runtime=substituted)
    monkeypatch.setattr(instance, '_observe', lambda *args:None)
    instance.run_once()
    with queued_experiment.factory() as db:
        row, values = experiments._load(db, queued_experiment.id)
        assert row.status == 'failed' and values['completed_rounds'] == 0
        assert len(experiments._histories(db)) == 3
