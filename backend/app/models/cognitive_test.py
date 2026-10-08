from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import JSON, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.mysql import VARCHAR
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base

if TYPE_CHECKING:
    from backend.app.models.patient import Patient


class CognitiveTest(Base):
    __tablename__ = "cognitive_tests"
    __table_args__ = (
        UniqueConstraint("patient_id", "test_type", "test_run_id", name="uq_cognitive_tests_patient_type_run"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    test_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # NULL preserves independent submissions from clients predating run ids.
    test_run_id: Mapped[str | None] = mapped_column(
        String(64).with_variant(VARCHAR(64, charset="ascii", collation="ascii_bin"), "mysql"),
        nullable=True,
    )
    result_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient: Mapped["Patient"] = relationship(back_populates="cognitive_tests")
