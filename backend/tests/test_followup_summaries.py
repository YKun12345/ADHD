"""One synthetic HTTP path covers real originals, missing values and access."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from backend.tests.test_assessment_sessions import created, start, actor
from backend.tests.test_submission_context import scale_submission


def test_actual_summary_comparison_dates_missing_zero_and_withdrawal(client):
    # The route can be exercised independently while Root registers the module.
    if not any(route.path == '/api/v1/care/followup-summary' for route in client.app.routes):
        from backend.app.api.routes.followup_summary import router
        client.app.include_router(router, prefix='/api/v1')
    owner, _, session, _, _, first = scale_submission(client, suffix='w10-first')
    pid = first['patient_id']
    assert client.post('/api/v1/care/submissions', headers=owner, json=first).status_code == 201
    second_session = created(client, owner, pid)
    second_item = second_session['items'][0]
    actual = start(client, owner, second_item, pid).json()
    second = {**first, 'submission_id': 'w10-second', 'assessment_id': second_session['id'],
        'assessment_item_id': second_item['id'], 'attempt_id': actual['id'], 'run_id': actual['run_id'],
        'template_digest': actual['template_digest'], 'config_digest': actual['config_digest']}
    assert client.post('/api/v1/care/submissions', headers=owner, json=second).status_code == 201
    today = datetime.now(timezone.utc).astimezone(ZoneInfo('Asia/Shanghai')).date()
    for index, start_date in enumerate((today - timedelta(days=2), today)):
        response = client.post('/api/v1/care/cycles', headers=owner, json={'patient_id': pid,
            'client_cycle_id': f'w10-cycle-{index}', 'start_date': start_date.isoformat(), 'end_date': today.isoformat()})
        assert response.status_code == 201, response.text
        cycle_id = response.json()['id']
        response = client.post('/api/v1/care/daily-records', headers=owner, json={'patient_id': pid, 'cycle_id': cycle_id,
            'record_date': today.isoformat(), 'client_submission_id': f'w10-daily-{index}', 'expected_revision': 0,
            'recorded_at': None, 'content': {'focus_minutes': 0} if index == 0 else {'note': '合成自报，原记录时间未知'}})
        assert response.status_code == 201, response.text
    response = client.get(f'/api/v1/care/followup-summary?patient_id={pid}', headers=owner)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['coverage']['due_unique_dates'] == 3 and value['coverage']['completed_unique_dates'] == 1
    assert value['cycles'][0]['metrics']['focus_minutes']['mean'] == 0
    assert value['cycles'][1]['metrics']['focus_minutes']['mean'] is None
    assert value['reported_events'][0]['reported_at'] is None
    assert len(value['measurements']) == 2 and all(row['metrics']['total_score'] == 0 for row in value['measurements'])
    assert value['comparisons'][0]['status'] == 'limited'
    assert value['comparisons'][0]['numeric_changes'] == []
    comparison = client.get('/api/v1/care/comparisons', headers=owner, params={'patient_id': pid,
        'left_submission_id': first['submission_id'], 'right_submission_id': second['submission_id']})
    assert comparison.status_code == 200, comparison.text
    assert comparison.json()['left']['source_ref']['id'] == first['submission_id']
    _, stranger, _ = actor(client, suffix='w10-stranger')
    assert client.get(f'/api/v1/care/followup-summary?patient_id={pid}', headers=stranger).status_code == 403
    basic = next(row for row in client.get('/api/v1/patient/consents', headers=owner).json()['items'] if row['purpose'] == 'basic_use')
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=owner,
        json={'expected_revision': basic['revision']}).status_code == 200
    assert client.get(f'/api/v1/care/followup-summary?patient_id={pid}', headers=owner).status_code == 403
    assert client.get('/api/v1/care/submissions/' + first['submission_id'], headers=owner).status_code == 200
