"""Short-lived, patient-bound sessions for the mounted imaging workspace."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http.cookies import SimpleCookie, CookieError
from urllib.parse import parse_qs

from jose import jwt, JWTError
from fastapi import HTTPException
from backend.app.core.config import settings
from backend.app.core.data_encryption import scoped_key

COOKIE_NAME = 'adhd_findviz_session'
SESSION_LIFETIME = timedelta(minutes=15)
PATIENT_HEADER = 'x-findviz-patient-id'


def _database_scope():
    return sha256(settings.DATABASE_URL.encode()).hexdigest()[:16]


def can_access_patient(user, patient):
    from backend.app.models.user import UserRole
    if patient is None or user is None or not user.is_active:
        return False
    if user.role == UserRole.PATIENT:
        return patient.user_id == user.id
    return user.role == UserRole.RESEARCHER and patient.assigned_researcher_id == user.id


def require_patient_access(db, user, patient_id):
    from backend.app.models.patient import Patient
    patient = db.get(Patient, patient_id)
    if not can_access_patient(user, patient):
        raise HTTPException(status_code=403, detail='没有该患者影像工作区的护理权限。')
    return patient


def issue_session_token(user_id, patient_id, lifetime=SESSION_LIFETIME):
    now = datetime.now(timezone.utc)
    return jwt.encode({'sub': str(user_id), 'patient_id': patient_id,
                       'purpose': 'findviz-workspace', 'database_scope': _database_scope(),
                       'iat': now, 'exp': now + lifetime},
                      scoped_key('findviz-session').hex(), algorithm='HS256')


@dataclass(frozen=True)
class ImagingWorkspace:
    user_id: int
    patient_id: int
    namespace: str


def _audit(db, actor_id, patient_id, method, path, allowed):
    from backend.app.services.security_service import _append_audit_log
    _append_audit_log(db, actor_user_id=actor_id, patient_id=patient_id,
                      action='imaging_access' if allowed else 'access_denied',
                      status='authorized' if allowed else 'denied',
                      message='影像工作区访问授权。' if allowed else '影像工作区权限拒绝。',
                      detail_json={'method': method, 'path': '/findviz' + path})
    db.commit()


def authorize_scope(scope):
    """Revalidate the live account/binding on every dynamic request."""
    headers = {key.decode('latin1').lower(): value.decode('latin1') for key, value in scope.get('headers', [])}
    cookies = SimpleCookie()
    try:
        cookies.load(headers.get('cookie', ''))
        value = cookies[COOKIE_NAME].value
        claims = jwt.decode(value, scoped_key('findviz-session').hex(), algorithms=['HS256'],
                            options={'require_exp': True, 'require_sub': True})
        if claims.get('purpose') != 'findviz-workspace' or claims.get('database_scope') != _database_scope():
            raise ValueError('wrong session purpose')
        user_id = int(claims['sub'])
        patient_id = int(claims['patient_id'])
    except (JWTError, KeyError, TypeError, ValueError, CookieError):
        raise HTTPException(status_code=401, detail='影像会话未建立或已过期，请重新进入患者工作区。')
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.models.patient import Patient
    relative_path = scope['path']
    root_path = scope.get('root_path', '')
    if root_path and relative_path.startswith(root_path):
        relative_path = relative_path[len(root_path):] or '/'
    method = scope.get('method', 'GET')
    with SessionLocal() as db:
        user = db.get(User, user_id)
        patient = db.get(Patient, patient_id)
        allowed = can_access_patient(user, patient)
        # A tab identifies its patient even when another tab has replaced the cookie.
        document_route = relative_path == '/' or relative_path.startswith('/analysis_view/')
        expected = (parse_qs(scope.get('query_string', b'').decode()).get('patient_id') or [None])[0] if document_route else headers.get(PATIENT_HEADER)
        allowed = allowed and str(patient_id) == expected
        # Shared platform logs may contain another patient's details.
        allowed = allowed and relative_path not in ('/get_log_entries', '/get_log_files')
        origin = headers.get('origin')
        host_origin = scope.get('scheme', 'http') + '://' + headers.get('host', '')
        if method not in ('GET', 'HEAD') and origin and origin != host_origin:
            allowed = False
        if user is not None:
            _audit(db, user_id, patient_id if patient else None, method, relative_path, allowed)
        if user is None or not user.is_active:
            raise HTTPException(status_code=401, detail='账户已失效，请重新登录。')
        if not allowed:
            raise HTTPException(status_code=403, detail='影像工作区授权失败，请确认患者绑定并重新进入当前患者页面。')
    return ImagingWorkspace(user_id, patient_id, f'{_database_scope()}:user:{user_id}:patient:{patient_id}')
