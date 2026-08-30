from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_development_default_database_is_repository_sqlite() -> None:
    environment = os.environ.copy()
    environment["APP_ENV"] = "development"
    environment.pop("DATABASE_URL", None)
    environment.pop("MYSQL_PASSWORD", None)

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from backend.app.core.config import settings; print(settings.SQLALCHEMY_DATABASE_URI)",
        ],
        cwd=ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )

    database_url = result.stdout.strip()
    assert database_url.startswith("sqlite:///"), database_url
    assert database_url.endswith("backend/app.db"), database_url


def test_health_uses_temporary_sqlite(client, sqlite_database_path: Path) -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert sqlite_database_path.exists()


def test_production_requires_explicit_database_url() -> None:
    environment = os.environ.copy()
    environment["APP_ENV"] = "production"
    environment["SECRET_KEY"] = "production-test-secret"
    environment.pop("DATABASE_URL", None)

    result = subprocess.run(
        [sys.executable, "-c", "from backend.app.core.config import settings"],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "DATABASE_URL is required" in result.stderr


def test_production_rejects_placeholder_secret() -> None:
    environment = os.environ.copy()
    environment["APP_ENV"] = "production"
    environment["DATABASE_URL"] = "sqlite:///production-test.db"
    environment["SECRET_KEY"] = "change-me"

    result = subprocess.run(
        [sys.executable, "-c", "from backend.app.core.config import settings"],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "non-placeholder SECRET_KEY" in result.stderr
