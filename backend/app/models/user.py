from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, Enum as SqlEnum, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base

if TYPE_CHECKING:
    from backend.app.models.imaging_visualization import ImagingVisualization
    from backend.app.models.patient import Patient
    from backend.app.models.upload import Upload


class UserRole(str, Enum):
    PATIENT = "patient"
    RESEARCHER = "researcher"


class UserSubrole(str, Enum):
    NORMAL = "normal"
    DAC = "dac"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    staff_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    full_name: Mapped[str] = mapped_column(String(100), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        SqlEnum(UserRole, native_enum=False),
        index=True,
        nullable=False,
    )
    subrole: Mapped[UserSubrole | None] = mapped_column(
        SqlEnum(UserSubrole, native_enum=False),
        index=True,
        nullable=True,
    )
    consent_agreed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient_profile: Mapped["Patient | None"] = relationship(
        back_populates="user",
        uselist=False,
        cascade="all, delete-orphan",
        foreign_keys="Patient.user_id",
    )

    researcher_patients: Mapped[list["Patient"]] = relationship(
        back_populates="assigned_researcher",
        foreign_keys="Patient.assigned_researcher_id",
    )
    saved_imaging_visualizations: Mapped[list["ImagingVisualization"]] = relationship(
        back_populates="researcher",
        foreign_keys="ImagingVisualization.researcher_id",
    )
    uploads: Mapped[list["Upload"]] = relationship(
        back_populates="uploader",
        foreign_keys="Upload.uploader_id",
    )
