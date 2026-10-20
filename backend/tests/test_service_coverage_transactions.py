"""Actual institutional authority races and final transaction boundaries."""
import pytest
from sqlalchemy import event, func, select

from backend.tests.test_service_coverage import institutional_actor, coverage_body, versions_route


def setup(client, suffix):
    doctor, _ = institutional_actor(client, suffix + '-doctor')
    reviewer, headers = institutional_actor(client, suffix + '-reviewer', reviewer=True)
    listed = client.get(versions_route(doctor['user']['id']), headers=headers, params={'institution_id': 'synthetic-institution'})
    assert listed.status_code == 200, listed.text
    body = {**coverage_body('queued-' + suffix), 'doctor_user_id': doctor['user']['id'], 'configuration_context': listed.json()['configuration_context']}
    return doctor, reviewer, headers, body


def count():
    from backend.app.db.session import SessionLocal
    from backend.app.models.service_coverage import ServiceCoverageVersion
    with SessionLocal() as db:
        return db.scalar(select(func.count()).select_from(ServiceCoverageVersion))


def test_original_signed_institutional_context_cannot_borrow_regranted_reviewer_head_for_first_post(client):
    doctor, reviewer, headers, body = setup(client, 'regrant')
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import InstitutionMembership
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        row = db.scalar(select(InstitutionMembership).where(InstitutionMembership.user_id == reviewer['user']['id']))
        ledger.deny(row)
        db.commit()
        ledger.publish(row)
    denied = client.post('/api/v1/identity/service-coverage-versions', headers=headers, json=body)
    assert denied.status_code in {403, 409}, denied.text
    assert count() == 0
    current = client.get(versions_route(doctor['user']['id']), headers=headers, params={'institution_id': 'synthetic-institution'})
    assert current.status_code == 200, current.text
    fresh = {**body, 'client_coverage_id': 'fresh-confirmed-new-context', 'configuration_context': current.json()['configuration_context']}
    assert client.post('/api/v1/identity/service-coverage-versions', headers=headers, json=fresh).status_code == 201
    assert count() == 1


def test_final_commit_failure_hides_ack_and_same_original_context_can_save_once_after_recovery(client, monkeypatch):
    _, _, headers, body = setup(client, 'commit')
    from backend.app.services import service_coverage_service as service
    original = service.create_coverage
    def fail_after_fact(db, *args):
        result = original(db, *args)
        def fail(*_):
            raise OSError('synthetic final institutional commit unavailable')
        event.listen(db, 'before_commit', fail, once=True)
        return result
    monkeypatch.setattr(service, 'create_coverage', fail_after_fact)
    response = client.post('/api/v1/identity/service-coverage-versions', headers=headers, json=body)
    assert response.status_code == 503 and 'effective_from' not in response.text, response.text
    assert count() == 0
    monkeypatch.setattr(service, 'create_coverage', original)
    saved = client.post('/api/v1/identity/service-coverage-versions', headers=headers, json=body)
    assert saved.status_code == 201, saved.text
    queried = client.get('/api/v1/identity/service-coverage-submissions/' + body['client_coverage_id'], headers=headers)
    assert queried.status_code == 200 and queried.json() == saved.json(), queried.text
    assert count() == 1


def test_critical_configuration_audit_failure_cannot_create_or_disclose_a_version(client, monkeypatch):
    doctor, _, headers, body = setup(client, 'audit')
    from backend.app.services import security_service
    original = security_service._append_audit_log
    def fail(db, **kwargs):
        if kwargs['action'].startswith('service_coverage'):
            raise OSError('synthetic critical coverage audit unavailable')
        return original(db, **kwargs)
    monkeypatch.setattr(security_service, '_append_audit_log', fail)
    saved = client.post('/api/v1/identity/service-coverage-versions', headers=headers, json=body)
    assert saved.status_code == 503 and count() == 0, saved.text
    listed = client.get(versions_route(doctor['user']['id']), headers=headers, params={'institution_id': 'synthetic-institution'})
    assert listed.status_code == 503 and 'configuration_context' not in listed.text, listed.text


def test_missing_real_coverage_table_reports_storage_unavailable_without_faking_unknown_config(client):
    _, doctor = institutional_actor(client, 'storage-doctor')
    from backend.app.db.session import engine
    with engine.begin() as db:
        db.exec_driver_sql('DROP TABLE service_coverage_versions')
    response = client.get('/api/v1/care/doctor/service-coverage', headers=doctor)
    assert response.status_code == 503, response.text
