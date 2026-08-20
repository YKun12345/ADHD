from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum as SqlEnum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base

if TYPE_CHECKING:
    from backend.app.models.ai_chat_log import AIChatLog
    from backend.app.models.care_message import CareMessage
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.models.imaging_visualization import ImagingVisualization
    from backend.app.models.model_prediction import ModelPrediction
    from backend.app.models.patient_task import PatientTask
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.tracking_log import TrackingLog
    from backend.app.models.user import User


class PatientType(str, Enum):
    ADULT = "adult"
    CHILD = "child"


class Patient(Base):
    __tablename__ = "patients"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        index=True,
        nullable=False,
    )
    assigned_researcher_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    age: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gender: Mapped[str | None] = mapped_column(String(32), nullable=True)
    patient_type: Mapped[PatientType] = mapped_column(
        SqlEnum(PatientType, native_enum=False),
        index=True,
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    user: Mapped["User"] = relationship(
        back_populates="patient_profile",
        foreign_keys=[user_id],
    )
    assigned_researcher: Mapped["User | None"] = relationship(
        back_populates="researcher_patients",
        foreign_keys=[assigned_researcher_id],
    )
    scale_results: Mapped[list["ScaleResult"]] = relationship(
        back_populates="patient",
        cascade="all, delete-orphan",
    )
    cognitive_tests: Mapped[list["CognitiveTest"]] = relationship(
        back_populates="patient",
        cascade="all, delete-orphan",
    )
    tracking_logs: Mapped[list["TrackingLog"]] = relationship(
        back_populates="patient",
        cascade="all, delete-orphan",
    )
    predictions: Mapped[list["ModelPrediction"]] = relationship(
        back_populates="patient",
        cascade="all, delete-orphan",
    )
    imaging_visualizations: Mapped[list["ImagingVisualization"]] = relationship(
        back_populates="patient",
        cascade="all, delete-orphan",
    )
    patient_tasks: Mapped[list["PatientTask"]] = relationship(
        back_populates="patient",
        cascade="all, delete-orphan",
    )
    care_messages: Mapped[list["CareMessage"]] = relationship(
        back_populates="patient",
        cascade="all, delete-orphan",
    )
    ai_chat_logs: Mapped[list["AIChatLog"]] = relationship(
        back_populates="patient",
        cascade="all, delete-orphan",
    )
