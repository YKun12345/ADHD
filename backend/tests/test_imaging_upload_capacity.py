from __future__ import annotations

import pytest
from backend.tests.test_findviz_security import imaging_actors, open_workspace


def test_upload_configuration_requires_login(client, imaging_actors, monkeypatch):
    assert client.get('/api/v1/imaging/upload_limits').status_code == 401
    monkeypatch.setenv('FINDVIZ_MAX_UPLOAD_BYTES', '104857600')
    response = client.get('/api/v1/imaging/upload_limits', headers=imaging_actors['doctor']['headers'])
    assert response.status_code == 200
    assert response.json()['max_body_bytes'] == 104857600


def test_valid_nifti_above_old_64mb_limit_can_be_visualized(client, imaging_actors, monkeypatch):
    import nibabel as nib
    import numpy as np
    monkeypatch.delenv('FINDVIZ_MAX_UPLOAD_BYTES', raising=False)
    open_workspace(client, imaging_actors)
    image = nib.Nifti1Image(np.ones((5, 6, 7, 3), dtype=np.float32), np.eye(4))
    content = image.to_bytes()
    # A valid image with trailing padding exercises multipart size without a huge volume.
    content += b'\0' * (65 * 1024 * 1024 - len(content))
    response = client.post('/findviz/upload', files={'nii_func': ('synthetic-large.nii', content)},
                           data={'fmri_file_type': 'nifti', 'ts_input': 'false', 'task_input': 'false'})
    assert response.status_code == 201, response.text[:300]
    assert client.get('/findviz/get_fmri_data?context_id=main').status_code == 200


def test_oversized_upload_reports_configured_limit_and_preserves_existing_workspace(client, imaging_actors, monkeypatch):
    from backend.tests.test_findviz_web import imaging_files
    open_workspace(client, imaging_actors)
    response = client.post('/findviz/upload', files=imaging_files('nifti'),
                           data={'fmri_file_type': 'nifti', 'ts_input': 'false', 'task_input': 'false'})
    assert response.status_code == 201
    monkeypatch.setenv('FINDVIZ_MAX_UPLOAD_BYTES', '1024')
    rejected = client.post('/findviz/upload', files={'nii_func': ('synthetic.nii', b'x' * 2048)},
                           data={'fmri_file_type': 'nifti'})
    assert rejected.status_code == 413
    assert rejected.json()['max_body_bytes'] == 1024
    assert '上传' in rejected.json()['detail']
    assert client.get('/findviz/check_cache').json()['has_cache'] is True
