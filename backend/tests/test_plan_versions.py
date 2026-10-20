from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from backend.tests.test_report_publications import saved_draft, publication_body
from backend.tests.test_assessment_consumers import drain


def test_real_plan_publication_receipt_daily_evidence_future_revision_and_withdrawal(client):
    owner, doctor, other, session, draft, _ = saved_draft(client)
    published = client.post('/api/v1/care/review-publications', headers=doctor, json=publication_body(client, doctor, draft))
    assert published.status_code == 201, published.text
    route = f"/api/v1/care/assessments/{session['id']}/plan-context"
    assert client.get(route, headers=owner).status_code == 403
    assert client.get(route, headers=other).status_code == 403
    preflight = client.get(route, headers=doctor)
    assert preflight.status_code == 200, preflight.text
    ctx = preflight.json(); today = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    body = {'client_plan_version_id': 'actual-first-plan', 'patient_id': session['patient_id'], 'assessment_id': session['id'],
        'expected_assessment_version': ctx['assessment_version'], 'expected_previous_version': ctx['expected_previous_version'],
        'expected_plan_revision': ctx['expected_plan_revision'], 'source_report_id': ctx['source_report_id'],
        'input_digest': ctx['input_digest'], 'plan_context': ctx['plan_context'], 'title': '医生实际确认的合成记录安排',
        'instructions': '按实际情况记录当日状态，缺失保持为空；有问题通过共享消息联系医生。',
        'start_date': today.isoformat(), 'end_date': (today + timedelta(days=3)).isoformat(), 'confirmed': True}
    assert client.post('/api/v1/care/plan-versions', headers=owner, json=body).status_code == 403
    saved = client.post('/api/v1/care/plan-versions', headers=doctor, json=body)
    assert saved.status_code == 201, saved.text
    first = saved.json()
    assert first['version'] == 1 and first['actor_user_id'] == session['responsible_doctor_id']
    assert client.post('/api/v1/care/plan-versions', headers=doctor, json=body).json() == first
    assert client.get('/api/v1/care/plan-versions/submissions/actual-first-plan', headers=doctor).json() == first
    detail = client.get(f"/api/v1/care/plans/{first['plan_id']}", headers=owner)
    assert detail.status_code == 200, detail.text
    assert len(detail.json()['tasks']) == 4 and all(row['status'] != 'completed' for row in detail.json()['tasks'])
    assert detail.json()['acknowledgements'] == []
    ackctx = client.get(f"/api/v1/care/plan-versions/{first['id']}/acknowledgement-context", headers=owner)
    assert ackctx.status_code == 200, ackctx.text
    receipt_body = {'client_acknowledgement_id': 'actual-plan-received', 'patient_id': session['patient_id'], 'assessment_id': session['id'], 'plan_version_id': first['id'],
        'acknowledgement_context': ackctx.json()['acknowledgement_context'], 'confirmed': True}
    received = client.post('/api/v1/care/plan-acknowledgements', headers=owner, json=receipt_body)
    assert received.status_code == 201, received.text
    assert received.json()['meaning'] == 'received_only' and received.json()['actor_user_id'] != first['actor_user_id']
    assert client.post('/api/v1/care/plan-acknowledgements', headers=owner, json=receipt_body).json() == received.json()
    daily = {'client_submission_id': 'actual-plan-daily', 'patient_id': session['patient_id'], 'cycle_id': first['cycle_id'],
        'record_date': today.isoformat(), 'expected_revision': 0, 'recorded_at': None, 'content': {'note': '合成实际当日记录'}}
    recorded = client.post('/api/v1/care/daily-records', headers=owner, json=daily)
    assert recorded.status_code == 201, recorded.text
    before = client.get(f"/api/v1/care/plans/{first['plan_id']}", headers=owner).json()
    done = next(row for row in before['tasks'] if row['record_date'] == today.isoformat())
    assert done['status'] == 'completed' and done['daily_record_id'] == recorded.json()['record_id']
    nextctx = client.get(route, headers=doctor).json()
    revision = {**body, 'client_plan_version_id': 'actual-revised-plan', 'expected_previous_version': 1,
        'expected_plan_revision': nextctx['expected_plan_revision'], 'expected_assessment_version': nextctx['assessment_version'],
        'input_digest': nextctx['input_digest'], 'plan_context': nextctx['plan_context'], 'instructions': '医生修订未来记录安排，既往原件保留。'}
    assert client.post('/api/v1/care/plan-versions', headers=doctor, json=revision).status_code == 422
    revision['start_date'] = (today + timedelta(days=1)).isoformat()
    changed = client.post('/api/v1/care/plan-versions', headers=doctor, json=revision)
    assert changed.status_code == 201, changed.text
    assert changed.json()['version'] == 2 and changed.json()['cycle_id'] != first['cycle_id']
    after = client.get(f"/api/v1/care/plans/{first['plan_id']}", headers=owner).json()
    assert next(row for row in after['tasks'] if row['id'] == done['id']) == done
    assert any(row['status'] == 'superseded_future' and row['plan_version_id'] == first['id'] for row in after['tasks'])
    assert client.get('/api/v1/care/daily-records/actual-plan-daily', headers=owner).json() == recorded.json()
    relation = next(row for row in client.get('/api/v1/care/relationships', headers=owner).json()['items'] if row['doctor_user_id'] == session['responsible_doctor_id'])
    assert client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=owner, json={'expected_revision': relation['revision']}).status_code == 200
    drain()
    suspended = client.get(f"/api/v1/care/plans/{first['plan_id']}", headers=owner)
    assert suspended.status_code == 200 and suspended.json()['status'] == 'suspended', suspended.text
    assert next(row for row in suspended.json()['tasks'] if row['id'] == done['id'])['status'] == 'completed'
    assert client.get('/api/v1/care/daily-records/actual-plan-daily', headers=owner).json() == recorded.json()
    assert client.post('/api/v1/care/daily-records', headers=owner, json={**daily, 'client_submission_id': 'after-withdraw', 'expected_revision': 1}).status_code in {403, 409}
    assert client.get(f"/api/v1/care/plans/{first['plan_id']}", headers=doctor).status_code == 403
