"""Research-only candidates. Registration conveys neither DAC nor clinical rights."""
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.core.config import settings
from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.federated_experiment import FederatedExperiment, FederatedModelVersion, FederatedRound, FederatedPrivacyLedger
from backend.app.models.model_registry import ModelVersion, tag
from backend.app.models.user import User
from backend.app.schemas.federated_experiment import PRESET
from backend.app.services import federated_control_service as control
from backend.app.services import federated_experiment_service as experiments
from backend.app.services import model_registry_service as registry
from backend.app.services.care_plan_service import _original_credentials
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.identity_access import require_reviewer, recheck_request_authority

ROOT = Path(__file__).resolve().parents[3]
MAX_PREVIEW_BYTES = 10 * 1024 * 1024


def _lease(db, experiment_id, owner):
    db.scalar(select(FederatedExperiment).where(FederatedExperiment.id == experiment_id).with_for_update())
    row, values = experiments._load(db, experiment_id)
    if (row.status != 'validating' or row.active_slot != 1 or not owner or row.lease_owner != owner or row.lease_expires_at is None
            or control._utc(row.lease_expires_at) <= datetime.now(timezone.utc)):
        raise HTTPException(409, '仅当前有效租约的验证阶段执行器可以登记候选。')
    return row, values


def _sources(db, row, values):
    actor = db.get(User, row.actor_user_id, populate_existing=True)
    if actor is None or not actor.is_active:
        raise HTTPException(403, '实验原发起账号已失效。')
    _original_credentials(db, values['source_credentials'])
    current = experiments._sources(db, actor, row, values, fresh_heartbeat=False)
    # Current HTTP credentials also include the viewing member. They are checked
    # independently; only the original source snapshot defines the experiment.
    if canonical_digest({k: v for k, v in current.items() if k != 'credentials'}) != canonical_digest(
            {k: v for k, v in values['sources'].items() if k != 'credentials'}):
        raise HTTPException(409, '原项目、成员、节点、同意、基座或审查准入已改变。')
    return actor, values['sources']


def _json_file(path, digest, *, maximum=8 * 1024 * 1024):
    target = Path(path)
    if not target.is_absolute() or not target.is_file() or target.stat().st_size > maximum:
        raise HTTPException(409, '已提交轮次收据缺失或超出限制。')
    raw = target.read_bytes()
    if len(raw) > maximum or hashlib.sha256(raw).hexdigest() != digest:
        raise HTTPException(409, '已提交轮次收据摘要改变。')
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise HTTPException(409, '已提交轮次收据格式无效。') from error


def _committed(db, row, values):
    config = values['configuration']
    protected = config['mode'] == 'dp_secagg'
    if config['mode'] not in {'dp_secagg', 'synthetic_plaintext'} or values.get('completed_rounds') != config['rounds']:
        raise HTTPException(409, '候选需要全部计划轮次的确切模式提交。')
    rows = db.scalars(select(FederatedRound).where(FederatedRound.experiment_id == row.id,
                      FederatedRound.status == 'aggregate_committed').order_by(FederatedRound.round_number)).all()
    if [r.round_number for r in rows] != list(range(1, config['rounds'] + 1)):
        raise HTTPException(409, '已提交轮次不完整或有重复提交。')
    aggregates, rounds, previous = [], [], None
    for round_row in rows:
        item = control._object(db, round_row)
        if any(item.get(key) != val for key, val in {'experiment_id': row.id, 'round_number': round_row.round_number,
                'attempt': round_row.attempt, 'status': 'aggregate_committed'}.items()):
            raise RecordIntegrityError('Candidate committed round identity changed.')
        receipt = _json_file(item['receipt_path'], item['receipt_sha256'])
        expected = {'schema': 'federated-round-receipt/v1', 'experiment_id': row.id,
                    'round': round_row.round_number, 'attempt': round_row.attempt, 'status': 'completed',
                    'applied': True, 'mode': config['mode'], 'synthetic_only': True, 'dp_enabled': protected,
                    'secagg_enabled': protected, 'candidate_sha256': values['sources']['base_sha256'],
                    'aggregate_sha256': item['aggregate_sha256'],
                    'aggregate_parameters_sha256': item['aggregate_parameters_sha256'],
                    'base_parameters_sha256': item['base_parameters_sha256']}
        expected['initialization'] = ('fresh_public_seed_1729_original_mlp' if round_row.round_number == 1
                                      else 'previous_committed_public_arrays')
        expected['classifier_input_dim'] = values['sources']['nodes'][0]['feature_dimension']
        expected['parameter_names'] = ['linear1.weight', 'linear1.bias', 'linear2.weight', 'linear2.bias']
        if any(receipt.get(key) != val for key, val in expected.items()):
            raise HTTPException(409, '真实轮次收据与当前确切提交不一致。')
        runtime = item['runtime_manifest']
        if any(runtime.get(key) != val for key, val in {'experiment_id': row.id, 'round': round_row.round_number,
                'attempt': round_row.attempt, 'candidate_sha256': values['sources']['base_sha256'],
                'synthetic_only': True, 'mode': config['mode']}.items()):
            raise HTTPException(409, '轮次冻结配置与实验来源不一致。')
        if previous is not None and item['base_parameters_sha256'] != previous:
            raise HTTPException(409, '后续轮次没有使用上一轮确切已提交参数。')
        from federated_runtime.candidate_pack import load_aggregate
        try:
            _, actual_parameters_sha = load_aggregate(item['aggregate_path'], item['aggregate_sha256'],
                                                       values['sources']['nodes'][0]['feature_dimension'])
        except (OSError, ValueError) as error:
            raise HTTPException(409, '已提交四数组的有限值、结构或文件摘要已改变。') from error
        if actual_parameters_sha != item['aggregate_parameters_sha256']:
            raise HTTPException(409, '已提交四数组的确切数值摘要已改变。')
        previous = item['aggregate_parameters_sha256']
        aggregates.append({'path': item['aggregate_path'], 'sha256': item['aggregate_sha256'],
                           'parameters_sha256': previous})
        rounds.append({'round': round_row.round_number, 'attempt': round_row.attempt,
                       'aggregate_sha256': item['aggregate_sha256'], 'parameters_sha256': previous,
                       'receipt_sha256': item['receipt_sha256']})
    last = values.get('last_committed_parameters')
    if not isinstance(last, dict) or last != {**aggregates[-1], 'round': config['rounds']}:
        raise HTTPException(409, '实验最后提交的确切参数与轮次记录不一致。')
    if not protected:
        return aggregates, rounds, {'overall': experiments.account(experiments._histories(db)),
            'dp_enabled': False, 'secagg_enabled': False, 'protection_applied': False,
            'reservation_count': 0, 'notice': '明文合成对照没有隐私保护。overall仅为既有DP账本，不保护该对照模型。'}
    reservations, witnessed = [], set()
    for ledger in db.scalars(select(FederatedPrivacyLedger)).all():
        body = control._object(db, ledger)
        if body['protection_namespace'] != ledger.protection_namespace:
            raise RecordIntegrityError('Candidate privacy namespace changed.')
        for reservation in body['reservations']:
            if reservation['experiment_id'] == row.id:
                reservations.append(reservation)
        for committed in rounds:
            for node in values['sources']['nodes']:
                if node['institution_id'] != ledger.institution_id or node['protection_namespace'] != ledger.protection_namespace:
                    continue
                identity = f"{row.id}:{committed['round']}:{committed['attempt']}:{node['node_id']}"
                matching = [r for r in body['reservations'] if r['identity'] == identity]
                if len(matching) != 1 or matching[0]['status'] != 'spent_or_partly_spent':
                    raise HTTPException(409, '确切已提交轮次缺少原节点签名消耗账本。')
                reservation = matching[0]
                if (reservation.get('node_id') != node['node_id']
                        or reservation.get('round') != committed['round'] or reservation.get('attempt') != committed['attempt']
                        or reservation['noise_multiplier'] != PRESET['noise_multiplier']
                        or reservation['sample_rate'] != PRESET['sample_rate']
                        or reservation['planned_steps'] != PRESET['logical_steps']
                        or reservation.get('actual_history') != [[PRESET['noise_multiplier'], PRESET['sample_rate'], PRESET['logical_steps']]]
                        or not body['node_anchors'].get(node['node_id'], {}).get('signed_events')):
                    raise HTTPException(409, '节点实际步数、原预算或签名历史不完整。')
                witnessed.add((committed['round'], committed['attempt'], node['node_id']))
    for committed in rounds:
        for node in values['sources']['nodes']:
            key = f"{row.id}:{committed['round']}:{committed['attempt']}:{node['node_id']}"
            if (len([r for r in reservations if r['identity'] == key]) != 1
                    or (committed['round'], committed['attempt'], node['node_id']) not in witnessed):
                raise HTTPException(409, '每轮三个节点必须有唯一持久预算记录。')
    privacy = experiments.account(experiments._histories(db))
    if not math.isfinite(privacy['epsilon']) or privacy['epsilon'] > PRESET['max_epsilon']:
        raise HTTPException(409, '当前保守顺序组合预算超限。')
    return aggregates, rounds, {'overall': privacy, 'maximum_epsilon': PRESET['max_epsilon'],
            'delta': PRESET['delta'], 'reservation_count': len(reservations),
            'reservations_digest': canonical_digest(reservations), 'composition': PRESET['composition']}


def _legacy(request):
    interpreter = Path(settings.FEDERATED_HGST_PYTHON).resolve()
    packages = ROOT / '.venv-hgst/Lib/site-packages'
    if not interpreter.is_file() or not packages.is_dir():
        raise HTTPException(503, '只读旧HGST兼容解释器尚不可用。')
    with tempfile.TemporaryDirectory(prefix='f05-candidate-') as temporary:
        request_path = Path(temporary) / 'request.json'
        request_path.write_text(json.dumps(request, allow_nan=False), encoding='utf8')
        try:
            process = subprocess.run([str(interpreter), '-B', str(ROOT / 'federated_runtime/candidate_pack.py'),
                       '--request', str(request_path), '--legacy-site-packages', str(packages)],
                       cwd=ROOT, capture_output=True, text=True, timeout=120,
                       env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1'},
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            if process.returncode != 0:
                raise ValueError('Locked HGST process refused the candidate contract')
            result = json.loads(process.stdout)
            if not isinstance(result, dict):
                raise ValueError('Invalid candidate result')
            return result
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            raise HTTPException(409, '旧HGST环境未通过确切候选加载、数值结构或合成推理验证。') from error


def _public(db, row, values, *, published=False):
    version = registry._version(db, row.id)
    metadata = version.manifest['training_metadata']
    return {'model_version_id': row.id, 'id': row.id, 'project_id': row.project_id, 'experiment_id': row.experiment_id,
            'revision': row.version, 'version': version.version, 'artifact_sha256': version.artifact_sha256,
            'status': 'published' if published else 'candidate', 'published': published, 'research_only': True,
            'clinical_activation_allowed': False, **{k: metadata[k] for k in ('synthetic', 'encoder_origin',
                'encoder_provenance_verified', 'encoder_dp_protected', 'secure_rng', 'privacy', 'validation',
                'completed_rounds', 'mode', 'r03_equivalence_verified', 'protection_scope')}}


def _existing(db, experiment, values, rounds):
    old = db.scalar(select(FederatedModelVersion).where(FederatedModelVersion.experiment_id == experiment.id))
    if old is None:
        return None
    body = control._object(db, old)
    version = registry._version(db, old.id)
    metadata = version.manifest['training_metadata']
    if (old.project_id != experiment.project_id or body.get('model_version_id') != old.id
            or body.get('experiment_id') != experiment.id or body.get('project_id') != experiment.project_id
            or body.get('configuration_digest') != values['configuration_digest']
            or body.get('artifact_sha256') != version.artifact_sha256
            or metadata.get('configuration_digest') != values['configuration_digest']
            or metadata.get('rounds') != rounds or version.manifest['purpose'] != 'research_only'):
        raise RecordIntegrityError('Existing candidate differs from its exact frozen experiment.')
    registry.artifact_path(version)
    return _public(db, old, body)


def prepare_candidate(session_factory, experiment_id, lease_owner):
    """Worker-only registration; worker alone transitions validating to completed."""
    with session_factory() as db:
        row, values = _lease(db, experiment_id, lease_owner)
        actor, sources = _sources(db, row, values)
        aggregates, rounds, privacy = _committed(db, row, values)
        existing = _existing(db, row, values, rounds)
        if existing is not None:
            return existing
        root = Path(settings.MODEL_REGISTRY_ARTIFACT_ROOT).resolve()
        filename = f'federated/{row.id}/{uuid4().hex}.pt'
        output = root / filename
        metadata = {'schema': 'federated-candidate/v1', 'experiment_id': row.id,
                    'configuration_digest': values['configuration_digest'], 'synthetic': True,
                    'purpose': 'research_only', 'mode': values['configuration']['mode'], 'completed_rounds': len(rounds),
                    'encoder_origin': sources['nodes'][0]['encoder_origin'], 'encoder_provenance_verified': False,
                    'encoder_dp_protected': False, 'secure_rng': False, 'r03_equivalence_verified': False,
                    'protection_scope': ('classifier_only_fixed_public_slot_patient_dp' if values['configuration']['mode'] == 'dp_secagg' else 'none_synthetic_plaintext_control'),
                    'base_model_version_id': sources['base_version_id'], 'base_artifact_sha256': sources['base_sha256'],
                    'base_review_id': sources['base_review_id'], 'rounds': rounds, 'privacy': privacy,
                    'input_contract_digest': sources['input_contract_digest'],
                    'code_review_inherited': False, 'clinical_admission': False}
        # Let concurrent stop/withdrawal transactions proceed during isolation.
        # The lease and every original gate are read again before registration.
        db.rollback()
        result = _legacy({'operation': 'package', 'base_path': sources['base_path'], 'base_sha256': sources['base_sha256'],
                          'output_path': str(output), 'input_contract_digest': sources['input_contract_digest'],
                          'aggregates': aggregates, 'metadata': metadata})
        if (result.get('aggregate_parameters_sha256') != aggregates[-1]['parameters_sha256']
                or result.get('round_parameter_digests') != [a['parameters_sha256'] for a in aggregates]
                or result.get('encoder_parameters_sha256') != sources['nodes'][0]['encoder_parameters_sha256']
                or result.get('input_contract_digest') != sources['input_contract_digest']
                or result.get('validation', {}).get('artifact_sha256') != result.get('artifact_sha256')
                or result.get('validation', {}).get('status') != 'synthetic_load_and_inference_passed'):
            raise HTTPException(409, '打包结果没有绑定确切聚合、原编码器和合成验证摘要。')
        # The slow isolated validation does not extend or take over a lease.
        row, values = _lease(db, experiment_id, lease_owner)
        actor, current = _sources(db, row, values)
        current_aggregates, current_rounds, current_privacy = _committed(db, row, values)
        if (current_aggregates != aggregates or current_rounds != rounds
                or canonical_digest(current_privacy) != canonical_digest(privacy)):
            raise HTTPException(409, '隔离验证期间已提交参数或保守预算发生变化。')
        existing = _existing(db, row, values, rounds)
        if existing is not None:
            return existing
        metadata.update(validation=result['validation'], encoder_origin=result['encoder_origin'])
        base = registry._version(db, sources['base_version_id'])
        registry._head(db, base.family)
        manifest = {'family': base.family, 'version': 'fed-' + row.id, 'artifact_file': filename,
                    'artifact_sha256': result['artifact_sha256'], 'input_contract_digest': sources['input_contract_digest'],
                    'purpose': 'research_only', 'institution_id': row.institution_id,
                    'code_source': base.manifest['code_source'], 'weight_source': 'frozen base encoder plus committed classifier; mode=' + values['configuration']['mode'],
                    'training_data_source': 'explicit synthetic node ROI only; no clinical validity claim', 'training_metadata': metadata}
        version = ModelVersion(family=base.family, version=manifest['version'], artifact_sha256=result['artifact_sha256'],
                               actor_user_id=row.actor_user_id, manifest=manifest)
        version.state_tag = tag(version)
        registry.artifact_path(version)
        db.add(version)
        try:
            db.flush()
        except IntegrityError as error:
            # The deterministic unified version name serializes duplicate
            # attempts even on SQLite, where SELECT FOR UPDATE is advisory.
            db.rollback()
            row, values = _lease(db, experiment_id, lease_owner)
            _sources(db, row, values)
            existing = _existing(db, row, values, rounds)
            if existing is None:
                raise HTTPException(409, '候选并发登记冲突；未改变实验终态。') from error
            return existing
        bound = FederatedModelVersion(id=version.id, project_id=row.project_id, experiment_id=row.id,
                                     institution_id=row.institution_id, version=1, sealed_payload='')
        bound.put({'project_id': row.project_id, 'experiment_id': row.id, 'model_version_id': version.id,
                   'artifact_sha256': version.artifact_sha256, 'configuration_digest': values['configuration_digest'],
                   'source_credentials': values['source_credentials'], 'research_only': True})
        db.add(bound)
        head, state, _ = control._head(db, row.institution_id, lock=True)
        public = _public(db, bound, bound.read())
        control._append(db, actor, head, state, bound, 'candidate_register', str(version.id),
                        {'client_request_id': 'candidate-' + row.id, 'experiment_id': row.id}, public, row.project_id)
        return public


def _load(db, user, project_id, model_id, *, completed=True):
    control._scope(db, user, project_id)
    control._project(db, project_id, active=True)
    row = db.get(FederatedModelVersion, model_id, populate_existing=True)
    if row is None or row.project_id != project_id:
        raise HTTPException(404, '此项目没有这个联邦候选。')
    body = control._object(db, row)
    if any(body.get(key) != value for key, value in {'project_id': row.project_id,
            'experiment_id': row.experiment_id, 'model_version_id': row.id}.items()):
        raise RecordIntegrityError('Candidate project or experiment binding changed.')
    experiment, values = experiments._load(db, row.experiment_id)
    if experiment.project_id != project_id or completed and (experiment.status != 'completed'
            or values.get('candidate_model_version_id') != model_id):
        raise HTTPException(409, '实验尚未完成或没有绑定这个确切候选。')
    _sources(db, experiment, values)
    version = registry._version(db, model_id)
    if version.manifest['purpose'] != 'research_only' or version.artifact_sha256 != body['artifact_sha256']:
        raise RecordIntegrityError('Candidate research-only metadata changed.')
    registry._head(db, version.family)
    registry.artifact_path(version)
    return row, body, experiment, values, version


def _published(db, row):
    _, _, events = control._head(db, row.institution_id)
    publication = next(((event, body) for event, body in reversed(events)
                        if body['operation'] == 'candidate_publish' and body['target'] == str(row.id)), None)
    if publication is None:
        return False
    event, body = publication
    reviewer = db.get(User, event.actor_user_id, populate_existing=True)
    if reviewer is None or not reviewer.is_active:
        raise HTTPException(403, '候选原实验发布审查账号已失效。')
    require_reviewer(db, reviewer.id, row.institution_id)
    _original_credentials(db, body['authority_snapshot'])
    return True


def listing(db, user, project_id):
    control._scope(db, user, project_id)
    control._project(db, project_id, active=True)
    result = []
    for row in db.scalars(select(FederatedModelVersion).where(FederatedModelVersion.project_id == project_id)).all():
        row, body, _, _, _ = _load(db, user, project_id, row.id)
        result.append(_public(db, row, body, published=_published(db, row)))
    return {'project_id': project_id, 'items': result}


def bases(db, user, project_id):
    control._scope(db, user, project_id, 'experiment')
    control._project(db, project_id, active=True)
    result = []
    for version in db.scalars(select(ModelVersion).order_by(ModelVersion.id.desc())).all():
        if version.manifest.get('purpose') != 'research_only' or version.manifest.get('training_metadata', {}).get('schema') == 'federated-candidate/v1':
            continue
        try:
            experiments._research_base(db, version.id, admit=True)
        except HTTPException as error:
            if error.status_code >= 500:
                raise
            continue
        result.append({'id': version.id, 'version': version.version, 'artifact_sha256': version.artifact_sha256,
                       'input_contract_digest': version.manifest['input_contract_digest'], 'purpose': 'research_only'})
    return {'project_id': project_id, 'items': result}


def publish(db, user, project_id, model_id, payload):
    row, body, experiment, values, version = _load(db, user, project_id, model_id)
    require_reviewer(db, user.id, row.institution_id)
    request = control._body(payload)
    old = control._old(db, user, payload.client_request_id, 'candidate_publish', model_id, request)
    if old:
        _published(db, row)
        return old
    if payload.expected_revision != row.version:
        raise HTTPException(409, '候选不可变版本不一致。')
    if not payload.reason.strip():
        raise HTTPException(422, '实验发布需要实际审查理由。')
    _committed(db, experiment, values)
    head, state, _ = control._head(db, row.institution_id, lock=True)
    return control._append(db, user, head, state, row, 'candidate_publish', str(model_id), request,
                           _public(db, row, body, published=True), project_id)


def preview(db, user, project_id, model_id, raw, filename, confirmed_synthetic):
    row, body, _, _, version = _load(db, user, project_id, model_id)
    if not _published(db, row):
        raise HTTPException(409, '该候选尚未由原负责机构审查人明确实验发布。')
    if confirmed_synthetic is not True or not filename.lower().endswith('.npz'):
        raise HTTPException(422, '实验预览只接受明确确认的合成ROI数值NPZ。')
    if not raw or len(raw) > MAX_PREVIEW_BYTES:
        raise HTTPException(413, '实验ROI上传不得超过10 MiB。')
    with tempfile.TemporaryDirectory(prefix='f05-preview-') as temporary:
        path = Path(temporary) / 'synthetic-roi.npz'
        path.write_bytes(raw)
        digest = hashlib.sha256(raw).hexdigest()
        result = _legacy({'operation': 'preview', 'candidate_path': str(registry.artifact_path(version)),
                          'candidate_sha256': version.artifact_sha256, 'roi_path': str(path), 'roi_sha256': digest})
    # Recheck after inference so a concurrent withdrawal cannot release a result.
    _load(db, user, project_id, model_id)
    _published(db, row)
    recheck_request_authority(db)
    if result.get('artifact_sha256') != version.artifact_sha256 or result.get('input_sha256') != digest:
        raise HTTPException(409, '预览结果没有绑定指定模型和实际输入摘要。')
    protected = version.manifest['training_metadata']['mode'] == 'dp_secagg'
    return {'model_version_id': model_id, 'experiment_id': row.experiment_id, **result,
            'mode': version.manifest['training_metadata']['mode'], 'dp_enabled': protected, 'secagg_enabled': protected,
            'notice': ('仅合成研究实验推理；编码器来源未验证，保护仅覆盖分类器，不能形成临床报告。' if protected
                       else '仅无隐私保护的明文合成对照推理；没有DP或安全聚合保护，不能形成临床报告。')}
