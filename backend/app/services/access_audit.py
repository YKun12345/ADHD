"""Record authenticated API reads, writes and rejected access without request bodies."""

from __future__ import annotations
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from backend.app.core.config import settings


def record_access(token: str, method: str, path: str, status_code: int) -> None:
    from backend.app.core.security import decode_access_token
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User
    from backend.app.models.patient import Patient
    from backend.app.services.security_service import _append_audit_log
    from sqlalchemy import select

    try:
        actor_id = int(decode_access_token(token)["sub"])
    except Exception:
        return
    with SessionLocal() as db:
        actor = db.get(User, actor_id)
        if actor is None:
            return
        import re

        target = re.search(r"/(?:patient|patients)/(\d+)(?:/|$)", path)
        patient = (
            db.get(Patient, int(target.group(1)))
            if target
            else db.scalar(select(Patient).where(Patient.user_id == actor_id))
        )
        _append_audit_log(
            db,
            action="access_denied"
            if status_code in (401, 403, 404)
            else ("data_read" if method == "GET" else "data_write"),
            status="denied"
            if status_code in (401, 403, 404)
            else ("success" if status_code < 400 else "failed"),
            message="访问权限拒绝。"
            if status_code in (401, 403, 404)
            else "接口访问已记录。",
            actor_user_id=actor_id,
            patient_id=patient.id if patient else None,
            detail_json={"method": method, "path": path, "http_status": status_code},
        )
        db.commit()


async def access_audit_middleware(request: Request, call_next):
    response = await call_next(request)
    authorization = request.headers.get("authorization", "")
    path = request.url.path
    if (
        path.startswith(settings.API_V1_STR + "/")
        and path != settings.API_V1_STR + "/health"
        and authorization.lower().startswith("bearer ")
    ):
        try:
            await run_in_threadpool(
                record_access,
                authorization[7:],
                request.method,
                path,
                response.status_code,
            )
        except Exception:
            from logging import getLogger

            getLogger("uvicorn.error").error(
                "Authenticated access audit failed; request_id/path=%s", path
            )
            return JSONResponse(
                status_code=503,
                content={
                    "detail": "Audit storage is unavailable. Please contact the administrator."
                },
            )
    return response
