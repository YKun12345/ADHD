from backend.app.services.identity_access import require_patient_access, resolve_patient
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from backend.app.api.deps import get_db, require_roles, get_current_user
from backend.app.models.ai_chat_log import AIChatLog
from backend.app.models.care_message import CareMessage
from backend.app.services import legacy_message_service
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


@router.get('/capabilities')
def care_capabilities(user: User = Depends(get_current_user)):
    from backend.app.services.care_capabilities import response
    return response()


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
        suspension_reason=task.suspension_reason,
        assessment_id=task.assessment_id,
        assessment_item_id=task.assessment_item_id,
        legacy=task.legacy,
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


def _get_patient_for_researcher(db: Session, patient_id: int, researcher_id: int) -> Patient:
    return require_patient_access(db, db.get(User,researcher_id), patient_id, "care")


def _get_patient_for_user(db: Session, current_user: User) -> Patient:
    return resolve_patient(db,current_user,"care")


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

    if task.assessment_item_id is not None:
        raise HTTPException(409, "评估项目必须由真实结果提交推进，不能手动标记完成。")

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
    db.info["requires_basic_use"] = False
    _get_patient_for_researcher(db, patient_id, current_user.id)
    raise HTTPException(409,"请选择具体医患关系并取得原始发送上下文，再使用 /care/shared-messages 确认发送；旧消息接口已只读。")


@router.post("/patient/messages", response_model=CareMessageResponse, status_code=status.HTTP_201_CREATED)
def create_patient_message(
    payload: CareMessageCreateRequest,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> CareMessageResponse:
    db.info["requires_basic_use"] = False
    _get_patient_for_user(db, current_user)
    raise HTTPException(409,"请选择具体医患关系并取得原始发送上下文，再使用 /care/shared-messages 确认发送；旧消息接口已只读。")


@router.get("/doctor/patient/{patient_id}/messages", response_model=CareMessageListResponse)
def get_researcher_messages(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> CareMessageListResponse:
    result = legacy_message_service.unavailable_doctor_history(db,current_user,patient_id)
    return _commit_cycle_response(db,CareMessageListResponse(**result))


@router.get("/patient/messages", response_model=CareMessageListResponse)
def get_patient_messages(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> CareMessageListResponse:
    db.info["requires_basic_use"] = False
    patient = _get_patient_for_user(db, current_user)
    items = legacy_message_service.own_history(db,current_user,patient.id)
    result = CareMessageListResponse(items=[_message_response(item,UserRole.PATIENT.value) for item in items],
        legacy_scope_status="own_history_only")
    return _commit_cycle_response(db,result)


@router.get("/patient/summary", response_model=CareSummaryResponse)
def get_patient_care_summary(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> CareSummaryResponse:
    db.info["requires_basic_use"] = False
    patient = _get_patient_for_user(db, current_user)
    now = datetime.now(timezone.utc)
    unread = legacy_message_service.scoped_unread_count(db,current_user,patient.id)
    pending = db.scalar(
        select(func.count(PatientTask.id)).where(
            PatientTask.patient_id == patient.id,
            PatientTask.status == PatientTaskStatus.PENDING,
            or_(PatientTask.due_at.is_(None), PatientTask.due_at >= now),
        )
    ) or 0
    return _commit_cycle_response(db,CareSummaryResponse(unread_message_count=unread,pending_task_count=pending,
        legacy_scope_status="own_history_only"))


@router.post("/patient/messages/read", response_model=ReadReceiptResponse)
def mark_patient_messages_read(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> ReadReceiptResponse:
    db.info["requires_basic_use"] = False
    _get_patient_for_user(db,current_user)
    raise HTTPException(409,"旧历史缺少逐人阅读依据；请使用 /care/shared-messages/{message_id}/read 记录实际阅读者，不表示专业处理。")


@router.get("/doctor/patient/{patient_id}/summary", response_model=CareSummaryResponse)
def get_researcher_care_summary(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> CareSummaryResponse:
    db.info["requires_basic_use"] = False
    _get_patient_for_researcher(db, patient_id, current_user.id)
    unread = legacy_message_service.scoped_unread_count(db,current_user,patient_id)
    pending = db.scalar(select(func.count(PatientTask.id)).where(
        PatientTask.patient_id == patient_id,
        PatientTask.status == PatientTaskStatus.PENDING,
        or_(PatientTask.due_at.is_(None), PatientTask.due_at >= datetime.now(timezone.utc)),
    )) or 0
    return _commit_cycle_response(db,CareSummaryResponse(unread_message_count=unread,pending_task_count=pending,
        legacy_scope_status="unverified_relationship"))


@router.post("/doctor/patient/{patient_id}/messages/read", response_model=ReadReceiptResponse)
def mark_researcher_messages_read(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> ReadReceiptResponse:
    db.info["requires_basic_use"] = False
    _get_patient_for_researcher(db, patient_id, current_user.id)
    raise HTTPException(409,"旧消息原关系不可核验，不能共用医生已读；请使用 /care/shared-messages/{message_id}/read 记录实际阅读者，不表示专业处理。")


@router.get("/doctor/patient/{patient_id}/ai_logs", response_model=AIChatLogListResponse)
def get_researcher_ai_logs(
    patient_id: int,
    current_user: User = Depends(require_roles(UserRole.RESEARCHER)),
    db: Session = Depends(get_db),
) -> AIChatLogListResponse:
    if db.get(Patient,patient_id) is None:
        raise HTTPException(status_code=404,detail="Patient not found.")
    raise HTTPException(status_code=403,detail="Private AI conversations are not included in clinical sharing.")
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

# W03 adds creation/launch boundaries; result submission is intentionally W04/W05.
from backend.app.schemas.assessment import (AssessmentCreateRequest, AssessmentPublishRequest, TaskAttemptCreateRequest, AssessmentSessionResponse, AssessmentListResponse, TaskAttemptResponse)
from backend.app.services import assessment_service
from backend.app.services.assessment_templates import registry_response


@router.get('/assessment-templates')
def get_assessment_templates(patient_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    patient = require_patient_access(db, current_user, patient_id, 'assessment')
    return assessment_service.template_response(db,current_user,patient)


@router.post('/patient/assessments', response_model=AssessmentSessionResponse, status_code=201)
def create_self_assessment(payload: AssessmentCreateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return assessment_service.create_assessment(db, current_user, payload, 'self')


@router.post('/doctor/assessments', response_model=AssessmentSessionResponse, status_code=201)
def create_doctor_assessment(payload: AssessmentCreateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return assessment_service.create_assessment(db, current_user, payload, 'doctor_assigned')


@router.get('/assessments', response_model=AssessmentListResponse)
def get_assessments(patient_id: int | None = None, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return assessment_service.list_assessments(db, current_user, patient_id)


@router.get('/assessments/{assessment_id}', response_model=AssessmentSessionResponse)
def get_assessment(assessment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return assessment_service.get_assessment(db, current_user, assessment_id)


@router.post('/assessments/{assessment_id}/publish', response_model=AssessmentSessionResponse)
def publish_assessment(assessment_id: int, payload: AssessmentPublishRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return assessment_service.publish_assessment(db, current_user, assessment_id, payload)


@router.post('/assessment-items/{item_id}/attempts', response_model=TaskAttemptResponse, status_code=201)
def create_assessment_attempt(item_id: int, payload: TaskAttemptCreateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return assessment_service.create_attempt(db, current_user, item_id, payload)


from fastapi import Response
from backend.app.schemas.submission import SubmissionCreate,SubmissionAck
from backend.app.services import submission_service


@router.post('/submissions',response_model=SubmissionAck,status_code=201)
def create_submission(payload: SubmissionCreate,response:Response,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    result,created = submission_service.submit(db,current_user,payload)
    response.status_code = 201 if created else 200
    return result


@router.get('/submissions/{submission_id}',response_model=SubmissionAck)
def get_submission(submission_id:str,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return submission_service.get_submission(db,current_user,submission_id)


@router.get('/submissions/{submission_id}/evidence')
def get_submission_evidence(submission_id:str,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return submission_service.get_evidence(db,current_user,submission_id)


@router.get('/patient/attention')
def get_patient_attention(patient_id:int|None=None,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    from backend.app.services.attention_service import patient_attention
    return patient_attention(db,current_user,patient_id)


@router.get('/doctor/work_queue')
def get_doctor_work_queue(current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    from backend.app.services.attention_service import doctor_work_queue
    return doctor_work_queue(db,current_user)


# W05 services append facts/events/critical audit; routes own the final commit.
from datetime import date
from backend.app.schemas.care_cycle import CareCycleCreate, DailyRecordCreate
from backend.app.services import care_cycle_service
from backend.app.services.event_service import mark_transaction_audit_committed


def _commit_cycle_response(db, result):
    try:
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(503,"Care transaction could not be committed; query or retry the original ID.") from exc
    mark_transaction_audit_committed(db)
    return result


@router.post('/cycles',status_code=201)
def create_care_cycle(payload:CareCycleCreate,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,care_cycle_service.create_cycle(db,current_user,payload))


@router.get('/cycles')
def list_care_cycles(patient_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,care_cycle_service.list_cycles(db,current_user,patient_id))


@router.get('/cycles/{cycle_id}')
def get_care_cycle(cycle_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,care_cycle_service.get_cycle(db,current_user,cycle_id))


@router.post('/daily-records',status_code=201)
def create_daily_record(payload:DailyRecordCreate,response:Response,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    result,created = care_cycle_service.submit_daily_record(db,current_user,payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db,result)


@router.get('/daily-records/{client_submission_id}')
def get_daily_record(client_submission_id:str,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,care_cycle_service.get_daily_record(db,current_user,client_submission_id))


@router.get('/cycles/{cycle_id}/daily-history')
def get_daily_history(cycle_id:int,record_date:date,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,care_cycle_service.daily_history(db,current_user,cycle_id,record_date))


from backend.app.schemas.shared_message import SharedMessageCreate
from backend.app.services import care_message_service


@router.get('/shared-messages/relationships')
def get_shared_message_relationships(patient_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,care_message_service.list_message_relationships(db,current_user,patient_id))


@router.post('/shared-messages',status_code=201)
def create_shared_message(payload:SharedMessageCreate,response:Response,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    result,created = care_message_service.send_message(db,current_user,payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db,result)


@router.get('/shared-messages')
def get_shared_messages(patient_id:int,relationship_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,care_message_service.list_messages(db,current_user,patient_id,relationship_id))


@router.get('/shared-messages/submissions/{client_message_id}')
def get_shared_message_submission(client_message_id:str,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,care_message_service.get_original_message(db,current_user,client_message_id))


@router.post('/shared-messages/{message_id}/read')
def read_shared_message(message_id:int,current_user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    return _commit_cycle_response(db,care_message_service.mark_message_read(db,current_user,message_id))
