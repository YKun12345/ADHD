"""Concrete user-authorized handovers preserve old provenance and create successor work."""
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.db.base import Base


class CareTransferRequest(RecordFieldsMixin, Base):
    __tablename__ = "care_transfer_requests"
    record_object_type = "care_transfer_request"
    record_fields = {"body": "care_transfer_requests.body"}
    __table_args__ = (CheckConstraint("version=1", name="ck_transfer_request_version"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    client_transfer_id: Mapped[str] = mapped_column(String(64), unique=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    author_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    author_identity_basis: Mapped[str] = mapped_column(String(256))
    receiver_doctor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    receiving_relationship_id: Mapped[int] = mapped_column(ForeignKey("care_relationships.id"))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, default=1)
    request_context_digest: Mapped[str] = mapped_column(String(64))
    payload_digest: Mapped[str] = mapped_column(String(64))
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    _body_cipher: Mapped[str] = mapped_column("body", record_storage_type())
    body = record_field("body")


class CareTransferDecision(RecordFieldsMixin, Base):
    __tablename__ = "care_transfer_decisions"
    record_object_type = "care_transfer_decision"
    record_fields = {"body": "care_transfer_decisions.body"}
    __table_args__ = (
        CheckConstraint("decision IN ('accept','reject','cancel')", name="ck_transfer_decision"),
        CheckConstraint("expected_version=1 AND version=2 AND confirmed=1", name="ck_transfer_decision_version"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    client_decision_id: Mapped[str] = mapped_column(String(64), unique=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    transfer_id: Mapped[int] = mapped_column(ForeignKey("care_transfer_requests.id"), unique=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    actor_identity_basis: Mapped[str] = mapped_column(String(256))
    decision: Mapped[str] = mapped_column(String(16))
    expected_version: Mapped[int] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer)
    confirmed: Mapped[bool] = mapped_column(Boolean)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decision_context_digest: Mapped[str] = mapped_column(String(64))
    payload_digest: Mapped[str] = mapped_column(String(64))
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    _body_cipher: Mapped[str] = mapped_column("body", record_storage_type())
    body = record_field("body")


class CareTransferWorkItem(RecordFieldsMixin, Base):
    __tablename__ = "care_transfer_work_items"
    record_object_type = "care_transfer_work_item"
    record_fields = {"detail": "care_transfer_work_items.detail", "state_snapshot": "care_transfer_work_items.state_snapshot"}
    __table_args__ = (
        UniqueConstraint("transfer_id", "source_type", "source_id", name="uq_transfer_work_source"),
        CheckConstraint("source_type IN ('attention','transferred_work')", name="ck_transfer_work_source"),
        CheckConstraint("status IN ('open','acknowledged','resolved','closed_with_reason','suspended')", name="ck_transfer_work_status"),
        CheckConstraint("version > 0", name="ck_transfer_work_version"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    transfer_id: Mapped[int] = mapped_column(ForeignKey("care_transfer_requests.id"))
    decision_id: Mapped[int] = mapped_column(ForeignKey("care_transfer_decisions.id"))
    source_type: Mapped[str] = mapped_column(String(32))
    source_id: Mapped[int] = mapped_column(Integer)
    original_attention_id: Mapped[int] = mapped_column(ForeignKey("attention_items.id"))
    assessment_id: Mapped[int] = mapped_column(ForeignKey("assessment_sessions.id"), index=True)
    from_doctor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    responsible_doctor_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    receiving_relationship_id: Mapped[int] = mapped_column(ForeignKey("care_relationships.id"))
    accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expected_response_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(32), default="open", index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    suspension_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    _detail_cipher: Mapped[str] = mapped_column("detail", record_storage_type())
    _state_snapshot_cipher: Mapped[str] = mapped_column("state_snapshot", record_storage_type())
    detail = record_field("detail")
    state_snapshot = record_field("state_snapshot")


class CareTransferWorkAction(RecordFieldsMixin, Base):
    __tablename__ = "care_transfer_work_actions"
    record_object_type = "care_transfer_work_action"
    record_fields = {"body": "care_transfer_work_actions.body"}
    __table_args__ = (
        UniqueConstraint("work_item_id", "version", name="uq_transfer_work_action_version"),
        CheckConstraint("expected_version > 0 AND version=expected_version+1", name="ck_transfer_action_version"),
        CheckConstraint("(action='acknowledge' AND previous_status='open' AND status='acknowledged') OR "
            "(action='resolve' AND previous_status='acknowledged' AND status='resolved') OR "
            "(action='close_with_reason' AND previous_status IN ('open','acknowledged') AND status='closed_with_reason')",
            name="ck_transfer_action_transition"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    client_action_id: Mapped[str] = mapped_column(String(64), unique=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    work_item_id: Mapped[int] = mapped_column(ForeignKey("care_transfer_work_items.id"), index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    actor_identity_basis: Mapped[str] = mapped_column(String(256))
    action: Mapped[str] = mapped_column(String(24))
    previous_status: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32))
    expected_version: Mapped[int] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    action_context_digest: Mapped[str] = mapped_column(String(64))
    payload_digest: Mapped[str] = mapped_column(String(64))
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    _body_cipher: Mapped[str] = mapped_column("body", record_storage_type())
    body = record_field("body")


class CareTransferClaim(Base):
    __tablename__ = "care_transfer_claims"
    source_type: Mapped[str] = mapped_column(String(32), primary_key=True)
    source_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"))
    transfer_id: Mapped[int | None] = mapped_column(ForeignKey("care_transfer_requests.id"), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)


class CareTransferMaintenanceCursor(Base):
    __tablename__ = "care_transfer_maintenance_cursors"
    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    last_work_id: Mapped[int] = mapped_column(Integer, default=0)


def _immutable(mapper, connection, row):
    if any(attribute.history.has_changes() for attribute in inspect(row).attrs):
        raise ValueError("Handover facts are immutable; record a new explicit action.")


def _preserve(*_):
    raise ValueError("Handover facts are immutable and cannot be deleted.")


for model in (CareTransferRequest, CareTransferDecision, CareTransferWorkAction):
    event.listen(model, "before_update", _immutable)
    event.listen(model, "before_delete", _preserve)
    register_record_fields(model)


@event.listens_for(CareTransferWorkItem, "before_update")
def _preserve_work_source(mapper, connection, row):
    mutable = {"status", "version", "suspension_reason", "_state_snapshot_cipher"}
    if any(attribute.history.has_changes() for attribute in inspect(row).attrs if attribute.key not in mutable):
        raise ValueError("Successor work keeps its immutable accepted source and actual responsible scope.")


event.listen(CareTransferWorkItem, "before_delete", _preserve)
register_record_fields(CareTransferWorkItem)
