"""Authenticated notification account controls; no caller can choose an openid."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, get_db
from backend.app.models.user import User
from backend.app.schemas.notification import WechatBindRequest, NotificationPermissionResult, NotificationRevokeRequest
from backend.app.services import notification_service as service

def require_store(db: Session = Depends(get_db)):
    from backend.app.db.notification_migration import require_notification_schema
    try:
        require_notification_schema(db.get_bind())
    except (RuntimeError, SQLAlchemyError):
        raise HTTPException(503, '通知存储尚未准备，业务可继续。') from None


router = APIRouter(prefix='/notifications', tags=['notifications'], dependencies=[Depends(require_store)])


def _commit(db):
    try: db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, '微信绑定或通知记录已变化，请刷新后重试。') from None


@router.get('')
def status(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return service.notification_status(db, user)


@router.get('/{identifier}/resolve')
def resolve(identifier: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return service.resolve_delivery(db, user, identifier)


@router.post('/wechat-bind')
def bind(payload: WechatBindRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    result = service.bind_wechat(db, user, payload.code)
    _commit(db)
    return result


@router.post('/permission-requests')
def request_permission(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    result = service.request_permission(db, user)
    _commit(db)
    return result


@router.post('/permission-requests/{identifier}/result')
def record_permission(identifier: str, payload: NotificationPermissionResult,
        db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    result = service.record_permission(db, user, identifier, payload.result)
    _commit(db)
    return result


@router.post('/revoke')
def revoke(payload: NotificationRevokeRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    result = service.revoke_notifications(db, user, payload.expected_binding_revision)
    _commit(db)
    return result
