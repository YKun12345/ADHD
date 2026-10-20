"""Independent notification records; external delivery never changes care facts."""
from datetime import datetime, timezone
import hashlib
import hmac
from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.data_encryption import EncryptedValue, scoped_key
from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.db.base import Base


def utcnow():
    return datetime.now(timezone.utc)


class WechatBinding(Base):
    __tablename__ = 'wechat_bindings'
    __table_args__ = (UniqueConstraint('user_id', 'app_id', name='uq_wechat_account_app'),
        UniqueConstraint('app_id', 'openid_digest', name='uq_wechat_openid_app'),
        CheckConstraint('revision > 0', name='ck_wechat_binding_revision'))
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    app_id: Mapped[str] = mapped_column(String(64))
    openid_digest: Mapped[str] = mapped_column(String(64))
    _openid_payload: Mapped[dict] = mapped_column('openid', EncryptedValue('wechat_bindings.openid', 'json'))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    bound_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    @property
    def openid(self):
        value = self._openid_payload
        if (not isinstance(value, dict) or set(value) != {'user_id', 'app_id', 'openid'} or
                value['user_id'] != self.user_id or value['app_id'] != self.app_id or
                not isinstance(value['openid'], str) or not 1 <= len(value['openid']) <= 128):
            raise RecordIntegrityError('WeChat binding does not match its actual account and app.')
        expected = hmac.new(scoped_key('wechat-openid-lookup'),
            (self.app_id + ':' + value['openid']).encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, self.openid_digest):
            raise RecordIntegrityError('WeChat binding identifier does not match its lookup digest.')
        return value['openid']

    @openid.setter
    def openid(self, value):
        self._openid_payload = {'user_id': self.user_id, 'app_id': self.app_id, 'openid': value}


class NotificationPermission(Base):
    __tablename__ = 'notification_permissions'
    __table_args__ = (CheckConstraint("status IN ('requested','accept','reject','ban','filter','failed','revoked','consumed')", name='ck_notification_permission_status'),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: uuid4().hex)
    binding_id: Mapped[int] = mapped_column(ForeignKey('wechat_bindings.id'), index=True)
    binding_revision: Mapped[int] = mapped_column(Integer)
    template_id: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default='requested', index=True)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    consumed_delivery_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)


class NotificationDelivery(Base):
    __tablename__ = 'notification_deliveries'
    __table_args__ = (UniqueConstraint('source_kind', 'source_event_id', 'recipient_user_id', name='uq_notification_event_recipient'),
        CheckConstraint("status IN ('pending','blocked','sending','sent','failed','unknown','suppressed')", name='ck_notification_delivery_status'),
        CheckConstraint('attempts >= 0', name='ck_notification_delivery_attempts'))
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: uuid4().hex)
    source_kind: Mapped[str] = mapped_column(String(16))
    source_event_id: Mapped[str] = mapped_column(String(64), index=True)
    recipient_user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id'), index=True)
    event_type: Mapped[str] = mapped_column(String(64))
    # Original authority receipts and source metadata are encrypted at rest.
    context: Mapped[dict] = mapped_column(EncryptedValue('notification_deliveries.context', 'json'))
    status: Mapped[str] = mapped_column(String(16), default='pending', index=True)
    reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    permission_id: Mapped[str | None] = mapped_column(ForeignKey('notification_permissions.id'), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    attempted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class NotificationCursor(Base):
    __tablename__ = 'notification_cursors'
    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    last_care_event_id: Mapped[int] = mapped_column(Integer, default=0)
    last_system_event_id: Mapped[int] = mapped_column(Integer, default=0)
