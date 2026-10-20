from backend.tests.test_review_drafts import context_and_body


def test_rule_run_is_a_real_queryable_owned_artifact_and_cannot_change_business_or_borrow_another_actor(client):
    owner, doctor, _, session, _, _ = context_and_body(client)
    preflight = client.get(f"/api/v1/agent/run-context?patient_id={session['patient_id']}", headers=owner)
    assert preflight.status_code == 200, preflight.text
    ctx = preflight.json()
    body = {'client_run_id': 'original-rule-run', 'patient_id': session['patient_id'], 'intent': 'assessment_summary',
        'assessment_id': session['id'], 'cycle_id': None, 'message': '请说明这轮实际保存的进度和下一步。',
        'expected_context_digest': ctx['input_digest'], 'run_context': ctx['run_context']}
    before = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    queued = client.post('/api/v1/agent/runs', headers=owner, json=body)
    assert queued.status_code == 202, queued.text
    ack = queued.json()
    assert ack['client_run_id'] == body['client_run_id'] and ack['accepted'] is True
    assert ack['original_request'] == body and ack['actor_user_id'] != session['responsible_doctor_id']
    assert client.get('/api/v1/agent/runs/submissions/original-rule-run', headers=owner).json() == ack
    assert client.post('/api/v1/agent/runs', headers=owner, json=body).json() == ack
    assert client.post('/api/v1/agent/runs', headers=owner, json={**body, 'message': '同一原ID不同问题'}).status_code == 409
    import time
    for _ in range(100):
        read = client.get(f"/api/v1/agent/runs/{ack['run_id']}", headers=owner)
        if read.json().get('status') not in {'queued', 'running'}:
            break
        time.sleep(0.05)
    assert read.status_code == 200, read.text
    run = read.json()
    assert run['status'] == 'completed' and run['mode'] == 'rules'
    assert run['model_round_count'] == 0 and run['tool_count'] <= 6 and run['duration_ms'] < 60000
    assert run['artifact']['status'] == 'draft' and run['artifact']['input_digest'] == body['expected_context_digest']
    assert run['artifact']['source_refs'] and run['artifact']['body']['summary']['limited_submissions'] == 1
    assert run['artifact']['body']['summary']['valid_submissions'] == 0
    assert client.get(f"/api/v1/agent/runs/{ack['run_id']}", headers=doctor).status_code == 403
    assert client.get('/api/v1/agent/runs/submissions/original-rule-run', headers=doctor).status_code == 403
    after = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    assert after['version'] == before['version'] and after['status'] == before['status']
    assert after['items'] == before['items']
