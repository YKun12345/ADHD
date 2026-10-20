"""Actual specific doctor questions and immutable patient/guardian answer revisions."""
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy import select, update, func
from backend.app.models.review import ReviewClarification, ClarificationReply, metadata
from backend.app.models.assessment import AssessmentSession
from backend.app.models.user import User
from backend.app.schemas.review import ClarificationCreate, ClarificationReplyCreate
from backend.app.services import review_service as reviews
from backend.app.services.assessment_service import _own_processing, _doctor_processing, _bound_relationship, authorization_snapshot
from backend.app.services.identity_access import self_access, require_patient_access, identity_basis
from backend.app.services.attention_action_service import _original, _historical_original
from backend.app.services.cognitive_contract import canonical_digest

BACKGROUND_KEYS = {'diagnosis_history', 'medication', 'other_conditions', 'sleep', 'school_work'}


def _ack(row):
    return {'id': row.id, **row.snapshot['ack'], 'submission_status': 'committed', 'legacy': False}


def _access(db, user, session, *, processing=False):
    if self_access(db, user.id, session.patient_id):
        if processing:
            _own_processing(db, user, session.patient_id)
            if session.source != 'doctor_assigned' or session.status in {'draft', 'suspended', 'cancelled', 'reviewed'}:
                raise HTTPException(409, 'This assessment is not accepting clarification replies.')
            _doctor_processing(db, db.get(User, session.responsible_doctor_id), session.patient_id, relationship_id=_bound_relationship(session))
            _original(db, session.authorization_snapshot)
        else:
            require_patient_access(db, user, session.patient_id, 'assessment')
    else:
        reviews._doctor_authority(db, user, session, historical=not processing)


def _profile(db, user, session):
    require_patient_access(db, user, session.patient_id, 'profile',
        **({} if self_access(db, user.id, session.patient_id) else {'relationship_id': _bound_relationship(session)}))


def snapshot_clarifications(db, user, session):
    query = select(ReviewClarification).where(ReviewClarification.assessment_id == session.id).order_by(ReviewClarification.id)
    try:
        _profile(db, user, session)
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
        query = query.where(ReviewClarification.source_type != 'background')
    result = []
    for question in db.scalars(query).all():
        replies = db.scalars(select(ClarificationReply).where(ClarificationReply.question_id == question.id)
            .order_by(ClarificationReply.revision)).all()
        if not self_access(db, user.id, session.patient_id):
            _historical_original(db, question.snapshot['authorization_snapshot'])
            for reply in replies:
                _historical_original(db, reply.snapshot['authorization_snapshot'])
        result.append({**_ack(question), 'replies': [_ack(reply) for reply in replies]})
    return result


def _question(db, user, identifier, *, processing=False):
    ref = db.execute(select(ReviewClarification.assessment_id, ReviewClarification.source_type).where(ReviewClarification.id == identifier)).first()
    if ref is None:
        raise HTTPException(404, 'Specific question not found.')
    session = reviews._assessment(db, ref.assessment_id)
    _access(db, user, session, processing=processing)
    if ref.source_type == 'background':
        _profile(db, user, session)
    question = db.get(ReviewClarification, identifier, populate_existing=True)
    if processing:
        _original(db, question.snapshot['authorization_snapshot'])
    elif not self_access(db, user.id, session.patient_id):
        _historical_original(db, question.snapshot['authorization_snapshot'])
    return question, session


def _advance(db, session, expected):
    state = {'status': 'under_review'} if session.status == 'reviewed' else {}
    if db.execute(update(AssessmentSession).where(AssessmentSession.id == session.id, AssessmentSession.version == expected)
            .values(version=AssessmentSession.version + 1, **state)).rowcount != 1:
        raise HTTPException(409, 'The assessment or clarification has changed; reread it before confirming.')


def _save(db, user, session, row, values, ack, authority, event_type, basis):
    row.snapshot = {'metadata': metadata(row), 'payload': values, 'ack': ack, 'authorization_snapshot': authority}
    db.add(row); db.flush()
    from backend.app.services.event_service import append_care_event
    append_care_event(db, patient_id=session.patient_id, actor_user_id=user.id, event_type=event_type,
        aggregate_type='clarification' if isinstance(row, ReviewClarification) else 'clarification_reply', aggregate_id=row.id,
        revision=1 if isinstance(row, ReviewClarification) else row.revision,
        payload={'assessment_id': session.id, 'question_id': row.id if isinstance(row, ReviewClarification) else row.question_id,
            'authorization_snapshot': authority}, dedupe_key=event_type + ':' + (values.get('client_question_id') or values['client_reply_id']),
        actor_identity_basis=basis)
    reviews._audit(db, user, session.patient_id, event_type, {'assessment_id': session.id, 'record_id': row.id})
    return _ack(row), True


@reviews.storage_boundary
def create_question(db, user, payload):
    payload = reviews._validate(ClarificationCreate, payload); values = payload.model_dump()
    session = reviews._assessment(db, payload.assessment_id)
    reviews._doctor_authority(db, user, session)
    if session.patient_id != payload.patient_id:
        raise HTTPException(409, 'Question and assessment belong to different patients.')
    if payload.source_type == 'background':
        _profile(db, user, session)
        if payload.source_key not in BACKGROUND_KEYS:
            raise HTTPException(422, 'Select one actual permitted background field.')
    ctx = reviews._decode(payload.review_context, 'doctor-review-context')
    if any(ctx.get(key) != value for key, value in {'actor_user_id': user.id, 'patient_id': session.patient_id,
            'assessment_id': session.id, 'assessment_version': payload.expected_assessment_version, 'input_digest': payload.input_digest}.items()):
        raise HTTPException(409, 'The specific question differs from its original doctor preflight.')
    _original(db, ctx['authorization_snapshot'])
    previous = db.scalar(select(ReviewClarification).where(ReviewClarification.client_question_id == payload.client_question_id))
    if previous:
        if previous.actor_user_id != user.id or previous.payload_digest != canonical_digest(values):
            raise HTTPException(409, 'This original question ID belongs to different confirmed content.')
        reviews._audit(db, user, session.patient_id, 'clarification_retry_ack', {'question_id': previous.id})
        return _ack(previous), False
    reviews._lock_inputs(db, session.id); session = reviews._assessment(db, session.id)
    frozen = reviews._snapshot(db, user, session)
    if session.version != payload.expected_assessment_version or canonical_digest(frozen) != payload.input_digest:
        raise HTTPException(409, 'The question is based on earlier evidence; reread the actual inputs.')
    if payload.source_type == 'submission' and payload.source_key not in {row['submission_id'] for row in frozen['submissions']}:
        raise HTTPException(409, 'The question must refer to an actual submitted original from this assessment.')
    if payload.source_ai_decision_id is not None:
        from backend.app.services.agent.artifact_decision_service import validate_adoption
        validate_adoption(db,user,payload.source_ai_decision_id,target_type='review_question',client_id=payload.client_question_id,
            patient_id=session.patient_id,assessment_id=session.id,
            content={key:values[key] for key in ('source_type','source_key','question')})
    _advance(db, session, payload.expected_assessment_version)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    row = ReviewClarification(patient_id=session.patient_id, assessment_id=session.id, actor_user_id=user.id,
        client_question_id=payload.client_question_id, source_type=payload.source_type, source_key=payload.source_key,
        expected_assessment_version=payload.expected_assessment_version, payload_digest=canonical_digest(values), created_at=now)
    ack = {key: value for key, value in values.items() if key != 'review_context'}
    ack.update(actor_user_id=user.id, actor_identity_basis=ctx['actor_identity_basis'], assessment_version=payload.expected_assessment_version + 1,
        review_context_digest=canonical_digest(ctx), payload_digest=row.payload_digest, created_at=reviews._utc(now),
        authorization_snapshot=ctx['authorization_snapshot'], status='requested')
    return _save(db, user, session, row, values, ack, ctx['authorization_snapshot'], 'clarification_requested', ctx['actor_identity_basis'])


@reviews.storage_boundary
def list_questions(db, user, identifier):
    session = reviews._assessment(db, identifier); _access(db, user, session)
    result = snapshot_clarifications(db, user, session)
    reviews._audit(db, user, session.patient_id, 'data_read', {'assessment_id': session.id, 'scope': 'specific_clarifications'})
    return {'assessment_id': session.id, 'patient_id': session.patient_id, 'items': result}


@reviews.storage_boundary
def reply_context(db, user, identifier):
    question, session = _question(db, user, identifier, processing=True)
    if not self_access(db, user.id, session.patient_id):
        raise HTTPException(403, 'Only the actual patient or verified guardian may answer this question.')
    previous = db.scalar(select(func.max(ClarificationReply.revision)).where(ClarificationReply.question_id == identifier)) or 0
    ctx = {'purpose': 'clarification_reply', 'context_version': 1, 'question_id': question.id, 'question_payload_digest': question.payload_digest,
        'patient_id': session.patient_id, 'assessment_id': session.id, 'actor_user_id': user.id,
        'actor_identity_basis': identity_basis(db, user.id, session.patient_id), 'assessment_version': session.version,
        'expected_previous_revision': previous, 'authorization_snapshot': authorization_snapshot(db)}
    reviews._audit(db, user, session.patient_id, 'data_read', {'question_id': question.id, 'scope': 'clarification_reply_preflight'})
    return {**ctx, 'reply_context': reviews._encode(ctx, 'clarification-reply-context'), 'reply_context_digest': canonical_digest(ctx)}


@reviews.storage_boundary
def create_reply(db, user, payload):
    payload = reviews._validate(ClarificationReplyCreate, payload); values = payload.model_dump()
    # Repeated exact IDs are legal ACK queries after later versions, while new
    # replies must still satisfy current processing authority and original heads.
    question, session = _question(db, user, payload.question_id, processing=True)
    if not self_access(db, user.id, session.patient_id):
        raise HTTPException(403, 'Only the actual patient or verified guardian may answer.')
    ctx = reviews._decode(payload.reply_context, 'clarification-reply-context')
    expected = {'patient_id': payload.patient_id, 'assessment_id': payload.assessment_id, 'question_id': question.id,
        'question_payload_digest': question.payload_digest, 'actor_user_id': user.id, 'assessment_version': payload.expected_assessment_version,
        'expected_previous_revision': payload.expected_previous_revision}
    if session.patient_id != payload.patient_id or session.id != payload.assessment_id or any(ctx.get(key) != value for key, value in expected.items()):
        raise HTTPException(409, 'The reply differs from its original question or preflight.')
    _original(db, ctx['authorization_snapshot'])
    previous = db.scalar(select(ClarificationReply).where(ClarificationReply.client_reply_id == payload.client_reply_id))
    if previous:
        if previous.actor_user_id != user.id or previous.payload_digest != canonical_digest(values):
            raise HTTPException(409, 'This original reply ID belongs to different content.')
        reviews._audit(db, user, session.patient_id, 'clarification_reply_retry_ack', {'reply_id': previous.id})
        return _ack(previous), False
    reviews._lock_inputs(db, session.id); session = reviews._assessment(db, session.id)
    current = db.scalar(select(func.max(ClarificationReply.revision)).where(ClarificationReply.question_id == question.id)) or 0
    if current != payload.expected_previous_revision or session.version != payload.expected_assessment_version:
        raise HTTPException(409, 'The question or assessment changed before the reply was confirmed.')
    _advance(db, session, payload.expected_assessment_version)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    row = ClarificationReply(patient_id=session.patient_id, assessment_id=session.id, question_id=question.id, actor_user_id=user.id,
        client_reply_id=payload.client_reply_id, expected_assessment_version=payload.expected_assessment_version,
        revision=current + 1, payload_digest=canonical_digest(values), created_at=now)
    ack = {key: value for key, value in values.items() if key != 'reply_context'}
    ack.update(actor_user_id=user.id, actor_identity_basis=ctx['actor_identity_basis'], assessment_version=payload.expected_assessment_version + 1,
        reply_context_digest=canonical_digest(ctx), revision=row.revision, payload_digest=row.payload_digest, created_at=reviews._utc(now),
        authorization_snapshot=ctx['authorization_snapshot'], status='answered')
    return _save(db, user, session, row, values, ack, ctx['authorization_snapshot'], 'clarification_answered', ctx['actor_identity_basis'])


@reviews.storage_boundary
def query_original(db, user, client_id, *, reply=False):
    model, field = (ClarificationReply, ClarificationReply.client_reply_id) if reply else (ReviewClarification, ReviewClarification.client_question_id)
    ref = db.execute(select(model.id, model.assessment_id, model.actor_user_id).where(field == client_id)).first()
    if ref is None:
        raise HTTPException(404, 'This original clarification ID has not been committed.')
    if ref.actor_user_id != user.id:
        raise HTTPException(403, 'Only the actual original author may query this exact acknowledgement.')
    session = reviews._assessment(db, ref.assessment_id); _access(db, user, session)
    row = db.get(model, ref.id, populate_existing=True)
    _question(db, user, row.question_id if reply else row.id)
    if not self_access(db, user.id, session.patient_id):
        _historical_original(db, row.snapshot['authorization_snapshot'])
    reviews._audit(db, user, session.patient_id, 'data_read', {'record_id': row.id, 'scope': 'clarification_original_ack'})
    return _ack(row)
