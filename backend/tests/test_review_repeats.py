"""One actual complete-round workflow exercises the required repeat boundary."""
from backend.tests.test_assessment_consumers import complete_assessment, drain
from backend.tests.test_assessment_sessions import start
from backend.tests.test_report_publications import publication_body
from backend.tests.test_submission_cognitive_evidence import cognitive_submission


def test_published_repeat_starts_only_its_new_bound_attempt_and_old_valid_cannot_satisfy_it(client):
    owner, doctor, session, pid = complete_assessment(client, doctor=True)
    drain()
    ctx = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor).json()
    target_item = next(row for row in ctx['items'] if row['key'] == 'flanker')
    target = next(row for row in ctx['submissions'] if row['assessment_item_id'] == target_item['assessment_item_id'])
    draft_body = {'client_review_id': 'repeat-review', 'patient_id': pid, 'assessment_id': session['id'],
        'expected_assessment_version': ctx['assessment_version'], 'input_digest': ctx['input_digest'],
        'review_context': ctx['review_context'], 'category': 'evidence_review', 'body': '实际核对本轮全部原件，指定一项重测。',
        'limitations': '演示资料，仅材料审核。', 'confirmed': True,
        'decisions': [{'submission_id': row['submission_id'], 'assessment_item_id': row['assessment_item_id'], 'attempt_id': row['attempt_id'],
            'decision': 'needs_repeat' if row['submission_id'] == target['submission_id'] else 'accepted',
            'reason': '执行环境需再次核对。' if row['submission_id'] == target['submission_id'] else '已核对实际原件。'} for row in ctx['submissions']]}
    draft = client.post('/api/v1/care/reviews', headers=doctor, json=draft_body)
    assert draft.status_code == 201, draft.text
    published = client.post('/api/v1/care/review-publications', headers=doctor, json=publication_body(client, doctor, draft.json()))
    assert published.status_code == 201, published.text
    report = published.json()
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    item = next(row for row in current['items'] if row['id'] == target['assessment_item_id'])
    assert item.get('repeat_request', {}).get('report_id') == report['id'], item
    assert item['repeat_request']['reason'] == '执行环境需再次核对。'
    assert 'create_attempt' in item['allowed_actions']
    other = next(row for row in current['items'] if row['id'] != item['id'])
    assert not other['allowed_actions']
    assert start(client, owner, other, pid, repeat_report_id=report['id']).status_code == 409
    assert start(client, owner, item, pid).status_code == 409
    assert start(client, owner, item, pid, repeat_report_id=report['id'] + 100).status_code == 409
    from backend.app.db.session import SessionLocal
    from backend.app.models.assessment import AssessmentSession
    from backend.app.services.submission_service import valid_evidence_manifest
    with SessionLocal() as db:
        assert valid_evidence_manifest(db, db.get(AssessmentSession, session['id'])) is None
    started = start(client, owner, item, pid, repeat_report_id=report['id'])
    assert started.status_code == 201, started.text
    attempt = started.json()
    assert attempt['id'] != target['attempt_id'] and attempt['run_id'] != target['run_id']
    assert attempt['metadata']['repeat_request']['source_attempt_id'] == target['attempt_id']
    assert attempt['metadata']['repeat_request']['report_id'] == report['id']
    fresh = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    repeated = next(row for row in fresh['items'] if row['id'] == item['id'])
    assert not repeated['allowed_actions']
    assert repeated['repeat_request']['continuing_attempt_id'] == attempt['id']
    assert start(client, owner, repeated, pid, repeat_report_id=report['id']).status_code == 409
    # Reuse the real frozen trial generator with the actual new run.
    import json, subprocess
    from pathlib import Path
    completed = subprocess.run(['node', str(Path(__file__).with_name('w04_cognitive_fixture.cjs'))],
        input=json.dumps({'config': item['config'], 'run_id': attempt['run_id']}), capture_output=True, text=True, encoding='utf-8', check=True)
    evidence = json.loads(completed.stdout)
    metadata = {key: attempt['metadata'][key] for key in ('device', 'input', 'timing', 'practice', 'assistance')}
    metadata['practice'] = {'completed': True, 'attempts': 1, 'exposure_count': 0}
    metadata.update(interrupted_count=0, practice_records=evidence['practice_records'])
    body = {'submission_id': 'actual-repeat-' + attempt['run_id'], 'kind': 'cognitive', 'patient_id': pid,
        'assessment_id': session['id'], 'assessment_item_id': item['id'], 'attempt_id': attempt['id'], 'run_id': attempt['run_id'],
        'task_id': item['patient_task_id'], **{key: attempt[key] for key in ('protocol_id', 'protocol_schema_version', 'config_digest',
        'template_digest', 'actor_user_id', 'performer_kind', 'performer_user_id', 'performer_patient_id', 'respondent_user_id',
        'respondent_kind', 'submitter_user_id')}, 'content': {**evidence['payload'], 'execution_metadata': metadata}}
    saved = client.post('/api/v1/care/submissions', headers=owner, json=body)
    assert saved.status_code == 201, saved.text
    assert saved.json()['quality_status'] == 'valid' and saved.json()['assessment_status'] == 'evidence_ready'
    old = client.get(f"/api/v1/care/submissions/{target['submission_id']}", headers=owner)
    assert old.status_code == 200 and old.json()['quality_status'] == 'valid' and old.json()['acceptance_status'] == 'pending_review'
    drain()
    assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()['status'] == 'under_review'
    original = client.get(f"/api/v1/care/reports/{report['id']}", headers=owner).json()
    assert len(original['input_snapshot']['attempts']) == len(ctx['attempts'])
