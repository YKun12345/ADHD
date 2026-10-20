"""Doctor publication, receipt-only acknowledgements and real dated plan tasks."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import json
from uuid import uuid4
from fastapi import HTTPException
from sqlalchemy import select, update
from backend.app.models.care_plan import CarePlan, PlanVersion, PlanTask, PlanAcknowledgement, metadata, state
from backend.app.models.care_cycle import CareCycle, DailyRecord
from backend.app.models.review import ReportVersion
from backend.app.models.user import User
from backend.app.schemas.care_plan import PlanPublication, PlanReceipt
from backend.app.services import review_service as reviews
from backend.app.services.assessment_service import _bound_relationship, _doctor_processing, authorization_snapshot
from backend.app.services.identity_access import self_access, require_processing_access, require_patient_access, identity_basis
from backend.app.services.attention_action_service import _original, _historical_original
from backend.app.services.cognitive_contract import canonical_digest


def today():
    return datetime.now(timezone.utc).astimezone(ZoneInfo('Asia/Shanghai')).date()


def _credentials(db):
    return json.loads(json.dumps(db.info.get('credential_receipts') or [], default=lambda value: value.isoformat()))


def _original_credentials(db, snapshot):
    from backend.app.services.identity_access import recheck_authorities
    try:
        originals = [tuple([*row[:5], datetime.fromisoformat(row[5]) if isinstance(row[5], str) else row[5], row[6]]) for row in snapshot]
        if not originals:
            raise ValueError('Missing original institutional authority')
    except (TypeError, ValueError, IndexError) as exc:
        raise HTTPException(409, 'The original institutional plan context is incomplete.') from exc
    recheck_authorities(db, originals)
    current = db.info.setdefault('credential_receipts', [])
    current.extend(row for row in originals if row not in current)
    request = db.info.get('authorization_request')
    if request is not None:
        request.state.credential_receipts = current


def _root(db, assessment_id):
    return db.scalar(select(CarePlan).where(CarePlan.assessment_id == assessment_id).execution_options(populate_existing=True))


def _load(db, identifier):
    row = db.get(CarePlan, identifier, populate_existing=True)
    if row is None:
        raise HTTPException(404, 'Doctor plan not found.')
    return row


def _versions(db, plan):
    rows = db.scalars(select(PlanVersion).where(PlanVersion.plan_id == plan.id).order_by(PlanVersion.version)).all()
    if rows and (plan.current_plan_version_id != rows[-1].id or [row.version for row in rows] != list(range(1, len(rows) + 1))):
        raise HTTPException(503, 'The authenticated plan head and immutable version history disagree.')
    return rows


def _access(db, user, plan):
    if self_access(db, user.id, plan.patient_id):
        require_patient_access(db, user, plan.patient_id, {'assessment', 'tracking'})
    else:
        reviews._doctor_authority(db, user, reviews._assessment(db, plan.assessment_id), historical=True)
        require_patient_access(db, user, plan.patient_id, 'tracking', relationship_id=plan.relationship_id)
        _historical_original(db, plan.snapshot['authorization_snapshot'])


def _processing(db, user, plan):
    if plan.status != 'active':
        raise HTTPException(409, 'This original doctor plan is suspended or ended; it does not resume through a new grant.')
    if self_access(db, user.id, plan.patient_id):
        require_processing_access(db, user, plan.patient_id, {'assessment', 'tracking'})
    elif user.id != plan.responsible_doctor_id:
        raise HTTPException(403, 'Only the original responsible doctor or actual patient may process this plan.')
    session = reviews._assessment(db, plan.assessment_id)
    if session.status in {'suspended', 'cancelled'}:
        raise HTTPException(409, 'The original assessment authority is unavailable.')
    doctor = db.get(User, plan.responsible_doctor_id)
    _doctor_processing(db, doctor, plan.patient_id, relationship_id=plan.relationship_id)
    require_patient_access(db, doctor, plan.patient_id, 'tracking', relationship_id=plan.relationship_id)
    if reviews._doctor_basis(db, doctor, session) != plan.snapshot['actor_identity_basis']:
        raise HTTPException(409, 'The original plan doctor qualification or relationship has changed.')
    _original(db, plan.snapshot['authorization_snapshot'])
    _original_credentials(db, plan.snapshot['credential_snapshot'])


def suspend_plan(db, plan, reason, *, at=None, source_event_id=None):
    if plan.status != 'active':
        return
    plan.status = 'suspended'; plan.suspension_reason = reason; plan.revision += 1; plan.state_snapshot = state(plan)
    from backend.app.models.care_system_event import CareSystemEvent
    now = at or datetime.now(timezone.utc).replace(microsecond=0)
    key = f'plan_suspended:{plan.id}:{plan.revision}'
    if db.scalar(select(CareSystemEvent.id).where(CareSystemEvent.dedupe_key == key)) is None:
        row = CareSystemEvent(event_id=uuid4().hex, patient_id=plan.patient_id, assessment_id=plan.assessment_id,
            system_principal='care_plan_authority_guard', event_type='professional_plan_suspended', revision=plan.revision,
            observed_at=now, dedupe_key=key, payload={})
        from backend.app.services.care_authority_reconciliation import _context
        row.payload = {'context_snapshot': _context(row), 'plan_id': plan.id, 'reason': reason, 'source_event_id': source_event_id,
            'plan_revision': plan.revision, 'human_action': False, 'external_notification_sent': False}
        db.add(row)
        from backend.app.services.security_service import _append_audit_log
        _append_audit_log(db, action='professional_plan_suspended', status='suspended', actor_user_id=None,
            patient_id=plan.patient_id, message='原专业计划权限已失效，后续安排暂停，已执行原件保留。',
            detail_json={'plan_id': plan.id, 'system_event_id': row.event_id, 'reason': reason, 'system_principal': row.system_principal})


def _availability(db, user, plan):
    if plan.status != 'active':
        return False
    previous = {key: list(db.info.get(key) or []) for key in ('authorization_receipts', 'credential_receipts')}
    previous['requires_basic_use'] = db.info.get('requires_basic_use', False)
    denied = None
    try:
        _processing(db, user, plan)
    except HTTPException as exc:
        if exc.status_code not in {403, 409}:
            raise
        denied = 'original_authority_invalid'
    finally:
        for key, value in previous.items():
            db.info[key] = value
        request = db.info.get('authorization_request')
        if request is not None:
            request.state.authorization_receipts = db.info.get('authorization_receipts') or []
    if denied:
        suspend_plan(db, plan, denied)
    return denied is None


def _cycle(db, version):
    from backend.app.services.care_cycle_service import _verify
    cycle = db.scalar(select(CareCycle).where(CareCycle.plan_version_id == version.id))
    if cycle is None:
        raise HTTPException(503, 'The published plan has no authenticated actual cycle.')
    _verify(cycle)
    if (cycle.patient_id, cycle.responsible_doctor_id, cycle.cycle_type) != (version.patient_id, version.actor_user_id, 'professional'):
        raise HTTPException(503, 'The plan version and cycle ownership disagree.')
    return cycle


def _ack(db, version):
    return {'id': version.id, **version.snapshot['ack'], 'cycle_id': _cycle(db, version).id, 'submission_status': 'committed', 'legacy': False}


@reviews.storage_boundary
def plan_context(db, user, identifier):
    session = reviews._assessment(db, identifier); reviews._doctor_authority(db, user, session)
    from backend.app.db.care_plan_migration import require_care_plan_schema
    require_care_plan_schema(db.connection())
    require_patient_access(db, user, session.patient_id, 'tracking', relationship_id=_bound_relationship(session))
    report = db.scalar(select(ReportVersion).where(ReportVersion.assessment_id == session.id).order_by(ReportVersion.version.desc()))
    if report is None:
        raise HTTPException(409, 'Read and publish an actual doctor opinion before publishing its plan.')
    root = _root(db, session.id)
    if root:
        _processing(db, user, root)
    versions = _versions(db, root) if root else []
    ctx = {'purpose': 'care_plan_publication', 'context_version': 1, 'actor_user_id': user.id,
        'actor_identity_basis': reviews._doctor_basis(db, user, session), 'patient_id': session.patient_id, 'assessment_id': session.id,
        'assessment_version': session.version, 'expected_previous_version': versions[-1].version if versions else 0,
        'expected_plan_revision': root.revision if root else 0, 'source_report_id': report.id, 'source_report_digest': report.payload_digest,
        'input_digest': canonical_digest(reviews._snapshot(db, user, session)), 'authorization_snapshot': authorization_snapshot(db),
        'credential_snapshot': _credentials(db)}
    reviews._audit(db, user, session.patient_id, 'data_read', {'scope': 'doctor_plan_preflight', 'assessment_id': session.id})
    return {**ctx, 'plan_context': reviews._encode(ctx, 'care-plan-context'), 'plan_context_digest': canonical_digest(ctx),
        'calendar_today': today().isoformat(), 'calendar_timezone': 'Asia/Shanghai'}


def _new_cycle(db, version, ctx, now):
    from backend.app.services.care_cycle_service import _context, _CYCLE_CONTEXT
    from backend.app.core.record_envelope import seal_record
    from sqlalchemy.orm.attributes import set_committed_value
    cycle = CareCycle(client_cycle_id='plan-' + canonical_digest(version.client_plan_version_id)[:50], patient_id=version.patient_id,
        cycle_type='professional', start_date=version.start_date, end_date=version.end_date, calendar_timezone='Asia/Shanghai',
        actor_user_id=version.actor_user_id, actor_identity_basis=ctx['actor_identity_basis'], authorization_snapshot=ctx['authorization_snapshot'],
        responsible_doctor_id=version.actor_user_id, plan_version_id=version.id, created_at=now, snapshot={})
    db.add(cycle); db.flush()
    cipher = seal_record(_context(cycle, _CYCLE_CONTEXT), cycle._binding('snapshot'))
    db.execute(update(CareCycle).where(CareCycle.id == cycle.id).values(_snapshot_cipher=cipher).execution_options(synchronize_session=False))
    set_committed_value(cycle, '_snapshot_cipher', cipher)
    return cycle


@reviews.storage_boundary
def publish_plan(db, user, payload):
    payload = reviews._validate(PlanPublication, payload); values = payload.model_dump(mode='json')
    session = reviews._assessment(db, payload.assessment_id); reviews._doctor_authority(db, user, session)
    from backend.app.db.care_plan_migration import require_care_plan_schema
    require_care_plan_schema(db.connection())
    require_patient_access(db, user, session.patient_id, 'tracking', relationship_id=_bound_relationship(session))
    ctx = reviews._decode(payload.plan_context, 'care-plan-context')
    expected = {'actor_user_id': user.id, 'patient_id': payload.patient_id, 'assessment_id': payload.assessment_id,
        'assessment_version': payload.expected_assessment_version, 'expected_previous_version': payload.expected_previous_version,
        'expected_plan_revision': payload.expected_plan_revision, 'source_report_id': payload.source_report_id, 'input_digest': payload.input_digest}
    if session.patient_id != payload.patient_id or any(ctx.get(key) != value for key, value in expected.items()):
        raise HTTPException(409, 'Plan publication differs from its actual doctor preflight.')
    _original(db, ctx['authorization_snapshot'])
    _original_credentials(db, ctx.get('credential_snapshot'))
    existing = db.scalar(select(PlanVersion).where(PlanVersion.client_plan_version_id == payload.client_plan_version_id))
    if existing:
        if existing.actor_user_id != user.id or existing.payload_digest != canonical_digest(values):
            raise HTTPException(409, 'This original plan publication ID belongs to different confirmed content.')
        reviews._audit(db, user, session.patient_id, 'plan_retry_ack', {'plan_version_id': existing.id})
        return _ack(db, existing), False
    reviews._lock_inputs(db, session.id); session = reviews._assessment(db, session.id)
    root = _root(db, session.id); versions = _versions(db, root) if root else []
    if root:
        _processing(db, user, root)
    current = versions[-1].version if versions else 0
    report = db.scalar(select(ReportVersion).where(ReportVersion.assessment_id == session.id).order_by(ReportVersion.version.desc()))
    if (session.version != payload.expected_assessment_version or current != payload.expected_previous_version or
            (root.revision if root else 0) != payload.expected_plan_revision or report is None or report.id != payload.source_report_id or
            report.payload_digest != ctx.get('source_report_digest') or canonical_digest(reviews._snapshot(db, user, session)) != payload.input_digest):
        raise HTTPException(409, 'The plan, source opinion or evidence changed; reread and explicitly confirm.')
    if payload.start_date < today() or current and payload.start_date <= today():
        raise HTTPException(422, 'A first plan cannot invent past execution; revisions change future dates only.')
    if payload.source_ai_decision_id is not None:
        from backend.app.services.agent.artifact_decision_service import validate_adoption
        validate_adoption(db,user,payload.source_ai_decision_id,target_type='plan_publication',client_id=payload.client_plan_version_id,
            patient_id=session.patient_id,assessment_id=session.id,
            content={'title':payload.title,'instructions':payload.instructions,'source_report_id':payload.source_report_id})
    now = datetime.now(timezone.utc).replace(microsecond=0)
    if root is None:
        root = CarePlan(patient_id=session.patient_id, assessment_id=session.id, responsible_doctor_id=user.id,
            relationship_id=_bound_relationship(session), authority_digest=canonical_digest({key: ctx[key] for key in ('authorization_snapshot', 'credential_snapshot', 'actor_identity_basis')}),
            created_at=now, status='draft', revision=0, current_plan_version_id=None, suspension_reason=None)
        root.snapshot = {'metadata': metadata(root), 'authorization_snapshot': ctx['authorization_snapshot'],
            'credential_snapshot': ctx['credential_snapshot'], 'actor_identity_basis': ctx['actor_identity_basis']}
        root.state_snapshot = state(root); db.add(root); db.flush()
    version = PlanVersion(patient_id=session.patient_id, assessment_id=session.id, plan_id=root.id, actor_user_id=user.id,
        client_plan_version_id=payload.client_plan_version_id, version=current + 1, source_report_id=report.id,
        start_date=payload.start_date, end_date=payload.end_date, payload_digest=canonical_digest(values), published_at=now)
    ack = {key: value for key, value in values.items() if key != 'plan_context'}
    ack.update(plan_id=root.id, version=version.version, actor_user_id=user.id, actor_identity_basis=ctx['actor_identity_basis'],
        plan_revision=root.revision + 1, assessment_version=payload.expected_assessment_version + 1,
        plan_context_digest=canonical_digest(ctx), authorization_snapshot=ctx['authorization_snapshot'], payload_digest=version.payload_digest,
        published_at=reviews._utc(now), demonstration_only=session.demonstration_only, status='published', task_type='daily_record')
    version.snapshot = {'metadata': metadata(version), 'payload': values, 'ack': ack, 'authorization_snapshot': ctx['authorization_snapshot']}
    db.add(version); db.flush(); _new_cycle(db, version, ctx, now)
    for offset in range((version.end_date - version.start_date).days + 1):
        task = PlanTask(patient_id=version.patient_id, plan_version_id=version.id, record_date=version.start_date + timedelta(days=offset), task_type='daily_record')
        task.snapshot = {'metadata': metadata(task)}; db.add(task)
    root.status = 'active'; root.revision += 1; root.current_plan_version_id = version.id; root.state_snapshot = state(root)
    if db.execute(update(type(session)).where(type(session).id == session.id, type(session).version == payload.expected_assessment_version)
            .values(version=payload.expected_assessment_version + 1)).rowcount != 1:
        raise HTTPException(409, 'The assessment changed during plan publication.')
    from backend.app.services.event_service import append_care_event
    append_care_event(db, patient_id=session.patient_id, actor_user_id=user.id, event_type='professional_plan_published',
        aggregate_type='care_plan', aggregate_id=root.id, revision=version.version,
        payload={'plan_id': root.id, 'plan_version_id': version.id, 'assessment_id': session.id, 'authorization_snapshot': ctx['authorization_snapshot']},
        dedupe_key='plan_publication:' + payload.client_plan_version_id, actor_identity_basis=ctx['actor_identity_basis'])
    reviews._audit(db, user, session.patient_id, 'professional_plan_published', {'plan_id': root.id, 'plan_version_id': version.id})
    return _ack(db, version), True


def authorize_cycle(db, user, cycle, *, processing=False, record_date=None):
    version = db.get(PlanVersion, cycle.plan_version_id, populate_existing=True)
    if version is None or (version.patient_id, version.actor_user_id) != (cycle.patient_id, cycle.responsible_doctor_id):
        raise HTTPException(503, 'The actual professional cycle has no matching published plan.')
    plan = _load(db, version.plan_id); _access(db, user, plan)
    if processing:
        if not self_access(db, user.id, cycle.patient_id):
            raise HTTPException(403, 'Only the actual patient or verified guardian may record observations.')
        _processing(db, user, plan); _original(db, version.snapshot['authorization_snapshot'])
        if record_date is not None and any(candidate.version > version.version and candidate.start_date <= record_date for candidate in _versions(db, plan)):
            raise HTTPException(409, 'Use the actual revised plan cycle for this date; the old future schedule was superseded.')
    return plan, version


@reviews.storage_boundary
def get_plan(db, user, identifier):
    plan = _load(db, identifier); _access(db, user, plan); _availability(db, user, plan)
    versions = _versions(db, plan); tasks = []
    from backend.app.services.care_cycle_service import _verify
    for version in versions:
        cycle = _cycle(db, version)
        originals = db.scalars(select(DailyRecord).where(DailyRecord.cycle_id == cycle.id).order_by(DailyRecord.revision)).all()
        for record in originals:
            _verify(record)
        latest = {record.record_date: record for record in originals}
        for task in db.scalars(select(PlanTask).where(PlanTask.plan_version_id == version.id).order_by(PlanTask.record_date)).all():
            record = latest.get(task.record_date)
            superseded = any(candidate.version > version.version and candidate.start_date <= task.record_date for candidate in versions)
            status = 'completed' if record else 'superseded_future' if superseded else plan.status if plan.status != 'active' else 'overdue' if task.record_date < today() else 'pending'
            tasks.append({'id': task.id, **metadata(task), 'cycle_id': cycle.id, 'status': status, 'daily_record_id': record.id if record else None,
                'instructions': version.snapshot['ack']['instructions']})
    receipts = db.scalars(select(PlanAcknowledgement).where(PlanAcknowledgement.plan_version_id.in_([version.id for version in versions]))).all()
    reviews._audit(db, user, plan.patient_id, 'data_read', {'scope': 'doctor_plan', 'plan_id': plan.id})
    return {'id': plan.id, **metadata(plan), **state(plan), 'versions': [_ack(db, version) for version in versions],
        'tasks': tasks, 'acknowledgements': [{'id': row.id, **row.snapshot['ack']} for row in receipts]}


@reviews.storage_boundary
def list_plans(db, user, patient_id):
    require_patient_access(db, user, patient_id, {'assessment', 'tracking'})
    query = select(CarePlan).where(CarePlan.patient_id == patient_id)
    if not self_access(db, user.id, patient_id):
        query = query.where(CarePlan.responsible_doctor_id == user.id)
    return {'items': [get_plan(db, user, row.id) for row in db.scalars(query.order_by(CarePlan.id.desc())).all()]}


@reviews.storage_boundary
def query_plan_publication(db, user, client_id):
    row = db.scalar(select(PlanVersion).where(PlanVersion.client_plan_version_id == client_id))
    if row is None:
        raise HTTPException(404, 'This original plan publication ID has not been committed.')
    if row.actor_user_id != user.id:
        raise HTTPException(403, 'Only the actual publishing doctor may query the original confirmation.')
    _access(db, user, _load(db, row.plan_id)); _historical_original(db, row.snapshot['authorization_snapshot'])
    reviews._audit(db, user, row.patient_id, 'data_read', {'scope': 'plan_original_ack', 'plan_version_id': row.id})
    return _ack(db, row)


@reviews.storage_boundary
def acknowledgement_context(db, user, identifier):
    version = db.get(PlanVersion, identifier, populate_existing=True)
    if version is None:
        raise HTTPException(404, 'Plan version not found.')
    plan = _load(db, version.plan_id)
    if not self_access(db, user.id, plan.patient_id):
        raise HTTPException(403, 'The actual patient or verified guardian must acknowledge receipt.')
    _processing(db, user, plan)
    if plan.current_plan_version_id != version.id:
        raise HTTPException(409, 'Read and acknowledge the newly published version.')
    ctx = {'purpose': 'care_plan_received', 'context_version': 1, 'actor_user_id': user.id,
        'actor_identity_basis': identity_basis(db, user.id, plan.patient_id), 'patient_id': plan.patient_id, 'assessment_id': plan.assessment_id,
        'plan_version_id': version.id, 'version': version.version, 'plan_revision': plan.revision,
        'plan_payload_digest': version.payload_digest, 'authorization_snapshot': authorization_snapshot(db)}
    reviews._audit(db, user, plan.patient_id, 'data_read', {'scope': 'plan_receipt_preflight', 'plan_version_id': version.id})
    return {**ctx, 'acknowledgement_context': reviews._encode(ctx, 'care-plan-received-context'), 'acknowledgement_context_digest': canonical_digest(ctx)}


@reviews.storage_boundary
def acknowledge_plan(db, user, payload):
    payload = reviews._validate(PlanReceipt, payload); values = payload.model_dump()
    version = db.get(PlanVersion, payload.plan_version_id, populate_existing=True)
    if version is None:
        raise HTTPException(404, 'Plan version not found.')
    plan = _load(db, version.plan_id)
    if not self_access(db, user.id, plan.patient_id):
        raise HTTPException(403, 'Only the actual patient or verified guardian may record receipt.')
    _processing(db, user, plan)
    ctx = reviews._decode(payload.acknowledgement_context, 'care-plan-received-context')
    if any(ctx.get(key) != value for key, value in {'actor_user_id': user.id, 'patient_id': payload.patient_id, 'assessment_id': payload.assessment_id,
            'plan_version_id': version.id, 'plan_payload_digest': version.payload_digest}.items()) or payload.patient_id != plan.patient_id:
        raise HTTPException(409, 'Receipt differs from the original plan version or patient.')
    _original(db, ctx['authorization_snapshot'])
    existing = db.scalar(select(PlanAcknowledgement).where(PlanAcknowledgement.client_acknowledgement_id == payload.client_acknowledgement_id))
    if existing:
        if existing.actor_user_id != user.id or existing.payload_digest != canonical_digest(values):
            raise HTTPException(409, 'This receipt ID already belongs to different confirmed content.')
        reviews._audit(db, user, plan.patient_id, 'plan_receipt_retry_ack', {'receipt_id': existing.id})
        return {'id': existing.id, **existing.snapshot['ack'], 'submission_status': 'committed', 'legacy': False}, False
    reviews._lock_inputs(db, plan.assessment_id); plan = _load(db, plan.id)
    if plan.current_plan_version_id != version.id or plan.revision != ctx['plan_revision']:
        raise HTTPException(409, 'The plan changed before receipt confirmation.')
    if db.scalar(select(PlanAcknowledgement.id).where(PlanAcknowledgement.plan_version_id == version.id, PlanAcknowledgement.actor_user_id == user.id)):
        raise HTTPException(409, 'This actor already recorded receipt; read the original acknowledgement.')
    now = datetime.now(timezone.utc).replace(microsecond=0)
    row = PlanAcknowledgement(patient_id=plan.patient_id, plan_version_id=version.id, actor_user_id=user.id,
        client_acknowledgement_id=payload.client_acknowledgement_id, payload_digest=canonical_digest(values), received_at=now)
    ack = {key: value for key, value in values.items() if key != 'acknowledgement_context'}
    ack.update(actor_user_id=user.id, actor_identity_basis=ctx['actor_identity_basis'], version=version.version,
        acknowledgement_context_digest=canonical_digest(ctx), authorization_snapshot=ctx['authorization_snapshot'],
        payload_digest=row.payload_digest, received_at=reviews._utc(now), meaning='received_only')
    row.snapshot = {'metadata': metadata(row), 'payload': values, 'ack': ack}; db.add(row); db.flush()
    from backend.app.services.event_service import append_care_event
    append_care_event(db, patient_id=plan.patient_id, actor_user_id=user.id, event_type='professional_plan_received',
        aggregate_type='plan_acknowledgement', aggregate_id=row.id, revision=1,
        payload={'plan_id': plan.id, 'plan_version_id': version.id, 'assessment_id': plan.assessment_id,
            'meaning': 'received_only', 'authorization_snapshot': ctx['authorization_snapshot']},
        dedupe_key='plan_receipt:' + payload.client_acknowledgement_id, actor_identity_basis=ctx['actor_identity_basis'])
    reviews._audit(db, user, plan.patient_id, 'plan_received', {'plan_version_id': version.id, 'receipt_id': row.id, 'meaning': 'received_only'})
    return {'id': row.id, **ack, 'submission_status': 'committed', 'legacy': False}, True


@reviews.storage_boundary
def query_receipt(db, user, client_id):
    row = db.scalar(select(PlanAcknowledgement).where(PlanAcknowledgement.client_acknowledgement_id == client_id))
    if row is None:
        raise HTTPException(404, 'This original receipt has not been committed.')
    if row.actor_user_id != user.id or not self_access(db, user.id, row.patient_id):
        raise HTTPException(403, 'Only the actual lawful original recipient may query this acknowledgement.')
    require_patient_access(db, user, row.patient_id, {'assessment', 'tracking'})
    reviews._audit(db, user, row.patient_id, 'data_read', {'scope': 'plan_receipt_original_ack', 'receipt_id': row.id})
    return {'id': row.id, **row.snapshot['ack'], 'submission_status': 'committed', 'legacy': False}
