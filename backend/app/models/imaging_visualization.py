from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base

if TYPE_CHECKING:
    from backend.app.models.patient import Patient
    from backend.app.models.user import User


class ImagingVisualization(Base):
    __tablename__ = "imaging_visualizations"

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
    visualization_type: Mapped[str] = mapped_column(String(32), nullable=False)
    func_file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    anat_file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mask_file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    left_func_file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    left_mesh_file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    right_func_file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    right_mesh_file_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    slice_screenshot_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    slice_screenshot_data: Mapped[str | None] = mapped_column(
        Text().with_variant(LONGTEXT, "mysql"),
        nullable=True,
    )
    surface_screenshot_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    surface_screenshot_data: Mapped[str | None] = mapped_column(
        Text().with_variant(LONGTEXT, "mysql"),
        nullable=True,
    )
    slice_interpretation: Mapped[str | None] = mapped_column(Text, nullable=True)
    surface_interpretation: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary_text: Mapped[str] = mapped_column(Text, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient: Mapped["Patient"] = relationship(back_populates="imaging_visualizations")
    researcher: Mapped["User"] = relationship(back_populates="saved_imaging_visualizations")
