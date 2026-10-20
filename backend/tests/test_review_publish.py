"""W06 preparation: actual originals exist, but professional review is not connected yet."""
from backend.tests.test_responsibility_transfers import real_transfer_source
from backend.tests.test_submission_cognitive_evidence import cognitive_submission


def test_actual_responsible_doctor_reads_a_fixed_review_context_without_auto_accepting_evidence(client):
    owner, doctor, _, session, _, source = real_transfer_source(client)
    response = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor)
    assert response.status_code == 200, response.text
    review = response.json()
    assert review['assessment_id'] == session['id'] and review['patient_id'] == session['patient_id']
    assert review['responsible_doctor_id'] == session['responsible_doctor_id']
    assert len(review['input_digest']) == 64 and review['review_context']
    assert any(row['quality_status'] == 'limited' for row in review['submissions'])
    assert all(row['acceptance_status'] == 'pending_review' for row in review['submissions'])
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    assert all(item['acceptance_status'] == 'pending_review' for item in current['items'])


def test_new_review_context_is_only_for_actual_original_doctor_not_owner_or_an_accepted_contact(client):
    owner, doctor, incoming, session, _, _ = real_transfer_source(client)
    route = f"/api/v1/care/assessments/{session['id']}/review-context"
    assert client.get(route, headers=owner).status_code == 403
    assert client.get(route, headers=incoming).status_code == 403
    assert client.get(route, headers=doctor).status_code == 200


def test_fixed_review_inputs_include_incomplete_attempts_and_change_when_a_new_actual_attempt_starts(client):
    owner, doctor, _, session, _, _ = real_transfer_source(client)
    route = f"/api/v1/care/assessments/{session['id']}/review-context"
    first = client.get(route, headers=doctor)
    assert first.status_code == 200, first.text
    old = first.json()
    assert any(attempt['execution_status'] == 'in_progress' for attempt in old['attempts'])
    assert len(old['items']) == len(session['items'])
    assert client.get(route, headers=doctor).json()['input_digest'] == old['input_digest']
    _, _, _, attempt, _ = cognitive_submission(client, 'nback', context=(owner, session, session['patient_id']))
    new = client.get(route, headers=doctor)
    assert new.status_code == 200, new.text
    assert new.json()['input_digest'] != old['input_digest']
    assert any(row['attempt_id'] == attempt['id'] for row in new.json()['attempts'])
    assert all(row['acceptance_status'] == 'pending_review' for row in new.json()['submissions'])
