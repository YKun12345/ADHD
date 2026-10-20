"""Actual responsible-doctor review inputs; scoring and original ACKs stay immutable."""
import base64
import hashlib
import hmac
import json
from functools import wraps

from fastapi import HTTPException
from sqlalchemy import select, update, func
from sqlalchemy.exc import DBAPIError

from backend.app.core.config import settings
from backend.app.models.assessment import AssessmentSession, AssessmentItem, TaskAttempt
from backend.app.models.submission import SubmissionRecord
from backend.app.models.scale_result import ScaleResult
from backend.app.models.cognitive_test import CognitiveTest
from backend.app.models.review import ReviewInputSnapshot, ReviewRecord, ReportVersion, metadata as record_metadata
from backend.app.schemas.review import ReviewCreate, ReviewPublicationCreate
from backend.app.services.assessment_service import _doctor_processing, _bound_relationship, authorization_snapshot
from backend.app.services.attention_action_service import _original, _historical_original
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.identity_access import require_patient_access, record_authenticated_actor, recheck_authenticated_actor
from backend.app.services.submission_service import _verify_record, context_dict

_DOMAIN = b'adhd-ab/doctor-review/context/v1'


def storage_boundary(operation):
    @wraps(operation)
    def guarded(*args, **kwargs):
        try:
            return operation(*args, **kwargs)
        except DBAPIError as exc:
            raise HTTPException(503, 'Review storage is unavailable; query the original ID or retry after upgrade.') from exc
    return guarded


def _encode(value, purpose):
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    body = base64.urlsafe_b64encode(raw).decode().rstrip('=')
    signature = hmac.new(settings.SECRET_KEY.encode(), _DOMAIN + b'/' + purpose.encode() + b'/' + raw, hashlib.sha256).hexdigest()
    return f'{purpose}.v1.{body}.{signature}'


def _decode(token, purpose):
    try:
        prefix, version, body, signature = token.split('.')
        raw = base64.urlsafe_b64decode(body + '=' * (-len(body) % 4))
        expected = hmac.new(settings.SECRET_KEY.encode(), _DOMAIN + b'/' + purpose.encode() + b'/' + raw, hashlib.sha256).hexdigest()
        if prefix != purpose or version != 'v1' or not hmac.compare_digest(signature, expected):
            raise ValueError('signature')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('context')
        return value
    except (TypeError, ValueError, AttributeError, UnicodeError) as exc:
        raise HTTPException(409, 'The original review context is invalid; reread the inputs.') from exc


def _utc(value):
    from datetime import timezone
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()


def _assessment(db, identifier):
    row = db.get(AssessmentSession, identifier, populate_existing=True)
    if row is None:
        raise HTTPException(404, 'Assessment not found.')
    return row


def _doctor_authority(db, user, row, *, historical=False):
    recheck_authenticated_actor(db, user.id)
    record_authenticated_actor(db, user)
    if row.source != 'doctor_assigned' or row.responsible_doctor_id != user.id:
        raise HTTPException(403, 'Only the original responsible doctor may review this assessment.')
    relationship_id = _bound_relationship(row)
    if historical:
        from backend.app.services.identity_access import require_doctor
        require_doctor(db, user.id)
        db.info['requires_basic_use'] = False
        require_patient_access(db, user, row.patient_id, {'assessment', 'care'}, relationship_id=relationship_id)
        _historical_original(db, row.authorization_snapshot)
    else:
        if row.published_at is None or row.status in {'draft', 'suspended', 'cancelled'}:
            raise HTTPException(409, 'This assessment is not available for new professional processing.')
        _doctor_processing(db, user, row.patient_id, relationship_id=relationship_id)
        _original(db, row.authorization_snapshot)
    return relationship_id


def _background(db, user, row):
    # Do not decrypt provided background before checking its separate scope.
    try:
        require_patient_access(db, user, row.patient_id, {'profile'}, relationship_id=_bound_relationship(row))
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
        return {'visibility': 'withheld', 'fields': {}}
    return {'visibility': 'shared', 'fields': row.background}


def _doctor_basis(db, user, row):
    from backend.app.models.identity import CareRelationship
    from backend.app.services.identity_access import require_doctor
    qualification = require_doctor(db, user.id)
    relationship = db.get(CareRelationship, _bound_relationship(row), populate_existing=True)
    return f'doctor:{user.id}:qualification:{qualification.id}:revision:{qualification.revision}:relationship:{relationship.id}:revision:{relationship.revision}'


def _snapshot(db, user, row):
    items = db.scalars(select(AssessmentItem).where(AssessmentItem.assessment_id == row.id).order_by(AssessmentItem.id)
        .execution_options(populate_existing=True)).all()
    attempts = db.scalars(select(TaskAttempt).where(TaskAttempt.assessment_id == row.id).order_by(TaskAttempt.id)
        .execution_options(populate_existing=True)).all()
    submissions = db.scalars(select(SubmissionRecord).where(SubmissionRecord.assessment_id == row.id).order_by(SubmissionRecord.id)
        .execution_options(populate_existing=True)).all()
    item_ids = {item.id for item in items}
    attempt_ids = {attempt.id for attempt in attempts}
    for attempt in attempts:
        if attempt.patient_id != row.patient_id or attempt.assessment_item_id not in item_ids:
            raise HTTPException(409, 'An attempt has inconsistent original assessment ownership.')
    evidence = []
    for submission in submissions:
        _verify_record(db, submission)
        if submission.patient_id != row.patient_id or submission.assessment_item_id not in item_ids or submission.attempt_id not in attempt_ids:
            raise HTTPException(409, 'An original submission is outside this assessment.')
        if submission.kind == 'scale':
            result = db.get(ScaleResult, submission.scale_result_id)
            saved_result = {'kind': 'scale', 'id': result.id, 'scale_type': result.scale_type,
                'total_score': result.total_score, 'risk_level': result.risk_level, 'score_json': result.score_json}
        else:
            result = db.get(CognitiveTest, submission.cognitive_result_id)
            saved_result = {'kind': 'cognitive', 'id': result.id, 'test_type': result.test_type, 'result_json': result.result_json}
        evidence.append({**context_dict(submission), 'canonical_digest': submission.canonical_digest,
            'quality_status': submission.quality_status, 'quality_reasons': submission.quality_reasons,
            'quality_rule_version': submission.quality_rule_version, 'acceptance_status': submission.acceptance_status,
            'comparability_status': submission.comparability_status, 'comparability_reasons': submission.comparability_reasons,
            'committed_at': _utc(submission.committed_at), 'content': submission.content,
            'execution_metadata': submission.execution_metadata, 'server_result': saved_result})
    from backend.app.services.clarification_service import snapshot_clarifications
    return {'assessment_id': row.id, 'patient_id': row.patient_id, 'responsible_doctor_id': row.responsible_doctor_id,
        'clarifications': snapshot_clarifications(db, user, row),
        'assessment_version': row.version, 'assessment_status': row.status, 'source': row.source,
        'template_id': row.template_id, 'template_version': row.template_version, 'template_digest': row.template_digest,
        'template_snapshot': row.template_snapshot, 'age_at_assessment': row.age_at_assessment, 'age_group': row.age_group,
        'demonstration_only': row.demonstration_only, 'background': _background(db, user, row),
        'items': [{'assessment_item_id': item.id, 'key': item.key, 'kind': item.kind, 'instrument': item.instrument,
            'version': item.version, 'definition': item.definition_snapshot, 'execution_status': item.execution_status,
            'quality_status': item.quality_status, 'acceptance_status': item.acceptance_status} for item in items],
        'attempts': [{'attempt_id': attempt.id, 'assessment_item_id': attempt.assessment_item_id, 'run_id': attempt.run_id,
            **{key: getattr(attempt, key) for key in ('patient_id', 'actor_user_id', 'performer_kind', 'performer_patient_id',
                'performer_user_id', 'respondent_user_id', 'respondent_kind', 'submitter_user_id', 'protocol_id', 'protocol_schema_version',
                'config_digest', 'template_digest', 'age_at_attempt', 'age_group', 'recall_window', 'execution_status', 'quality_status', 'acceptance_status')},
            'execution_metadata': attempt.execution_metadata, 'created_at': _utc(attempt.created_at)} for attempt in attempts],
        'submissions': evidence, 'ai_draft': None, 'ai_draft_status': 'not_provided',
        'model_evidence_status': 'not_admitted'}


def _audit(db, user, patient_id, action, detail):
    from backend.app.services.deferred_read_audit import append_read_audit
    try:
        append_read_audit(db, failure_detail='Critical review audit could not be persisted.', action=action, status='success', message='实际医生审核输入与版本操作已按原授权核对。',
            actor_user_id=user.id, patient_id=patient_id, detail_json=detail)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, 'Critical review audit could not be persisted.') from exc


@storage_boundary
def review_context(db, user, identifier):
    row = _assessment(db, identifier)
    relationship_id = _doctor_authority(db, user, row)
    snapshot = _snapshot(db, user, row)
    digest = canonical_digest(snapshot)
    authority = authorization_snapshot(db)
    original = {'purpose': 'doctor_review_context', 'context_version': 1, 'actor_user_id': user.id,
        'actor_identity_basis': _doctor_basis(db, user, row),
        'patient_id': row.patient_id, 'assessment_id': row.id, 'responsible_doctor_id': user.id,
        'relationship_id': relationship_id, 'assessment_version': row.version, 'input_digest': digest,
        'authorization_snapshot': authority}
    token = _encode(original, 'doctor-review-context')
    _audit(db, user, row.patient_id, 'data_read', {'assessment_id': row.id, 'input_digest': digest, 'scope': 'review_inputs'})
    return {**snapshot, 'input_digest': digest, 'review_context': token, 'review_context_digest': canonical_digest(original),
        'allowed_categories': ['evidence_review', 'screening_opinion'], 'allowed_actions': ['save_review_draft']}


def _validate(schema, payload):
    from pydantic import ValidationError
    try:
        return schema.model_validate(payload.model_dump() if hasattr(payload, 'model_dump') else payload)
    except ValidationError as exc:
        raise HTTPException(422, 'Review input requires explicit, valid original values.') from exc


def _category(category):
    # The existing templates are demonstration/test-only and no clinical-record
    # admission service exists. A user checkbox or environment flag cannot fill it.
    if category in {'clinical_assessment', 'diagnosis'}:
        raise HTTPException(409, 'A verified professional template, clinical evidence and institutional workflow are not admitted.')


def _lock_inputs(db, assessment_id):
    # Attempt creation CAS-locks its item; submission locks the session first.
    # Follow that order and lock every item before freezing inputs so a newly
    # started attempt cannot slip between the snapshot and the critical write.
    db.execute(update(AssessmentSession).where(AssessmentSession.id == assessment_id).values(version=AssessmentSession.version))
    for identifier in db.scalars(select(AssessmentItem.id).where(AssessmentItem.assessment_id == assessment_id).order_by(AssessmentItem.id)).all():
        db.execute(update(AssessmentItem).where(AssessmentItem.id == identifier).values(version=AssessmentItem.version))


def _review(db, identifier):
    from backend.app.db.review_migration import require_review_schema
    require_review_schema(db.connection())
    row = db.get(ReviewRecord, identifier, populate_existing=True)
    if row is None:
        raise HTTPException(404, 'Review draft not found.')
    saved = db.get(ReviewInputSnapshot, row.input_snapshot_id, populate_existing=True)
    if saved is None or (saved.patient_id, saved.assessment_id, saved.input_digest) != (row.patient_id, row.assessment_id, row.input_digest):
        raise HTTPException(409, 'Frozen review input association is inconsistent.')
    return row, saved


def _draft_ack(row):
    value = row.snapshot
    return {'id': row.id, **value['ack'], 'submission_status': 'committed', 'legacy': False}


def _same_original(db, user, row, payload):
    if row.actor_user_id != user.id or row.payload_digest != canonical_digest(payload):
        raise HTTPException(409, 'This review ID belongs to different immutable original content.')
    ctx = _decode(payload['review_context'], 'doctor-review-context')
    _original(db, ctx['authorization_snapshot'])
    return _draft_ack(row)


@storage_boundary
def create_review(db, user, payload):
    payload = _validate(ReviewCreate, payload)
    values = payload.model_dump()
    session = _assessment(db, payload.assessment_id)
    _doctor_authority(db, user, session)
    if payload.patient_id != session.patient_id:
        raise HTTPException(409, 'Review patient and assessment differ.')
    existing = db.scalar(select(ReviewRecord).where(ReviewRecord.client_review_id == payload.client_review_id))
    if existing:
        result = _same_original(db, user, existing, values)
        _audit(db, user, session.patient_id, 'review_retry_ack', {'review_id': existing.id})
        return result, False
    from backend.app.db.review_migration import require_review_schema
    require_review_schema(db.connection())
    _lock_inputs(db, session.id)
    session = _assessment(db, session.id)
    ctx = _decode(payload.review_context, 'doctor-review-context')
    if (ctx.get('actor_user_id'), ctx.get('patient_id'), ctx.get('assessment_id'), ctx.get('assessment_version'), ctx.get('input_digest')) != (
            user.id, session.patient_id, session.id, payload.expected_assessment_version, payload.input_digest):
        raise HTTPException(409, 'Review input differs from the original doctor context.')
    _original(db, ctx['authorization_snapshot'])
    snapshot = _snapshot(db, user, session)
    if session.version != payload.expected_assessment_version or canonical_digest(snapshot) != payload.input_digest:
        raise HTTPException(409, 'Actual evidence or its version has changed; reread it before deciding.')
    if payload.source_ai_decision_id is not None:
        from backend.app.services.agent.artifact_decision_service import validate_adoption
        validate_adoption(db,user,payload.source_ai_decision_id,target_type='review_draft',client_id=payload.client_review_id,
            patient_id=session.patient_id,assessment_id=session.id,content={'text':payload.body})
    _category(payload.category)
    originals = {item['submission_id']: item for item in snapshot['submissions']}
    if len(payload.decisions) != len(originals) or {item.submission_id for item in payload.decisions} != set(originals):
        raise HTTPException(409, 'Every actual submitted original must have one explicit decision; missing attempts remain missing.')
    for decision in payload.decisions:
        original = originals[decision.submission_id]
        if (decision.attempt_id, decision.assessment_item_id) != (original['attempt_id'], original['assessment_item_id']):
            raise HTTPException(409, 'A doctor decision refers to different evidence.')
        if original['quality_status'] == 'invalid' and decision.decision == 'accepted':
            raise HTTPException(422, 'Invalid evidence cannot become valid through doctor acceptance.')
    from datetime import datetime, timezone
    created_at = datetime.now(timezone.utc).replace(microsecond=0)
    frozen = ReviewInputSnapshot(patient_id=session.patient_id, assessment_id=session.id, actor_user_id=user.id,
        assessment_version=session.version, input_digest=payload.input_digest, created_at=created_at)
    frozen.snapshot = {'metadata': record_metadata(frozen), 'input': snapshot, 'authorization_snapshot': ctx['authorization_snapshot']}
    db.add(frozen); db.flush()
    row = ReviewRecord(patient_id=session.patient_id, assessment_id=session.id, input_snapshot_id=frozen.id, actor_user_id=user.id,
        client_review_id=payload.client_review_id, category=payload.category, assessment_version=session.version,
        input_digest=payload.input_digest, payload_digest=canonical_digest(values), created_at=created_at)
    ack = {'client_review_id': payload.client_review_id, 'patient_id': session.patient_id, 'assessment_id': session.id,
        'actor_user_id': user.id, 'category': payload.category, 'status': 'draft', 'body': payload.body,
        'source_ai_decision_id':payload.source_ai_decision_id,
        'actor_identity_basis': ctx['actor_identity_basis'],
        'limitations': payload.limitations, 'decisions': [decision.model_dump() for decision in payload.decisions],
        'input_digest': payload.input_digest, 'expected_assessment_version': payload.expected_assessment_version,
        'review_context_digest': canonical_digest(ctx), 'authorization_snapshot': ctx['authorization_snapshot'],
        'created_at': _utc(created_at), 'payload_digest': row.payload_digest, 'confirmed': True, 'demonstration_only': snapshot['demonstration_only']}
    row.snapshot = {'metadata': record_metadata(row), 'payload': values, 'ack': ack}
    db.add(row); db.flush()
    _audit(db, user, session.patient_id, 'review_draft_saved', {'review_id': row.id, 'input_digest': row.input_digest})
    return _draft_ack(row), True


def _private_authority(db, user, row, frozen):
    if row.actor_user_id != user.id:
        raise HTTPException(403, 'An unpublished review is private to its actual doctor author.')
    session = _assessment(db, row.assessment_id)
    _doctor_authority(db, user, session, historical=True)
    _historical_original(db, frozen.snapshot['authorization_snapshot'])


@storage_boundary
def query_review(db, user, client_id):
    row = db.scalar(select(ReviewRecord).where(ReviewRecord.client_review_id == client_id))
    if row is None:
        raise HTTPException(404, 'The original review ID has not been committed.')
    row, frozen = _review(db, row.id)
    _private_authority(db, user, row, frozen)
    _audit(db, user, row.patient_id, 'data_read', {'review_id': row.id, 'scope': 'original_review_ack'})
    return _draft_ack(row)


@storage_boundary
def review_detail(db, user, identifier):
    row, frozen = _review(db, identifier)
    _private_authority(db, user, row, frozen)
    _audit(db, user, row.patient_id, 'data_read', {'review_id': row.id, 'scope': 'private_review'})
    return {**_draft_ack(row), 'input_snapshot': frozen.snapshot['input']}


@storage_boundary
def list_reviews(db, user, assessment_id):
    session = _assessment(db, assessment_id)
    _doctor_authority(db, user, session, historical=True)
    result = []
    for row in db.scalars(select(ReviewRecord).where(ReviewRecord.assessment_id == session.id).order_by(ReviewRecord.id.desc())).all():
        actual, frozen = _review(db, row.id)
        _private_authority(db, user, actual, frozen)
        result.append(_draft_ack(actual))
    _audit(db, user, session.patient_id, 'data_read', {'assessment_id': session.id, 'scope': 'private_review_list'})
    return {'items': result}


@storage_boundary
def list_reports(db, user, assessment_id):
    session = _assessment(db, assessment_id)
    _published_access(db, user, session)
    reports = db.scalars(select(ReportVersion).where(ReportVersion.assessment_id == session.id).order_by(ReportVersion.version.desc())).all()
    _audit(db, user, session.patient_id, 'data_read', {'assessment_id': session.id, 'scope': 'published_reports'})
    return {'items': [] if not reports else [_report_response(db, user, row) for row in reports]}


def _current_draft_inputs(db, user, row, frozen):
    session = _assessment(db, row.assessment_id)
    _doctor_authority(db, user, session)
    _original(db, frozen.snapshot['authorization_snapshot'])
    snapshot = _snapshot(db, user, session)
    if session.version != row.assessment_version or canonical_digest(snapshot) != row.input_digest:
        raise HTTPException(409, 'The draft is based on earlier evidence; reread and create a new review.')
    _category(row.category)
    return session, snapshot


def _previous_report_version(db, assessment_id):
    return db.scalar(select(func.max(ReportVersion.version)).where(ReportVersion.assessment_id == assessment_id)) or 0


@storage_boundary
def publication_context(db, user, review_id):
    row, frozen = _review(db, review_id)
    if row.actor_user_id != user.id:
        raise HTTPException(403, 'Only the actual private review author can publish it.')
    session, snapshot = _current_draft_inputs(db, user, row, frozen)
    previous = _previous_report_version(db, session.id)
    value = {'purpose': 'review_publication', 'context_version': 1, 'actor_user_id': user.id,
        'actor_identity_basis': _doctor_basis(db, user, session),
        'patient_id': session.patient_id, 'assessment_id': session.id, 'review_id': row.id,
        'review_payload_digest': row.payload_digest, 'input_digest': row.input_digest,
        'expected_assessment_version': session.version, 'expected_previous_report_version': previous,
        'authorization_snapshot': authorization_snapshot(db)}
    _audit(db, user, row.patient_id, 'data_read', {'review_id': row.id, 'scope': 'publication_preflight'})
    return {**value, 'publication_context': _encode(value, 'review-publication-context'),
        'publication_context_digest': canonical_digest(value)}


def _publication_ack(row):
    return {'id': row.id, **row.snapshot['ack'], 'submission_status': 'committed', 'legacy': False}


def _published_access(db, user, session):
    from backend.app.services.identity_access import self_access, require_doctor
    if self_access(db, user.id, session.patient_id):
        require_patient_access(db, user, session.patient_id, 'assessment')
    elif session.source == 'self':
        require_doctor(db, user.id)
        require_patient_access(db, user, session.patient_id, 'assessment')
    else:
        _doctor_authority(db, user, session, historical=True)


def _report_response(db, user, row):
    from backend.app.services.identity_access import self_access
    session = _assessment(db, row.assessment_id)
    _published_access(db, user, session)
    if session.source != 'self' and not self_access(db, user.id, row.patient_id):
        _historical_original(db, row.snapshot['authorization_snapshot'])
    return {**_publication_ack(row), 'input_snapshot': row.snapshot['input_snapshot'],
        'ai_draft': {'source_ai_decision_id':row.snapshot['ack']['source_ai_decision_id']} if row.snapshot['ack'].get('source_ai_decision_id') else None,
        'ai_draft_status': 'human_reviewed_source' if row.snapshot['ack'].get('source_ai_decision_id') else 'not_provided', 'model_evidence_status': 'not_admitted'}


@storage_boundary
def publish_review(db, user, payload):
    payload = _validate(ReviewPublicationCreate, payload)
    values = payload.model_dump()
    row, frozen = _review(db, payload.review_id)
    if row.actor_user_id != user.id:
        raise HTTPException(403, 'Only the actual original doctor may publish this private review.')
    session = _assessment(db, row.assessment_id)
    _doctor_authority(db, user, session)
    if (payload.assessment_id, payload.patient_id) != (row.assessment_id, row.patient_id):
        raise HTTPException(409, 'Publication ownership differs from the frozen review.')
    ctx = _decode(payload.publication_context, 'review-publication-context')
    expected = {'actor_user_id': user.id, 'patient_id': row.patient_id, 'assessment_id': row.assessment_id, 'review_id': row.id,
        'review_payload_digest': row.payload_digest, 'input_digest': payload.input_digest,
        'expected_assessment_version': payload.expected_assessment_version, 'expected_previous_report_version': payload.expected_previous_report_version}
    if any(ctx.get(key) != value for key, value in expected.items()):
        raise HTTPException(409, 'Publication differs from its exact confirmed preflight context.')
    _original(db, frozen.snapshot['authorization_snapshot'])
    _original(db, ctx['authorization_snapshot'])
    existing = db.scalar(select(ReportVersion).where(ReportVersion.client_publication_id == payload.client_publication_id))
    if existing:
        if existing.actor_user_id != user.id or existing.payload_digest != canonical_digest(values):
            raise HTTPException(409, 'This publication ID already belongs to different original content.')
        _audit(db, user, row.patient_id, 'review_publication_retry_ack', {'report_id': existing.id})
        return _publication_ack(existing), False
    # Serialize the aggregate before loading inputs; the unique review/version
    # constraints also protect the final publication from concurrent contenders.
    _lock_inputs(db, session.id)
    session, snapshot = _current_draft_inputs(db, user, row, frozen)
    if (session.version, row.input_digest, _previous_report_version(db, session.id)) != (
            payload.expected_assessment_version, payload.input_digest, payload.expected_previous_report_version):
        raise HTTPException(409, 'A report or its evidence has changed; reread before publishing.')
    if row.snapshot['ack'].get('source_ai_decision_id'):
        from backend.app.services.agent.artifact_decision_service import validate_adoption
        validate_adoption(db,user,row.snapshot['ack']['source_ai_decision_id'],target_type='review_draft',client_id=row.client_review_id,
            patient_id=row.patient_id,assessment_id=row.assessment_id,content={'text':row.snapshot['ack']['body']})
    if db.scalar(select(ReportVersion.id).where(ReportVersion.review_id == row.id)):
        raise HTTPException(409, 'This immutable draft has already been published.')
    decisions = row.snapshot['ack']['decisions']
    originals = {item['submission_id']: item for item in snapshot['submissions']}
    for decision in decisions:
        evidence = originals[decision['submission_id']]
        db.execute(update(TaskAttempt).where(TaskAttempt.id == evidence['attempt_id'], TaskAttempt.patient_id == row.patient_id)
            .values(acceptance_status=decision['decision']))
    for item in snapshot['items']:
        latest = max((attempt for attempt in snapshot['attempts'] if attempt['assessment_item_id'] == item['assessment_item_id']),
            key=lambda value: value['attempt_id'], default=None)
        selected = next((decision for decision in decisions if latest and decision['attempt_id'] == latest['attempt_id']), None)
        changed = db.execute(update(AssessmentItem).where(AssessmentItem.id == item['assessment_item_id'], AssessmentItem.version == item['version'])
            .values(acceptance_status=selected['decision'] if selected else item['acceptance_status'], version=AssessmentItem.version + 1))
        if changed.rowcount != 1:
            raise HTTPException(409, 'An assessment item changed while publishing.')
    # Material review of an incomplete round never closes the whole round.
    complete = bool(snapshot['items'])
    for item in snapshot['items']:
        latest = max((attempt for attempt in snapshot['attempts'] if attempt['assessment_item_id'] == item['assessment_item_id']),
            key=lambda value: value['attempt_id'], default=None)
        decision = next((value for value in decisions if latest and value['attempt_id'] == latest['attempt_id']), None)
        if not decision or decision['decision'] != 'accepted' or originals[decision['submission_id']]['quality_status'] != 'valid':
            complete = False
    status = 'reviewed' if complete else 'under_review' if session.status == 'reviewed' else session.status
    changed = db.execute(update(AssessmentSession).where(AssessmentSession.id == session.id,
        AssessmentSession.version == payload.expected_assessment_version).values(version=AssessmentSession.version + 1, status=status))
    if changed.rowcount != 1:
        raise HTTPException(409, 'The assessment changed before publication.')
    from datetime import datetime, timezone
    published_at = datetime.now(timezone.utc).replace(microsecond=0)
    report = ReportVersion(patient_id=row.patient_id, assessment_id=row.assessment_id, review_id=row.id, actor_user_id=user.id,
        client_publication_id=payload.client_publication_id, category=row.category, version=payload.expected_previous_report_version + 1,
        expected_assessment_version=payload.expected_assessment_version, input_digest=row.input_digest,
        payload_digest=canonical_digest(values), published_at=published_at)
    ack = {'client_publication_id': payload.client_publication_id, 'patient_id': row.patient_id, 'assessment_id': row.assessment_id,
        'review_id': row.id, 'actor_user_id': user.id, 'version': report.version, 'expected_assessment_version': payload.expected_assessment_version,
        'actor_identity_basis': ctx['actor_identity_basis'],
        'review_payload_digest': row.payload_digest,
        'source_ai_decision_id':row.snapshot['ack'].get('source_ai_decision_id'),
        'expected_previous_report_version': payload.expected_previous_report_version, 'assessment_version': payload.expected_assessment_version + 1,
        'assessment_status': status, 'category': row.category, 'status': 'published', 'body': row.snapshot['ack']['body'],
        'limitations': row.snapshot['ack']['limitations'], 'decisions': decisions, 'input_digest': row.input_digest,
        'publication_context_digest': canonical_digest(ctx), 'authorization_snapshot': ctx['authorization_snapshot'],
        'published_at': _utc(published_at), 'payload_digest': report.payload_digest, 'confirmed': True,
        'demonstration_only': snapshot['demonstration_only']}
    report.snapshot = {'metadata': record_metadata(report), 'payload': values, 'ack': ack,
        'authorization_snapshot': ctx['authorization_snapshot'], 'input_snapshot': frozen.snapshot['input']}
    db.add(report); db.flush()
    from backend.app.services.event_service import append_care_event
    append_care_event(db, patient_id=row.patient_id, actor_user_id=user.id, event_type='professional_report_published',
        aggregate_type='report', aggregate_id=report.id, revision=report.version,
        payload={'assessment_id': row.assessment_id, 'review_id': row.id, 'report_id': report.id, 'version': report.version,
            'input_digest': row.input_digest, 'category': row.category, 'authorization_snapshot': ctx['authorization_snapshot']},
        dedupe_key='report_publication:' + payload.client_publication_id, actor_identity_basis=ctx['actor_identity_basis'])
    _audit(db, user, row.patient_id, 'professional_report_published', {'report_id': report.id, 'input_digest': row.input_digest})
    return _publication_ack(report), True


@storage_boundary
def query_publication(db, user, client_id):
    report = db.scalar(select(ReportVersion).where(ReportVersion.client_publication_id == client_id))
    if report is None:
        raise HTTPException(404, 'The original publication ID has not been committed.')
    if report.actor_user_id != user.id:
        raise HTTPException(403, 'Only the original publishing doctor can query this exact confirmation.')
    _doctor_authority(db, user, _assessment(db, report.assessment_id), historical=True)
    _historical_original(db, report.snapshot['authorization_snapshot'])
    _audit(db, user, report.patient_id, 'data_read', {'report_id': report.id, 'scope': 'publication_original_ack'})
    return _publication_ack(report)


@storage_boundary
def report_detail(db, user, identifier):
    ref = db.scalar(select(ReportVersion.assessment_id).where(ReportVersion.id == identifier))
    if ref is None:
        raise HTTPException(404, 'Published report not found.')
    _published_access(db, user, _assessment(db, ref))
    report = db.get(ReportVersion, identifier, populate_existing=True)
    result = _report_response(db, user, report)
    _audit(db, user, report.patient_id, 'data_read', {'report_id': report.id, 'scope': 'published_report'})
    return result
