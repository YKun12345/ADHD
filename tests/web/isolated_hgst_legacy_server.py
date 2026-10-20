"""Original-weight inference browser fixture; real API, synthetic database only."""
import os
import runpy
from isolated_server import root, runtime

assert os.environ['APP_ENV'] == 'test'
os.environ.update(HGST_DEPLOYMENT_BUNDLE_PATH=str(root / 'backend/models/hgst_adhd_bundle.pt'),
                  HGST_LEGACY_COMPATIBILITY_ENABLED='true', MODEL_REGISTRY_ENABLED='false', USE_MOCK_MODEL='real')
runpy.run_path(str(root / 'tests/web/isolated_authorization_server.py'), run_name='__main__')
