"""Explicit immutable attention facts in the caller's transaction.

All return values remain provisional until the caller commits the critical audit,
action, CAS state and care event together. This service never commits or rolls back.
"""
import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone
from functools import wraps

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm.attributes import set_committed_value

from backend.app.core.config import settings
from backend.app.core.record_envelope import RecordIntegrityError, seal_record
from backend.app.models.assessment import AssessmentSession
from backend.app.models.attention import AttentionItem
from backend.app.models.attention_action import AttentionAction
from backend.app.models.event import CareEvent
from backend.app.models.identity import CareRelationship
from backend.app.schemas.attention_action import AttentionActionCreate
from backend.app.services.assessment_service import _bound_relationship, authorization_snapshot
from backend.app.services.attention_service import (allowed_attention_actions, attention_context,
    response, state_values, verify_attention)
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.event_service import append_care_event
from backend.app.services.identity_access import (identity_basis, record_authenticated_actor,
    recheck_authenticated_actor, recheck_receipts, require_doctor, require_patient_access, self_access)
from backend.app.services.submission_service import _receipt_tuples

_CONTEXT_DOMAIN = b"adhd-ab/attention/action-context/v1"
_ACK_FIELDS = ("client_action_id", "attention_id", "patient_id", "actor_user_id", "actor_identity_basis",
    "action", "reason", "previous_status", "status", "expected_version", "version", "occurred_at",
    "action_context_digest", "authorization_snapshot", "confirmed")
_AUTH_KEYS = ("authorization_receipts", "credential_receipts", "requires_basic_use")
_TARGET_STATUS = {"acknowledge":"acknowledged", "resolve":"resolved", "close_with_reason":"closed_with_reason"}


def _storage_boundary(operation):
    @wraps(operation)
    def guarded(*args, **kwargs):
        try:
            return operation(*args, **kwargs)
        except DBAPIError as exc:
            raise HTTPException(503,"Attention storage is unavailable; retry/query the original action ID.") from exc
    return guarded


def _utc(value):
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()


def _saved_authority(db):
    return {key:list(value) if isinstance(value,list) else value
        for key in _AUTH_KEYS for value in [db.info.get(key)]}


def _sync_authority(db):
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.authorization_receipts = db.info.get("authorization_receipts",[])
        request.state.credential_receipts = db.info.get("credential_receipts",[])


def _restore_authority(db, saved):
    for key, value in saved.items():
        if value is None:
            db.info.pop(key,None)
        else:
            db.info[key] = value
    _sync_authority(db)


def _merge_receipts(db, receipts):
    db.info["authorization_receipts"] = list(dict.fromkeys(receipts))
    _sync_authority(db)


def _snapshot_receipts(snapshot):
    try:
        values = _receipt_tuples(snapshot)
        if not values:
            raise ValueError("empty")
        return values
    except (TypeError, ValueError) as exc:
        raise RecordIntegrityError("Original attention processing authority is incomplete.") from exc


def _original(db, snapshot):
    originals = _snapshot_receipts(snapshot)
    previous = list(db.info.get("authorization_receipts",[]))
    processing = db.info.get("requires_basic_use",False)
    recheck_receipts(db,originals)
    _merge_receipts(db,previous+originals)
    db.info["requires_basic_use"] = processing


def _load(db, identifier):
    row = db.scalar(select(AttentionItem).where(AttentionItem.id == identifier)
        .execution_options(populate_existing=True))
    if row is None:
        raise HTTPException(404,"Attention item not found.")
    verify_attention(row)
    return row


def _source(db, row):
    """Authenticate original event/evidence associations before using their grants."""
    from backend.app.services.care_consumers import _original_submission
    session = db.get(AssessmentSession,row.assessment_id,populate_existing=True)
    source = db.scalar(select(CareEvent).where(CareEvent.event_id == row.source_event_id)
        .execution_options(populate_existing=True))
    if session is None or source is None:
        raise RecordIntegrityError("Attention has no actual original assessment and care event.")
    data = source.payload
    if not isinstance(data,dict) or (source.patient_id,source.actor_user_id,data.get("assessment_id")) != (
        row.patient_id,row.created_for_user_id,row.assessment_id):
        raise RecordIntegrityError("Attention source event routing differs from its authenticated original.")
    if (session.patient_id,session.responsible_doctor_id,session.source) != (
        row.patient_id,row.responsible_doctor_id,"doctor_assigned" if row.owner_kind == "doctor" else "self"):
        raise RecordIntegrityError("Attention no longer matches its actual assessment responsibility.")
    if row.owner_kind == "doctor" and _bound_relationship(session) != row.relationship_id:
        raise RecordIntegrityError("Attention differs from its original specific clinical relationship.")
    if row.owner_kind == "patient_self" and row.relationship_id is not None:
        raise RecordIntegrityError("Self attention cannot borrow a clinical relationship.")
    if row.detail.get("authorization_snapshot") != data.get("authorization_snapshot"):
        raise RecordIntegrityError("Attention authority differs from the authenticated source event.")
    snapshots = [row.detail["authorization_snapshot"], session.authorization_snapshot]
    if row.kind == "assessment_quality":
        if source.event_type != "assessment_quality_issue" or row.submission_id is None:
            raise RecordIntegrityError("Quality attention requires its actual quality event and evidence.")
        submission = _original_submission(db,source,data)
        if (submission.submission_id,submission.assessment_id,submission.quality_reasons) != (
            row.submission_id,row.assessment_id,row.detail.get("quality_reasons")) or submission.quality_status not in {"limited","invalid"}:
            raise RecordIntegrityError("Attention differs from the actual immutable quality evidence.")
        if (data.get("assessment_item_id"),data.get("quality_reasons"),data.get("responsible_doctor_id")) != (
            submission.assessment_item_id,submission.quality_reasons,row.responsible_doctor_id):
            raise RecordIntegrityError("Attention event has different actual quality evidence or responsibility.")
        snapshots.append(submission.authorization_snapshot)
    elif (source.event_type,source.aggregate_type,source.aggregate_id,source.revision,data.get("assessment_version"),
            data.get("source"),data.get("responsible_doctor_id"),row.submission_id) != (
            "assessment_evidence_ready","assessment",session.id,source.revision,source.revision,
            session.source,row.responsible_doctor_id,None):
        raise RecordIntegrityError("Review attention differs from the actual materials-ready event.")
    receipts = []
    for snapshot in snapshots:
        for receipt in _snapshot_receipts(snapshot):
            if receipt[1] != row.patient_id:
                raise RecordIntegrityError("Attention authority belongs to a different patient.")
            if receipt not in receipts:
                receipts.append(receipt)
    return session,json.loads(json.dumps(receipts))


def _read_authority(db, user, row):
    recheck_authenticated_actor(db,user.id)
    record_authenticated_actor(db,user)
    db.info["requires_basic_use"] = False
    if self_access(db,user.id,row.patient_id):
        require_patient_access(db,user,row.patient_id,"assessment")
        _source(db,row)
        return
    if row.owner_kind != "doctor" or row.responsible_doctor_id != user.id:
        raise HTTPException(403,"Only the actual self/current guardian or this original responsible doctor may read attention.")
    require_doctor(db,user.id)
    rel = db.get(CareRelationship,row.relationship_id,populate_existing=True)
    if rel is None or rel.purpose != "clinical_sharing":
        raise HTTPException(403,"The original specific clinical-sharing relationship is required.")
    require_patient_access(db,user,row.patient_id,{"assessment","care"},relationship_id=row.relationship_id)
    _,snapshot = _source(db,row)
    # History needs the original clinical grant, but never reactivates a withdrawn
    # basic-use purpose. Preserve all original non-basic authority versions.
    _historical_original(db,snapshot)


def _historical_original(db, snapshot):
    historical = []
    for actor,patient,scope,purpose,versions in _snapshot_receipts(snapshot):
        retained = tuple(version for version in versions if version[0] != "consent_records"
            or not _is_basic_consent(db,version[3]))
        historical.append((actor,patient,scope,"clinical" if purpose == "processing" else purpose,retained))
    _original(db,historical)


def _is_basic_consent(db, identifier):
    from backend.app.models.consent import ConsentRecord
    consent = db.get(ConsentRecord,identifier,populate_existing=True)
    return consent is not None and consent.purpose == "basic_use"


def _processing(db, user, row, originals):
    saved = _saved_authority(db)
    try:
        _merge_receipts(db,[])
        _original(db,originals)
        db.info["requires_basic_use"] = True
        if row.owner_kind == "doctor":
            if user.id != row.responsible_doctor_id:
                raise HTTPException(403,"Only this original responsible doctor may process clinical attention.")
            rel = db.get(CareRelationship,row.relationship_id,populate_existing=True)
            if rel is None or rel.purpose != "clinical_sharing" or rel.doctor_user_id != user.id:
                raise HTTPException(403,"The original specific clinical relationship is required for processing.")
            qualification = require_doctor(db,user.id)
            require_patient_access(db,user,row.patient_id,{"assessment","care"},relationship_id=row.relationship_id)
            basis = (f"doctor:{user.id}:qualification:{qualification.id}:revision:{qualification.revision}:"
                f"relationship:{rel.id}:revision:{rel.revision}")
        else:
            if not self_access(db,user.id,row.patient_id):
                raise HTTPException(403,"Only the actual self user or current verified guardian may process personal attention.")
            require_patient_access(db,user,row.patient_id,"assessment")
            basis = identity_basis(db,user.id,row.patient_id)
        snapshot = authorization_snapshot(db)
        captured = list(db.info.get("authorization_receipts",[]))
    except Exception:
        _restore_authority(db,saved)
        raise
    _merge_receipts(db,list(saved.get("authorization_receipts") or [])+captured)
    db.info["requires_basic_use"] = True
    return basis,snapshot


def _key():
    return hmac.new(settings.SECRET_KEY.encode(),_CONTEXT_DOMAIN,hashlib.sha256).digest()


def _source_context(row):
    return {name:getattr(row,name) for name in attention_context()}


def _issue_context(user, row, basis, originals, snapshot):
    source = _source_context(row)
    value = {"purpose":"attention_action","version":1,"actor_user_id":user.id,
        "actor_identity_basis":basis,"patient_id":row.patient_id,"attention_id":row.id,
        "expected_version":row.version,"previous_status":row.status,"source_context":source,
        "source_context_digest":canonical_digest(source),"original_authorization_snapshot":originals,
        "authorization_snapshot":snapshot}
    encoded = base64.urlsafe_b64encode(json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).decode().rstrip("=")
    return "attention-action-context.v1."+encoded+"."+hmac.new(_key(),encoded.encode(),hashlib.sha256).hexdigest()


def _open_context(user, identifier, payload):
    try:
        prefix,version,encoded,signature = payload.action_context.split(".")
        expected = hmac.new(_key(),encoded.encode(),hashlib.sha256).hexdigest()
        if prefix != "attention-action-context" or version != "v1" or not hmac.compare_digest(signature,expected):
            raise ValueError("signature")
        value = json.loads(base64.b64decode(encoded+"="*(-len(encoded)%4),altchars=b"-_",validate=True))
        if (value["purpose"],value["version"],value["actor_user_id"],value["attention_id"]) != (
            "attention_action",1,user.id,identifier):
            raise ValueError("binding")
        if value["expected_version"] != payload.expected_version:
            raise HTTPException(409,"This action version differs from its original confirmed server context.")
        return value
    except (ValueError,KeyError,TypeError,UnicodeError) as exc:
        raise HTTPException(403,"The original action context is invalid for this actual account and attention.") from exc


def _audit(db, user, patient_id, action, **detail):
    from backend.app.services.security_service import _append_audit_log
    try:
        _append_audit_log(db,action=action,status="success",message="关注项实际动作与原授权的事务证据。",
            actor_user_id=user.id,patient_id=patient_id,detail_json=detail)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503,"Critical attention audit is unavailable; retry/query the original action ID.") from exc


@_storage_boundary
def attention_detail(db, user, attention_id):
    row = _load(db,attention_id)
    _read_authority(db,user,row)
    actions,token = [],None
    if allowed_attention_actions(row):
        saved = _saved_authority(db)
        try:
            session,originals = _source(db,row)
            if session.status in {"suspended","cancelled"}:
                raise HTTPException(409,"The original assessment is suspended or cancelled.")
            basis,snapshot = _processing(db,user,row,originals)
            actions = allowed_attention_actions(row)
            token = _issue_context(user,row,basis,originals,snapshot)
        except HTTPException as exc:
            if exc.status_code not in {403,409}:
                raise
            _restore_authority(db,saved)
    _audit(db,user,row.patient_id,"attention_detail_read",attention_id=row.id)
    return {"attention":response(row,db),"allowed_actions":actions,"action_context":token,
        "action_context_digest":canonical_digest(token) if token else None}


def _action_context(row):
    return {"action_id":row.id,**{name:_utc(value) if isinstance(value,datetime) else value
        for name in _ACK_FIELDS for value in [getattr(row,name)]},"source_context":row.source_context}


def _verify_action(row):
    context = _action_context(row)
    valid = row.action in _TARGET_STATUS and row.status == _TARGET_STATUS.get(row.action)
    valid = valid and (row.previous_status == "open" if row.action == "acknowledge" else
        row.previous_status == "acknowledged" if row.action == "resolve" else row.previous_status in {"open","acknowledged"})
    valid = valid and row.confirmed is True and row.expected_version > 0 and row.version == row.expected_version+1
    valid = valid and (row.reason is None or bool(row.reason.strip()))
    valid = valid and (row.action == "acknowledge" or row.reason is not None)
    if not valid or row.snapshot != context or row.context_digest != canonical_digest(context):
        raise RecordIntegrityError("Attention action differs from its authenticated immutable actor, source, reason or state.")


def _ack(row):
    _verify_action(row)
    context = _action_context(row)
    context.pop("source_context")
    return {**context,"submission_status":"committed","legacy":False}


def _seal_snapshot(db, row):
    context = _action_context(row)
    values = {"_snapshot_cipher":seal_record(context,row._binding("snapshot")),"context_digest":canonical_digest(context)}
    db.execute(update(AttentionAction).where(AttentionAction.id == row.id).values(**values)
        .execution_options(synchronize_session=False))
    for name,value in values.items():
        set_committed_value(row,name,value)


def _existing(db, key):
    return db.scalar(select(AttentionAction).where(AttentionAction.client_action_id == key)
        .execution_options(populate_existing=True))


def _recover(db, user, existing, attention_id, payload=None, *, historical=False):
    _verify_action(existing)
    if payload is not None and (existing.actor_user_id != user.id or existing.attention_id != attention_id
        or (existing.action,existing.reason,existing.expected_version,existing.action_context_digest,existing.confirmed) != (
            payload.action,payload.reason,payload.expected_version,canonical_digest(payload.action_context),payload.confirmed)):
        raise HTTPException(409,"This global action ID belongs to a different immutable actor, attention, body or context.")
    if existing.actor_user_id != user.id:
        raise HTTPException(403,"Only the actual original actor may recover this original action ACK.")
    row = _load(db,existing.attention_id)
    _read_authority(db,user,row)
    if existing.source_context != _source_context(row):
        raise HTTPException(409,"The original action cannot borrow a changed identity or responsibility.")
    if historical:
        # A GET recovers an already committed fact. Current lawful self/guardian
        # history survives basic-use withdrawal; clinical history additionally
        # retains the original non-basic grant and qualification heads.
        if not self_access(db,user.id,row.patient_id):
            _historical_original(db,existing.authorization_snapshot)
    else:
        _,originals = _source(db,row)
        basis,_ = _processing(db,user,row,originals)
        if existing.actor_identity_basis != basis:
            raise HTTPException(409,"The original action cannot borrow a changed identity or responsibility.")
        _original(db,existing.authorization_snapshot)
    _audit(db,user,row.patient_id,"attention_action_original_ack_read",action_id=existing.id,attention_id=row.id)
    return _ack(existing)


@_storage_boundary
def act_on_attention(db, user, attention_id, payload):
    try:
        payload = AttentionActionCreate.model_validate(payload.model_dump() if isinstance(payload,AttentionActionCreate) else payload)
    except ValidationError as exc:
        raise HTTPException(422,exc.errors(include_context=False)) from exc
    existing = _existing(db,payload.client_action_id)
    if existing is not None:
        return _recover(db,user,existing,attention_id,payload),False
    # Lock before reading current state. SQLite ignores FOR UPDATE and needs the
    # same conditional write lock; the actual state change remains a later CAS.
    db.execute(update(AttentionItem).where(AttentionItem.id == attention_id)
        .values(version=AttentionItem.version).execution_options(synchronize_session=False))
    existing = _existing(db,payload.client_action_id)
    if existing is not None:
        return _recover(db,user,existing,attention_id,payload),False
    row = _load(db,attention_id)
    _read_authority(db,user,row)
    original_context = _open_context(user,attention_id,payload)
    session,originals = _source(db,row)
    basis,_ = _processing(db,user,row,originals)
    _original(db,original_context.get("authorization_snapshot"))
    if (original_context.get("patient_id"),original_context.get("actor_identity_basis"),
        original_context.get("source_context"),original_context.get("source_context_digest"),
        original_context.get("original_authorization_snapshot")) != (
        row.patient_id,basis,_source_context(row),canonical_digest(_source_context(row)),originals):
        raise HTTPException(409,"The original action context or authority changed; a new grant cannot authorize this queued action.")
    if session.status in {"suspended","cancelled"} or payload.action not in allowed_attention_actions(row):
        raise HTTPException(409,"This attention state does not permit that action; terminal and suspended items cannot reopen.")
    if (payload.expected_version,original_context.get("previous_status")) != (row.version,row.status):
        raise HTTPException(409,"Attention changed after confirmation; reload the current original before acting.")
    previous_status,previous_version = row.status,row.version
    new_status = _TARGET_STATUS[payload.action]
    changed = db.execute(update(AttentionItem).where(AttentionItem.id == row.id,
        AttentionItem.version == previous_version,AttentionItem.status == previous_status)
        .values(status=new_status,version=previous_version+1,suspension_reason=None)
        .execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        raise HTTPException(409,"Concurrent attention processing changed this original version.")
    for name,value in {"status":new_status,"version":previous_version+1,"suspension_reason":None}.items():
        set_committed_value(row,name,value)
    row.state_snapshot = state_values(row)
    action = AttentionAction(client_action_id=payload.client_action_id,attention_id=row.id,patient_id=row.patient_id,
        actor_user_id=user.id,actor_identity_basis=basis,action=payload.action,reason=payload.reason,
        previous_status=previous_status,status=new_status,expected_version=previous_version,version=previous_version+1,
        occurred_at=datetime.now(timezone.utc),action_context_digest=canonical_digest(payload.action_context),
        authorization_snapshot=original_context["authorization_snapshot"],source_context=_source_context(row),
        confirmed=True,snapshot={},context_digest="")
    db.add(action)
    try:
        db.flush()
        _seal_snapshot(db,action)
        append_care_event(db,patient_id=row.patient_id,actor_user_id=user.id,actor_identity_basis=basis,
            event_type="attention_action_committed",aggregate_type="attention_action",aggregate_id=action.id,
            revision=action.version,payload={"attention_id":row.id,"action_id":action.id,
                "client_action_id":action.client_action_id,"action":action.action,"previous_status":previous_status,
                "status":new_status,"expected_version":previous_version,"version":action.version,
                "action_context_digest":action.action_context_digest,"context_digest":action.context_digest,
                "authorization_snapshot":action.authorization_snapshot},dedupe_key="attention_action:"+action.client_action_id)
        _audit(db,user,row.patient_id,"attention_action_committed",attention_id=row.id,action_id=action.id,
            action_context_digest=action.action_context_digest,context_digest=action.context_digest)
    except IntegrityError as exc:
        raise HTTPException(409,"Concurrent action creation requires retry/query of the unchanged original action ID.") from exc
    return _ack(action),True


@_storage_boundary
def query_attention_action(db, user, client_action_id):
    action = _existing(db,client_action_id)
    if action is None:
        raise HTTPException(404,"Original attention action not found.")
    return _recover(db,user,action,action.attention_id,historical=True)


@_storage_boundary
def attention_history(db, user, attention_id):
    row = _load(db,attention_id)
    _read_authority(db,user,row)
    actions = db.scalars(select(AttentionAction).where(AttentionAction.attention_id == row.id)
        .order_by(AttentionAction.version,AttentionAction.id).execution_options(populate_existing=True)).all()
    values = [_ack(action) for action in actions]
    if any(action.patient_id != row.patient_id or action.source_context != _source_context(row) for action in actions):
        raise RecordIntegrityError("Attention action history belongs to a different immutable source.")
    _audit(db,user,row.patient_id,"attention_history_read",attention_id=row.id,action_ids=[action.id for action in actions])
    return {"items":values}
