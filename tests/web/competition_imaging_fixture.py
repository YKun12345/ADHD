"""Synthetic imaging walkthrough through production APIs in a marked test store.

The CSV and NIfTI phantom are independently generated test inputs. Their ROI
correspondence, clinical meaning and the original HGST training provenance are
not asserted. No real images, mock prediction endpoint or training are used.
"""
from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path


ORIGINAL_HGST_SHA256 = '74575afa48ef423461ca463f8c57cc2f1b767c3cf320c94367c00e02aba7f95a'
SCOPES = ['profile', 'assessment', 'tracking', 'care', 'imaging']


def _request(client, receipts, method, path, headers, *, status=200, **kwargs):
    response = client.request(method, path, headers=headers, **kwargs)
    receipts.append({'method': method, 'path': path, 'status_code': response.status_code})
    assert response.status_code == status, f'{method} {path}: {response.status_code} {response.text[:2000]}'
    return response.json()


def _write_assets(directory: Path) -> dict:
    import nibabel as nib
    import numpy as np

    directory.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(18102026)
    # 64 actual numeric rows and 90 ROI columns, accepted by the real parser.
    timeseries = rng.normal(size=(64, 90))
    csv = '\n'.join(','.join(f'{value:.6f}' for value in row) for row in timeseries).encode('ascii') + b'\n'
    csv_path = directory / 'synthetic-competition-roi90.csv'
    csv_path.write_bytes(csv)

    # An analytic phantom, deliberately unrelated to an actual patient's brain.
    shape = (32, 40, 32)
    x, y, z = np.meshgrid(*(np.linspace(-1, 1, size) for size in shape), indexing='ij')
    ellipsoid = (x / .85) ** 2 + (y / .94) ** 2 + (z / .88) ** 2
    mask = ellipsoid < 1
    shells = 1.2 + .22 * np.cos(22 * ellipsoid) + .16 * np.sin(13 * y + 5 * z)
    core = .7 * np.exp(-((x / .48) ** 2 + (y / .67) ** 2 + (z / .6) ** 2))
    cavity = ((x / .12) ** 2 + ((y + .03) / .25) ** 2 + (z / .20) ** 2) < 1
    anatomy = np.where(mask, 70 * shells + 35 * core, 0)
    anatomy[cavity] = 12
    anatomy = anatomy.astype(np.float32)
    frames = []
    for frame in range(12):
        wave = np.sin(2 * np.pi * frame / 12 + 3 * x + 2 * z)
        frames.append(np.where(mask, anatomy + 8 * wave + 2 * rng.normal(size=shape), 0))
    functional = np.stack(frames, axis=-1).astype(np.float32)
    affine = np.diag([2.0, 2.0, 2.0, 1.0])
    affine[:3, 3] = [-32, -40, -32]

    assets = {'timeseries_csv': {'path': str(csv_path), 'sha256': hashlib.sha256(csv).hexdigest(),
        'shape': [64, 90], 'synthetic': True, 'source': 'numpy.default_rng(18102026); no real inputs'}}
    for key, name, data in (
        ('nifti_functional', 'synthetic-competition-functional.nii.gz', functional),
        ('nifti_anatomical', 'synthetic-competition-anatomical.nii.gz', anatomy),
    ):
        image = nib.Nifti1Image(data, affine)
        image.header['descrip'] = b'SYNTHETIC competition phantom; no patient data; not diagnostic'
        if data.ndim == 4:
            image.header.set_zooms((2, 2, 2, 2))
        raw = gzip.compress(image.to_bytes(), mtime=0)
        path = directory / name
        path.write_bytes(raw)
        assets[key] = {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
            'shape': list(data.shape), 'size_bytes': len(raw), 'synthetic': True,
            'source': 'analytic ellipsoid phantom with deterministic noise; no real inputs'}
    return assets


def provision_imaging(client, doctor_headers, owner_headers, patient_id, runtime, root) -> dict:
    """Create actual inference/report receipts and a loadable synthetic viewer.

    Call with the production FastAPI TestClient inside its initialized lifespan.
    The caller provisions the synthetic doctor qualification and full-scope care
    relationship. Files and receipts stay inside the caller's disposable store.
    """
    from competition_fixture import _isolated_runtime
    runtime, root = Path(runtime).resolve(), Path(root).resolve()
    _isolated_runtime(runtime, root)
    return _provision_imaging(client, doctor_headers, owner_headers, patient_id, runtime, root)


def provision_main_example_imaging(client, doctor_headers, owner_headers, patient_id, runtime, root):
    """Called only by the explicitly authorized main example provisioning tool."""
    from backend.app.db.session import SessionLocal
    from backend.app.models.patient import Patient
    from backend.app.services.example_scope_service import _membership
    runtime, root = Path(runtime).resolve(), Path(root).resolve()
    assert runtime == root / '.codex-tmp' / 'main-examples'
    with SessionLocal() as db:
        patient = db.get(Patient, patient_id)
        assert patient is not None and _membership(db, patient.user_id) is not None
    return _provision_imaging(client, doctor_headers, owner_headers, patient_id, runtime, root)


def _provision_imaging(client, doctor_headers, owner_headers, patient_id, runtime, root):
    import numpy as np
    from backend.app.core.config import settings
    from backend.app.services.hgst_runtime.service import resolve_inference_mode

    runtime, root = Path(runtime).resolve(), Path(root).resolve()
    assert isinstance(patient_id, int) and patient_id > 0
    assert resolve_inference_mode() == 'real', 'Real HGST is required; mock/auto are forbidden.'
    bundle = Path(settings.HGST_DEPLOYMENT_BUNDLE_PATH).resolve()
    assert bundle == (root / 'backend/models/hgst_adhd_bundle.pt').resolve(), 'Only the existing original HGST artifact is allowed.'
    before_sha = hashlib.sha256(bundle.read_bytes()).hexdigest()
    assert before_sha == ORIGINAL_HGST_SHA256, 'The original HGST artifact identity changed.'
    receipts = []
    admission = _request(client, receipts, 'GET', '/api/v1/model/admission', doctor_headers)
    assert admission['inference_mode'] == 'real' and admission['real_inference_allowed'] is True, admission
    assert admission['status'] == 'legacy_accepted' and admission['artifact']['sha256'] == before_sha, admission

    # Registration may grant only initial scopes. Add the imaging purpose scope
    # through the actual owner's consent API, preserving every other demo scope.
    consents = _request(client, receipts, 'GET', f'/api/v1/patient/consents?patient_id={patient_id}', owner_headers)
    effective = [row for row in consents['items'] if row['purpose'] == 'basic_use' and row.get('effective_access') is True]
    basic_consent = next((row for row in effective if set(SCOPES) <= set(row['scope'])), None)
    if basic_consent is None:
        basic_consent = _request(client, receipts, 'POST', '/api/v1/patient/consents', owner_headers, status=201,
            json={'patient_id': patient_id, 'purpose': 'basic_use', 'scope': SCOPES, 'terms_version': 'W02-1'})
    assert basic_consent['effective_access'] is True and 'imaging' in basic_consent['scope']

    asset_directory = runtime / 'synthetic-imaging'
    assert asset_directory.resolve().is_relative_to(runtime)
    assets = _write_assets(asset_directory)
    csv_path = Path(assets['timeseries_csv']['path'])
    prediction = _request(client, receipts, 'POST', f'/api/v1/model/predict_fmri?patient_id={patient_id}',
        doctor_headers, files={'timeseries_file': (csv_path.name, csv_path.read_bytes(), 'text/csv')})
    assert prediction['is_demo'] is False and prediction['source_type'] == 'fmri_hgst', prediction
    assert prediction['source_admission_status'] == 'legacy_accepted', prediction
    assert prediction['roi_dim_used'] == 90 and prediction['timepoints'] == 64, prediction
    assert 0 <= prediction['probability'] <= 1 and abs(prediction['probability'] + prediction['probability_control'] - 1) < 1e-5
    assert prediction['storage_context']['input']['sha256'] == assets['timeseries_csv']['sha256']
    assert prediction['storage_context']['input']['model_artifact_sha256'] == before_sha
    prediction_id = prediction['prediction_id']
    reports = _request(client, receipts, 'GET', f'/api/v1/care/imaging-reports?patient_id={patient_id}', owner_headers)
    system_report = next(row for row in reports['items'] if row['prediction_id'] == prediction_id and row['publisher_kind'] == 'system')
    assert system_report['version'] == 1 and system_report['professional_review_status'] == 'not_reviewed'

    context = _request(client, receipts, 'GET',
        f'/api/v1/care/imaging-reports/publication-context?patient_id={patient_id}&prediction_id={prediction_id}', doctor_headers)
    body = {key: context[key] for key in ('patient_id', 'prediction_id', 'expected_previous_version', 'input_digest', 'publication_context')}
    body.update(client_publication_id=f'competition-imaging-{patient_id}-{prediction_id}', confirmed=True,
        body='【合成演示】已人工核对本次真实HGST推理的保存来源及系统报告。输入为64个时间点、90个ROI的合成数值；原始影像页另用解析几何生成的NIfTI幻影。两种输入独立生成，未证明ROI对应关系。此版本展示医生确认发布与版本留存，不解释为个体患病风险。',
        limitations='全部输入均为合成测试资料，不涉及真实患者。沿用项目原有旧权重，训练来源、输入一致性和临床准确性未重新核验。真实推理仅指实际执行原HGST模型，不代表合成数据具备临床效度；不能用于诊断、治疗决策或疗效证明。')
    doctor_report = _request(client, receipts, 'POST', '/api/v1/care/imaging-reports', doctor_headers, json=body, status=201)
    assert doctor_report['version'] == 2 and doctor_report['professional_review_status'] == 'reviewed'
    assert doctor_report['source']['source_admission_status'] == 'legacy_accepted'
    assert doctor_report['raw_image_session_included'] is False
    assert _request(client, receipts, 'GET', f"/api/v1/care/imaging-reports/{doctor_report['id']}", owner_headers) == doctor_report
    assert _request(client, receipts, 'GET', f"/api/v1/care/imaging-reports/{system_report['id']}", owner_headers) == system_report
    assert _request(client, receipts, 'GET', f"/api/v1/care/imaging-reports/submissions/{body['client_publication_id']}", doctor_headers) == doctor_report

    session = _request(client, receipts, 'POST', '/api/v1/imaging/session', doctor_headers, json={'patient_id': patient_id})
    viewer_headers = {'X-Findviz-Patient-Id': str(patient_id)}
    functional = Path(assets['nifti_functional']['path'])
    anatomical = Path(assets['nifti_anatomical']['path'])
    upload = _request(client, receipts, 'POST', '/findviz/upload', viewer_headers, status=201,
        data={'fmri_file_type': 'nifti', 'ts_input': 'false', 'task_input': 'false'},
        files={'nii_func': (functional.name, functional.read_bytes(), 'application/gzip'),
            'nii_anat': (anatomical.name, anatomical.read_bytes(), 'application/gzip')})
    assert upload['file_type'] == 'nifti'
    ready = _request(client, receipts, 'GET', '/findviz/check_cache', viewer_headers)
    assert ready['has_cache'] is True and ready['plot_type'] == 'nifti', ready
    metadata = _request(client, receipts, 'GET', '/findviz/get_viewer_metadata?context_id=main', viewer_headers)
    fmri = _request(client, receipts, 'GET', '/findviz/get_fmri_data?context_id=main', viewer_headers)
    slices = fmri['data']['func']
    assert set(slices) == {'slice_1', 'slice_2', 'slice_3'}, slices.keys()
    slice_evidence = {}
    for name, values in slices.items():
        array = np.asarray(values, dtype=float)
        assert array.ndim == 2 and array.size > 0 and np.isfinite(array).all() and np.any(array != 0), name
        slice_evidence[name] = {'shape': list(array.shape), 'finite': True, 'nonzero_voxels': int(np.count_nonzero(array)),
            'minimum': float(array.min()), 'maximum': float(array.max())}

    visualization = _request(client, receipts, 'POST', f'/api/v1/doctor/patient/{patient_id}/imaging_visualization',
        doctor_headers, status=201, json={'visualization_type': 'nifti', 'func_file_name': functional.name,
            'anat_file_name': anatomical.name, 'notes': '【合成演示】Findviz已实际解析解析几何NIfTI幻影并返回三向切片。与推理CSV独立生成；未作ROI对应验证，未包含真实影像，不作医学解读。'})
    after_sha = hashlib.sha256(bundle.read_bytes()).hexdigest()
    assert after_sha == before_sha, 'The original HGST artifact must remain unchanged.'
    result = {'synthetic_only': True, 'patient_id': patient_id, 'training_performed': False,
        'real_patient_data_used': False, 'prediction_created_via_production_api': True,
        'inputs_roi_correspondence_verified': False, 'clinical_accuracy_verified': False,
        'assets': assets, 'model_admission': admission, 'basic_use_consent': basic_consent,
        'original_hgst_sha256_before': before_sha, 'original_hgst_sha256_after': after_sha,
        'prediction_id': prediction_id, 'prediction': prediction,
        'system_report_id': system_report['id'], 'system_report': system_report,
        'doctor_report_id': doctor_report['id'], 'doctor_report': doctor_report,
        'findviz': {'session': session, 'upload': upload, 'ready': True, 'metadata': metadata,
            'slice_evidence': slice_evidence, 'visualization_summary': visualization,
            'cache_scope': 'authenticated doctor and patient; authorization rechecked by production middleware'},
        'pages': {'doctor_visualization': f'/doctor-web/doctor_visualization.html?patient_id={patient_id}',
            'doctor_reports': f'/doctor-web/doctor_imaging_reports.html?patient_id={patient_id}',
            'patient_reports': f'/patient-web/patient_imaging_reports.html?patient_id={patient_id}',
            'mini_reports': f'/pages/imaging-reports/index?patient_id={patient_id}'},
        'browser_operation': {'requires_upload_after_server_restart': True,
            'same_origin_init_script': "window.FINDVIZ_BASE_PATH = location.origin + '/findviz';",
            'functional_input_selector': '#nifti-func', 'functional_file': str(functional),
            'anatomical_input_selector': '#nifti-anat', 'anatomical_file': str(anatomical),
            'upload_button_selector': '#submit-file', 'success_selector': '#uploadActionFeedback.success',
            'note': '登录合成医生后，从同源影像页选择两个生成文件并点击载入；只通过正常上传按钮初始化可视化，不注入或伪造切片。'},
        'http_receipts': receipts}
    receipt_path = asset_directory / 'imaging-receipts.json'
    result['receipt_path'] = str(receipt_path)
    receipt_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return result
