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
async def lifespan(_: FastAPI):
    init_db()
    from backend.app.services.hgst_runtime.service import describe_model_mode

    startup_logger.info("Model inference mode: %s", describe_model_mode())
    yield


app = FastAPI(
    title=settings.PROJECT_NAME,
    version="0.1.0",
    description="Backend API for the ADHD multimodal demo platform.",
    lifespan=lifespan,
)


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
        with workspace_context(workspace.namespace, workspace.patient_id):
            await self._ensure_app()(wsgi_scope, replay, send)


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
