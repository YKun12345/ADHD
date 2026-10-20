"""Single canonical persistent consent authority model."""
from sqlalchemy import ForeignKey, JSON, String, Integer, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column
from backend.app.db.base import Base
from backend.app.models.identity import AuthorityMixin


class ConsentAuthority(AuthorityMixin, Base):
    """Current record pointer and concurrent revision only; contains no consent material."""
    __tablename__ = "consent_authorities"
    __table_args__ = (UniqueConstraint("patient_id", "purpose", "authority_key", name="uq_consent_patient_purpose_authority"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    purpose: Mapped[str] = mapped_column(String(32), index=True)
    authority_key: Mapped[str] = mapped_column(String(64))
    current_record_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ConsentRecord(AuthorityMixin, Base):
    """Each grant is a new record. Original actor, scope and terms never change."""
    __tablename__ = "consent_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    authority_id: Mapped[int] = mapped_column(ForeignKey("consent_authorities.id"),index=True)
    ledger_key: Mapped[str] = mapped_column(String(64),index=True,nullable=False)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    purpose: Mapped[str] = mapped_column(String(32), index=True)
    authority_key: Mapped[str] = mapped_column(String(64))
    scope: Mapped[list] = mapped_column(JSON)
    target_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("research_projects.id"), nullable=True)
    grantor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    actor_identity_basis: Mapped[str] = mapped_column(String(128))
    terms_version: Mapped[str] = mapped_column(String(32))


@event.listens_for(ConsentRecord,"before_update")
def preserve_grant_material(mapper, connection, target):
    material = ("patient_id","purpose","authority_key","authority_id","ledger_key","scope","target_user_id","project_id","grantor_user_id","actor_identity_basis","terms_version","expires_at","created_at")
    state = inspect(target)
    if any(state.attrs[name].history.has_changes() for name in material):
        raise RuntimeError("Consent grant material is immutable; append a new grant record.")


