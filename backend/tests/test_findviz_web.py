from __future__ import annotations

import gzip
from io import BytesIO
import re
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import nibabel as nib
import numpy as np
import pytest


ROOT = Path(__file__).resolve().parents[2]
MODULE_REFERENCE = re.compile(
    r"(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['\"]([^'\"]+)['\"]"
)


def test_doctor_visualization_module_graph_is_served(client) -> None:
    """Follow browser module URLs, including the lazy-loaded imaging viewer."""
    html = client.get("/doctor-web/doctor_visualization.html")
    assert html.status_code == 200
    entry = re.search(r'<script type="module" src="(js/doctor_visualization[^\"]+)"', html.text)
    assert entry is not None
    pending = [
        urljoin("/doctor-web/doctor_visualization.html", entry.group(1)),
        "/findviz/static/js/viewer/AnalysisViewer.js",
    ]
    visited = set()
    canonical_paths = {
        "/" + path.relative_to(ROOT).as_posix()
        for directory in (ROOT / "doctor-web" / "js", ROOT / "findviz" / "static" / "js")
        for path in directory.rglob("*.js")
    }
    failures = []

    while pending:
        url = pending.pop()
        path = urlsplit(url).path
        if path in visited:
            continue
        visited.add(path)
        response = client.get(url)
        if response.status_code != 200:
            failures.append(f"{url}: HTTP {response.status_code}")
            continue
        if path not in canonical_paths:
            failures.append(f"{url}: filename case does not match the repository")
        assert "javascript" in response.headers["content-type"], url
        pending.extend(
            urljoin(url, reference)
            for reference in MODULE_REFERENCE.findall(response.text)
            if reference.startswith((".", "/"))
        )

    assert not failures, "\n".join(failures)
    assert "/findviz/static/js/viewer/MainViewer.js" in visited
    assert "/findviz/static/js/viewer/plots/NiftiViewer.js" in visited
    assert "/findviz/static/js/viewer/plots/GiftiViewer.js" in visited


def imaging_files(file_type: str) -> dict:
    """Small synthetic images; no patient files are used for verification."""
    if file_type == "nifti":
        data = np.random.default_rng(42).uniform(1, 10, (9, 10, 11, 4)).astype(np.float32)
        image = nib.Nifti1Image(data, np.diag([2, 2, 2, 1]))
        return {"nii_func": ("synthetic.nii.gz", gzip.compress(image.to_bytes()))}

    vertices = np.array(
        [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
        dtype=np.float32,
    )
    faces = np.array(
        [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
         [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]],
        dtype=np.int32,
    )
    mesh = nib.gifti.GiftiImage(darrays=[
        nib.gifti.GiftiDataArray(vertices, intent="NIFTI_INTENT_POINTSET"),
        nib.gifti.GiftiDataArray(faces, intent="NIFTI_INTENT_TRIANGLE"),
    ])
    functional = nib.gifti.GiftiImage(darrays=[
        nib.gifti.GiftiDataArray(np.arange(6, dtype=np.float32) + timepoint)
        for timepoint in range(4)
    ])
    return {
        f"{side}_gii_{kind}": (f"{side}.{suffix}.gii", image.to_bytes())
        for side in ("left", "right")
        for kind, suffix, image in (("func", "func", functional), ("mesh", "surf", mesh))
    }


@pytest.mark.parametrize("file_type", ["nifti", "gifti"])
def test_uploaded_images_provide_renderable_data(client, monkeypatch, tmp_path, file_type):
    from findviz import create_app
    from findviz.routes.shared import data_manager
    from findviz.viz.io.cache import Cache
    from findviz.viz.viewer.context import VisualizationContext

    cache = object.__new__(Cache)
    cache.temp_dir = tmp_path
    cache.cache_file = tmp_path / "viewer_cache.json"
    monkeypatch.setattr(Cache, "_instance", cache)
    monkeypatch.setattr(data_manager, "_contexts", {"main": VisualizationContext("main")})
    monkeypatch.setattr(data_manager, "_active_context_id", "main")

    # Standalone CLI viewer remains supported; mounted patient access is tested separately.
    client = create_app(testing=True).test_client()
    upload_data = {"fmri_file_type": file_type, "ts_input": "false", "task_input": "false"}
    upload_data.update({key: (BytesIO(content), name) for key, (name, content) in imaging_files(file_type).items()})
    response = client.post("/upload", data=upload_data, content_type="multipart/form-data")
    assert response.status_code == 201, response.text
    assert response.get_json()["file_type"] == file_type
    metadata_response = client.get("/get_viewer_metadata?context_id=main")
    assert metadata_response.status_code == 200, metadata_response.text
    metadata = metadata_response.get_json()
    ready = client.get("/check_cache").get_json()
    assert ready["has_cache"] is True
    assert ready["plot_type"] == file_type
    response = client.get("/get_fmri_data?context_id=main")
    assert response.status_code == 200, response.text
    data = response.get_json()["data"]
    if file_type == "nifti":
        assert set(data["func"]) == {"slice_1", "slice_2", "slice_3"}
        for values in data["func"].values():
            array = np.array(values, dtype=float)
            assert array.ndim == 2 and array.size > 0
            assert np.isfinite(array).all()
    else:
        assert len(data["left_hemisphere"]) == len(data["right_hemisphere"]) == 6
        for side in ("left", "right"):
            vertices = np.array(metadata[f"vertices_{side}"])
            faces = np.array(metadata[f"faces_{side}"])
            assert vertices.shape == (6, 3)
            assert faces.shape == (8, 3)
            assert np.isfinite(vertices).all()
            assert faces.min() >= 0 and faces.max() < len(vertices)
            assert np.isfinite(np.array(data[f"{side}_hemisphere"], dtype=float)).all()
