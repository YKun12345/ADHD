"""Append-only institutional coverage versions; no invented patient association."""
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.coverage_binding import CoverageBinding
from backend.app.core.record_envelope import RecordIntegrityError, open_record, seal_record
from backend.app.core.record_fields import RecordFieldsMixin, record_field, register_record_fields
from backend.app.core.record_provenance import record_storage_type
from backend.app.db.base import Base


class ServiceCoverageVersion(RecordFieldsMixin, Base):
    __tablename__ = "service_coverage_versions"
    record_fields = {"config": "service_coverage_versions.config"}
    __table_args__ = (
        UniqueConstraint("institution_id", "doctor_user_id", "version", name="uq_coverage_institution_doctor_version"),
        CheckConstraint("version > 0", name="ck_coverage_version"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    client_coverage_id: Mapped[str] = mapped_column(String(64), unique=True)
    institution_id: Mapped[str] = mapped_column(String(64), index=True)
    doctor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    reviewer_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    version: Mapped[int]
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload_digest: Mapped[str] = mapped_column(String(64))
    _config_cipher: Mapped[str] = mapped_column("config", record_storage_type())
    config = record_field("config")

    def _binding(self, field):
        return CoverageBinding(self.institution_id, self.doctor_user_id, self.id, field,
            self.record_schema_version, self.data_version, self.record_key_version)

    def _origin_binding(self):
        return CoverageBinding(self.institution_id, self.doctor_user_id, self.id, "__coverage_origin__")

    def _origin_values(self):
        return {"record_schema_version": self.record_schema_version, "data_version": self.data_version,
            "record_key_version": self.record_key_version, "envelope_status": self.envelope_status}

    def _seal_origin(self):
        return seal_record(self._origin_values(), self._origin_binding())

    def _verify_origin(self):
        if open_record(self._origin_cipher, self._origin_binding()) != self._origin_values() or self.envelope_status != "bound":
            raise RecordIntegrityError("Coverage format and provenance do not match its real institutional origin.")


@event.listens_for(ServiceCoverageVersion, "before_update")
def _immutable(mapper, connection, row):
    if any(attribute.history.has_changes() for attribute in inspect(row).attrs):
        raise ValueError("Coverage versions are immutable; save a new explicitly confirmed version.")


@event.listens_for(ServiceCoverageVersion, "before_delete")
def _preserve(*_):
    raise ValueError("Coverage versions are immutable and cannot be deleted.")


register_record_fields(ServiceCoverageVersion)
