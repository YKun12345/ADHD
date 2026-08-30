from sqlalchemy import inspect
from sqlalchemy.orm import Session

from backend.app.db.base import Base
from backend.app.db.session import engine
from backend.app.models import (  # noqa: F401
    AIChatLog,
    CareMessage,
    CognitiveTest,
    ImagingVisualization,
    ModelPrediction,
    Patient,
    PatientTask,
    ScaleResult,
    SecurityAuditLog,
    SecurityAuditTask,
    SecurityCipherRecord,
    SecurityMcsNode,
    SecurityPatientAssignment,
    SecuritySystemConfig,
    SecurityUserKey,
    TrackingLog,
    Upload,
    User,
)


def _ensure_patient_assignment_column() -> None:
    inspector = inspect(engine)
    if "patients" not in inspector.get_table_names():
        return

    column_names = {column["name"] for column in inspector.get_columns("patients")}
    if "assigned_researcher_id" in column_names:
        return

    with engine.begin() as conn:
        if engine.dialect.name == "mysql":
            conn.exec_driver_sql(
                "ALTER TABLE patients "
                "ADD COLUMN assigned_researcher_id INTEGER NULL"
            )
            conn.exec_driver_sql(
                "CREATE INDEX ix_patients_assigned_researcher_id "
                "ON patients (assigned_researcher_id)"
            )
            conn.exec_driver_sql(
                "ALTER TABLE patients "
                "ADD CONSTRAINT fk_patients_assigned_researcher_id_users "
                "FOREIGN KEY (assigned_researcher_id) REFERENCES users(id) "
                "ON DELETE SET NULL"
            )
        elif engine.dialect.name == "sqlite":
            conn.exec_driver_sql("ALTER TABLE patients ADD COLUMN assigned_researcher_id INTEGER")


def _ensure_tracking_log_activities_column() -> None:
    inspector = inspect(engine)
    if "tracking_logs" not in inspector.get_table_names():
        return

    column_names = {column["name"] for column in inspector.get_columns("tracking_logs")}
    if "activities" in column_names:
        return

    with engine.begin() as conn:
        if engine.dialect.name == "mysql":
            conn.exec_driver_sql("ALTER TABLE tracking_logs ADD COLUMN activities VARCHAR(500) NULL")
        elif engine.dialect.name == "sqlite":
            conn.exec_driver_sql("ALTER TABLE tracking_logs ADD COLUMN activities VARCHAR(500)")


def _ensure_imaging_visualization_screenshot_columns() -> None:
    inspector = inspect(engine)
    if "imaging_visualizations" not in inspector.get_table_names():
        return

    column_names = {column["name"] for column in inspector.get_columns("imaging_visualizations")}
    screenshot_columns = {
        "slice_screenshot_name": "VARCHAR(255)",
        "slice_screenshot_data": "TEXT",
        "surface_screenshot_name": "VARCHAR(255)",
        "surface_screenshot_data": "TEXT",
        "slice_interpretation": "TEXT",
        "surface_interpretation": "TEXT",
    }
    missing_columns = {
        name: definition
        for name, definition in screenshot_columns.items()
        if name not in column_names
    }
    if not missing_columns:
        return

    with engine.begin() as conn:
        for name, definition in missing_columns.items():
            conn.exec_driver_sql(f"ALTER TABLE imaging_visualizations ADD COLUMN {name} {definition}")
        if engine.dialect.name == "mysql":
            conn.exec_driver_sql(
                "ALTER TABLE imaging_visualizations "
                "MODIFY COLUMN slice_screenshot_data LONGTEXT NULL, "
                "MODIFY COLUMN surface_screenshot_data LONGTEXT NULL"
            )


def _ensure_model_prediction_detail_columns() -> None:
    inspector = inspect(engine)
    if "model_predictions" not in inspector.get_table_names():
        return

    column_names = {column["name"] for column in inspector.get_columns("model_predictions")}
    detail_columns = {
        "upload_id": "INTEGER",
        "probability_control": "FLOAT",
        "roi_dim_used": "INTEGER",
        "timepoints": "INTEGER",
        "model_name": "VARCHAR(64)",
        "model_version": "VARCHAR(64)",
        "summary_text": "TEXT",
    }
    missing_columns = {
        name: definition
        for name, definition in detail_columns.items()
        if name not in column_names
    }
    if missing_columns:
        with engine.begin() as conn:
            for name, definition in missing_columns.items():
                conn.exec_driver_sql(f"ALTER TABLE model_predictions ADD COLUMN {name} {definition}")

    _ensure_model_prediction_upload_constraints()


def _ensure_model_prediction_upload_constraints() -> None:
    """Complete the legacy ``upload_id`` upgrade for supported databases."""

    inspector = inspect(engine)
    if not {"model_predictions", "uploads"}.issubset(inspector.get_table_names()):
        return

    if engine.dialect.name == "sqlite":
        # SQLite cannot add a FOREIGN KEY to an existing table. These triggers
        # provide the same insert/update and ON DELETE SET NULL semantics while
        # preserving the legacy table and its data.
        indexes = inspector.get_indexes("model_predictions")
        has_unique_upload_index = any(
            index.get("unique")
            and index.get("column_names") == ["upload_id"]
            for index in indexes
        )
        with engine.begin() as conn:
            if not has_unique_upload_index:
                conn.exec_driver_sql(
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_model_predictions_upload_id "
                    "ON model_predictions (upload_id)"
                )
            conn.exec_driver_sql(
                """
                CREATE TRIGGER IF NOT EXISTS trg_model_predictions_upload_insert
                BEFORE INSERT ON model_predictions
                FOR EACH ROW
                WHEN NEW.upload_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM uploads WHERE id = NEW.upload_id)
                BEGIN
                    SELECT RAISE(ABORT, 'model_predictions.upload_id references a missing upload');
                END
                """
            )
            conn.exec_driver_sql(
                """
                CREATE TRIGGER IF NOT EXISTS trg_model_predictions_upload_update
                BEFORE UPDATE OF upload_id ON model_predictions
                FOR EACH ROW
                WHEN NEW.upload_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM uploads WHERE id = NEW.upload_id)
                BEGIN
                    SELECT RAISE(ABORT, 'model_predictions.upload_id references a missing upload');
                END
                """
            )
            conn.exec_driver_sql(
                """
                CREATE TRIGGER IF NOT EXISTS trg_uploads_prediction_set_null
                AFTER DELETE ON uploads
                FOR EACH ROW
                BEGIN
                    UPDATE model_predictions SET upload_id = NULL WHERE upload_id = OLD.id;
                END
                """
            )
        return

    if engine.dialect.name == "mysql":
        indexes = inspector.get_indexes("model_predictions")
        has_unique_upload_index = any(
            index.get("unique")
            and index.get("column_names") == ["upload_id"]
            for index in indexes
        )
        foreign_keys = inspector.get_foreign_keys("model_predictions")
        has_upload_foreign_key = any(
            foreign_key.get("constrained_columns") == ["upload_id"]
            and foreign_key.get("referred_table") == "uploads"
            for foreign_key in foreign_keys
        )
        with engine.begin() as conn:
            if not has_unique_upload_index:
                conn.exec_driver_sql(
                    "CREATE UNIQUE INDEX ux_model_predictions_upload_id "
                    "ON model_predictions (upload_id)"
                )
            if not has_upload_foreign_key:
                conn.exec_driver_sql(
                    "ALTER TABLE model_predictions "
                    "ADD CONSTRAINT fk_model_predictions_upload_id_uploads "
                    "FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE SET NULL"
                )


def _ensure_user_security_columns() -> None:
    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return

    column_names = {column["name"] for column in inspector.get_columns("users")}
    missing_columns = {
        name: definition
        for name, definition in {
            "staff_id": "VARCHAR(64)",
            "subrole": "VARCHAR(16)",
        }.items()
        if name not in column_names
    }
    if not missing_columns:
        return

    with engine.begin() as conn:
        for name, definition in missing_columns.items():
            conn.exec_driver_sql(f"ALTER TABLE users ADD COLUMN {name} {definition}")


def _disable_legacy_fixed_dac_account() -> None:
    """Disable the old public demo administrator if an upgraded database contains it."""

    with Session(engine) as db:
        legacy_accounts = db.query(User).filter(
            (User.staff_id == "admin123") | (User.email == "admin123@qq.com")
        ).all()
        changed = False
        for account in legacy_accounts:
            if account.is_active:
                account.is_active = False
                changed = True
        if changed:
            db.commit()


def _ensure_default_mcs_node() -> None:
    with Session(engine) as db:
        existing = db.query(SecurityMcsNode).filter(SecurityMcsNode.node_code == "LOCAL-MCS-001").one_or_none()
        if existing is not None:
            existing.node_name = "Local Medical Cloud Server #1"
            existing.storage_backend = "local_db"
            existing.storage_namespace = "security_cipher_records"
            existing.is_active = True
            db.commit()
            return

        db.add(
            SecurityMcsNode(
                node_code="LOCAL-MCS-001",
                node_name="Local Medical Cloud Server #1",
                storage_backend="local_db",
                storage_namespace="security_cipher_records",
                is_active=True,
            )
        )
        db.commit()


def _ensure_security_runtime_columns() -> None:
    inspector = inspect(engine)
    if "security_cipher_records" in inspector.get_table_names():
        columns = {column["name"] for column in inspector.get_columns("security_cipher_records")}
        missing = {
            name: definition
            for name, definition in {
                "patient_assignment_id": "INTEGER",
                "mcs_node_id": "INTEGER",
            }.items()
            if name not in columns
        }
        with engine.begin() as conn:
            for name, definition in missing.items():
                conn.exec_driver_sql(f"ALTER TABLE security_cipher_records ADD COLUMN {name} {definition}")

    if "security_audit_tasks" in inspector.get_table_names():
        columns = {column["name"] for column in inspector.get_columns("security_audit_tasks")}
        missing = {
            name: definition
            for name, definition in {
                "patient_assignment_id": "INTEGER",
                "mcs_node_id": "INTEGER",
            }.items()
            if name not in columns
        }
        with engine.begin() as conn:
            for name, definition in missing.items():
                conn.exec_driver_sql(f"ALTER TABLE security_audit_tasks ADD COLUMN {name} {definition}")


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_user_security_columns()
    _ensure_patient_assignment_column()
    _ensure_tracking_log_activities_column()
    _ensure_imaging_visualization_screenshot_columns()
    _ensure_model_prediction_detail_columns()
    _ensure_security_runtime_columns()
    _disable_legacy_fixed_dac_account()
    _ensure_default_mcs_node()

    from backend.app.services.security_service import get_security_config, sync_security_runtime_entities

    with Session(engine) as db:
        config = get_security_config(db)
        if config is not None and config.is_initialized:
            sync_security_runtime_entities(db)
            db.commit()
