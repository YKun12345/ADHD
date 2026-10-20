"""Independent W09 spec probes. All writes are confined by conftest to synthetic temp stores."""
import hashlib
import json

import pytest
from sqlalchemy import select, text

from backend.tests.w02_helpers import register, qualify


def _patient(client, email):
    account, headers = register(client, email)
    return account, headers, account['user']['patient_profile']['id']


def _doctor_route(client):
    account, owner, pid = _patient(client, 'independent-w09-image-owner@example.org')
    doctor, headers = register(client, 'independent-w09-image-doctor@example.org', 'researcher')
    qualify(doctor['user']['id'])
    invitation = client.post('/api/v1/care/relationships/invitations', headers=headers,
        json={'target_email': account['user']['email'], 'purpose': 'clinical_sharing',
              'scope': ['profile', 'assessment', 'tracking', 'imaging']})
    assert invitation.status_code == 201, invitation.text
    accepted = client.post(f"/api/v1/care/relationships/{invitation.json()['id']}/accept", headers=owner,
        json={'expected_revision': invitation.json()['revision']})
    assert accepted.status_code == 200, accepted.text
    return account, owner, doctor, headers, f'/api/v1/doctor/patient/{pid}/imaging_visualization'


def _raw(table, identifier):
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        return dict(db.execute(text(f'SELECT * FROM {table} WHERE id=:id'), {'id': identifier}).mappings().one())


def _replace(table, identifier, values):
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        assignments = ','.join(f'{name}=:{name}' for name in values)
        db.execute(text(f'UPDATE {table} SET {assignments} WHERE id=:identifier'), {**values, 'identifier': identifier})
        db.commit()


def test_same_patient_other_row_field_and_context_substitution_are_denied(client):
    _, headers, pid = _patient(client, 'independent-w09-row-owner@example.org')
    saved = []
    for name in ['independent-first.csv', 'independent-latest.csv']:
        response = client.post(f'/api/v1/model/predict_mock?patient_id={pid}&file_name={name}', headers=headers)
        assert response.status_code == 200, response.text
        saved.append(response.json())
    first = _raw('model_predictions', saved[0]['prediction_id'])
    latest = _raw('model_predictions', saved[1]['prediction_id'])
    attacks = [
        {'summary_text': first['summary_text']},
        {'file_name': latest['prediction_label']},
        {'storage_context': first['storage_context']},
        {'record_key_version': 2},
        {'record_schema_version': 1, 'envelope_status': 'legacy', 'record_origin': None},
    ]
    for values in attacks:
        _replace('model_predictions', latest['id'], values)
        denied = client.get('/api/v1/patient/comprehensive_report', headers=headers)
        assert denied.status_code == 503, (values.keys(), denied.text)
        assert 'independent-latest.csv' not in denied.text
        _replace('model_predictions', latest['id'], {field: latest[field] for field in values})
    assert client.get('/api/v1/patient/comprehensive_report', headers=headers).status_code == 200
    print('independent_model_substitutions_denied=5')


def test_image_field_substitution_and_all_nullable_cipher_erasures_are_denied(client):
    _, owner, _, headers, route = _doctor_route(client)
    response = client.post(route, headers=headers, json={'visualization_type': 'nifti',
        'func_file_name': 'independent-source.nii', 'notes': 'independent-private-note'})
    assert response.status_code == 201, response.text
    original = _raw('imaging_visualizations', response.json()['id'])
    from backend.app.models.imaging_visualization import ImagingVisualization
    nullable = [field for field in ImagingVisualization.record_fields if ImagingVisualization.__table__.c[field].nullable]
    attacks = [{'notes': original['func_file_name']}, *[{field: None} for field in nullable]]
    for values in attacks:
        _replace('imaging_visualizations', original['id'], values)
        denied = client.get('/api/v1/patient/comprehensive_report', headers=owner)
        assert denied.status_code == 503, (values.keys(), denied.text)
        assert 'independent-private-note' not in denied.text
        _replace('imaging_visualizations', original['id'], {field: original[field] for field in values})
    assert client.get('/api/v1/patient/comprehensive_report', headers=owner).status_code == 200
    print(f'independent_image_field_and_null_attacks_denied={len(attacks)}')


def test_actual_upload_context_matches_bytes_current_metadata_and_critical_audit(client, monkeypatch):
    account, headers, pid = _patient(client, 'independent-w09-upload-owner@example.org')
    from backend.app.core.config import settings
    from backend.app.services.hgst_runtime import service as runtime
    monkeypatch.setattr(settings, 'USE_MOCK_MODEL', 'mock')
    monkeypatch.setattr(settings, 'UPLOAD_MAX_BYTES', 32768)
    monkeypatch.setattr(runtime, '_import_runtime_dependencies', lambda: pytest.fail('An explicit demo must not load model dependencies'))
    payload = ('\n'.join(','.join(str((row + col) % 11) for col in range(90)) for row in range(12))).encode()
    response = client.post(f'/api/v1/model/predict_fmri?patient_id={pid}', headers=headers,
        files={'timeseries_file': ('independent-upload.csv', payload, 'text/csv')})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['is_demo'] is True and result['source_admission_status'] == 'demonstration_only'
    from backend.app.db.session import SessionLocal
    from backend.app.models.model_prediction import ModelPrediction
    from backend.app.models.imaging_storage import canonical_metadata
    from backend.app.models.security import SecurityAuditLog
    from backend.app.models.upload import Upload
    from backend.app.services.upload_storage import read_stored_upload
    from pathlib import Path
    with SessionLocal() as db:
        saved = db.get(ModelPrediction, result['prediction_id'])
        context = saved.storage_context
        assert context['actor_user_id'] == account['user']['id'] and context['saved_at']
        assert context['authority_receipts']
        assert context['input']['sha256'] == hashlib.sha256(payload).hexdigest()
        assert context['input']['size_bytes'] == len(payload)
        assert context['input']['upload_id'] == saved.upload_id
        assert context['metadata'] == canonical_metadata(saved)
        actual = {field: getattr(saved, field) for field in saved.record_fields if field != 'storage_context'}
        digest = hashlib.sha256(json.dumps(actual, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()
        assert context['saved_content_sha256'] == digest
        upload = db.get(Upload, saved.upload_id)
        assert upload.status == 'completed' and read_stored_upload(Path(upload.stored_path)) == payload
        log = db.scalar(select(SecurityAuditLog).where(SecurityAuditLog.action == 'model_prediction_saved'))
        assert log is not None and log.actor_user_id == account['user']['id']
        context_sha = hashlib.sha256(json.dumps(context, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        assert log.detail_json['storage_context_sha256'] == context_sha
        assert log.detail_json['object_id'] == saved.id and log.detail_json['data_version'] == saved.data_version


def test_actual_existing_non_demo_model_stays_readable_but_not_in_generation_context(client, monkeypatch):
    _, headers, pid = _patient(client, 'independent-w09-ai-owner@example.org')
    marker = 'INDEPENDENT-UNADMITTED-MODEL-MUST-NOT-GENERATE'
    from backend.app.db.session import SessionLocal
    from backend.app.models.model_prediction import ModelPrediction
    with SessionLocal() as db:
        db.add(ModelPrediction(patient_id=pid, file_name=marker + '.csv', prediction_label='ADHD',
            probability=.987654321, source_type='fmri_hgst', model_name=marker, summary_text=marker))
        db.commit()
    historical = client.get('/api/v1/patient/comprehensive_report', headers=headers)
    assert historical.status_code == 200 and marker in historical.text
    from backend.app.api.routes import ai
    from backend.app.services import ai_service
    observed = []
    original = ai.generate_report_explanation
    def capture(snapshot, focus):
        observed.append(snapshot)
        messages = ai_service._build_chat_messages(user_message='explain', conversation=[], context_scope='report', snapshot=snapshot)
        assert marker not in json.dumps(messages, ensure_ascii=False)
        assert '.987654321' not in json.dumps(messages, ensure_ascii=False)
        return original(snapshot, focus)
    monkeypatch.setattr(ai, 'generate_report_explanation', capture)
    response = client.post('/api/v1/ai/explain_report', headers=headers, json={})
    assert response.status_code == 200, response.text
    assert len(observed) == 1
    assert observed[0]['imaging_history_status'] == historical.json()['imaging_history_status'] == 'ready'
    assert observed[0]['latest_model_prediction'] is None and observed[0]['model_evidence_status'] == 'not_admitted'
    assert marker not in response.text


def test_complete_same_row_snapshot_replay_is_the_documented_single_store_limit(client):
    _, owner, _, headers, route = _doctor_route(client)
    first = client.post(route, headers=headers, json={'visualization_type': 'nifti', 'notes': 'independent-old-replay-note'})
    assert first.status_code == 201, first.text
    original = _raw('imaging_visualizations', first.json()['id'])
    second = client.post(route, headers=headers, json={'visualization_type': 'nifti', 'notes': 'independent-new-note'})
    assert second.status_code == 201, second.text
    assert second.json()['storage_integrity']['data_version'] > first.json()['storage_integrity']['data_version']
    # Explicit malicious SQL is confined to this test DB. All old ciphertext,
    # origin, metadata and data_version are replayed together.
    _replace('imaging_visualizations', original['id'], {k: v for k, v in original.items() if k != 'id'})
    replay = client.get('/api/v1/patient/comprehensive_report', headers=owner)
    assert replay.status_code == 200, replay.text
    assert replay.json()['latest_imaging_visualization']['notes'] == 'independent-old-replay-note'
    print('known_limit_complete_same_row_replay_is_not_detected_without_external_monotonic_anchor=true')


def test_converted_old_image_never_invents_a_historical_author(client, tmp_path):
    account, owner, doctor, _, _ = _doctor_route(client)
    from backend.app.db.session import engine
    from backend.app.core.data_encryption import encrypt_value
    from backend.app.db import imaging_migration as migration
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO imaging_visualizations(patient_id,researcher_id,visualization_type,summary_text,created_at) "
            "VALUES(:pid,:doctor,'nifti',:summary,'2026-01-01 00:00:00')"),
            {'pid': account['user']['patient_profile']['id'], 'doctor': doctor['user']['id'],
             'summary': encrypt_value('independent historical image', 'imaging_visualizations.summary_text')})
    prepared = migration.prepare_temporary_conversion(engine, tmp_path/'independent-reviewed-backups')
    migration.convert_reviewed_temporary_store(engine, reviewed_manifest=prepared['manifest'],
        backup_path=prepared['backup_path'], backup_sha256=prepared['backup_sha256'])
    response = client.get('/api/v1/patient/comprehensive_report', headers=owner)
    assert response.status_code == 200, response.text
    saved = response.json()['latest_imaging_visualization']
    assert saved['storage_context']['actor_user_id'] is None and 'saved_at' not in saved['storage_context']
    assert saved['storage_context']['metadata']['researcher_id'] == doctor['user']['id']
    assert saved['storage_context']['source_binding_retroactively_proven'] is False
    assert saved['storage_integrity']['status'] == 'migrated_from_legacy'

