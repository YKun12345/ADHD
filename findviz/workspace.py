"""Request-local workspace selection; standalone CLI retains its own namespace."""
from contextlib import contextmanager
from contextvars import ContextVar

_workspace = ContextVar('findviz_workspace', default='standalone-cli')
_patient_id = ContextVar('findviz_patient_id', default=None)


def current_workspace():
    return _workspace.get()


def current_patient_id():
    return _patient_id.get()


@contextmanager
def workspace_context(namespace, patient_id=None):
    workspace_token = _workspace.set(namespace)
    patient_token = _patient_id.set(patient_id)
    try:
        yield
    finally:
        _patient_id.reset(patient_token)
        _workspace.reset(workspace_token)
