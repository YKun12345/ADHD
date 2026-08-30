from sqlalchemy import inspect
from sqlalchemy.orm import Session

from backend.app.core.security import get_password_hash
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
    UserRole,
    UserSubrole,
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
    if not missing_columns:
        return

    with engine.begin() as conn:
        for name, definition in missing_columns.items():
            conn.exec_driver_sql(f"ALTER TABLE model_predictions ADD COLUMN {name} {definition}")


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


def _ensure_default_dac_account() -> None:
    with Session(engine) as db:
        existing = db.query(User).filter(User.staff_id == "admin123").one_or_none()
        if existing is not None:
            existing.email = "admin123@qq.com"
            existing.password_hash = get_password_hash("admin1111")
            existing.role = UserRole.RESEARCHER
            existing.subrole = UserSubrole.DAC
            existing.is_active = True
            db.commit()
            return

        existing_email = db.query(User).filter(User.email.in_(["dac_admin@smartbrain.local", "dac_admin@smartbrainmap.com", "admin123@qq.com"])).one_or_none()
        if existing_email is not None:
            existing_email.email = "admin123@qq.com"
            existing_email.staff_id = "admin123"
            existing_email.password_hash = get_password_hash("admin1111")
            existing_email.role = UserRole.RESEARCHER
            existing_email.subrole = UserSubrole.DAC
            existing_email.is_active = True
            db.commit()
            return

        db.add(
            User(
                email="admin123@qq.com",
                staff_id="admin123",
                full_name="DAC 审计员",
                password_hash=get_password_hash("admin1111"),
                role=UserRole.RESEARCHER,
                subrole=UserSubrole.DAC,
                consent_agreed=True,
                is_active=True,
            )
        )
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
    _ensure_default_dac_account()
    _ensure_default_mcs_node()

    from backend.app.services.security_service import get_security_config, sync_security_runtime_entities

    with Session(engine) as db:
        config = get_security_config(db)
        if config is not None and config.is_initialized:
            sync_security_runtime_entities(db)
            db.commit()
