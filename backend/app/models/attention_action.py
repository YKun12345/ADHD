"""Immutable explicit actions; reading or delivering a notification is no action."""
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.db.base import Base


class AttentionAction(RecordFieldsMixin, Base):
    __tablename__ = "attention_actions"
    record_object_type = "attention_action"
    record_fields = {"reason":"attention_actions.reason", "snapshot":"attention_actions.snapshot"}
    __table_args__ = (
        UniqueConstraint("attention_id", "version", name="uq_attention_action_version"),
        CheckConstraint("expected_version > 0 AND version = expected_version + 1", name="ck_attention_action_version"),
        CheckConstraint("confirmed = 1", name="ck_attention_action_confirmed"),
        CheckConstraint("(action='acknowledge' AND previous_status='open' AND status='acknowledged') OR "
            "(action='resolve' AND previous_status='acknowledged' AND status='resolved') OR "
            "(action='close_with_reason' AND previous_status IN ('open','acknowledged') AND status='closed_with_reason')",
            name="ck_attention_action_transition"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    client_action_id: Mapped[str] = mapped_column(String(64), unique=True)
    attention_id: Mapped[int] = mapped_column(ForeignKey("attention_items.id"), index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    actor_identity_basis: Mapped[str] = mapped_column(String(256))
    action: Mapped[str] = mapped_column(String(24))
    previous_status: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32))
    expected_version: Mapped[int] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    action_context_digest: Mapped[str] = mapped_column(String(64))
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    source_context: Mapped[dict] = mapped_column(JSON)
    context_digest: Mapped[str] = mapped_column(String(64))
    confirmed: Mapped[bool] = mapped_column(Boolean)
    _reason_cipher: Mapped[str] = mapped_column("reason", record_storage_type())
    _snapshot_cipher: Mapped[str] = mapped_column("snapshot", record_storage_type())
    reason = record_field("reason")
    snapshot = record_field("snapshot")


def _immutable(mapper, connection, row):
    if any(attribute.history.has_changes() for attribute in inspect(row).attrs):
        raise ValueError("Attention actions are immutable; create a separate explicit next action.")


def _preserve(*args):
    raise ValueError("Attention actions are immutable and cannot be deleted.")


event.listen(AttentionAction, "before_update", _immutable)
event.listen(AttentionAction, "before_delete", _preserve)
register_record_fields(AttentionAction)
