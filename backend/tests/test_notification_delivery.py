"""Notification integration uses only isolated stores and controlled HTTP."""
import importlib
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError


@pytest.fixture
def notifications(client):
    from backend.app.db.base import Base
    from backend.app.db.session import engine, SessionLocal
    from backend.app.models.user import User
    from backend.app.services.wechat_notification_provider import WechatNotificationConfig, WechatNotificationProvider
    from backend.tests.test_care_message_scope import message_world
    model = importlib.import_module('backend.app.models.notification')
    service = importlib.import_module('backend.app.services.notification_service')
    schema = importlib.import_module('backend.app.schemas.notification')
    Base.metadata.create_all(engine)
    account, headers, pid, doctors = message_world(client)
    calls = []
    def http(request):
        calls.append(request)
        if request.url.path == '/sns/jscode2session':
            return httpx.Response(200, json={'openid': 'synthetic-openid', 'session_key': 'not-stored'})
        if request.url.path == '/cgi-bin/stable_token':
            return httpx.Response(200, json={'access_token': 'synthetic-wechat-token', 'expires_in': 7200})
        return httpx.Response(200, json={'errcode': 0})
    cfg = WechatNotificationConfig('synthetic-app', 'synthetic-secret', 'synthetic-template', 'thing1', 'time2', True)
    provider = WechatNotificationProvider(cfg, transport=httpx.MockTransport(http))
    return client, SessionLocal, User, model, service, schema, account['user']['id'], doctors, cfg, provider, calls, pid, headers


def bind_and_permit(f, uid=None):
    _, factory, User, _, service, _, owner, _, _, provider, *_ = f
    with factory() as db:
        user = db.get(User, uid or owner)
        service.bind_wechat(db, user, 'synthetic-login-code', provider=provider)
        challenge = service.request_permission(db, user, config=provider.config)
        service.record_permission(db, user, challenge['permission_id'], 'accept', config=provider.config)
        db.commit()
        return challenge


def daytime():
    """Explicit synthetic next 10:00 Shanghai clock, within the 24h allowance."""
    current = datetime.now(timezone(timedelta(hours=8)))
    result = current.replace(hour=10, minute=0, second=0, microsecond=0)
    if result < current: result += timedelta(days=1)
    return result.astimezone(timezone.utc)


def test_only_server_code_exchange_can_bind_and_openid_is_never_exposed(notifications):
    f = notifications
    with pytest.raises(ValidationError):
        f[5].WechatBindRequest(code='test', openid='forged-client-openid')
    bind_and_permit(f)
    with f[1]() as db:
        status = f[4].notification_status(db, db.get(f[2], f[6]), config=f[8])
        assert status['bound'] is True and status['available_permissions'] == 1
        assert status['delivery_enabled'] is False and 'worker_disabled' in status['blockers']
        assert 'openid' not in json.dumps(status) and 'synthetic-secret' not in json.dumps(status)
        with pytest.raises(HTTPException):
            f[4].bind_wechat(db, db.get(f[2], f[7][0][0]['user']['id']), 'different-login-code', provider=f[9])


def test_permission_replay_cannot_mint_more_credits_and_revoke_invalidates_challenge(notifications):
    f = notifications
    challenge = bind_and_permit(f)
    with f[1]() as db:
        user = db.get(f[2], f[6])
        f[4].record_permission(db, user, challenge['permission_id'], 'accept', config=f[8])
        assert f[4].notification_status(db, user, config=f[8])['available_permissions'] == 1
        pending = f[4].request_permission(db, user, config=f[8])
        revision = f[4].notification_status(db, user, config=f[8])['binding_revision']
        f[4].revoke_notifications(db, user, revision, config=f[8])
        db.commit()
        with pytest.raises(HTTPException):
            f[4].record_permission(db, user, pending['permission_id'], 'accept', config=f[8])
        assert f[4].notification_status(db, user, config=f[8])['available_permissions'] == 0


def test_binding_ciphertext_from_another_account_cannot_redirect_a_reminder(notifications):
    f = notifications
    from sqlalchemy import text
    from backend.app.services.wechat_notification_provider import WechatNotificationProvider
    bind_and_permit(f)
    other_id = f[7][0][0]['user']['id']
    other_provider = WechatNotificationProvider(f[8], transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={'openid': 'another-synthetic-openid'})))
    with f[1]() as db:
        f[4].bind_wechat(db, db.get(f[2], other_id), 'another-code', provider=other_provider)
        db.commit()
        stolen_cipher = db.execute(text('SELECT openid FROM wechat_bindings WHERE user_id=:uid'), {'uid': other_id}).scalar_one()
        db.execute(text('UPDATE wechat_bindings SET openid=:cipher WHERE user_id=:uid'), {'cipher': stolen_cipher, 'uid': f[6]})
        db.commit()
    worker = importlib.import_module('backend.app.workers.notification_worker')
    worker.initialize_cursor(f[1]); actual_message(f); assert worker.scan_events(f[1]) == 1
    assert worker.deliver_once(f[1], provider=f[9], clock=daytime) is False
    assert not any(request.url.path.endswith('/subscribe/send') for request in f[10])
    with f[1]() as db:
        state = f[4].notification_status(db, db.get(f[2], f[6]), config=f[8])
        assert state['items'][0]['reason'] == 'binding_integrity_unavailable'
        repaired = f[4].bind_wechat(db, db.get(f[2], f[6]), 'fresh-server-code', provider=f[9])
        assert repaired['binding_revision'] == 2 and repaired['available_permissions'] == 0
        assert repaired['enabled'] is False
        db.commit()


def test_provider_default_disable_and_uncertain_ack_never_pretend_success():
    from datetime import datetime, timezone
    from backend.app.services.wechat_notification_provider import WechatNotificationConfig, WechatNotificationProvider, WechatProviderError
    with pytest.raises(WechatProviderError):
        WechatNotificationProvider(WechatNotificationConfig()).send(openid='test', event_type='shared_message_sent', occurred_at=datetime.now(timezone.utc))
    calls = []
    def http(request):
        calls.append(request.url.path)
        if request.url.path.endswith('stable_token'):
            return httpx.Response(200, json={'access_token': 'test'})
        raise httpx.ReadTimeout('secret URL must never escape')
    cfg = WechatNotificationConfig('app', 'secret', 'template', 'thing1', 'time2', True)
    with pytest.raises(WechatProviderError) as error:
        WechatNotificationProvider(cfg, transport=httpx.MockTransport(http)).send(openid='test', event_type='shared_message_sent', occurred_at=datetime.now(timezone.utc))
    assert error.value.uncertain and str(error.value) == 'wechat_delivery_unknown'


def actual_message(f, key='notification-original'):
    from backend.tests.test_shared_message_routes import send_context
    client, _, _, _, _, _, uid, doctors, _, _, _, pid, headers = f
    doctor, doctor_headers, relation = doctors[0]
    context = send_context(client, doctor_headers, pid, relation['id'])
    body = {'patient_id': pid, 'relationship_id': relation['id'], 'client_message_id': key,
        'content': '合成原件：不能进入外部模板的敏感正文', 'confirmed': True, 'send_context': context['send_context']}
    response = client.post('/api/v1/care/shared-messages', headers=doctor_headers, json=body)
    assert response.status_code == 201, response.text
    return response.json(), relation


def test_real_message_event_once_permission_once_and_safe_fixed_template(notifications):
    f = notifications
    worker = importlib.import_module('backend.app.workers.notification_worker')
    worker.initialize_cursor(f[1])
    bind_and_permit(f)
    original, relation = actual_message(f)
    assert worker.scan_events(f[1]) == 1
    assert worker.scan_events(f[1]) == 0
    delivered = worker.deliver_once(f[1], provider=f[9], clock=daytime)
    with f[1]() as db:
        diagnostic = f[4].notification_status(db, db.get(f[2], f[6]), config=f[8])
    assert delivered is True, [(row['status'], row['reason']) for row in diagnostic['items']]
    assert worker.deliver_once(f[1], provider=f[9], clock=daytime) is False
    with f[1]() as db:
        state = f[4].notification_status(db, db.get(f[2], f[6]), config=f[8])
        assert state['items'][0]['status'] == 'sent'
        assert state['available_permissions'] == 0
    sends = [r for r in f[10] if r.url.path.endswith('/subscribe/send')]
    assert len(sends) == 1
    assert '敏感正文' not in sends[0].content.decode()
    assert json.loads(sends[0].content)['data']['thing1']['value'] == '有新的协作消息'
    assert json.loads(sends[0].content)['page'] == 'pages/notifications/index'
    station = f[0].get(f"/api/v1/care/shared-messages?patient_id={f[11]}&relationship_id={relation['id']}", headers=f[12])
    assert station.status_code == 200, station.text
    assert any(row['message_id'] == original['message_id'] for row in station.json()['items'])
    actual_message(f, 'notification-second-original')
    assert worker.scan_events(f[1]) == 1
    assert worker.deliver_once(f[1], provider=f[9], clock=daytime) is False
    with f[1]() as db:
        assert any(row['reason'] == 'one_time_permission_required' for row in
            f[4].notification_status(db, db.get(f[2], f[6]), config=f[8])['items'])
    assert len([r for r in f[10] if r.url.path.endswith('/subscribe/send')]) == 1


@pytest.mark.parametrize('boundary', ['revoke_permission', 'revoke_relationship', 'inactive', 'unqualified', 'disabled'])
def test_pending_notification_rechecks_actual_authority_and_configuration(notifications, boundary):
    f = notifications
    worker = importlib.import_module('backend.app.workers.notification_worker')
    worker.initialize_cursor(f[1]); bind_and_permit(f)
    _, relation = actual_message(f)
    assert worker.scan_events(f[1]) == 1
    if boundary == 'revoke_permission':
        with f[1]() as db:
            user = db.get(f[2], f[6]); version = f[4].notification_status(db, user, config=f[8])['binding_revision']
            f[4].revoke_notifications(db, user, version, config=f[8]); db.commit()
    if boundary == 'revoke_relationship':
        assert f[0].post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=f[12],
            json={'expected_revision': relation['revision']}).status_code == 200
    if boundary in {'inactive', 'unqualified'}:
        with f[1]() as db:
            if boundary == 'inactive': db.get(f[2], f[6]).is_active = False
            else:
                from backend.app.models.identity import DoctorQualification
                from sqlalchemy import select
                qualification = db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == f[7][0][0]['user']['id']))
                qualification.status = 'revoked'; qualification.revision += 1
            db.commit()
    provider = f[9]
    if boundary == 'disabled':
        from backend.app.services.wechat_notification_provider import WechatNotificationProvider
        provider = WechatNotificationProvider(replace(f[8], send_enabled=False), transport=provider.transport)
    assert worker.deliver_once(f[1], provider=provider, clock=daytime) is False
    assert not any(r.url.path.endswith('/subscribe/send') for r in f[10])
    from sqlalchemy import select
    with f[1]() as db:
        saved = db.scalar(select(f[3].NotificationDelivery))
        assert saved.status in {'suppressed', 'blocked'}


def test_unknown_receipt_is_durable_and_not_automatically_retried(notifications):
    f = notifications
    worker = importlib.import_module('backend.app.workers.notification_worker')
    from backend.app.services.wechat_notification_provider import WechatNotificationProvider
    worker.initialize_cursor(f[1]); bind_and_permit(f); actual_message(f); worker.scan_events(f[1])
    sends = []
    def http(request):
        if request.url.path.endswith('stable_token'): return httpx.Response(200, json={'access_token': 'test'})
        sends.append(request); raise httpx.ReadTimeout('lost ACK')
    provider = WechatNotificationProvider(f[8], transport=httpx.MockTransport(http))
    assert worker.deliver_once(f[1], provider=provider, clock=daytime) is False
    assert worker.deliver_once(f[1], provider=provider, clock=daytime) is False
    assert len(sends) == 1
    with f[1]() as db:
        state = f[4].notification_status(db, db.get(f[2], f[6]), config=f[8])
        assert state['items'][0]['status'] == 'unknown'


def test_notification_link_requires_recipient_and_current_original_authority(notifications):
    f = notifications
    from sqlalchemy import select
    worker = importlib.import_module('backend.app.workers.notification_worker')
    worker.initialize_cursor(f[1]); original, relation = actual_message(f); worker.scan_events(f[1])
    with f[1]() as db:
        row = db.scalar(select(f[3].NotificationDelivery))
        identifier = row.id
        result = f[4].resolve_delivery(db, db.get(f[2], f[6]), identifier)
        assert result == {'notification_id': identifier, 'page': '/pages/shared-messages/index',
            'patient_id': f[11], 'relationship_id': relation['id']}
        stranger = db.get(f[2], f[7][1][0]['user']['id'])
        with pytest.raises(HTTPException): f[4].resolve_delivery(db, stranger, identifier)
    assert f[0].post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=f[12],
        json={'expected_revision': relation['revision']}).status_code == 200
    with f[1]() as db:
        with pytest.raises(HTTPException): f[4].resolve_delivery(db, db.get(f[2], f[6]), identifier)


def test_missing_notification_tables_are_friendly_503_without_creating_tables():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine, inspect
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from backend.app.api.deps import get_db, get_current_user
    from backend.app.api.routes.notifications import router
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    factory = sessionmaker(bind=engine)
    app = FastAPI(); app.include_router(router)
    def isolated_db():
        with factory() as db: yield db
    app.dependency_overrides[get_db] = isolated_db
    app.dependency_overrides[get_current_user] = lambda: type('SyntheticUser', (), {'id': 1})()
    with TestClient(app) as client:
        response = client.get('/notifications')
    assert response.status_code == 503
    assert response.json()['detail'] == '通知存储尚未准备，业务可继续。'
    assert inspect(engine).get_table_names() == []


def test_empty_send_response_is_unknown_not_success():
    from datetime import datetime, timezone
    from backend.app.services.wechat_notification_provider import WechatNotificationConfig, WechatNotificationProvider, WechatProviderError
    cfg = WechatNotificationConfig('app', 'secret', 'template', 'thing1', 'time2', True)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={
        'access_token': 'test'} if request.url.path.endswith('stable_token') else {}))
    with pytest.raises(WechatProviderError) as error:
        WechatNotificationProvider(cfg, transport=transport).send(openid='synthetic',
            event_type='shared_message_sent', occurred_at=datetime.now(timezone.utc))
    assert error.value.uncertain


def test_integrated_routes_bind_permission_revoke_and_resolve_only_own_current_source(notifications, monkeypatch):
    f = notifications
    for name, value in {'WECHAT_APP_ID': 'synthetic-app', 'WECHAT_APP_SECRET': 'synthetic-secret',
        'WECHAT_SUBSCRIBE_TEMPLATE_ID': 'synthetic-template', 'WECHAT_SUBSCRIBE_TITLE_FIELD': 'thing1',
        'WECHAT_SUBSCRIBE_TIME_FIELD': 'time2'}.items(): monkeypatch.setenv(name, value)
    monkeypatch.setattr(f[4], 'WechatNotificationProvider', lambda: f[9])
    client, headers = f[0], f[12]
    assert client.get('/api/v1/notifications').status_code == 401
    assert client.post('/api/v1/notifications/wechat-bind', headers=headers,
        json={'code': 'synthetic-code', 'openid': 'forged-openid'}).status_code == 422
    bound = client.post('/api/v1/notifications/wechat-bind', headers=headers, json={'code': 'synthetic-code'})
    assert bound.status_code == 200, bound.text
    assert 'openid' not in bound.text and 'synthetic-secret' not in bound.text
    challenge = client.post('/api/v1/notifications/permission-requests', headers=headers)
    assert challenge.status_code == 200, challenge.text
    accepted = client.post(f"/api/v1/notifications/permission-requests/{challenge.json()['permission_id']}/result",
        headers=headers, json={'result': 'accept'})
    assert accepted.status_code == 200 and accepted.json()['available_permissions'] == 1
    worker = importlib.import_module('backend.app.workers.notification_worker')
    worker.initialize_cursor(f[1]); _, relation = actual_message(f); assert worker.scan_events(f[1]) == 1
    state = client.get('/api/v1/notifications', headers=headers).json()
    identifier = state['items'][0]['id']
    assert 'page' not in state['items'][0] and 'patient_id' not in state['items'][0]
    resolved = client.get(f'/api/v1/notifications/{identifier}/resolve', headers=headers)
    assert resolved.status_code == 200 and resolved.json()['relationship_id'] == relation['id']
    assert client.get(f'/api/v1/notifications/{identifier}/resolve', headers=f[7][1][1]).status_code == 404
    revoked = client.post('/api/v1/notifications/revoke', headers=headers,
        json={'expected_binding_revision': state['binding_revision']})
    assert revoked.status_code == 200 and revoked.json()['available_permissions'] == 0
    assert client.post(f"/api/v1/care/relationships/{relation['id']}/revoke", headers=headers,
        json={'expected_revision': relation['revision']}).status_code == 200
    assert client.get(f'/api/v1/notifications/{identifier}/resolve', headers=headers).status_code in {403, 409}


def test_notification_module_has_fixed_provider_and_durable_permission_models():
    model = importlib.import_module('backend.app.models.notification')
    provider = importlib.import_module('backend.app.services.wechat_notification_provider')
    assert model.WechatBinding.__tablename__ == 'wechat_bindings'
    assert model.NotificationPermission.__tablename__ == 'notification_permissions'
    assert model.NotificationDelivery.__tablename__ == 'notification_deliveries'
    assert provider.WechatNotificationConfig.from_environment().send_enabled is False


def test_real_report_and_plan_events_resolve_their_actual_assessment_and_do_not_duplicate(notifications):
    f = notifications
    worker = importlib.import_module('backend.app.workers.notification_worker')
    worker.initialize_cursor(f[1])
    from backend.tests.test_cycle_reviews import actual_plan
    owner, _, _, assessment, _, _, _ = actual_plan(f[0])
    user_id = f[0].get('/api/v1/auth/me', headers=owner).json()['id']
    assert worker.scan_events(f[1]) == 2
    assert worker.scan_events(f[1]) == 0
    with f[1]() as db:
        state = f[4].notification_status(db, db.get(f[2], user_id), config=f[8])
        assert len(state['items']) == 2
        destinations = [f[4].resolve_delivery(db, db.get(f[2], user_id), item['id']) for item in state['items']]
        assert {row['page'] for row in destinations} == {'/pages/care-reports/index', '/pages/patient-plan/index'}
        assert all(row['patient_id'] == assessment['patient_id'] and row['assessment_id'] == assessment['id'] for row in destinations)
    bind_and_permit(f, uid=user_id)
    assert worker.deliver_once(f[1], provider=f[9], clock=daytime) is True
    assert worker.deliver_once(f[1], provider=f[9], clock=daytime) is False
    assert len([r for r in f[10] if r.url.path.endswith('/subscribe/send')]) == 1


def test_real_overdue_fact_resolves_only_the_responsible_doctor_without_changing_attention(notifications):
    f = notifications
    worker = importlib.import_module('backend.app.workers.notification_worker')
    worker.initialize_cursor(f[1])
    from backend.tests.test_attention_deadlines import actual_deadline_attention
    from backend.app.services.attention_deadline_service import monitor_once
    from backend.app.models.attention import AttentionItem
    _, doctor, session, attention_id, deadline = actual_deadline_attention(f[0])
    assert monitor_once(f[1], clock=lambda: deadline + timedelta(seconds=1)) == 1
    assert worker.scan_events(f[1]) == 1
    assert worker.scan_events(f[1]) == 0
    doctor_id = f[0].get('/api/v1/auth/me', headers=doctor).json()['id']
    with f[1]() as db:
        state = f[4].notification_status(db, db.get(f[2], doctor_id), config=f[8])
        assert len(state['items']) == 1
        result = f[4].resolve_delivery(db, db.get(f[2], doctor_id), state['items'][0]['id'])
        assert result['page'] == '/pages/care-attention/index' and result['patient_id'] == session['patient_id']
        attention = db.get(AttentionItem, attention_id)
        assert attention.status == 'open' and attention.version == 1
