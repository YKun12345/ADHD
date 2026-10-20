from backend.tests.test_review_drafts import context_and_body


def test_actual_specific_question_reply_versions_and_stale_draft(client):
    owner, doctor, other, session, ctx, draft = context_and_body(client)
    question = {'client_question_id': 'original-question', 'patient_id': session['patient_id'], 'assessment_id': session['id'],
        'expected_assessment_version': ctx['assessment_version'], 'input_digest': ctx['input_digest'], 'review_context': ctx['review_context'],
        'source_type': 'submission', 'source_key': ctx['submissions'][0]['submission_id'], 'question': '这次操作中断的实际原因是什么？不知道或不便提供可以说明。', 'confirmed': True}
    assert client.post('/api/v1/care/clarifications', headers=other, json=question).status_code == 403
    saved = client.post('/api/v1/care/clarifications', headers=doctor, json=question)
    assert saved.status_code == 201, saved.text
    q = saved.json()
    assert q['actor_user_id'] == session['responsible_doctor_id'] and q['source_key'] == question['source_key']
    assert client.post('/api/v1/care/clarifications', headers=doctor, json=question).json() == q
    assert client.get('/api/v1/care/clarifications/submissions/original-question', headers=doctor).json() == q
    assert client.post('/api/v1/care/reviews', headers=doctor, json=draft).status_code == 409
    context = client.get(f"/api/v1/care/clarifications/{q['id']}/reply-context", headers=owner)
    assert context.status_code == 200, context.text
    preflight = context.json()
    reply = {'client_reply_id': 'original-question-reply', 'patient_id': session['patient_id'], 'assessment_id': session['id'],
        'question_id': q['id'], 'expected_assessment_version': preflight['assessment_version'],
        'expected_previous_revision': 0, 'reply_context': preflight['reply_context'], 'answer_status': 'unknown', 'answer': None, 'confirmed': True}
    assert client.post('/api/v1/care/clarification-replies', headers=doctor, json=reply).status_code == 403
    result = client.post('/api/v1/care/clarification-replies', headers=owner, json=reply)
    assert result.status_code == 201, result.text
    ack = result.json()
    assert ack['answer_status'] == 'unknown' and ack['answer'] is None and ack['revision'] == 1
    assert client.post('/api/v1/care/clarification-replies', headers=owner, json=reply).json() == ack
    assert client.get('/api/v1/care/clarification-replies/submissions/original-question-reply', headers=owner).json() == ack
    updated = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor).json()
    assert updated['input_digest'] != ctx['input_digest']
    assert updated['clarifications'][0]['replies'][0]['answer_status'] == 'unknown'
    assert updated['clarifications'][0]['replies'][0]['answer'] is None
    assert updated['background'] == ctx['background']
    assert client.get(f"/api/v1/care/assessments/{session['id']}/clarifications", headers=other).status_code == 403
    preflight2 = client.get(f"/api/v1/care/clarifications/{q['id']}/reply-context", headers=owner).json()
    skipped = {**reply, 'client_reply_id': 'second-question-reply', 'expected_assessment_version': preflight2['assessment_version'],
        'expected_previous_revision': 1, 'reply_context': preflight2['reply_context'], 'answer_status': 'skipped'}
    second = client.post('/api/v1/care/clarification-replies', headers=owner, json=skipped)
    assert second.status_code == 201 and second.json()['revision'] == 2 and second.json()['answer'] is None, second.text
    assert client.post('/api/v1/care/clarification-replies', headers=owner, json={**skipped, 'client_reply_id': 'forged', 'answer': '伪装已提供'}).status_code == 422
    relation = next(row for row in client.get('/api/v1/care/relationships', headers=owner).json()['items'] if row['doctor_user_id'] == session['responsible_doctor_id'])
    assert client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=owner, json={'expected_revision': relation['revision']}).status_code == 200
    assert client.get(f"/api/v1/care/clarifications/{q['id']}/reply-context", headers=owner).status_code in {403, 409}
    historical = client.get(f"/api/v1/care/assessments/{session['id']}/clarifications", headers=owner)
    assert historical.status_code == 200 and len(historical.json()['items'][0]['replies']) == 2
