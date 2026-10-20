"""Configure a durable synthetic demo without importing or opening the real app.

Only stores carrying this project's own marker can be reopened. There is no
delete/reset operation: a fresh recording uses a new store instead.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import secrets
import uuid

SERVICE = 'adhd-competition-demo/v1'


def project_key(root: Path) -> str:
    return hashlib.sha256(str(Path(root).resolve()).casefold().encode()).hexdigest()[:24]


def prepare(root: Path, directory: Path | None = None):
    root = Path(root).resolve()
    allowed = (root / '.codex-tmp/competition-demo/stores').resolve()
    store = Path(directory).resolve() if directory else allowed / uuid.uuid4().hex[:16]
    if store == allowed or not store.is_relative_to(allowed):
        raise ValueError('Demo stores must be inside .codex-tmp/competition-demo/stores.')
    marker = store / 'competition-demo.json'
    if store.exists():
        if not marker.is_file():
            raise ValueError('Refusing to reuse an unmarked directory.')
        meta = json.loads(marker.read_text(encoding='utf-8'))
        if (meta.get('service') != SERVICE or meta.get('synthetic') is not True
                or meta.get('project_key') != project_key(root)):
            raise ValueError('The existing store belongs to another service or project.')
        if not (store / '.demo-config.json').is_file():
            raise ValueError('The existing demo key file is missing; create a new session.')
        return store, meta
    store.mkdir(parents=True)
    meta = {'service': SERVICE, 'synthetic': True, 'project_key': project_key(root),
            'store_id': store.name, 'created_at': datetime.now(timezone.utc).isoformat()}
    (store / '.demo-config.json').write_text(json.dumps({
        'secret_key': secrets.token_urlsafe(48),
        'data_encryption_key': base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
    }), encoding='utf-8')
    marker.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
    return store, meta


def environment(root: Path, store: Path, meta: dict, inherited: dict) -> dict:
    root, store = Path(root).resolve(), Path(store).resolve()
    checked, saved = prepare(root, store)
    if checked != store or saved != meta:
        raise ValueError('Demo metadata mismatch.')
    keys = json.loads((store / '.demo-config.json').read_text(encoding='utf-8'))
    result = dict(inherited)
    # APP_ENV=test prevents loading backend/.env, even in a development shell.
    result.update({
        'APP_ENV': 'test', 'DATABASE_URL': f'sqlite:///{(store / "synthetic.db").as_posix()}',
        'SECRET_KEY': keys['secret_key'], 'DATA_ENCRYPTION_KEY': keys['data_encryption_key'],
        'ACCESS_TOKEN_EXPIRE_MINUTES': '10080',
        'SECURITY_MASTER_KEY_PATH': str(store / 'synthetic-master.key'),
        'AUTHORIZATION_LEDGER_PATH': str(store / 'authorization.db'),
        'UPLOAD_ROOT': str(store / 'uploads'), 'FINDVIZ_CACHE_ROOT': str(store / 'findviz-cache'),
        'MODEL_REGISTRY_ENABLED': 'false', 'MODEL_REGISTRY_ARTIFACT_ROOT': str(store / 'model-registry'),
        'MODEL_REGISTRY_REQUIRED_INSTANCES': '', 'MODEL_REGISTRY_INSTANCE_KEYS_JSON': '{}',
        'FEDERATED_WORKER_ENABLED': 'false', 'FEDERATED_RUNTIME_ROOT': str(store / 'federated-runtime'),
        'FEDERATED_NODE_ROOT': str(store / 'federated-nodes'),
        'FEDERATED_NODE_REGISTRY_PATH': str(store / 'unused-node-registry.json'),
        'CARE_WORKER_ENABLED': 'false', 'AGENT_WORKER_ENABLED': 'false',
        'DEEPSEEK_API_KEY': '', 'AGENT_MAX_PROMPT_TOKENS': '0',
        'AGENT_MAX_COMPLETION_TOKENS': '0', 'AGENT_MAX_COST_MICROUNITS': '0',
        'WECHAT_APP_ID': '', 'WECHAT_APP_SECRET': '', 'WECHAT_SUBSCRIBE_TEMPLATE_ID': '',
        'WECHAT_SUBSCRIBE_TITLE_FIELD': '', 'WECHAT_SUBSCRIBE_TIME_FIELD': '',
        'WECHAT_NOTIFICATION_SEND_ENABLED': 'false', 'WECHAT_NOTIFICATION_WORKER_ENABLED': 'false',
        'HGST_DEPLOYMENT_BUNDLE_PATH': str(root / 'backend/models/hgst_adhd_bundle.pt'),
        'HGST_PRETRAINED_WEIGHTS_PATH': str(store / 'absent-encoder.pth'),
        'HGST_DEFAULT_DATA_DIR': '', 'HGST_DEFAULT_LABELS_PATH': '',
        'HGST_LEGACY_COMPATIBILITY_ENABLED': 'true', 'USE_MOCK_MODEL': 'real',
        'HGST_INFERENCE_PYTHON': str(root / '.codex-tmp/python310-compat-f00/python.exe'),
        'PYTHONIOENCODING': 'utf-8', 'PYTHONUNBUFFERED': '1',
        'BACKEND_CORS_ORIGINS': 'http://127.0.0.1:8770,http://localhost:8770',
    })
    return result


def fingerprint(path: Path) -> dict:
    """Read-only baseline; a busy real database is reported, never unlocked."""
    result = {'path': str(path), 'exists': path.is_file()}
    if not result['exists']:
        return result
    result['bytes'] = path.stat().st_size
    try:
        with path.open('rb') as stream:
            result['sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
    except OSError as exc:
        result['read_error'] = type(exc).__name__
    return result
