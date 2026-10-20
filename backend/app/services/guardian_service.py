from backend.app.services.identity_access import publish_authority
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy import select
from backend.app.models.identity import (GuardianRelationship, GuardianHistory, PatientAccess, IdentityConfirmation, ConsentRecord, CareRelationship)
from backend.app.models.patient import Patient, PatientType
from backend.app.models.user import User
from backend.app.services import authorization_ledger as ledger
from backend.app.services.identity_access import require_reviewer, not_expired, TERMS_VERSION, guardian_is_current, GUARDIAN_DECLARATION_VERSION
from backend.app.services.care_relationship_service import check_revision
from backend.app.services.consent_service import event_for


def append_history(db, row, actor_id, action, basis, details):
    db.add(GuardianHistory(relationship_id=row.id, patient_id=row.patient_id, actor_user_id=actor_id, actor_identity_basis=basis, action=action, revision=row.revision, details=details))
    event_for(db, row, actor_id, basis, f"guardian.{action}", details)


def guardian_response(db, row):
    history = db.scalars(select(GuardianHistory).where(GuardianHistory.relationship_id == row.id).order_by(GuardianHistory.id)).all()
    confirmations = db.scalars(select(IdentityConfirmation).where(IdentityConfirmation.relationship_id == row.id,
        IdentityConfirmation.revision == row.revision, IdentityConfirmation.consumed_at.is_(None))).all()
    return {key:getattr(row,key) for key in ("id","patient_id","guardian_user_id","guardian_age","relation","status","revision","proof_reference","expires_at","institution_id")} | {"history":[{"id":item.id,"action":item.action,"revision":item.revision,"actor_user_id":item.actor_user_id,"actor_identity_basis":item.actor_identity_basis,"created_at":item.created_at,"details":item.details} for item in history],"effective_access":guardian_is_current(row),
        "successor_confirmations":[{"id":c.id,"user_id":c.user_id,"purpose":c.purpose,"age":c.age,"proof_reference":c.proof_reference} for c in confirmations]}


def confirm_own_relationship(db, user, relationship_id, payload):
    row = db.get(GuardianRelationship, relationship_id)
    if row is None:
        raise HTTPException(404, "Guardian relationship not found.")
    if row.guardian_user_id != user.id:
        raise HTTPException(403, "Only the registered guardian may confirm this relationship.")
    check_revision(row, payload.expected_revision)
    if row.status == "confirmed" and guardian_is_current(row):
        return guardian_response(db, row)
    if row.status != "pending" or not ledger.matches(row, active=False):
        raise HTTPException(409, "Only a current pending relationship can be confirmed.")
    access = db.scalar(select(PatientAccess).where(PatientAccess.guardian_relationship_id == row.id,
        PatientAccess.user_id == user.id, PatientAccess.patient_id == row.patient_id))
    if not access or access.status != "pending" or not ledger.matches(access, active=False):
        raise HTTPException(409, "The pending guardian access must be refreshed.")
    pending_basic = db.scalar(select(ConsentRecord).where(ConsentRecord.patient_id == row.patient_id,
        ConsentRecord.grantor_user_id == user.id, ConsentRecord.purpose == "basic_use",
        ConsentRecord.status == "pending", ConsentRecord.terms_version == TERMS_VERSION))
    ledger.deny(row); ledger.deny(access)
    row.status = "confirmed"; row.confirmed = True; row.guardian_age = payload.guardian_age
    row.institution_id = None; row.expires_at = None
    access.status = "active"; access.expires_at = None
    append_history(db, row, user.id, "self_confirmed", "guardian_self_declaration", {
        "declaration_version": GUARDIAN_DECLARATION_VERSION, "confirmed_by_user_id": user.id})
    db.commit()
    publish_authority(db, row); publish_authority(db, access)
    if pending_basic:
        from backend.app.services.consent_service import prepare_grant
        basic = prepare_grant(db, patient_id=row.patient_id, actor_id=user.id,
            purpose="basic_use", scope=pending_basic.scope)
        db.commit(); publish_authority(db, basic)
    return guardian_response(db, row)


def confirm_identity(db, user, relationship_id, payload, purpose):
    row = db.get(GuardianRelationship, relationship_id)
    if row is None:
        raise HTTPException(404, "Guardian relationship not found.")
    check_revision(row, payload.expected_revision)
    if row.status not in {"confirmed", "verified", "suspended"} or user.id == row.guardian_user_id:
        raise HTTPException(403, "A distinct prospective identity must authenticate its own confirmation.")
    if db.scalar(select(PatientAccess.id).where(PatientAccess.user_id == user.id, PatientAccess.status.in_(["active", "pending"]))):
        raise HTTPException(409, "The new identity already has a primary patient relationship.")
    existing = db.scalar(select(IdentityConfirmation).where(IdentityConfirmation.relationship_id == row.id, IdentityConfirmation.revision == row.revision, IdentityConfirmation.user_id == user.id, IdentityConfirmation.purpose == purpose))
    if existing is None:
        existing = IdentityConfirmation(relationship_id=row.id, revision=row.revision, user_id=user.id, purpose=purpose, proof_reference=payload.proof_reference, terms_version=TERMS_VERSION, age=payload.age)
        db.add(existing)
    elif existing.proof_reference != payload.proof_reference or existing.age != payload.age or existing.consumed_at:
        raise HTTPException(409, "The identity confirmation conflicts with an existing record.")
    db.commit()
    return {"id":existing.id,"relationship_id":row.id,"revision":row.revision,"purpose":purpose,"confirmed":True,"consumed":False}


def _invalidate_actor_grants(db, patient_id, actor_id, reviewer_id, basis):
    consents = db.scalars(select(ConsentRecord).where(ConsentRecord.patient_id == patient_id, ConsentRecord.grantor_user_id == actor_id, ConsentRecord.status == "active")).all()
    for consent in consents:
        from backend.app.services.consent_service import prepare_withdraw
        prepare_withdraw(db,consent,reviewer_id,basis,"consent.identity_invalidated")
    relationships = db.scalars(select(CareRelationship).where(CareRelationship.patient_id == patient_id, CareRelationship.patient_actor_user_id == actor_id, CareRelationship.status.in_(["active","pending"]))).all()
    for relationship in relationships:
        ledger.deny(relationship)
        relationship.status = "revoked"
        event_for(db, relationship, reviewer_id, basis, "care_relationship.identity_invalidated")


def change_guardian(db, user, relationship_id, payload, action):
    row = db.get(GuardianRelationship, relationship_id)
    if row is None:
        raise HTTPException(404, "Guardian relationship not found.")
    owner_action = user.id == row.guardian_user_id and action != "review"
    reviewer = None
    if not owner_action:
        if row.institution_id is None:
            raise HTTPException(403,"An institution is required only for independent professional verification.")
        reviewer = require_reviewer(db, user.id, row.institution_id)
    check_revision(row, payload.expected_revision)
    access = db.scalar(select(PatientAccess).where(PatientAccess.guardian_relationship_id == row.id))
    if access is None:
        raise HTTPException(403, "Guardian authority is incomplete.")
    if owner_action and (not ledger.matches(row, active=row.status in {"confirmed", "verified"}) or
        not ledger.matches(access, active=access.status == "active")):
        raise HTTPException(409, "Guardian authority changed; refresh before continuing.")
    basis = f"guardian_owner:{user.id}" if owner_action else f"institution_reviewer:{reviewer.institution_id}:{reviewer.id}"
    details = {"review_reference":payload.review_reference,"old_guardian_user_id":row.guardian_user_id,"action":action}
    activation = []
    confirmation = None
    new_user = None
    if action == "review":
        if row.status not in {"pending", "confirmed"} or payload.status is None:
            raise HTTPException(409, "Only a pending guardian can be reviewed.")
        desired = payload.status
    elif action == "suspend":
        if row.status not in {"confirmed", "verified"}:
            raise HTTPException(409, "Only a verified guardian can be suspended.")
        desired = "suspended"
    elif action == "restore":
        if row.status != "suspended":
            raise HTTPException(409, "Only a suspended guardian can be restored.")
        desired = "confirmed" if owner_action else "verified"
    elif action in {"transfer", "adult_conversion"}:
        if row.status not in {"confirmed","verified","suspended"}:
            raise HTTPException(409, "The guardian relationship cannot transition.")
        new_id = payload.new_guardian_user_id if action == "transfer" else payload.adult_user_id
        confirmed = payload.new_guardian_confirmed if action == "transfer" else payload.adult_confirmed
        if not new_id or confirmed is not True or new_id == row.guardian_user_id:
            raise HTTPException(400, "A distinct new identity and explicit confirmation are required.")
        new_user = db.get(User, new_id)
        if not new_user:
            raise HTTPException(404, "New identity account not found.")
        if not new_user.is_active:
            raise HTTPException(403, "The new identity account is inactive.")
        confirmation = db.scalar(select(IdentityConfirmation).where(IdentityConfirmation.relationship_id == row.id, IdentityConfirmation.revision == row.revision, IdentityConfirmation.user_id == new_id, IdentityConfirmation.purpose == action, IdentityConfirmation.consumed_at.is_(None)))
        if not confirmation or confirmation.terms_version != TERMS_VERSION:
            raise HTTPException(403, "The new identity must authenticate and confirm before transfer.")
        if db.scalar(select(PatientAccess.id).where(PatientAccess.user_id == new_id, PatientAccess.status.in_(["active","pending"]))):
            raise HTTPException(409, "New identity already has a primary patient relationship.")
        if action == "transfer" and (not payload.proof_reference or payload.proof_reference != confirmation.proof_reference):
            raise HTTPException(403, "Reviewed proof must match the new guardian's authenticated confirmation.")
        if action == "adult_conversion" and (payload.age is None or payload.age != confirmation.age):
            raise HTTPException(403, "Reviewed adult age must match authenticated confirmation.")
        desired = "transferred" if action == "transfer" else "adult_converted"
        details |= {"new_user_id":new_id,"identity_confirmation_id":confirmation.id,"proof_reference":confirmation.proof_reference}
    else:
        raise HTTPException(400, "Unknown guardian lifecycle action.")
    if desired == "verified" and (payload.expires_at is None or not not_expired(payload.expires_at)):
        raise HTTPException(400, "A future expiry is required for verified guardian authority.")
    if action == "transfer" and not owner_action and (payload.expires_at is None or not not_expired(payload.expires_at)):
        raise HTTPException(400, "A future expiry is required for new guardian authority.")
    retain_access = action == "review" and row.status == "confirmed" and desired == "verified"
    ledger.deny(row)
    if not retain_access:
        ledger.deny(access)
    row.status = desired
    if reviewer:
        row.institution_id = reviewer.institution_id
    elif desired == "confirmed":
        row.institution_id = None
    if desired in {"confirmed", "verified"}:
        row.expires_at = payload.expires_at
        access.status = "active"
        access.expires_at = payload.expires_at
        activation.append(row)
        if not retain_access:
            activation.append(access)
    else:
        access.status = "suspended" if desired == "suspended" else "revoked"
    if action in {"suspend","transfer","adult_conversion"}:
        _invalidate_actor_grants(db, row.patient_id, row.guardian_user_id, user.id, basis)
    append_history(db, row, user.id, action, basis, details)
    if confirmation:
        confirmation.consumed_at = datetime.now(timezone.utc)
        if action == "transfer":
            successor = GuardianRelationship(patient_id=row.patient_id, guardian_user_id=new_user.id, guardian_age=confirmation.age, relation=row.relation, proof_reference=confirmation.proof_reference, institution_id=reviewer.institution_id if reviewer else None, confirmed=True, status="verified" if reviewer else "confirmed", expires_at=payload.expires_at)
            db.add(successor)
            db.flush()
            ledger.reserve(successor)
            new_access = PatientAccess(patient_id=row.patient_id, user_id=new_user.id, access_kind="guardian", guardian_relationship_id=successor.id, status="active", expires_at=payload.expires_at)
            db.add(new_access)
            db.flush()
            ledger.reserve(new_access)
            activation.extend([successor,new_access])
            append_history(db, successor, user.id, "established_by_transfer", basis, details | {"previous_relationship_id":row.id})
        else:
            patient = db.get(Patient, row.patient_id)
            patient.patient_type = PatientType.ADULT
            patient.age = confirmation.age
            new_access = PatientAccess(patient_id=row.patient_id, user_id=new_user.id, access_kind="self", status="active")
            db.add(new_access)
            db.flush()
            ledger.reserve(new_access)
            activation.append(new_access)
    db.commit()
    for authority in activation:
        publish_authority(db,authority)
    if action == "review" and desired == "verified":
        pending_basic = db.scalar(select(ConsentRecord).where(ConsentRecord.patient_id == row.patient_id,ConsentRecord.grantor_user_id == row.guardian_user_id,ConsentRecord.purpose == "basic_use",ConsentRecord.status == "pending",ConsentRecord.terms_version == TERMS_VERSION))
        if pending_basic is not None:
            from backend.app.services.consent_service import prepare_grant
            basic = prepare_grant(db,patient_id=row.patient_id,actor_id=row.guardian_user_id,purpose="basic_use",scope=pending_basic.scope,expires_at=row.expires_at)
            db.commit()
            publish_authority(db,basic)
    return guardian_response(db, row)
