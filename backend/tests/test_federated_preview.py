"""Preview safety checks without a database, training or a provider call."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _preview(monkeypatch, tmp_path):
    import importlib.util
    from pathlib import Path
    from backend.app.core.config import settings
    file = Path(__file__).resolve().parents[2] / 'tests/web/federated_preview.py'
    spec = importlib.util.spec_from_file_location('synthetic_federated_preview', file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(settings, 'APP_ENV', 'test')
    monkeypatch.setattr(settings, 'FEDERATED_WORKER_ENABLED', False)
    root = tmp_path / 'project'
    runtime = root / '.codex-tmp' / 'synthetic'
    runtime.mkdir(parents=True)
    app, calls = FastAPI(), []
    def source(**kwargs):
        calls.append(kwargs)
        return {'synthetic_only': True, 'researcher': {'access_token': 'synthetic-only-token', 'user': {'role': 'researcher'}}}
    module.install(app, root, runtime, source)
    return settings, app, calls, module


def test_preview_entry_is_real_source_and_training_guard_fails_closed(monkeypatch, tmp_path):
    settings, app, calls, _ = _preview(monkeypatch, tmp_path)
    with TestClient(app) as client:
        assert client.get('/__synthetic__/research-preview').status_code == 200
        assert calls == []
        entered = client.post('/api/v1/__synthetic__/research-preview-enter')
        assert entered.status_code == 200
        assert entered.json()['training_enabled'] is False
        assert len(calls) == 1
        monkeypatch.setattr(settings, 'FEDERATED_WORKER_ENABLED', True)
        for path in ['/__synthetic__/research-preview', '/__synthetic__/research-workbench']:
            assert client.get(path).status_code == 409
        assert client.post('/api/v1/__synthetic__/research-preview-enter').status_code == 409
        assert len(calls) == 1
        monkeypatch.setattr(settings, 'FEDERATED_WORKER_ENABLED', False)
        app.state.federated_worker = object()
        assert client.get('/api/v1/__synthetic__/research-preview-mode').json()['training_enabled'] is True
        assert client.post('/api/v1/__synthetic__/research-preview-enter').status_code == 409
        assert len(calls) == 1


def test_preview_cannot_be_installed_outside_disposable_test_scope(monkeypatch, tmp_path):
    settings, app, calls, module = _preview(monkeypatch, tmp_path)
    with pytest.raises(AssertionError):
        module.install(FastAPI(), tmp_path, tmp_path / 'real-store', lambda: {})
    monkeypatch.setattr(settings, 'APP_ENV', 'production')
    with pytest.raises(AssertionError):
        module.install(FastAPI(), tmp_path, tmp_path / '.codex-tmp' / 'synthetic', lambda: {})
