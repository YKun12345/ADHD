from backend.app.services.identity_access import publish_authority
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.app.api.deps import get_db, get_current_user
from backend.app.models.identity import ConsentRecord, CareRelationship, PatientAccess
from backend.app.models.user import User
from backend.app.schemas.identity import ConsentCreate, RelationshipInvitation, RevisionRequest
from backend.app.services.identity_access import identity_basis, resolve_patient, self_access, require_patient_access
from backend.app.services.consent_service import prepare_grant, prepare_withdraw, consent_response, event_for
from backend.app.services.care_relationship_service import create_invitation, accept_relationship, revoke_relationship, relationship_response, check_revision
from backend.app.services import authorization_ledger as ledger

router = APIRouter(tags=["authorizations"])


@router.get("/patient/consents")
def list_consents(patient_id: int | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    pid = patient_id if patient_id is not None else resolve_patient(db,user).id
    identity_basis(db,user.id,pid)
    require_patient_access(db,user,pid,"profile")
    rows = db.scalars(select(ConsentRecord).where(ConsentRecord.patient_id == pid).order_by(ConsentRecord.id)).all()
    return {"items":[consent_response(db,row) for row in rows]}


@router.post("/patient/consents", status_code=201)
def grant_consent(payload: ConsentCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_patient_access(db,user,payload.patient_id,"profile")
    row = prepare_grant(db,patient_id=payload.patient_id,actor_id=user.id,purpose=payload.purpose,scope=payload.scope,target_user_id=payload.target_user_id,project_id=payload.project_id,expires_at=payload.expires_at,expected_project_revision=payload.expected_project_revision)
    db.commit()
    publish_authority(db,row)
    return consent_response(db,row)


@router.post("/patient/consents/{consent_id}/withdraw")
def withdraw(consent_id: int, payload: RevisionRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    row = db.get(ConsentRecord,consent_id)
    if row is None:
        raise HTTPException(404,"Consent not found.")
    basis = identity_basis(db,user.id,row.patient_id)
    check_revision(row,payload.expected_revision)
    if row.status != "active":
        raise HTTPException(409,"Consent already withdrawn.")
    prepare_withdraw(db,row,user.id,basis)
    db.commit()
    return consent_response(db,row)


@router.get("/care/relationships")
def relationships(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.scalars(select(CareRelationship).where((CareRelationship.doctor_user_id == user.id) | (CareRelationship.patient_actor_user_id == user.id)).order_by(CareRelationship.id)).all()
    return {"items":[relationship_response(db,row,user.id) for row in rows]}


@router.post("/care/relationships/invitations", status_code=201)
def invitations(payload: RelationshipInvitation, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return create_invitation(db,user,payload)


@router.post("/care/relationships/{relationship_id}/accept")
def accept(relationship_id: int, payload: RevisionRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return accept_relationship(db,user,relationship_id,payload.expected_revision)


@router.post("/care/relationships/{relationship_id}/revoke")
def revoke(relationship_id: int, payload: RevisionRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return revoke_relationship(db,user,relationship_id,payload.expected_revision)
