"""Persist first; process and revalidate independently from ordinary submissions."""
from datetime import datetime, timedelta, timezone
from secrets import token_hex
from time import monotonic
from logging import getLogger
from traceback import extract_tb
from concurrent.futures import ThreadPoolExecutor, wait
from threading import Lock, Event
from fastapi import HTTPException
from sqlalchemy import select, update
from backend.app.models.agent import AgentRun, AIArtifact, metadata, run_state
from backend.app.models.user import User
from backend.app.schemas.agent import AgentRunCreate
from backend.app.services.agent.context import build_context
from backend.app.services.agent.tools import _process
from backend.app.services.agent.artifacts import rule_artifact, RULES_VERSION, INTENT_TO_TOOL
from backend.app.services.agent.validators import validate_tool, validate_artifact
from backend.app.services import review_service, care_plan_service, assessment_service
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.attention_action_service import _original
from backend.app.services.identity_access import recheck_request_authority
from backend.app.services.agent.provider_authority import (external_snapshot, check_external, MESSAGE_POLICY,
    DIALOGUE_POLICY, validate_dialogue_ids, validate_dialogue_preview)
from backend.app.services.agent.artifacts import execute_tool
from backend.app.core.config import settings

MAX_ROUNDS = 3
MAX_TOOLS = 6
MAX_RUN_SECONDS = 60
MAX_MODEL_SECONDS = 20
_schedule_lock = Lock()
_executor = None
_executor_stop = None
_scheduled = {}


def schedule_run(session_factory, identifier):
    """Use a separate bounded pool; an AI job never occupies API worker slots."""
    global _executor, _executor_stop
    with _schedule_lock:
        if identifier in _scheduled:
            return True
        if len(_scheduled) >= 64:
            return False
        if _executor is None:
            _executor_stop = Event()
            _executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='unified-agent')
        future = _executor.submit(execute_one, session_factory, identifier, stop_event=_executor_stop)
        _scheduled[identifier] = future
    def released(done):
        with _schedule_lock:
            _scheduled.pop(identifier, None)
    future.add_done_callback(released)
    return True


def shutdown_background(timeout=5):
    global _executor
    with _schedule_lock:
        executor = _executor; _executor = None; pending = list(_scheduled.values())
        if _executor_stop is not None:
            _executor_stop.set()
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)
    if pending:
        wait(pending, timeout=timeout)
    return not any(not future.done() for future in pending)


def _authority(db, saved):
    _original(db, saved['authorization_snapshot'])
    if saved['credential_snapshot']:
        care_plan_service._original_credentials(db, saved['credential_snapshot'])


def _owned(db, user, identifier, frame=None):
    ref = db.execute(select(AgentRun.actor_user_id, AgentRun.patient_id).where(AgentRun.id == identifier)).first()
    if ref is None:
        raise HTTPException(404, 'Agent run not found.')
    if ref.actor_user_id != user.id:
        raise HTTPException(403, 'This private Agent run belongs to another actual actor.')
    if frame is None:
        frame = build_context(db, user, ref.patient_id)
    elif frame['actor_user_id'] != user.id or frame['patient_id'] != ref.patient_id:
        raise HTTPException(403, 'The private Agent history is outside the current profile.')
    return db.get(AgentRun, identifier, populate_existing=True), frame


def accepted_ack(row):
    return {'id': row.id, 'run_id': row.id, **row.snapshot['ack'], 'accepted': True, 'submission_status': 'committed', 'legacy': False}


def _dialogue_preview(db, user, frame, identifiers):
    """Read complete actor-owned ordinary answers; never accept client text."""
    turns = []
    for identifier in validate_dialogue_ids(identifiers):
        row, _ = _owned(db, user, identifier, frame)
        if row.intent != 'question':
            raise HTTPException(422, 'Only ordinary question runs can be selected as conversation.')
        if row.status != 'completed' or row.artifact_id is None:
            raise HTTPException(409, 'Select only completed question runs with a complete original answer.')
        original = row.snapshot['request']
        artifact = db.get(AIArtifact, row.artifact_id, populate_existing=True)
        if (original.get('intent') != 'question' or original.get('patient_id') != frame['patient_id'] or
                artifact is None or (artifact.run_id, artifact.actor_user_id, artifact.patient_id, artifact.kind, artifact.input_digest) !=
                (row.id, user.id, frame['patient_id'], 'question', row.input_digest) or artifact.snapshot['body'].get('kind') != 'question'):
            raise HTTPException(409, 'The selected conversation and its original answer association disagree.')
        turns.append({'run_id': row.id, 'user_message': original.get('message'), 'assistant_message': artifact.snapshot['body'].get('reply')})
    value = {'policy_version': DIALOGUE_POLICY, 'turns': turns}
    return validate_dialogue_preview({**value, 'digest': canonical_digest(value)}, identifiers)


def _check_dialogue(db, user, frame, request, preview):
    identifiers = request.get('context_run_ids') or []
    if identifiers:
        validate_dialogue_preview(preview, identifiers)
        signed = review_service._decode(request['run_context'], 'unified-agent-run-context')
        if (signed.get('conversation_preview') != preview or signed.get('actor_user_id') != user.id or
                signed.get('patient_id') != frame['patient_id']):
            raise HTTPException(409, 'The frozen dialogue differs from the original signed preview.')
        if _dialogue_preview(db, user, frame, identifiers) != preview:
            raise HTTPException(409, 'The selected original dialogue differs from the confirmed preview.')
    elif preview is not None:
        raise HTTPException(409, 'The original preview selected different conversation runs.')


@review_service.storage_boundary
def run_context(db, user, patient_id, *, question_mode=None, context_run_ids=None):
    frame = build_context(db, user, patient_id); _process(db, user, patient_id)
    from backend.app.db.agent_migration import require_agent_schema
    require_agent_schema(db.connection())
    identifiers = validate_dialogue_ids(context_run_ids)
    if identifiers and question_mode != 'smart':
        raise HTTPException(422, 'Select smart questions before previewing conversation for external sending.')
    preview = _dialogue_preview(db, user, frame, identifiers) if identifiers else None
    external = None if question_mode == 'local' else external_snapshot(db, patient_id, frame,
        field_policy=(DIALOGUE_POLICY if identifiers else MESSAGE_POLICY) if question_mode == 'smart' else None)
    value = {'purpose': 'unified_agent_run', 'context_version': 1, 'actor_user_id': user.id, 'role': frame['role'],
        'patient_id': patient_id, 'input_digest': frame['input_digest'], 'authorization_snapshot': assessment_service.authorization_snapshot(db),
        'credential_snapshot': care_plan_service._credentials(db), 'external_ai': external}
    if question_mode is not None:
        value['question_mode'] = question_mode
    if preview is not None:
        value['conversation_preview'] = preview
    provider_status = None
    if question_mode == 'smart':
        from backend.app.services.agent.provider import _budget, ProviderFailure
        provider_status = 'ready' if settings.DEEPSEEK_API_KEY else 'provider_not_configured'
        if provider_status == 'ready':
            try:
                _budget(settings)
            except ProviderFailure:
                provider_status = 'budget_not_configured'
    review_service._audit(db, user, patient_id, 'data_read', {'scope': 'agent_run_preflight', 'input_digest': frame['input_digest']})
    return {**value, 'run_context': review_service._encode(value, 'unified-agent-run-context'), 'run_context_digest': canonical_digest(value),
        **({'question_provider_status': provider_status} if provider_status is not None else {}),
        'limits': {'max_model_rounds': MAX_ROUNDS, 'max_tool_calls': MAX_TOOLS, 'max_run_seconds': MAX_RUN_SECONDS, 'max_model_seconds': MAX_MODEL_SECONDS}}


@review_service.storage_boundary
def enqueue_run(db, user, payload):
    supplied = set(payload.model_fields_set if hasattr(payload, 'model_fields_set') else payload)
    payload = review_service._validate(AgentRunCreate, payload); values = payload.model_dump()
    # Preserve the exact original body/ACK of clients predating this optional field.
    for field in ('external_message_consent', 'context_run_ids'):
        if field not in supplied:
            values.pop(field)
    from backend.app.db.agent_migration import require_agent_schema
    require_agent_schema(db.connection())
    if not payload.message.strip():
        raise HTTPException(422, 'An actual question or explicit draft request is required.')
    previous = db.scalar(select(AgentRun).where(AgentRun.client_run_id == payload.client_run_id))
    if previous:
        actual, _ = _owned(db, user, previous.id)
        if actual.request_digest != canonical_digest(values):
            raise HTTPException(409, 'This original Agent run ID belongs to different immutable input.')
        _authority(db, actual.snapshot['authority'])
        review_service._audit(db, user, actual.patient_id, 'agent_run_retry_ack', {'run_id': actual.id})
        return accepted_ack(actual), False
    frame = build_context(db, user, payload.patient_id); _process(db, user, payload.patient_id)
    ctx = review_service._decode(payload.run_context, 'unified-agent-run-context')
    if any(ctx.get(key) != value for key, value in {'purpose': 'unified_agent_run', 'context_version': 1,
            'actor_user_id': user.id, 'role': frame['role'], 'patient_id': payload.patient_id, 'input_digest': payload.expected_context_digest}.items()):
        raise HTTPException(409, 'Agent request differs from its actual actor, profile or preflight.')
    authority = {key: ctx[key] for key in ('authorization_snapshot', 'credential_snapshot')}
    authority['external_ai'] = ctx.get('external_ai')
    preview = ctx.get('conversation_preview')
    if payload.context_run_ids and payload.intent != 'question':
        raise HTTPException(422, 'Selected conversation is only available for ordinary questions.')
    _check_dialogue(db, user, frame, values, preview)
    if payload.external_message_consent is not None:
        policy = DIALOGUE_POLICY if payload.context_run_ids else MESSAGE_POLICY
        if (payload.intent != 'question' or payload.external_message_consent.confirmed is not True or ctx.get('question_mode') != 'smart' or
                payload.external_message_consent.version != policy):
            raise HTTPException(422, 'Confirm this question with a fresh smart-question context before sending its text.')
        if authority['external_ai'] is None or authority['external_ai'].get('field_policy_version') != policy:
            raise HTTPException(403, 'External AI care/message consent from the user or verified guardian is required.')
    elif ctx.get('question_mode') == 'smart' or payload.context_run_ids:
        raise HTTPException(422, 'This smart-question request has no explicit permission for its current message.')
    _authority(db, authority)
    if authority['external_ai'] is not None:
        check_external(db, payload.patient_id, frame, authority['external_ai'])
    if frame['input_digest'] != payload.expected_context_digest:
        raise HTTPException(409, 'Business input changed; read the current context before starting a new run.')
    validate_tool(frame, INTENT_TO_TOOL[payload.intent], {'patient_id': payload.patient_id,
        'assessment_id': payload.assessment_id, 'cycle_id': payload.cycle_id})
    row = AgentRun(client_run_id=payload.client_run_id, actor_user_id=user.id, patient_id=payload.patient_id, intent=payload.intent,
        input_digest=payload.expected_context_digest, request_digest=canonical_digest(values), authority_digest=canonical_digest(authority),
        created_at=datetime.now(timezone.utc).replace(microsecond=0), status='queued', mode='pending', model_name=None,
        model_round_count=0, tool_count=0, duration_ms=0, prompt_tokens=0, completion_tokens=0, estimated_cost_microunits=0,
        attempt_count=0, error_code=None, lease_token=None, lease_expires_at=None, artifact_id=None)
    row.snapshot = {'metadata': metadata(row), 'request': values, 'authority': authority, 'frame': frame,
        'ack': {'client_run_id': payload.client_run_id, 'actor_user_id': user.id, 'patient_id': payload.patient_id,
            'input_digest': row.input_digest, 'request_digest': row.request_digest, 'run_context_digest': canonical_digest(ctx),
            'requested_at': metadata(row)['created_at'], 'original_request': values}}
    if preview is not None:
        row.snapshot = {**row.snapshot, 'conversation_preview': preview}
    row.state_snapshot = run_state(row); db.add(row); db.flush()
    review_service._audit(db, user, payload.patient_id, 'agent_run_queued', {'run_id': row.id, 'intent': row.intent, 'input_digest': row.input_digest})
    return accepted_ack(row), True


@review_service.storage_boundary
def query_original(db, user, client_id):
    ref = db.scalar(select(AgentRun.id).where(AgentRun.client_run_id == client_id))
    if ref is None:
        raise HTTPException(404, 'The original Agent run ID has not been committed.')
    row, _ = _owned(db, user, ref)
    review_service._audit(db, user, row.patient_id, 'data_read', {'scope': 'agent_original_ack', 'run_id': row.id})
    return accepted_ack(row)


@review_service.storage_boundary
def get_run(db, user, identifier, frame=None):
    row, frame = _owned(db, user, identifier, frame)
    from backend.app.db.session import SessionLocal
    authority_changed = False
    with SessionLocal() as checker:
        try:
            _authority(checker, row.snapshot['authority'])
            if row.snapshot['authority'].get('external_ai') is not None:
                check_external(checker, row.patient_id, frame, row.snapshot['authority']['external_ai'])
        except HTTPException as exc:
            if exc.status_code not in {403, 409}:
                raise
            authority_changed = True
    artifact = None
    if row.artifact_id is not None:
        saved = db.get(AIArtifact, row.artifact_id, populate_existing=True)
        if saved is None or (saved.run_id, saved.actor_user_id, saved.patient_id, saved.input_digest) != (row.id, user.id, row.patient_id, row.input_digest):
            raise HTTPException(503, 'The Agent run and immutable draft association disagree.')
        artifact = {'id': saved.id, 'run_id': row.id, 'patient_id': row.patient_id, 'actor_user_id': user.id,
            'kind': saved.kind, 'status': 'draft', 'input_digest': saved.input_digest, 'source_refs': saved.snapshot['source_refs'],
            'body': saved.snapshot['body'], 'rules_version': saved.rules_version, 'model_name': saved.model_name,
            'stale': authority_changed or frame['input_digest'] != saved.input_digest,
            'stale_reason': 'authority_changed' if authority_changed else 'input_changed' if frame['input_digest'] != saved.input_digest else None}
        from backend.app.models.agent import ArtifactDecision
        latest=db.scalar(select(ArtifactDecision).where(ArtifactDecision.artifact_id==saved.id).order_by(ArtifactDecision.version.desc()))
        artifact['latest_decision']=None if latest is None else {'id':latest.id,'version':latest.version,'decision':latest.decision,
            'target_type':latest.target_type,'created_at':latest.snapshot['ack']['created_at']}
    review_service._audit(db, user, row.patient_id, 'data_read', {'scope': 'private_agent_run', 'run_id': row.id})
    return {'id': row.id, 'run_id': row.id, 'client_run_id': row.client_run_id, 'actor_user_id': user.id, 'patient_id': row.patient_id,
        **{key: value for key, value in run_state(row).items() if key not in {'lease_token', 'lease_expires_at'}},
        'input_digest': row.input_digest, 'intent': row.intent, 'original_message': row.snapshot['request']['message'],
        **({'context_run_ids': row.snapshot['request']['context_run_ids']} if 'context_run_ids' in row.snapshot['request'] else {}),
        'question_mode': ('smart' if row.snapshot['request'].get('external_message_consent') else 'local') if row.intent == 'question' else None,
        'artifact': artifact}


@review_service.storage_boundary
def list_runs(db, user, patient_id):
    frame = build_context(db, user, patient_id)
    identifiers = db.scalars(select(AgentRun.id).where(AgentRun.actor_user_id == user.id, AgentRun.patient_id == patient_id)
        .order_by(AgentRun.id.desc()).limit(10)).all()
    return {'patient_id': patient_id, 'actor_user_id': user.id, 'items': [get_run(db, user, identifier, frame) for identifier in reversed(identifiers)]}


def _lock(db, identifier):
    db.execute(update(AgentRun).where(AgentRun.id == identifier).values(id=AgentRun.id))
    return db.get(AgentRun, identifier, populate_existing=True)


def _seal_state(row):
    row.state_snapshot = run_state(row)


def _internal_failure(session_factory, identifier, code, *, token=None, duration_ms=0, metrics=None):
    with session_factory() as db:
        with db.begin():
            row = _lock(db, identifier)
            if row is None or row.status in {'completed', 'failed', 'stale'} or token is not None and row.lease_token != token:
                return
            row.status = 'stale' if code in {'authority_changed', 'input_changed'} else 'failed'
            row.error_code = code; row.duration_ms = duration_ms; row.lease_token = None; row.lease_expires_at = None
            if metrics:
                row.model_round_count = metrics.get('model_round_count', 0); row.tool_count = metrics.get('tool_count', 0)
                row.prompt_tokens = metrics.get('prompt_tokens', 0); row.completion_tokens = metrics.get('completion_tokens', 0)
                row.estimated_cost_microunits = metrics.get('cost_microunits', 0) if metrics.get('usage_complete',True) else max(row.estimated_cost_microunits,metrics.get('cost_microunits',0))
                row.model_name = metrics.get('model_name')
            _seal_state(row)
            from backend.app.services.security_service import _append_audit_log
            _append_audit_log(db, action='agent_run_stopped', status=row.status, actor_user_id=None, patient_id=row.patient_id,
                message='后台助手运行停止，未发布业务意见或计划。', detail_json={'system_principal': 'unified_agent_runner', 'run_id': row.id, 'code': code})


def execute_one(session_factory, identifier, *, stop_event=None):
    """CAS/lease-owned background execution; failures never alter clinical work."""
    started = monotonic(); lease = None; metrics = {}
    def running():
        if stop_event is not None and stop_event.is_set():
            raise RuntimeError('runner_shutdown')
    try:
        running()
        with session_factory() as db:
            with db.begin():
                row = _lock(db, identifier)
                if row is None or row.status in {'completed', 'failed', 'stale'}:
                    return False
                now = datetime.now(timezone.utc)
                expiry = row.lease_expires_at
                if row.status == 'running' and expiry and (expiry if expiry.tzinfo else expiry.replace(tzinfo=timezone.utc)) > now:
                    return False
                if row.model_round_count > 0:
                    raise RuntimeError('provider_outcome_unknown')
                if row.attempt_count >= 3:
                    raise RuntimeError('run_attempt_limit')
                user = db.get(User, row.actor_user_id)
                if user is None or not user.is_active:
                    raise HTTPException(403, 'Actual Agent actor no longer active.')
                _authority(db, row.snapshot['authority']); frame = build_context(db, user, row.patient_id); _process(db, user, row.patient_id)
                if frame['input_digest'] != row.input_digest:
                    raise HTTPException(409, 'input_changed')
                request = row.snapshot['request']; authority = row.snapshot['authority']; lease = token_hex(24)
                preview = row.snapshot.get('conversation_preview')
                _check_dialogue(db, user, frame, request, preview)
                if authority.get('external_ai') is not None:
                    check_external(db, row.patient_id, frame, authority['external_ai'])
                row.status = 'running'; row.lease_token = lease; row.lease_expires_at = now + timedelta(seconds=75); row.attempt_count += 1; _seal_state(row)
                review_service._audit(db, user, row.patient_id, 'agent_run_started', {'run_id': row.id})
                recheck_request_authority(db)
        execution_request = {**request, '_conversation_preview': preview} if preview is not None else request
        body, references, tool_count = rule_artifact(frame, execution_request)
        mode, model_name, reason = 'rules', None, 'external_ai_not_consented' if authority.get('external_ai') is None else 'provider_not_configured'
        metrics = {'model_round_count': 0, 'prompt_tokens': 0, 'completion_tokens': 0, 'cost_microunits': 0}
        def revalidate(*, tool=None, arguments=None, reservation=None):
            running()
            if monotonic() - started >= MAX_RUN_SECONDS:
                raise RuntimeError('run_budget_exceeded')
            with session_factory() as checker:
                actual = checker.get(User, frame['actor_user_id'])
                if actual is None or not actual.is_active:
                    raise HTTPException(403, 'Actual Agent actor no longer active.')
                _authority(checker, authority)
                fresh = build_context(checker, actual, frame['patient_id']); _process(checker, actual, frame['patient_id'])
                if fresh['input_digest'] != frame['input_digest']:
                    raise HTTPException(409, 'input_changed')
                check_external(checker, frame['patient_id'], fresh, authority.get('external_ai'))
                _check_dialogue(checker, actual, fresh, request, preview)
                if reservation:
                    run=_lock(checker,identifier)
                    if run.status != 'running' or run.lease_token != lease or reservation['model_round_count'] != run.model_round_count+1 or run.model_round_count >= MAX_ROUNDS:
                        raise HTTPException(409,'The original Agent dispatch lease or reserved model budget changed.')
                    run.model_round_count=reservation['model_round_count']; run.model_name=settings.DEEPSEEK_CHAT_MODEL
                    run.prompt_tokens=reservation['prompt_tokens']; run.completion_tokens=reservation['completion_tokens']; run.tool_count=reservation['tool_count']
                    run.estimated_cost_microunits=reservation['reserved_cost_microunits']; _seal_state(run)
                value = execute_tool(fresh, tool, arguments, request=request) if tool else None
                review_service._audit(checker, actual, frame['patient_id'], 'agent_tool_read' if tool else 'agent_external_dispatch',
                    {'run_id': identifier, 'input_digest': frame['input_digest'], 'tool': tool,
                        'argument_digest': canonical_digest(arguments) if tool else None,
                        'external_consent_id': authority['external_ai']['id'],
                        'field_policy_version': authority['external_ai']['field_policy_version'],
                        **({'context_run_ids': request['context_run_ids'], 'conversation_digest': preview['digest']} if preview is not None else {}),
                        'model_name': settings.DEEPSEEK_CHAT_MODEL, 'dispatch_reservation':reservation})
                recheck_request_authority(checker)
                checker.commit()
                return value
        def authorized_tool(name, arguments):
            return revalidate(tool=name, arguments=arguments)
        wants_provider = request['intent'] != 'question' or request.get('external_message_consent') is not None
        if not wants_provider:
            reason = 'local_question_selected'
        if wants_provider and authority.get('external_ai') is not None and settings.DEEPSEEK_API_KEY:
            from backend.app.services.agent.provider import run_provider, ProviderFailure
            try:
                body, references, metrics = run_provider(frame, request, settings=settings, authorize_dispatch=revalidate,
                    execute_authorized_tool=authorized_tool, deadline=started + MAX_RUN_SECONDS, base_artifact=(body, references, tool_count),
                    **({'conversation_preview': preview} if preview is not None else {}))
                mode, model_name, reason = 'remote', metrics['model_name'], None
                tool_count = metrics['tool_count']
            except ProviderFailure as exc:
                metrics = exc.metrics; reason = exc.code
                tool_count = max(tool_count, metrics.get('tool_count', 0))
                body = {**body, 'fallback_reason': reason}
                if metrics.get('usage_complete') is False:
                    body['provider_usage_status']='unconfirmed_reservation_retained'
        running()
        if tool_count > MAX_TOOLS or monotonic() - started >= MAX_RUN_SECONDS:
            raise RuntimeError('run_budget_exceeded')
        with session_factory() as db:
            with db.begin():
                row = _lock(db, identifier)
                if row is None or row.status != 'running' or row.lease_token != lease:
                    return False
                user = db.get(User, row.actor_user_id)
                if user is None or not user.is_active:
                    raise HTTPException(403, 'Actual Agent actor no longer active.')
                _authority(db, row.snapshot['authority']); current = build_context(db, user, row.patient_id); _process(db, user, row.patient_id)
                if authority.get('external_ai') is not None:
                    check_external(db, row.patient_id, current, authority['external_ai'])
                _check_dialogue(db, user, current, request, preview)
                if current['input_digest'] != row.input_digest:
                    raise HTTPException(409, 'input_changed')
                validate_artifact(current, body, references)
                if preview is not None:
                    body = {**body, 'conversation_context': {'run_ids': request['context_run_ids'], 'digest': preview['digest']}}
                elapsed = int((monotonic() - started) * 1000)
                if elapsed >= MAX_RUN_SECONDS * 1000:
                    raise RuntimeError('run_budget_exceeded')
                artifact = AIArtifact(run_id=row.id, actor_user_id=user.id, patient_id=row.patient_id, kind=row.intent,
                    input_digest=row.input_digest, body_digest=canonical_digest(body), source_digest=canonical_digest(references),
                    rules_version=RULES_VERSION, model_name=model_name, created_at=datetime.now(timezone.utc).replace(microsecond=0))
                artifact.snapshot = {'metadata': metadata(artifact), 'body': body, 'source_refs': references}
                db.add(artifact); db.flush()
                running()
                row.status = 'completed'; row.mode = mode; row.error_code = reason
                row.model_name = model_name or metrics.get('model_name') if metrics.get('model_round_count', 0) else None
                row.model_round_count = metrics.get('model_round_count', 0)
                row.prompt_tokens = metrics.get('prompt_tokens', 0); row.completion_tokens = metrics.get('completion_tokens', 0)
                row.estimated_cost_microunits = metrics.get('cost_microunits', 0) if metrics.get('usage_complete',True) else max(row.estimated_cost_microunits,metrics.get('cost_microunits',0))
                row.artifact_id = artifact.id; row.tool_count = tool_count; row.duration_ms = elapsed
                row.lease_token = None; row.lease_expires_at = None; _seal_state(row)
                review_service._audit(db, user, row.patient_id, 'agent_draft_saved', {'run_id': row.id, 'artifact_id': artifact.id, 'mode': row.mode})
                recheck_request_authority(db)
        return True
    except HTTPException as exc:
        code = 'input_changed' if exc.status_code == 409 and exc.detail == 'input_changed' else 'authority_changed' if exc.status_code in {403, 409} else 'invalid_draft'
        try: _internal_failure(session_factory, identifier, code, token=lease, duration_ms=int((monotonic() - started) * 1000), metrics=getattr(exc, 'agent_metrics', metrics))
        except Exception: pass
    except Exception as exc:
        location = extract_tb(exc.__traceback__)[-1]
        getLogger('agent.runner').warning('Agent run stopped (%s at %s:%s).', type(exc).__name__, location.name, location.lineno)
        code = str(exc) if str(exc) in {'runner_shutdown', 'run_budget_exceeded', 'run_attempt_limit', 'provider_outcome_unknown'} else 'runner_failed'
        try: _internal_failure(session_factory, identifier, code, token=lease, duration_ms=int((monotonic() - started) * 1000), metrics=metrics)
        except Exception: pass
    return False
