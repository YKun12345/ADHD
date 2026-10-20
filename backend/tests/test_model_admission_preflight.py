"""P0 admission: synthetic stores and bytes only, never deserialize any model."""
import pytest


def test_unadmitted_prediction_is_rejected_before_dependency_import_or_model_load(monkeypatch, tmp_path):
    from backend.app.core.config import settings
    from backend.app.services.hgst_runtime import service
    artifact = tmp_path / 'unverified-synthetic.pt'; artifact.write_bytes(b'not-a-model-synthetic-bytes')
    monkeypatch.setattr(settings, 'HGST_DEPLOYMENT_BUNDLE_PATH', str(artifact))
    def forbidden():
        pytest.fail('Model runtime was touched before admission, even though provenance is unverified')
    monkeypatch.setattr(service, '_import_runtime_dependencies', forbidden)
    with pytest.raises(service.HGSTModelNotAdmittedError, match='准入'):
        service.predict_timeseries_file(b'not-read-before-admission', 'synthetic.csv')
    with pytest.raises(service.HGSTModelNotAdmittedError, match='准入'):
        service.load_hgst_bundle()


def test_auto_mode_must_not_convert_admission_rejection_to_mock(monkeypatch, tmp_path):
    from backend.app.core.config import settings
    from backend.app.services.hgst_runtime import service
    monkeypatch.setattr(settings, 'USE_MOCK_MODEL', 'auto')
    monkeypatch.setattr(settings, 'HGST_DEPLOYMENT_BUNDLE_PATH', str(tmp_path / 'missing-synthetic.pt'))
    with pytest.raises(service.HGSTModelNotAdmittedError, match='准入'):
        service.predict_with_mode(b'not-read-before-admission', 'synthetic.csv')


def test_actual_admission_status_binds_current_bytes_and_never_accepts_app_env_or_filename(client, monkeypatch, tmp_path):
    from backend.tests.test_model_upload import patient_identity
    from backend.app.core.config import settings
    from hashlib import sha256
    headers, _ = patient_identity(client)
    artifact = tmp_path / 'approved-clinical.pt'; artifact.write_bytes(b'synthetic-first')
    monkeypatch.setattr(settings, 'HGST_DEPLOYMENT_BUNDLE_PATH', str(artifact))
    for environment in ['test', 'production']:
        monkeypatch.setattr(settings, 'APP_ENV', environment)
        response = client.get('/api/v1/model/admission', headers=headers)
        assert response.status_code == 200, response.text
        status = response.json()
        assert status['status'] == 'unverified' and status['real_inference_allowed'] is False
        assert status['artifact']['sha256'] == sha256(artifact.read_bytes()).hexdigest()
        assert status['registry_status'] == 'not_configured'
        assert status['input_contract_status'] == 'unverified'
        assert str(tmp_path) not in response.text
    artifact.write_bytes(b'synthetic-second')
    changed = client.get('/api/v1/model/admission', headers=headers)
    assert changed.json()['artifact']['sha256'] != status['artifact']['sha256']
    assert changed.json()['real_inference_allowed'] is False
    assert client.get('/api/v1/model/admission').status_code == 401


def test_real_upload_returns_explicit_admission_failure_without_any_prediction(client, monkeypatch, tmp_path):
    from backend.tests.test_model_upload import patient_identity, prediction_rows, upload_rows
    from backend.app.core.config import settings
    from backend.app.services.hgst_runtime import service
    headers, pid = patient_identity(client)
    monkeypatch.setattr(settings, 'USE_MOCK_MODEL', 'real')
    monkeypatch.setattr(settings, 'HGST_DEPLOYMENT_BUNDLE_PATH', str(tmp_path / 'synthetic.pt'))
    monkeypatch.setattr(service, '_import_runtime_dependencies', lambda: pytest.fail('Unadmitted HTTP request imported real runtime'))
    response = client.post(f'/api/v1/model/predict_fmri?patient_id={pid}', headers=headers,
        files={'timeseries_file': ('synthetic.csv', b'1,2,3\n4,5,6', 'text/csv')})
    assert response.status_code == 503, response.text
    assert '准入' in response.json()['detail']
    assert prediction_rows() == []
    assert len(upload_rows()) == 1 and upload_rows()[0].status == 'failed'
    assert '准入' in upload_rows()[0].note


def test_explicit_demo_still_runs_without_model_loading_and_stays_labelled(monkeypatch):
    from backend.tests.test_model_modes import _sample_1d_bytes
    from backend.app.core.config import settings
    from backend.app.services.hgst_runtime import service
    monkeypatch.setattr(settings, 'USE_MOCK_MODEL', 'mock')
    monkeypatch.setattr(service, '_import_runtime_dependencies', lambda: pytest.fail('Explicit demo loaded a real runtime'))
    result = service.predict_with_mode(_sample_1d_bytes(), 'synthetic.1D')
    assert result.source_type == 'mock' and result.model_name == 'DemoMock'
    assert '演示' in result.summary_text and '不构成医学诊断' in result.summary_text


def test_current_admission_denial_preserves_lawful_existing_history_and_does_not_relabel_it(client, monkeypatch, tmp_path):
    from backend.tests.test_model_upload import patient_identity
    from backend.app.core.config import settings
    from backend.app.db.session import SessionLocal
    from backend.app.models.model_prediction import ModelPrediction
    headers, pid = patient_identity(client)
    with SessionLocal() as db:
        record = ModelPrediction(patient_id=pid, file_name='synthetic-legacy.csv', prediction_label='Control',
            probability=.2, probability_control=.8, source_type='fmri_hgst', model_name='Synthetic historical fixture',
            model_version='synthetic-history', summary_text='Synthetic pre-existing result; no model was run.')
        db.add(record); db.commit(); identifier = record.id
    monkeypatch.setattr(settings, 'HGST_DEPLOYMENT_BUNDLE_PATH', str(tmp_path / 'missing-synthetic.pt'))
    assert client.get('/api/v1/model/admission', headers=headers).json()['real_inference_allowed'] is False
    historical = client.get('/api/v1/patient/comprehensive_report', headers=headers)
    assert historical.status_code == 200, historical.text
    saved = historical.json()['latest_model_prediction']
    assert saved['prediction_id'] == identifier and saved['model_version'] == 'synthetic-history'
    assert saved['source_type'] == 'fmri_hgst' and saved['is_demo'] is False
    assert 'no model was run' in saved['summary_text']
    # Existing history does not grant a new request permission, or lose its old label.
    from backend.tests.test_model_upload import prediction_rows
    assert len(prediction_rows()) == 1
