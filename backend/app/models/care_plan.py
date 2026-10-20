"""Authenticated plan state with immutable published schedules and receipt facts."""
from datetime import date, datetime, timezone
from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, ForeignKeyConstraint, Integer, String, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column
from backend.app.db.base import Base
from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.core.record_envelope import RecordIntegrityError


def metadata(row):
    def plain(value):
        if isinstance(value, datetime):
            return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()
        return value.isoformat() if isinstance(value, date) else value
    return {field: plain(getattr(row, field)) for field in row.metadata_fields}


def state(row):
    return {field: getattr(row, field) for field in ('status', 'revision', 'current_plan_version_id', 'suspension_reason')}


class CarePlan(RecordFieldsMixin, Base):
    __tablename__ = 'care_plans'
    record_object_type = 'care_plan'
    record_fields = {'snapshot': 'care_plans.snapshot', 'state_snapshot': 'care_plans.state_snapshot'}
    metadata_fields = ('patient_id', 'assessment_id', 'responsible_doctor_id', 'relationship_id', 'authority_digest', 'created_at')
    __table_args__ = (ForeignKeyConstraint(['assessment_id', 'patient_id'], ['assessment_sessions.id', 'assessment_sessions.patient_id']),
        UniqueConstraint('assessment_id', name='uq_care_plan_assessment'), UniqueConstraint('id', 'patient_id', 'assessment_id', name='uq_care_plan_context'),
        CheckConstraint("status IN ('draft','active','suspended','ended')", name='ck_care_plan_status'))
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    assessment_id: Mapped[int] = mapped_column(Integer, index=True)
    responsible_doctor_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    relationship_id: Mapped[int] = mapped_column(ForeignKey('care_relationships.id'))
    authority_digest: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(24))
    revision: Mapped[int] = mapped_column(Integer)
    current_plan_version_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    suspension_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    _state_snapshot_cipher: Mapped[str] = mapped_column('state_snapshot', record_storage_type())
    snapshot = record_field('snapshot')
    state_snapshot = record_field('state_snapshot')


class PlanVersion(RecordFieldsMixin, Base):
    __tablename__ = 'care_plan_versions'
    record_object_type = 'care_plan_version'
    record_fields = {'snapshot': 'care_plan_versions.snapshot'}
    metadata_fields = ('patient_id', 'assessment_id', 'plan_id', 'actor_user_id', 'client_plan_version_id', 'version',
        'source_report_id', 'start_date', 'end_date', 'payload_digest', 'published_at')
    __table_args__ = (ForeignKeyConstraint(['plan_id', 'patient_id', 'assessment_id'], ['care_plans.id', 'care_plans.patient_id', 'care_plans.assessment_id']),
        UniqueConstraint('plan_id', 'version', name='uq_care_plan_version'), UniqueConstraint('id', 'patient_id', name='uq_care_plan_version_patient'),
        CheckConstraint('end_date >= start_date AND version > 0', name='ck_care_plan_version_dates'))
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    assessment_id: Mapped[int] = mapped_column(Integer, index=True)
    plan_id: Mapped[int] = mapped_column(Integer, index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    client_plan_version_id: Mapped[str] = mapped_column(String(64), unique=True)
    version: Mapped[int] = mapped_column(Integer)
    source_report_id: Mapped[int] = mapped_column(ForeignKey('report_versions.id'))
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    payload_digest: Mapped[str] = mapped_column(String(64))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    snapshot = record_field('snapshot')


class PlanTask(RecordFieldsMixin, Base):
    __tablename__ = 'care_plan_tasks'
    record_object_type = 'care_plan_task'
    record_fields = {'snapshot': 'care_plan_tasks.snapshot'}
    metadata_fields = ('patient_id', 'plan_version_id', 'record_date', 'task_type')
    __table_args__ = (ForeignKeyConstraint(['plan_version_id', 'patient_id'], ['care_plan_versions.id', 'care_plan_versions.patient_id']),
        UniqueConstraint('plan_version_id', 'record_date', name='uq_plan_task_date'),
        CheckConstraint("task_type = 'daily_record'", name='ck_plan_task_type'))
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    plan_version_id: Mapped[int] = mapped_column(Integer, index=True)
    record_date: Mapped[date] = mapped_column(Date)
    task_type: Mapped[str] = mapped_column(String(24))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    snapshot = record_field('snapshot')


class PlanAcknowledgement(RecordFieldsMixin, Base):
    __tablename__ = 'plan_acknowledgements'
    record_object_type = 'plan_acknowledgement'
    record_fields = {'snapshot': 'plan_acknowledgements.snapshot'}
    metadata_fields = ('patient_id', 'plan_version_id', 'actor_user_id', 'client_acknowledgement_id', 'payload_digest', 'received_at')
    __table_args__ = (ForeignKeyConstraint(['plan_version_id', 'patient_id'], ['care_plan_versions.id', 'care_plan_versions.patient_id']),
        UniqueConstraint('plan_version_id', 'actor_user_id', name='uq_plan_receipt_actor'))
    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    plan_version_id: Mapped[int] = mapped_column(Integer, index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    client_acknowledgement_id: Mapped[str] = mapped_column(String(64), unique=True)
    payload_digest: Mapped[str] = mapped_column(String(64))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    snapshot = record_field('snapshot')


def verify(row, *args):
    if row.snapshot.get('metadata') != metadata(row):
        raise RecordIntegrityError('Plan metadata differs from its authenticated original.')
    if isinstance(row, CarePlan) and row.state_snapshot != state(row):
        raise RecordIntegrityError('Plan current state differs from its authenticated state.')
    if isinstance(row, CarePlan):
        from backend.app.services.cognitive_contract import canonical_digest
        if canonical_digest({key: row.snapshot.get(key) for key in ('authorization_snapshot', 'credential_snapshot', 'actor_identity_basis')}) != row.authority_digest:
            raise RecordIntegrityError('The original plan authority differs from its immutable digest.')
    if isinstance(row, (PlanVersion, PlanAcknowledgement)):
        from backend.app.services.cognitive_contract import canonical_digest
        if canonical_digest(row.snapshot.get('payload')) != row.payload_digest:
            raise RecordIntegrityError('Plan confirmed payload differs from its digest.')


def immutable(mapper, connection, row):
    attributes = inspect(row).attrs
    # The record-field layer increments data_version and reseals both fields
    # when state changes. Immutable plaintext metadata and authority digest
    # remain fixed even though their authenticated ciphertext is refreshed.
    allowed = {'status', 'revision', 'current_plan_version_id', 'suspension_reason', '_state_snapshot_cipher',
        '_snapshot_cipher', 'data_version', '_origin_cipher'} if isinstance(row, CarePlan) else set()
    if any(attr.history.has_changes() for attr in attributes if attr.key not in allowed):
        raise ValueError('Plan originals and published schedules are immutable.')
    verify(row)


def preserve(*args):
    raise ValueError('Published plan originals cannot be deleted.')


for model in (CarePlan, PlanVersion, PlanTask, PlanAcknowledgement):
    register_record_fields(model)
    event.listen(model, 'before_insert', lambda mapper, connection, row: verify(row))
    event.listen(model, 'load', verify); event.listen(model, 'refresh', verify)
    event.listen(model, 'before_update', immutable); event.listen(model, 'before_delete', preserve)
