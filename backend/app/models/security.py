from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base


class SecuritySystemConfig(Base):
    __tablename__ = "security_system_configs"

    id: Mapped[int] = mapped_column(primary_key=True)
    is_initialized: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    initialized_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    system_version: Mapped[str] = mapped_column(String(32), default="vmemda-lite-v1", nullable=False)
    storage_mode: Mapped[str] = mapped_column(String(32), default="local_mcs_db", nullable=False)
    public_params_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    secret_params_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    profile_params_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class SecurityUserKey(Base):
    __tablename__ = "security_user_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    patient_id: Mapped[int | None] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=True,
    )
    key_role: Mapped[str] = mapped_column(String(32), nullable=False)
    key_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    public_key_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    private_key_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    key_fingerprint: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    user = relationship("User")
    patient = relationship("Patient")


class SecurityMcsNode(Base):
    __tablename__ = "security_mcs_nodes"

    id: Mapped[int] = mapped_column(primary_key=True)
    node_code: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    node_name: Mapped[str] = mapped_column(String(100), nullable=False)
    storage_backend: Mapped[str] = mapped_column(String(32), default="local_db", nullable=False)
    storage_namespace: Mapped[str] = mapped_column(String(100), default="security_cipher_records", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class SecurityPatientAssignment(Base):
    __tablename__ = "security_patient_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        unique=True,
        index=True,
        nullable=False,
    )
    patient_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    assigned_dac_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    assigned_mcs_node_id: Mapped[int | None] = mapped_column(
        ForeignKey("security_mcs_nodes.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    assignment_status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)
    assignment_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient = relationship("Patient")
    patient_user = relationship("User", foreign_keys=[patient_user_id])
    assigned_dac_user = relationship("User", foreign_keys=[assigned_dac_user_id])
    assigned_mcs_node = relationship("SecurityMcsNode")


class SecurityCipherRecord(Base):
    __tablename__ = "security_cipher_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    source_type: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    source_record_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    patient_assignment_id: Mapped[int | None] = mapped_column(
        ForeignKey("security_patient_assignments.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    mcs_node_id: Mapped[int | None] = mapped_column(
        ForeignKey("security_mcs_nodes.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    time_bucket: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    dimension_labels_json: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    encrypted_payload: Mapped[str] = mapped_column(Text, nullable=False)
    integrity_digest: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    key_fingerprint: Mapped[str] = mapped_column(String(128), nullable=False)
    cipher_version: Mapped[str] = mapped_column(String(32), default="vmemda-lite-v1", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient = relationship("Patient")
    patient_assignment = relationship("SecurityPatientAssignment")
    mcs_node = relationship("SecurityMcsNode")


class SecurityAuditTask(Base):
    __tablename__ = "security_audit_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    requested_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    patient_assignment_id: Mapped[int | None] = mapped_column(
        ForeignKey("security_patient_assignments.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    mcs_node_id: Mapped[int | None] = mapped_column(
        ForeignKey("security_mcs_nodes.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    task_type: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    source_type: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="created", nullable=False)
    included_record_ids_json: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    aggregate_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    aggregate_digest: Mapped[str | None] = mapped_column(String(128), nullable=True)
    verification_passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    verification_details_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    decrypted_stats_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    patient = relationship("Patient")
    requested_by = relationship("User")
    patient_assignment = relationship("SecurityPatientAssignment")
    mcs_node = relationship("SecurityMcsNode")


class SecurityAuditLog(Base):
    __tablename__ = "security_audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    audit_task_id: Mapped[int | None] = mapped_column(
        ForeignKey("security_audit_tasks.id", ondelete="CASCADE"),
        index=True,
        nullable=True,
    )
    patient_id: Mapped[int | None] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=True,
    )
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    action: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    detail_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    audit_task = relationship("SecurityAuditTask")
    patient = relationship("Patient")
    actor = relationship("User")
