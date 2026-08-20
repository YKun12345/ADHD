from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.app.api.deps import get_db, require_roles
from backend.app.core.config import settings
from backend.app.models.ai_chat_log import AIChatLog
from backend.app.models.patient import Patient
from backend.app.models.user import User, UserRole
from backend.app.schemas.ai import (
    AIChatRequest,
    AIChatResponse,
    AIExplainReportRequest,
    AIExplainReportResponse,
    AIReminderRequest,
    AIReminderResponse,
    AIStatusResponse,
)
from backend.app.services.ai_service import (
    AI_DISCLAIMER,
    ai_status_message,
    build_patient_snapshot,
    generate_chat_reply,
    generate_report_explanation,
    generate_tracking_reminder,
    used_context_for_scope,
)


router = APIRouter(prefix="/ai", tags=["ai"])


def _store_ai_chat_turns(
    db: Session,
    current_user: User,
    user_message: str,
    assistant_reply: str,
    scope: str,
) -> None:
    patient = db.scalar(select(Patient).where(Patient.user_id == current_user.id))
    if patient is None:
        return

    logs = [
        AIChatLog(
            patient_id=patient.id,
            role="user",
            scope=scope,
            content=user_message.strip(),
        ),
        AIChatLog(
            patient_id=patient.id,
            role="assistant",
            scope=scope,
            content=assistant_reply.strip(),
        ),
    ]
    db.add_all(logs)
    db.commit()


@router.get("/status", response_model=AIStatusResponse)
def get_ai_status(
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
) -> AIStatusResponse:
    return AIStatusResponse(
        configured=bool(settings.QWEN_API_KEY),
        chat_model=settings.QWEN_CHAT_MODEL,
        reminder_model=settings.QWEN_REMINDER_MODEL,
        message=ai_status_message(),
    )


@router.post("/chat", response_model=AIChatResponse)
def chat_with_ai(
    payload: AIChatRequest,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> AIChatResponse:
    snapshot = build_patient_snapshot(db, current_user)
    reply, model, degraded = generate_chat_reply(
        message=payload.message,
        conversation=[turn.model_dump() for turn in payload.conversation],
        context_scope=payload.context_scope,
        snapshot=snapshot,
    )
    _store_ai_chat_turns(db, current_user, payload.message, reply, payload.context_scope)
    return AIChatResponse(
        reply=reply,
        model=model,
        disclaimer=AI_DISCLAIMER,
        degraded=degraded,
        used_context=used_context_for_scope(payload.context_scope, snapshot),
    )


@router.post("/explain_report", response_model=AIExplainReportResponse)
def explain_report(
    payload: AIExplainReportRequest | None = None,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> AIExplainReportResponse:
    snapshot = build_patient_snapshot(db, current_user)
    explanation, model, degraded = generate_report_explanation(snapshot, payload.focus if payload else None)
    return AIExplainReportResponse(
        headline=explanation["headline"],
        plain_summary=explanation["plain_summary"],
        key_findings=explanation["key_findings"],
        next_actions=explanation["next_actions"],
        disclaimer=explanation["disclaimer"],
        model=model,
        degraded=degraded,
    )


@router.post("/generate_reminder", response_model=AIReminderResponse)
def generate_reminder(
    payload: AIReminderRequest | None = None,
    current_user: User = Depends(require_roles(UserRole.PATIENT)),
    db: Session = Depends(get_db),
) -> AIReminderResponse:
    snapshot = build_patient_snapshot(db, current_user)
    tone = payload.tone if payload else "gentle"
    reminder, model, degraded = generate_tracking_reminder(snapshot, tone=tone)
    return AIReminderResponse(
        should_remind=reminder["should_remind"],
        title=reminder["title"],
        message=reminder["message"],
        action_label=reminder["action_label"],
        completion_status=reminder["completion_status"],
        disclaimer=reminder["disclaimer"],
        model=model,
        degraded=degraded,
    )
