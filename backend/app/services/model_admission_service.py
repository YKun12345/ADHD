"""Read-only registry admission or explicitly retained, byte-pinned old bundle.

Legacy acceptance restores operation at the owner's request; it never creates
training, input-contract, licensing or professional-review evidence.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from backend.app.core.config import settings

ROOT = Path(__file__).resolve().parents[3]
ADMISSION_MESSAGE = '模型尚未通过来源、输入契约及用途准入核验，不能生成新的真实影像分析。已生成的历史结果仍按有效授权查看。'
LEGACY_BUNDLE = ROOT / 'backend/models/hgst_adhd_bundle.pt'
LEGACY_SHA256 = '74575afa48ef423461ca463f8c57cc2f1b767c3cf320c94367c00e02aba7f95a'
LEGACY_MESSAGE = '沿用项目原有HGST权重，可继续分析新影像。旧训练记录和输入一致性未重新核验；模型输出供辅助参考，由医生结合实际材料判断。'


class ModelAdmissionError(RuntimeError):
    pass


def _artifact(path: Path):
    try:
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            while block := stream.read(1024 * 1024):
                digest.update(block)
        return {'file_name': path.name, 'status': 'present', 'sha256': digest.hexdigest()}
    except FileNotFoundError:
        return {'file_name': path.name, 'status': 'missing', 'sha256': None}
    except OSError:
        return {'file_name': path.name, 'status': 'unreadable', 'sha256': None}


def inspect_hgst_admission(bundle_path: str | Path | None = None):
    if settings.MODEL_REGISTRY_ENABLED:
        from fastapi import HTTPException
        from backend.app.db.session import SessionLocal
        from backend.app.services.model_registry_service import active
        try:
            with SessionLocal() as db:
                version,path,revision=active(db)
                if bundle_path is not None and Path(bundle_path).expanduser().resolve()!=path:
                    raise HTTPException(409,'指定模型包不是当前唯一激活版本。')
                return {'status':'admitted','real_inference_allowed':True,'registry_status':'active','model_version_id':version.id,
                    'registry_revision':revision,'model_version':version.version,'input_contract_digest':version.manifest['input_contract_digest'],
                    'artifact':{'file_name':path.name,'status':'present','sha256':version.artifact_sha256},
                    'weights_provenance_status':'verified','training_data_provenance_status':'verified','input_contract_status':'verified',
                    'intended_use':version.manifest['purpose'],'reason_codes':[],'message':'当前已审核版本通过全部实例加载与输入契约准入。',
                    'historical_results_require_current_authority':True,'weights_loaded':False}
        except Exception as exc:
            return {'status':'unverified','real_inference_allowed':False,'registry_status':'unavailable',
                'reason_codes':['registry_or_activation_not_ready'],'message':getattr(exc,'detail',ADMISSION_MESSAGE),
                'historical_results_require_current_authority':True,'weights_loaded':False}
    path = Path(bundle_path if bundle_path is not None else settings.HGST_DEPLOYMENT_BUNDLE_PATH).expanduser()
    readme = ROOT / 'HGST-main/README.md'
    license_source = _artifact(readme)
    try:
        text = readme.read_text(encoding='utf-8')
        restricted = 'free for research and education use only' in text and 'formal permission first' in text
    except OSError:
        restricted = False
    sources = ['HGST-main/src/corr.py', 'HGST-main/src/getData.py',
        'backend/app/services/hgst_runtime/preprocessing.py']
    status = {'status': 'unverified', 'real_inference_allowed': False, 'registry_status': 'not_configured',
        'artifact': _artifact(path), 'weights_provenance_status': 'unverified', 'training_data_provenance_status': 'unverified',
        'code_license': {'declared_scope': 'research_and_education_only' if restricted else 'unverified',
            'intended_use_approved': False, 'source': 'HGST-main/README.md', 'source_sha256': license_source['sha256']},
        'input_contract_status': 'unverified', 'input_implementations': {name: _artifact(ROOT / name)['sha256'] for name in sources},
        'reason_codes': ['model_registry_not_configured', 'weights_provenance_unverified', 'training_data_provenance_unverified',
            'input_contract_unverified', 'intended_use_not_approved'], 'message': ADMISSION_MESSAGE,
        'historical_results_require_current_authority': True, 'weights_loaded': False}
    if (settings.HGST_LEGACY_COMPATIBILITY_ENABLED and path.resolve() == LEGACY_BUNDLE.resolve()
            and status['artifact']['sha256'] == LEGACY_SHA256):
        status.update(status='legacy_accepted', real_inference_allowed=True,
            acceptance_basis='owner_requested_existing_weight_2026_10_18',
            message=LEGACY_MESSAGE)
    return status


def require_hgst_admission(bundle_path: str | Path | None = None):
    status = inspect_hgst_admission(bundle_path)
    if not status['real_inference_allowed']:
        raise ModelAdmissionError(status['message'])
    return status


def registered_bundle_path(admission):
    from backend.app.db.session import SessionLocal
    from backend.app.services.model_registry_service import active
    with SessionLocal() as db:
        version,path,revision=active(db)
        if version.id!=admission['model_version_id'] or revision!=admission['registry_revision']:
            raise ModelAdmissionError('实际模型版本指针已变化，请重新发起分析。')
        return path
