"""Real API/page server for synthetic browser tests; never opens the business database."""
import os
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
runtime = Path(tempfile.mkdtemp(prefix='w01-browser-', dir=root / '.codex-tmp'))
os.environ.update({
    'APP_ENV': 'test', 'DATABASE_URL': f'sqlite:///{(runtime / "synthetic.db").as_posix()}',
    'SECRET_KEY': 'w01-synthetic-browser-test-only',
    'DATA_ENCRYPTION_KEY': 'dGVzdC1rZXktMzItYnl0ZXMtaXNvbGF0ZWQtMDAwMDE=',
    'SECURITY_MASTER_KEY_PATH': str(runtime / 'synthetic-master.key'),
    'AUTHORIZATION_LEDGER_PATH': str(runtime / 'authority.db'),
    'FINDVIZ_CACHE_ROOT': str(runtime / 'findviz-cache'),
    'DEEPSEEK_API_KEY': '', 'AGENT_WORKER_ENABLED':'false', 'CARE_WORKER_ENABLED':'false',
    'FEDERATED_WORKER_ENABLED': 'false',
    'WECHAT_APP_ID': '', 'WECHAT_APP_SECRET': '', 'WECHAT_SUBSCRIBE_TEMPLATE_ID': '',
    'WECHAT_SUBSCRIBE_TITLE_FIELD': '', 'WECHAT_SUBSCRIBE_TIME_FIELD': '',
    'WECHAT_NOTIFICATION_SEND_ENABLED': 'false', 'WECHAT_NOTIFICATION_WORKER_ENABLED': 'false',
    'UPLOAD_ROOT': str(runtime / 'uploads'),
    'HGST_DEPLOYMENT_BUNDLE_PATH': str(runtime / 'absent-model.pt'),
    'HGST_PRETRAINED_WEIGHTS_PATH': str(runtime / 'absent-encoder.pth'),
})

if __name__ == '__main__':
    import asyncio
    import uvicorn
    from backend.app.main import app

    @app.middleware('http')
    async def synthetic_response_delay(request, call_next):
        response = await call_next(request)
        # Test-server-only transport delay. The real endpoint still authenticates
        # and reads the synthetic database before this response is delayed.
        milliseconds = request.query_params.get('w01_delay_ms', '0')
        if milliseconds.isdigit():
            await asyncio.sleep(min(int(milliseconds), 5000) / 1000)
        return response

    uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]), log_level='warning')
