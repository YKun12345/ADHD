"""New relationship-bound originals. Legacy CareMessage is never queried or converted."""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.db.base import Base


class SharedCareMessage(RecordFieldsMixin, Base):
    __tablename__ = "shared_care_messages"
    record_object_type = "shared_care_message"
    record_fields = {"content":"shared_care_messages.content", "snapshot":"shared_care_messages.snapshot"}
    id: Mapped[int] = mapped_column(primary_key=True)
    # Globally unique across actual senders; another owner cannot reuse this key.
    client_message_id: Mapped[str] = mapped_column(String(64), unique=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    relationship_id: Mapped[int] = mapped_column(ForeignKey("care_relationships.id"), index=True)
    relationship_revision: Mapped[int] = mapped_column(Integer)
    doctor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    patient_actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    sender_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    sender_identity_basis: Mapped[str] = mapped_column(String(256))
    sender_kind: Mapped[str] = mapped_column(String(16))
    scope: Mapped[list] = mapped_column(JSON)
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    content_digest: Mapped[str] = mapped_column(String(64))
    send_context_digest: Mapped[str] = mapped_column(String(64))
    context_digest: Mapped[str] = mapped_column(String(64))
    confirmed: Mapped[bool] = mapped_column(Boolean)
    reply_to_message_id: Mapped[int | None] = mapped_column(ForeignKey("shared_care_messages.id"), nullable=True)
    source_ai_decision_id: Mapped[int | None] = mapped_column(ForeignKey('agent_artifact_decisions.id'),nullable=True)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, default=1)
    _content_cipher: Mapped[str] = mapped_column("content",record_storage_type())
    _snapshot_cipher: Mapped[str] = mapped_column("snapshot",record_storage_type())
    content = record_field("content")
    snapshot = record_field("snapshot")


class SharedMessageRead(RecordFieldsMixin, Base):
    __tablename__ = "shared_message_reads"
    __table_args__ = (UniqueConstraint("message_id","viewer_user_id",name="uq_shared_message_actual_viewer"),)
    record_object_type = "shared_message_read"
    record_fields = {"snapshot":"shared_message_reads.snapshot"}
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"),index=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("shared_care_messages.id"),index=True)
    viewer_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column("snapshot",record_storage_type())
    snapshot = record_field("snapshot")


def _immutable(mapper,connection,row):
    if any(attribute.history.has_changes() for attribute in inspect(row).attrs):
        raise ValueError("Shared message originals and actual viewer receipts are immutable.")


def _preserve_original(*args):
    raise ValueError("Shared message originals and actual viewer receipts are immutable.")


for _model in (SharedCareMessage, SharedMessageRead):
    # Register the guard first, before the common mixin's mutable-record hook.
    event.listen(_model,"before_update",_immutable)
    event.listen(_model,"before_delete",_preserve_original)
    register_record_fields(_model)
