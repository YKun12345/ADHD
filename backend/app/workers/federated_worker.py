"""Durable synthetic-only coordinator; training stays in .venv-federated.

Every attempt starts after conservative reservations are committed. An expired
lease discards the old protocol session, never its budget or committed model.
Injected runtimes are a control-test seam, not a training implementation.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
from types import SimpleNamespace
from uuid import uuid4
import zipfile

from fastapi import HTTPException
from sqlalchemy import select, update, or_
from sqlalchemy.exc import IntegrityError, OperationalError

from backend.app.core.config import settings
from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.federated import FederatedAuditEvent
from backend.app.models.federated_experiment import FederatedExperiment, FederatedRound
from backend.app.models.user import User
from backend.app.services import federated_control_service as control
from backend.app.services import federated_experiment_service as experiments
from backend.app.services import federated_budget_service as budget
from federated_runtime.framing import read_frame, write_frame

LOGGER = logging.getLogger(__name__)
NAMES = ('linear1.weight', 'linear1.bias', 'linear2.weight', 'linear2.bias')
PRIVACY_KEYS = ('capacity', 'noise_multiplier', 'max_grad_norm', 'sample_rate',
                'logical_steps', 'delta', 'max_epsilon', 'max_rounds')
ACTIVE = {'running', 'validating', 'stopping'}


class LeaseLost(RuntimeError):
    pass


class StopRequested(RuntimeError):
    pass


class WorkerShutdown(StopRequested):
    pass


def _now():
    return datetime.now(timezone.utc)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def _commit_objects(db, head, state, objects, operation, project_id):
    """Use the existing anchored audit format, atomically for several objects.

    Round + experiment progress must not be split by _append's eager commit.
    The independent head is advanced once for the complete contiguous batch.
    """
    from backend.app.services import authorization_ledger as ledger
    from backend.app.services.care_plan_service import _credentials
    from backend.app.services.identity_access import recheck_request_authority, publish_authority
    from backend.app.services.security_service import _append_audit_log
    previous, sequence = state['last_hash'], state['sequence']
    for obj in objects:
        sequence += 1
        event = FederatedAuditEvent(id=uuid4().hex, institution_id=head.id, version=1,
            sequence=sequence, actor_user_id=None, project_id=project_id,
            client_request_id='fed-worker-'+uuid4().hex, sealed_payload='', created_at=_now())
        event.put({'sequence': sequence, 'previous': previous, 'actor_user_id': None,
            'project_id': project_id, 'client_request_id': event.client_request_id,
            'created_at': event.created_at.isoformat(), 'operation': operation, 'target': str(obj.id),
            'original_request': {'client_request_id': event.client_request_id},
            'result': {'id': str(obj.id), 'status': getattr(obj, 'status', None), 'revision': obj.version},
            'object_type': obj.__tablename__, 'object_id': str(obj.id),
            'object_digest': hashlib.sha256(obj.sealed_payload.encode()).hexdigest(),
            'authority_snapshot': _credentials(db)})
        previous = hashlib.sha256(event.sealed_payload.encode()).hexdigest()
        db.add(event)
    ledger.deny(head)
    head.version = head.revision
    head.put({'revision': head.revision, 'ledger_key': head.ledger_key,
              'sequence': sequence, 'last_hash': previous})
    _append_audit_log(db, action='federated_'+operation, status='success', actor_user_id=None,
        message='联邦执行器持久状态。', detail_json={'institution_id': head.id, 'project_id': project_id, 'operation': operation})
    recheck_request_authority(db)
    db.commit()
    publish_authority(db, head)


def _numeric_artifact(path, sources, expected_file, expected_arrays):
    """Independent bounded non-pickle check before a public aggregate commit."""
    import numpy as np
    from federated_runtime.hgst_features import MAX_ARRAY_BYTES
    path = Path(path).resolve()
    if not path.is_file() or path.stat().st_size > MAX_ARRAY_BYTES:
        raise RecordIntegrityError('Aggregate NPZ is absent or oversized.')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_file:
        raise RecordIntegrityError('Aggregate file digest changed.')
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) != 4 or sum(item.file_size for item in archive.infolist()) > MAX_ARRAY_BYTES:
            raise RecordIntegrityError('Aggregate expands beyond the four-array bound.')
    descriptors = sources['nodes'][0]['classifier_parameters']
    with np.load(path, allow_pickle=False) as arrays:
        if set(arrays.files) != set(NAMES):
            raise RecordIntegrityError('Aggregate requires exactly four classifier arrays.')
        actual = []
        for descriptor, name in zip(descriptors, NAMES):
            value = arrays[name]
            if descriptor['name'] != name or value.dtype != np.float32 or list(value.shape) != descriptor['shape'] or not np.isfinite(value).all():
                raise RecordIntegrityError('Aggregate shape, dtype or finite-value check failed.')
            actual.append({'name': name, 'shape': list(value.shape), 'dtype': str(value.dtype),
                           'sha256': hashlib.sha256(value.tobytes(order='C')).hexdigest()})
    if hashlib.sha256(_canonical(actual)).hexdigest() != expected_arrays:
        raise RecordIntegrityError('Aggregate parameter digest changed.')
    return str(path)


class FederatedWorkerRuntime:
    def __init__(self, session_factory, *, owner=None, interval_seconds=None, lease_seconds=None,
                 round_timeout_seconds=None, runtime=None, candidate_preparer=None):
        self.session_factory = session_factory
        self.owner = owner or uuid4().hex
        self.interval = interval_seconds or settings.FEDERATED_WORKER_INTERVAL_SECONDS
        self.lease_seconds = lease_seconds or settings.FEDERATED_WORKER_LEASE_SECONDS
        self.round_timeout = round_timeout_seconds or settings.FEDERATED_ROUND_TIMEOUT_SECONDS
        if len(self.owner) > 64 or not .1 <= self.interval <= 60 or not 5 <= self.lease_seconds <= 3600 or not 1 <= self.round_timeout <= 7200:
            raise ValueError('Federated worker bounds are invalid.')
        self.runtime = runtime or self._stdio_round
        self.candidate_preparer = candidate_preparer
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name='federated-worker', daemon=True)
        self._thread.start()

    def stop(self, timeout=5):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)
        return not self._thread or not self._thread.is_alive()

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                LOGGER.exception('Federated worker scan stopped safely; durable state is retained.')
            self._stop.wait(self.interval)

    def _owned(self, row, *, allow_stopping=True):
        if (row.lease_owner != self.owner or row.active_slot != 1 or not row.lease_expires_at
                or control._utc(row.lease_expires_at) <= _now() or row.status not in ACTIVE):
            raise LeaseLost('The attempt no longer holds the current experiment lease.')
        if not allow_stopping and self._stop.is_set():
            raise WorkerShutdown('The worker is shutting down; retain resumable state.')
        if not allow_stopping and row.status == 'stopping':
            raise StopRequested('The current experiment was stopped.')

    def _write_experiment(self, db, row, values, old_revision, *, require_lease=True):
        conditions = [FederatedExperiment.id == row.id, FederatedExperiment.version == old_revision,
                      FederatedExperiment.active_slot == 1]
        if require_lease:
            conditions.extend([FederatedExperiment.lease_owner == self.owner,
                               FederatedExperiment.lease_expires_at > _now()])
        experiments._put(row, values)
        with db.no_autoflush:
            result = db.execute(update(FederatedExperiment).where(*conditions).values(
                version=row.version, status=row.status, active_slot=row.active_slot,
                lease_owner=row.lease_owner, lease_expires_at=row.lease_expires_at,
                sealed_payload=row.sealed_payload).execution_options(synchronize_session=False))
        if result.rowcount != 1:
            db.rollback()
            raise LeaseLost('Experiment version or lease changed before the durable write.')
        # The CAS has already written these columns. Discard ORM dirty tracking.
        db.expire(row)

    def _change(self, identifier, operation, mutate, *, require_lease=True):
        with self.session_factory() as db:
            row, _ = experiments._load(db, identifier)
            head, state, _ = control._head(db, row.institution_id, lock=True)
            row, values = experiments._load(db, identifier)
            if require_lease:
                self._owned(row)
            if operation == 'worker_completed':
                self._owned(row, allow_stopping=False)
                experiments.worker_sources(db, row, values)
            revision = row.version
            mutate(row, values)
            self._write_experiment(db, row, values, revision, require_lease=require_lease)
            _commit_objects(db, head, state, [row], operation, row.project_id)
            return values

    def claim_once(self):
        with self.session_factory() as db:
            candidates = db.scalars(select(FederatedExperiment).where(
                FederatedExperiment.active_slot == 1,
                or_(FederatedExperiment.status == 'queued',
                    FederatedExperiment.status.in_(ACTIVE) &
                    or_(FederatedExperiment.lease_expires_at.is_(None), FederatedExperiment.lease_expires_at <= _now())))
                .order_by(FederatedExperiment.id)).all()
            identifiers = [row.id for row in candidates]
        for identifier in identifiers:
            def claim(row, values):
                if row.status != 'queued' and not (row.status in ACTIVE and
                    (row.lease_expires_at is None or control._utc(row.lease_expires_at) <= _now())):
                    raise LeaseLost('Another worker renewed or claimed this experiment.')
                if row.status != 'stopping':
                    row.status = 'validating' if values['completed_rounds'] == values['configuration']['rounds'] else 'running'
                row.lease_owner = self.owner
                row.lease_expires_at = _now() + timedelta(seconds=self.lease_seconds)
            try:
                self._change(identifier, 'worker_claim', claim, require_lease=False)
                self._abort_unfinished(identifier, 'expired_lease_protocol_discarded')
                return identifier
            except (LeaseLost, IntegrityError, OperationalError):
                continue
        return None

    def _round_change(self, identifier, round_id, operation, mutate, *, finish=None, check_sources=False):
        with self.session_factory() as db:
            experiment, _ = experiments._load(db, identifier)
            head, state, _ = control._head(db, experiment.institution_id, lock=True)
            experiment, values = experiments._load(db, identifier)
            self._owned(experiment)
            if finish or check_sources:
                self._owned(experiment, allow_stopping=False)
                experiments.worker_sources(db, experiment, values)
            row = db.get(FederatedRound, round_id, populate_existing=True)
            payload = control._object(db, row)
            if payload['status'] != row.status or payload['experiment_id'] != identifier or payload['attempt'] != row.attempt or payload['round_number'] != row.round_number:
                raise RecordIntegrityError('Round routing or phase changed.')
            mutate(row, payload)
            row.version += 1
            row.put(payload)
            revision = experiment.version
            if finish:
                finish(experiment, values)
            self._write_experiment(db, experiment, values, revision)
            _commit_objects(db, head, state, [row, experiment], operation, experiment.project_id)

    def _abort_unfinished(self, identifier, code):
        with self.session_factory() as db:
            ids = list(db.scalars(select(FederatedRound.id).where(
                FederatedRound.experiment_id == identifier,
                FederatedRound.status.notin_(['aggregate_committed', 'aborted']))))
        for round_id in ids:
            def abort(row, payload):
                row.status = payload['status'] = 'aborted'
                payload.update(error_code=code, finished_at=_now().isoformat())
            self._round_change(identifier, round_id, 'worker_round_aborted', abort)

    def _pulse(self, identifier):
        with self.session_factory() as db:
            row, values = experiments._load(db, identifier)
            self._owned(row, allow_stopping=False)
            experiments.worker_sources(db, row, values)
            renew_needed = (control._utc(row.lease_expires_at)-_now()).total_seconds() <= self.lease_seconds*2/3
        if not renew_needed:
            return
        def renew(row, values):
            self._owned(row, allow_stopping=False)
            row.lease_expires_at = _now() + timedelta(seconds=self.lease_seconds)
        self._change(identifier, 'worker_lease_renewed', renew)

    def _new_round(self, identifier):
        with self.session_factory() as db:
            experiment, values = experiments._load(db, identifier)
            head, state, _ = control._head(db, experiment.institution_id, lock=True)
            experiment, values = experiments._load(db, identifier)
            self._owned(experiment, allow_stopping=False)
            sources = experiments.worker_sources(db, experiment, values)
            config = values['configuration']
            if config['mode'] not in {'dp_secagg', 'synthetic_plaintext'} or not 1 <= config['rounds'] <= 5:
                raise HTTPException(409, '持久执行器只接受明确冻结的合成研究模式，最多五轮。')
            number, attempt = values['completed_rounds']+1, str(uuid4())
            if number > config['rounds']:
                return None
            previous = values.get('last_committed_parameters')
            if number > 1:
                if not previous or previous.get('round') != number-1:
                    raise RecordIntegrityError('Previous committed round is missing.')
                _numeric_artifact(previous['path'], sources, previous['sha256'], previous['parameters_sha256'])
            output = Path(settings.FEDERATED_RUNTIME_ROOT).resolve()/identifier/f'round-{number}-{attempt}'
            output.parent.mkdir(parents=True, exist_ok=True)
            manifest = {'schema':'federated-round/v1', 'synthetic_only':True, 'experiment_id':identifier,
                'round':number, 'attempt':attempt, 'mode':config['mode'], 'nodes':sources['nodes'],
                'candidate_path':sources['base_path'], 'candidate_sha256':sources['base_sha256'],
                'output_directory':str(output), 'privacy':{key:experiments.PRESET[key] for key in PRIVACY_KEYS},
                'legacy_python':str(Path(settings.FEDERATED_HGST_PYTHON).resolve()),
                'legacy_site_packages':str(experiments.ROOT/'.venv-hgst/Lib/site-packages')}
            if previous:
                manifest.update(base_parameters_path=previous['path'], base_parameters_sha256=previous['parameters_sha256'])
            row = FederatedRound(id=uuid4().hex, experiment_id=identifier, institution_id=experiment.institution_id,
                round_number=number, attempt=attempt, status='created', version=1, sealed_payload='')
            payload = {'experiment_id':identifier, 'round_number':number, 'attempt':attempt,
                'status':'created', 'runtime_manifest':manifest, 'started_at':_now().isoformat(),
                'lease_owner':self.owner}
            row.put(payload)
            db.add(row)
            self._write_experiment(db, experiment, values, experiment.version)
            _commit_objects(db, head, state, [row, experiment], 'worker_round_created', experiment.project_id)
            return row.id, manifest, sources, experiment.actor_user_id

    def _reserve(self, identifier, manifest, sources, actor_id):
        if manifest['mode'] == 'synthetic_plaintext':
            # Existing sources accept explicit synthetic node manifests only.
            # A control experiment does not receive or consume a DP guarantee.
            self._pulse(identifier)
            return
        for node in sources['nodes']:
            self._pulse(identifier)
            with self.session_factory() as db:
                row, values = experiments._load(db, identifier)
                self._owned(row, allow_stopping=False)
                experiments.worker_sources(db, row, values)
                budget.reserve(db, db.get(User, actor_id), identifier, manifest['round'], manifest['attempt'], node)

    def _observe(self, node, privacy):
        if privacy is None:
            raise RecordIntegrityError('A signed node privacy snapshot is required.')
        with self.session_factory() as db:
            budget.observe(db, node, privacy)

    def _gate(self, identifier, manifest, sources, event):
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
        node = next((node for node in sources['nodes'] if node['node_id'] == event.get('node_id')), None)
        if node is None:
            raise RecordIntegrityError('Gate belongs to an unselected node.')
        signed = {key:value for key,value in event.items() if key != 'signature_hex'}
        load_pem_public_key(node['public_key_pem'].encode()).verify(bytes.fromhex(event['signature_hex']), _canonical(signed))
        if any(event.get(key) != expected for key,expected in (
            ('schema','federated-node-reply/v1'),
            ('experiment_id',identifier), ('round',manifest['round']), ('attempt',manifest['attempt']),
            ('institution_id',node['institution_id']), ('index',node['index']), ('kind','gate_request'))):
            raise RecordIntegrityError('Signed gate belongs to another attempt or authority.')
        if manifest.get('base_parameters_sha256') and event.get('base_parameters_sha256') != manifest['base_parameters_sha256']:
            raise RecordIntegrityError('The gate does not use the last committed public base.')
        if not manifest.get('base_parameters_sha256'):
            digest = event.get('base_parameters_sha256')
            if not isinstance(digest, str) or len(digest) != 64:
                raise RecordIntegrityError('The public initial parameter digest is missing.')
            manifest['base_parameters_sha256'] = digest
        # Spending evidence is retained even when the following authority check denies.
        if manifest['mode'] == 'dp_secagg':
            self._observe(node, event.get('privacy'))
        self._pulse(identifier)
        with self.session_factory() as db:
            round_id = db.scalar(select(FederatedRound.id).where(
                FederatedRound.experiment_id == identifier, FederatedRound.attempt == manifest['attempt']))
        def accept(row, payload):
            sequence = event.get('seq')
            old = payload.setdefault('gate_sequences', {}).get(node['node_id'], 0)
            if type(sequence) is not int or sequence <= old:
                raise RecordIntegrityError('Signed authorization gate sequence was replayed.')
            payload['gate_sequences'][node['node_id']] = sequence
            payload['base_parameters_sha256'] = manifest['base_parameters_sha256']
            payload['runtime_manifest'] = manifest
            phases = ['created', 'roster_locked', 'key_exchange', 'local_training', 'masked_collect', 'unmask']
            action_phase = {'node_start':'roster_locked', 'hello_reply':'roster_locked',
                'protocol_compute':'key_exchange', 'protocol_reply':'key_exchange',
                'training_start':'local_training', 'logical_step':'local_training',
                'update_ready':'masked_collect', 'aggregate_commit':'unmask'}
            phase = action_phase.get(event.get('action'))
            if phase is None or row.status not in phases:
                raise RecordIntegrityError('Unknown authorization gate or terminated round.')
            row.status = payload['status'] = phases[max(phases.index(row.status), phases.index(phase))]
        self._round_change(identifier, round_id, 'worker_gate_authorized', accept, check_sources=True)
        return True

    def _observe_receipt(self, sources, receipt):
        reports = receipt.get('node_receipts', [])
        errors = []
        for report in reports:
            node = next((node for node in sources['nodes'] if node['node_id'] == report.get('node_id')), None)
            if node is None:
                errors.append(RecordIntegrityError('Receipt contains an unselected node.'))
                continue
            try:
                self._observe(node, report.get('privacy'))
            except Exception as error:
                errors.append(error)
        if errors:
            raise errors[0]

    def _commit_round(self, identifier, round_id, manifest, sources, receipt):
        protected = manifest['mode'] == 'dp_secagg'
        if protected:
            self._observe_receipt(sources, receipt)
        self._pulse(identifier)
        expected = {'schema':'federated-round-receipt/v1', 'experiment_id':identifier,
            'round':manifest['round'], 'attempt':manifest['attempt'], 'status':'completed',
            'applied':True, 'mode':manifest['mode'], 'synthetic_only':True, 'dp_enabled':protected,
            'secagg_enabled':protected, 'candidate_sha256':sources['base_sha256']}
        if manifest.get('base_parameters_sha256'):
            expected['base_parameters_sha256'] = manifest['base_parameters_sha256']
        if any(receipt.get(key) != value for key,value in expected.items()) or receipt.get('node_cleanup_incomplete'):
            raise RecordIntegrityError('Only a complete protected round can be committed.')
        reports = receipt.get('node_receipts', [])
        if len(reports) != 3 or {report.get('node_id') for report in reports} != {node['node_id'] for node in sources['nodes']} or len({report.get('pid') for report in reports}) != 3:
            raise RecordIntegrityError('All three independent selected nodes must finish.')
        phases = receipt.get('protocol_phases', [])
        if len(phases) != (4 if protected else 1) or any(not isinstance(phase, list) or len(phase) != 3 for phase in phases):
            raise RecordIntegrityError('The receipt must contain the frozen mode\'s complete three-node protocol.')
        directory = Path(manifest['output_directory']).resolve()
        aggregate, receipt_path = Path(receipt['aggregate_path']).resolve(), Path(receipt['receipt_path']).resolve()
        if aggregate != directory/'aggregate-classifier.npz' or receipt_path != directory/'receipt.json':
            raise RecordIntegrityError('Runtime output escaped its frozen attempt directory.')
        path = _numeric_artifact(aggregate, sources, receipt['aggregate_sha256'], receipt['aggregate_parameters_sha256'])
        if json.loads(receipt_path.read_text(encoding='utf8')) != receipt:
            raise RecordIntegrityError('Durable runtime receipt differs from the framed result.')
        receipt_sha = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
        if protected:
            with self.session_factory() as db:
                if experiments.account(experiments._histories(db))['epsilon'] > experiments.PRESET['max_epsilon']:
                    raise HTTPException(409, '中央保守预算已达上限。')
        def commit(row, payload):
            if row.status in {'aggregate_committed', 'aborted'}:
                raise LeaseLost('This round attempt has already terminated.')
            row.status = payload['status'] = 'aggregate_committed'
            payload.update(aggregate_path=path, aggregate_sha256=receipt['aggregate_sha256'],
                aggregate_parameters_sha256=receipt['aggregate_parameters_sha256'],
                base_parameters_sha256=receipt['base_parameters_sha256'], receipt_path=str(receipt_path),
                receipt_sha256=receipt_sha, finished_at=_now().isoformat(),
                elapsed_seconds=receipt.get('elapsed_seconds'), node_pids=receipt.get('node_pids', {}),
                protocol_phase_count=len(receipt.get('protocol_phases', [])))
            payload['runtime_manifest'] = manifest
        def advance(row, values):
            self._owned(row, allow_stopping=False)
            # Repeat sources under the same transaction immediately before publication.
            # A check in _pulse alone would leave a stop/revoke window.
            if values['completed_rounds'] != manifest['round']-1:
                raise LeaseLost('A different attempt has already committed this round.')
            values['completed_rounds'] = manifest['round']
            values['last_committed_parameters'] = {'path':path, 'sha256':receipt['aggregate_sha256'],
                'parameters_sha256':receipt['aggregate_parameters_sha256'], 'round':manifest['round']}
            values['last_error'] = None
            row.status = 'validating' if manifest['round'] == values['configuration']['rounds'] else 'running'
        self._round_change(identifier, round_id, 'worker_aggregate_committed', commit, finish=advance)

    def _finish(self, identifier, status, error=None, candidate_id=None):
        def finish(row, values):
            if row.status == 'stopping':
                row.status = 'cancelled'
            else:
                row.status = status
            values['last_error'] = error
            if candidate_id is not None:
                values['candidate_model_version_id'] = candidate_id
            row.active_slot = None
            row.lease_owner = None
            row.lease_expires_at = None
        self._change(identifier, 'worker_'+status, finish)

    def run_once(self):
        identifier = self.claim_once()
        if identifier is None:
            return False
        try:
            while True:
                self._pulse(identifier)
                next_round = self._new_round(identifier)
                if next_round is None:
                    break
                round_id, manifest, sources, actor_id = next_round
                self._reserve(identifier, manifest, sources, actor_id)
                receipt = self.runtime(manifest,
                    lambda event:self._gate(identifier, manifest, sources, event),
                    lambda:self._pulse(identifier))
                self._commit_round(identifier, round_id, manifest, sources, receipt)
            self._pulse(identifier)
            if self.candidate_preparer is None:
                from backend.app.services.federated_candidate_service import prepare_candidate
            else:
                prepare_candidate = self.candidate_preparer
            result = self._prepare_with_heartbeat(prepare_candidate, identifier)
            self._pulse(identifier)
            if not isinstance(result, dict) or type(result.get('model_version_id')) is not int:
                raise RecordIntegrityError('Candidate preparation did not return a verified model version.')
            self._finish(identifier, 'completed', candidate_id=result['model_version_id'])
        except LeaseLost:
            # The new lease owner alone may abort or publish this attempt.
            LOGGER.info('Federated lease lost; old attempt cannot publish.')
        except Exception as error:
            try:
                self._abort_unfinished(identifier, 'stopped' if isinstance(error, StopRequested) else type(error).__name__)
                if isinstance(error, WorkerShutdown):
                    def release(row, values):
                        row.lease_expires_at = _now()-timedelta(seconds=1)
                    self._change(identifier, 'worker_shutdown_resumable', release)
                    return True
                status = 'cancelled' if isinstance(error, StopRequested) and not self._stop.is_set() else 'failed'
                if isinstance(error, HTTPException) and '预算' in str(error.detail):
                    status = 'budget_exhausted'
                self._finish(identifier, status, error={'code':type(error).__name__,
                    'message':'实验已停止；保留最后提交聚合与全部保守预算，可核对原始审计。'})
            except LeaseLost:
                pass
        return True

    def _prepare_with_heartbeat(self, prepare, identifier):
        completed = threading.Event()
        failures = []
        def heartbeat():
            while not completed.wait(min(2., self.lease_seconds/3)):
                try:
                    self._pulse(identifier)
                except Exception as error:
                    failures.append(error)
                    return
        thread = threading.Thread(target=heartbeat, name='federated-candidate-lease', daemon=True)
        thread.start()
        try:
            result = prepare(self.session_factory, identifier, self.owner)
            if failures:
                raise failures[0]
            return result
        finally:
            completed.set()
            thread.join(timeout=5)

    def _stdio_round(self, manifest, authorize, pulse):
        """Framed RPC to the pinned interpreter, with a bounded watchdog."""
        interpreter = Path(settings.FEDERATED_PYTHON).resolve()
        pinned = (experiments.ROOT/'.venv-federated/Scripts/python.exe').resolve()
        if interpreter != pinned or not interpreter.is_file():
            raise RuntimeError('Use the unchanged isolated .venv-federated interpreter.')
        manifest_file = Path(manifest['output_directory']).parent/(manifest['attempt']+'-request.json')
        manifest_file.write_bytes(_canonical(manifest))
        log_file = manifest_file.with_suffix('.stderr.txt')
        received = queue.Queue(maxsize=8)
        with log_file.open('wb') as stderr:
            child = subprocess.Popen([str(interpreter), '-B', '-u', '-m', 'federated_runtime.project_round',
                '--manifest', str(manifest_file), '--gate-stdio'], cwd=experiments.ROOT,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                env={**os.environ, 'FLWR_TELEMETRY_ENABLED':'0', 'OMP_NUM_THREADS':'1', 'MKL_NUM_THREADS':'1'})
            def reader():
                try:
                    while True:
                        received.put((True, json.loads(read_frame(child.stdout))))
                except Exception as error:
                    received.put((False, error))
            threading.Thread(target=reader, name='federated-framed-reader', daemon=True).start()
            started, last_pulse = time.monotonic(), 0.
            try:
                while True:
                    now = time.monotonic()
                    if now-started > self.round_timeout:
                        raise TimeoutError('The bounded federated round deadline expired.')
                    if now-last_pulse >= min(2., self.lease_seconds/3):
                        pulse()
                        last_pulse = now
                    try:
                        success, message = received.get(timeout=.25)
                    except queue.Empty:
                        continue
                    if not success:
                        raise message
                    if message.get('type') == 'authorization_gate':
                        event = message['event']
                        accepted = False
                        try:
                            accepted = authorize(event) is True
                        finally:
                            ack = {key:event[key] for key in ('experiment_id','round','attempt','node_id','seq')}
                            write_frame(child.stdin, _canonical({**ack, 'authorized':accepted}))
                    elif message.get('type') == 'round_result':
                        result = message['receipt']
                        child.wait(timeout=5)
                        if child.returncode not in (0, 2):
                            raise RuntimeError('The isolated runtime exited without a valid receipt.')
                        return result
                    else:
                        raise RecordIntegrityError('Unknown message in the bounded runtime protocol.')
            finally:
                if child.poll() is None:
                    # Only this launched process tree is terminated; no broad scan.
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'],
                            capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
                    else:
                        child.kill()
                    child.wait(timeout=5)
                child.stdin.close()
                child.stdout.close()
