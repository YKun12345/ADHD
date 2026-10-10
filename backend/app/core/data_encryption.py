"""AES-256-GCM storage envelopes; master key never belongs in the database."""

from __future__ import annotations
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import Text
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.types import TypeDecorator
from backend.app.core.config import settings

PREFIX = "aesgcm:v1:"
FILE_MAGIC = b"ADHD-AESGCM-V1\x00"


def _decode_key(value: str) -> bytes:
    try:
        key = base64.b64decode(
            value.strip() + "=" * (-len(value.strip()) % 4),
            altchars=b"-_",
            validate=True,
        )
    except (ValueError, TypeError) as exc:
        raise RuntimeError(
            "DATA_ENCRYPTION_KEY must be a base64url encoded 32-byte key."
        ) from exc
    if len(key) != 32:
        raise RuntimeError(
            "DATA_ENCRYPTION_KEY must be a base64url encoded 32-byte key."
        )
    return key


def master_key() -> bytes:
    if settings.DATA_ENCRYPTION_KEY:
        return _decode_key(settings.DATA_ENCRYPTION_KEY)
    target = Path(settings.SECURITY_MASTER_KEY_PATH).expanduser().resolve()
    if not target.exists():
        if settings.APP_ENV == "production":
            raise RuntimeError(
                "Production requires DATA_ENCRYPTION_KEY or an existing SECURITY_MASTER_KEY_PATH."
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        key = os.urandom(32)
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "wb") as out:
                out.write(base64.urlsafe_b64encode(key))
    return _decode_key(target.read_text(encoding="ascii"))


def scoped_key(purpose: str) -> bytes:
    return hmac.new(
        master_key(), ("adhd-storage-v1:" + purpose).encode(), hashlib.sha256
    ).digest()


def encrypt_bytes(value: bytes, context: str) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(scoped_key("aes")).encrypt(nonce, value, context.encode())


def decrypt_bytes(value: bytes, context: str) -> bytes:
    if len(value) < 28:
        raise ValueError("Invalid authenticated storage envelope.")
    return AESGCM(scoped_key("aes")).decrypt(value[:12], value[12:], context.encode())


def encrypt_value(value, context: str) -> str:
    raw = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf8")
    return PREFIX + base64.urlsafe_b64encode(encrypt_bytes(raw, context)).decode(
        "ascii"
    )


def decrypt_value(value: str, context: str):
    raw = base64.b64decode(value[len(PREFIX) :], altchars=b"-_", validate=True)
    return json.loads(decrypt_bytes(raw, context))


class EncryptedValue(TypeDecorator):
    """Transparent authenticated values; plaintext conversion is migration-only."""

    impl = Text
    cache_ok = True

    def __init__(self, context: str, legacy: str = "text"):
        super().__init__()
        self.context = context
        self.legacy = legacy

    def load_dialect_impl(self, dialect):
        return dialect.type_descriptor(
            LONGTEXT() if dialect.name == "mysql" else Text()
        )

    def process_bind_param(self, value, dialect):
        return None if value is None else encrypt_value(value, self.context)

    def legacy_value(self, value):
        if self.legacy == "json":
            return json.loads(value) if isinstance(value, str) else value
        if self.legacy == "float":
            return float(value)
        if self.legacy == "int":
            return int(value)
        if self.legacy == "bool":
            return bool(int(value))
        return value

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, str) and value.startswith(PREFIX):
            return decrypt_value(value, self.context)
        raise ValueError(
            "Unauthenticated database value; run the backed-up storage migration."
        )
