from collections.abc import Callable

from fastapi import Depends, HTTPException, status, Request
from sqlalchemy import event
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
from sqlalchemy.orm import Session

from backend.app.core.config import settings
from backend.app.core.security import decode_access_token
from backend.app.db.session import SessionLocal
from backend.app.models.user import User, UserRole, UserSubrole


oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1_STR}/auth/login")


def get_db(request: Request) -> Session:
    db = SessionLocal()
    db.info["authorization_request"] = request
    path = request.url.path
    db.info["requires_basic_use"] = request.method in {"POST","PUT","PATCH"} and any(
        path.startswith(settings.API_V1_STR + prefix)
        for prefix in ("/patient/submit_","/ai/","/model/predict_","/doctor/patient/","/care/doctor/patient/","/care/patient/")
    )
    def recheck(*_):
        receipts = db.info.get("authorization_receipts", [])
        credentials = db.info.get("credential_receipts",[])
        if receipts or credentials or db.info.get("authenticated_actor_id") is not None:
            from backend.app.services.identity_access import recheck_request_authority
            recheck_request_authority(db)
    event.listen(db, "before_commit", recheck)
    event.listen(db, "before_flush", recheck)
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = decode_access_token(token)
        user_id = int(payload["sub"])
    except (JWTError, KeyError, TypeError, ValueError) as exc:
        raise credentials_error from exc

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise credentials_error

    from backend.app.services.identity_access import record_authenticated_actor
    record_authenticated_actor(db,user)
    return user


def require_roles(*roles: UserRole) -> Callable:
    def dependency(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
        if current_user.role not in roles:
            from backend.app.services.identity_access import resolve_patient, doctor_qualification
            permitted = False
            if UserRole.PATIENT in roles:
                try:
                    resolve_patient(db,current_user)
                    permitted = True
                except HTTPException:
                    pass
            if UserRole.RESEARCHER in roles and doctor_qualification(db,current_user.id):
                permitted = True
            if not permitted:
                raise HTTPException(status_code=403,detail="You do not have permission to access this resource.")
        return current_user

    return dependency


def require_subroles(*subroles: UserSubrole) -> Callable:
    def dependency(current_user: User = Depends(get_current_user)) -> User:
        if current_user.subrole not in subroles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have permission to access this resource.",
            )
        return current_user

    return dependency
