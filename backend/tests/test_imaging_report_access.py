"""Existing report reading preserves unknowns, current imaging scope and audit."""
from backend.tests.test_model_upload import patient_identity


def test_existing_model_report_never_invents_missing_control_confidence_or_review(client):
    headers, pid = patient_identity(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.model_prediction import ModelPrediction
    with SessionLocal() as db:
        row = ModelPrediction(patient_id=pid, file_name='synthetic-history.csv', prediction_label='Control', probability=.2,
            probability_control=None, source_type='fmri_hgst', model_name='Synthetic legacy', summary_text='Synthetic historical content.')
        db.add(row); db.commit(); identifier = row.id
    report = client.get('/api/v1/patient/comprehensive_report', headers=headers)
    assert report.status_code == 200, report.text
    saved = report.json()['latest_model_prediction']
    assert saved['prediction_id'] == identifier
    assert saved['probability_control'] is None
    assert saved['source_admission_status'] == 'not_recorded'
    assert saved['professional_review_status'] == 'not_recorded'
    assert saved['version_status'] == 'legacy_unversioned'


def test_saved_visualization_is_readable_without_claiming_immutable_version_or_professional_acceptance(client):
    headers, pid = patient_identity(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.imaging_visualization import ImagingVisualization
    profile = client.get('/api/v1/auth/me', headers=headers).json()
    with SessionLocal() as db:
        row = ImagingVisualization(patient_id=pid, researcher_id=profile['id'], visualization_type='nifti',
            summary_text='实际保存的合成影像正文。', notes='合成补充说明。', slice_interpretation='合成切片解释。')
        db.add(row); db.commit(); identifier = row.id
    response = client.get('/api/v1/patient/comprehensive_report', headers=headers)
    assert response.status_code == 200, response.text
    saved = response.json()['latest_imaging_visualization']
    assert saved['id'] == identifier and saved['summary_text'] == '实际保存的合成影像正文。'
    assert saved['professional_review_status'] == 'not_recorded'
    assert saved['version_status'] == 'legacy_mutable_record'


def doctor_history(client, scope):
    from backend.tests.w02_helpers import register, qualify
    owner, owner_headers = register(client, 'imaging-history-owner@example.org')
    doctor, headers = register(client, 'imaging-history-doctor@example.org', 'researcher')
    qualify(doctor['user']['id'])
    invited = client.post('/api/v1/care/relationships/invitations', headers=headers,
        json={'target_email': owner['user']['email'], 'purpose': 'clinical_sharing', 'scope': scope})
    assert invited.status_code == 201, invited.text
    accepted = client.post(f"/api/v1/care/relationships/{invited.json()['id']}/accept", headers=owner_headers,
        json={'expected_revision': invited.json()['revision']})
    assert accepted.status_code == 200, accepted.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.imaging_visualization import ImagingVisualization
    from backend.app.models.model_prediction import ModelPrediction
    pid = owner['user']['patient_profile']['id']
    with SessionLocal() as db:
        db.add(ImagingVisualization(patient_id=pid, researcher_id=doctor['user']['id'], visualization_type='nifti',
            summary_text='只在当前影像共享下读取的合成正文。'))
        db.add(ModelPrediction(patient_id=pid, file_name='synthetic.csv', prediction_label='Control', probability=.2,
            source_type='fmri_hgst', summary_text='合成已有原模型记录。'))
        db.commit()
    return owner_headers, headers, pid, accepted.json()


def test_current_imaging_grant_reads_history_after_basic_withdrawal_but_current_clinical_revocation_denies(client):
    owner, doctor, pid, relationship = doctor_history(client, ['profile', 'imaging'])
    route = f'/api/v1/doctor/patient/{pid}/report'
    report = client.get(route, headers=doctor)
    assert report.status_code == 200, report.text
    assert report.json()['latest_imaging_visualization']['summary_text'] == '只在当前影像共享下读取的合成正文。'
    from backend.tests.test_w05_remainder_spec import withdraw_basic
    withdraw_basic(client, owner)
    historical = client.get(route, headers=doctor)
    assert historical.status_code == 200, historical.text
    assert historical.json()['latest_model_prediction']['professional_review_status'] == 'not_recorded'
    revoked = client.post(f"/api/v1/care/relationships/{relationship['id']}/revoke", headers=owner,
        json={'expected_revision': relationship['revision']})
    assert revoked.status_code == 200, revoked.text
    assert client.get(route, headers=doctor).status_code == 403
    assert client.get('/api/v1/patient/comprehensive_report', headers=owner).json()['latest_model_prediction']['probability_control'] is None


def test_unshared_imaging_is_absent(client):
    _, doctor, pid, _ = doctor_history(client, ['profile'])
    route = f'/api/v1/doctor/patient/{pid}/report'
    report = client.get(route, headers=doctor)
    assert report.status_code == 200, report.text
    assert report.json()['latest_imaging_visualization'] is None and report.json()['latest_model_prediction'] is None


def test_audit_failure_cannot_disclose_authorized_existing_image_body(client, monkeypatch):
    _, doctor, pid, _ = doctor_history(client, ['profile', 'imaging'])
    route = f'/api/v1/doctor/patient/{pid}/report'
    report = client.get(route, headers=doctor)
    assert report.status_code == 200, report.text
    assert report.json()['latest_imaging_visualization']['summary_text'] == '只在当前影像共享下读取的合成正文。'
    from backend.app.services import access_audit
    monkeypatch.setattr(access_audit, 'record_access', lambda *args: (_ for _ in ()).throw(RuntimeError('synthetic audit failure')))
    denied = client.get(route, headers=doctor)
    assert denied.status_code == 503
    assert '合成正文' not in denied.text and 'latest_model_prediction' not in denied.text
