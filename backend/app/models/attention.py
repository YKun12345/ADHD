"""Durable event-owned attention, separate from notification delivery or resolution."""
from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.db.base import Base


class AttentionItem(RecordFieldsMixin, Base):
    __tablename__ = "attention_items"
    record_object_type = "attention_item"
    record_fields = {"detail":"attention_items.detail", "state_snapshot":"attention_items.state_snapshot"}
    __table_args__ = (
        UniqueConstraint("source_event_id","kind",name="uq_attention_source_kind"),
        CheckConstraint("kind IN ('assessment_quality','evidence_review')",name="ck_attention_kind"),
        CheckConstraint("status IN ('open','acknowledged','resolved','closed_with_reason','suspended','in_progress','closed')",name="ck_attention_status"),
        CheckConstraint("version > 0",name="ck_attention_version"),
        CheckConstraint("(owner_kind='patient_self' AND responsible_doctor_id IS NULL) OR (owner_kind='doctor' AND responsible_doctor_id IS NOT NULL)",name="ck_attention_owner"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    source_event_id: Mapped[str] = mapped_column(ForeignKey("care_events.event_id"),index=True)
    kind: Mapped[str] = mapped_column(String(32),index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"),index=True)
    assessment_id: Mapped[int] = mapped_column(ForeignKey("assessment_sessions.id"),index=True)
    submission_id: Mapped[str | None] = mapped_column(ForeignKey("submission_records.submission_id"),nullable=True)
    owner_kind: Mapped[str] = mapped_column(String(32))
    responsible_doctor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"),nullable=True,index=True)
    relationship_id: Mapped[int | None] = mapped_column(ForeignKey("care_relationships.id"),nullable=True)
    created_for_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(32),default="open",index=True)
    version: Mapped[int] = mapped_column(Integer,default=1)
    suspension_reason: Mapped[str | None] = mapped_column(String(64),nullable=True)
    expected_response_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),nullable=True)
    _detail_cipher: Mapped[str] = mapped_column("detail",record_storage_type())
    detail = record_field("detail")
    _state_snapshot_cipher: Mapped[str] = mapped_column("state_snapshot",record_storage_type())
    state_snapshot = record_field("state_snapshot")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))


def immutable_attention_source(mapper,connection,row):
    state = inspect(row)
    fields = {"source_event_id","kind","patient_id","assessment_id","submission_id","owner_kind",
        "responsible_doctor_id","relationship_id","created_for_user_id","_detail_cipher","created_at"}
    if any(state.attrs[name].history.has_changes() for name in fields):
        raise ValueError("Attention source and original responsibility are immutable; use an explicit accepted transfer.")


event.listen(AttentionItem,"before_update",immutable_attention_source)
register_record_fields(AttentionItem)
