"""Authenticate handover sources and explicit current scope without borrowing old grants."""
import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone
from functools import wraps

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError

from backend.app.core.config import settings
from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.attention import AttentionItem
from backend.app.models.care_transfer import (CareTransferRequest, CareTransferDecision, CareTransferWorkItem,
    CareTransferClaim)
from backend.app.models.identity import CareRelationship
from backend.app.models.user import User
from backend.app.services.attention_service import verify_attention
from backend.app.services.cognitive_contract import canonical_digest
from backend.app.services.identity_access import (identity_basis, recheck_authenticated_actor, require_doctor,
    require_patient_access, require_processing_access, self_access, recheck_receipts)
from backend.app.services.submission_service import _receipt_tuples

REQUEST_FIELDS = ("client_transfer_id", "patient_id", "author_user_id", "author_identity_basis", "receiver_doctor_user_id",
    "receiving_relationship_id", "requested_at", "version", "request_context_digest", "payload_digest", "authorization_snapshot")
DECISION_FIELDS = ("client_decision_id", "patient_id", "transfer_id", "actor_user_id", "actor_identity_basis", "decision",
    "expected_version", "version", "confirmed", "decided_at", "decision_context_digest", "payload_digest", "authorization_snapshot")
WORK_FIELDS = ("patient_id", "transfer_id", "decision_id", "source_type", "source_id", "original_attention_id", "assessment_id",
    "from_doctor_user_id", "responsible_doctor_id", "receiving_relationship_id", "accepted_at", "expected_response_at", "authorization_snapshot")
ACTION_FIELDS = ("client_action_id", "patient_id", "work_item_id", "actor_user_id", "actor_identity_basis", "action", "previous_status",
    "status", "expected_version", "version", "occurred_at", "action_context_digest", "payload_digest", "authorization_snapshot")
FINAL_STATUS = {"accept": "accepted", "reject": "rejected", "cancel": "cancelled"}
_PREFIXES = {"request": "care-transfer-request-context", "decision": "care-transfer-decision-context", "work": "care-transfer-work-context"}


def utc(value):
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def plain(value):
    def encode(item):
        if isinstance(item, datetime):
            return utc(item).isoformat()
        raise ValueError("Handover metadata must contain finite JSON values and actual UTC times.")
    return json.loads(json.dumps(value, default=encode, allow_nan=False))


def metadata(row, fields):
    return plain({field: getattr(row, field) for field in fields})


def storage_boundary(handler):
    @wraps(handler)
    def invoke(*args, **kwargs):
        try:
            return handler(*args, **kwargs)
        except DBAPIError as exc:
            raise HTTPException(503, "Handover storage is unavailable; query/retry the unchanged original ID.") from exc
    return invoke


def validated_payload(model, value):
    try:
        return model.model_validate(value.model_dump() if isinstance(value, BaseModel) else value)
    except ValidationError as exc:
        raise HTTPException(422, exc.errors(include_context=False)) from exc


def audit(db, user, patient_id, action, **detail):
    from backend.app.services.security_service import _append_audit_log
    try:
        _append_audit_log(db, action=action, status="success", actor_user_id=user.id, patient_id=patient_id,
            message="具体对象责任交接的实际身份和事务记录。", detail_json=detail)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Critical handover audit is unavailable; no acknowledgement is disclosed.") from exc


def own(db, user, patient_id, *, processing=False):
    recheck_authenticated_actor(db, user.id)
    if not self_access(db, user.id, patient_id):
        raise HTTPException(403, "Only the actual self user or current verified guardian may authorize this object list.")
    db.info["requires_basic_use"] = processing
    if processing:
        require_processing_access(db, user, patient_id, {"assessment", "care"})
    else:
        require_patient_access(db, user, patient_id, {"assessment", "care"})
    return identity_basis(db, user.id, patient_id)


def receiver_scope(db, patient_id, relationship_id, *, processing, expected_doctor=None):
    relation = db.get(CareRelationship, relationship_id, populate_existing=True)
    if relation is None or relation.patient_id != patient_id or relation.purpose != "clinical_sharing":
        raise HTTPException(403, "An actual specific clinical-sharing relationship is required.")
    if expected_doctor is not None and relation.doctor_user_id != expected_doctor:
        raise HTTPException(403, "This handover is addressed to a different actual doctor.")
    doctor = db.get(User, relation.doctor_user_id, populate_existing=True)
    if doctor is None:
        raise HTTPException(403, "The actual receiving doctor is unavailable.")
    qualification = require_doctor(db, doctor.id)
    if relation.institution_id != qualification.institution_id:
        raise HTTPException(403, "The receiving relationship does not match the doctor's actual institution.")
    db.info["requires_basic_use"] = processing
    require_patient_access(db, doctor, patient_id, {"assessment", "care"}, relationship_id=relation.id)
    return relation, f"doctor:{doctor.id}:qualification:{qualification.id}:revision:{qualification.revision}:relationship:{relation.id}:revision:{relation.revision}"


def original_authority(db, snapshot):
    previous = list(db.info.get("authorization_receipts", []))
    processing = db.info.get("requires_basic_use", False)
    originals = _receipt_tuples(snapshot)
    if not originals:
        raise RecordIntegrityError("The original handover authority snapshot is missing.")
    recheck_receipts(db, originals)
    db.info["authorization_receipts"] = list(dict.fromkeys(previous + originals))
    db.info["requires_basic_use"] = processing
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.authorization_receipts = db.info["authorization_receipts"]


def original_historical_authority(db, snapshot):
    # Reading actual clinical history still needs its original non-basic grant
    # and qualification heads. Withdrawing basic use stops new processing but
    # does not delete already committed, otherwise-lawful history.
    from backend.app.services.attention_action_service import _is_basic_consent
    originals = _receipt_tuples(snapshot)
    historical = []
    for actor, patient, scopes, purpose, versions in originals:
        retained = tuple(version for version in versions if version[0] != "consent_records" or not _is_basic_consent(db, version[3]))
        historical.append((actor, patient, scopes, "clinical" if purpose == "processing" else purpose, retained))
    original_authority(db, historical)


def save_authority(db):
    return {key: list(value) if isinstance(value, list) else value for key in
        ("authorization_receipts", "credential_receipts", "requires_basic_use") for value in [db.info.get(key)]}


def restore_authority(db, saved):
    for key, value in saved.items():
        if value is None:
            db.info.pop(key, None)
        else:
            db.info[key] = value
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.authorization_receipts = db.info.get("authorization_receipts", [])
        request.state.credential_receipts = db.info.get("credential_receipts", [])


def issue_context(kind, value):
    body = {"purpose": "care_transfer_" + kind, "context_version": 1, **plain(value)}
    encoded = base64.urlsafe_b64encode(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).decode().rstrip("=")
    key = hmac.new(settings.SECRET_KEY.encode(), ("adhd-ab/care-transfer/" + kind + "/v1").encode(), hashlib.sha256).digest()
    return _PREFIXES[kind] + ".v1." + encoded + "." + hmac.new(key, encoded.encode(), hashlib.sha256).hexdigest()


def open_context(kind, token, user):
    try:
        prefix, version, encoded, signature = token.split(".")
        key = hmac.new(settings.SECRET_KEY.encode(), ("adhd-ab/care-transfer/" + kind + "/v1").encode(), hashlib.sha256).digest()
        if prefix != _PREFIXES[kind] or version != "v1" or not hmac.compare_digest(signature, hmac.new(key, encoded.encode(), hashlib.sha256).hexdigest()):
            raise ValueError("signature")
        value = json.loads(base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
        if (value["purpose"], value["context_version"], value["actor_user_id"]) != ("care_transfer_" + kind, 1, user.id):
            raise ValueError("actual actor")
        return value
    except (ValueError, KeyError, TypeError, UnicodeError) as exc:
        raise HTTPException(403, "The original handover context is invalid for this actual account and purpose.") from exc


def verify_request(row):
    value = row.body
    if value.get("metadata") != metadata(row, REQUEST_FIELDS) or row.version != 1:
        raise RecordIntegrityError("Handover request routing differs from its authenticated original.")
    return value


def request_row(db, identifier):
    row = db.get(CareTransferRequest, identifier, populate_existing=True)
    if row is None:
        raise HTTPException(404, "Handover request not found.")
    verify_request(row)
    return row


def verify_decision(row):
    value = row.body
    if value.get("metadata") != metadata(row, DECISION_FIELDS) or row.decision not in FINAL_STATUS or (row.expected_version, row.version, row.confirmed) != (1, 2, True):
        raise RecordIntegrityError("Handover decision differs from its authenticated actual actor and scope.")
    return value


def work_state(row):
    return {"status": row.status, "version": row.version, "suspension_reason": row.suspension_reason}


def verify_work(db, row):
    value = row.detail
    if value.get("context_snapshot") != metadata(row, WORK_FIELDS) or row.state_snapshot != work_state(row) or row.version < 1:
        raise RecordIntegrityError("Successor work responsibility or state differs from its accepted original.")
    request = request_row(db, row.transfer_id)
    decision = db.get(CareTransferDecision, row.decision_id, populate_existing=True)
    if decision is None:
        raise RecordIntegrityError("Successor work has no actual accepting decision.")
    verify_decision(decision)
    if (decision.decision, decision.transfer_id, decision.patient_id, decision.actor_user_id, request.patient_id,
            request.receiver_doctor_user_id, request.receiving_relationship_id) != ("accept", row.transfer_id, row.patient_id,
            row.responsible_doctor_id, row.patient_id, row.responsible_doctor_id, row.receiving_relationship_id):
        raise RecordIntegrityError("Successor work differs from the actual user request and doctor acceptance.")
    selected = next((source for source in request.body["sources"] if (source["source_type"], source["source_id"]) == (row.source_type, row.source_id)), None)
    if selected is None or value.get("source_snapshot") != selected or row.authorization_snapshot != decision.authorization_snapshot or utc(row.accepted_at) != utc(decision.decided_at):
        raise RecordIntegrityError("Successor work changed the explicitly selected original or accepting authority.")
    if (selected.get("original_attention_id"), selected.get("assessment_id"), selected.get("from_doctor_user_id")) != (
            row.original_attention_id, row.assessment_id, row.from_doctor_user_id):
        raise RecordIntegrityError("Successor work has a different root evidence or original responsible actor.")
    root = db.get(AttentionItem, row.original_attention_id, populate_existing=True)
    if root is None or (root.patient_id, root.assessment_id) != (row.patient_id, row.assessment_id):
        raise RecordIntegrityError("Successor work has no actual selected original attention.")
    verify_attention(root)
    from backend.app.services.attention_action_service import _source
    _source(db, root)  # Authenticate historical evidence; never reuse its old grant.
    return value


def work_row(db, identifier):
    row = db.get(CareTransferWorkItem, identifier, populate_existing=True)
    if row is None:
        raise HTTPException(404, "Successor work not found.")
    verify_work(db, row)
    return row


def source_info(db, source_type, identifier, patient_id):
    if source_type == "attention":
        row = db.get(AttentionItem, identifier, populate_existing=True)
        if row is None:
            raise HTTPException(404, "Original attention not found.")
        verify_attention(row)
        from backend.app.services.attention_action_service import _source
        session, _ = _source(db, row)  # Historical authenticity, not old grant permission.
        if row.patient_id != patient_id or row.owner_kind != "doctor":
            raise HTTPException(403, "Only the selected patient's actual clinical attention may be handed over.")
        info = {"source_type": source_type, "source_id": row.id, "expected_version": row.version,
            "patient_id": row.patient_id, "assessment_id": row.assessment_id, "assessment_version": session.version,
            "original_attention_id": row.id, "from_doctor_user_id": row.responsible_doctor_id,
            "source_relationship_id": row.relationship_id, "status": row.status, "suspension_reason": row.suspension_reason,
            "source_digest": canonical_digest({"detail": row.detail, "state": row.state_snapshot}), "kind": row.kind}
    elif source_type == "transferred_work":
        row = work_row(db, identifier)
        if row.patient_id != patient_id:
            raise HTTPException(403, "The successor source belongs to another patient.")
        info = {"source_type": source_type, "source_id": row.id, "expected_version": row.version,
            "patient_id": row.patient_id, "assessment_id": row.assessment_id, "assessment_version": None,
            "original_attention_id": row.original_attention_id, "from_doctor_user_id": row.responsible_doctor_id,
            "source_relationship_id": row.receiving_relationship_id, "status": row.status, "suspension_reason": row.suspension_reason,
            "source_digest": canonical_digest({"detail": row.detail, "state": row.state_snapshot}), "kind": "transferred_attention"}
    else:
        raise HTTPException(422, "Unknown concrete handover source type.")
    if row.status not in {"open", "acknowledged", "in_progress", "suspended"} or row.suspension_reason == "responsibility_transferred":
        raise HTTPException(409, "This source is terminal or already has a successor; select its actual current work instead.")
    claim = db.get(CareTransferClaim, (source_type, identifier), populate_existing=True)
    if claim and claim.patient_id != patient_id:
        raise RecordIntegrityError("Handover claim routes to a different actual subject.")
    info["claim_revision"] = claim.revision if claim else 0
    info["claimed_transfer_id"] = claim.transfer_id if claim else None
    return info


def read_request_authority(db, user, row):
    recheck_authenticated_actor(db, user.id)
    if self_access(db, user.id, row.patient_id):
        return own(db, user, row.patient_id)
    if row.receiver_doctor_user_id != user.id:
        raise HTTPException(403, "Only the lawful patient identity or the actual addressed doctor may read this request.")
    basis = receiver_scope(db, row.patient_id, row.receiving_relationship_id, processing=False, expected_doctor=user.id)[1]
    original_historical_authority(db, row.authorization_snapshot)
    return basis


def read_work_authority(db, user, row, *, processing=False):
    if not processing and self_access(db, user.id, row.patient_id):
        return own(db, user, row.patient_id)
    if row.responsible_doctor_id != user.id:
        raise HTTPException(403, "Only the actual accepting doctor can process this successor work.")
    _, basis = receiver_scope(db, row.patient_id, row.receiving_relationship_id, processing=processing, expected_doctor=user.id)
    if processing:
        original_authority(db, row.authorization_snapshot)
    else:
        original_historical_authority(db, row.authorization_snapshot)
    return basis


def request_ack(row):
    value = verify_request(row)
    return {"id": row.id, **metadata(row, REQUEST_FIELDS), "sources": value["sources"], "reason": value["reason"],
        "status": "pending_acceptance", "status_snapshot_at_creation": True, "confirmed": True,
        "submission_status": "committed", "legacy": False}


def decision_ack(db, row):
    value = verify_decision(row)
    request = request_row(db, row.transfer_id)
    work = db.scalars(select(CareTransferWorkItem).where(CareTransferWorkItem.decision_id == row.id).order_by(CareTransferWorkItem.id)).all()
    expected = {(source["source_type"], source["source_id"]) for source in request.body["sources"]} if row.decision == "accept" else set()
    if {(item.source_type, item.source_id) for item in work} != expected or len(work) != len(expected):
        raise RecordIntegrityError("Original handover ACK has missing or unselected actual successor work.")
    for item in work:
        verify_work(db, item)
    return {"id": row.id, **metadata(row, DECISION_FIELDS), "reason": value["reason"], "status": FINAL_STATUS[row.decision],
        "work_item_ids": [item.id for item in work], "submission_status": "committed", "legacy": False}


def work_response(db, row):
    value = verify_work(db, row)
    from backend.app.services.care_transfer_maintenance import observations
    return {"id": row.id, **metadata(row, WORK_FIELDS), **work_state(row), "response_coverage": value["response_coverage"],
        **observations(db, row),
        "source_snapshot": value["source_snapshot"], "original_provenance_preserved": True, "legacy": False}


def verify_action(row):
    value = row.body
    if value.get("metadata") != metadata(row, ACTION_FIELDS):
        raise RecordIntegrityError("Successor work action differs from its authenticated actual actor and body.")
    return value


def action_ack(row):
    value = verify_action(row)
    return {"action_id": row.id, **metadata(row, ACTION_FIELDS), "reason": value["reason"],
        "confirmed": True, "submission_status": "committed", "legacy": False}
