from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.wsgi import WSGIMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from backend.app.api.router import api_router
from backend.app.core.config import settings
from backend.app.db.init_db import init_db


app = FastAPI(
    title=settings.PROJECT_NAME,
    version="0.1.0",
    description="Backend API for the ADHD multimodal demo platform.",
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
        app = self._ensure_app()
        await app(scope, receive, send)

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

@app.on_event("startup")
def on_startup() -> None:
    init_db()

@app.get("/", tags=["root"])
def read_root() -> dict[str, str]:
    return {
        "message": "ADHD Assist Platform API is running.",
        "docs": "/docs",
    }
