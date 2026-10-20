"""Independent adoption quality probes; fixture-isolated synthetic stores only."""
from sqlalchemy import event

from backend.tests.test_assessment_sessions import doctor_session
from backend.tests.test_agent_artifact_business import _actual_run, _adopt


def test_actual_adopted_reply_locks_human_disposition_before_latest_check(client):
    _, owner, patient_id, _, doctor, draft = doctor_session(client)
    published = client.post(f"/api/v1/care/assessments/{draft['id']}/publish", headers=doctor, json={"expected_version": draft['version']})
    assert published.status_code == 200, published.text
    artifact = _actual_run(client, doctor, published.json(), 'reply_draft', 'quality-real-reply')
    decision = _adopt(client, doctor, artifact, 'quality-real-human-use')
    relationships = client.get(f"/api/v1/care/shared-messages/relationships?patient_id={patient_id}", headers=doctor)
    assert relationships.status_code == 200, relationships.text
    selected = next(row for row in relationships.json()['items'] if row['can_send'])
    payload = {'patient_id': patient_id, 'relationship_id': selected['relationship_id'],
        'client_message_id': decision['target_client_id'], 'send_context': selected['send_context'],
        'content': decision['content']['text'], 'source_ai_decision_id': decision['id'], 'confirmed': True}
    from backend.app.db.session import engine
    statements = []

    def observe(connection, cursor, statement, parameters, context, many):
        statements.append(' '.join(statement.lower().split()))

    event.listen(engine, 'before_cursor_execute', observe)
    try:
        result = client.post('/api/v1/care/shared-messages', headers=doctor, json=payload)
        assert result.status_code == 201, result.text
    finally:
        event.remove(engine, 'before_cursor_execute', observe)
    lock_positions = [index for index, sql in enumerate(statements)
        if sql.startswith('update ai_artifacts ') or ('from ai_artifacts ' in sql and 'for update' in sql)]
    latest_positions = [index for index, sql in enumerate(statements)
        if 'max(agent_artifact_decisions.version)' in sql or
        ('from agent_artifact_decisions ' in sql and 'order by agent_artifact_decisions.version desc' in sql)]
    print({'actual_message_id': result.json()['message_id'], 'actual_decision_id': decision['id'],
        'artifact_serialization_positions': lock_positions, 'latest_decision_read_positions': latest_positions,
        'mysql_race_executed': False})
    assert latest_positions, 'the actual business operation must check the latest human disposition'
    assert lock_positions and min(lock_positions) < min(latest_positions), (
        'The real business transaction reads latest disposition without acquiring the same artifact lock as decide; '
        'SQLite writer serialization is not evidence of MySQL row-lock serialization')
