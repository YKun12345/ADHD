"""Independent scoped W06 probes using per-test synthetic stores."""
from datetime import timedelta
from backend.tests.test_assessment_consumers import complete_assessment, drain
from backend.tests.test_report_publications import publication_body, saved_draft
from backend.tests.test_assessment_sessions import start
from backend.tests.test_cycle_reviews import actual_plan


def _report(client, doctor, session, pid, *, repeat=False):
    response = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor)
    assert response.status_code == 200, response.text
    context = response.json()
    target = next(row for row in context['submissions'] if row['kind'] == 'cognitive')
    key = 'repeat' if repeat else 'accepted'
    saved = client.post('/api/v1/care/reviews', headers=doctor, json={
        'client_review_id': 'independent-' + key, 'patient_id': pid, 'assessment_id': session['id'],
        'expected_assessment_version': context['assessment_version'], 'input_digest': context['input_digest'],
        'review_context': context['review_context'], 'category': 'evidence_review',
        'body': 'Independent actual synthetic doctor opinion', 'limitations': 'Synthetic engineering evidence only',
        'decisions': [{'submission_id': row['submission_id'], 'assessment_item_id': row['assessment_item_id'],
            'attempt_id': row['attempt_id'], 'decision': 'needs_repeat' if repeat and row == target else 'accepted',
            'reason': 'Actual independent explicit decision'} for row in context['submissions']], 'confirmed': True})
    assert saved.status_code == 201, saved.text
    body = publication_body(client, doctor, saved.json())
    body['client_publication_id'] = 'independent-' + key + '-publication'
    published = client.post('/api/v1/care/review-publications', headers=doctor, json=body)
    assert published.status_code == 201, published.text
    return published.json(), target


def test_independent_revised_report_reopens_requested_attempt_and_specific_question_without_changing_old_report(client):
    owner, doctor, session, pid = complete_assessment(client, doctor=True)
    drain()
    first, _ = _report(client, doctor, session, pid)
    assert first['assessment_status'] == 'reviewed'
    second, target = _report(client, doctor, session, pid, repeat=True)
    assert second['assessment_status'] == 'under_review'
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    item = next(row for row in current['items'] if row['id'] == target['assessment_item_id'])
    assert item['repeat_request']['report_id'] == second['id']
    assert start(client, owner, item, pid, repeat_report_id=second['id']).status_code == 201
    context = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor).json()
    issued = client.post('/api/v1/care/clarifications', headers=doctor, json={
        'client_question_id': 'independent-after-reviewed-question', 'patient_id': pid, 'assessment_id': session['id'],
        'expected_assessment_version': context['assessment_version'], 'input_digest': context['input_digest'],
        'review_context': context['review_context'], 'source_type': 'submission', 'source_key': target['submission_id'],
        'question': 'Specific synthetic follow-up question', 'confirmed': True})
    assert issued.status_code == 201, issued.text
    reply = client.get(f"/api/v1/care/clarifications/{issued.json()['id']}/reply-context", headers=owner)
    assert reply.status_code == 200, reply.text
    original = client.get('/api/v1/care/review-publications/submissions/independent-accepted-publication', headers=doctor)
    assert original.status_code == 200 and original.json() == first, original.text


def test_independent_future_revision_preserves_original_received_ack_and_cannot_reuse_stale_receipt_context(client):
    owner, doctor, _, session, first, _, day = actual_plan(client)
    receipt_context = client.get(f"/api/v1/care/plan-versions/{first['id']}/acknowledgement-context", headers=owner)
    assert receipt_context.status_code == 200, receipt_context.text
    receipt_body = {'client_acknowledgement_id': 'independent-original-received', 'patient_id': session['patient_id'],
        'assessment_id': session['id'], 'plan_version_id': first['id'],
        'acknowledgement_context': receipt_context.json()['acknowledgement_context'], 'confirmed': True}
    receipt = client.post('/api/v1/care/plan-acknowledgements', headers=owner, json=receipt_body)
    assert receipt.status_code == 201, receipt.text
    context = client.get(f"/api/v1/care/assessments/{session['id']}/plan-context", headers=doctor).json()
    revision = client.post('/api/v1/care/plan-versions', headers=doctor, json={
        **{key: context[key] for key in ('patient_id', 'assessment_id', 'expected_previous_version', 'expected_plan_revision',
                                        'source_report_id', 'input_digest', 'plan_context')},
        'expected_assessment_version': context['assessment_version'], 'client_plan_version_id': 'independent-future-plan',
        'title': 'Actual future revision', 'instructions': 'Preserve original dated observations',
        'start_date': str(day + timedelta(days=1)), 'end_date': str(day + timedelta(days=2)), 'confirmed': True})
    assert revision.status_code == 201, revision.text
    original = client.get('/api/v1/care/plan-acknowledgements/submissions/independent-original-received', headers=owner)
    assert original.status_code == 200 and original.json() == receipt.json(), original.text
    assert client.post('/api/v1/care/plan-acknowledgements', headers=owner,
                       json={**receipt_body, 'client_acknowledgement_id': 'independent-stale-new-receipt'}).status_code == 409


def test_independent_cycle_next_round_real_draft_requires_actual_publish_before_new_tasks_are_available(client):
    owner, doctor, _, session, plan, _, _ = actual_plan(client)
    context = client.get(f"/api/v1/care/cycles/{plan['cycle_id']}/review-context", headers=doctor).json()
    saved = client.post('/api/v1/care/cycle-reviews', headers=doctor, json={
        'client_cycle_review_id': 'independent-next-round', 'patient_id': session['patient_id'], 'cycle_id': plan['cycle_id'],
        'expected_previous_version': 0, 'input_digest': context['input_digest'], 'review_context': context['review_context'],
        'decision': 'next_round', 'body': 'Actual stage decision', 'limitations': 'Synthetic records only',
        'reason': 'New explicitly authorized assessment', 'followup_plan': None, 'next_cycle': None, 'confirmed': True})
    assert saved.status_code == 201, saved.text
    identifier = saved.json()['next_assessment_id']
    path = f'/api/v1/care/assessments/{identifier}'
    draft = client.get(path, headers=doctor)
    assert draft.status_code == 200 and draft.json()['status'] == 'draft', draft.text
    assert all(row['patient_task_id'] is None for row in draft.json()['items'])
    assert client.get(path, headers=owner).status_code == 403
    published = client.post(path + '/publish', headers=doctor, json={'expected_version': draft.json()['version']})
    assert published.status_code == 200, published.text
    visible = client.get(path, headers=owner)
    assert visible.status_code == 200 and visible.json()['status'] == 'active', visible.text
    assert all(row['patient_task_id'] is not None for row in visible.json()['items'])
    assert visible.json()['previous_assessment_id'] == session['id']


def test_independent_nonexistent_ai_decision_cannot_create_review_question_or_plan_side_effects(client):
    from sqlalchemy import select, func
    owner, doctor, _, session, draft, body = saved_draft(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.review import ReviewRecord, ReviewInputSnapshot, ReviewClarification
    from backend.app.models.care_plan import CarePlan, PlanVersion, PlanTask
    with SessionLocal() as db:
        before = [db.scalar(select(func.count()).select_from(model)) for model in (ReviewRecord, ReviewInputSnapshot)]
    denied = client.post('/api/v1/care/reviews', headers=doctor,
                         json={**body, 'client_review_id': 'independent-forged-ai-review', 'source_ai_decision_id': 999999})
    assert denied.status_code in {403, 404, 409}, denied.text
    context = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor).json()
    denied_question = client.post('/api/v1/care/clarifications', headers=doctor, json={
        'client_question_id': 'independent-forged-ai-question', 'patient_id': session['patient_id'], 'assessment_id': session['id'],
        'expected_assessment_version': context['assessment_version'], 'input_digest': context['input_digest'],
        'review_context': context['review_context'], 'source_type': 'submission', 'source_key': context['submissions'][0]['submission_id'],
        'question': 'Unverified AI source must not authorize a question', 'source_ai_decision_id': 999999, 'confirmed': True})
    assert denied_question.status_code in {403, 404, 409}, denied_question.text
    published = client.post('/api/v1/care/review-publications', headers=doctor, json=publication_body(client, doctor, draft))
    assert published.status_code == 201, published.text
    context = client.get(f"/api/v1/care/assessments/{session['id']}/plan-context", headers=doctor).json()
    day = context['calendar_today']
    denied_plan = client.post('/api/v1/care/plan-versions', headers=doctor, json={
        **{key: context[key] for key in ('patient_id', 'assessment_id', 'expected_previous_version', 'expected_plan_revision',
                                        'source_report_id', 'input_digest', 'plan_context')},
        'expected_assessment_version': context['assessment_version'], 'client_plan_version_id': 'independent-forged-ai-plan',
        'title': 'Unverified source', 'instructions': 'A fake decision must not publish',
        'source_ai_decision_id': 999999, 'start_date': day, 'end_date': day, 'confirmed': True})
    assert denied_plan.status_code in {403, 404, 409}, denied_plan.text
    with SessionLocal() as db:
        assert [db.scalar(select(func.count()).select_from(model)) for model in (ReviewRecord, ReviewInputSnapshot)] == before
        for model in (ReviewClarification, CarePlan, PlanVersion, PlanTask):
            assert db.scalar(select(func.count()).select_from(model)) == 0
