"""Account-owned binding/permission and authenticated clinical-event projection."""
from datetime import datetime, timedelta, timezone
import hashlib
import hmac

from fastapi import HTTPException
from sqlalchemy import func, select, update

from backend.app.core.data_encryption import scoped_key
from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.notification import WechatBinding, NotificationPermission, NotificationDelivery
from backend.app.models.user import User
from backend.app.services.wechat_notification_provider import WechatNotificationConfig, WechatNotificationProvider, WechatProviderError, TEMPLATES


def utc(value=None):
    value = value or datetime.now(timezone.utc)
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _active(db, user):
    current = db.get(User, user.id, populate_existing=True)
    if not current or not current.is_active: raise HTTPException(403, '当前账号已失效。')


def _binding(db, user, config, *, lock=False):
    _active(db, user)
    statement = select(WechatBinding).where(WechatBinding.user_id == user.id, WechatBinding.app_id == config.app_id)
    if lock:
        db.execute(update(WechatBinding).where(WechatBinding.user_id == user.id, WechatBinding.app_id == config.app_id)
            .values(revision=WechatBinding.revision))
        statement = statement.with_for_update()
    return db.scalar(statement.execution_options(populate_existing=True))


def _revoke_permissions(db, binding):
    db.execute(update(NotificationPermission).where(NotificationPermission.binding_id == binding.id,
        NotificationPermission.status.in_(['requested', 'accept'])).values(status='revoked'))


def bind_wechat(db, user, code, *, provider=None):
    provider = provider or WechatNotificationProvider()
    _active(db, user)
    try:
        openid = provider.exchange_login_code(code)
    except WechatProviderError as exc:
        raise HTTPException(503, exc.reason) from None
    # App-scoped keyed digest supports uniqueness without exposing the identifier.
    digest = hmac.new(scoped_key('wechat-openid-lookup'), (provider.config.app_id + ':' + openid).encode(), hashlib.sha256).hexdigest()
    conflict = db.scalar(select(WechatBinding).where(WechatBinding.app_id == provider.config.app_id,
        WechatBinding.openid_digest == digest))
    if conflict and conflict.user_id != user.id:
        raise HTTPException(409, '此微信已绑定其他账号；请先在原账号暂停并联系机构处理。')
    binding = _binding(db, user, provider.config, lock=True)
    if binding is None:
        binding = WechatBinding(user_id=user.id, app_id=provider.config.app_id, openid=openid,
            openid_digest=digest, revision=1, enabled=False)
        db.add(binding)
    elif binding.openid_digest != digest:
        _revoke_permissions(db, binding)
        binding.openid = openid
        binding.openid_digest = digest
        binding.revision += 1
        binding.enabled = False
        binding.bound_at = utc()
    else:
        try:
            binding.openid
        except RecordIntegrityError:
            # Only a fresh server-side code exchange can repair an old or
            # mismatched encrypted binding; its previous permissions stay revoked.
            _revoke_permissions(db, binding)
            binding.revision += 1
            binding.enabled = False
            binding.bound_at = utc()
            binding.openid = openid
    db.flush()
    return notification_status(db, user, config=provider.config)


def request_permission(db, user, *, config=None):
    config = config or WechatNotificationConfig.from_environment()
    blockers = config.blockers(include_disabled=False)
    if blockers: raise HTTPException(503, blockers[0])
    binding = _binding(db, user, config, lock=True)
    if binding is None: raise HTTPException(409, '请先绑定当前微信。')
    now = utc()
    recent = db.scalar(select(func.count()).select_from(NotificationPermission).where(
        NotificationPermission.binding_id == binding.id, NotificationPermission.requested_at > now - timedelta(minutes=10)))
    if recent >= 5: raise HTTPException(429, '操作较频繁，请稍后再试。')
    row = NotificationPermission(binding_id=binding.id, binding_revision=binding.revision,
        template_id=config.template_id, status='requested', expires_at=now + timedelta(minutes=5))
    db.add(row); db.flush()
    return {'permission_id': row.id, 'template_id': row.template_id, 'expires_at': utc(row.expires_at).isoformat(),
        'binding_revision': binding.revision, 'permission_kind': 'one_time'}


def record_permission(db, user, identifier, result, *, config=None):
    config = config or WechatNotificationConfig.from_environment()
    if result not in {'accept', 'reject', 'ban', 'filter', 'failed'}: raise HTTPException(422, '未知许可结果。')
    binding = _binding(db, user, config, lock=True)
    row = db.get(NotificationPermission, identifier, populate_existing=True)
    if not binding or not row or row.binding_id != binding.id: raise HTTPException(404, '许可记录不存在。')
    if row.binding_revision != binding.revision or row.template_id != config.template_id:
        raise HTTPException(409, '绑定或模板已变化，请重新点击订阅。')
    if row.status == result or (row.status == 'consumed' and result == 'accept'):
        return notification_status(db, user, config=config)
    if row.status != 'requested' or utc(row.expires_at) <= utc():
        raise HTTPException(409, '此许可请求已处理或过期，请重新点击订阅。')
    row.status = result; row.decided_at = utc()
    if result == 'accept':
        binding.enabled = True
        row.expires_at = utc() + timedelta(hours=24)
    else:
        # A new refusal blocks any earlier local allowances conservatively.
        db.flush()
        _revoke_permissions(db, binding)
        binding.enabled = False
    db.flush()
    return notification_status(db, user, config=config)


def revoke_notifications(db, user, expected_revision, *, config=None):
    config = config or WechatNotificationConfig.from_environment()
    binding = _binding(db, user, config, lock=True)
    if not binding: raise HTTPException(404, '当前账号尚未绑定微信。')
    if binding.revision != expected_revision: raise HTTPException(409, '绑定已变化，请刷新后重试。')
    _revoke_permissions(db, binding)
    binding.enabled = False; binding.revision += 1
    db.flush()
    return notification_status(db, user, config=config)


def notification_status(db, user, *, config=None):
    config = config or WechatNotificationConfig.from_environment()
    binding = _binding(db, user, config)
    permits = 0
    blockers = config.blockers()
    if not config.worker_enabled: blockers.append('worker_disabled')
    if not binding: blockers.append('wechat_not_bound')
    else:
        if not binding.enabled: blockers.append('notifications_paused')
        permits = db.scalar(select(func.count()).select_from(NotificationPermission).where(
            NotificationPermission.binding_id == binding.id, NotificationPermission.binding_revision == binding.revision,
            NotificationPermission.template_id == config.template_id, NotificationPermission.status == 'accept',
            NotificationPermission.expires_at > utc()))
    if not permits: blockers.append('one_time_permission_required')
    rows = db.scalars(select(NotificationDelivery).where(NotificationDelivery.recipient_user_id == user.id)
        .order_by(NotificationDelivery.created_at.desc(), NotificationDelivery.id).limit(40)).all()
    return {'bound': binding is not None, 'binding_revision': binding.revision if binding else None,
        'enabled': bool(binding and binding.enabled), 'available_permissions': permits, 'blockers': blockers,
        'binding_ready': bool(config.app_id and config.app_secret),
        'template_ready': not config.blockers(include_disabled=False), 'delivery_enabled': config.send_enabled and config.worker_enabled,
        'items': [{'id': row.id, 'title': TEMPLATES.get(row.event_type, ('业务提醒', ''))[0],
            'status': row.status, 'reason': row.reason, 'attempts': row.attempts,
            'created_at': utc(row.created_at).isoformat()} for row in rows],
        'notice': '站内业务状态始终保留。微信受理不代表用户已读或业务已处理；结果不明时不自动重发。'}


def source_context(db, event, source_kind):
    """Resolve only immutable server-owned originals, never a client recipient."""
    from backend.app.models.assessment import AssessmentSession
    from backend.app.models.identity import CareRelationship
    from backend.app.services.assessment_service import _bound_relationship
    from backend.app.core.record_envelope import RecordIntegrityError
    payload = event.payload
    if event.event_type not in TEMPLATES or not isinstance(payload, dict): return None
    if source_kind == 'care' and event.event_type == 'shared_message_sent':
        from backend.app.models.shared_message import SharedCareMessage
        from backend.app.services.care_message_service import _verify
        row = db.get(SharedCareMessage, event.aggregate_id, populate_existing=True)
        if row is None: raise RecordIntegrityError('Missing original notification message.')
        _verify(row)
        if (event.aggregate_type, event.patient_id, event.actor_user_id, event.revision,
            payload.get('message_id'), payload.get('relationship_id'), payload.get('relationship_revision'),
            payload.get('content_digest'), payload.get('authorization_snapshot')) != (
            'shared_care_message', row.patient_id, row.sender_user_id, row.version, row.id,
            row.relationship_id, row.relationship_revision, row.content_digest, row.authorization_snapshot):
            raise RecordIntegrityError('Notification event differs from its actual message.')
        recipient = row.patient_actor_user_id if row.sender_user_id == row.doctor_user_id else row.doctor_user_id
        return {'recipient_user_id': recipient, 'patient_id': row.patient_id, 'relationship_id': row.relationship_id,
            'relationship_revision': row.relationship_revision, 'scope': 'care', 'authorization_snapshot': row.authorization_snapshot}
    if source_kind == 'care' and event.event_type in {'professional_report_published', 'professional_plan_published'}:
        if event.event_type == 'professional_report_published':
            from backend.app.models.review import ReportVersion, verify
            row = db.get(ReportVersion, event.aggregate_id, populate_existing=True)
            expected_aggregate = 'report'
        else:
            from backend.app.models.care_plan import PlanVersion, CarePlan, verify
            row = db.get(PlanVersion, payload.get('plan_version_id'), populate_existing=True)
            root = db.get(CarePlan, event.aggregate_id, populate_existing=True)
            if not root or not row or row.plan_id != root.id or root.status != 'active': return None
            verify(root)
            expected_aggregate = 'care_plan'
        if not row: raise RecordIntegrityError('Missing original clinical notification source.')
        verify(row)
        if (event.patient_id, event.actor_user_id, event.revision, event.aggregate_type,
            payload.get('authorization_snapshot')) != (row.patient_id, row.actor_user_id, row.version,
            expected_aggregate, row.snapshot.get('authorization_snapshot')):
            raise RecordIntegrityError('Notification event differs from its publication.')
        assessment = db.get(AssessmentSession, row.assessment_id, populate_existing=True)
        if not assessment or assessment.status in {'cancelled', 'suspended'}: return None
        relation = db.get(CareRelationship, _bound_relationship(assessment), populate_existing=True)
        if not relation: return None
        revisions = [version[2] for receipt in payload['authorization_snapshot'] for version in receipt[4]
            if version[0] == 'care_relationships' and version[3] == relation.id]
        if not revisions or len(set(revisions)) != 1: raise RecordIntegrityError('Missing original notification relationship revision.')
        return {'recipient_user_id': relation.patient_actor_user_id, 'patient_id': row.patient_id,
            'relationship_id': relation.id, 'relationship_revision': revisions[0],
            'scope': 'assessment' if event.event_type == 'professional_report_published' else 'care',
            'authorization_snapshot': payload['authorization_snapshot']}
    if source_kind == 'system' and event.event_type == 'attention_response_overdue':
        from backend.app.models.attention import AttentionItem
        from backend.app.services.attention_deadline_service import _verify_event, OPEN
        from backend.app.services.attention_service import verify_attention
        row = db.get(AttentionItem, payload.get('attention_id'), populate_existing=True)
        if not row: raise RecordIntegrityError('Missing original deadline attention.')
        verify_attention(row); values = _verify_event(event, row)
        if row.status not in OPEN or row.owner_kind != 'doctor': return None
        relation = db.get(CareRelationship, row.relationship_id, populate_existing=True)
        if not relation: return None
        receipts = values['original_authorization_snapshot']
        revisions = [version[2] for receipt in receipts for version in receipt[4]
            if version[0] == 'care_relationships' and version[3] == relation.id]
        if not revisions or len(set(revisions)) != 1: raise RecordIntegrityError('Missing original deadline authority.')
        return {'recipient_user_id': row.responsible_doctor_id, 'patient_id': row.patient_id,
            'relationship_id': row.relationship_id, 'relationship_revision': revisions[0], 'scope': 'assessment',
            'authorization_snapshot': receipts}
    return None


def check_delivery_authority(db, row):
    from backend.app.models.event import CareEvent
    from backend.app.models.care_system_event import CareSystemEvent
    from backend.app.models.identity import CareRelationship
    from backend.app.services.identity_access import require_patient_access
    from backend.app.services.care_message_service import _original
    model = CareEvent if row.source_kind == 'care' else CareSystemEvent
    event = db.scalar(select(model).where(model.event_id == row.source_event_id).execution_options(populate_existing=True))
    context = source_context(db, event, row.source_kind) if event else None
    if (not context or context != row.context or context['recipient_user_id'] != row.recipient_user_id
        or context['patient_id'] != row.patient_id or event.event_type != row.event_type):
        raise HTTPException(409, 'Original notification context changed.')
    user = db.get(User, row.recipient_user_id, populate_existing=True)
    if not user or not user.is_active: raise HTTPException(403, 'Recipient inactive.')
    relation = db.get(CareRelationship, context['relationship_id'], populate_existing=True)
    if not relation or relation.revision != context['relationship_revision']:
        raise HTTPException(409, 'Original notification relationship changed.')
    _original(db, context['authorization_snapshot'], processing=True)
    require_patient_access(db, user, row.patient_id, context['scope'],
        relationship_id=relation.id if user.id == relation.doctor_user_id else None)
    return event


def resolve_delivery(db, user, identifier):
    _active(db, user)
    row = db.get(NotificationDelivery, identifier, populate_existing=True)
    if not row or row.recipient_user_id != user.id: raise HTTPException(404, '提醒记录不存在。')
    event = check_delivery_authority(db, row)
    result = {'notification_id': row.id, 'page': '/' + TEMPLATES[row.event_type][1], 'patient_id': row.patient_id}
    if row.event_type == 'shared_message_sent':
        result['relationship_id'] = row.context['relationship_id']
    elif row.event_type in {'professional_report_published', 'professional_plan_published'}:
        result['assessment_id'] = event.payload['assessment_id']
    return result
