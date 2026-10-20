"""Clinical authority is independent of an account's technical role."""
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.data_encryption import EncryptedValue
from backend.app.db.base import Base


class AuthorityMixin:
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    ledger_key: Mapped[str] = mapped_column(String(64), default=lambda: uuid4().hex, unique=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)


class PatientAccess(AuthorityMixin, Base):
    __tablename__ = "patient_access"
    __table_args__ = (UniqueConstraint("patient_id", "user_id", name="uq_patient_access_actor"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    access_kind: Mapped[str] = mapped_column(String(16))
    guardian_relationship_id: Mapped[int | None] = mapped_column(ForeignKey("guardian_relationships.id"), nullable=True)


class GuardianRelationship(AuthorityMixin, Base):
    __tablename__ = "guardian_relationships"
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    guardian_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    guardian_age: Mapped[int] = mapped_column(Integer)
    relation: Mapped[str] = mapped_column(String(32))
    proof_reference: Mapped[str] = mapped_column(EncryptedValue("guardian_relationships.proof_reference", "text"))
    institution_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)


class GuardianHistory(Base):
    __tablename__ = "guardian_history"
    id: Mapped[int] = mapped_column(primary_key=True)
    relationship_id: Mapped[int] = mapped_column(ForeignKey("guardian_relationships.id"), index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    actor_identity_basis: Mapped[str] = mapped_column(String(128))
    action: Mapped[str] = mapped_column(String(32))
    revision: Mapped[int] = mapped_column(Integer)
    details: Mapped[dict] = mapped_column(EncryptedValue("guardian_history.details", "json"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


@event.listens_for(GuardianHistory, "before_update")
@event.listens_for(GuardianHistory, "before_delete")
def preserve_guardian_history(*_):
    raise RuntimeError("Guardian identity history is append-only")


class IdentityConfirmation(Base):
    __tablename__ = "identity_confirmations"
    __table_args__ = (UniqueConstraint("relationship_id", "revision", "user_id", "purpose", name="uq_identity_confirmation"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    relationship_id: Mapped[int] = mapped_column(ForeignKey("guardian_relationships.id"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    purpose: Mapped[str] = mapped_column(String(32))
    proof_reference: Mapped[str] = mapped_column(EncryptedValue("identity_confirmations.proof_reference", "text"))
    terms_version: Mapped[str] = mapped_column(String(32))
    age: Mapped[int] = mapped_column(Integer)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class DoctorQualification(AuthorityMixin, Base):
    __tablename__ = "doctor_qualifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    institution_id: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(32))
    verification_reference: Mapped[str] = mapped_column(String(255))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class InstitutionMembership(AuthorityMixin, Base):
    __tablename__ = "institution_memberships"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    institution_id: Mapped[str] = mapped_column(String(64), index=True)
    role: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32))
    verification_reference: Mapped[str] = mapped_column(String(255))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ResearchProject(AuthorityMixin, Base):
    __tablename__ = "research_projects"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ResearchProjectMember(AuthorityMixin, Base):
    __tablename__ = "research_project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_research_project_member"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("research_projects.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[str] = mapped_column(String(32))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CareRelationship(AuthorityMixin, Base):
    __tablename__ = "care_relationships"
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    doctor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    patient_actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    initiator_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    institution_id: Mapped[str] = mapped_column(String(64))
    scope: Mapped[list] = mapped_column(JSON)
    purpose: Mapped[str] = mapped_column(String(32), default="clinical_sharing")
    patient_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    doctor_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    consent_id: Mapped[int | None] = mapped_column(ForeignKey("consent_records.id"), nullable=True)


# Compatibility export; the model is defined only in models/consent.py.
from backend.app.models.consent import ConsentRecord, ConsentAuthority
