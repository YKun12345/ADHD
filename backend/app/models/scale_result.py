from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base
from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type, register_immutable_formal_result

if TYPE_CHECKING:
    from backend.app.models.patient import Patient


class ScaleResult(RecordFieldsMixin, Base):
    __tablename__ = "scale_results"
    record_object_type = "scale_result"
    record_fields = {"score_json":"scale_results.score_json","total_score":"scale_results.total_score","risk_level":"scale_results.risk_level"}

    id: Mapped[int] = mapped_column(primary_key=True)
    assessment_id: Mapped[int | None] = mapped_column(ForeignKey("assessment_sessions.id"), nullable=True)
    assessment_item_id: Mapped[int | None] = mapped_column(ForeignKey("assessment_items.id"), nullable=True)
    task_attempt_id: Mapped[int | None] = mapped_column(ForeignKey("task_attempts.id"), nullable=True, unique=True)
    legacy: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    patient_id: Mapped[int] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    scale_type: Mapped[str] = mapped_column(String(64), nullable=False)
    _score_json_cipher: Mapped[str] = mapped_column("score_json",record_storage_type(),nullable=False)
    _total_score_cipher: Mapped[str] = mapped_column("total_score",record_storage_type(),nullable=False)
    _risk_level_cipher: Mapped[str] = mapped_column("risk_level",record_storage_type(),nullable=False)
    score_json = record_field("score_json")
    total_score = record_field("total_score")
    risk_level = record_field("risk_level")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient: Mapped["Patient"] = relationship(back_populates="scale_results")


register_immutable_formal_result(ScaleResult)
register_record_fields(ScaleResult)
