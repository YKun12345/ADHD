"""Institutional schedules have no patient subject; bind their real institution."""
from dataclasses import asdict, dataclass
import json

from backend.app.core.record_envelope import RecordIntegrityError


@dataclass(frozen=True)
class CoverageBinding:
    institution_id: str
    doctor_user_id: int
    object_id: int
    field: str
    schema_version: int = 2
    data_version: int = 1
    key_version: int = 1
    object_type: str = "institutional_service_coverage"

    def aad(self):
        if not self.institution_id or not self.field or any(type(value) is not int or value <= 0
                for value in (self.doctor_user_id, self.object_id, self.schema_version, self.data_version, self.key_version)):
            raise RecordIntegrityError("Coverage binding requires a real institution, doctor, row and version.")
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
