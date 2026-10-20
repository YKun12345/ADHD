"""Immutable shared-message facts, events and critical audit in the caller transaction.

Returned dictionaries are provisional until the route commits and marks its audit
committed. No commit, rollback, AI history, legacy inference, or network delivery.
"""
from datetime import datetime, timezone
import base64
import hashlib
import hmac
import json

from fastapi import HTTPException
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.attributes import set_committed_value

from backend.app.core.record_envelope import RecordIntegrityError, seal_record
from backend.app.core.config import settings
from backend.app.models.identity import CareRelationship
from backend.app.models.shared_message import SharedCareMessage, SharedMessageRead
from backend.app.models.user import User
from backend.app.schemas.shared_message import SharedMessageCreate
from backend.app.services.assessment_service import authorization_snapshot
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.event_service import append_care_event
from backend.app.services.identity_access import identity_basis, require_doctor, require_patient_access, self_access, recheck_receipts

_CONTEXT = ("id","client_message_id","patient_id","relationship_id","relationship_revision","doctor_user_id",
    "patient_actor_user_id","sender_user_id","sender_identity_basis","sender_kind","scope","authorization_snapshot",
    "content_digest","send_context_digest","confirmed","reply_to_message_id","sent_at","version")
_READ_CONTEXT = ("id","patient_id","message_id","viewer_user_id","read_at")


def _utc(value):
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()


def _context(row,fields):
    result={key:_utc(value) if isinstance(value,datetime) else value for key in fields for value in [getattr(row,key)]}
    if isinstance(row,SharedCareMessage) and row.source_ai_decision_id is not None:
        result['source_ai_decision_id']=row.source_ai_decision_id
    return result


def _verify(row):
    fields = _CONTEXT if isinstance(row,SharedCareMessage) else _READ_CONTEXT
    context = _context(row,fields)
    if row.snapshot != context:
        raise RecordIntegrityError("Shared message metadata differs from the authenticated original context.")
    if isinstance(row,SharedCareMessage):
        if (row.context_digest != canonical_digest(context) or row.content_digest != canonical_digest(_semantic(row))
            or row.version != 1 or row.scope != ["care"] or not row.confirmed
            or row.sender_user_id != (row.doctor_user_id if row.sender_kind == "doctor" else row.patient_actor_user_id)
            or row.sender_kind not in {"doctor","patient"}):
            raise RecordIntegrityError("Shared message immutable sender, content or scope is inconsistent.")


def _semantic(row):
    values = {key:getattr(row,key) for key in ("patient_id","relationship_id","client_message_id","content","reply_to_message_id","confirmed")}
    values["send_context_digest"] = (canonical_digest(row.send_context) if isinstance(row,SharedMessageCreate) else row.send_context_digest)
    if row.source_ai_decision_id is not None:
        values['source_ai_decision_id']=row.source_ai_decision_id
    return values


_CONTEXT_DOMAIN = b"adhd-ab/shared-message/send-context/v1"


def _context_key():
    # Derive a separate signing key. These tokens cannot be used as login JWTs.
    return hmac.new(settings.SECRET_KEY.encode(),_CONTEXT_DOMAIN,hashlib.sha256).digest()


def _basis(db,user,rel,qualification):
    return (f"doctor:{user.id}:qualification:{qualification.id}:revision:{qualification.revision}:relationship:{rel.id}:revision:{rel.revision}"
        if user.id == rel.doctor_user_id else identity_basis(db,user.id,rel.patient_id))


def _issue_context(db,user,rel,qualification,snapshot):
    body = {"purpose":"shared_message_send","version":1,"sender_user_id":user.id,"patient_id":rel.patient_id,
        "relationship_id":rel.id,"relationship_revision":rel.revision,"doctor_user_id":rel.doctor_user_id,
        "patient_actor_user_id":rel.patient_actor_user_id,"sender_identity_basis":_basis(db,user,rel,qualification),
        "authorization_snapshot":snapshot}
    encoded = base64.urlsafe_b64encode(json.dumps(body,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).decode().rstrip("=")
    signature = hmac.new(_context_key(),encoded.encode(),hashlib.sha256).hexdigest()
    return "shared-message-context.v1."+encoded+"."+signature


def _open_context(payload,user):
    try:
        prefix,version,encoded,signature = payload.send_context.split(".")
        expected = hmac.new(_context_key(),encoded.encode(),hashlib.sha256).hexdigest()
        if prefix != "shared-message-context" or version != "v1" or not hmac.compare_digest(signature,expected):
            raise ValueError("signature")
        value = json.loads(base64.urlsafe_b64decode(encoded+"="*(-len(encoded)%4)))
        if (value["purpose"],value["version"],value["sender_user_id"],value["patient_id"],value["relationship_id"]) != (
            "shared_message_send",1,user.id,payload.patient_id,payload.relationship_id):
            raise ValueError("binding")
        return value
    except (ValueError,KeyError,TypeError,UnicodeError) as exc:
        raise HTTPException(403,"The original confirmed send context is invalid for this actual account, patient or relationship.") from exc


def _seal_snapshot(db,row,fields):
    # Complete AAD requires the actual database-generated primary key. This
    # insert-only initialization stays inside the same uncommitted transaction.
    context = _context(row,fields)
    values = {"_snapshot_cipher":seal_record(context,row._binding("snapshot"))}
    if isinstance(row,SharedCareMessage):
        values["context_digest"] = canonical_digest(context)
    db.execute(update(type(row)).where(type(row).id == row.id).values(**values).execution_options(synchronize_session=False))
    for key,value in values.items():
        set_committed_value(row,key,value)


def _audit(db,user,patient_id,action,**detail):
    from backend.app.services.security_service import _append_audit_log
    try:
        _append_audit_log(db,action=action,status="success",message="有范围共享消息事务证据。",
            patient_id=patient_id,actor_user_id=user.id,detail_json=detail)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503,"Critical shared-message audit is unavailable; retry/query the original client message ID.") from exc


def _merge_receipts(db,receipts):
    db.info["authorization_receipts"] = receipts
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.authorization_receipts = receipts


def _relationship(db,patient_id,relationship_id):
    rel = db.get(CareRelationship,relationship_id,populate_existing=True)
    if rel is None or rel.patient_id != patient_id:
        raise HTTPException(403,"The selected original patient relationship is unavailable.")
    return rel


def _scope(db,user,patient_id,relationship_id,*,processing):
    """Record both actual parties, explicitly selecting this exact relationship.

    Both clinical and processing receipts are frozen: later historical reads
    recheck original clinical receipts without requiring withdrawn basic use.
    """
    rel = _relationship(db,patient_id,relationship_id)
    if rel.purpose != "clinical_sharing":
        raise HTTPException(403,"Shared messages require the original specific clinical-sharing relationship purpose.")
    if user.id not in {rel.doctor_user_id,rel.patient_actor_user_id}:
        raise HTTPException(403,"Only this relationship's actual parties may send or read shared messages.")
    doctor = db.get(User,rel.doctor_user_id,populate_existing=True)
    patient_actor = db.get(User,rel.patient_actor_user_id,populate_existing=True)
    if not doctor or not patient_actor or not self_access(db,patient_actor.id,patient_id):
        raise HTTPException(403,"The original patient actor no longer has current identity authority.")
    qualification = require_doctor(db,doctor.id)
    previous = list(db.info.get("authorization_receipts",[]))
    previous_processing = db.info.get("requires_basic_use",False)
    _merge_receipts(db,[])
    try:
        for write in ([False,True] if processing else [False]):
            db.info["requires_basic_use"] = write
            require_patient_access(db,patient_actor,patient_id,"care")
            # A self-access shortcut must never stand in for the actual doctor
            # relationship, even for a dual-role account.
            require_patient_access(db,doctor,patient_id,"care",relationship_id=rel.id)
        frozen = authorization_snapshot(db)
        captured = list(db.info.get("authorization_receipts",[]))
    except Exception:
        _merge_receipts(db,previous)
        db.info["requires_basic_use"] = previous_processing
        raise
    _merge_receipts(db,previous+[item for item in captured if item not in previous])
    db.info["requires_basic_use"] = processing or previous_processing
    return rel,qualification,frozen


def _original(db,snapshot,*,processing=True):
    receipts = [(actor,patient,tuple(scope),purpose,tuple(tuple(version) for version in versions))
        for actor,patient,scope,purpose,versions in snapshot if processing or purpose != "processing"]
    previous = list(db.info.get("authorization_receipts",[]))
    previous_processing = db.info.get("requires_basic_use",False)
    try:
        recheck_receipts(db,receipts)
    finally:
        current = db.info.get("authorization_receipts",[])
        _merge_receipts(db,previous+[item for item in current if item not in previous])
        db.info["requires_basic_use"] = previous_processing


def _read_authority(db,user,row):
    _verify(row)
    db.info["requires_basic_use"] = False
    if self_access(db,user.id,row.patient_id):
        require_patient_access(db,user,row.patient_id,"care")
        return
    if user.id != row.doctor_user_id:
        raise HTTPException(403,"This message belongs to a different actual doctor.")
    rel,_,_ = _scope(db,user,row.patient_id,row.relationship_id,processing=False)
    if rel.revision != row.relationship_revision:
        raise HTTPException(409,"The original message relationship revision has changed.")
    _original(db,row.authorization_snapshot,processing=False)


def _ack(row):
    _verify(row)
    return {"message_id":row.id,**{key:value for key,value in _context(row,_CONTEXT).items() if key != "id"},
        "content":row.content,"context_digest":row.context_digest,"legacy":False,"submission_status":"committed"}


def send_message(db,user,payload):
    payload = SharedMessageCreate.model_validate(payload)
    existing = db.scalar(select(SharedCareMessage).where(SharedCareMessage.client_message_id == payload.client_message_id)
        .execution_options(populate_existing=True))
    if existing is not None:
        _verify(existing)
        if existing.sender_user_id != user.id or _semantic(existing) != _semantic(payload):
            raise HTTPException(409,"This global client message ID belongs to a different immutable sender, relationship or content.")
        _scope(db,user,existing.patient_id,existing.relationship_id,processing=True)
        _original(db,existing.authorization_snapshot)
        _audit(db,user,existing.patient_id,"shared_message_retry_ack",message_id=existing.id)
        return _ack(existing),False
    if not payload.confirmed:
        raise HTTPException(422,"The actual sender must explicitly confirm this content and recipient before sending.")
    original_context = _open_context(payload,user)
    rel,qualification,_ = _scope(db,user,payload.patient_id,payload.relationship_id,processing=True)
    snapshot = original_context["authorization_snapshot"]
    _original(db,snapshot)
    if (original_context["relationship_revision"],original_context["doctor_user_id"],original_context["patient_actor_user_id"],original_context["sender_identity_basis"]) != (
        rel.revision,rel.doctor_user_id,rel.patient_actor_user_id,_basis(db,user,rel,qualification)):
        raise HTTPException(409,"The original send context changed; it cannot borrow a new identity or relationship revision.")
    if payload.reply_to_message_id is not None:
        original = db.get(SharedCareMessage,payload.reply_to_message_id,populate_existing=True)
        if original is None:
            raise HTTPException(409,"The replied-to shared message does not exist in this original scope.")
        _verify(original)
        if (original.patient_id,original.relationship_id,original.relationship_revision,original.doctor_user_id,original.patient_actor_user_id) != (
            rel.patient_id,rel.id,rel.revision,rel.doctor_user_id,rel.patient_actor_user_id):
            raise HTTPException(409,"Replies must retain the same original patient and specific relationship revision.")
        _original(db,original.authorization_snapshot)
    doctor_sender = user.id == rel.doctor_user_id
    if payload.source_ai_decision_id is not None:
        from backend.app.services.agent.artifact_decision_service import validate_adoption
        validate_adoption(db,user,payload.source_ai_decision_id,target_type='shared_message',client_id=payload.client_message_id,
            patient_id=payload.patient_id,content={'text':payload.content})
    basis = original_context["sender_identity_basis"]
    row = SharedCareMessage(**payload.model_dump(exclude={"send_context"}),relationship_revision=rel.revision,doctor_user_id=rel.doctor_user_id,
        patient_actor_user_id=rel.patient_actor_user_id,sender_user_id=user.id,sender_identity_basis=basis,
        sender_kind="doctor" if doctor_sender else "patient",scope=["care"],authorization_snapshot=snapshot,
        content_digest=canonical_digest(_semantic(payload)),send_context_digest=canonical_digest(payload.send_context),
        context_digest="",sent_at=datetime.now(timezone.utc),version=1,snapshot={})
    db.add(row)
    try:
        db.flush()
        _seal_snapshot(db,row,_CONTEXT)
        append_care_event(db,patient_id=row.patient_id,actor_user_id=user.id,event_type="shared_message_sent",
            aggregate_type="shared_care_message",aggregate_id=row.id,revision=1,
            payload={"message_id":row.id,"relationship_id":row.relationship_id,"relationship_revision":row.relationship_revision,
                "content_digest":row.content_digest,"authorization_snapshot":snapshot},
            dedupe_key="shared_message:"+row.client_message_id,actor_identity_basis=basis)
        _audit(db,user,row.patient_id,"shared_message_sent",message_id=row.id,relationship_id=row.relationship_id,content_digest=row.content_digest)
    except IntegrityError as exc:
        raise HTTPException(409,"Concurrent message creation requires an unchanged retry of the original client message ID.") from exc
    return _ack(row),True


def get_original_message(db,user,client_message_id):
    row = db.scalar(select(SharedCareMessage).where(SharedCareMessage.client_message_id == client_message_id)
        .execution_options(populate_existing=True))
    if row is None:
        raise HTTPException(404,"Original shared message not found.")
    _verify(row)
    if row.sender_user_id != user.id:
        raise HTTPException(403,"Only the actual original sender can recover this original message ACK.")
    # An unchanged original ACK is a historical read, not another send.
    # Keep the sender check above and the same lawful read authority as history.
    _read_authority(db,user,row)
    _audit(db,user,row.patient_id,"shared_message_original_ack_read",message_id=row.id)
    return _ack(row)


def _receipt(row):
    _verify(row)
    return {"message_id":row.message_id,"viewer_user_id":row.viewer_user_id,"read_at":_utc(row.read_at)}


def list_messages(db,user,patient_id,relationship_id):
    _relationship(db,patient_id,relationship_id)
    db.info["requires_basic_use"] = False
    own = bool(self_access(db,user.id,patient_id))
    if own:
        require_patient_access(db,user,patient_id,"care")
    else:
        _scope(db,user,patient_id,relationship_id,processing=False)
    rows = db.scalars(select(SharedCareMessage).where(SharedCareMessage.patient_id == patient_id,
        SharedCareMessage.relationship_id == relationship_id).order_by(SharedCareMessage.sent_at,SharedCareMessage.id)
        .execution_options(populate_existing=True)).all()
    items = []
    for row in rows:
        _read_authority(db,user,row)
        receipts = db.scalars(select(SharedMessageRead).where(SharedMessageRead.message_id == row.id)
            .order_by(SharedMessageRead.viewer_user_id).execution_options(populate_existing=True)).all()
        receipt_values = [_receipt(receipt) for receipt in receipts]
        items.append({**_ack(row),"read_receipts":receipt_values,
            "viewer_read_at":next((r["read_at"] for r in receipt_values if r["viewer_user_id"] == user.id),None)})
    _audit(db,user,patient_id,"shared_messages_read",relationship_id=relationship_id,message_ids=[row.id for row in rows])
    return {"items":items}


def mark_message_read(db,user,message_id):
    row = db.get(SharedCareMessage,message_id,populate_existing=True)
    if row is None:
        raise HTTPException(404,"Shared message not found.")
    _read_authority(db,user,row)
    existing = db.scalar(select(SharedMessageRead).where(SharedMessageRead.message_id == message_id,
        SharedMessageRead.viewer_user_id == user.id).execution_options(populate_existing=True))
    if existing is not None:
        _audit(db,user,row.patient_id,"shared_message_read_receipt_retry",message_id=message_id)
        return _receipt(existing)
    receipt = SharedMessageRead(patient_id=row.patient_id,message_id=row.id,viewer_user_id=user.id,
        read_at=datetime.now(timezone.utc),snapshot={})
    db.add(receipt)
    try:
        db.flush()
        _seal_snapshot(db,receipt,_READ_CONTEXT)
        basis = identity_basis(db,user.id,row.patient_id) if self_access(db,user.id,row.patient_id) else f"doctor:{user.id}:relationship:{row.relationship_id}:revision:{row.relationship_revision}"
        append_care_event(db,patient_id=row.patient_id,actor_user_id=user.id,event_type="shared_message_read",
            aggregate_type="shared_message_read",aggregate_id=receipt.id,revision=1,
            payload={"message_id":row.id,"viewer_user_id":user.id,"relationship_id":row.relationship_id},
            dedupe_key=f"shared_message_read:{row.id}:{user.id}",actor_identity_basis=basis)
        _audit(db,user,row.patient_id,"shared_message_read_receipt",message_id=row.id,viewer_user_id=user.id)
    except IntegrityError as exc:
        raise HTTPException(409,"Concurrent read receipt requires an unchanged retry.") from exc
    return _receipt(receipt)


def list_message_relationships(db,user,patient_id):
    own = bool(self_access(db,user.id,patient_id))
    history = {}
    if own:
        db.info["requires_basic_use"] = False
        require_patient_access(db,user,patient_id,"care")
        for message in db.scalars(select(SharedCareMessage).where(SharedCareMessage.patient_id == patient_id)
                .order_by(SharedCareMessage.id).execution_options(populate_existing=True)).all():
            _verify(message)
            history[message.relationship_id] = message
    else:
        require_doctor(db,user.id)
    query = select(CareRelationship).where(CareRelationship.patient_id == patient_id)
    query = (query.where(or_(
        (CareRelationship.status == "active") & (CareRelationship.patient_actor_user_id == user.id),
        CareRelationship.id.in_(list(history)))) if own else query.where(
            CareRelationship.status == "active",CareRelationship.doctor_user_id == user.id))
    items = []
    for rel in db.scalars(query.order_by(CareRelationship.id)).all():
        try:
            _,qualification,snapshot = _scope(db,user,patient_id,rel.id,processing=True)
        except HTTPException as exc:
            if exc.status_code in {403,409}:
                original = history.get(rel.id)
                if original is not None:
                    items.append({"relationship_id":original.relationship_id,"relationship_revision":original.relationship_revision,
                        "doctor_user_id":original.doctor_user_id,"patient_actor_user_id":original.patient_actor_user_id,
                        "patient_id":patient_id,"scope":["care"],"can_send":False,"send_context":None,"send_context_digest":None})
                continue
            raise
        send_context = _issue_context(db,user,rel,qualification,snapshot)
        items.append({"relationship_id":rel.id,"relationship_revision":rel.revision,"doctor_user_id":rel.doctor_user_id,
            "patient_actor_user_id":rel.patient_actor_user_id,"patient_id":patient_id,"scope":["care"],"can_send":True,
            "send_context":send_context,"send_context_digest":canonical_digest(send_context)})
    _audit(db,user,patient_id,"shared_message_relationships_read",relationship_ids=[item["relationship_id"] for item in items])
    return {"items":items}
