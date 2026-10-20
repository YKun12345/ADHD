"""Owner-requested old-weight compatibility; synthetic inputs and temporary DB only."""
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
OLD_SHA = '74575afa48ef423461ca463f8c57cc2f1b767c3cf320c94367c00e02aba7f95a'


def test_original_weight_is_accepted_without_inventing_training_evidence(monkeypatch):
    from backend.app.core.config import settings
    from backend.app.services.model_admission_service import inspect_hgst_admission
    monkeypatch.setattr(settings, 'MODEL_REGISTRY_ENABLED', False)
    monkeypatch.setattr(settings, 'HGST_DEPLOYMENT_BUNDLE_PATH', str(ROOT / 'backend/models/hgst_adhd_bundle.pt'))
    status = inspect_hgst_admission()
    assert status['real_inference_allowed'] is True
    assert status['status'] == 'legacy_accepted'
    assert status['artifact']['sha256'] == OLD_SHA
    assert status['weights_provenance_status'] == status['training_data_provenance_status'] == 'unverified'
    assert status['input_contract_status'] == 'unverified'
    assert status['weights_loaded'] is False


def test_compatibility_can_be_disabled_and_does_not_accept_another_file(monkeypatch, tmp_path):
    from backend.app.core.config import settings
    from backend.app.services.model_admission_service import inspect_hgst_admission
    monkeypatch.setattr(settings, 'HGST_LEGACY_COMPATIBILITY_ENABLED', False)
    assert inspect_hgst_admission()['real_inference_allowed'] is False
    monkeypatch.setattr(settings, 'HGST_LEGACY_COMPATIBILITY_ENABLED', True)
    other = tmp_path / 'hgst_adhd_bundle.pt'
    other.write_bytes(b'not-the-original-weight')
    status = inspect_hgst_admission(other)
    assert status['real_inference_allowed'] is False
    assert status['status'] == 'unverified'


def test_enabled_but_unavailable_registry_does_not_fall_back_to_old_weight(client, monkeypatch):
    from backend.app.core.config import settings
    from backend.app.services.model_admission_service import inspect_hgst_admission
    monkeypatch.setattr(settings, 'MODEL_REGISTRY_ENABLED', True)
    status = inspect_hgst_admission()
    assert status['real_inference_allowed'] is False
    assert status['registry_status'] == 'unavailable'


def test_actual_original_weight_http_inference_is_saved_and_read_with_legacy_status(client, monkeypatch):
    import hashlib
    import numpy as np
    from backend.app.core.config import settings
    from backend.tests.test_model_upload import patient_identity, prediction_rows
    from backend.tests.w02_helpers import register
    headers, pid = patient_identity(client)
    monkeypatch.setattr(settings, 'USE_MOCK_MODEL', 'real')
    monkeypatch.setattr(settings, 'MODEL_REGISTRY_ENABLED', False)
    monkeypatch.setattr(settings, 'UPLOAD_MAX_BYTES', 1024 * 1024)
    path = ROOT / 'backend/models/hgst_adhd_bundle.pt'
    monkeypatch.setattr(settings, 'HGST_DEPLOYMENT_BUNDLE_PATH', str(path))
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    rng = np.random.default_rng(18102026)
    raw = '\n'.join(','.join(f'{x:.6f}' for x in row) for row in rng.normal(size=(32, 90))).encode()
    response = client.post(f'/api/v1/model/predict_fmri?patient_id={pid}', headers=headers,
                           files={'timeseries_file': ('synthetic-only.csv', raw, 'text/csv')})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['is_demo'] is False and result['source_type'] == 'fmri_hgst'
    assert result['source_admission_status'] == 'legacy_accepted'
    assert result['roi_dim_used'] == 90 and result['timepoints'] == 32
    assert 0 <= result['probability'] <= 1
    assert result['probability'] + result['probability_control'] == pytest.approx(1, abs=1e-6)
    assert result['storage_context']['input']['model_artifact_sha256'] == OLD_SHA
    assert result['storage_context']['input']['model_input_contract_status'] == 'unverified'
    assert '旧权重' in result['summary_text']
    history = client.get('/api/v1/patient/comprehensive_report', headers=headers)
    assert history.status_code == 200, history.text
    saved = history.json()['latest_model_prediction']
    assert saved['prediction_id'] == result['prediction_id']
    assert saved['source_admission_status'] == 'legacy_accepted'
    versions = client.get(f'/api/v1/care/imaging-reports?patient_id={pid}', headers=headers)
    assert versions.status_code == 200, versions.text
    assert versions.json()['items'][0]['source']['source_admission_status'] == 'legacy_accepted'
    assert '未重新核验' in versions.json()['items'][0]['limitations']
    _, outsider = register(client, 'legacy-outsider@example.org')
    denied = client.post(f'/api/v1/model/predict_fmri?patient_id={pid}', headers=outsider,
                         files={'timeseries_file': ('synthetic-only.csv', raw, 'text/csv')})
    assert denied.status_code == 403, denied.text
    assert len(prediction_rows()) == 1
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before == OLD_SHA
