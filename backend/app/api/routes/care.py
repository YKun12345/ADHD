from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.api.deps import get_db, require_roles
from backend.app.models.ai_chat_log import AIChatLog
from backend.app.models.care_message import CareMessage, CareMessageType
from backend.app.models.patient import Patient
from backend.app.models.patient_task import PatientTask, PatientTaskStatus, PatientTaskType
from backend.app.models.user import User, UserRole
from backend.app.schemas.care import (
    AIChatLogListResponse,
    AIChatLogResponse,
    CareMessageCreateRequest,
    CareMessageListResponse,
    CareMessageResponse,
    PatientTaskCreateRequest,
    PatientTaskListResponse,
    PatientTaskResponse,
)


router = APIRouter(prefix="/care", tags=["care"])


def _get_patient_for_researcher(db: Session, patient_id: int, researcher_id: int) -> Patient:
    patient = db.get(Patient, patient_id)
    if patient is None or patient.assigned_researcher_id != researcher_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="未找到该患者，或该患者不属于当前研究人员。",
        )
    return patient


def _get_patient_for_user(db: Session, current_user: User) -> Patient:
    patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="未找到当前患者档案。",
        )
    return patient


@router.post(
    "/doctor/patient/{patient_id}/tasks",
    response_model=PatientTaskResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_patient_task(
    patient_id: int,
    payload: PatientTaskCreateRequest,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> PatientTaskResponse:
    _get_patient_for_researcher(db, patient_id, current_user.id)

    task = PatientTask(
        patient_id=patient_id,
        researcher_id=current_user.id,
        task_type=PatientTaskType(payload.task_type),
        task_title=payload.task_title,
        task_description=payload.task_description,
        target_page=payload.target_page,
        target_payload_json=payload.target_payload_json,
        priority=payload.priority,
        status=PatientTaskStatus.PENDING,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return PatientTaskResponse.model_validate(task)


@router.get(
    "/doctor/patient/{patient_id}/tasks",
    response_model=PatientTaskListResponse,
)
def get_researcher_patient_tasks(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> PatientTaskListResponse:
    _get_patient_for_researcher(db, patient_id, current_user.id)
    tasks = db.scalars(
        select(PatientTask)
        .where(PatientTask.patient_id == patient_id)
        .order_by(PatientTask.status.asc(), PatientTask.priority.desc(), PatientTask.created_at.desc())
    ).all()
    return PatientTaskListResponse(items=[PatientTaskResponse.model_validate(item) for item in tasks])


@router.get("/patient/tasks", response_model=PatientTaskListResponse)
def get_my_tasks(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> PatientTaskListResponse:
    patient = _get_patient_for_user(db, current_user)
    tasks = db.scalars(
        select(PatientTask)
        .where(PatientTask.patient_id == patient.id)
        .order_by(PatientTask.status.asc(), PatientTask.priority.desc(), PatientTask.created_at.desc())
    ).all()
    return PatientTaskListResponse(items=[PatientTaskResponse.model_validate(item) for item in tasks])


@router.post("/patient/tasks/{task_id}/complete", response_model=PatientTaskResponse)
def complete_patient_task(
    task_id: int,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> PatientTaskResponse:
    patient = _get_patient_for_user(db, current_user)
    task = db.get(PatientTask, task_id)
    if task is None or task.patient_id != patient.id:
        raise HTTPException(status_code=404, detail="未找到该任务。")

    task.status = PatientTaskStatus.COMPLETED
    task.completed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(task)
    return PatientTaskResponse.model_validate(task)


@router.post(
    "/doctor/patient/{patient_id}/messages",
    response_model=CareMessageResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_researcher_message(
    patient_id: int,
    payload: CareMessageCreateRequest,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> CareMessageResponse:
    _get_patient_for_researcher(db, patient_id, current_user.id)
    message = CareMessage(
        patient_id=patient_id,
        sender_user_id=current_user.id,
        sender_role=current_user.role.value,
        message_type=CareMessageType.TEXT,
        content=payload.content.strip(),
    )
    db.add(message)
    db.commit()
    db.refresh(message)
    return CareMessageResponse.model_validate(message)


@router.post("/patient/messages", response_model=CareMessageResponse, status_code=status.HTTP_201_CREATED)
def create_patient_message(
    payload: CareMessageCreateRequest,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> CareMessageResponse:
    patient = _get_patient_for_user(db, current_user)
    if patient.assigned_researcher_id is None:
        raise HTTPException(status_code=400, detail="当前尚未关联研究人员，暂时无法发送消息。")

    message = CareMessage(
        patient_id=patient.id,
        sender_user_id=current_user.id,
        sender_role=current_user.role.value,
        message_type=CareMessageType.TEXT,
        content=payload.content.strip(),
    )
    db.add(message)
    db.commit()
    db.refresh(message)
    return CareMessageResponse.model_validate(message)


@router.get("/doctor/patient/{patient_id}/messages", response_model=CareMessageListResponse)
def get_researcher_messages(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> CareMessageListResponse:
    _get_patient_for_researcher(db, patient_id, current_user.id)
    items = db.scalars(
        select(CareMessage)
        .where(CareMessage.patient_id == patient_id)
        .order_by(CareMessage.created_at.asc(), CareMessage.id.asc())
    ).all()
    return CareMessageListResponse(items=[CareMessageResponse.model_validate(item) for item in items])


@router.get("/patient/messages", response_model=CareMessageListResponse)
def get_patient_messages(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> CareMessageListResponse:
    patient = _get_patient_for_user(db, current_user)
    items = db.scalars(
        select(CareMessage)
        .where(CareMessage.patient_id == patient.id)
        .order_by(CareMessage.created_at.asc(), CareMessage.id.asc())
    ).all()
    return CareMessageListResponse(items=[CareMessageResponse.model_validate(item) for item in items])


@router.get("/doctor/patient/{patient_id}/ai_logs", response_model=AIChatLogListResponse)
def get_researcher_ai_logs(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> AIChatLogListResponse:
    _get_patient_for_researcher(db, patient_id, current_user.id)
    items = db.scalars(
        select(AIChatLog)
        .where(AIChatLog.patient_id == patient_id)
        .order_by(AIChatLog.created_at.desc(), AIChatLog.id.desc())
    ).all()
    return AIChatLogListResponse(items=[AIChatLogResponse.model_validate(item) for item in items])


@router.get("/patient/ai_logs", response_model=AIChatLogListResponse)
def get_patient_ai_logs(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> AIChatLogListResponse:
    patient = _get_patient_for_user(db, current_user)
    items = db.scalars(
        select(AIChatLog)
        .where(AIChatLog.patient_id == patient.id)
        .order_by(AIChatLog.created_at.desc(), AIChatLog.id.desc())
    ).all()
    return AIChatLogListResponse(items=[AIChatLogResponse.model_validate(item) for item in items])
