from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base

if TYPE_CHECKING:
    from backend.app.models.model_prediction import ModelPrediction
    from backend.app.models.patient import Patient
    from backend.app.models.user import User


class Upload(Base):
    """时间序列文件（.1D/.csv）上传记录。

    记录每次上传的文件元信息与落盘路径；预测逻辑（真实 HGST 或演示 mock）
    由相应服务从 stored_path 读取文件后写入 model_predictions 表。
    """

    __tablename__ = "uploads"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int | None] = mapped_column(
        ForeignKey("patients.id", ondelete="CASCADE"),
        index=True,
        nullable=True,
    )
    uploader_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False, default="fMRI_1D")
    file_size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    file_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="uploaded")
    stored_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient: Mapped["Patient | None"] = relationship(back_populates="uploads")
    uploader: Mapped["User"] = relationship(back_populates="uploads")
    prediction: Mapped["ModelPrediction | None"] = relationship(
        back_populates="upload",
        uselist=False,
    )
