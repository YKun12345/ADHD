from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy import select
from backend.app.models.identity import (PatientAccess, GuardianRelationship, DoctorQualification, InstitutionMembership, CareRelationship, ResearchProject, ResearchProjectMember)
from backend.app.models.patient import Patient
from backend.app.models.user import User
from backend.app.services import authorization_ledger as ledger

SCOPES = {"profile", "assessment", "tracking", "care", "imaging"}
TERMS_VERSION = "W02-1"
GUARDIAN_DECLARATION_VERSION = "guardian-self-declaration-2026-10-19"


def guardian_is_current(row):
    return bool(row and row.status in {"confirmed", "verified"} and row.confirmed
        and row.guardian_age is not None and row.guardian_age >= 18
        and row.relation in {"parent", "legal_guardian"}
        and (row.status != "verified" or row.institution_id)
        and not_expired(row.expires_at) and ledger.matches(row))


def record_authenticated_actor(db,user):
    db.info["authenticated_actor_id"] = user.id
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.authenticated_actor_id = user.id


def recheck_authenticated_actor(db,user_id):
    actor = db.get(User,user_id,populate_existing=True)
    if actor is None or not actor.is_active:
        raise HTTPException(403,"The authenticated account is no longer active.")


def record_authority(db,row):
    actor_id = getattr(row,"user_id",None) or getattr(row,"grantor_user_id",None)
    receipt = (row.__tablename__,row.id,row.ledger_key,row.revision,row.status,row.expires_at,actor_id)
    receipts = db.info.setdefault("credential_receipts",[])
    if receipt not in receipts:
        receipts.append(receipt)
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.credential_receipts = receipts


def recheck_authorities(db,receipts):
    from backend.app.models.consent import ConsentRecord
    from backend.app.models.federated import FederatedNode
    models = {model.__tablename__:model for model in (DoctorQualification,InstitutionMembership,ResearchProject,ResearchProjectMember,ConsentRecord,FederatedNode)}
    for table,identifier,key,revision,status,expiry,actor_id in receipts:
        row = db.get(models[table],identifier,populate_existing=True)
        actor = db.get(User,actor_id,populate_existing=True) if actor_id else None
        if not row or row.ledger_key != key or row.revision != revision or row.status != status or not not_expired(row.expires_at) or not not_expired(expiry) or not ledger.matches(row) or (actor_id and (not actor or not actor.is_active)):
            raise HTTPException(403,"Institutional or purpose authority changed before publication.")


def recheck_request_authority(db):
    """Check the original request snapshot in a fresh session before external writes."""
    from backend.app.db.session import SessionLocal
    receipts = db.info.get("authorization_receipts",[])
    credentials = db.info.get("credential_receipts",[])
    with ledger.read_heads(),SessionLocal() as authority_db:
        actor_id = db.info.get("authenticated_actor_id")
        if actor_id is not None:
            recheck_authenticated_actor(authority_db,actor_id)
        recheck_receipts(authority_db,receipts)
        recheck_authorities(authority_db,credentials)


def publish_authority(db,row):
    receipts = db.info.get("authorization_receipts",[])
    credentials = db.info.get("credential_receipts",[])
    recheck_request_authority(db)
    heads = {(key,revision) for receipt in receipts for _,key,revision,_ in receipt[4]}
    heads.update((key,revision) for _,_,key,revision,_,_,_ in credentials)
    ledger.publish(row,required_heads=heads)


def not_expired(value):
    if value is None:
        return True
    utc = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return utc > datetime.now(timezone.utc)


def active_memberships(db, user_id, role):
    rows = db.scalars(select(InstitutionMembership).where(InstitutionMembership.user_id == user_id, InstitutionMembership.role == role, InstitutionMembership.status == "verified").execution_options(populate_existing=True)).all()
    return [row for row in rows if row.verification_reference and not_expired(row.expires_at) and ledger.matches(row)]


def doctor_qualification(db, user_id):
    user = db.get(User, user_id)
    if not user or not user.is_active:
        return None
    memberships = active_memberships(db, user_id, "clinician")
    rows = db.scalars(select(DoctorQualification).where(DoctorQualification.user_id == user_id, DoctorQualification.status == "verified").execution_options(populate_existing=True)).all()
    return next((row for row in rows if row.verification_reference and row.expires_at is not None and not_expired(row.expires_at) and ledger.matches(row) and any(member.institution_id == row.institution_id for member in memberships)), None)


@ledger.read_heads()
def require_doctor(db, user_id):
    qualification = doctor_qualification(db, user_id)
    if qualification is None:
        raise HTTPException(403, "Verified doctor qualification and institution membership are required.")
    record_authority(db,qualification)
    for membership in active_memberships(db,user_id,"clinician"):
        if membership.institution_id == qualification.institution_id:
            record_authority(db,membership)
    return qualification


def require_reviewer(db, user_id, institution_id=None):
    rows = active_memberships(db, user_id, "reviewer")
    result = next((row for row in rows if institution_id is None or row.institution_id == institution_id), None)
    if result is None:
        raise HTTPException(403, "An independently verified institutional reviewer is required.")
    record_authority(db,result)
    return result


def self_access(db, user_id, patient_id):
    row = db.scalar(select(PatientAccess).where(PatientAccess.user_id == user_id, PatientAccess.patient_id == patient_id).execution_options(populate_existing=True))
    user = db.get(User, user_id)
    if not user or not user.is_active or not row or row.status != "active" or not not_expired(row.expires_at) or not ledger.matches(row):
        return None
    if row.access_kind == "guardian":
        guardian = db.get(GuardianRelationship, row.guardian_relationship_id, populate_existing=True)
        if not guardian_is_current(guardian) or guardian.guardian_user_id != user_id:
            return None
    elif row.access_kind != "self":
        return None
    return row


def identity_basis(db, user_id, patient_id):
    if db.get(Patient,patient_id) is None:
        raise HTTPException(404,"Patient not found.")
    row = self_access(db, user_id, patient_id)
    if not row:
        raise HTTPException(403, "No active patient identity authority.")
    if db.info.get("authorization_request") is not None:
        sources = [row]
        if row.guardian_relationship_id:
            sources.append(db.get(GuardianRelationship,row.guardian_relationship_id))
        _record(db,user_id,patient_id,{"profile"},sources,purpose="identity_control")
    return f"{row.access_kind}:{user_id}:access:{row.id}:revision:{row.revision}"


def _record(db, user_id, patient_id, scope, authorities, purpose=None):
    purpose = purpose or ("processing" if db.info.get("requires_basic_use") else "clinical")
    if purpose == "processing":
        from backend.app.services.consent_service import current_consent
        authorities = list(authorities) + [current_consent(db,patient_id,"basic_use")]
    versions = tuple(sorted((row.__tablename__,row.ledger_key,row.revision,row.id) for row in authorities if row is not None))
    receipt = (user_id, patient_id, tuple(sorted(scope)), purpose, versions)
    receipts = db.info.setdefault("authorization_receipts", [])
    if receipt not in receipts:
        receipts.append(receipt)
    request = db.info.get("authorization_request")
    if request is not None:
        request.state.authorization_receipts = receipts


@ledger.read_heads()
def require_patient_access(db, user, patient_id, scope="profile", *, record=True, relationship_id=None):
    patient = db.get(Patient, patient_id)
    if patient is None:
        raise HTTPException(404, "Patient not found.")
    from backend.app.services.example_scope_service import require_example_boundary
    require_example_boundary(db, user.id, patient)
    required = {scope} if isinstance(scope, str) else set(scope)
    if not required or not required <= SCOPES:
        raise HTTPException(403, "Unknown patient access scope.")
    if db.info.get("requires_basic_use"):
        from backend.app.services.consent_service import has_consent
        if not has_consent(db,patient_id,"basic_use",scope=required):
            raise HTTPException(403,"A current explicit basic-use consent is required for new processing. Own historical records remain readable.")
    access = self_access(db, user.id, patient_id)
    if access and relationship_id is None:
        if record:
            sources = [access]
            if access.guardian_relationship_id:
                sources.append(db.get(GuardianRelationship,access.guardian_relationship_id))
            _record(db, user.id, patient_id, required, sources)
        return patient
    qualification = doctor_qualification(db, user.id)
    if qualification:
        relationships = db.scalars(select(CareRelationship).where(CareRelationship.patient_id == patient_id, CareRelationship.doctor_user_id == user.id, CareRelationship.status == "active").execution_options(populate_existing=True)).all()
        from backend.app.services.consent_service import has_consent
        for relationship in relationships:
            if relationship_id is not None and relationship.id != relationship_id:
                continue
            if relationship.purpose != "clinical_sharing" or relationship.institution_id != qualification.institution_id or not relationship.patient_confirmed or not relationship.doctor_confirmed or not required <= set(relationship.scope) or not not_expired(relationship.expires_at) or not ledger.matches(relationship):
                continue
            if has_consent(db, patient_id, "clinical_sharing", target_user_id=user.id, scope=required, consent_id=relationship.consent_id):
                if record:
                    from backend.app.services.consent_service import current_consent
                    consent = current_consent(db,patient_id,"clinical_sharing",target_user_id=user.id)
                    grantor_access = self_access(db,consent.grantor_user_id,patient_id)
                    sources = [qualification,relationship,consent,grantor_access]
                    sources.extend(member for member in active_memberships(db,user.id,"clinician") if member.institution_id == qualification.institution_id)
                    if grantor_access and grantor_access.guardian_relationship_id:
                        sources.append(db.get(GuardianRelationship,grantor_access.guardian_relationship_id))
                    _record(db, user.id, patient_id, required, sources)
                return patient
    raise HTTPException(403, "No current patient authority for the requested scope.")


@ledger.read_heads()
def resolve_patient(db, user, scope="profile"):
    rows = db.scalars(select(PatientAccess).where(PatientAccess.user_id == user.id).order_by(PatientAccess.id)).all()
    for row in rows:
        if self_access(db, user.id, row.patient_id):
            return require_patient_access(db, user, row.patient_id, scope)
    raise HTTPException(403, "No active self or verified guardian patient access.")


@ledger.read_heads()
def authorized_patient_ids(db, user_id, scope=SCOPES):
    require_doctor(db, user_id)
    user = db.get(User, user_id)
    candidates = db.scalars(select(CareRelationship.patient_id).where(CareRelationship.doctor_user_id == user_id, CareRelationship.status == "active")).all()
    allowed = []
    for pid in set(candidates):
        try:
            require_patient_access(db, user, pid, scope)
            allowed.append(pid)
        except HTTPException as exc:
            if exc.status_code not in {403, 404}:
                raise
    return allowed


def require_research_access(db, user_id, patient_id, project_id, scope):
    from backend.app.services.federated_control_service import assert_project_gate
    assert_project_gate(db,project_id,user_id)
    user = db.get(User, user_id)
    project = db.get(ResearchProject, project_id)
    membership = db.scalar(select(ResearchProjectMember).where(ResearchProjectMember.project_id == project_id, ResearchProjectMember.user_id == user_id))
    from backend.app.services.consent_service import has_consent
    if not user or not user.is_active or not project or project.status != "active" or not not_expired(project.expires_at) or not ledger.matches(project) or not membership or membership.status != "active" or not not_expired(membership.expires_at) or not ledger.matches(membership) or not has_consent(db, patient_id, "research", project_id=project_id, scope={scope}):
        raise HTTPException(403, "Concrete project membership and scoped research consent are required.")
    record_authority(db,project)
    record_authority(db,membership)
    return True


@ledger.read_heads()
def recheck_receipts(db, receipts):
    originals = list(receipts)
    grouped = {}
    for user_id, patient_id, scope, purpose, versions in originals:
        required = set(scope)
        if not required or not required <= SCOPES:
            raise HTTPException(403, "Unknown patient access scope.")
        key = (user_id, patient_id, purpose, tuple(tuple(version) for version in versions))
        grouped.setdefault(key, set()).update(required)
    # The same exact original grant can authorize several recorded scopes.
    # Verify their union once, without combining different heads or purposes.
    # Every group still reads current database rows and independent ledger heads.
    for (user_id, patient_id, purpose, versions), scope in grouped.items():
        user = db.get(User, user_id, populate_existing=True)
        if user is None or not user.is_active:
            raise HTTPException(403, "Identity authority is no longer active.")
        db.info["requires_basic_use"] = purpose == "processing"
        db.info["authorization_receipts"] = []
        relationship_id = next((identifier for table,_,_,identifier in versions if table == "care_relationships"),None)
        require_patient_access(db,user,patient_id,scope,relationship_id=relationship_id)
        current = db.info["authorization_receipts"][-1]
        if current[4] != versions:
            raise HTTPException(409,"Authorization revision changed; the earlier request cannot borrow a new grant.")
    if originals:
        # Preserve the original receipt representation and existing caller contract.
        db.info["authorization_receipts"] = [originals[-1]]
        db.info["requires_basic_use"] = originals[-1][3] == "processing"
        request = db.info.get("authorization_request")
        if request is not None:
            request.state.authorization_receipts = db.info["authorization_receipts"]


def require_processing_access(db,user,patient_id,scope="profile"):
    db.info["requires_basic_use"] = True
    return require_patient_access(db,user,patient_id,scope)


@ledger.read_heads()
def readable_user(db, user):
    from backend.app.schemas.auth import UserRead, PatientProfileRead
    result = UserRead.model_validate(user)
    result.patient_profile = None
    rows = db.scalars(select(PatientAccess).where(PatientAccess.user_id == user.id)).all()
    for row in rows:
        if self_access(db, user.id, row.patient_id):
            result.patient_profile = PatientProfileRead.model_validate(db.get(Patient, row.patient_id))
            require_patient_access(db,user,row.patient_id,"profile")
            break
    return result
