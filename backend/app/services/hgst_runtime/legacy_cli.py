"""Private stdin/stdout bridge to the retained HGST runtime. Never trains."""
from dataclasses import asdict
import base64
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / '.venv-hgst/Lib/site-packages'))
sys.path.insert(0, str(ROOT))


def main():
    try:
        packet = json.loads(sys.stdin.buffer.read(15 * 1024 * 1024))
        raw = base64.b64decode(packet['file_base64'], validate=True)
        if len(raw) > 10 * 1024 * 1024 or not isinstance(packet['file_name'], str):
            raise ValueError('Invalid bounded inference input')
        from backend.app.services.hgst_runtime.service import _predict_timeseries_in_process
        result = _predict_timeseries_in_process(raw, packet['file_name'])
        print(json.dumps({'result': asdict(result)}, ensure_ascii=True, allow_nan=False))
        return 0
    except Exception as exc:
        print(json.dumps({'error_type': type(exc).__name__, 'error': str(exc)[:1000]}, ensure_ascii=True))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
