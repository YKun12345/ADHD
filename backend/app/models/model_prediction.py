from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db.base import Base
from backend.app.core.record_fields import RecordFieldsMixin, record_field
from backend.app.core.record_provenance import record_storage_type
from backend.app.models.imaging_storage import initialize_values, register_imaging_storage

if TYPE_CHECKING:
    from backend.app.models.patient import Patient
    from backend.app.models.upload import Upload


class ModelPrediction(RecordFieldsMixin, Base):
    __tablename__ = "model_predictions"
    record_object_type = 'model_prediction'
    record_fields = ('file_name','prediction_label','probability','probability_control','summary_text','storage_context')
    storage_metadata_fields = ('upload_id','source_type','roi_dim_used','timepoints','model_name','model_version','created_at')

    def __init__(self, **values):
        initialize_values(self, values)

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
    _file_name_cipher: Mapped[str] = mapped_column('file_name',record_storage_type(),nullable=False)
    file_name = record_field('file_name')
    _prediction_label_cipher: Mapped[str] = mapped_column('prediction_label',record_storage_type(),nullable=False)
    prediction_label = record_field('prediction_label')
    _probability_cipher: Mapped[str] = mapped_column('probability',record_storage_type(),nullable=False)
    probability = record_field('probability')
    _probability_control_cipher: Mapped[str | None] = mapped_column('probability_control',record_storage_type(),nullable=True)
    probability_control = record_field('probability_control')
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)
    roi_dim_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    timepoints: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    _summary_text_cipher: Mapped[str | None] = mapped_column('summary_text',record_storage_type(),nullable=True)
    summary_text = record_field('summary_text')
    _storage_context_cipher: Mapped[str | None] = mapped_column('storage_context',record_storage_type(),nullable=True)
    storage_context = record_field('storage_context')
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    patient: Mapped["Patient"] = relationship(back_populates="predictions")
    upload: Mapped["Upload | None"] = relationship(back_populates="prediction")


register_imaging_storage(ModelPrediction, immutable=True)
