"""Canonical transactional outbox; authorization and later care workflows share it."""
from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.db.base import Base


class CareEvent(RecordFieldsMixin, Base):
    __tablename__ = "care_events"
    record_object_type = "care_event"
    record_fields = {"payload":"care_events.payload"}
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[str] = mapped_column(String(64), unique=True, default=lambda: uuid4().hex)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    actor_identity_basis: Mapped[str] = mapped_column(String(128))
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    aggregate_type: Mapped[str] = mapped_column(String(32))
    aggregate_id: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    _payload_cipher: Mapped[str] = mapped_column("payload",record_storage_type())
    payload = record_field("payload")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dedupe_key: Mapped[str | None] = mapped_column(String(192),unique=True,nullable=True)


class CareEventDelivery(Base):
    __tablename__ = "care_event_deliveries"
    __table_args__ = (
        UniqueConstraint("event_id","consumer",name="uq_care_event_consumer"),
        CheckConstraint("status IN ('pending','processing','succeeded','retry_failed','suspended')",name="ck_care_event_delivery_status"),
        CheckConstraint("attempts >= 0",name="ck_care_event_delivery_attempts"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[str] = mapped_column(ForeignKey("care_events.event_id"),index=True)
    consumer: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32),default="pending",index=True)
    lease_token: Mapped[str | None] = mapped_column(String(64),nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),nullable=True)
    attempts: Mapped[int] = mapped_column(Integer,default=0)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(256),nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),nullable=True)


register_record_fields(CareEvent)
