from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Protocol
from uuid import uuid4


ALLOWED_TIMESERIES_SUFFIXES = {".1d", ".csv"}


class UploadValidationError(ValueError):
    pass


class UploadTooLargeError(UploadValidationError):
    pass


class AsyncReadable(Protocol):
    def read(self, size: int) -> Awaitable[bytes]: ...


async def read_upload_bytes_limited(
    upload: AsyncReadable,
    *,
    max_bytes: int,
    chunk_size: int = 64 * 1024,
) -> bytes:
    """Read at most ``max_bytes + 1`` bytes using bounded chunks."""

    if max_bytes < 1:
        raise ValueError("max_bytes must be positive")
    if chunk_size < 1:
        raise ValueError("chunk_size must be positive")

    content = bytearray()
    while len(content) <= max_bytes:
        probe_remaining = max_bytes + 1 - len(content)
        chunk = await upload.read(min(chunk_size, probe_remaining))
        if not chunk:
            return bytes(content)
        content.extend(chunk)
        if len(content) > max_bytes:
            raise UploadTooLargeError(
                f"The uploaded file exceeds the {max_bytes}-byte limit."
            )

    raise UploadTooLargeError(f"The uploaded file exceeds the {max_bytes}-byte limit.")


@dataclass(frozen=True)
class StoredUpload:
    original_name: str
    stored_path: Path
    file_size: int
    file_hash: str
    source_type: str = "fMRI_1D"


def store_timeseries_upload(
    file_bytes: bytes,
    file_name: str,
    upload_root: Path,
    max_bytes: int,
) -> StoredUpload:
    original_name = Path(file_name).name
    suffix = Path(original_name).suffix.lower()
    if not original_name:
        raise UploadValidationError("A file name is required.")
    if suffix not in ALLOWED_TIMESERIES_SUFFIXES:
        raise UploadValidationError("Only .1D and .csv files are supported.")
    if not file_bytes:
        raise UploadValidationError("The uploaded time-series file is empty.")
    if len(file_bytes) > max_bytes:
        raise UploadTooLargeError(f"The uploaded file exceeds the {max_bytes}-byte limit.")

    resolved_root = upload_root.expanduser().resolve()
    resolved_root.mkdir(parents=True, exist_ok=True)
    destination = (resolved_root / f"{uuid4().hex}{suffix}").resolve()
    if destination.parent != resolved_root:
        raise UploadValidationError("The upload destination is outside the configured root.")

    destination.write_bytes(file_bytes)
    return StoredUpload(
        original_name=original_name,
        stored_path=destination,
        file_size=len(file_bytes),
        file_hash=hashlib.sha256(file_bytes).hexdigest(),
    )
