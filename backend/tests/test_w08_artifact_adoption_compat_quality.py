"""Cheap independent protocol/schema probes; no real database or model invocation."""
from datetime import datetime, timezone

import pytest


def test_nullable_ai_source_preserves_exact_old_message_semantic_context_and_ack():
    from backend.app.models.shared_message import SharedCareMessage
    from backend.app.schemas.shared_message import SharedMessageCreate
    from backend.app.services import care_message_service as messages
    from backend.app.services.cognitive_contract import canonical_digest
    from backend.app.core.record_envelope import RecordIntegrityError

    token = 'old-server-context-' + 'a' * 64
    payload = {'patient_id': 8, 'relationship_id': 20, 'client_message_id': 'old-no-ai-original',
        'content': '原无AI来源消息保持原摘要', 'reply_to_message_id': None, 'confirmed': True, 'send_context': token}
    old_semantic = {key: payload[key] for key in ('patient_id', 'relationship_id', 'client_message_id', 'content', 'reply_to_message_id', 'confirmed')}
    old_semantic['send_context_digest'] = canonical_digest(token)
    omitted = SharedMessageCreate.model_validate(payload)
    explicit_null = SharedMessageCreate.model_validate({**payload, 'source_ai_decision_id': None})
    assert messages._semantic(omitted) == messages._semantic(explicit_null) == old_semantic
    old_context = {'id': 51, 'client_message_id': payload['client_message_id'], 'patient_id': 8, 'relationship_id': 20,
        'relationship_revision': 2, 'doctor_user_id': 90, 'patient_actor_user_id': 7, 'sender_user_id': 7,
        'sender_identity_basis': 'self:7:access:1:revision:1', 'sender_kind': 'patient', 'scope': ['care'],
        'authorization_snapshot': [], 'content_digest': canonical_digest(old_semantic), 'send_context_digest': canonical_digest(token),
        'confirmed': True, 'reply_to_message_id': None, 'sent_at': '2026-10-16T00:00:00+00:00', 'version': 1}
    row = SharedCareMessage(**{key: value for key, value in old_context.items() if key != 'sent_at'},
        sent_at=datetime(2026, 10, 16, tzinfo=timezone.utc), content=payload['content'], source_ai_decision_id=None,
        context_digest=canonical_digest(old_context), snapshot=old_context)
    assert messages._context(row, messages._CONTEXT) == old_context
    assert messages._semantic(row) == old_semantic
    assert messages._ack(row) == {'message_id': 51, **{key: value for key, value in old_context.items() if key != 'id'},
        'content': payload['content'], 'context_digest': canonical_digest(old_context), 'legacy': False, 'submission_status': 'committed'}
    row.source_ai_decision_id = 9
    assert messages._semantic(row)['source_ai_decision_id'] == messages._context(row, messages._CONTEXT)['source_ai_decision_id'] == 9
    with pytest.raises(RecordIntegrityError):
        messages._verify(row)


def test_artifact_decision_schema_binds_owner_artifact_and_unique_human_version():
    from sqlalchemy import create_engine
    from sqlalchemy.schema import CreateTable
    from sqlalchemy.dialects import mysql
    from backend.app.models.agent import ArtifactDecision
    from backend.app.models.shared_message import SharedCareMessage
    from backend.app.db.agent_migration import agent_schema_plan

    ddl = str(CreateTable(ArtifactDecision.__table__).compile(dialect=mysql.dialect()))
    assert 'FOREIGN KEY(artifact_id, patient_id, actor_user_id)' in ddl
    assert 'UNIQUE (artifact_id, version)' in ddl
    assert 'UNIQUE (client_decision_id)' in ddl
    assert SharedCareMessage.__table__.c.source_ai_decision_id.nullable is True
    engine = create_engine('sqlite://')
    try:
        result = agent_schema_plan(engine)
        assert result['executed'] is False and result['requires_explicit_review'] is True
        assert any('agent_artifact_decisions' in statement for statement in result['statements'])
        assert engine.dialect.get_table_names(engine.connect()) == []
    finally:
        engine.dispose()
