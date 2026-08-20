from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base

if TYPE_CHECKING:
    from backend.app.models.patient import Patient


class TrackingLog(Base):
    __tablename__ = "tracking_logs"
    __table_args__ = (
        UniqueConstraint("patient_id", "day_index", name="uq_tracking_logs_patient_day"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    day_index: Mapped[int] = mapped_column(Integer, nullable=False)
    mood_tag: Mapped[str | None] = mapped_column(String(32), nullable=True)
    focus_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    test_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    activities: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Medication tracking
    is_medication: Mapped[bool | None] = mapped_column(default=False, nullable=True)
    medication_dosage: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # 5 core ratings (1-5 scale)
    attention_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hyperactivity_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impulsivity_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    emotion_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    task_completion_rating: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Life items (stored as JSON strings)
    sleep_quality: Mapped[str | None] = mapped_column(String(32), nullable=True)
    appetite_quality: Mapped[str | None] = mapped_column(String(32), nullable=True)
    has_conflict: Mapped[bool | None] = mapped_column(default=False, nullable=True)
    was_criticized: Mapped[bool | None] = mapped_column(default=False, nullable=True)
    side_effects: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # Extended notes
    special_events: Mapped[str | None] = mapped_column(Text, nullable=True)
    highlights: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient: Mapped["Patient"] = relationship(back_populates="tracking_logs")
