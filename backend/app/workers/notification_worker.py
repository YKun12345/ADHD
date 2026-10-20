"""Durable event scanner and conservative single-attempt WeChat delivery.

A durable 'sending' claim is committed before network I/O. A lost acknowledgement
or process crash is never blindly retried, since WeChat send has no idempotency key.
"""
from datetime import datetime, timedelta, timezone
import logging
from threading import Event, Thread

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.event import CareEvent
from backend.app.models.care_system_event import CareSystemEvent
from backend.app.models.notification import NotificationCursor, NotificationDelivery, NotificationPermission, WechatBinding
from backend.app.services.notification_service import source_context, check_delivery_authority, utc
from backend.app.services.wechat_notification_provider import WechatNotificationProvider, WechatProviderError, TEMPLATES

logger = logging.getLogger('notification.worker')
CURSOR = 'wechat_subscribe_v1'


def initialize_cursor(session_factory):
    """Start after current committed events; never bulk-notify historical records."""
    with session_factory() as db:
        if db.get(NotificationCursor, CURSOR): return
        db.add(NotificationCursor(name=CURSOR,
            last_care_event_id=db.scalar(select(func.max(CareEvent.id))) or 0,
            last_system_event_id=db.scalar(select(func.max(CareSystemEvent.id))) or 0))
        try: db.commit()
        except IntegrityError: db.rollback()  # Another initializer owns the same cursor.


def scan_events(session_factory, *, limit=32):
    if type(limit) is not int or not 1 <= limit <= 64: raise ValueError('Unsupported notification scan limit.')
    count = 0
    initialize_cursor(session_factory)
    with session_factory() as db:
        with db.begin():
            db.execute(update(NotificationCursor).where(NotificationCursor.name == CURSOR)
                .values(last_care_event_id=NotificationCursor.last_care_event_id))
            cursor = db.get(NotificationCursor, CURSOR, with_for_update=True, populate_existing=True)
            for kind, model, attribute in [('care', CareEvent, 'last_care_event_id'), ('system', CareSystemEvent, 'last_system_event_id')]:
                events = db.scalars(select(model).where(model.id > getattr(cursor, attribute))
                    .order_by(model.id).limit(limit)).all()
                for event in events:
                    if event.event_type in TEMPLATES:
                        try: context = source_context(db, event, kind)
                        except (RecordIntegrityError, HTTPException):
                            # Unverified facts cannot supply a recipient; do not leak payloads to logs.
                            context = None
                            logger.warning('Notification source rejected by integrity/authority checks.')
                        if context:
                            existing = db.scalar(select(NotificationDelivery.id).where(
                                NotificationDelivery.source_kind == kind, NotificationDelivery.source_event_id == event.event_id,
                                NotificationDelivery.recipient_user_id == context['recipient_user_id']))
                            if not existing:
                                db.add(NotificationDelivery(source_kind=kind, source_event_id=event.event_id,
                                    recipient_user_id=context['recipient_user_id'], patient_id=context['patient_id'],
                                    event_type=event.event_type, context=context, status='pending'))
                                count += 1
                    setattr(cursor, attribute, event.id)
            db.flush()
    return count


def _claim(session_factory, provider, now):
    config = provider.config
    with session_factory() as db:
        with db.begin():
            # A crashed network attempt is ambiguous, never eligible for another send.
            db.execute(update(NotificationDelivery).where(NotificationDelivery.status == 'sending',
                NotificationDelivery.attempted_at < now - timedelta(minutes=2))
                .values(status='unknown', reason='worker_interrupted', completed_at=now))
            identifiers = db.scalars(select(NotificationDelivery.id).where(NotificationDelivery.status.in_(['pending', 'blocked']))
                .order_by(NotificationDelivery.created_at, NotificationDelivery.id).limit(32)).all()
            for identifier in identifiers:
                # Serialize all sends/permission changes for this actual binding.
                row = db.get(NotificationDelivery, identifier, populate_existing=True)
                db.execute(update(WechatBinding).where(WechatBinding.user_id == row.recipient_user_id,
                    WechatBinding.app_id == config.app_id).values(revision=WechatBinding.revision))
                db.execute(update(NotificationDelivery).where(NotificationDelivery.id == identifier,
                    NotificationDelivery.status.in_(['pending', 'blocked'])).values(status=NotificationDelivery.status))
                row = db.get(NotificationDelivery, identifier, with_for_update=True, populate_existing=True)
                if row.status not in {'pending', 'blocked'}: continue
                try: check_delivery_authority(db, row)
                except (HTTPException, RecordIntegrityError):
                    row.status = 'suppressed'; row.reason = 'original_authority_unavailable'
                    continue
                blockers = config.blockers()
                binding = db.scalar(select(WechatBinding).where(WechatBinding.user_id == row.recipient_user_id,
                    WechatBinding.app_id == config.app_id).with_for_update().execution_options(populate_existing=True))
                if not binding: blockers.append('wechat_not_bound')
                elif not binding.enabled: blockers.append('notifications_paused')
                local = now.astimezone(timezone(timedelta(hours=8)))
                if local.hour >= 22 or local.hour < 8: blockers.append('quiet_hours')
                day_start = local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
                attempts = db.scalar(select(func.count()).select_from(NotificationDelivery).where(
                    NotificationDelivery.recipient_user_id == row.recipient_user_id,
                    NotificationDelivery.attempted_at >= day_start))
                if attempts >= 3: blockers.append('daily_limit')
                inflight = db.scalar(select(NotificationDelivery.id).where(NotificationDelivery.recipient_user_id == row.recipient_user_id,
                    NotificationDelivery.status == 'sending').limit(1))
                if inflight: blockers.append('recipient_busy')
                permit = None
                if binding and not blockers:
                    permit = db.scalar(select(NotificationPermission).where(NotificationPermission.binding_id == binding.id,
                        NotificationPermission.binding_revision == binding.revision,
                        NotificationPermission.template_id == config.template_id, NotificationPermission.status == 'accept',
                        NotificationPermission.expires_at > now).order_by(NotificationPermission.decided_at, NotificationPermission.id)
                        .with_for_update().limit(1))
                if not permit: blockers.append('one_time_permission_required')
                if blockers:
                    row.status = 'blocked'; row.reason = blockers[0]
                    continue
                consumed = db.execute(update(NotificationPermission).where(NotificationPermission.id == permit.id,
                    NotificationPermission.status == 'accept', NotificationPermission.binding_revision == binding.revision)
                    .values(status='consumed', consumed_delivery_id=row.id))
                if consumed.rowcount != 1: continue
                row.status = 'sending'; row.reason = None; row.attempted_at = now
                row.permission_id = permit.id; row.attempts += 1
                db.flush()
                return row.id
    return None


def deliver_once(session_factory, *, provider=None, clock=None):
    provider = provider or WechatNotificationProvider()
    now = utc(clock() if clock else None)
    identifier = _claim(session_factory, provider, now)
    if identifier is None: return False
    from backend.app.services import authorization_ledger as ledger
    # Authority withdrawals use the same ledger lock. Binding revocation is
    # serialized by the DB write lock through the bounded external call.
    with ledger.read_heads(), session_factory() as db:
        with db.begin():
            row = db.get(NotificationDelivery, identifier, with_for_update=True)
            if row.status != 'sending': return False
            db.execute(update(WechatBinding).where(WechatBinding.user_id == row.recipient_user_id,
                WechatBinding.app_id == provider.config.app_id).values(revision=WechatBinding.revision))
            binding = db.scalar(select(WechatBinding).where(WechatBinding.user_id == row.recipient_user_id,
                WechatBinding.app_id == provider.config.app_id).with_for_update().execution_options(populate_existing=True))
            permit = db.get(NotificationPermission, row.permission_id, populate_existing=True)
            try:
                event = check_delivery_authority(db, row)
                if (not binding or not binding.enabled or not permit or permit.status != 'consumed'
                    or permit.consumed_delivery_id != row.id or permit.binding_revision != binding.revision
                    or permit.template_id != provider.config.template_id or utc(permit.expires_at) <= utc(clock() if clock else None)):
                    raise HTTPException(403, 'Current binding/permission changed.')
            except (HTTPException, RecordIntegrityError):
                row.status = 'suppressed'; row.reason = 'original_authority_unavailable'; row.completed_at = utc()
                return False
            try:
                openid = binding.openid
            except RecordIntegrityError:
                row.status = 'suppressed'; row.reason = 'binding_integrity_unavailable'; row.completed_at = utc()
                return False
            try:
                provider.send(openid=openid, event_type=row.event_type,
                    occurred_at=event.created_at if row.source_kind == 'care' else event.observed_at)
                row.status = 'sent'; row.reason = None
            except WechatProviderError as exc:
                row.status = 'unknown' if exc.uncertain else 'failed'; row.reason = exc.reason
                if exc.reason in {'wechat_permission_unavailable', 'wechat_binding_invalid', 'wechat_template_banned'}:
                    binding.enabled = False
                    db.execute(update(NotificationPermission).where(NotificationPermission.binding_id == binding.id,
                        NotificationPermission.status.in_(['accept', 'requested'])).values(status='revoked'))
            row.completed_at = utc()
            return row.status == 'sent'


class NotificationWorkerRuntime:
    def __init__(self, session_factory, *, interval_seconds=5, provider=None):
        if not 0.5 <= interval_seconds <= 60: raise ValueError('Unsupported notification interval.')
        self.session_factory = session_factory
        self.provider = provider or WechatNotificationProvider()
        self.interval_seconds = interval_seconds
        self._stop = Event(); self._thread = None

    @property
    def running(self): return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self.running: return
        initialize_cursor(self.session_factory)
        self._stop.clear()
        self._thread = Thread(target=self._run, name='wechat-notifications', daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop.is_set():
            try:
                scan_events(self.session_factory)
                if not self._stop.is_set(): deliver_once(self.session_factory, provider=self.provider)
            except Exception:
                # Never log request URLs, openids, payloads or exception strings.
                logger.warning('Notification worker transaction failed; durable records retained.')
            self._stop.wait(self.interval_seconds)

    def stop(self, *, timeout=5):
        self._stop.set()
        if self._thread: self._thread.join(timeout=timeout)
        return not self.running
