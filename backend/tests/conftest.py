from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def isolated_runtime(monkeypatch, tmp_path):
    """Even subprocess and unit tests must never load development .env or real stores."""
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'isolated-unit.db').as_posix()}")
    monkeypatch.setenv("AUTHORIZATION_LEDGER_PATH", str(tmp_path / "authorization-heads.db"))
    monkeypatch.setenv("DATA_ENCRYPTION_KEY", "dGVzdC1rZXktMzItYnl0ZXMtaXNvbGF0ZWQtMDAwMDE=")
    monkeypatch.setenv("SECRET_KEY", "test-only-secret")
    monkeypatch.setenv("SECURITY_MASTER_KEY_PATH", str(tmp_path / "keys" / "data.key"))
    monkeypatch.setenv("UPLOAD_ROOT", str(tmp_path / "uploads"))
    monkeypatch.setenv("FINDVIZ_CACHE_ROOT", str(tmp_path / "findviz"))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    monkeypatch.setenv("CARE_WORKER_ENABLED","false")
    monkeypatch.setenv('AGENT_WORKER_ENABLED','false')
    for name in ('WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'WECHAT_SUBSCRIBE_TEMPLATE_ID',
                 'WECHAT_SUBSCRIBE_TITLE_FIELD', 'WECHAT_SUBSCRIBE_TIME_FIELD'):
        monkeypatch.setenv(name, '')
    monkeypatch.setenv('WECHAT_NOTIFICATION_SEND_ENABLED', 'false')
    monkeypatch.setenv('WECHAT_NOTIFICATION_WORKER_ENABLED', 'false')
    monkeypatch.setenv('WECHAT_MINIPROGRAM_STATE', 'formal')


@pytest.fixture
def sqlite_database_path(tmp_path: Path) -> Path:
    return tmp_path / "backend-test.db"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, sqlite_database_path: Path):
    database_url = f"sqlite:///{sqlite_database_path.as_posix()}"
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("DATA_ENCRYPTION_KEY", "dGVzdC1rZXktMzItYnl0ZXMtaXNvbGF0ZWQtMDAwMDE=")
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("SECRET_KEY", "test-only-secret")
    monkeypatch.setenv("AUTHORIZATION_LEDGER_PATH", str(sqlite_database_path.parent / "authorization-heads.db"))
    monkeypatch.setenv("SECURITY_MASTER_KEY_PATH", str(sqlite_database_path.parent / "keys" / "data.key"))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    monkeypatch.setenv("UPLOAD_ROOT", str(sqlite_database_path.parent / "uploads"))
    monkeypatch.setenv("UPLOAD_MAX_BYTES", "64")

    for module_name in list(sys.modules):
        if module_name.startswith("backend.app"):
            sys.modules.pop(module_name)

    from backend.app.main import app

    with TestClient(app) as test_client:
        yield test_client

    from backend.app.db.session import engine

    engine.dispose()
