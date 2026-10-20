from datetime import timedelta
import pytest
from backend.tests.test_report_publications import saved_draft, publication_body


def actual_plan(client):
    owner, doctor, other, session, draft, _ = saved_draft(client)
    report = client.post('/api/v1/care/review-publications', headers=doctor, json=publication_body(client, doctor, draft))
    assert report.status_code == 201, report.text
    ctx = client.get(f"/api/v1/care/assessments/{session['id']}/plan-context", headers=doctor).json()
    from datetime import date
    day = date.fromisoformat(ctx['calendar_today'])
    value = {key: ctx[key] for key in ('patient_id','assessment_id','expected_previous_version','expected_plan_revision','source_report_id','input_digest','plan_context')}
    value.update(client_plan_version_id='reviewed-cycle-source-plan', expected_assessment_version=ctx['assessment_version'], title='实际阶段记录安排',
        instructions='按实际日期记录，缺失不补造。', start_date=str(day), end_date=str(day), confirmed=True)
    saved = client.post('/api/v1/care/plan-versions', headers=doctor, json=value)
    assert saved.status_code == 201, saved.text
    record = client.post('/api/v1/care/daily-records', headers=owner, json={'client_submission_id': 'cycle-actual-day',
        'patient_id': session['patient_id'], 'cycle_id': saved.json()['cycle_id'], 'record_date': str(day), 'expected_revision': 0,
        'recorded_at': None, 'content': {'note': '实际合成记录，未记录专注值。'}})
    assert record.status_code == 201, record.text
    return owner, doctor, other, session, saved.json(), record.json(), day


@pytest.mark.parametrize('decision', ['continue', 'adjust', 'end', 'next_round'])
def test_actual_professional_cycle_review_keeps_original_dates_and_creates_its_real_followup(client, decision):
    owner, doctor, other, session, plan, record, day = actual_plan(client)
    route = f"/api/v1/care/cycles/{plan['cycle_id']}/review-context"
    response = client.get(route, headers=doctor)
    assert response.status_code == 200, response.text
    ctx = response.json()
    assert ctx['input_snapshot']['cycle']['summary']['completed_count'] == 1
    assert ctx['input_snapshot']['cycle']['records'][0]['content']['focus_minutes'] is None
    body = {'client_cycle_review_id': 'original-stage-review', 'patient_id': session['patient_id'], 'cycle_id': plan['cycle_id'],
        'expected_previous_version': ctx['expected_previous_version'], 'input_digest': ctx['input_digest'], 'review_context': ctx['review_context'],
        'decision': decision, 'body': '核对实际记录和缺失，不判断治疗效果。', 'limitations': '仅合成流程演示，当前材料有局限。',
        'reason': '实际阶段安排需要后续核对。', 'followup_plan': None, 'next_cycle': None, 'confirmed': True}
    if decision in {'continue','adjust'}:
        body['followup_plan'] = {'title': '真实后续安排', 'instructions': '继续按实际日期记录，未记录保持为空。',
            'start_date': str(day+timedelta(days=1)), 'end_date': str(day+timedelta(days=2))}
    if decision == 'end':
        assert client.get(route, headers=owner).status_code == 403
        assert client.get(route, headers=other).status_code == 403
        revised = client.post('/api/v1/care/daily-records', headers=owner, json={'client_submission_id': 'actual-late-revision',
            'patient_id': session['patient_id'], 'cycle_id': plan['cycle_id'], 'record_date': str(day), 'expected_revision': 1,
            'recorded_at': None, 'content': {'note': '真实补充说明，保持未知值。'}})
        assert revised.status_code == 201, revised.text
        assert client.post(f"/api/v1/care/cycles/{plan['cycle_id']}/reviews", headers=doctor, json=body).status_code == 409
        ctx = client.get(route, headers=doctor).json(); body.update(input_digest=ctx['input_digest'], review_context=ctx['review_context'])
    saved = client.post(f"/api/v1/care/cycles/{plan['cycle_id']}/reviews", headers=doctor, json=body)
    assert saved.status_code == 201, saved.text
    ack = saved.json(); assert ack['decision'] == decision and ack['actor_user_id'] == session['responsible_doctor_id']
    assert client.get('/api/v1/care/cycle-reviews/submissions/original-stage-review', headers=doctor).json() == ack
    assert client.post(f"/api/v1/care/cycles/{plan['cycle_id']}/reviews", headers=doctor, json=body).json() == ack
    history = client.get(f"/api/v1/care/cycles/{plan['cycle_id']}/reviews", headers=owner)
    assert history.status_code == 200 and history.json()['items'][0]['id'] == ack['id']
    assert client.get('/api/v1/care/daily-records/cycle-actual-day', headers=owner).json() == record
    if decision in {'continue','adjust'}:
        assert ack['next_plan_version_id'] > plan['id'] and ack['next_cycle_id'] != plan['cycle_id']
        next_cycle = client.get(f"/api/v1/care/cycles/{ack['next_cycle_id']}", headers=owner).json()
        assert next_cycle['start_date'] == str(day+timedelta(days=1)) and not next_cycle['records']
    else:
        assert client.get(f"/api/v1/care/plans/{plan['plan_id']}", headers=owner).json()['status'] == 'ended'
        if decision == 'next_round':
            next_assessment = client.get(f"/api/v1/care/assessments/{ack['next_assessment_id']}", headers=doctor)
            assert next_assessment.status_code == 200, next_assessment.text
            next_session = next_assessment.json()
            assert next_session['id'] != session['id'] and next_session['previous_assessment_id'] == session['id']
            assert next_session['status'] == 'draft' and next_session['responsible_doctor_id'] == session['responsible_doctor_id']
            assert all(row['execution_status'] == 'not_started' for row in next_session['items'])
            assert client.get(f"/api/v1/care/assessments/{next_session['id']}", headers=owner).status_code == 403
