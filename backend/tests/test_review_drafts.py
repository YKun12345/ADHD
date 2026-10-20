"""Private drafts are real doctor decisions, never automatic clinical acceptance."""
from backend.tests.test_responsibility_transfers import real_transfer_source


def context_and_body(client):
    owner, doctor, incoming, session, _, _ = real_transfer_source(client)
    response = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor)
    assert response.status_code == 200, response.text
    current = response.json()
    payload = {'client_review_id': 'original-review-draft', 'patient_id': session['patient_id'], 'assessment_id': session['id'],
        'expected_assessment_version': current['assessment_version'], 'input_digest': current['input_digest'],
        'review_context': current['review_context'], 'category': 'evidence_review',
        'body': '合成实际医生核对本次已保存试次，材料有局限，尚不能作临床判断。',
        'limitations': '本轮其他材料尚未提交，当前仅为材料审核。',
        'decisions': [{'submission_id': row['submission_id'], 'assessment_item_id': row['assessment_item_id'],
            'attempt_id': row['attempt_id'], 'decision': 'needs_repeat', 'reason': '实际执行有中断，建议新尝试。'} for row in current['submissions']],
        'confirmed': True}
    return owner, doctor, incoming, session, current, payload


def test_private_review_draft_keeps_frozen_inputs_and_exact_original_ack_without_accepting(client):
    owner, doctor, incoming, session, current, payload = context_and_body(client)
    saved = client.post('/api/v1/care/reviews', headers=doctor, json=payload)
    assert saved.status_code == 201, saved.text
    ack = saved.json()
    assert ack['client_review_id'] == payload['client_review_id']
    assert ack['status'] == 'draft' and ack['submission_status'] == 'committed'
    assert ack['actor_user_id'] == session['responsible_doctor_id']
    assert ack['input_digest'] == payload['input_digest'] and ack['body'] == payload['body']
    assert ack['decisions'] == payload['decisions']
    assert client.post('/api/v1/care/reviews', headers=doctor, json=payload).json() == ack
    assert client.get('/api/v1/care/reviews/submissions/original-review-draft', headers=doctor).json() == ack
    assert client.post('/api/v1/care/reviews', headers=doctor, json={**payload, 'body': '不同正文'}).status_code == 409
    assert client.get(f"/api/v1/care/reviews/{ack['id']}", headers=owner).status_code == 403
    assert client.get(f"/api/v1/care/reviews/{ack['id']}", headers=incoming).status_code == 403
    detail = client.get(f"/api/v1/care/reviews/{ack['id']}", headers=doctor)
    assert detail.status_code == 200, detail.text
    assert detail.json()['input_snapshot']['submissions'] == current['submissions']
    listed = client.get(f"/api/v1/care/assessments/{session['id']}/reviews", headers=doctor)
    assert listed.status_code == 200 and listed.json()['items'][0]['id'] == ack['id']
    unchanged = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    assert all(item['acceptance_status'] == 'pending_review' for item in unchanged['items'])
    assert client.get(f"/api/v1/care/assessments/{session['id']}/reports", headers=owner).json()['items'] == []


def test_draft_requires_original_actor_exact_inputs_and_real_reasons(client):
    owner, doctor, incoming, _, _, payload = context_and_body(client)
    assert client.post('/api/v1/care/reviews', headers=owner, json=payload).status_code == 403
    assert client.post('/api/v1/care/reviews', headers=incoming, json=payload).status_code == 403
    assert client.post('/api/v1/care/reviews', headers=doctor, json={**payload, 'confirmed': False}).status_code == 422
    assert client.post('/api/v1/care/reviews', headers=doctor, json={**payload, 'input_digest': '0'*64}).status_code == 409
    wrong = [{**payload['decisions'][0], 'attempt_id': 9999}]
    assert client.post('/api/v1/care/reviews', headers=doctor, json={**payload, 'decisions': wrong}).status_code == 409
    assert client.post('/api/v1/care/reviews', headers=doctor, json={**payload, 'doctor_user_id': 9999}).status_code == 422
