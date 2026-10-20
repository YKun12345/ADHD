"""Immutable submission context and one actual result per server attempt/run."""
from datetime import datetime,timezone
from sqlalchemy import CheckConstraint,DateTime,ForeignKey,ForeignKeyConstraint,Integer,JSON,String,Text,event,inspect
from sqlalchemy.orm import Mapped,mapped_column
from backend.app.db.base import Base
from backend.app.core.record_fields import RecordFieldsMixin,record_field,register_record_fields
from backend.app.core.record_provenance import record_storage_type


class SubmissionRecord(RecordFieldsMixin,Base):
    __tablename__ = "submission_records"
    record_object_type = "submission_record"
    record_fields = {"content":"submission_records.content","execution_metadata":"submission_records.execution_metadata"}
    __table_args__ = (
        ForeignKeyConstraint(["attempt_id","patient_id","assessment_id","assessment_item_id"],["task_attempts.id","task_attempts.patient_id","task_attempts.assessment_id","task_attempts.assessment_item_id"]),
        CheckConstraint("(kind='scale' AND scale_result_id IS NOT NULL AND cognitive_result_id IS NULL) OR (kind='cognitive' AND cognitive_result_id IS NOT NULL AND scale_result_id IS NULL)",name="ck_submission_actual_result"),
        CheckConstraint("(performer_kind='user' AND performer_user_id IS NOT NULL AND performer_patient_id IS NULL) OR (performer_kind='patient' AND performer_patient_id IS NOT NULL AND performer_user_id IS NULL)",name="ck_submission_performer"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    submission_id: Mapped[str] = mapped_column(String(64),unique=True)
    kind: Mapped[str] = mapped_column(String(16))
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"),index=True)
    assessment_id: Mapped[int] = mapped_column(ForeignKey("assessment_sessions.id"),index=True)
    assessment_item_id: Mapped[int] = mapped_column(ForeignKey("assessment_items.id"),index=True)
    attempt_id: Mapped[int] = mapped_column(Integer,unique=True)
    run_id: Mapped[str] = mapped_column(String(64),unique=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("patient_tasks.id"),nullable=True)
    protocol_id: Mapped[str] = mapped_column(String(96))
    protocol_schema_version: Mapped[int] = mapped_column(Integer)
    config_digest: Mapped[str] = mapped_column(String(64))
    template_digest: Mapped[str] = mapped_column(String(64))
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    performer_kind: Mapped[str] = mapped_column(String(16))
    performer_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"),nullable=True)
    performer_patient_id: Mapped[int | None] = mapped_column(ForeignKey("patients.id"),nullable=True)
    respondent_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"),nullable=True)
    respondent_kind: Mapped[str | None] = mapped_column(String(32),nullable=True)
    submitter_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    canonical_digest: Mapped[str] = mapped_column(String(64))
    _content_cipher: Mapped[str] = mapped_column("content",record_storage_type())
    _execution_metadata_cipher: Mapped[str] = mapped_column("execution_metadata",record_storage_type())
    content = record_field("content")
    execution_metadata = record_field("execution_metadata")
    scale_result_id: Mapped[int | None] = mapped_column(ForeignKey("scale_results.id"),unique=True,nullable=True)
    cognitive_result_id: Mapped[int | None] = mapped_column(ForeignKey("cognitive_tests.id"),unique=True,nullable=True)
    execution_status: Mapped[str] = mapped_column(String(32),default="submitted")
    quality_status: Mapped[str] = mapped_column(String(32))
    acceptance_status: Mapped[str] = mapped_column(String(32))
    quality_reasons: Mapped[list] = mapped_column(JSON)
    quality_rule_version: Mapped[str] = mapped_column(String(64))
    comparability_status: Mapped[str] = mapped_column(String(32),default="not_verified")
    comparability_reasons: Mapped[list] = mapped_column(JSON)
    authorization_snapshot: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))
    committed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc))


def immutable_submission(mapper,connection,row):
    if any(attribute.history.has_changes() for attribute in inspect(row).attrs):
        raise ValueError("Committed submission content and context are immutable.")


event.listen(SubmissionRecord,"before_update",immutable_submission)
register_record_fields(SubmissionRecord)
