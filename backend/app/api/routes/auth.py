from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from backend.app.api.deps import get_current_user, get_db
from backend.app.core.password_policy import get_password_policy_error
from backend.app.core.security import (
    create_access_token,
    get_password_hash,
    verify_password,
)
from backend.app.models.patient import Patient, PatientType
from backend.app.models.user import User, UserRole, UserSubrole
from backend.app.schemas.auth import TokenResponse, UserLogin, UserRegister, UserRead
from backend.app.services.security_service import provision_security_materials_for_user


router = APIRouter(prefix="/auth", tags=["auth"])


def build_auth_response(user: User) -> TokenResponse:
    access_token = create_access_token(subject=str(user.id), role=user.role.value)
    return TokenResponse(access_token=access_token, user=user)


def enforce_password_policy(password: str) -> None:
    error = get_password_policy_error(password)
    if error is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error,
        )


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register_user(payload: UserRegister, db: Session = Depends(get_db)) -> TokenResponse:
    enforce_password_policy(payload.password)

    existing_user = db.scalar(select(User).where(User.email == payload.email))
    if existing_user is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This email is already registered.",
        )

    if payload.role == "patient":
        if not payload.consent_agreed:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Patients must agree to informed consent before registering.",
            )
        if payload.patient_profile is None or payload.patient_profile.patient_type is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Patient registration requires a patient profile.",
            )
    elif payload.subrole == "dac":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="DAC accounts are provisioned by the system administrator.",
        )

    if payload.staff_id:
        existing_staff = db.scalar(select(User).where(User.staff_id == payload.staff_id))
        if existing_staff is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This staff ID is already registered.",
            )
    user = User(
        email=payload.email,
        staff_id=payload.staff_id,
        full_name=payload.full_name,
        password_hash=get_password_hash(payload.password),
        role=UserRole(payload.role),
        subrole=(
            UserSubrole(payload.subrole)
            if payload.subrole
            else (UserSubrole.NORMAL if payload.role == "researcher" else None)
        ),
        consent_agreed=payload.consent_agreed,
    )
    db.add(user)
    db.flush()

    if payload.role == "patient" and payload.patient_profile is not None:
        patient = Patient(
            user_id=user.id,
            age=payload.patient_profile.age,
            gender=payload.patient_profile.gender,
            patient_type=PatientType(payload.patient_profile.patient_type),
        )
        db.add(patient)

    db.commit()
    db.refresh(user)
    provision_security_materials_for_user(db, user)

    return build_auth_response(user)


@router.post("/login", response_model=TokenResponse)
def login_user(payload: UserLogin, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.scalar(
        select(User).where(
            or_(
                User.email == payload.identifier,
                User.staff_id == payload.identifier,
            )
        )
    )
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect account or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if payload.role is not None and user.role.value != payload.role:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Selected role does not match this account.",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been disabled.",
        )

    return build_auth_response(user)


@router.get("/me", response_model=UserRead)
def get_me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserRead:
    db.refresh(current_user)
    return current_user
