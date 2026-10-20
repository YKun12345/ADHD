"""Immutable readable image analysis versions, separate from image sessions."""
from datetime import datetime
from sqlalchemy import DateTime,ForeignKey,Integer,String,UniqueConstraint,event
from sqlalchemy.orm import Mapped,mapped_column
from backend.app.db.base import Base
from backend.app.core.record_fields import RecordFieldsMixin,record_field,register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.core.record_envelope import RecordIntegrityError
from backend.app.models.review import metadata,immutable,preserve
from backend.app.services.cognitive_contract import canonical_digest


class ImagingReportVersion(RecordFieldsMixin,Base):
    __tablename__='imaging_report_versions'
    record_object_type='imaging_report_version'
    record_fields={'snapshot':'imaging_report_versions.snapshot'}
    metadata_fields=('patient_id','prediction_id','actor_user_id','client_publication_id','version','publisher_kind','input_digest','payload_digest','published_at')
    __table_args__=(UniqueConstraint('prediction_id','version',name='uq_imaging_report_source_version'),)
    id:Mapped[int]=mapped_column(primary_key=True)
    patient_id:Mapped[int]=mapped_column(ForeignKey('patients.id'),index=True)
    prediction_id:Mapped[int]=mapped_column(ForeignKey('model_predictions.id'),index=True)
    actor_user_id:Mapped[int]=mapped_column(ForeignKey('users.id'))
    client_publication_id:Mapped[str]=mapped_column(String(64),unique=True)
    version:Mapped[int]=mapped_column(Integer)
    publisher_kind:Mapped[str]=mapped_column(String(24))
    input_digest:Mapped[str]=mapped_column(String(64))
    payload_digest:Mapped[str]=mapped_column(String(64))
    published_at:Mapped[datetime]=mapped_column(DateTime(timezone=True))
    _snapshot_cipher:Mapped[str]=mapped_column('snapshot',record_storage_type())
    snapshot=record_field('snapshot')


def verify(row,*args):
    value=row.snapshot
    if not isinstance(value,dict) or value.get('metadata')!=metadata(row) or canonical_digest(value.get('input'))!=row.input_digest or canonical_digest(value.get('payload'))!=row.payload_digest:
        raise RecordIntegrityError('The immutable imaging report source or version was changed.')
    source=value['input']
    if source.get('patient_id')!=row.patient_id or source.get('prediction_id')!=row.prediction_id:
        raise RecordIntegrityError('The imaging report belongs to another source or patient.')


register_record_fields(ImagingReportVersion)
event.listen(ImagingReportVersion,'before_insert',lambda mapper,connection,row:verify(row))
event.listen(ImagingReportVersion,'load',verify)
event.listen(ImagingReportVersion,'refresh',verify)
event.listen(ImagingReportVersion,'before_update',immutable)
event.listen(ImagingReportVersion,'before_delete',preserve)
