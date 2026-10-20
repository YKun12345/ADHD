"""Persist synthetic example membership without granting real-patient scope.

Uses the existing independently versioned institution ledger; no schema change
or clinical credential import is needed. Only the explicit local provisioning
tool creates these rows. There is no public API to mark an account as example.
"""
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import select

from backend.app.models.identity import InstitutionMembership, DoctorQualification
from backend.app.models.user import User
from backend.app.services import authorization_ledger as ledger

INSTITUTION = 'example-only:competition-v1'
ROLE = 'example_account'


def mark_example_account(db, user_id, *, doctor=False):
    """Explicit local operation, called only for newly created synthetic users."""
    user = db.get(User, user_id)
    if user is None or not user.email.endswith('@competition.example.com'):
        raise ValueError('Only the explicitly reserved synthetic accounts can be marked.')
    existing = db.scalar(select(InstitutionMembership).where(
        InstitutionMembership.user_id == user_id, InstitutionMembership.institution_id == INSTITUTION,
        InstitutionMembership.role == ROLE))
    if existing:
        _membership(db, user_id)  # Never silently repair a withdrawn/tampered marker.
        return
    expiry = datetime.now(timezone.utc) + timedelta(days=3650)
    rows = [InstitutionMembership(user_id=user_id, institution_id=INSTITUTION, role=ROLE,
        status='verified', verification_reference='synthetic-example-only:not-a-clinical-qualification', expires_at=expiry)]
    if doctor:
        if user.role.value != 'researcher':
            raise ValueError('The example doctor must use the normal doctor role.')
        rows.extend([
            InstitutionMembership(user_id=user_id, institution_id=INSTITUTION, role='clinician', status='verified',
                verification_reference='synthetic-example-only:not-a-clinical-qualification', expires_at=expiry),
            DoctorQualification(user_id=user_id, institution_id=INSTITUTION, status='verified',
                verification_reference='synthetic-example-only:not-a-clinical-qualification', expires_at=expiry),
        ])
    db.add_all(rows)
    db.flush()
    for row in rows:
        ledger.reserve(row)
    db.commit()
    for row in rows:
        ledger.publish(row)


def _membership(db, user_id):
    rows = db.scalars(select(InstitutionMembership).where(
        InstitutionMembership.user_id == user_id, InstitutionMembership.role == ROLE,
        InstitutionMembership.institution_id == INSTITUTION).execution_options(populate_existing=True)).all()
    if not rows:
        # Fail closed if the doctor's separate example marker has disappeared.
        example_qualification = db.scalar(select(DoctorQualification.id).where(
            DoctorQualification.user_id == user_id, DoctorQualification.institution_id == INSTITUTION))
        if example_qualification:
            raise HTTPException(403, 'Example account scope is unavailable.')
        return None
    from backend.app.services.identity_access import not_expired
    if len(rows) != 1 or rows[0].status != 'verified' or not not_expired(rows[0].expires_at) or not ledger.matches(rows[0]):
        raise HTTPException(403, 'Example account scope was withdrawn or changed.')
    return rows[0]


def require_example_boundary(db, actor_id, patient):
    actor = _membership(db, actor_id)
    subject = _membership(db, patient.user_id)
    if (actor is None) != (subject is None):
        raise HTTPException(403, 'Example accounts can collaborate only with example records.')
    if actor is not None:
        from backend.app.services.identity_access import record_authority
        record_authority(db, actor)
        record_authority(db, subject)
