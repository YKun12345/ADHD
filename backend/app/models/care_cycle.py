"""Real-date self cycles; daily revisions are insert-only encrypted originals."""
from datetime import date, datetime, timezone

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, ForeignKeyConstraint, Integer, JSON, String, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.db.base import Base
from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type


class CareCycle(RecordFieldsMixin, Base):
    __tablename__ = "care_cycles"
    record_object_type = "care_cycle"
    record_fields = {"snapshot":"care_cycles.snapshot"}
    __table_args__ = (
        UniqueConstraint("id","patient_id",name="uq_care_cycle_patient"),
        CheckConstraint("(cycle_type = 'self' AND responsible_doctor_id IS NULL AND plan_version_id IS NULL) OR (cycle_type = 'professional' AND responsible_doctor_id IS NOT NULL AND plan_version_id IS NOT NULL)",name="ck_cycle_actual_plan_or_self"),
        ForeignKeyConstraint(['plan_version_id', 'patient_id'], ['care_plan_versions.id', 'care_plan_versions.patient_id']),
        UniqueConstraint('plan_version_id', name='uq_cycle_plan_version'),
        CheckConstraint("end_date >= start_date",name="ck_cycle_dates"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    client_cycle_id: Mapped[str] = mapped_column(String(64),unique=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"),index=True)
    cycle_type: Mapped[str] = mapped_column(String(24),default="self")
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    calendar_timezone: Mapped[str] = mapped_column(String(48),default="Asia/Shanghai")
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    actor_identity_basis: Mapped[str] = mapped_column(String(256))
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    responsible_doctor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"),nullable=True)
    # Professional cycles require an actual immutable doctor-published version.
    plan_version_id: Mapped[int | None] = mapped_column(Integer,nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))
    _snapshot_cipher: Mapped[str] = mapped_column("snapshot",record_storage_type())
    snapshot = record_field("snapshot")


class DailyRecord(RecordFieldsMixin, Base):
    __tablename__ = "daily_records"
    record_object_type = "daily_record"
    record_fields = {"content":"daily_records.content","snapshot":"daily_records.snapshot"}
    __table_args__ = (
        ForeignKeyConstraint(["cycle_id","patient_id"],["care_cycles.id","care_cycles.patient_id"]),
        UniqueConstraint("patient_id","cycle_id","record_date","revision",name="uq_daily_date_revision"),
        CheckConstraint("revision > 0",name="ck_daily_revision_positive"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    client_submission_id: Mapped[str] = mapped_column(String(64),unique=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"),index=True)
    cycle_id: Mapped[int] = mapped_column(Integer,index=True)
    record_date: Mapped[date] = mapped_column(Date,index=True)
    revision: Mapped[int] = mapped_column(Integer)
    expected_revision: Mapped[int] = mapped_column(Integer)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    actor_identity_basis: Mapped[str] = mapped_column(String(256))
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    content_digest: Mapped[str] = mapped_column(String(64))
    recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),nullable=True)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _content_cipher: Mapped[str] = mapped_column("content",record_storage_type())
    _snapshot_cipher: Mapped[str] = mapped_column("snapshot",record_storage_type())
    content = record_field("content")
    snapshot = record_field("snapshot")


def _immutable(mapper, connection, row):
    if any(attribute.history.has_changes() for attribute in inspect(row).attrs):
        raise ValueError("Care-cycle dates and committed daily originals are immutable; insert a new revision.")


for _model in (CareCycle, DailyRecord):
    register_record_fields(_model)
    event.listen(_model,"before_update",_immutable)
