from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum as SqlEnum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base

if TYPE_CHECKING:
    from backend.app.models.patient import Patient
    from backend.app.models.user import User


class PatientTaskType(str, Enum):
    SCALE = "scale"
    COGNITIVE = "cognitive"
    TRACKING = "tracking"
    REPORT_REVIEW = "report_review"
    MESSAGE = "message"


class PatientTaskStatus(str, Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    DISMISSED = "dismissed"


class PatientTask(Base):
    __tablename__ = "patient_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    researcher_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    task_type: Mapped[PatientTaskType] = mapped_column(
        SqlEnum(PatientTaskType, native_enum=False),
        nullable=False,
        index=True,
    )
    status: Mapped[PatientTaskStatus] = mapped_column(
        SqlEnum(PatientTaskStatus, native_enum=False),
        nullable=False,
        default=PatientTaskStatus.PENDING,
        index=True,
    )
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    task_title: Mapped[str] = mapped_column(String(120), nullable=False)
    task_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_page: Mapped[str | None] = mapped_column(String(120), nullable=True)
    target_payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    patient: Mapped["Patient"] = relationship(back_populates="patient_tasks")
    researcher: Mapped["User"] = relationship(foreign_keys=[researcher_id])
