"""Bounded inference only in the existing HGST environment; no file input persists."""
import base64
import json
import math
import os
from pathlib import Path
import subprocess

from backend.app.core.config import settings

ROOT = Path(__file__).resolve().parents[4]


def predict_in_legacy_process(raw, name, admission):
    from backend.app.services.hgst_runtime.service import HGSTPredictionResult, HGSTUnavailableError, HGSTInferenceError
    executable = Path(settings.HGST_INFERENCE_PYTHON).expanduser().resolve()
    if not executable.is_file():
        raise HGSTUnavailableError('原HGST独立推理环境不存在，请恢复HGST_INFERENCE_PYTHON所指定的环境。')
    if len(raw) > 10 * 1024 * 1024:
        raise HGSTInferenceError('影像时间序列超过10MiB推理上限。')
    # The model process receives no application credentials or real database URL.
    env = {key: value for key, value in os.environ.items() if key.upper() in
           {'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'}}
    env.update(APP_ENV='inference', DATABASE_URL='sqlite:///:memory:',
               MODEL_REGISTRY_ENABLED='false', HGST_LEGACY_COMPATIBILITY_ENABLED='true',
               HGST_DEPLOYMENT_BUNDLE_PATH=str(ROOT / 'backend/models/hgst_adhd_bundle.pt'),
               MPLCONFIGDIR=str(ROOT / '.codex-tmp/hgst-inference-matplotlib'),
               PYTHONDONTWRITEBYTECODE='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1')
    try:
        completed = subprocess.run([str(executable), '-B', str(Path(__file__).with_name('legacy_cli.py'))],
            input=json.dumps({'file_base64': base64.b64encode(raw).decode('ascii'), 'file_name': name}).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(ROOT), env=env, timeout=90,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HGSTUnavailableError('HGST独立推理环境未能完成分析，请检查环境或稍后重试。') from exc
    try:
        packet = json.loads(completed.stdout)
        if completed.returncode != 0 or packet.get('error'):
            if packet.get('error_type') in {'HGSTPreprocessError', 'HGSTInferenceError'}:
                raise HGSTInferenceError(packet.get('error', '时间序列格式无效。'))
            raise HGSTUnavailableError('HGST独立推理失败，请检查原模型运行环境。')
        result = HGSTPredictionResult(**packet['result'])
        if (result.model_artifact_sha256 != admission['artifact']['sha256']
                or result.model_admission_status != 'legacy_accepted' or result.source_type != 'timeseries_hgst'
                or not all(math.isfinite(p) and 0 <= p <= 1 for p in (result.probability, result.probability_control))
                or abs(result.probability + result.probability_control - 1) > 1e-5):
            raise ValueError('Original model result identity or probabilities do not match')
        return result
    except (ValueError, KeyError, TypeError) as exc:
        raise HGSTUnavailableError('HGST独立推理未返回有效的原权重分析结果。') from exc
