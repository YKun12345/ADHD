from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base
from backend.app.core.data_encryption import EncryptedValue

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
    mood_tag: Mapped[str | None] = mapped_column(EncryptedValue("tracking_logs.mood_tag", "text"), nullable=True)
    focus_minutes: Mapped[int | None] = mapped_column(EncryptedValue("tracking_logs.focus_minutes", "int"), nullable=True)
    note: Mapped[str | None] = mapped_column(EncryptedValue("tracking_logs.note", "text"), nullable=True)
    test_score: Mapped[float | None] = mapped_column(EncryptedValue("tracking_logs.test_score", "float"), nullable=True)
    activities: Mapped[str | None] = mapped_column(EncryptedValue("tracking_logs.activities", "text"), nullable=True)

    # Medication tracking
    is_medication: Mapped[bool | None] = mapped_column(EncryptedValue("tracking_logs.is_medication", "bool"), default=False, nullable=True)
    medication_dosage: Mapped[str | None] = mapped_column(EncryptedValue("tracking_logs.medication_dosage", "text"), nullable=True)

    # 5 core ratings (1-5 scale)
    attention_rating: Mapped[int | None] = mapped_column(EncryptedValue("tracking_logs.attention_rating", "int"), nullable=True)
    hyperactivity_rating: Mapped[int | None] = mapped_column(EncryptedValue("tracking_logs.hyperactivity_rating", "int"), nullable=True)
    impulsivity_rating: Mapped[int | None] = mapped_column(EncryptedValue("tracking_logs.impulsivity_rating", "int"), nullable=True)
    emotion_rating: Mapped[int | None] = mapped_column(EncryptedValue("tracking_logs.emotion_rating", "int"), nullable=True)
    task_completion_rating: Mapped[int | None] = mapped_column(EncryptedValue("tracking_logs.task_completion_rating", "int"), nullable=True)

    # Life items (stored as JSON strings)
    sleep_quality: Mapped[str | None] = mapped_column(EncryptedValue("tracking_logs.sleep_quality", "text"), nullable=True)
    appetite_quality: Mapped[str | None] = mapped_column(EncryptedValue("tracking_logs.appetite_quality", "text"), nullable=True)
    has_conflict: Mapped[bool | None] = mapped_column(EncryptedValue("tracking_logs.has_conflict", "bool"), default=False, nullable=True)
    was_criticized: Mapped[bool | None] = mapped_column(EncryptedValue("tracking_logs.was_criticized", "bool"), default=False, nullable=True)
    side_effects: Mapped[str | None] = mapped_column(EncryptedValue("tracking_logs.side_effects", "text"), nullable=True)

    # Extended notes
    special_events: Mapped[str | None] = mapped_column(EncryptedValue("tracking_logs.special_events", "text"), nullable=True)
    highlights: Mapped[str | None] = mapped_column(EncryptedValue("tracking_logs.highlights", "text"), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient: Mapped["Patient"] = relationship(back_populates="tracking_logs")
