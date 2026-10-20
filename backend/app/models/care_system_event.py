"""Authenticated system facts name their actual service, never a fictional human."""
from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, event, inspect
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.db.base import Base


class CareSystemEvent(RecordFieldsMixin, Base):
    __tablename__ = "care_system_events"
    record_object_type = "care_system_event"
    record_fields = {"payload": "care_system_events.payload"}
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[str] = mapped_column(String(64), unique=True, default=lambda: uuid4().hex)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    assessment_id: Mapped[int] = mapped_column(ForeignKey("assessment_sessions.id"), index=True)
    system_principal: Mapped[str] = mapped_column(String(64))
    event_type: Mapped[str] = mapped_column(String(64))
    revision: Mapped[int] = mapped_column(Integer)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    dedupe_key: Mapped[str] = mapped_column(String(192), unique=True)
    _payload_cipher: Mapped[str] = mapped_column("payload", record_storage_type())
    payload = record_field("payload")


class CareReconciliationCursor(Base):
    __tablename__ = "care_reconciliation_cursors"
    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    last_assessment_id: Mapped[int] = mapped_column(Integer, default=0)


class CareDeadlineCursor(Base):
    __tablename__ = "care_deadline_cursors"
    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    last_attention_id: Mapped[int] = mapped_column(Integer, default=0)


@event.listens_for(CareSystemEvent, "before_update")
def _immutable(mapper, connection, row):
    if any(attribute.history.has_changes() for attribute in inspect(row).attrs):
        raise ValueError("System care facts are immutable.")


@event.listens_for(CareSystemEvent, "before_delete")
def _preserve(*_):
    raise ValueError("System care facts are immutable and cannot be deleted.")


register_record_fields(CareSystemEvent)
