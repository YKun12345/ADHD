"""Append-only frozen professional inputs, private decisions and published versions."""
from datetime import datetime, timezone
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, Integer, String, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column
from backend.app.db.base import Base
from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.core.record_envelope import RecordIntegrityError


def metadata(row):
    values = {}
    for field in row.metadata_fields:
        value = getattr(row, field)
        if isinstance(value, datetime):
            value = (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()
        values[field] = value
    return values


class ReviewInputSnapshot(RecordFieldsMixin, Base):
    __tablename__ = 'review_input_snapshots'
    record_object_type = 'review_input_snapshot'
    record_fields = {'snapshot': 'review_input_snapshots.snapshot'}
    metadata_fields = ('patient_id', 'assessment_id', 'actor_user_id', 'assessment_version', 'input_digest', 'created_at')
    __table_args__ = (ForeignKeyConstraint(['assessment_id', 'patient_id'], ['assessment_sessions.id', 'assessment_sessions.patient_id']),
        UniqueConstraint('id', 'patient_id', 'assessment_id', name='uq_review_input_context'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    assessment_id: Mapped[int] = mapped_column(Integer, index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    assessment_version: Mapped[int] = mapped_column(Integer)
    input_digest: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    snapshot = record_field('snapshot')


class ReviewRecord(RecordFieldsMixin, Base):
    __tablename__ = 'review_records'
    record_object_type = 'review_record'
    record_fields = {'snapshot': 'review_records.snapshot'}
    metadata_fields = ('patient_id', 'assessment_id', 'input_snapshot_id', 'actor_user_id', 'client_review_id', 'category',
        'assessment_version', 'input_digest', 'payload_digest', 'created_at')
    __table_args__ = (ForeignKeyConstraint(['input_snapshot_id', 'patient_id', 'assessment_id'],
        ['review_input_snapshots.id', 'review_input_snapshots.patient_id', 'review_input_snapshots.assessment_id']),
        UniqueConstraint('id', 'patient_id', 'assessment_id', name='uq_review_record_context'),
        CheckConstraint("category IN ('evidence_review','screening_opinion','clinical_assessment','diagnosis')", name='ck_review_category'))
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    assessment_id: Mapped[int] = mapped_column(Integer, index=True)
    input_snapshot_id: Mapped[int] = mapped_column(Integer)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    client_review_id: Mapped[str] = mapped_column(String(64), unique=True)
    category: Mapped[str] = mapped_column(String(32))
    assessment_version: Mapped[int] = mapped_column(Integer)
    input_digest: Mapped[str] = mapped_column(String(64))
    payload_digest: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    snapshot = record_field('snapshot')


class ReportVersion(RecordFieldsMixin, Base):
    __tablename__ = 'report_versions'
    record_object_type = 'report_version'
    record_fields = {'snapshot': 'report_versions.snapshot'}
    metadata_fields = ('patient_id', 'assessment_id', 'review_id', 'actor_user_id', 'client_publication_id', 'category', 'version',
        'expected_assessment_version', 'input_digest', 'payload_digest', 'published_at')
    __table_args__ = (ForeignKeyConstraint(['review_id', 'patient_id', 'assessment_id'],
        ['review_records.id', 'review_records.patient_id', 'review_records.assessment_id']),
        ForeignKeyConstraint(['assessment_id', 'patient_id'], ['assessment_sessions.id', 'assessment_sessions.patient_id']),
        UniqueConstraint('assessment_id', 'version', name='uq_report_assessment_version'),
        UniqueConstraint('review_id', name='uq_report_review_publication'),
        CheckConstraint('version > 0', name='ck_report_positive_version'),
        CheckConstraint("(category = 'self_screening' AND review_id IS NULL) OR (category IN ('evidence_review','screening_opinion','clinical_assessment','diagnosis') AND review_id IS NOT NULL)", name='ck_report_actual_publisher'))
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    assessment_id: Mapped[int] = mapped_column(Integer, index=True)
    review_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    client_publication_id: Mapped[str] = mapped_column(String(64), unique=True)
    category: Mapped[str] = mapped_column(String(32))
    version: Mapped[int] = mapped_column(Integer)
    expected_assessment_version: Mapped[int] = mapped_column(Integer)
    input_digest: Mapped[str] = mapped_column(String(64))
    payload_digest: Mapped[str] = mapped_column(String(64))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    snapshot = record_field('snapshot')


class ReviewClarification(RecordFieldsMixin, Base):
    __tablename__ = 'review_clarifications'
    record_object_type = 'review_clarification'
    record_fields = {'snapshot': 'review_clarifications.snapshot'}
    metadata_fields = ('patient_id', 'assessment_id', 'actor_user_id', 'client_question_id', 'source_type', 'source_key',
        'expected_assessment_version', 'payload_digest', 'created_at')
    __table_args__ = (ForeignKeyConstraint(['assessment_id', 'patient_id'], ['assessment_sessions.id', 'assessment_sessions.patient_id']),
        UniqueConstraint('id', 'patient_id', 'assessment_id', name='uq_clarification_context'),
        CheckConstraint("source_type IN ('submission','background')", name='ck_clarification_source'))
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    assessment_id: Mapped[int] = mapped_column(Integer, index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    client_question_id: Mapped[str] = mapped_column(String(64), unique=True)
    source_type: Mapped[str] = mapped_column(String(24))
    source_key: Mapped[str] = mapped_column(String(64))
    expected_assessment_version: Mapped[int] = mapped_column(Integer)
    payload_digest: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    snapshot = record_field('snapshot')


class ClarificationReply(RecordFieldsMixin, Base):
    __tablename__ = 'clarification_replies'
    record_object_type = 'clarification_reply'
    record_fields = {'snapshot': 'clarification_replies.snapshot'}
    metadata_fields = ('patient_id', 'assessment_id', 'question_id', 'actor_user_id', 'client_reply_id',
        'expected_assessment_version', 'revision', 'payload_digest', 'created_at')
    __table_args__ = (ForeignKeyConstraint(['question_id', 'patient_id', 'assessment_id'],
        ['review_clarifications.id', 'review_clarifications.patient_id', 'review_clarifications.assessment_id']),
        UniqueConstraint('question_id', 'revision', name='uq_clarification_reply_revision'))
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    assessment_id: Mapped[int] = mapped_column(Integer, index=True)
    question_id: Mapped[int] = mapped_column(Integer, index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    client_reply_id: Mapped[str] = mapped_column(String(64), unique=True)
    expected_assessment_version: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    payload_digest: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    snapshot = record_field('snapshot')


class CycleReview(RecordFieldsMixin, Base):
    __tablename__ = 'cycle_reviews'
    record_object_type = 'cycle_review'
    record_fields = {'snapshot': 'cycle_reviews.snapshot'}
    metadata_fields = ('patient_id', 'cycle_id', 'actor_user_id', 'client_cycle_review_id', 'version', 'decision',
        'input_digest', 'payload_digest', 'next_cycle_id', 'next_plan_version_id', 'next_assessment_id', 'created_at')
    __table_args__ = (ForeignKeyConstraint(['cycle_id','patient_id'], ['care_cycles.id','care_cycles.patient_id']),
        ForeignKeyConstraint(['next_cycle_id','patient_id'], ['care_cycles.id','care_cycles.patient_id']),
        ForeignKeyConstraint(['next_plan_version_id','patient_id'], ['care_plan_versions.id','care_plan_versions.patient_id']),
        ForeignKeyConstraint(['next_assessment_id','patient_id'], ['assessment_sessions.id','assessment_sessions.patient_id']),
        UniqueConstraint('cycle_id','version',name='uq_cycle_review_version'),
        CheckConstraint("decision IN ('continue','adjust','end','next_round') AND version > 0",name='ck_cycle_review_decision'))
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(Integer,index=True)
    cycle_id: Mapped[int] = mapped_column(Integer,index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    client_cycle_review_id: Mapped[str] = mapped_column(String(64),unique=True)
    version: Mapped[int] = mapped_column(Integer)
    decision: Mapped[str] = mapped_column(String(24))
    input_digest: Mapped[str] = mapped_column(String(64))
    payload_digest: Mapped[str] = mapped_column(String(64))
    next_cycle_id: Mapped[int | None] = mapped_column(Integer,nullable=True)
    next_plan_version_id: Mapped[int | None] = mapped_column(Integer,nullable=True)
    next_assessment_id: Mapped[int | None] = mapped_column(Integer,nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot',record_storage_type())
    snapshot = record_field('snapshot')


def verify(row, *args):
    value = row.snapshot
    if not isinstance(value, dict) or value.get('metadata') != metadata(row):
        raise RecordIntegrityError('Professional review metadata differs from its authenticated immutable record.')
    from backend.app.services.cognitive_contract import canonical_digest
    if isinstance(row, ReviewInputSnapshot) and canonical_digest(value.get('input')) != row.input_digest:
        raise RecordIntegrityError('Frozen review inputs do not match their authenticated digest.')
    if isinstance(row, ReportVersion) and canonical_digest(value.get('input_snapshot')) != row.input_digest:
        raise RecordIntegrityError('Published report input differs from its frozen input digest.')
    if isinstance(row, CycleReview) and canonical_digest(value.get('input_snapshot')) != row.input_digest:
        raise RecordIntegrityError('Cycle review input differs from its frozen evidence.')
    if not isinstance(row, ReviewInputSnapshot) and canonical_digest(value.get('payload')) != row.payload_digest:
        raise RecordIntegrityError('Original professional action payload does not match its digest.')


def immutable(mapper, connection, row):
    if any(attr.history.has_changes() for attr in inspect(row).attrs):
        raise ValueError('Review inputs, drafts and report versions are immutable; create a new record.')


def preserve(*args):
    raise ValueError('Review originals and report versions cannot be deleted.')


for model in (ReviewInputSnapshot, ReviewRecord, ReportVersion, ReviewClarification, ClarificationReply, CycleReview):
    register_record_fields(model)
    event.listen(model, 'before_insert', lambda mapper, connection, row: verify(row))
    event.listen(model, 'load', verify)
    event.listen(model, 'refresh', verify)
    event.listen(model, 'before_update', immutable)
    event.listen(model, 'before_delete', preserve)
