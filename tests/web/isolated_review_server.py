"""W06 synthetic source provisioning through real production API services only."""
import os
from isolated_server import runtime, root
os.environ['AUTHORIZATION_LEDGER_PATH'] = str(runtime / 'review-authority.db')

if __name__ == '__main__':
    import sys
    import uvicorn
    from fastapi import Header, HTTPException
    from fastapi.testclient import TestClient
    from pydantic import BaseModel
    from backend.app.main import app

    assert os.environ['APP_ENV'] == 'test'
    if os.environ.get('XINGZAI_SYNTHETIC_LIVE_AI') == 'explicit-current-message-only':
        from xingzai_live_fixture import enable_synthetic_provider
        enable_synthetic_provider()

    # Preserve production error responses while recording the cause against
    # this server's disposable synthetic store only.
    import traceback
    from backend.app.services import security_service
    _synthetic_original_audit = security_service._append_audit_log
    def _synthetic_audit_diagnostics(*args, **kwargs):
        try:
            return _synthetic_original_audit(*args, **kwargs)
        except Exception:
            traceback.print_exc()
            raise
    security_service._append_audit_log = _synthetic_audit_diagnostics

    class Source(BaseModel):
        child: bool = False
        self_screening: bool = False
        cycle_review: bool = False
        minimal: bool = False

    @app.post('/api/v1/__synthetic__/registry-source')
    def registry_source(x_synthetic_test: str = Header(default='')):
        if x_synthetic_test != 'w06-local-synthetic-only':
            raise HTTPException(403,'Synthetic fixture access only')
        import hashlib
        from backend.app.core.config import settings
        from backend.tests.w02_helpers import register,qualify
        directory=runtime/'synthetic-models';directory.mkdir(exist_ok=True)
        artifact=directory/'never-load-synthetic.pt';artifact.write_bytes(b'synthetic-model-registry-ui-never-deserialized')
        settings.MODEL_REGISTRY_ARTIFACT_ROOT=str(directory)
        with TestClient(app) as client:
            actor,headers=register(client,'model-registry-ui@example.com','researcher')
            qualify(actor['user']['id'],reviewer=True)
            return {'reviewer':{'access_token':headers['Authorization'].split(' ',1)[1],'user':client.get('/api/v1/auth/me',headers=headers).json()},
                'artifact_file':artifact.name,'artifact_sha256':hashlib.sha256(artifact.read_bytes()).hexdigest()}

    @app.post('/api/v1/__synthetic__/review-source')
    def prepare(payload: Source, x_synthetic_test: str = Header(default='')):
        if x_synthetic_test != 'w06-local-synthetic-only':
            raise HTTPException(403, 'Synthetic fixture access only')
        with TestClient(app) as client:
            plan = None
            if payload.minimal:
                from backend.tests.test_assessment_sessions import doctor_session
                _,owner,_,_,doctor,draft=doctor_session(client)
                published=client.post(f"/api/v1/care/assessments/{draft['id']}/publish",headers=doctor,json={'expected_version':draft['version']})
                assert published.status_code==200,published.text
                session=published.json();incoming=None
            elif payload.cycle_review:
                from backend.tests.test_cycle_reviews import actual_plan
                owner,doctor,incoming,session,plan,_,_=actual_plan(client)
            elif payload.self_screening:
                from backend.tests.test_assessment_consumers import complete_assessment, drain
                owner, _, session, pid = complete_assessment(client)
                drain()
                from backend.tests.test_transfer_guardian_chain import new_relation
                user = client.get('/api/v1/auth/me', headers=owner).json()
                doctor, relation = new_relation(client, {'user': user}, owner, pid, 'w06-self-shared')
                incoming = None
            elif not payload.child:
                from backend.tests.test_responsibility_transfers import real_transfer_source
                owner, doctor, incoming, session, relation, source = real_transfer_source(client)
            else:
                from backend.tests.test_assessment_sessions import actor, created
                from backend.tests.test_transfer_guardian_chain import new_relation
                from backend.tests.test_submission_cognitive_evidence import cognitive_submission
                from backend.tests.test_assessment_consumers import drain
                data, owner, pid = actor(client, child=True, suffix='w06-http-child')
                doctor, relation = new_relation(client, data, owner, pid, 'w06-child-original')
                incoming, _ = new_relation(client, data, owner, pid, 'w06-child-other')
                draft = created(client, doctor, pid, child=True, doctor=True)
                published = client.post(f"/api/v1/care/assessments/{draft['id']}/publish", headers=doctor, json={'expected_version': draft['version']})
                assert published.status_code == 200, published.text
                session = published.json()
                _, _, item, _, body = cognitive_submission(client, 'flanker', context=(owner, session, pid))
                body['submission_id'] = 'w06-child-' + body['run_id']
                body['task_id'] = item['patient_task_id']; body['content']['execution_metadata']['interrupted_count'] = 1
                saved = client.post('/api/v1/care/submissions', headers=owner, json=body)
                assert saved.status_code == 201, saved.text
                drain()
            def auth(headers):
                if headers is None:
                    return None
                response = client.get('/api/v1/auth/me', headers=headers)
                assert response.status_code == 200, response.text
                return {'access_token': headers['Authorization'].split(' ', 1)[1], 'user': response.json()}
            return {'synthetic_temporary_store': True, 'source_created_via_production_api_testclient': True,
                'owner': auth(owner), 'doctor': auth(doctor), 'incoming': auth(incoming), 'assessment': session, 'plan': plan}

    uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]), log_level='warning')
