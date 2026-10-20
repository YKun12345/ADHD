"""Immutable, actor-owned next actions derived from authenticated business facts."""
from datetime import datetime, timezone
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, Integer, String, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column
from backend.app.db.base import Base
from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.core.record_envelope import RecordIntegrityError


class AgentAction(RecordFieldsMixin, Base):
    __tablename__ = 'agent_actions'
    record_object_type = 'agent_action'
    record_fields = {'snapshot': 'agent_actions.snapshot'}
    __table_args__ = (UniqueConstraint('actor_user_id', 'patient_id', 'dedupe_key', name='uq_agent_action_trigger'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    kind: Mapped[str] = mapped_column(String(48))
    action_digest: Mapped[str] = mapped_column(String(64))
    authority_digest: Mapped[str] = mapped_column(String(64))
    dedupe_key: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    snapshot = record_field('snapshot')


class AgentRun(RecordFieldsMixin, Base):
    __tablename__ = 'agent_runs'
    record_object_type = 'agent_run'
    record_fields = {'snapshot': 'agent_runs.snapshot', 'state_snapshot': 'agent_runs.state_snapshot'}
    __table_args__ = (UniqueConstraint('id', 'patient_id', 'actor_user_id', name='uq_agent_run_context'),
        CheckConstraint("status IN ('queued','running','completed','failed','stale')", name='ck_agent_run_status'))
    id: Mapped[int] = mapped_column(primary_key=True)
    client_run_id: Mapped[str] = mapped_column(String(64), unique=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    intent: Mapped[str] = mapped_column(String(48))
    input_digest: Mapped[str] = mapped_column(String(64))
    request_digest: Mapped[str] = mapped_column(String(64))
    authority_digest: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(24), index=True)
    mode: Mapped[str] = mapped_column(String(24))
    model_name: Mapped[str | None] = mapped_column(String(96), nullable=True)
    model_round_count: Mapped[int] = mapped_column(Integer)
    tool_count: Mapped[int] = mapped_column(Integer)
    duration_ms: Mapped[int] = mapped_column(Integer)
    prompt_tokens: Mapped[int] = mapped_column(Integer)
    completion_tokens: Mapped[int] = mapped_column(Integer)
    estimated_cost_microunits: Mapped[int] = mapped_column(Integer)
    attempt_count: Mapped[int] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    artifact_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    _state_snapshot_cipher: Mapped[str] = mapped_column('state_snapshot', record_storage_type())
    snapshot = record_field('snapshot')
    state_snapshot = record_field('state_snapshot')


class AIArtifact(RecordFieldsMixin, Base):
    __tablename__ = 'ai_artifacts'
    record_object_type = 'ai_artifact'
    record_fields = {'snapshot': 'ai_artifacts.snapshot'}
    __table_args__ = (UniqueConstraint('id','patient_id','actor_user_id',name='uq_ai_artifact_context'),ForeignKeyConstraint(['run_id', 'patient_id', 'actor_user_id'],
        ['agent_runs.id', 'agent_runs.patient_id', 'agent_runs.actor_user_id']), UniqueConstraint('run_id', name='uq_agent_run_artifact'))
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(Integer, index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    kind: Mapped[str] = mapped_column(String(48))
    input_digest: Mapped[str] = mapped_column(String(64))
    body_digest: Mapped[str] = mapped_column(String(64))
    source_digest: Mapped[str] = mapped_column(String(64))
    rules_version: Mapped[str] = mapped_column(String(48))
    model_name: Mapped[str | None] = mapped_column(String(96), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    _snapshot_cipher: Mapped[str] = mapped_column('snapshot', record_storage_type())
    snapshot = record_field('snapshot')


class ArtifactDecision(RecordFieldsMixin,Base):
    __tablename__='agent_artifact_decisions'
    record_object_type='agent_artifact_decision'
    record_fields={'snapshot':'agent_artifact_decisions.snapshot'}
    __table_args__=(ForeignKeyConstraint(['artifact_id','patient_id','actor_user_id'],['ai_artifacts.id','ai_artifacts.patient_id','ai_artifacts.actor_user_id']),
        UniqueConstraint('artifact_id','version',name='uq_artifact_decision_version'),
        CheckConstraint("decision IN ('adopt','edit','reject') AND version > 0",name='ck_artifact_decision'))
    id:Mapped[int]=mapped_column(primary_key=True)
    artifact_id:Mapped[int]=mapped_column(Integer,index=True)
    patient_id:Mapped[int]=mapped_column(Integer,index=True)
    actor_user_id:Mapped[int]=mapped_column(Integer,index=True)
    client_decision_id:Mapped[str]=mapped_column(String(64),unique=True)
    version:Mapped[int]=mapped_column(Integer)
    decision:Mapped[str]=mapped_column(String(16))
    target_type:Mapped[str | None]=mapped_column(String(32),nullable=True)
    target_client_id:Mapped[str | None]=mapped_column(String(64),nullable=True,unique=True)
    input_digest:Mapped[str]=mapped_column(String(64))
    payload_digest:Mapped[str]=mapped_column(String(64))
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True))
    _snapshot_cipher:Mapped[str]=mapped_column('snapshot',record_storage_type())
    snapshot=record_field('snapshot')


RUN_STATE_FIELDS = ('status', 'mode', 'model_name', 'model_round_count', 'tool_count', 'duration_ms', 'prompt_tokens',
    'completion_tokens', 'estimated_cost_microunits', 'attempt_count', 'error_code', 'lease_token', 'lease_expires_at', 'artifact_id')


def _plain(value):
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat() if isinstance(value, datetime) else value


def run_state(row):
    return {field: _plain(getattr(row, field)) for field in RUN_STATE_FIELDS}


def metadata(row):
    if isinstance(row,ArtifactDecision):
        return {field:_plain(getattr(row,field)) for field in ('artifact_id','patient_id','actor_user_id','client_decision_id','version',
            'decision','target_type','target_client_id','input_digest','payload_digest','created_at')}
    if isinstance(row, AgentRun):
        fields = ('client_run_id', 'actor_user_id', 'patient_id', 'intent', 'input_digest', 'request_digest', 'authority_digest', 'created_at')
        return {field: _plain(getattr(row, field)) for field in fields}
    if isinstance(row, AIArtifact):
        fields = ('run_id', 'actor_user_id', 'patient_id', 'kind', 'input_digest', 'body_digest', 'source_digest', 'rules_version', 'model_name', 'created_at')
        return {field: _plain(getattr(row, field)) for field in fields}
    return {'actor_user_id': row.actor_user_id, 'patient_id': row.patient_id, 'kind': row.kind, 'action_digest': row.action_digest,
        'authority_digest': row.authority_digest, 'dedupe_key': row.dedupe_key,
        'created_at': (row.created_at if row.created_at.tzinfo else row.created_at.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()}


def verify(row, *args):
    from backend.app.services.cognitive_contract import canonical_digest
    saved = row.snapshot
    if saved.get('metadata') != metadata(row):
        raise RecordIntegrityError('Agent object metadata differs from its authenticated original.')
    if isinstance(row, AgentRun):
        if canonical_digest(saved.get('request')) != row.request_digest or canonical_digest(saved.get('authority')) != row.authority_digest or row.state_snapshot != run_state(row):
            raise RecordIntegrityError('Agent run input, authority or state differs from its authenticated record.')
        frame = saved.get('frame') or {}
        if canonical_digest({key: value for key, value in frame.items() if key not in {'input_digest', 'authorization_snapshot', 'credential_snapshot'}}) != row.input_digest:
            raise RecordIntegrityError('Agent input snapshot differs from its original digest.')
        return
    if isinstance(row,ArtifactDecision):
        if canonical_digest(saved.get('payload')) != row.payload_digest:
            raise RecordIntegrityError('Artifact disposition differs from its immutable human decision.')
        return
    if isinstance(row, AIArtifact):
        if canonical_digest(saved.get('body')) != row.body_digest or canonical_digest(saved.get('source_refs')) != row.source_digest:
            raise RecordIntegrityError('Agent artifact body or references differ from its original digest.')
        return
    if canonical_digest(saved.get('action')) != row.action_digest or canonical_digest(saved.get('authority')) != row.authority_digest:
        raise RecordIntegrityError('Agent action source, target or authority differs from its immutable original.')


def immutable(*args):
    row = args[-1]
    allowed = set(RUN_STATE_FIELDS) | {'_state_snapshot_cipher', '_snapshot_cipher', 'data_version', '_origin_cipher'} if isinstance(row, AgentRun) else set()
    if any(field.history.has_changes() for field in inspect(row).attrs if field.key not in allowed):
        raise ValueError('Agent action originals are immutable; changed state produces a new permitted action.')
    verify(row)


def preserve(*args):
    raise ValueError('Agent action originals cannot be deleted.')


for model in (AgentAction, AgentRun, AIArtifact, ArtifactDecision):
    register_record_fields(model)
    event.listen(model, 'before_insert', lambda mapper, connection, row: verify(row))
    event.listen(model, 'load', verify); event.listen(model, 'refresh', verify)
    event.listen(model, 'before_update', immutable); event.listen(model, 'before_delete', preserve)
