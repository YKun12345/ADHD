from __future__ import annotations
from datetime import datetime, timezone
from typing import TYPE_CHECKING
from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship, declared_attr
from backend.app.db.base import Base
from backend.app.core.record_fields import RecordFieldsMixin, record_field
from backend.app.core.record_provenance import record_storage_type
from backend.app.models.imaging_storage import initialize_values, register_imaging_storage

if TYPE_CHECKING:
    from backend.app.models.patient import Patient
    from backend.app.models.user import User


class ImagingVisualization(RecordFieldsMixin, Base):
    __tablename__ = 'imaging_visualizations'
    record_object_type = 'imaging_visualization'
    record_fields = ('func_file_name','anat_file_name','mask_file_name','left_func_file_name','left_mesh_file_name','right_func_file_name','right_mesh_file_name','slice_screenshot_name','slice_screenshot_data','surface_screenshot_name','surface_screenshot_data','slice_interpretation','surface_interpretation','summary_text','notes','storage_context')
    storage_metadata_fields = ('researcher_id','visualization_type','created_at')

    @declared_attr.directive
    def __mapper_args__(cls):
        return {'version_id_col': cls.data_version, 'version_id_generator': False}

    def __init__(self, **values):
        initialize_values(self, values)

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey('patients.id',ondelete='CASCADE'), index=True,nullable=False)
    researcher_id: Mapped[int] = mapped_column(ForeignKey('users.id',ondelete='CASCADE'), index=True,nullable=False)
    visualization_type: Mapped[str] = mapped_column(String(32),nullable=False)
    _func_file_name_cipher: Mapped[str | None] = mapped_column('func_file_name',record_storage_type(),nullable=True)
    func_file_name = record_field('func_file_name')
    _anat_file_name_cipher: Mapped[str | None] = mapped_column('anat_file_name',record_storage_type(),nullable=True)
    anat_file_name = record_field('anat_file_name')
    _mask_file_name_cipher: Mapped[str | None] = mapped_column('mask_file_name',record_storage_type(),nullable=True)
    mask_file_name = record_field('mask_file_name')
    _left_func_file_name_cipher: Mapped[str | None] = mapped_column('left_func_file_name',record_storage_type(),nullable=True)
    left_func_file_name = record_field('left_func_file_name')
    _left_mesh_file_name_cipher: Mapped[str | None] = mapped_column('left_mesh_file_name',record_storage_type(),nullable=True)
    left_mesh_file_name = record_field('left_mesh_file_name')
    _right_func_file_name_cipher: Mapped[str | None] = mapped_column('right_func_file_name',record_storage_type(),nullable=True)
    right_func_file_name = record_field('right_func_file_name')
    _right_mesh_file_name_cipher: Mapped[str | None] = mapped_column('right_mesh_file_name',record_storage_type(),nullable=True)
    right_mesh_file_name = record_field('right_mesh_file_name')
    _slice_screenshot_name_cipher: Mapped[str | None] = mapped_column('slice_screenshot_name',record_storage_type(),nullable=True)
    slice_screenshot_name = record_field('slice_screenshot_name')
    _slice_screenshot_data_cipher: Mapped[str | None] = mapped_column('slice_screenshot_data',record_storage_type(),nullable=True)
    slice_screenshot_data = record_field('slice_screenshot_data')
    _surface_screenshot_name_cipher: Mapped[str | None] = mapped_column('surface_screenshot_name',record_storage_type(),nullable=True)
    surface_screenshot_name = record_field('surface_screenshot_name')
    _surface_screenshot_data_cipher: Mapped[str | None] = mapped_column('surface_screenshot_data',record_storage_type(),nullable=True)
    surface_screenshot_data = record_field('surface_screenshot_data')
    _slice_interpretation_cipher: Mapped[str | None] = mapped_column('slice_interpretation',record_storage_type(),nullable=True)
    slice_interpretation = record_field('slice_interpretation')
    _surface_interpretation_cipher: Mapped[str | None] = mapped_column('surface_interpretation',record_storage_type(),nullable=True)
    surface_interpretation = record_field('surface_interpretation')
    _summary_text_cipher: Mapped[str | None] = mapped_column('summary_text',record_storage_type(),nullable=False)
    summary_text = record_field('summary_text')
    _notes_cipher: Mapped[str | None] = mapped_column('notes',record_storage_type(),nullable=True)
    notes = record_field('notes')
    _storage_context_cipher: Mapped[str | None] = mapped_column('storage_context',record_storage_type(),nullable=True)
    storage_context = record_field('storage_context')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),default=lambda:datetime.now(timezone.utc),nullable=False)
    patient: Mapped['Patient'] = relationship(back_populates='imaging_visualizations')
    researcher: Mapped['User'] = relationship(back_populates='saved_imaging_visualizations')


register_imaging_storage(ImagingVisualization)
