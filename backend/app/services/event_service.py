"""Append care facts within the caller's transaction; never commits or sends."""
from backend.app.models.event import CareEvent, CareEventDelivery
from backend.app.services.identity_access import identity_basis


def append_care_event(db, *, patient_id, actor_user_id, event_type, aggregate_type,
                      aggregate_id, revision, payload, dedupe_key, consumers=(), actor_identity_basis=None):
    # Trusted service callers may already hold the historical basis (including
    # pending/invalidated guardian authority). HTTP payloads never supply it.
    basis = actor_identity_basis if actor_identity_basis is not None else identity_basis(db,actor_user_id,patient_id)
    row = CareEvent(patient_id=patient_id,actor_user_id=actor_user_id,
        actor_identity_basis=basis,
        event_type=event_type,aggregate_type=aggregate_type,aggregate_id=aggregate_id,
        revision=revision,payload=payload,dedupe_key=dedupe_key)
    db.add(row)
    db.flush()
    for consumer in consumers:
        db.add(CareEventDelivery(event_id=row.event_id,consumer=consumer))
    return row


def append_submission_audit(db, *, patient_id, actor_user_id, result_kind, result_id, digest, submission_id=None,action="submission_committed"):
    from backend.app.services.security_service import _append_audit_log
    try:
        return _append_audit_log(db,action=action,status="success",
            message="真实提交与关键事务证据已保存。",patient_id=patient_id,actor_user_id=actor_user_id,
            detail_json={"result_kind":result_kind,"result_id":result_id,
                         "canonical_digest":digest,"submission_id":submission_id})
    except Exception as exc:
        from fastapi import HTTPException
        if isinstance(exc,HTTPException):
            raise
        raise HTTPException(503,{"message":"Critical submission audit is unavailable; query/retry the original submission ID.","submission_id":submission_id}) from exc


def mark_transaction_audit_committed(db):
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.transactional_audit_committed = True
