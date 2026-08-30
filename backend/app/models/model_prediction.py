from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base

if TYPE_CHECKING:
    from backend.app.models.patient import Patient
    from backend.app.models.upload import Upload


class ModelPrediction(Base):
    __tablename__ = "model_predictions"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    upload_id: Mapped[int | None] = mapped_column(
        ForeignKey("uploads.id", ondelete="SET NULL"),
        unique=True,
        index=True,
        nullable=True,
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    prediction_label: Mapped[str] = mapped_column(String(32), nullable=False)
    probability: Mapped[float] = mapped_column(Float, nullable=False)
    probability_control: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)
    roi_dim_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    timepoints: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    summary_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient: Mapped["Patient"] = relationship(back_populates="predictions")
    upload: Mapped["Upload | None"] = relationship(back_populates="prediction")
