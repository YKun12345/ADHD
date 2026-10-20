from backend.tests.test_review_drafts import context_and_body


def saved_draft(client):
    owner, doctor, incoming, session, current, body = context_and_body(client)
    response = client.post('/api/v1/care/reviews', headers=doctor, json=body)
    assert response.status_code == 201, response.text
    return owner, doctor, incoming, session, response.json(), body


def publication_body(client, doctor, draft):
    response = client.get(f"/api/v1/care/reviews/{draft['id']}/publication-context", headers=doctor)
    assert response.status_code == 200, response.text
    context = response.json()
    return {'client_publication_id': 'original-publication', 'patient_id': draft['patient_id'], 'assessment_id': draft['assessment_id'],
        'review_id': draft['id'], 'expected_assessment_version': context['expected_assessment_version'],
        'expected_previous_report_version': context['expected_previous_report_version'], 'input_digest': draft['input_digest'],
        'publication_context': context['publication_context'], 'confirmed': True}


def test_explicit_publication_creates_immutable_readable_version_but_preserves_original_submission_ack(client):
    owner, doctor, incoming, session, draft, _ = saved_draft(client)
    detail = client.get(f"/api/v1/care/reviews/{draft['id']}", headers=doctor).json()
    original_id = detail['input_snapshot']['submissions'][0]['submission_id']
    old_ack = client.get(f'/api/v1/care/submissions/{original_id}', headers=owner).json()
    payload = publication_body(client, doctor, draft)
    assert client.post('/api/v1/care/review-publications', headers=owner, json=payload).status_code == 403
    assert client.post('/api/v1/care/review-publications', headers=incoming, json=payload).status_code == 403
    saved = client.post('/api/v1/care/review-publications', headers=doctor, json=payload)
    assert saved.status_code == 201, saved.text
    report = saved.json()
    assert report['version'] == 1 and report['status'] == 'published'
    assert report['body'] == draft['body'] and report['limitations'] == draft['limitations']
    assert report['actor_user_id'] == draft['actor_user_id'] and report['input_digest'] == draft['input_digest']
    assert report['category'] == 'evidence_review' and report['demonstration_only'] is True
    assert client.post('/api/v1/care/review-publications', headers=doctor, json=payload).json() == report
    assert client.get('/api/v1/care/review-publications/submissions/original-publication', headers=doctor).json() == report
    own = client.get(f"/api/v1/care/reports/{report['id']}", headers=owner)
    assert own.status_code == 200, own.text
    assert own.json()['body'] == report['body']
    assert client.get(f"/api/v1/care/reports/{report['id']}", headers=incoming).status_code == 403
    assert client.get(f"/api/v1/care/assessments/{session['id']}/reports", headers=owner).json()['items'][0]['id'] == report['id']
    unchanged = client.get(f'/api/v1/care/submissions/{original_id}', headers=owner).json()
    assert unchanged['acceptance_status'] == old_ack['acceptance_status'] == 'pending_review'
    item_id = detail['input_snapshot']['submissions'][0]['assessment_item_id']
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    assert next(row for row in current['items'] if row['id'] == item_id)['acceptance_status'] == 'needs_repeat'
    assert current['status'] != 'reviewed'


def test_unpublished_competing_draft_cannot_reuse_a_changed_assessment_version(client):
    _, doctor, _, _, first, original = saved_draft(client)
    second = client.post('/api/v1/care/reviews', headers=doctor, json={**original, 'client_review_id': 'second-draft'})
    assert second.status_code == 201, second.text
    first_body = publication_body(client, doctor, first)
    second_body = {**publication_body(client, doctor, second.json()), 'client_publication_id': 'second-publication'}
    assert client.post('/api/v1/care/review-publications', headers=doctor, json=first_body).status_code == 201
    assert client.post('/api/v1/care/review-publications', headers=doctor, json=second_body).status_code == 409
    assert client.get('/api/v1/care/review-publications/submissions/second-publication', headers=doctor).status_code == 404
