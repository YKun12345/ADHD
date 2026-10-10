from __future__ import annotations

from datetime import timedelta
import pytest


@pytest.fixture
def imaging_actors(client, monkeypatch, tmp_path):
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User, UserRole, UserSubrole
    from backend.app.models.patient import Patient, PatientType
    from backend.app.core.security import create_access_token
    monkeypatch.setenv('FINDVIZ_CACHE_ROOT', str(tmp_path / 'findviz'))
    with SessionLocal() as db:
        actors = {}
        for name, role, subrole in [('doctor', UserRole.RESEARCHER, UserSubrole.NORMAL),
                                    ('other', UserRole.RESEARCHER, UserSubrole.NORMAL),
                                    ('dac', UserRole.RESEARCHER, UserSubrole.DAC),
                                    ('patient1', UserRole.PATIENT, None),
                                    ('patient2', UserRole.PATIENT, None)]:
            user = User(email=name+'@imaging.example', full_name=name+'-private',
                        password_hash='unused', role=role, subrole=subrole,
                        consent_agreed=True, is_active=True)
            db.add(user)
            db.flush()
            actors[name] = {'id': user.id, 'headers': {'Authorization': 'Bearer '+
                create_access_token(str(user.id), role.value)}}
        for name in ['patient1', 'patient2']:
            patient = Patient(user_id=actors[name]['id'],
                              assigned_researcher_id=actors['doctor']['id'], patient_type=PatientType.ADULT)
            db.add(patient)
            db.flush()
            actors[name]['patient_id'] = patient.id
        db.commit()
    return actors


def open_workspace(client, actors, who='doctor', patient='patient1'):
    patient_id = actors[patient]['patient_id']
    response = client.post('/api/v1/imaging/session', headers=actors[who]['headers'],
                           json={'patient_id': patient_id})
    assert response.status_code == 200, response.text[:300]
    client.headers['X-Findviz-Patient-Id'] = str(patient_id)
    return response


@pytest.mark.parametrize('method,path', [('get','/findviz/check_cache'),
    ('post','/findviz/upload'), ('get','/findviz/get_viewer_metadata?context_id=main'),
    ('get','/findviz/get_log_entries'), ('get','/findviz/')])
def test_findviz_dynamic_routes_reject_anonymous(client, method, path):
    response = getattr(client, method)(path)
    assert response.status_code == 401, response.text[:300]


def test_findviz_session_requires_care_binding_and_does_not_expose_token(client, imaging_actors):
    patient_id = imaging_actors['patient1']['patient_id']
    for who in ['other', 'dac', 'patient2']:
        response = client.post('/api/v1/imaging/session', headers=imaging_actors[who]['headers'],
                               json={'patient_id': patient_id})
        assert response.status_code == 403, (who,response.text[:300])
        assert 'adhd_findviz_session=' not in response.headers.get('set-cookie','')
    response = open_workspace(client, imaging_actors)
    assert set(response.json()) == {'patient_id', 'expires_in'}
    cookie = response.headers['set-cookie'].lower()
    assert 'httponly' in cookie and 'samesite=strict' in cookie and 'path=/findviz' in cookie
    assert client.get('/findviz/check_cache').status_code == 200
    open_workspace(client, imaging_actors, who='patient1')
    assert client.get('/findviz/check_cache').status_code == 200


@pytest.mark.parametrize('change', ['inactive', 'unbind'])
def test_findviz_revalidates_active_user_and_binding(client, imaging_actors, change):
    open_workspace(client, imaging_actors)
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.models.patient import Patient
    with SessionLocal() as db:
        if change == 'inactive':
            db.get(User, imaging_actors['doctor']['id']).is_active = False
        else:
            db.get(Patient, imaging_actors['patient1']['patient_id']).assigned_researcher_id = None
        db.commit()
    response = client.get('/findviz/check_cache')
    assert response.status_code in (401,403), response.text[:300]


def test_findviz_expired_cookie_and_access_jwt_are_rejected(client, imaging_actors):
    from backend.app.services.findviz_access import COOKIE_NAME, issue_session_token
    expired = issue_session_token(imaging_actors['doctor']['id'], imaging_actors['patient1']['patient_id'],
                                  lifetime=timedelta(seconds=-1))
    client.cookies.set(COOKIE_NAME, expired, path='/findviz')
    assert client.get('/findviz/check_cache').status_code == 401
    client.cookies.set(COOKIE_NAME, imaging_actors['doctor']['headers']['Authorization'][7:], path='/findviz')
    assert client.get('/findviz/check_cache').status_code == 401


def test_findviz_prevents_mixed_patient_tabs_and_cross_origin_writes(client, imaging_actors):
    open_workspace(client, imaging_actors)
    client.headers['X-Findviz-Patient-Id'] = str(imaging_actors['patient2']['patient_id'])
    assert client.get('/findviz/check_cache').status_code == 403
    client.headers.pop('X-Findviz-Patient-Id')
    assert client.get('/findviz/check_cache').status_code == 403
    client.headers['X-Findviz-Patient-Id'] = str(imaging_actors['patient1']['patient_id'])
    assert client.post('/findviz/clear_cache', headers={'Origin':'https://untrusted.example'}).status_code == 403


def test_findviz_remote_logs_are_unavailable_and_static_modules_remain_public(client, imaging_actors):
    assert client.get('/findviz/static/js/viewer/MainViewer.js').status_code == 200
    open_workspace(client, imaging_actors)
    assert client.get('/findviz/get_log_entries?log_file=../../backend/.env').status_code == 403
    assert client.get('/findviz/get_log_files').status_code == 403


def test_findviz_cache_is_authenticated_and_scope_bound(client, imaging_actors):
    from findviz.workspace import workspace_context
    from findviz.viz.io.cache import Cache
    from findviz.viz.viewer.data_manager import DataManager
    with workspace_context('test-user-a:patient-a'):
        first = Cache()
        first.save({'file_type':'nifti','patient_note':'private-imaging-note'})
        raw = first.cache_file.read_bytes()
        assert b'private-imaging-note' not in raw
        assert first.load()['patient_note'] == 'private-imaging-note'
        manager_a = DataManager()
        manager_a.create_analysis_context('private-analysis')
    with workspace_context('test-user-a:patient-b'):
        second = Cache()
        assert second is not first and not second.exists()
        assert DataManager() is not manager_a
        assert 'private-analysis' not in DataManager().get_context_ids()
        second.cache_file.write_bytes(raw)
        with pytest.raises(IOError):
            second.load()
    with workspace_context('test-user-b:patient-a'):
        assert Cache() is not first and DataManager() is not manager_a
    with workspace_context('test-user-a:patient-a'):
        assert Cache() is first and DataManager() is manager_a
        mutated = bytearray(raw)
        mutated[-1] ^= 1
        first.cache_file.write_bytes(mutated)
        with pytest.raises(IOError):
            first.load()


@pytest.mark.parametrize('file_type', ['nifti', 'gifti'])
def test_findviz_uploaded_patient_data_stays_in_its_workspace(client, imaging_actors, file_type):
    from backend.tests.test_findviz_web import imaging_files
    open_workspace(client, imaging_actors)
    response = client.post('/findviz/upload', files=imaging_files(file_type),
                           data={'fmri_file_type':file_type, 'ts_input':'false', 'task_input':'false'})
    assert response.status_code == 201, response.text[:300]
    assert client.get('/findviz/check_cache').json()['has_cache'] is True
    assert client.get('/findviz/get_fmri_data?context_id=main').status_code == 200
    view = client.get('/findviz/', params={'patient_id':imaging_actors['patient1']['patient_id'], 'patient_name':'leaked-name', 'patient_email':'private@example.com'})
    assert view.status_code == 200
    assert 'leaked-name' not in view.text and 'private@example.com' not in view.text
    open_workspace(client, imaging_actors, patient='patient2')
    assert client.get('/findviz/check_cache').json()['has_cache'] is False
    assert client.get('/findviz/get_fmri_data?context_id=main').status_code == 404
    assert client.post('/findviz/clear_cache').status_code == 200
    open_workspace(client, imaging_actors, who='patient1')
    assert client.get('/findviz/check_cache').json()['has_cache'] is False
    open_workspace(client, imaging_actors)
    assert client.get('/findviz/check_cache').json()['has_cache'] is True
    assert client.get('/findviz/get_fmri_data?context_id=main').status_code == 200


@pytest.mark.parametrize('log_file', ['../../backend/.env', 'C:/Windows/win.ini', '/etc/passwd', 'app-run-20260101-120000.log/../other'])
def test_standalone_log_route_rejects_arbitrary_paths(client, log_file):
    from findviz import create_app
    response = create_app(testing=True).test_client().get('/get_log_entries', query_string={'log_file':log_file})
    assert response.status_code == 400, response.text[:300]


def test_large_multipart_stays_in_memory(client, tmp_path):
    from io import BytesIO
    from flask import request, jsonify
    from findviz import create_app
    app = create_app(testing=True)
    @app.post('/inspect-upload-stream')
    def inspect_stream():
        uploaded = request.files['clinical_image']
        return jsonify({'in_memory': isinstance(uploaded.stream, BytesIO),
                        'bytes': len(uploaded.read())})
    data = b'synthetic-clinical-image' * 50000
    assert len(data) > 1024 * 1024
    response = app.test_client().post('/inspect-upload-stream',
        data={'clinical_image': (BytesIO(data), 'synthetic.nii')}, content_type='multipart/form-data')
    assert response.status_code == 200
    assert response.get_json() == {'in_memory':True, 'bytes':len(data)}


def test_mounted_upload_limit_returns_413_before_image_parsing(client, imaging_actors, monkeypatch):
    open_workspace(client, imaging_actors)
    monkeypatch.setenv('FINDVIZ_MAX_UPLOAD_BYTES', '1024')
    response = client.post('/findviz/upload',
        files={'nii_func':('synthetic.nii', b'x' * 2048)},
        data={'fmri_file_type':'nifti', 'ts_input':'false', 'task_input':'false'})
    assert response.status_code == 413, response.text[:300]
    assert client.get('/findviz/check_cache').json()['has_cache'] is False


def test_standalone_upload_limit_returns_413(client, monkeypatch):
    from io import BytesIO
    from flask import request
    from findviz import create_app
    monkeypatch.setenv('FINDVIZ_MAX_UPLOAD_BYTES', '1024')
    app = create_app(testing=True)
    @app.post('/inspect-upload-stream')
    def inspect_stream():
        request.files['clinical_image'].read()
        return {'ok':True}
    response = app.test_client().post('/inspect-upload-stream',
        data={'clinical_image':(BytesIO(b'x'*2048), 'synthetic.nii')}, content_type='multipart/form-data')
    assert response.status_code == 413


def test_chunked_body_limit_is_enforced_without_content_length(monkeypatch):
    import asyncio
    from findviz.request_security import bounded_wsgi_body, UploadBodyTooLarge
    monkeypatch.setenv('FINDVIZ_MAX_UPLOAD_BYTES', '1024')
    messages = iter([{'type':'http.request', 'body':b'a'*700, 'more_body':True},
                     {'type':'http.request', 'body':b'b'*700, 'more_body':False}])
    async def receive():
        return next(messages)
    with pytest.raises(UploadBodyTooLarge):
        asyncio.run(bounded_wsgi_body({'headers':[]}, receive))


def test_trusted_proxy_https_origin_allows_authorized_imaging_write(client, imaging_actors):
    from fastapi.testclient import TestClient
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
    open_workspace(client, imaging_actors)
    proxy_app = ProxyHeadersMiddleware(client.app, trusted_hosts=['172.18.0.1'])
    proxy_client = TestClient(proxy_app, base_url='http://testserver',
                              client=('172.18.0.1', 12345), cookies=client.cookies)
    response = proxy_client.post('/findviz/clear_cache', headers={
        'Origin':'https://testserver', 'X-Forwarded-Proto':'https',
        'X-Findviz-Patient-Id':str(imaging_actors['patient1']['patient_id'])})
    assert response.status_code == 200, response.text[:300]
    untrusted_client = TestClient(proxy_app, base_url='http://testserver',
                                  client=('203.0.113.2', 12345), cookies=client.cookies)
    response = untrusted_client.post('/findviz/clear_cache', headers={
        'Origin':'https://testserver', 'X-Forwarded-Proto':'https',
        'X-Findviz-Patient-Id':str(imaging_actors['patient1']['patient_id'])})
    assert response.status_code == 403, response.text[:300]


@pytest.mark.parametrize('namespace,patient_id', [('synthetic-secret-owner:synthetic-secret-patient',77), ('standalone-cli',None)])
def test_imaging_logs_redact_identity_arrays_and_exception_text(client, tmp_path, namespace, patient_id):
    import io
    import logging
    from findviz.logger_config import setup_logger
    from findviz.workspace import workspace_context
    canary = 'CANARY_PRIVATE_CLINICAL_73291'
    logger = setup_logger('findviz.test_diagnostic_privacy', disable_file_logging=True)
    console = io.StringIO()
    stream_handler = logging.StreamHandler(console)
    log_file = tmp_path / 'diagnostic.log'
    file_handler = logging.FileHandler(log_file, encoding='utf8')
    logger.addHandler(stream_handler)
    logger.addHandler(file_handler)
    try:
        with workspace_context(namespace, patient_id):
            logger.info('Uploaded clinical file: %s', canary+'.nii')
            logger.warning(f'Labels and clinical array: {canary} [11,22,33]')
            try:
                raise ValueError('Clinical exception contains '+canary)
            except ValueError:
                logger.exception('Clinical parser error with '+canary)
        file_handler.flush()
        for output in [console.getvalue(), log_file.read_text(encoding='utf8')]:
            assert canary not in output
            assert '[11,22,33]' not in output
            assert 'synthetic-secret-owner' not in output
            assert 'synthetic-secret-patient' not in output
            assert 'event=' in output and 'workspace=' in output
    finally:
        logger.removeHandler(stream_handler)
        logger.removeHandler(file_handler)
        file_handler.close()


def test_mounted_header_extraction_does_not_log_user_filename(client, imaging_actors, caplog):
    import logging
    open_workspace(client, imaging_actors)
    canary = 'CANARY_PRIVATE_FILENAME_17359'
    with caplog.at_level(logging.DEBUG):
        response = client.post('/findviz/get_header', data={'file_index':'0'},
            files={'ts_file':(canary+'.csv', b'first,second\n1,2\n3,4\n')})
    assert response.status_code == 201, response.text[:300]
    assert canary not in caplog.text
    assert 'workspace=' in caplog.text


def test_standalone_cli_keeps_fixed_diagnostics_without_user_labels(client, caplog):
    import logging
    from io import BytesIO
    from findviz import create_app
    canary = 'CANARY_CLI_PRIVATE_LABEL_63572'
    with caplog.at_level(logging.INFO):
        response = create_app(testing=True).test_client().post('/get_header',
            data={'file_index':'0','ts_file':(BytesIO(b'column_a,column_b\n1,2\n'), canary+'.csv')},
            content_type='multipart/form-data')
    assert response.status_code == 201
    assert canary not in caplog.text
    assert 'Successfully extracted header from file: <redacted>' in caplog.text
    assert 'findviz.routes.file' in caplog.text and 'INFO' in caplog.text
