"""Disposable, three-institution research fixture, using the real control APIs.

Institution verification below is an explicit test-only trust root. Patient data,
the original model weights, and production settings are never opened.
"""
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from uuid import uuid4


def provision(client, runtime, root):
    from backend.app.core.config import settings
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import InstitutionMembership
    from backend.app.services import authorization_ledger as ledger
    from backend.tests.w02_helpers import register
    from federated_runtime.hgst_features import canonical_json, run_legacy_feature_extraction
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    assert settings.APP_ENV == 'test'
    assert Path(settings.MODEL_REGISTRY_ARTIFACT_ROOT).resolve().is_relative_to(runtime)
    base = '/api/v1/federated'
    actors = []
    for index in range(3):
        actor, headers = register(client, f'federated-dac-{index}@example.com', 'researcher')
        institution = f'synthetic-federated-{index}'
        with SessionLocal() as db:
            member = InstitutionMembership(user_id=actor['user']['id'], institution_id=institution,
                role='reviewer', status='verified', verification_reference='synthetic-test-only-institution-root')
            db.add(member); db.flush(); ledger.reserve(member); db.commit(); ledger.publish(member)
        actors.append((actor, headers, institution))

    def post(path, headers, body, status=200):
        response = client.post(path, headers=headers, json=body)
        assert response.status_code == status, f'{path}: {response.status_code}: {response.text}'
        return response.json()

    def action(path, headers, revision, **extra):
        return post(base + path, headers, {'client_request_id': uuid4().hex,
            'expected_revision': revision, 'confirmed': True, 'reason': 'Disposable synthetic research integration', **extra})['result']

    owner, headers, institution = actors[0]
    project = post(base + '/projects', headers, {'client_request_id': uuid4().hex,
        'institution_id': institution, 'name': '三机构合成联邦研究',
        'purpose': '本机三独立节点DP与SecAgg+闭环，不使用真实患者资料', 'mode': 'synthetic',
        'data_contract': 'synthetic-roi-v1',
        'expires_at': (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()}, 201)
    project = action(f"/projects/{project['id']}/approve", headers, project['revision'])
    nodes = []
    candidate = None
    candidate_sha256 = None
    legacy_python = Path(settings.FEDERATED_HGST_PYTHON).resolve()
    legacy_site = root / '.venv-hgst/Lib/site-packages'
    node_root = Path(settings.FEDERATED_NODE_ROOT).resolve()
    node_root.mkdir(parents=True, exist_ok=True)
    for index, (_, node_headers, node_institution) in enumerate(actors):
        node_id = f'synthetic-institution-node-{index}'
        directory = node_root / node_id
        command = [str(legacy_python), '-B', str(root / 'tools/provision-federated-synthetic-node.py'),
            '--node-directory', str(directory), '--node-id', node_id,
            '--protection-namespace', f'synthetic-institution-{index}-patient-set',
            '--legacy-site-packages', str(legacy_site)]
        if candidate:
            command += ['--candidate', str(candidate), '--candidate-sha256', candidate_sha256]
        process = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=180,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        (runtime / f'provision-{index}.log').write_text(process.stderr, encoding='utf8')
        assert process.returncode == 0, f'Provision failed; see synthetic local provision-{index}.log'
        public = json.loads(process.stdout)
        if candidate is None:
            candidate = directory / 'synthetic-candidate.pt'
            candidate_sha256 = public['candidate_sha256']
        run_legacy_feature_extraction(directory, directory / 'manifest.json', candidate_path=candidate,
            candidate_sha256=candidate_sha256, legacy_python=legacy_python, legacy_site_packages=legacy_site)
        node = post(base + '/nodes/enrollment', node_headers, {'client_request_id': uuid4().hex,
            'node_id': node_id, 'institution_id': node_institution, 'name': f'合成独立机构节点 {index + 1}',
            'public_key_pem': public['public_key_pem'], 'compatibility': 'flower-1.23/secaggplus-v1'}, 201)
        node = action(f"/nodes/{node['id']}/approve", node_headers, node['revision'])
        link = action(f"/projects/{project['id']}/nodes", headers, project['revision'], node_id=node_id)
        if index:
            action(f"/projects/{project['id']}/nodes/{link['id']}/approve", node_headers, link['revision'])
        nodes.append({'id': node_id, 'directory': str(directory), 'public': public})

    registry = {'schema': 'federated-node-registry/v1',
        'nodes': {node['id']: {'directory': node['directory']} for node in nodes}}
    Path(settings.FEDERATED_NODE_REGISTRY_PATH).write_text(json.dumps(registry), encoding='utf8')
    artifact_root = Path(settings.MODEL_REGISTRY_ARTIFACT_ROOT)
    artifact_root.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(candidate, artifact_root / 'fresh-synthetic-base.pt')
    manifest = json.loads((Path(nodes[0]['directory']) / 'manifest.json').read_text(encoding='utf8'))
    contract_digest = hashlib.sha256(canonical_json(manifest['input_contract'])).hexdigest()
    version = post('/api/v1/model/registry/candidates', headers, {'family': 'hgst',
        'version': 'fresh-synthetic-federated-base-v1', 'artifact_file': 'fresh-synthetic-base.pt',
        'artifact_sha256': candidate_sha256, 'input_contract_digest': contract_digest, 'purpose': 'research_only',
        'code_source': 'Existing HGST runtime modeling.py, synthetic integration only',
        'weight_source': 'Fresh random initialization by provision-federated-synthetic-node.py; no patient training',
        'training_data_source': 'Generated normal-distribution synthetic ROI; no patient source',
        'training_metadata': {'synthetic': True, 'clinical_admission': False, 'encoder_origin': 'fresh_random_synthetic_untrained'}}, 201)
    # These checks concern ONLY the generated fixture above. This is not a
    # review or provenance assertion for the original clinical HGST checkpoint.
    evidence = {key: {'status': 'verified', 'reference': f'synthetic-fixture-only:{key}:{candidate_sha256}'}
        for key in ['code_license', 'weight_license', 'training_data_permission', 'intended_use', 'input_contract']}
    post('/api/v1/model/registry/actions', headers, {'client_action_id': uuid4().hex,
        'version_id': version['id'], 'action': 'review', 'expected_registry_revision': 1,
        'reason': 'Only generated random synthetic base; no original model admission', 'evidence': evidence, 'confirmed': True}, 201)

    def heartbeat_all():
        for node in nodes:
            directory = Path(node['directory'])
            manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf8'))
            private = load_pem_private_key((directory / manifest['private_key_file']).read_bytes(), password=None)
            challenge = client.get(base + f"/node-channel/{node['id']}/challenge")
            assert challenge.status_code == 200, challenge.text
            body = {'client_request_id': 'heartbeat-' + uuid4().hex, 'node_id': node['id'],
                'challenge': challenge.json()['challenge'], 'sequence': challenge.json()['next_sequence'],
                'observed_at': datetime.now(timezone.utc).isoformat(), 'compatibility': 'flower-1.23/secaggplus-v1'}
            encoded = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
            body['signature'] = base64.b64encode(private.sign(hashlib.sha256(encoded).hexdigest().encode())).decode()
            post(base + '/node-channel/heartbeat', {}, body)

    heartbeat_all()
    me = client.get('/api/v1/auth/me', headers=headers)
    assert me.status_code == 200, me.text
    return {'synthetic_only': True, 'project_id': project['id'], 'base_model_version_id': version['id'],
        'node_ids': [n['id'] for n in nodes], 'artifact_sha256': candidate_sha256,
        'researcher': {'access_token': headers['Authorization'].split(' ', 1)[1], 'user': me.json()},
        'runtime': str(runtime)}, heartbeat_all
