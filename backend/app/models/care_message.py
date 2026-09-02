from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum as SqlEnum, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base

if TYPE_CHECKING:
    from backend.app.models.patient import Patient
    from backend.app.models.user import User


class CareMessageType(str, Enum):
    TEXT = "text"
    TASK = "task"
    SYSTEM = "system"


class CareMessage(Base):
    __tablename__ = "care_messages"
    __table_args__ = (
        UniqueConstraint(
            "sender_user_id",
            "client_message_id",
            name="uq_care_messages_sender_client_message",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    sender_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    sender_role: Mapped[str] = mapped_column(String(32), nullable=False)
    message_type: Mapped[CareMessageType] = mapped_column(
        SqlEnum(CareMessageType, native_enum=False),
        nullable=False,
        default=CareMessageType.TEXT,
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    client_message_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    related_task_id: Mapped[int | None] = mapped_column(
        ForeignKey("patient_tasks.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    read_by_patient_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_by_researcher_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    patient: Mapped["Patient"] = relationship(back_populates="care_messages")
    sender: Mapped["User"] = relationship(foreign_keys=[sender_user_id])
