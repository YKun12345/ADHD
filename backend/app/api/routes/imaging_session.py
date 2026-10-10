from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, get_db
from backend.app.core.config import settings
from backend.app.models.user import User
from backend.app.services.findviz_access import (
    COOKIE_NAME, SESSION_LIFETIME, issue_session_token, require_patient_access,
)

router = APIRouter(prefix='/imaging', tags=['imaging'])


class ImagingSessionRequest(BaseModel):
    patient_id: int = Field(gt=0)


@router.post('/session')
def create_imaging_session(payload: ImagingSessionRequest, response: Response,
                           db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_patient_access(db, user, payload.patient_id)
    seconds = int(SESSION_LIFETIME.total_seconds())
    response.set_cookie(COOKIE_NAME, issue_session_token(user.id, payload.patient_id),
                        max_age=seconds, path='/findviz', httponly=True,
                        secure=settings.APP_ENV == 'production', samesite='strict')
    response.headers['Cache-Control'] = 'no-store'
    return {'patient_id': payload.patient_id, 'expires_in': seconds}


@router.delete('/session')
def clear_imaging_session(response: Response):
    # Clearing a browser session must work even after its access token expires.
    response.delete_cookie(COOKIE_NAME, path='/findviz', httponly=True,
                           secure=settings.APP_ENV == 'production', samesite='strict')
    response.headers['Cache-Control'] = 'no-store'
    return {'logged_out': True}


@router.get('/upload_limits')
def get_imaging_upload_limits(response: Response, user: User = Depends(get_current_user)):
    from findviz.request_security import upload_body_limit
    response.headers['Cache-Control'] = 'no-store'
    return {'max_body_bytes': upload_body_limit()}
