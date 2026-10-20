"""Institution objects have their own domain; a patient identity is never fabricated."""
import base64
from dataclasses import asdict, dataclass
import hashlib
import hmac
import json
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag
from backend.app.core.data_encryption import master_key
from backend.app.core.record_envelope import RecordIntegrityError

PREFIX = 'aesgcm:federated:v1:'


@dataclass(frozen=True)
class FederatedBinding:
    institution_id: str
    object_type: str
    object_id: str
    field: str = 'payload'
    schema_version: int = 1
    data_version: int = 1
    key_version: int = 1

    def aad(self):
        if not all(isinstance(v, str) and v.strip() for v in (self.institution_id, self.object_type, self.object_id, self.field)) or any(type(v) is not int or v <= 0 for v in (self.schema_version,self.data_version,self.key_version)):
            raise RecordIntegrityError('A real institution, object and version are required.')
        return json.dumps(asdict(self),sort_keys=True,separators=(',',':')).encode()


def _key(binding):
    return hmac.new(master_key(),f'adhd-federated-envelope:{binding.key_version}'.encode(),hashlib.sha256).digest()


def seal(value,binding):
    nonce=os.urandom(12)
    plain=json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    return PREFIX+base64.urlsafe_b64encode(nonce+AESGCM(_key(binding)).encrypt(nonce,plain,binding.aad())).decode()


def open_sealed(value,binding):
    try:
        if not isinstance(value,str) or not value.startswith(PREFIX):
            raise ValueError('Missing institution object envelope')
        raw=base64.b64decode(value[len(PREFIX):],altchars=b'-_',validate=True)
        return json.loads(AESGCM(_key(binding)).decrypt(raw[:12],raw[12:],binding.aad()))
    except (ValueError,TypeError,InvalidTag) as exc:
        raise RecordIntegrityError('Federated institution/object/field/version authentication failed.') from exc
