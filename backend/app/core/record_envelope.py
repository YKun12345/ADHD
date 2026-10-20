"""Authenticated values bound to a known subject, row, field and data version."""
import base64
from dataclasses import asdict, dataclass
import hashlib
import hmac
import json
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from backend.app.core.data_encryption import master_key

PREFIX = "aesgcm:v2:"


class RecordIntegrityError(ValueError):
    pass


@dataclass(frozen=True)
class RecordBinding:
    patient_id: int
    object_type: str
    object_id: int
    field: str
    schema_version: int
    data_version: int
    key_version: int = 1

    def aad(self):
        if any(type(value) is not int or value <= 0 for value in (self.patient_id,self.object_id,self.schema_version,self.data_version,self.key_version)) or not self.object_type or not self.field:
            raise RecordIntegrityError("Object binding requires a real nonempty identity and version.")
        return json.dumps(asdict(self),sort_keys=True,separators=(",",":"),ensure_ascii=False).encode("utf-8")


def _key(binding, key=None):
    return hmac.new(master_key() if key is None else key,
        f"adhd-record-envelope-v2:key:{binding.key_version}".encode("ascii"),hashlib.sha256).digest()


def seal_record(value, binding, *, key=None):
    aad = binding.aad()
    plain = json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False,allow_nan=False).encode("utf-8")
    nonce = os.urandom(12)
    return PREFIX + base64.urlsafe_b64encode(nonce+AESGCM(_key(binding,key)).encrypt(nonce,plain,aad)).decode("ascii")


def open_record(value, binding, *, key=None):
    try:
        if not isinstance(value,str) or not value.startswith(PREFIX):
            raise RecordIntegrityError("The expected object-bound format is missing.")
        aad = binding.aad()
        raw = base64.b64decode(value[len(PREFIX):],altchars=b"-_",validate=True)
        if len(raw) < 28:
            raise RecordIntegrityError("The authenticated record is incomplete.")
        return json.loads(AESGCM(_key(binding,key)).decrypt(raw[:12],raw[12:],aad))
    except (InvalidTag,ValueError,TypeError) as exc:
        raise RecordIntegrityError("Unauthenticated record: subject, object, field or version does not match.") from exc


def origin_binding(patient_id, object_type, object_id):
    # A separate purpose and fixed proof schema authenticate editable format
    # markers without letting those same markers select how proof is decoded.
    return RecordBinding(patient_id, object_type, object_id, "__record_origin__", 2, 1, 1)


def seal_origin(patient_id, object_type, object_id, *, schema_version, data_version, key_version, status):
    return seal_record({"record_schema_version":schema_version,"data_version":data_version,
        "record_key_version":key_version,"envelope_status":status}, origin_binding(patient_id, object_type, object_id))

