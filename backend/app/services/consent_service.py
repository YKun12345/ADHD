from fastapi import HTTPException
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError
from backend.app.models.identity import ResearchProject
from backend.app.models.consent import ConsentRecord, ConsentAuthority
from backend.app.services.event_service import append_care_event
from backend.app.services import authorization_ledger as ledger
from backend.app.services.identity_access import SCOPES, TERMS_VERSION, identity_basis, not_expired, require_doctor


def authority_key(purpose, target_user_id=None, project_id=None):
    return f"doctor:{target_user_id}" if purpose == "clinical_sharing" else (f"project:{project_id}" if purpose == "research" else "patient")


def effective_consent(db, row):
    authority = db.get(ConsentAuthority,row.authority_id,populate_existing=True)
    if not authority or authority.current_record_id != row.id or authority.revision != row.revision or authority.ledger_key != row.ledger_key or authority.status != "active" or not ledger.matches(authority):
        return False
    if row.status != "active" or row.terms_version != TERMS_VERSION or not not_expired(row.expires_at) or not ledger.matches(row):
        return False
    try:
        if row.actor_identity_basis != identity_basis(db, row.grantor_user_id, row.patient_id):
            return False
    except HTTPException:
        return False
    if row.purpose == "clinical_sharing" and not require_valid_doctor(db, row.target_user_id):
        return False
    if row.purpose == "research":
        from backend.app.services.federated_control_service import assert_project_gate
        try:
            assert_project_gate(db,row.project_id)
            from backend.app.services.federated_control_service import assert_consent_gate
            assert_consent_gate(db,row)
        except HTTPException:
            return False
        project = db.get(ResearchProject, row.project_id)
        if not project or project.status != "active" or not not_expired(project.expires_at) or not ledger.matches(project):
            return False
        from backend.app.services.identity_access import record_authority
        record_authority(db,project)
    from backend.app.services.identity_access import record_authority
    record_authority(db,row)
    return True


def require_valid_doctor(db, user_id):
    try:
        return require_doctor(db, user_id)
    except HTTPException:
        return None


def current_consent(db, patient_id, purpose, *, target_user_id=None, project_id=None):
    authority = db.scalar(select(ConsentAuthority).where(ConsentAuthority.patient_id == patient_id,ConsentAuthority.purpose == purpose,ConsentAuthority.authority_key == authority_key(purpose,target_user_id,project_id)).execution_options(populate_existing=True))
    return db.get(ConsentRecord,authority.current_record_id,populate_existing=True) if authority and authority.current_record_id else None


def has_consent(db, patient_id, purpose, *, target_user_id=None, project_id=None, scope=None, consent_id=None):
    row = current_consent(db,patient_id,purpose,target_user_id=target_user_id,project_id=project_id)
    return bool(row and (consent_id is None or row.id == consent_id) and (not scope or set(scope) <= set(row.scope)) and effective_consent(db, row))


def event_for(db, row, actor_id, basis, event_type, payload=None):
    if payload is None and isinstance(row,ConsentRecord):
        payload = {key:getattr(row,key) for key in ("id","patient_id","purpose","status","revision","authority_id","scope","target_user_id","project_id","grantor_user_id","actor_identity_basis","terms_version")}
        payload["expires_at"] = row.expires_at.isoformat() if row.expires_at else None
    from backend.app.services.care_suspension_service import authority_invalidation
    payload = dict(payload or {"status":row.status})
    invalidation = authority_invalidation(row, event_type)
    if isinstance(row, ConsentRecord) and event_type == "consent.superseded" and "pending" in inspect(row).attrs.status.history.deleted:
        invalidation = False
    if invalidation:
        # The encrypted event payload binds mutable routing columns to the
        # actual server-side authority at the moment of invalidation.
        payload["authority_ref"] = {"table":row.__tablename__,"id":row.id,
            "revision":row.revision,"patient_id":row.patient_id,"event_type":event_type,
            "ledger_key":row.ledger_key,"actor_user_id":actor_id,"actor_identity_basis":basis}
    return append_care_event(db,patient_id=row.patient_id,actor_user_id=actor_id,
        actor_identity_basis=basis,event_type=event_type,aggregate_type=row.__tablename__,
        aggregate_id=row.id,revision=row.revision,payload=payload,
        dedupe_key=f"authority:{row.__tablename__}:{row.id}:{row.revision}:{event_type}",
        consumers=("care_authority_invalidation",) if invalidation else ())


def _append_grant(db, *, patient_id, actor_id, purpose, scope, basis, target_user_id=None, project_id=None, expires_at=None, status="active"):
    key = authority_key(purpose,target_user_id,project_id)
    authority = db.scalar(select(ConsentAuthority).where(ConsentAuthority.patient_id == patient_id,ConsentAuthority.purpose == purpose,ConsentAuthority.authority_key == key).with_for_update())
    if authority:
        previous = db.get(ConsentRecord,authority.current_record_id)
        ledger.deny(authority)
        if previous and previous.status in {"active","pending"}:
            previous.status = "superseded"
            event_for(db,previous,actor_id,basis,"consent.superseded")
    else:
        authority = ConsentAuthority(patient_id=patient_id,purpose=purpose,authority_key=key,status="pending")
        db.add(authority)
        try:
            db.flush()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(409,"A concurrent consent authority was created; refresh before granting.") from exc
        ledger.reserve(authority)
    authority.status = status
    row = ConsentRecord(authority_id=authority.id,ledger_key=authority.ledger_key,revision=authority.revision,patient_id=patient_id,purpose=purpose,authority_key=key,status=status,grantor_user_id=actor_id,actor_identity_basis=basis,terms_version=TERMS_VERSION,scope=sorted(set(scope)),target_user_id=target_user_id,project_id=project_id,expires_at=expires_at)
    db.add(row)
    db.flush()
    authority.current_record_id = row.id
    return row


def prepare_pending_basic(db,patient_id,actor_id):
    row = _append_grant(db,patient_id=patient_id,actor_id=actor_id,purpose="basic_use",scope=SCOPES,basis="guardian_registration_pending",status="pending")
    event_for(db,row,actor_id,row.actor_identity_basis,"consent.pending_identity_review")
    return row


def prepare_withdraw(db,row,actor_id,basis,event_type="consent.withdrawn"):
    authority = db.get(ConsentAuthority,row.authority_id)
    if not authority or authority.current_record_id != row.id or authority.revision != row.revision:
        raise HTTPException(409,"Only the current consent grant can be withdrawn.")
    ledger.deny(authority)
    authority.status = "withdrawn"
    row.revision = authority.revision
    row.status = "withdrawn"
    event_for(db,row,actor_id,basis,event_type)


def prepare_grant(db, *, patient_id, actor_id, purpose, scope, target_user_id=None, project_id=None, expires_at=None,expected_project_revision=None):
    basis = identity_basis(db, actor_id, patient_id)
    if purpose not in {"basic_use", "clinical_sharing", "external_ai", "research"} or not scope or not set(scope) <= SCOPES:
        raise HTTPException(400, "Unknown consent purpose or scope.")
    if not not_expired(expires_at):
        raise HTTPException(400, "Consent expiry must be in the future.")
    if purpose == "clinical_sharing":
        if not target_user_id:
            raise HTTPException(400, "Clinical consent needs a concrete doctor.")
        require_doctor(db, target_user_id)
    elif target_user_id is not None:
        raise HTTPException(400, "Only clinical consent accepts a target doctor.")
    if purpose == "research":
        from backend.app.services.federated_control_service import assert_project_gate
        assert_project_gate(db,project_id)
        project = db.get(ResearchProject, project_id) if project_id else None
        if not project or project.status != "active" or not not_expired(project.expires_at) or not ledger.matches(project):
            raise HTTPException(400, "Research consent needs a configured active project.")
        if project.ledger_key.startswith('fed-project-') and expected_project_revision!=project.revision:
            raise HTTPException(409,'原研究授权所核对的项目审批版本已改变，请重新阅读并明确确认。')
        if project.ledger_key.startswith('fed-project-') and expires_at is not None:
            from datetime import timezone
            if expires_at.tzinfo is None:
                raise HTTPException(422,'具体研究授权有效期需要含时区。')
            expires_at=expires_at.astimezone(timezone.utc)
    elif project_id is not None:
        raise HTTPException(400, "Only research consent accepts a project.")
    row = _append_grant(db,patient_id=patient_id,actor_id=actor_id,purpose=purpose,scope=scope,basis=basis,target_user_id=target_user_id,project_id=project_id,expires_at=expires_at)
    if purpose == 'research':
        from backend.app.services.federated_control_service import bind_research_consent
        bind_research_consent(db,row)
    event_for(db, row, actor_id, basis, "consent.granted")
    return row


def consent_response(db, row):
    effective = effective_consent(db, row)
    return {key:getattr(row,key) for key in ("id","patient_id","purpose","status","revision","scope","target_user_id","project_id","grantor_user_id","actor_identity_basis","terms_version","expires_at")} | {"effective_access":effective, "effective_status": "active" if effective else (row.status if row.status != "active" else "denied")}
