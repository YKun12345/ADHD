from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.api.deps import get_db, get_current_user
from backend.app.models.identity import GuardianRelationship, PatientAccess, IdentityConfirmation, DoctorQualification
from backend.app.models.patient import Patient
from backend.app.models.user import User
from backend.app.core.config import settings
from backend.app.schemas.identity import GuardianChange, IdentityConfirm, GuardianSelfConfirmation
from backend.app.services.identity_access import self_access, doctor_qualification, active_memberships, require_reviewer, require_doctor, require_patient_access, record_authority, TERMS_VERSION
from backend.app.services.guardian_service import guardian_response, change_guardian, confirm_identity

router = APIRouter(prefix="/identity", tags=["identity"])


@router.get("/context")
def context(response: Response, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    identities = []
    accessible = []
    for access in db.scalars(select(PatientAccess).where(PatientAccess.user_id == user.id)).all():
        if self_access(db, user.id, access.patient_id):
            require_patient_access(db,user,access.patient_id,"profile")
            patient = db.get(Patient, access.patient_id)
            guardian = db.get(GuardianRelationship, access.guardian_relationship_id) if access.guardian_relationship_id else None
            accessible.append({"patient_id":patient.id,"display_name":patient.display_name or patient.user.full_name,"patient_type":patient.patient_type.value,"access_kind":access.access_kind,"guardian_status":guardian.status if guardian else None})
            if access.access_kind not in identities:
                identities.append(access.access_kind)
    qualification = doctor_qualification(db, user.id)
    if qualification:
        qualification = require_doctor(db,user.id)
        identities.append("doctor")
    reviewers = active_memberships(db, user.id, "reviewer")
    if reviewers:
        for membership in reviewers:
            record_authority(db,membership)
        identities.append("institution_reviewer")
    if user.role.value == "researcher":
        identities.append("researcher")
    guardian_rows = db.scalars(select(GuardianRelationship).where(GuardianRelationship.guardian_user_id == user.id)).all()
    if guardian_rows and "guardian" not in identities:
        identities.append("guardian_pending" if any(row.status == "pending" for row in guardian_rows) else "guardian_inactive")
    confirmations = db.scalars(select(IdentityConfirmation).where(IdentityConfirmation.user_id == user.id)).all()
    return {"user_id":user.id,"identities":identities,"doctor_qualification":{"status":"verified" if qualification else "unverified","institution_id":qualification.institution_id if qualification else None},"accessible_patients":accessible,"guardian_relationships":[guardian_response(db,row) for row in guardian_rows],"pending_identity_confirmations":[{"id":item.id,"relationship_id":item.relationship_id,"revision":item.revision,"purpose":item.purpose,"confirmed":True,"consumed":item.consumed_at is not None} for item in confirmations],"demonstration_only":settings.APP_ENV == "test","terms_version":TERMS_VERSION}


@router.get("/guardians/review_queue")
def review_queue(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_reviewer(db, user.id)
    institutions = {row.institution_id for row in active_memberships(db,user.id,"reviewer")}
    rows = db.scalars(select(GuardianRelationship).order_by(GuardianRelationship.id)).all()
    items = []
    for row in rows:
        if row.institution_id is None or row.institution_id not in institutions:
            continue
        patient = db.get(Patient,row.patient_id)
        guardian = db.get(User,row.guardian_user_id)
        confirmations = db.scalars(select(IdentityConfirmation).where(IdentityConfirmation.relationship_id == row.id, IdentityConfirmation.revision == row.revision, IdentityConfirmation.consumed_at.is_(None))).all()
        items.append(guardian_response(db,row) | {"patient_name":patient.display_name or patient.user.full_name,"guardian_name":guardian.full_name,"actual_actor_confirmations":[{"user_id":item.user_id,"purpose":item.purpose,"revision":item.revision,"confirmation_ready":True} for item in confirmations]})
    return {"items":items}


@router.post("/guardians/{relationship_id}/confirm-transfer")
def confirm_transfer(relationship_id: int, payload: IdentityConfirm, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return confirm_identity(db,user,relationship_id,payload,"transfer")


@router.post("/guardians/{relationship_id}/confirm-relationship")
def confirm_own_guardian_relationship(relationship_id: int, payload: GuardianSelfConfirmation,
    db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from backend.app.services.guardian_service import confirm_own_relationship
    return confirm_own_relationship(db, user, relationship_id, payload)


@router.post("/guardians/{relationship_id}/confirm-adult-conversion")
def confirm_adult(relationship_id: int, payload: IdentityConfirm, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return confirm_identity(db,user,relationship_id,payload,"adult_conversion")


@router.post("/guardians/{relationship_id}/{action}")
def transition(relationship_id: int, action: str, payload: GuardianChange, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from fastapi import HTTPException
    mapping = {"review":"review","suspend":"suspend","restore":"restore","transfer":"transfer","adult-conversion":"adult_conversion"}
    if action not in mapping:
        raise HTTPException(404,"Unknown guardian lifecycle action.")
    return change_guardian(db,user,relationship_id,payload,mapping[action])


