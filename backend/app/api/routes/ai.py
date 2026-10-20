"""Compatibility boundary for clients predating the durable unified Agent.

The old request has no patient selection, signed input head or original ID.
It cannot safely become a durable Agent submission without those fields.
"""
from fastapi import APIRouter, Depends, HTTPException
from backend.app.api.deps import require_roles
from backend.app.models.user import User, UserRole
from backend.app.schemas.ai import AIChatRequest, AIExplainReportRequest, AIReminderRequest, AIStatusResponse

router = APIRouter(prefix="/ai", tags=["ai"])


def unified_agent_required() -> None:
    raise HTTPException(410, detail={
        "code": "UNIFIED_AGENT_REQUIRED",
        "message": "助手已升级，请进入统一助手，选择获准档案后继续提问。旧请求未提交，也未生成回答。",
        "web_page": "patient_ai.html",
        "mini_page": "/pages/agent-chat/index",
        "prepare_path": "/agent/run-context",
        "submit_path": "/agent/runs",
        "original_query_path": "/agent/runs/submissions/{client_run_id}",
    })


@router.get("/status", response_model=AIStatusResponse)
def get_ai_status(current_user: User = Depends(require_roles(UserRole.PATIENT))) -> AIStatusResponse:
    return AIStatusResponse(
        configured=False, provider="local", chat_model="unified-agent",
        reminder_model="unified-agent", fallback_available=False,
        message="旧助手接口已迁移到统一助手。请进入 patient_ai.html 或小程序统一助手继续。",
    )


@router.post("/chat", deprecated=True)
def chat_with_ai(payload: AIChatRequest, current_user: User = Depends(require_roles(UserRole.PATIENT))):
    unified_agent_required()


@router.post("/explain_report", deprecated=True)
def explain_report(payload: AIExplainReportRequest | None = None,
                   current_user: User = Depends(require_roles(UserRole.PATIENT))):
    unified_agent_required()


@router.post("/generate_reminder", deprecated=True)
def generate_reminder(payload: AIReminderRequest | None = None,
                      current_user: User = Depends(require_roles(UserRole.PATIENT))):
    unified_agent_required()
