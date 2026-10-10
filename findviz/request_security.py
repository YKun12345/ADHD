"""Bounded, memory-only multipart parsing for transient clinical image processing."""
from io import BytesIO
import os
from flask import Request

DEFAULT_UPLOAD_LIMIT = 512 * 1024 * 1024


def upload_body_limit():
    value = int(os.environ.get('FINDVIZ_MAX_UPLOAD_BYTES', str(DEFAULT_UPLOAD_LIMIT)))
    if value <= 0:
        raise ValueError('FINDVIZ_MAX_UPLOAD_BYTES must be positive.')
    return value


class MemoryUploadRequest(Request):
    def _get_file_stream(self, total_content_length, content_type, filename=None, content_length=None):
        # MAX_CONTENT_LENGTH and the mounted ASGI body limit bound the allocation.
        return BytesIO()


class UploadBodyTooLarge(ValueError):
    pass


async def bounded_wsgi_body(scope, receive):
    limit = upload_body_limit()
    for name, value in scope.get('headers', []):
        if name.lower() == b'content-length':
            if int(value) > limit:
                raise UploadBodyTooLarge()
    body = bytearray()
    while True:
        message = await receive()
        if message['type'] == 'http.disconnect':
            return None
        chunk = message.get('body', b'')
        if len(body) + len(chunk) > limit:
            raise UploadBodyTooLarge()
        body.extend(chunk)
        if not message.get('more_body', False):
            break
    # WSGI must also know the length for chunked requests after bounded buffering.
    wsgi_scope = dict(scope)
    wsgi_scope['headers'] = [(name, value) for name, value in scope.get('headers', [])
                            if name.lower() != b'content-length']
    wsgi_scope['headers'].append((b'content-length', str(len(body)).encode('ascii')))
    sent = False
    async def replay():
        nonlocal sent
        if not sent:
            sent = True
            return {'type':'http.request', 'body':bytes(body), 'more_body':False}
        return await receive()
    return wsgi_scope, replay


def upload_limit_error():
    limit = upload_body_limit()
    size_mb = limit / (1024 * 1024)
    return {"detail": f"影像文件过大，本次上传总大小上限为 {size_mb:g} MB。可将 NIfTI 文件压缩为 .nii.gz 后重试。",
            "max_body_bytes": limit}
