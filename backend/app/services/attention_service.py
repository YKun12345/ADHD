"""Authorize and audit durable attention; a notification is never resolution."""
from datetime import timezone
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.attention import AttentionItem
from backend.app.services.identity_access import require_doctor, require_patient_access, resolve_patient, self_access, recheck_receipts
from backend.app.services.submission_service import _receipt_tuples


def attention_context():
    return ("source_event_id","kind","patient_id","assessment_id","submission_id","owner_kind",
        "responsible_doctor_id","relationship_id","created_for_user_id")


def attention_state():
    return ("status","version","suspension_reason","expected_response_at")


def state_values(row):
    values = {key:getattr(row,key) for key in attention_state()}
    if values["expected_response_at"] is not None:
        value = values["expected_response_at"]
        values["expected_response_at"] = (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()
    return values


def verify_attention(row):
    if (row.status not in {"open","acknowledged","resolved","closed_with_reason","suspended","in_progress","closed"}
        or type(row.version) is not int or row.version < 1
        or row.detail.get("context_snapshot") != {key:getattr(row,key) for key in attention_context()}
        or row.state_snapshot != state_values(row)):
        raise RecordIntegrityError("Attention responsibility or workflow state differs from its authenticated version.")


def set_attention_state(row,status,reason=None):
    verify_attention(row)
    if row.status == status and row.suspension_reason == reason:
        return
    row.status = status
    row.suspension_reason = reason
    row.version += 1
    row.state_snapshot = state_values(row)


def allowed_attention_actions(row):
    """Legacy provisional values are readable without inventing an action fact."""
    verify_attention(row)
    return {"open":["acknowledge","close_with_reason"],
        "acknowledged":["resolve","close_with_reason"]}.get(row.status,[])


def response(row,db=None):
    verify_attention(row)
    result = {"id":row.id,**{key:getattr(row,key) for key in attention_context()},**state_values(row),
        "quality_reasons":row.detail["quality_reasons"],"response_coverage":row.detail["response_coverage"],
        "assessment_version":row.detail["assessment_version"],"created_at":row.created_at,
        "allowed_actions":["read_evidence"] if row.submission_id else ["view_assessment"]}
    if db is not None and row.responsible_doctor_id:
        from backend.app.services.service_coverage_service import current_coverage
        result["current_service_coverage"] = current_coverage(db,row.responsible_doctor_id)
    if db is not None and row.status == "suspended":
        from backend.app.models.care_system_event import CareSystemEvent
        from backend.app.services.care_authority_reconciliation import verify_system_event
        fact = db.scalar(select(CareSystemEvent).where(CareSystemEvent.assessment_id == row.assessment_id,
            CareSystemEvent.event_type == "original_authority_suspended").order_by(CareSystemEvent.id.desc()))
        if fact:
            value = verify_system_event(fact)
            result["suspension_observation"] = {"system_principal": fact.system_principal,
                "observed_at": value["context_snapshot"]["observed_at"], "reason_code": value["observation"]["code"],
                "human_action": False}
    if db is not None:
        from backend.app.services.attention_deadline_service import overdue_observation
        observation = overdue_observation(db,row)
        if observation:
            result["overdue_observation"] = observation
    return result


def _audit_read(db,user,rows,patient_id=None,*,commit=True):
    from backend.app.services.security_service import _append_audit_log
    from backend.app.services.deferred_read_audit import append_read_audit
    try:
        for target in rows or [None]:
            audit = _append_audit_log if commit else lambda db, **values: append_read_audit(db, failure_detail="Critical access audit is unavailable; attention evidence is withheld.", **values)
            audit(db,action="data_read",status="success",message="关注待办的当前权限与原责任范围已核验。",
                patient_id=target.patient_id if target else patient_id,actor_user_id=user.id,
                detail_json={"scope":"assessment_attention","attention_id":target.id if target else None})
        if commit:
            db.commit()
    except HTTPException:
        raise
    except Exception as exc:
        if commit:
            db.rollback()
        raise HTTPException(503,"Critical access audit is unavailable; attention evidence is withheld.") from exc


def patient_attention(db,user,patient_id=None,*,commit=True):
    patient = resolve_patient(db,user,"assessment") if patient_id is None else require_patient_access(db,user,patient_id,"assessment")
    if not self_access(db,user.id,patient.id):
        raise HTTPException(403,"Only the actual self user or current verified guardian can read this personal attention list.")
    rows = db.scalars(select(AttentionItem).where(AttentionItem.patient_id == patient.id).order_by(AttentionItem.id.desc())).all()
    values = [response(row,db) for row in rows]
    _audit_read(db,user,rows,patient.id,commit=commit)
    return {"items":values,"service_coverage":{"status":"per_attention" if any(
        value["response_coverage"].get("status") == "configured" for value in values) else "not_configured","emergency_process":"not_configured"}}


def doctor_work_queue(db,user,patient_id=None,*,commit=True):
    require_doctor(db,user.id)
    query = select(AttentionItem).where(AttentionItem.responsible_doctor_id == user.id,
        AttentionItem.owner_kind == "doctor",AttentionItem.status.in_(["open","acknowledged","in_progress"]))
    if patient_id is not None:
        query = query.where(AttentionItem.patient_id == patient_id)
    rows = db.scalars(query.order_by(AttentionItem.id)).all()
    allowed,values = [],[]
    for row in rows:
        previous = {key:db.info.get(key) for key in ("authorization_receipts","credential_receipts","requires_basic_use")}
        previous = {key:list(value) if isinstance(value,list) else value for key,value in previous.items()}
        try:
            require_patient_access(db,user,row.patient_id,{"assessment","care"},relationship_id=row.relationship_id)
            verify_attention(row)
            originals = _receipt_tuples(row.detail["authorization_snapshot"])
            recheck_receipts(db,originals)
            db.info["authorization_receipts"] = list(previous.get("authorization_receipts") or [])+originals
            values.append(response(row,db)); allowed.append(row)
        except HTTPException as exc:
            if exc.status_code not in {403,409}:
                raise
            for key,value in previous.items():
                if value is None: db.info.pop(key,None)
                else: db.info[key] = value
    from backend.app.services.service_coverage_service import current_coverage
    coverage = current_coverage(db,user.id)
    _audit_read(db,user,allowed,commit=commit)
    return {"items":values,"service_coverage":coverage}
