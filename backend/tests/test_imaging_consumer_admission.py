"""Real saved synthetic inputs must not become admitted AI or composite evidence."""
import pytest
from sqlalchemy import text
from backend.tests.test_imaging_storage_upgrade import mock_result, make_legacy
from backend.tests.w02_helpers import register


@pytest.mark.parametrize('mode', ['missing', 'legacy', 'demo'])
def test_actual_ai_explanation_keeps_non_imaging_content_and_excludes_unadmitted_models(client, monkeypatch, mode):
    if mode == 'demo':
        _, headers, _, _ = mock_result(client)
    elif mode == 'legacy':
        _, headers = make_legacy(client)
    else:
        _, headers = register(client, 'imaging-consumer-missing@example.org')
    scale = client.post('/api/v1/patient/submit_scale', headers=headers, json={'scale_type': 'ASRS', 'answers': [1] * 18})
    assert scale.status_code == 201, scale.text
    if mode == 'missing':
        from backend.app.db.session import engine
        with engine.begin() as conn:
            for table in ('model_predictions', 'imaging_visualizations'):
                for field in ('record_schema_version', 'data_version', 'record_key_version', 'envelope_status', 'record_origin', 'storage_context'):
                    conn.execute(text(f'ALTER TABLE {table} DROP COLUMN {field}'))
    from backend.app.api.routes import ai
    original = ai.build_patient_snapshot
    observed = []
    def capture(*args):
        result = original(*args)
        observed.append(result)
        return result
    monkeypatch.setattr(ai, 'build_patient_snapshot', capture)
    response = client.post('/api/v1/ai/explain_report', headers=headers, json={})
    assert response.status_code == 200, response.text
    snapshot = observed[0]
    assert snapshot['latest_scale']['total_score'] == scale.json()['total_score']
    assert snapshot['latest_model_prediction'] is None
    assert snapshot['model_evidence_status'] == 'not_admitted'
    assert snapshot['imaging_history_status'] == {'missing': 'storage_upgrade_required', 'legacy': 'conversion_required', 'demo': 'ready'}[mode]
    assert 'synthetic-legacy.csv' not in response.text


def test_actual_saved_demo_cannot_become_a_multimodal_imaging_risk_score(client):
    _, _, pid, _ = mock_result(client)
    from backend.app.db.session import SessionLocal
    from backend.app.services.multimodal_analysis_service import MultimodalAnalysisService
    with SessionLocal() as db:
        assert MultimodalAnalysisService(db)._compute_imaging_score(pid) is None
