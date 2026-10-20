"""A correction issued after completion must leave an actual user action."""
import pytest
from backend.tests.test_assessment_consumers import complete_assessment, drain
from backend.tests.test_assessment_sessions import start
from backend.tests.test_report_publications import publication_body


def _publish(client, doctor, session, label, *, repeat=False):
    ctx = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor).json()
    target = next(row for row in ctx['submissions'] if row['assessment_item_id'] == next(item['assessment_item_id'] for item in ctx['items'] if item['key'] == 'flanker'))
    saved = client.post('/api/v1/care/reviews', headers=doctor, json={
        'client_review_id': label, 'patient_id': session['patient_id'], 'assessment_id': session['id'],
        'expected_assessment_version': ctx['assessment_version'], 'input_digest': ctx['input_digest'], 'review_context': ctx['review_context'],
        'category': 'evidence_review', 'body': '实际合成原件审核及后续核对。', 'limitations': '演示材料，不是诊断。', 'confirmed': True,
        'decisions': [{'submission_id': row['submission_id'], 'assessment_item_id': row['assessment_item_id'], 'attempt_id': row['attempt_id'],
            'decision': 'needs_repeat' if repeat and row['submission_id'] == target['submission_id'] else 'accepted',
            'reason': '核对实际执行环境。' if repeat and row['submission_id'] == target['submission_id'] else '已核对实际有效原件。'} for row in ctx['submissions']]})
    assert saved.status_code == 201, saved.text
    publication = publication_body(client, doctor, saved.json())
    publication['client_publication_id'] = label + '-publication'
    result = client.post('/api/v1/care/review-publications', headers=doctor, json=publication)
    assert result.status_code == 201, result.text
    return result.json(), target


@pytest.mark.parametrize('kind', ['clarification', 'repeat'])
def test_actual_doctor_followup_reopens_completed_round_without_rewriting_old_report(client, kind):
    owner, doctor, session, pid = complete_assessment(client, doctor=True); drain()
    original, target = _publish(client, doctor, session, 'completed-before-followup')
    assert original['assessment_status'] == 'reviewed'
    if kind == 'clarification':
        ctx = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor).json()
        question = client.post('/api/v1/care/clarifications', headers=doctor, json={
            'client_question_id': 'followup-after-completion', 'patient_id': pid, 'assessment_id': session['id'],
            'expected_assessment_version': ctx['assessment_version'], 'input_digest': ctx['input_digest'], 'review_context': ctx['review_context'],
            'source_type': 'submission', 'source_key': target['submission_id'], 'question': '请补充本次执行时的实际环境。', 'confirmed': True})
        assert question.status_code == 201, question.text
        preflight = client.get(f"/api/v1/care/clarifications/{question.json()['id']}/reply-context", headers=owner)
        assert preflight.status_code == 200, preflight.text
        value = preflight.json()
        reply = client.post('/api/v1/care/clarification-replies', headers=owner, json={
            'client_reply_id': 'real-followup-answer', 'patient_id': pid, 'assessment_id': session['id'], 'question_id': question.json()['id'],
            'expected_assessment_version': value['assessment_version'], 'expected_previous_revision': 0, 'reply_context': value['reply_context'],
            'answer_status': 'unknown', 'answer': None, 'confirmed': True})
        assert reply.status_code == 201, reply.text
    else:
        updated, _ = _publish(client, doctor, session, 'explicit-repeat-after-completion', repeat=True)
        current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
        item = next(row for row in current['items'] if row['id'] == target['assessment_item_id'])
        actual = start(client, owner, item, pid, repeat_report_id=updated['id'])
        assert actual.status_code == 201, actual.text
        assert actual.json()['id'] != target['attempt_id']
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    assert current['status'] == 'under_review'
    assert client.get(f"/api/v1/care/reports/{original['id']}", headers=owner).json()['decisions'] == original['decisions']
