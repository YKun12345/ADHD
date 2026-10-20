"""Isolated F02 checks; no business settings, real database, or patient data."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
import pytest


ROOT = Path(__file__).resolve().parents[1]
LEGACY = ROOT / ".codex-tmp/python310-compat-f00/python.exe"
SITE = ROOT / ".venv-hgst/Lib/site-packages"


def _features_module():
    import importlib.util
    target = ROOT / "federated_runtime/hgst_features.py"
    assert target.exists(), "F02 local HGST feature adapter has not been implemented"
    spec = importlib.util.spec_from_file_location("f02_features_under_test", target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_rejects_candidate_digest_and_node_directory_escape_before_loading_torch(tmp_path):
    module = _features_module()
    node = tmp_path / "node"
    node.mkdir()
    candidate = tmp_path / "candidate.pt"
    candidate.write_bytes(b"not even a torch bundle")
    actual = hashlib.sha256(candidate.read_bytes()).hexdigest()
    manifest = node / "manifest.json"
    manifest.write_text("{}", encoding="utf-8")
    with pytest.raises(module.FeatureContractError, match="candidate.*SHA-256"):
        module.extract_local_features(node, manifest, candidate_path=candidate,
                                      candidate_sha256="0" * 64)
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")
    with pytest.raises(module.FeatureContractError, match="node directory"):
        module.extract_local_features(node, outside, candidate_path=candidate,
                                      candidate_sha256=actual)


def test_rejects_node_identity_outside_registration_contract():
    module = _features_module()
    for identity in ("../node", "node.with.dot", "医院A", "n" * 65):
        with pytest.raises(module.FeatureContractError, match="node identity"):
            module._validate_manifest({"schema": module.SCHEMA, "synthetic": True,
                "mode": "synthetic_research_only", "node_id": identity, "protection_namespace": "scope"})


@pytest.mark.parametrize("invalid", ["pickle", "nonfinite", "labels", "roi_count", "synthetic"])
def test_rejects_unsafe_or_invalid_local_numeric_arrays(tmp_path, invalid):
    module = _features_module()
    roi = np.ones((2, 10, 90), dtype=np.float32)
    labels = np.array([0, 1], dtype=np.int64)
    synthetic = np.array(True, dtype=np.bool_)
    if invalid == "pickle":
        roi = np.array([{"arbitrary": "Python object"}], dtype=object)
    elif invalid == "nonfinite":
        roi[0, 0, 0] = np.nan
    elif invalid == "labels":
        labels[0] = 2
    elif invalid == "roi_count":
        roi = roi[:, :, :89]
    elif invalid == "synthetic":
        synthetic = np.array(False, dtype=np.bool_)
    target = tmp_path / "roi.npz"
    np.savez(target, roi=roi, labels=labels, synthetic=synthetic)
    with pytest.raises(module.FeatureContractError):
        module._load_roi(target, module.file_sha256(target), np)


@pytest.mark.skipif(not LEGACY.exists() or not SITE.exists(), reason="isolated legacy runtime is unavailable")
def test_actual_legacy_hgst_features_remain_local_and_signed(tmp_path):
    module = _features_module()
    node = tmp_path / "synthetic-node"
    provision = subprocess.run(
        [str(LEGACY), "-B", str(ROOT / "tools/provision-federated-synthetic-node.py"),
         "--node-directory", str(node), "--node-id", "synthetic-node-a",
         "--legacy-site-packages", str(SITE)],
        cwd=ROOT, capture_output=True, text=True, timeout=90,
    )
    assert provision.returncode == 0, provision.stderr
    manifest = json.loads((node / "manifest.json").read_text(encoding="utf-8"))
    candidate = node / "synthetic-candidate.pt"
    receipt = module.run_legacy_feature_extraction(
        node, node / "manifest.json", candidate_path=candidate,
        candidate_sha256=manifest["candidate_sha256"], legacy_python=LEGACY,
        legacy_site_packages=SITE,
    )
    assert receipt["status"] == "features_ready"
    assert set(receipt) == {"status", "candidate_sha256", "features_sha256", "metadata_sha256"}
    with np.load(node / "features.npz", allow_pickle=False) as arrays:
        assert arrays["features"].shape == (8, 90 * 8)
        assert arrays["features"].dtype == np.float32
        assert np.isfinite(arrays["features"]).all()
        assert arrays["labels"].shape == (8,)
        assert arrays["linear1.weight"].shape == (256, 720)
        assert arrays["linear1.bias"].shape == (256,)
        assert arrays["linear2.weight"].shape == (2, 256)
        assert arrays["linear2.bias"].shape == (2,)
    signed = json.loads((node / "features.metadata.json").read_text(encoding="utf-8"))
    enrollment = json.loads((node / "public-enrollment.json").read_text(encoding="utf-8"))
    assert signed["public_key_hex"] == enrollment["public_key_hex"]
    assert "BEGIN PUBLIC KEY" in enrollment["public_key_pem"]
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(signed["public_key_hex"])).verify(
        bytes.fromhex(signed["signature_hex"]), module.canonical_json(signed["payload"]),
    )
    assert signed["payload"]["runtime"]["torch"] == "1.13.1+cpu"
    assert signed["payload"]["runtime"]["dhg"] == "0.9.5"
    assert signed["payload"]["candidate_sha256"] == manifest["candidate_sha256"]
    assert signed["payload"]["encoder_origin"] == "fresh_random_synthetic_untrained"
    assert signed["payload"]["r03_equivalence_verified"] is False
    # Altered local data and escapes must fail before any output is overwritten.
    for field, value, match in [("roi_file", "../outside.npz", "node directory"),
                                ("synthetic", False, "synthetic")]:
        modified = dict(manifest)
        modified[field] = value
        (node / "manifest.json").write_text(json.dumps(modified), encoding="utf-8")
        with pytest.raises(module.FeatureContractError, match=match):
            module.extract_local_features(node, node / "manifest.json", candidate_path=candidate,
                                          candidate_sha256=manifest["candidate_sha256"])
