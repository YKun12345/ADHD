"""Synthetic W09 storage, fault and compatibility regressions."""
import json
import pytest
from sqlalchemy import text, select
from backend.tests.w02_helpers import register, qualify


def mock_result(client):
    account, headers = register(client, 'storage-owner@example.org')
    pid = account['user']['patient_profile']['id']
    response = client.post(f'/api/v1/model/predict_mock?patient_id={pid}', headers=headers)
    assert response.status_code == 200, response.text
    return account, headers, pid, response.json()


def shared_doctor(client):
    account, owner = register(client, 'storage-image-owner@example.org')
    doctor, headers = register(client, 'storage-image-doctor@example.org', 'researcher')
    qualify(doctor['user']['id'])
    invited = client.post('/api/v1/care/relationships/invitations', headers=headers,
        json={'target_email': account['user']['email'], 'purpose':'clinical_sharing', 'scope':['profile','assessment','tracking','imaging']}).json()
    accepted = client.post(f"/api/v1/care/relationships/{invited['id']}/accept",headers=owner,json={'expected_revision':invited['revision']})
    assert accepted.status_code == 200, accepted.text
    return account, owner, doctor, headers, f"/api/v1/doctor/patient/{account['user']['patient_profile']['id']}/imaging_visualization"


def raw_row(table, identifier):
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        return dict(db.execute(text(f'SELECT * FROM {table} WHERE id=:id'),{'id':identifier}).mappings().one())


@pytest.mark.parametrize('field,value',[('source_type','fmri_hgst'),('model_version','forged'),('created_at','2000-01-01 00:00:00'),('data_version',2),('envelope_status','legacy')])
def test_bound_model_metadata_and_downgrade_tampering_is_rejected(client,field,value):
    _, headers, _, saved = mock_result(client)
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        db.execute(text(f'UPDATE model_predictions SET {field}=:value WHERE id=:id'),{'value':value,'id':saved['prediction_id']}); db.commit()
    response = client.get('/api/v1/patient/comprehensive_report',headers=headers)
    assert response.status_code in {409,503}, response.text
    assert 'Demonstration inference' not in response.text


def test_saved_prediction_is_append_only_including_delete(client):
    _, _, _, saved = mock_result(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.model_prediction import ModelPrediction
    for mutation in ('file_name','source_type','delete'):
        with SessionLocal() as db:
            row = db.get(ModelPrediction,saved['prediction_id'])
            if mutation == 'delete': db.delete(row)
            else: setattr(row,mutation,'forged')
            with pytest.raises(ValueError, match='immutable|append'):
                db.commit()
            db.rollback()
    assert raw_row('model_predictions',saved['prediction_id'])['file_name'].startswith('aesgcm:v2:')


def test_optional_encrypted_value_cannot_be_erased_to_unauthenticated_sql_null(client):
    _,headers,_,saved=mock_result(client)
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        db.execute(text('UPDATE model_predictions SET probability_control=NULL WHERE id=:id'),{'id':saved['prediction_id']}); db.commit()
    response=client.get('/api/v1/patient/comprehensive_report',headers=headers)
    assert response.status_code in {409,503},response.text


def test_new_created_time_matches_existing_mysql_datetime_second_precision(client):
    _,headers,_,saved=mock_result(client)
    from datetime import datetime
    row=raw_row('model_predictions',saved['prediction_id'])
    assert datetime.fromisoformat(row['created_at']).microsecond == 0
    assert client.get('/api/v1/patient/comprehensive_report',headers=headers).status_code == 200


def test_current_actor_context_is_required_for_mutating_authenticated_image(client):
    _,_,_,headers,route=shared_doctor(client)
    saved=client.post(route,headers=headers,json={'visualization_type':'nifti','notes':'original'})
    assert saved.status_code == 201,saved.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.imaging_visualization import ImagingVisualization
    with SessionLocal() as db:
        row=db.get(ImagingVisualization,saved.json()['id'])
        row.notes='unattributed change'
        with pytest.raises(ValueError,match='context|actor'):
            db.commit()
        db.rollback()


def test_image_update_preserves_inputs_and_rejects_old_cipher_version(client):
    account, owner, doctor, headers, route = shared_doctor(client)
    first = client.post(route,headers=headers,json={'visualization_type':'nifti','func_file_name':'synthetic-original.nii','notes':'first'} )
    assert first.status_code == 201, first.text
    before = raw_row('imaging_visualizations', first.json()['id'])
    second = client.post(route,headers=headers,json={'visualization_type':'nifti','notes':'second'})
    assert second.status_code == 201, second.text
    assert second.json()['func_file_name'] == 'synthetic-original.nii'
    assert 'synthetic-original.nii' in second.json()['summary_text']
    after = raw_row('imaging_visualizations',first.json()['id'])
    assert after['data_version'] == before['data_version'] + 1
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        db.execute(text('UPDATE imaging_visualizations SET notes=:cipher WHERE id=:id'),{'cipher':before['notes'],'id':first.json()['id']}); db.commit()
    response = client.get('/api/v1/patient/comprehensive_report',headers=owner)
    assert response.status_code in {409,503}, response.text
    assert 'first' not in response.text


def test_new_api_writes_authenticate_actual_actor_and_input_context(client):
    account, headers, pid, saved = mock_result(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.model_prediction import ModelPrediction
    with SessionLocal() as db:
        row = db.get(ModelPrediction,saved['prediction_id'])
        context = row.storage_context
        assert context['actor_user_id'] == account['user']['id']
        assert context['input']['kind'] == 'deterministic_demo'
        assert context['source_binding_retroactively_proven'] is None
        assert context['professional_review_status'] == 'not_recorded'
        assert len(context['saved_content_sha256']) == 64
    assert saved['storage_integrity']['status'] == 'bound'


def test_concurrent_image_edits_cannot_overwrite_a_newer_data_version(client):
    _,_,doctor,headers,route=shared_doctor(client)
    saved=client.post(route,headers=headers,json={'visualization_type':'nifti','notes':'initial'})
    assert saved.status_code == 201,saved.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.imaging_visualization import ImagingVisualization
    from backend.app.models.user import User
    from backend.app.services.imaging_storage_service import stamp_storage_context
    from sqlalchemy.orm.exc import StaleDataError
    with SessionLocal() as first,SessionLocal() as second:
        a=first.get(ImagingVisualization,saved.json()['id'])
        b=second.get(ImagingVisualization,saved.json()['id'])
        actor_a=first.get(User,doctor['user']['id']); actor_b=second.get(User,doctor['user']['id'])
        a.notes='first edit'
        stamp_storage_context(first,a,actor_a,input_context={'kind':'synthetic_concurrency_test'})
        first.commit()
        b.notes='stale edit'
        stamp_storage_context(second,b,actor_b,input_context={'kind':'synthetic_concurrency_test'})
        with pytest.raises(StaleDataError):
            second.commit()
        second.rollback()


@pytest.mark.parametrize('kind',['audit','commit'])
def test_critical_write_fault_does_not_save_model_or_image(client,monkeypatch,kind):
    account, _, _, headers, route = shared_doctor(client)
    from backend.app.services import imaging_storage_service as service
    if kind == 'audit': monkeypatch.setattr(service,'append_storage_audit',lambda *a,**k: (_ for _ in ()).throw(RuntimeError('synthetic audit fault')))
    else: monkeypatch.setattr(service,'commit_storage_transaction',lambda *a,**k: (_ for _ in ()).throw(RuntimeError('synthetic commit fault')))
    image = client.post(route,headers=headers,json={'visualization_type':'nifti','notes':'not saved'})
    assert image.status_code == 503, image.text
    prediction = client.post(f"/api/v1/model/predict_mock?patient_id={account['user']['patient_profile']['id']}",headers=headers)
    assert prediction.status_code == 503, prediction.text
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        assert db.execute(text('SELECT COUNT(*) FROM imaging_visualizations')).scalar_one() == 0
        assert db.execute(text('SELECT COUNT(*) FROM model_predictions')).scalar_one() == 0


@pytest.mark.parametrize('kind',['audit','commit'])
def test_uploaded_prediction_fault_rolls_back_upload_and_new_file(client,monkeypatch,kind):
    account,headers=register(client,'storage-upload-fault@example.org')
    from backend.app.services import imaging_storage_service as service
    from backend.app.api.routes import model_inference
    from backend.app.services.hgst_runtime.service import HGSTPredictionResult
    monkeypatch.setattr(model_inference,'predict_with_mode',lambda *a: HGSTPredictionResult(file_name='synthetic.csv',prediction_label='Control',probability=.2,
        probability_control=.8,source_type='mock',roi_dim_used=3,timepoints=2,model_name='SyntheticDemo',model_version='test',summary_text='synthetic'))
    if kind == 'audit': monkeypatch.setattr(service,'append_storage_audit',lambda *a,**k: (_ for _ in ()).throw(RuntimeError('synthetic audit fault')))
    else: monkeypatch.setattr(service,'commit_storage_transaction',lambda *a,**k: (_ for _ in ()).throw(RuntimeError('synthetic commit fault')))
    response=client.post(f"/api/v1/model/predict_fmri?patient_id={account['user']['patient_profile']['id']}",headers=headers,files={'timeseries_file':('synthetic.csv',b'1,2,3','text/csv')})
    assert response.status_code == 503,response.text
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        assert db.execute(text('SELECT COUNT(*) FROM uploads')).scalar_one() == 0
        assert db.execute(text('SELECT COUNT(*) FROM model_predictions')).scalar_one() == 0
    from backend.app.core.config import settings
    from pathlib import Path
    assert list(Path(settings.UPLOAD_ROOT).glob('*')) == []


def test_old_schema_keeps_non_imaging_report_and_rejects_writes_without_ddl(client):
    account, owner, _, doctor, route = shared_doctor(client)
    scale = client.post('/api/v1/patient/submit_scale',headers=owner,json={'scale_type':'ASRS','answers':[1]*18})
    assert scale.status_code in {200,201}, scale.text
    from backend.app.db.session import engine
    with engine.begin() as conn:
        for table in ('model_predictions','imaging_visualizations'):
            for field in ('record_schema_version','data_version','record_key_version','envelope_status','record_origin','storage_context'):
                conn.execute(text(f'ALTER TABLE {table} DROP COLUMN {field}'))
    for headers,url in ((owner,'/api/v1/patient/comprehensive_report'),(doctor,f"/api/v1/doctor/patient/{account['user']['patient_profile']['id']}/report")):
        report=client.get(url,headers=headers)
        assert report.status_code == 200, report.text
        assert report.json()['latest_scale'] is not None
        assert report.json()['imaging_history_status'] == 'storage_upgrade_required'
    assert client.post(route,headers=doctor,json={'visualization_type':'nifti'}).status_code == 503
    assert client.post(f"/api/v1/model/predict_mock?patient_id={account['user']['patient_profile']['id']}",headers=owner).status_code == 503
    from sqlalchemy import inspect
    assert 'record_origin' not in {c['name'] for c in inspect(engine).get_columns('model_predictions')}


def make_legacy(client):
    account, headers = register(client,'legacy-storage@example.org')
    from backend.app.db.session import engine
    from backend.app.core.data_encryption import encrypt_value
    values={'patient_id':account['user']['patient_profile']['id'],'file_name':encrypt_value('synthetic-legacy.csv','model_predictions.file_name'),
        'prediction_label':encrypt_value('Control','model_predictions.prediction_label'),'probability':encrypt_value(.2,'model_predictions.probability')}
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO model_predictions(patient_id,file_name,prediction_label,probability,source_type,created_at) VALUES(:patient_id,:file_name,:prediction_label,:probability,'fmri_hgst','2026-01-01 00:00:00')"),values)
    return engine,headers


def test_unreviewed_legacy_is_not_automatically_decrypted_or_converted(client):
    engine,headers=make_legacy(client)
    before=raw_row('model_predictions',1)
    response=client.get('/api/v1/patient/comprehensive_report',headers=headers)
    assert response.status_code == 200,response.text
    assert response.json()['imaging_history_status'] == 'conversion_required'
    assert response.json()['latest_model_prediction'] is None
    assert raw_row('model_predictions',1) == before


def test_temporary_conversion_requires_exact_review_backup_and_restores_separately(client,tmp_path):
    engine,headers=make_legacy(client)
    from backend.app.db.imaging_migration import (schema_plan,prepare_temporary_conversion,convert_reviewed_temporary_store,restore_temporary_backup)
    plan=schema_plan(engine)
    assert plan['requires_explicit_review'] is True
    assert plan['pending_conversion']['model_predictions'] == 1
    prepared=prepare_temporary_conversion(engine,tmp_path/'encrypted-backups')
    with pytest.raises(ValueError,match='review|manifest'):
        convert_reviewed_temporary_store(engine,reviewed_manifest={},backup_path=prepared['backup_path'],backup_sha256=prepared['backup_sha256'])
    with pytest.raises(ValueError,match='backup|digest'):
        convert_reviewed_temporary_store(engine,reviewed_manifest=prepared['manifest'],backup_path=prepared['backup_path'],backup_sha256='0'*64)
    result=convert_reviewed_temporary_store(engine,reviewed_manifest=prepared['manifest'],backup_path=prepared['backup_path'],backup_sha256=prepared['backup_sha256'])
    assert result['migrated_rows'] == 1
    response=client.get('/api/v1/patient/comprehensive_report',headers=headers)
    assert response.status_code == 200,response.text
    model=response.json()['latest_model_prediction']
    assert model['file_name'] == 'synthetic-legacy.csv'
    assert model['storage_integrity']['status'] == 'migrated_from_legacy'
    assert model['storage_integrity']['source_binding_retroactively_proven'] is False
    assert model['source_admission_status'] == 'not_recorded'
    restored=tmp_path/'restored-separate.db'
    restore_temporary_backup(prepared['backup_path'],prepared['backup_sha256'],restored)
    from sqlalchemy import create_engine
    separate=create_engine('sqlite:///'+restored.as_posix())
    with separate.connect() as conn:
        assert conn.execute(text('SELECT envelope_status FROM model_predictions')).scalar_one() == 'legacy'
    separate.dispose()
    with pytest.raises(ValueError,match='exist|overwrite'):
        restore_temporary_backup(prepared['backup_path'],prepared['backup_sha256'],restored)


def test_schema_plans_are_read_only_and_include_mysql_longtext(client):
    engine,_=make_legacy(client)
    from backend.app.db.imaging_migration import schema_plan
    before=raw_row('model_predictions',1)
    sqlite=schema_plan(engine)
    mysql=schema_plan(engine,dialect_name='mysql')
    assert sqlite['statements'] == []
    assert 'MODIFY COLUMN file_name LONGTEXT' in '\n'.join(mysql['statements'])
    assert 'MODIFY COLUMN slice_screenshot_data LONGTEXT' in '\n'.join(mysql['statements'])
    assert raw_row('model_predictions',1) == before


def test_read_only_planner_never_creates_a_missing_selected_database(tmp_path):
    import subprocess
    import sys
    from pathlib import Path
    target=tmp_path/'must-not-create.db'
    result=subprocess.run([sys.executable,'tools/plan-w09-imaging-schema.py','--database-url','sqlite:///'+target.as_posix()],capture_output=True,text=True)
    assert not target.exists(),result.stdout+result.stderr
    assert result.returncode != 0


def test_mysql_old_bounded_sensitive_columns_are_reported_unready(client,monkeypatch):
    from types import SimpleNamespace
    from sqlalchemy import String
    from sqlalchemy.dialects.mysql import LONGTEXT
    from backend.app.db import imaging_migration as migration
    class Inspector:
        def get_table_names(self):
            return [model.__tablename__ for model in migration._models()]
        def get_columns(self,table):
            model=next(model for model in migration._models() if model.__tablename__ == table)
            return [{'name':column.name,'type':String(255) if column.name == 'file_name' else LONGTEXT()} for column in model.__table__.c]
    monkeypatch.setattr(migration,'inspect',lambda bind:Inspector())
    issues=migration.storage_schema_issues(SimpleNamespace(dialect=SimpleNamespace(name='mysql')))
    assert issues == [{'table':'model_predictions','column':'file_name','issue':'requires_longtext'}]


def test_conversion_rejects_changed_review_source_and_rolls_back_on_failure(client,tmp_path,monkeypatch):
    engine,_=make_legacy(client)
    from backend.app.db import imaging_migration as migration
    prepared=migration.prepare_temporary_conversion(engine,tmp_path/'fault-backup')
    before=raw_row('model_predictions',1)
    with engine.begin() as conn:
        conn.execute(text("UPDATE model_predictions SET model_version='changed-after-review' WHERE id=1"))
    with pytest.raises(ValueError,match='manifest'):
        migration.convert_reviewed_temporary_store(engine,reviewed_manifest=prepared['manifest'],backup_path=prepared['backup_path'],backup_sha256=prepared['backup_sha256'])
    with engine.begin() as conn:
        conn.execute(text('UPDATE model_predictions SET model_version=:value WHERE id=1'),{'value':before['model_version']})
    count=0
    original=migration.seal_record
    def fail_partway(*args,**kwargs):
        nonlocal count
        count+=1
        if count == 3:
            raise RuntimeError('synthetic conversion interruption')
        return original(*args,**kwargs)
    monkeypatch.setattr(migration,'seal_record',fail_partway)
    with pytest.raises(RuntimeError,match='interruption'):
        migration.convert_reviewed_temporary_store(engine,reviewed_manifest=prepared['manifest'],backup_path=prepared['backup_path'],backup_sha256=prepared['backup_sha256'])
    assert raw_row('model_predictions',1) == before


def test_explicit_old_schema_plan_conversion_and_separate_restore_rehearsal(client,tmp_path):
    engine,headers=make_legacy(client)
    from backend.app.db import imaging_migration as migration
    from sqlalchemy import inspect,create_engine
    with engine.begin() as conn:
        for table in ('model_predictions','imaging_visualizations'):
            for name in sorted(migration.VERSION_COLUMNS):
                conn.exec_driver_sql(f'ALTER TABLE {table} DROP COLUMN {name}')
    sqlite_plan=migration.schema_plan(engine)
    mysql_plan=migration.schema_plan(engine,dialect_name='mysql')
    assert len(sqlite_plan['statements']) == 12
    assert 'record_origin' not in {c['name'] for c in inspect(engine).get_columns('model_predictions')}
    # Explicit reviewed execution applies ONLY to this fixture's temporary DB.
    with engine.begin() as conn:
        for statement in sqlite_plan['statements']:
            conn.exec_driver_sql(statement)
    assert client.get('/api/v1/patient/comprehensive_report',headers=headers).json()['imaging_history_status'] == 'conversion_required'
    prepared=migration.prepare_temporary_conversion(engine,tmp_path/'old-schema-rehearsal')
    converted=migration.convert_reviewed_temporary_store(engine,reviewed_manifest=prepared['manifest'],backup_path=prepared['backup_path'],backup_sha256=prepared['backup_sha256'])
    current=client.get('/api/v1/patient/comprehensive_report',headers=headers)
    assert current.status_code == 200,current.text
    assert current.json()['latest_model_prediction']['storage_integrity']['source_binding_retroactively_proven'] is False
    restored=migration.restore_temporary_backup(prepared['backup_path'],prepared['backup_sha256'],tmp_path/'separate-reviewed-restore.db')
    separate=create_engine('sqlite:///'+restored['restored_path'].replace('\\','/'))
    with separate.connect() as conn:
        assert conn.execute(text("SELECT envelope_status FROM model_predictions WHERE id=1")).scalar_one() == 'legacy'
    separate.dispose()
    print(json.dumps({'temporary_only':True,'sqlite_readonly_plan':sqlite_plan,'mysql_readonly_plan':mysql_plan,
        'reviewed_manifest':prepared['manifest'],'encrypted_backup_sha256':prepared['backup_sha256'],
        'conversion_result':converted,'restore_image_sha256':restored['image_sha256'],
        'separate_restore_verified':True,'source_binding_retroactively_proven':False},ensure_ascii=True))


def test_edit_of_converted_image_preserves_legacy_source_limit(client,tmp_path):
    account,owner,doctor,headers,route=shared_doctor(client)
    from backend.app.db.session import engine
    from backend.app.core.data_encryption import encrypt_value
    from backend.app.db import imaging_migration as migration
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO imaging_visualizations(patient_id,researcher_id,visualization_type,func_file_name,summary_text,created_at) VALUES(:pid,:actor,'nifti','synthetic-legacy.nii',:summary,'2026-01-01 00:00:00')"),
            {'pid':account['user']['patient_profile']['id'],'actor':doctor['user']['id'],'summary':encrypt_value('synthetic legacy image','imaging_visualizations.summary_text')})
    prepared=migration.prepare_temporary_conversion(engine,tmp_path/'legacy-edit')
    migration.convert_reviewed_temporary_store(engine,reviewed_manifest=prepared['manifest'],backup_path=prepared['backup_path'],backup_sha256=prepared['backup_sha256'])
    edited=client.post(route,headers=headers,json={'visualization_type':'nifti','notes':'new note retains old inputs'})
    assert edited.status_code == 201,edited.text
    image=edited.json()
    assert image['func_file_name'] == 'synthetic-legacy.nii'
    assert image['storage_integrity']['source_binding_retroactively_proven'] is False
    assert image['storage_context']['source_binding_retroactively_proven'] is False
    assert image['storage_context']['conversion_source_digest'] == prepared['manifest']['source_digest']
    assert image['storage_context']['actor_user_id'] == doctor['user']['id']
