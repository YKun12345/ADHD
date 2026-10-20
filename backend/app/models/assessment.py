"""Independent self items and append-only attempts; no synthetic doctor foreign key."""
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, Integer, JSON, String, Text, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.db.base import Base


def now():
    return datetime.now(timezone.utc)


class AssessmentSession(RecordFieldsMixin, Base):
    __tablename__ = "assessment_sessions"
    record_object_type = "assessment_session"
    record_fields = {"background":"assessment_sessions.background"}
    __table_args__ = (
        UniqueConstraint("id", "patient_id", name="uq_assessment_session_patient"),
        CheckConstraint("source IN ('self','doctor_assigned')", name="ck_assessment_source"),
        CheckConstraint("(source = 'self' AND responsible_doctor_id IS NULL) OR (source = 'doctor_assigned' AND responsible_doctor_id IS NOT NULL)", name="ck_assessment_responsibility"),
        CheckConstraint("status IN ('draft','active','evidence_ready','closed_self','under_review','reviewed','suspended','cancelled')", name="ck_assessment_status"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    source: Mapped[str] = mapped_column(String(32))
    responsible_doctor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    template_id: Mapped[str] = mapped_column(String(64))
    template_version: Mapped[str] = mapped_column(String(64))
    template_digest: Mapped[str] = mapped_column(String(64))
    template_snapshot: Mapped[dict] = mapped_column(JSON)
    age_at_assessment: Mapped[int] = mapped_column(Integer)
    age_group: Mapped[str] = mapped_column(String(16))
    previous_assessment_id: Mapped[int | None] = mapped_column(ForeignKey("assessment_sessions.id"), nullable=True)
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    _background_cipher: Mapped[str] = mapped_column("background",record_storage_type())
    background = record_field("background")
    demonstration_only: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(32), default="draft", index=True)
    suspension_reason: Mapped[str | None] = mapped_column(String(64),nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AssessmentItem(Base):
    __tablename__ = "assessment_items"
    __table_args__ = (
        ForeignKeyConstraint(["assessment_id", "patient_id"], ["assessment_sessions.id", "assessment_sessions.patient_id"]),
        UniqueConstraint("assessment_id", "key", name="uq_assessment_item_key"),
        UniqueConstraint("id", "patient_id", "assessment_id", name="uq_assessment_item_context"),
        CheckConstraint("kind IN ('scale','cognitive')", name="ck_assessment_item_kind"),
        CheckConstraint("execution_status IN ('not_started','in_progress','submitted','cancelled')", name="ck_assessment_item_execution"),
        CheckConstraint("quality_status IN ('pending_validation','valid','limited','invalid')", name="ck_assessment_item_quality"),
        CheckConstraint("acceptance_status IN ('not_required','pending_review','accepted','needs_repeat','rejected')", name="ck_assessment_item_acceptance"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    assessment_id: Mapped[int] = mapped_column(Integer, index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    key: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16))
    instrument: Mapped[str] = mapped_column(String(64))
    definition_snapshot: Mapped[dict] = mapped_column(JSON)
    execution_status: Mapped[str] = mapped_column(String(32), default="not_started")
    quality_status: Mapped[str] = mapped_column(String(32), default="pending_validation")
    acceptance_status: Mapped[str] = mapped_column(String(32))
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class TaskAttempt(RecordFieldsMixin, Base):
    __tablename__ = "task_attempts"
    record_object_type = "task_attempt"
    record_fields = {"execution_metadata":"task_attempts.execution_metadata"}
    __table_args__ = (
        UniqueConstraint("id","patient_id","assessment_id","assessment_item_id",name="uq_task_attempt_context"),
        ForeignKeyConstraint(["assessment_item_id", "patient_id", "assessment_id"], ["assessment_items.id", "assessment_items.patient_id", "assessment_items.assessment_id"]),
        CheckConstraint("execution_status IN ('in_progress','submitted','cancelled')", name="ck_task_attempt_execution"),
        CheckConstraint("quality_status IN ('pending_validation','valid','limited','invalid')", name="ck_task_attempt_quality"),
        CheckConstraint("acceptance_status IN ('not_required','pending_review','accepted','needs_repeat','rejected')", name="ck_task_attempt_acceptance"),
        CheckConstraint("(performer_kind = 'user' AND performer_user_id IS NOT NULL AND performer_patient_id IS NULL) OR (performer_kind = 'patient' AND performer_patient_id IS NOT NULL AND performer_user_id IS NULL)", name="ck_task_attempt_performer"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    assessment_id: Mapped[int] = mapped_column(Integer, index=True)
    assessment_item_id: Mapped[int] = mapped_column(Integer, index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    run_id: Mapped[str] = mapped_column(String(64), unique=True, default=lambda: uuid4().hex)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    performer_patient_id: Mapped[int | None] = mapped_column(ForeignKey("patients.id"), nullable=True)
    performer_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    performer_kind: Mapped[str] = mapped_column(String(16))
    respondent_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    respondent_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    submitter_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    age_at_attempt: Mapped[int] = mapped_column(Integer)
    age_group: Mapped[str] = mapped_column(String(16))
    protocol_id: Mapped[str] = mapped_column(String(96))
    protocol_schema_version: Mapped[int] = mapped_column(Integer)
    config_digest: Mapped[str] = mapped_column(String(64))
    config_snapshot: Mapped[dict] = mapped_column(JSON)
    template_digest: Mapped[str] = mapped_column(String(64))
    _execution_metadata_cipher: Mapped[str] = mapped_column("execution_metadata",record_storage_type())
    execution_metadata = record_field("execution_metadata")
    recall_window: Mapped[str | None] = mapped_column(String(16), nullable=True)
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    execution_status: Mapped[str] = mapped_column(String(32), default="in_progress")
    quality_status: Mapped[str] = mapped_column(String(32), default="pending_validation")
    acceptance_status: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


IMMUTABLE = {
    AssessmentSession: {"patient_id", "source", "responsible_doctor_id", "created_by_user_id", "template_id", "template_version", "template_digest", "template_snapshot", "age_at_assessment", "age_group", "previous_assessment_id", "authorization_snapshot", "_background_cipher", "demonstration_only", "created_at"},
    AssessmentItem: {"assessment_id", "patient_id", "key", "kind", "instrument", "definition_snapshot", "created_at"},
    TaskAttempt: {attribute.key for attribute in inspect(TaskAttempt).column_attrs} - {"execution_status", "quality_status", "acceptance_status"},
}


def reject_context_rewrite(mapper, connection, target):
    state = inspect(target)
    if any(state.attrs[field].history.has_changes() for field in IMMUTABLE[type(target)]):
        raise ValueError("Assessment and attempt ownership/context are immutable; create a new attempt.")


for model in IMMUTABLE:
    event.listen(model, "before_update", reject_context_rewrite)

register_record_fields(AssessmentSession)
register_record_fields(TaskAttempt)
