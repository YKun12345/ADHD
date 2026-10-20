from fastapi import APIRouter, Request


router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
def health_check(request: Request) -> dict:
    from backend.app.services.assessment_templates import reference_enabled
    care = getattr(request.app.state, 'care_worker', None)
    agent = getattr(request.app.state, 'agent_worker', None)
    return {"status": "ok", "capabilities": {
        "reference_assessments": reference_enabled(),
        "care_worker_running": bool(care and care.running),
        "agent_worker_running": bool(agent and agent.thread and agent.thread.is_alive()),
    }}
