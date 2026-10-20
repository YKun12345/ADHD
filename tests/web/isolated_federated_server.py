"""Local synthetic full-stack research server. No production database/settings."""
import os
import json
from pathlib import Path
from isolated_server import runtime, root

reuse = os.environ.get('W11_REUSE_SYNTHETIC_RUNTIME', '')
if reuse:
    directory = Path(reuse).resolve()
    assert directory.is_relative_to(root / '.codex-tmp') and directory.name.startswith('w01-browser-')
    assert json.loads((directory / 'browser-source.json').read_text(encoding='utf8'))['synthetic_only'] is True
    runtime = directory
    os.environ.update({
        'DATABASE_URL': f'sqlite:///{(runtime / "synthetic.db").as_posix()}',
        'SECURITY_MASTER_KEY_PATH': str(runtime / 'synthetic-master.key'),
        'AUTHORIZATION_LEDGER_PATH': str(runtime / 'authority.db'),
        'FINDVIZ_CACHE_ROOT': str(runtime / 'findviz-cache'), 'UPLOAD_ROOT': str(runtime / 'uploads'),
        'HGST_DEPLOYMENT_BUNDLE_PATH': str(runtime / 'absent-model.pt'),
        'HGST_PRETRAINED_WEIGHTS_PATH': str(runtime / 'absent-encoder.pth'),
    })

os.environ.update({
    # Latest user scope: finish engineering without starting training. An
    # explicit later synthetic-training run must opt in; provisioning never
    # creates or starts an experiment on its own.
    'FEDERATED_WORKER_ENABLED': 'true' if os.environ.get('W11_SYNTHETIC_TRAINING_AUTHORIZED') == 'explicit-synthetic-only' else 'false',
    'FEDERATED_RUNTIME_ROOT': str(runtime / 'rounds'),
    'FEDERATED_NODE_ROOT': str(runtime / 'nodes'),
    'FEDERATED_NODE_REGISTRY_PATH': str(runtime / 'nodes.json'),
    'MODEL_REGISTRY_ARTIFACT_ROOT': str(runtime / 'models'),
})

if __name__ == '__main__':
    import json
    import sys
    import threading
    import uvicorn
    from fastapi import Header, HTTPException
    from fastapi.testclient import TestClient
    from backend.app.main import app
    from federated_fixture import provision

    lock = threading.Lock()
    source = json.loads((runtime / 'browser-source.json').read_text(encoding='utf8')) if reuse else None
    heartbeat_all = None
    if reuse:
        # Renew actual signed node heartbeats through the existing local channel;
        # the CLI preserves originals on uncertain writes and never trains.
        def heartbeat_all():
            import subprocess
            registry = json.loads((runtime / 'nodes.json').read_text(encoding='utf8'))
            for node_id in source['node_ids']:
                process = subprocess.run([sys.executable, '-B', str(root / 'tools/federated-node-heartbeat.py'),
                    '--node-directory', registry['nodes'][node_id]['directory'],
                    '--api-base', f'http://127.0.0.1:{int(sys.argv[1])}/api/v1'],
                    cwd=root, capture_output=True, timeout=30,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                assert process.returncode == 0, 'Synthetic node signed heartbeat failed; original remains local'

    @app.post('/api/v1/__synthetic__/federated-source')
    def make_source(x_synthetic_test: str = Header(default='')):
        global source, heartbeat_all
        if x_synthetic_test != 'w11-local-synthetic-only':
            raise HTTPException(403, 'Synthetic fixture access only')
        with lock:
            if source is None:
                source, heartbeat_all = provision(TestClient(app), runtime, root)
                (runtime / 'browser-source.json').write_text(json.dumps(source), encoding='utf8')
            return source

    @app.post('/api/v1/__synthetic__/federated-heartbeats')
    def heartbeats(x_synthetic_test: str = Header(default='')):
        if x_synthetic_test != 'w11-local-synthetic-only' or heartbeat_all is None:
            raise HTTPException(403, 'Synthetic fixture access only')
        with lock:
            heartbeat_all()
        return {'signed_heartbeats': 3}

    from federated_preview import install
    install(app, root, runtime, make_source)

    (runtime / 'server.json').write_text(json.dumps({'pid': os.getpid(), 'port': int(sys.argv[1]), 'runtime': str(runtime)}), encoding='utf8')
    print(json.dumps({'synthetic_runtime': str(runtime)}), flush=True)
    uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]), log_level='warning')
