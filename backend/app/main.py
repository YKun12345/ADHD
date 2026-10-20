from contextlib import asynccontextmanager
from logging import getLogger
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.wsgi import WSGIMiddleware
from fastapi.staticfiles import StaticFiles

from backend.app.api.router import api_router
from backend.app.core.config import settings
from backend.app.db.init_db import init_db

startup_logger = getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(application: FastAPI):
    init_db()
    from backend.app.services.hgst_runtime.service import describe_model_mode

    startup_logger.info("Model inference mode: %s", describe_model_mode())
    runtime = None
    if settings.CARE_WORKER_ENABLED:
        from backend.app.db.session import SessionLocal
        from backend.app.workers.care_worker_runtime import CareWorkerRuntime
        runtime = CareWorkerRuntime(SessionLocal,interval_seconds=settings.CARE_WORKER_INTERVAL_SECONDS,
            lease_seconds=settings.CARE_WORKER_LEASE_SECONDS)
        runtime.start()
    application.state.care_worker = runtime
    agent_runtime=None
    if settings.AGENT_WORKER_ENABLED:
        from backend.app.db.session import SessionLocal
        from backend.app.workers.agent_worker import AgentWorkerRuntime
        agent_runtime=AgentWorkerRuntime(SessionLocal,interval_seconds=settings.AGENT_WORKER_INTERVAL_SECONDS)
        agent_runtime.start()
    application.state.agent_worker=agent_runtime
    notification_runtime = None
    from backend.app.services.wechat_notification_provider import WechatNotificationConfig
    if WechatNotificationConfig.from_environment().worker_enabled:
        from backend.app.db.session import SessionLocal
        from backend.app.workers.notification_worker import NotificationWorkerRuntime
        notification_runtime = NotificationWorkerRuntime(SessionLocal)
        notification_runtime.start()
    application.state.notification_worker = notification_runtime
    federated_runtime = None
    if settings.FEDERATED_WORKER_ENABLED:
        from backend.app.db.session import SessionLocal
        from backend.app.workers.federated_worker import FederatedWorkerRuntime
        federated_runtime = FederatedWorkerRuntime(SessionLocal)
        federated_runtime.start()
    application.state.federated_worker = federated_runtime
    try:
        yield
    finally:
        if federated_runtime is not None and not await run_in_threadpool(federated_runtime.stop, timeout=15):
            startup_logger.warning('Federated worker is stopping; the durable lease and budget remain authoritative.')
        if notification_runtime is not None and not await run_in_threadpool(notification_runtime.stop, timeout=5):
            startup_logger.warning('Notification worker is still finishing a bounded call; uncertain deliveries will not be resent.')
        if agent_runtime is not None and not await run_in_threadpool(agent_runtime.stop,timeout=5):
            startup_logger.warning('Agent recovery scan is still stopping; durable run IDs are retained.')
        from backend.app.services.agent.runner import shutdown_background
        if not await run_in_threadpool(shutdown_background, timeout=5):
            startup_logger.warning('Agent jobs are finishing a bounded call; queued records remain queryable.')
        if runtime is not None and not await run_in_threadpool(runtime.stop,timeout=5):
            startup_logger.error("Care worker is still finishing an active transaction after the shutdown wait.")


app = FastAPI(
    title=settings.PROJECT_NAME,
    version="0.1.0",
    description="Backend API for the ADHD multimodal demo platform.",
    lifespan=lifespan,
)

from backend.app.core.record_envelope import RecordIntegrityError
from fastapi.exceptions import RequestValidationError


@app.exception_handler(RecordIntegrityError)
async def record_integrity_error(request, exc):
    return JSONResponse(status_code=503,content={"detail":"记录完整性校验失败，当前资料不予披露。"},headers={"Cache-Control":"no-store"})


@app.exception_handler(RequestValidationError)
async def validation_error(request,exc):
    # Validation errors must not echo health payloads, credentials or a JSON
    # overflow number that would make the error response itself unserializable.
    return JSONResponse(status_code=422,content={"detail":[{"loc":list(error["loc"]),"msg":error["msg"],"type":error["type"]} for error in exc.errors()]})


class LazyFindvizMount:
    def __init__(self) -> None:
        self._app = None

    def _ensure_app(self):
        if self._app is None:
            from findviz import create_app as create_findviz_app

            self._app = WSGIMiddleware(create_findviz_app(clear_cache=False))
        return self._app

    async def __call__(self, scope, receive, send):
        from backend.app.services.findviz_access import authorize_scope
        from findviz.workspace import workspace_context
        from findviz.request_security import bounded_wsgi_body, UploadBodyTooLarge, upload_limit_error
        path = scope["path"]
        root_path = scope.get("root_path", "")
        relative_path = path[len(root_path):] if root_path and path.startswith(root_path) else path
        workspace = None
        if not relative_path.startswith("/static/"):
            try:
                workspace = await run_in_threadpool(authorize_scope, scope)
            except HTTPException as exc:
                response = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
                await response(scope, receive, send)
                return
            except Exception:
                startup_logger.exception("Imaging workspace authorization/audit failed")
                response = JSONResponse(status_code=503, content={"detail": "影像授权服务暂不可用。"})
                await response(scope, receive, send)
                return
        try:
            buffered_request = await bounded_wsgi_body(scope, receive)
        except UploadBodyTooLarge:
            response = JSONResponse(status_code=413, content=upload_limit_error())
            await response(scope, receive, send)
            return
        if buffered_request is None:
            return
        wsgi_scope, replay = buffered_request
        if workspace is None:
            await self._ensure_app()(wsgi_scope, replay, send)
            return
        from backend.app.services.findviz_access import recheck_workspace
        buffered_response = []
        async def buffer_send(message):
            buffered_response.append(message)
        with workspace_context(workspace.namespace, workspace.patient_id, lambda:recheck_workspace(workspace)):
            await self._ensure_app()(wsgi_scope, replay, buffer_send)
        try:
            await run_in_threadpool(recheck_workspace,workspace)
        except HTTPException as exc:
            response = JSONResponse(status_code=exc.status_code,content={"detail":exc.detail},headers={"Cache-Control":"no-store"})
            await response(scope,receive,send)
            return
        for message in buffered_response:
            await send(message)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[*settings.cors_origins, "null"],
    allow_origin_regex=(
        r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
        r"|^https?://(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from backend.app.services.access_audit import access_audit_middleware
app.middleware("http")(access_audit_middleware)


def _recheck_response_authority(receipts, credentials, actor_id):
    from backend.app.db.session import SessionLocal
    from backend.app.services.authorization_ledger import read_heads
    from backend.app.services.identity_access import recheck_receipts, recheck_authorities, recheck_authenticated_actor
    # The whole synchronous scope belongs to one worker thread. Keep every
    # current-head check; never hold a database session across an async wait.
    with read_heads(), SessionLocal() as db:
        if actor_id is not None:
            recheck_authenticated_actor(db, actor_id)
        recheck_receipts(db, receipts)
        recheck_authorities(db, credentials)


@app.middleware("http")
async def recheck_authorization_before_response(request, call_next):
    response = await call_next(request)
    receipts = getattr(request.state,"authorization_receipts",[])
    credentials = getattr(request.state,"credential_receipts",[])
    actor_id = getattr(request.state,"authenticated_actor_id",None)
    if response.status_code < 400 and (receipts or credentials or actor_id is not None):
        try:
            await run_in_threadpool(_recheck_response_authority, receipts, credentials, actor_id)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code,content={"detail":exc.detail},headers={"Cache-Control":"no-store"})
    if receipts or credentials or actor_id is not None:
        response.headers["Cache-Control"] = "no-store"
    elif (request.url.path.startswith(("/doctor-web/", "/patient-web/"))
          and request.url.path.endswith((".html", ".js", ".css"))):
        # Revalidate the page and its scripts together after a local product update.
        response.headers["Cache-Control"] = "no-cache"
    return response
app.include_router(api_router, prefix=settings.API_V1_STR)

# Ensure BASE_DIR is available
BASE_DIR = Path(__file__).resolve().parents[2]

# Add specific static mount for findviz templates to prevent WSGI shadowing
app.mount("/findviz/templates", StaticFiles(directory=str(BASE_DIR / "findviz" / "templates")), name="findviz_templates")
app.mount("/findviz", LazyFindvizMount())
app.mount(
    "/doctor-web",
    StaticFiles(directory=str(BASE_DIR / "doctor-web"), html=True),
    name="doctor_web",
)
app.mount(
    "/patient-web",
    StaticFiles(directory=str(BASE_DIR / "patient-web"), html=True),
    name="patient_web",
)

@app.get("/", tags=["root"])
def read_root() -> dict[str, str]:
    return {
        "message": "ADHD Assist Platform API is running.",
        "docs": "/docs",
        "patient_web": "/patient-web/",
        "doctor_web": "/doctor-web/",
    }
