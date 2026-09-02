from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
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
    CareSummaryResponse,
    PatientTaskCreateRequest,
    PatientTaskListResponse,
    PatientTaskResponse,
    ReadReceiptResponse,
)


router = APIRouter(prefix="/care", tags=["care"])


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _task_response(task: PatientTask) -> PatientTaskResponse:
    status_value = task.status.value
    if (
        task.status == PatientTaskStatus.PENDING
        and task.due_at is not None
        and _utc(task.due_at) < datetime.now(timezone.utc)
    ):
        status_value = "expired"
    return PatientTaskResponse(
        id=task.id,
        patient_id=task.patient_id,
        researcher_id=task.researcher_id,
        researcher_name=task.researcher.full_name if task.researcher else "医生",
        task_type=task.task_type.value,
        status=status_value,
        priority=task.priority,
        task_title=task.task_title,
        task_description=task.task_description,
        target_page=task.target_page,
        target_payload_json=task.target_payload_json,
        due_at=task.due_at,
        created_at=task.created_at,
        completed_at=task.completed_at,
    )


def _message_response(message: CareMessage, viewer_role: str) -> CareMessageResponse:
    read_at = (
        message.read_by_patient_at
        if viewer_role == UserRole.PATIENT.value
        else message.read_by_researcher_at
    )
    return CareMessageResponse(
        id=message.id,
        patient_id=message.patient_id,
        sender_user_id=message.sender_user_id,
        sender_role=message.sender_role,
        sender_name=message.sender.full_name if message.sender else "",
        message_type=message.message_type.value,
        content=message.content,
        client_message_id=message.client_message_id,
        created_at=message.created_at,
        related_task_id=message.related_task_id,
        read_at=read_at,
    )


def _create_idempotent_message(
    db: Session,
    *,
    patient_id: int,
    current_user: User,
    payload: CareMessageCreateRequest,
) -> CareMessage:
    def find_existing() -> CareMessage | None:
        return db.scalar(select(CareMessage).where(
            CareMessage.sender_user_id == current_user.id,
            CareMessage.client_message_id == payload.client_message_id,
        ))

    def validate_existing(existing: CareMessage) -> CareMessage:
        if existing.patient_id != patient_id or existing.content != payload.content:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="客户端消息编号已用于其他消息。",
            )
        return existing

    existing = find_existing()
    if existing is not None:
        return validate_existing(existing)

    message = CareMessage(
        patient_id=patient_id,
        sender_user_id=current_user.id,
        sender_role=current_user.role.value,
        message_type=CareMessageType.TEXT,
        content=payload.content,
        client_message_id=payload.client_message_id,
    )
    db.add(message)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = find_existing()
        if existing is None:
            raise
        return validate_existing(existing)
    db.refresh(message)
    return message


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
        due_at=payload.due_at,
        status=PatientTaskStatus.PENDING,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return _task_response(task)


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
    return PatientTaskListResponse(items=[_task_response(item) for item in tasks])


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
    return PatientTaskListResponse(items=[_task_response(item) for item in tasks])


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

    if task.status == PatientTaskStatus.COMPLETED:
        return _task_response(task)
    if task.due_at is not None and _utc(task.due_at) < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="任务已过期，不能再标记完成。")

    task.status = PatientTaskStatus.COMPLETED
    task.completed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(task)
    return _task_response(task)


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
    message = _create_idempotent_message(
        db,
        patient_id=patient_id,
        current_user=current_user,
        payload=payload,
    )
    return _message_response(message, UserRole.RESEARCHER.value)


@router.post("/patient/messages", response_model=CareMessageResponse, status_code=status.HTTP_201_CREATED)
def create_patient_message(
    payload: CareMessageCreateRequest,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> CareMessageResponse:
    patient = _get_patient_for_user(db, current_user)
    if patient.assigned_researcher_id is None:
        raise HTTPException(status_code=400, detail="当前尚未关联研究人员，暂时无法发送消息。")

    message = _create_idempotent_message(
        db,
        patient_id=patient.id,
        current_user=current_user,
        payload=payload,
    )
    return _message_response(message, UserRole.PATIENT.value)


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
    return CareMessageListResponse(items=[_message_response(item, UserRole.RESEARCHER.value) for item in items])


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
    return CareMessageListResponse(items=[_message_response(item, UserRole.PATIENT.value) for item in items])


@router.get("/patient/summary", response_model=CareSummaryResponse)
def get_patient_care_summary(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> CareSummaryResponse:
    patient = _get_patient_for_user(db, current_user)
    now = datetime.now(timezone.utc)
    unread = db.scalar(
        select(func.count(CareMessage.id)).where(
            CareMessage.patient_id == patient.id,
            CareMessage.sender_role == UserRole.RESEARCHER.value,
            CareMessage.read_by_patient_at.is_(None),
        )
    ) or 0
    pending = db.scalar(
        select(func.count(PatientTask.id)).where(
            PatientTask.patient_id == patient.id,
            PatientTask.status == PatientTaskStatus.PENDING,
            or_(PatientTask.due_at.is_(None), PatientTask.due_at >= now),
        )
    ) or 0
    return CareSummaryResponse(unread_message_count=unread, pending_task_count=pending)


@router.post("/patient/messages/read", response_model=ReadReceiptResponse)
def mark_patient_messages_read(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> ReadReceiptResponse:
    patient = _get_patient_for_user(db, current_user)
    items = db.scalars(select(CareMessage).where(
        CareMessage.patient_id == patient.id,
        CareMessage.sender_role == UserRole.RESEARCHER.value,
        CareMessage.read_by_patient_at.is_(None),
    )).all()
    now = datetime.now(timezone.utc)
    for item in items:
        item.read_by_patient_at = now
    db.commit()
    return ReadReceiptResponse(updated_count=len(items))


@router.get("/doctor/patient/{patient_id}/summary", response_model=CareSummaryResponse)
def get_researcher_care_summary(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> CareSummaryResponse:
    _get_patient_for_researcher(db, patient_id, current_user.id)
    unread = db.scalar(select(func.count(CareMessage.id)).where(
        CareMessage.patient_id == patient_id,
        CareMessage.sender_role == UserRole.PATIENT.value,
        CareMessage.read_by_researcher_at.is_(None),
    )) or 0
    pending = db.scalar(select(func.count(PatientTask.id)).where(
        PatientTask.patient_id == patient_id,
        PatientTask.status == PatientTaskStatus.PENDING,
        or_(PatientTask.due_at.is_(None), PatientTask.due_at >= datetime.now(timezone.utc)),
    )) or 0
    return CareSummaryResponse(unread_message_count=unread, pending_task_count=pending)


@router.post("/doctor/patient/{patient_id}/messages/read", response_model=ReadReceiptResponse)
def mark_researcher_messages_read(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> ReadReceiptResponse:
    _get_patient_for_researcher(db, patient_id, current_user.id)
    items = db.scalars(select(CareMessage).where(
        CareMessage.patient_id == patient_id,
        CareMessage.sender_role == UserRole.PATIENT.value,
        CareMessage.read_by_researcher_at.is_(None),
    )).all()
    now = datetime.now(timezone.utc)
    for item in items:
        item.read_by_researcher_at = now
    db.commit()
    return ReadReceiptResponse(updated_count=len(items))


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
