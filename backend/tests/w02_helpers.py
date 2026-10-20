from datetime import datetime, timedelta, timezone


def register(client, email, role="patient", child=False):
    payload = {"email": email, "password": "Synthetic123!", "full_name": "Synthetic Person", "role": role, "consent_agreed": role == "patient"}
    if role == "patient":
        payload["patient_profile"] = {"age": 10 if child else 25, "gender": "other", "patient_type": "child" if child else "adult", "display_name": "Synthetic Child" if child else "Synthetic Adult"}
    if child:
        payload["guardian"] = {"age": 35, "relation": "parent", "proof_reference": "synthetic-proof-ref", "confirmed": True}
    response = client.post("/api/v1/auth/register", json=payload)
    assert response.status_code == 201, response.text
    data = response.json()
    return data, {"Authorization": "Bearer " + data["access_token"]}


def qualify(user_id, reviewer=False, assign_guardians=True):
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification, InstitutionMembership
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        rows = [InstitutionMembership(user_id=user_id, institution_id="synthetic-institution", role="reviewer" if reviewer else "clinician", status="verified", verification_reference="synthetic-reviewed")]
        if not reviewer:
            rows.append(DoctorQualification(user_id=user_id, institution_id="synthetic-institution", status="verified", verification_reference="synthetic-reviewed", expires_at=datetime.now(timezone.utc) + timedelta(days=90)))
        db.add_all(rows)
        db.flush()
        for row in rows:
            ledger.reserve(row)
        if reviewer and assign_guardians:
            from backend.app.models.identity import GuardianRelationship
            from sqlalchemy import select
            for guardian in db.scalars(select(GuardianRelationship).where(GuardianRelationship.status.in_(["pending", "confirmed"]),GuardianRelationship.institution_id.is_(None))).all():
                guardian.institution_id = "synthetic-institution"
        db.commit()
        for row in rows:
            ledger.publish(row)


def invite(client, doctor, patient, patient_id):
    response = client.post("/api/v1/care/relationships/invitations", headers=doctor, json={"target_email": patient["user"]["email"], "patient_id": patient_id, "scope": ["profile", "assessment", "tracking", "care", "imaging"], "purpose": "clinical_sharing"})
    assert response.status_code == 201, response.text
    return response.json()


def grant_synthetic_patient_authority(patient_id, doctor_id=None):
    """Explicit synthetic institutional fixture, never a production upgrade shortcut."""
    from backend.app.core.config import settings
    assert settings.APP_ENV == "test"
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import PatientAccess, GuardianRelationship, CareRelationship, ConsentRecord
    from backend.app.models.patient import Patient, PatientType
    from backend.app.services import authorization_ledger as ledger
    from backend.app.services.consent_service import prepare_grant, event_for
    from backend.app.services.identity_service import doctor_qualification, identity_basis
    from sqlalchemy import select
    with SessionLocal() as db:
        patient = db.get(Patient,patient_id)
        patient.display_name = patient.display_name or patient.user.full_name
        access = db.scalar(select(PatientAccess).where(PatientAccess.patient_id == patient_id,PatientAccess.user_id == patient.user_id))
        authorities = []
        if access is None:
            guardian = None
            if patient.patient_type == PatientType.CHILD:
                guardian = GuardianRelationship(patient_id=patient.id,guardian_user_id=patient.user_id,guardian_age=35,relation="parent",proof_reference="synthetic-independent-proof",institution_id="synthetic-institution",confirmed=True,status="verified",expires_at=datetime.now(timezone.utc)+timedelta(days=90))
                db.add(guardian)
                db.flush()
                ledger.reserve(guardian)
                authorities.append(guardian)
            access = PatientAccess(patient_id=patient.id,user_id=patient.user_id,access_kind="guardian" if guardian else "self",guardian_relationship_id=guardian.id if guardian else None,status="active")
            db.add(access)
            db.flush()
            ledger.reserve(access)
            authorities.append(access)
        actor_id = patient.user_id
        db.commit()
        for authority in authorities:
            ledger.publish(authority)
        if db.scalar(select(ConsentRecord.id).where(ConsentRecord.patient_id == patient_id,ConsentRecord.purpose == "basic_use")) is None:
            basic = prepare_grant(db,patient_id=patient_id,actor_id=actor_id,purpose="basic_use",scope=["profile","assessment","tracking","care","imaging"])
            db.commit()
            ledger.publish(basic)
        needs_qualification = doctor_id and not doctor_qualification(db,doctor_id)
    if needs_qualification:
        qualify(doctor_id)
    if doctor_id:
        with SessionLocal() as db:
            qualification = doctor_qualification(db,doctor_id)
            scope = ["profile","assessment","tracking","care","imaging"]
            consent = prepare_grant(db,patient_id=patient_id,actor_id=actor_id,purpose="clinical_sharing",scope=scope,target_user_id=doctor_id,expires_at=datetime.now(timezone.utc)+timedelta(days=90))
            relationship = CareRelationship(patient_id=patient_id,doctor_user_id=doctor_id,patient_actor_user_id=actor_id,initiator_user_id=doctor_id,institution_id=qualification.institution_id,scope=scope,purpose="clinical_sharing",status="active",patient_confirmed=True,doctor_confirmed=True,consent_id=consent.id,expires_at=consent.expires_at)
            db.add(relationship)
            db.flush()
            ledger.reserve(relationship)
            event_for(db,relationship,actor_id,identity_basis(db,actor_id,patient_id),"care_relationship.synthetic_confirmed")
            db.commit()
            ledger.publish(consent)
            ledger.publish(relationship)
