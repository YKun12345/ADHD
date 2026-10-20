from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.mysql import VARCHAR
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base
from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type, register_immutable_formal_result

if TYPE_CHECKING:
    from backend.app.models.patient import Patient


class CognitiveTest(RecordFieldsMixin, Base):
    __tablename__ = "cognitive_tests"
    record_object_type = "cognitive_test"
    record_fields = {"result_json":"cognitive_tests.result_json"}
    __table_args__ = (
        UniqueConstraint("patient_id", "test_type", "test_run_id", name="uq_cognitive_tests_patient_type_run"),
    )

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
    test_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # NULL preserves independent submissions from clients predating run ids.
    test_run_id: Mapped[str | None] = mapped_column(
        String(64).with_variant(VARCHAR(64, charset="ascii", collation="ascii_bin"), "mysql"),
        nullable=True,
    )
    _result_json_cipher: Mapped[str] = mapped_column("result_json",record_storage_type(),nullable=False)
    result_json = record_field("result_json")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient: Mapped["Patient"] = relationship(back_populates="cognitive_tests")


register_immutable_formal_result(CognitiveTest)
register_record_fields(CognitiveTest)
