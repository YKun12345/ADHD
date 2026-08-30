from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def sqlite_database_path(tmp_path: Path) -> Path:
    return tmp_path / "backend-test.db"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, sqlite_database_path: Path):
    database_url = f"sqlite:///{sqlite_database_path.as_posix()}"
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("SECRET_KEY", "test-only-secret")
    monkeypatch.setenv("QWEN_API_KEY", "")

    for module_name in list(sys.modules):
        if module_name.startswith("backend.app"):
            sys.modules.pop(module_name)

    from backend.app.main import app

    with TestClient(app) as test_client:
        yield test_client

    from backend.app.db.session import engine

    engine.dispose()
