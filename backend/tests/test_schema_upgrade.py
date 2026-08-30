from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


def test_legacy_sqlite_model_prediction_upload_link_is_constrained(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE model_predictions (
                id INTEGER PRIMARY KEY,
                patient_id INTEGER NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                prediction_label VARCHAR(32) NOT NULL,
                probability FLOAT NOT NULL,
                source_type VARCHAR(32) NOT NULL,
                created_at DATETIME NOT NULL
            )
            """
        )

    environment = os.environ.copy()
    environment.update(
        {
            "APP_ENV": "test",
            "DATABASE_URL": f"sqlite:///{database_path.as_posix()}",
            "SECRET_KEY": "schema-upgrade-test-secret",
            "QWEN_API_KEY": "",
        }
    )
    result = subprocess.run(
        [sys.executable, "-c", "from backend.app.db.init_db import init_db; init_db()"],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr

    with sqlite3.connect(database_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(model_predictions)")}
        indexes = list(connection.execute("PRAGMA index_list(model_predictions)"))
        triggers = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'trigger'"
            )
        }
        assert "upload_id" in columns
        assert any(row[1] == "ux_model_predictions_upload_id" and row[2] == 1 for row in indexes)
        assert {
            "trg_model_predictions_upload_insert",
            "trg_model_predictions_upload_update",
            "trg_uploads_prediction_set_null",
        }.issubset(triggers)

        connection.execute(
            """
            INSERT INTO uploads
                (id, uploader_id, file_name, source_type, file_size, status, stored_path, created_at)
            VALUES (10, 999, 'scan.csv', 'fMRI_1D', 3, 'uploaded', '/tmp/scan.csv', CURRENT_TIMESTAMP)
            """
        )
        base_prediction = (
            1,
            "scan.csv",
            "Control",
            0.2,
            "fmri_hgst",
        )
        connection.execute(
            """
            INSERT INTO model_predictions
                (patient_id, file_name, prediction_label, probability, source_type, created_at, upload_id)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 10)
            """,
            base_prediction,
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO model_predictions
                    (patient_id, file_name, prediction_label, probability, source_type, created_at, upload_id)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 10)
                """,
                base_prediction,
            )
        connection.execute("DELETE FROM uploads WHERE id = 10")
        linked_upload_id = connection.execute(
            "SELECT upload_id FROM model_predictions WHERE id = 1"
        ).fetchone()[0]
        assert linked_upload_id is None
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO model_predictions
                    (patient_id, file_name, prediction_label, probability, source_type, created_at, upload_id)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 404)
                """,
                base_prediction,
            )


def test_mysql_upload_link_migration_declares_unique_foreign_key() -> None:
    migration = ROOT / "backend" / "sql" / "migrations" / "20260830_model_prediction_upload_link_mysql.sql"
    text = migration.read_text(encoding="utf-8")

    assert "UNIQUE INDEX ux_model_predictions_upload_id" in text
    assert "FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE SET NULL" in text
