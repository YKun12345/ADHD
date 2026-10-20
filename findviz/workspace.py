"""Request-local workspace selection; standalone CLI retains its own namespace."""
from contextlib import contextmanager
from contextvars import ContextVar

_workspace = ContextVar('findviz_workspace', default='standalone-cli')
_patient_id = ContextVar('findviz_patient_id', default=None)
_authorization_check = ContextVar('findviz_authorization_check', default=None)


def current_workspace():
    return _workspace.get()


def current_patient_id():
    return _patient_id.get()


def require_authority():
    if current_patient_id() is None:
        return
    check = _authorization_check.get()
    from werkzeug.exceptions import Forbidden
    if check is None:
        raise Forbidden("Patient workspace authority is unavailable.")
    try:
        check()
    except Exception as exc:
        raise Forbidden("Patient workspace authority changed.") from exc


@contextmanager
def workspace_context(namespace, patient_id=None, authorization_check=None):
    workspace_token = _workspace.set(namespace)
    patient_token = _patient_id.set(patient_id)
    authority_token = _authorization_check.set(authorization_check)
    try:
        yield
    finally:
        _patient_id.reset(patient_token)
        _authorization_check.reset(authority_token)
        _workspace.reset(workspace_token)
