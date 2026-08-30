from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from sqlalchemy import func, select


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


def test_static_routes_expose_only_the_doctor_web(client) -> None:
    assert client.get("/doctor-web/login.html").status_code == 200
    for private_path in (
        "/backend/app/main.py",
        "/miniprogram/app.json",
        "/archive/legacy-patient-web/patient_home.html",
    ):
        assert client.get(private_path).status_code == 404, private_path


def test_startup_does_not_provision_a_fixed_dac_account(client) -> None:
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User, UserSubrole

    with SessionLocal() as db:
        dac_count = db.scalar(
            select(func.count()).select_from(User).where(User.subrole == UserSubrole.DAC)
        )
    assert dac_count == 0


def test_startup_disables_an_existing_legacy_fixed_dac_account(client) -> None:
    from backend.app.core.security import get_password_hash
    from backend.app.db.init_db import init_db
    from backend.app.db.session import SessionLocal
    from backend.app.models.user import User, UserRole, UserSubrole

    with SessionLocal() as db:
        legacy = User(
            email="admin123@qq.com",
            staff_id="admin123",
            full_name="Legacy DAC",
            password_hash=get_password_hash("admin1111"),
            role=UserRole.RESEARCHER,
            subrole=UserSubrole.DAC,
            consent_agreed=True,
            is_active=True,
        )
        db.add(legacy)
        db.commit()
        legacy_id = legacy.id

    init_db()

    with SessionLocal() as db:
        assert db.get(User, legacy_id).is_active is False


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


def test_backend_import_avoids_owned_deprecations(tmp_path: Path) -> None:
    environment = os.environ.copy()
    environment.update(
        {
            "APP_ENV": "test",
            "DATABASE_URL": f"sqlite:///{(tmp_path / 'warnings.db').as_posix()}",
            "SECRET_KEY": "warning-test-secret",
            "QWEN_API_KEY": "",
        }
    )

    result = subprocess.run(
        [
            sys.executable,
            "-W",
            "always::DeprecationWarning",
            "-c",
            "from backend.app.main import app",
        ],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "on_event is deprecated" not in result.stderr
    assert "class-based `config` is deprecated" not in result.stderr
