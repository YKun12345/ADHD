from backend.app.services.identity_access import publish_authority
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException
from sqlalchemy import select
from backend.app.models.identity import CareRelationship, PatientAccess
from backend.app.models.patient import Patient
from backend.app.models.user import User
from backend.app.services import authorization_ledger as ledger
from backend.app.services.identity_access import require_doctor, resolve_patient, self_access, identity_basis, not_expired, require_patient_access
from backend.app.services.consent_service import prepare_grant, event_for, effective_consent


def current_patient_actor(db,patient_id,doctor_user_id):
    """Project current authorized contact without changing the historical Patient.user_id."""
    require_patient_access(db,db.get(User,doctor_user_id),patient_id,"profile")
    from backend.app.services.consent_service import has_consent
    rows = db.scalars(select(CareRelationship).where(CareRelationship.patient_id == patient_id,CareRelationship.doctor_user_id == doctor_user_id,CareRelationship.status == "active").order_by(CareRelationship.id.desc())).all()
    for row in rows:
        if ledger.matches(row) and not_expired(row.expires_at) and has_consent(db,patient_id,"clinical_sharing",target_user_id=doctor_user_id,scope={"profile"},consent_id=row.consent_id):
            actor = db.get(User,row.patient_actor_user_id)
            if actor and actor.is_active and self_access(db,actor.id,patient_id):
                return actor
    raise HTTPException(403,"No current authorized patient contact.")


def check_revision(row, expected):
    if row.revision != expected or not (ledger.matches(row) or ledger.matches(row, active=False)):
        raise HTTPException(409, "Authorization revision conflict.")


def relationship_response(db, row, viewer_id):
    patient = db.get(Patient, row.patient_id)
    doctor = db.get(User, row.doctor_user_id)
    patient_actor = db.get(User, row.patient_actor_user_id)
    status = row.status
    if status in {"pending", "active"} and not not_expired(row.expires_at):
        status = "expired"
    effective = False
    if status == "active":
        try:
            require_patient_access(db, doctor, row.patient_id, row.scope, relationship_id=row.id)
            effective = True
        except HTTPException:
            pass
    party_allowed = viewer_id == row.doctor_user_id or (viewer_id == row.patient_actor_user_id and self_access(db,viewer_id,row.patient_id))
    can_revoke = bool(party_allowed and row.status in {"active","pending"} and (ledger.matches(row) or ledger.matches(row,active=False)))
    patient_name = None
    try:
        require_patient_access(db,db.get(User,viewer_id),row.patient_id,"profile")
        patient_name = patient.display_name or patient.user.full_name
    except HTTPException as exc:
        if exc.status_code not in {403,404}:
            raise
    return {key:getattr(row,key) for key in ("id","patient_id","doctor_user_id","initiator_user_id","revision","scope","purpose","expires_at","patient_confirmed","doctor_confirmed")} | {"status":status,"effective_access":effective,"effective_status":"active" if effective else ("denied" if status == "active" else status),"can_revoke":can_revoke,"patient_name":patient_name,"doctor_name":doctor.full_name,"counterparty_email":doctor.email if viewer_id != row.doctor_user_id else patient_actor.email}


def create_invitation(db, actor, payload):
    target = db.scalar(select(User).where(User.email == payload.target_email))
    if not target:
        raise HTTPException(404, "Invitation target not found.")
    if target.id == actor.id:
        raise HTTPException(400, "Cannot invite the same account.")
    own = db.scalars(select(PatientAccess).where(PatientAccess.user_id == actor.id)).all()
    patient_initiated = any(self_access(db, actor.id, row.patient_id) and (payload.patient_id is None or row.patient_id == payload.patient_id) for row in own)
    if patient_initiated:
        patient = resolve_patient(db, actor)
        if payload.patient_id is not None and payload.patient_id != patient.id:
            raise HTTPException(403, "No patient authority for this invitation.")
        qualification = require_doctor(db, target.id)
        doctor_id, patient_actor_id = target.id, actor.id
    else:
        qualification = require_doctor(db, actor.id)
        rows = db.scalars(select(PatientAccess).where(PatientAccess.user_id == target.id)).all()
        row = next((row for row in rows if self_access(db, target.id, row.patient_id) and (payload.patient_id is None or row.patient_id == payload.patient_id)), None)
        if row is None:
            raise HTTPException(403, "The invited account has no active patient authority.")
        patient = db.get(Patient, row.patient_id)
        doctor_id, patient_actor_id = actor.id, target.id
    from backend.app.services.example_scope_service import require_example_boundary
    require_example_boundary(db, doctor_id, patient)
    require_example_boundary(db, patient_actor_id, patient)
    expires = payload.expires_at or datetime.now(timezone.utc) + timedelta(days=90)
    if not not_expired(expires):
        raise HTTPException(400, "Invitation expiry must be in the future.")
    existing = db.scalars(select(CareRelationship).where(CareRelationship.patient_id == patient.id, CareRelationship.doctor_user_id == doctor_id, CareRelationship.status.in_(["pending", "active"]))).all()
    if any(not_expired(row.expires_at) and (ledger.matches(row) or ledger.matches(row, active=False)) for row in existing):
        raise HTTPException(409, "An unexpired invitation or relationship already exists.")
    relationship = CareRelationship(patient_id=patient.id, doctor_user_id=doctor_id, patient_actor_user_id=patient_actor_id, initiator_user_id=actor.id, institution_id=qualification.institution_id, scope=sorted(set(payload.scope)), purpose="clinical_sharing", expires_at=expires, status="pending", patient_confirmed=patient_initiated, doctor_confirmed=not patient_initiated)
    db.add(relationship)
    db.flush()
    ledger.reserve(relationship)
    if patient_initiated:
        consent = prepare_grant(db, patient_id=patient.id, actor_id=actor.id, purpose="clinical_sharing", scope=relationship.scope, target_user_id=doctor_id, expires_at=expires)
        relationship.consent_id = consent.id
    else:
        consent = None
    event_for(db, relationship, actor.id, "patient" if patient_initiated else f"doctor:{qualification.id}", "care_relationship.invited")
    db.commit()
    if consent:
        publish_authority(db,consent)
    return relationship_response(db, relationship, actor.id)


def get_party_relationship(db, actor, relationship_id):
    row = db.get(CareRelationship, relationship_id)
    if row is None:
        raise HTTPException(404, "Care relationship not found.")
    if actor.id not in {row.doctor_user_id, row.patient_actor_user_id}:
        raise HTTPException(403, "Only relationship parties can act.")
    if actor.id != row.doctor_user_id:
        identity_basis(db, actor.id, row.patient_id)
    return row


def accept_relationship(db, actor, relationship_id, expected):
    row = get_party_relationship(db, actor, relationship_id)
    from backend.app.services.example_scope_service import require_example_boundary
    require_example_boundary(db, row.doctor_user_id, db.get(Patient, row.patient_id))
    check_revision(row, expected)
    if row.status != "pending" or not not_expired(row.expires_at):
        raise HTTPException(409, "Only an unexpired pending invitation can be accepted.")
    if actor.id == row.initiator_user_id:
        raise HTTPException(403, "The counterparty must confirm this invitation.")
    qualification = require_doctor(db, row.doctor_user_id)
    if qualification.institution_id != row.institution_id:
        raise HTTPException(403, "The doctor's institution authority changed.")
    consent = None
    if actor.id == row.doctor_user_id:
        from backend.app.models.identity import ConsentRecord
        consent = db.get(ConsentRecord, row.consent_id) if row.consent_id else None
        if not row.patient_confirmed or not consent or not effective_consent(db, consent):
            raise HTTPException(403, "A current patient confirmation and consent must precede doctor acceptance.")
    ledger.deny(row)
    if actor.id == row.doctor_user_id:
        row.doctor_confirmed = True
    else:
        row.patient_confirmed = True
        consent = prepare_grant(db, patient_id=row.patient_id, actor_id=actor.id, purpose="clinical_sharing", scope=row.scope, target_user_id=row.doctor_user_id, expires_at=row.expires_at)
        row.consent_id = consent.id
    row.status = "active" if row.patient_confirmed and row.doctor_confirmed else "pending"
    event_for(db, row, actor.id, "patient" if actor.id != row.doctor_user_id else f"doctor:{qualification.id}", "care_relationship.accepted")
    db.commit()
    if consent and not ledger.matches(consent):
        publish_authority(db,consent)
    if row.status == "active":
        publish_authority(db,row)
    return relationship_response(db, row, actor.id)


def revoke_relationship(db, actor, relationship_id, expected):
    row = get_party_relationship(db, actor, relationship_id)
    check_revision(row, expected)
    if row.status not in {"active", "pending"}:
        raise HTTPException(409, "Relationship already ended.")
    ledger.deny(row)
    row.status = "revoked"
    if row.consent_id:
        from backend.app.models.identity import ConsentRecord
        consent = db.get(ConsentRecord, row.consent_id)
        if consent and consent.status == "active":
            from backend.app.services.consent_service import prepare_withdraw
            prepare_withdraw(db,consent,actor.id,"relationship_party")
    event_for(db, row, actor.id, "relationship_party", "care_relationship.revoked")
    db.commit()
    return relationship_response(db, row, actor.id)
