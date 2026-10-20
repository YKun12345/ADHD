"""F02 node-local bridge to the unchanged HGST encoder runtime.

The caller must resolve an approved ModelVersion to an absolute candidate path
and frozen SHA-256; neither a request body nor the local manifest selects code
or a Python object to deserialize. This module never imports business settings.

Manifest v1 binds synthetic mode, node identity, protection namespace, ROI NPZ
path/hash, candidate hash, full config/hash, preprocessing contract and the four
classifier parameter descriptors. All manifest paths are relative to the node.
``features.npz`` and signed ``features.metadata.json`` are local artifacts, not
central receipts. stdout contains only their digests. No training occurs here.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "federated-hgst-features/v1"
CLASSIFIER_NAMES = ("linear1.weight", "linear1.bias", "linear2.weight", "linear2.bias")
MAX_BUNDLE_BYTES = 512 * 1024 * 1024
MAX_ARRAY_BYTES = 128 * 1024 * 1024


class FeatureContractError(ValueError):
    """A frozen node-local input, path, digest or runtime contract was violated."""


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("utf-8")


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _digest(value, description):
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise FeatureContractError(description + " must be a lowercase SHA-256")
    return value


def _local_path(node, value, *, relative=False):
    path = Path(value)
    if relative and (path.is_absolute() or path.drive):
        raise FeatureContractError("Manifest paths must be relative to the node directory")
    target = (path if path.is_absolute() else node / path).resolve()
    if target == node or not target.is_relative_to(node):
        raise FeatureContractError("Path escapes the node directory")
    return target


def input_contract(config):
    return {"roi_count": 90, "roi_order": list(range(90)),
            "atlas": "synthetic_90_roi_no_clinical_atlas_claim",
            "layout": "subject,time,roi", "minimum_timepoints": 10,
            "connectivity": "numpy.corrcoef",
            "normalization": "center_and_population_std_per_roi",
            "hyperedges": "sklearn.linear_model.Lasso",
            "lasso_alpha": config["edge_lambda"], "lasso_max_iter": 5000,
            "lasso_tol": 0.0001, "r03_equivalence_verified": False}


def validate_config(config):
    if not isinstance(config, dict):
        raise FeatureContractError("Candidate config must be a JSON object")
    required = {"num_nodes", "in_dim", "hid_dim", "num_classes", "encoder_type", "decoder_type",
                "use_bn", "dropout", "mask_rate", "replace_rate", "loss_fn", "edge_lambda", "connectivity_kind"}
    if not required.issubset(config):
        raise FeatureContractError("Candidate config is incomplete")
    try:
        canonical_json(config)
    except (ValueError, TypeError) as error:
        raise FeatureContractError("Candidate config must contain finite JSON values") from error
    for name in ("num_nodes", "in_dim", "num_classes", "hid_dim"):
        if type(config[name]) is not int:
            raise FeatureContractError("Candidate config dimensions must be integers")
    if (config["num_nodes"], config["in_dim"], config["num_classes"]) != (90, 90, 2):
        raise FeatureContractError("Candidate must bind 90 ROI and two classes")
    if not 1 <= config["hid_dim"] <= 1024 or type(config["use_bn"]) is not bool:
        raise FeatureContractError("Candidate hidden dimension or BatchNorm flag is invalid")
    for name in ("dropout", "mask_rate", "replace_rate", "edge_lambda"):
        value = config[name]
        if type(value) not in (float, int) or not math.isfinite(value):
            raise FeatureContractError("Candidate numerical config must be finite")
        if not (0 <= value < 1 if name != "edge_lambda" else 0 < value <= 10):
            raise FeatureContractError("Candidate numerical config is out of bounds")
    if config["connectivity_kind"] != "correlation":
        raise FeatureContractError("Only the frozen numpy.corrcoef deployment contract is supported")
    if any(config[name] not in ("hgnn", "hgnnp") for name in ("encoder_type", "decoder_type")):
        raise FeatureContractError("Unsupported candidate encoder/decoder")
    if config["loss_fn"] not in ("sce", "mse"):
        raise FeatureContractError("Unsupported candidate loss")
    return config


def candidate_config(bundle):
    """Read safe JSON metadata; Torch 1.13's weights loader rejects pickle floats.

    New trusted candidates therefore store canonical config_json as a string.
    A config mapping remains supported when its pickle opcodes are understood
    by that locked loader. There is deliberately no unsafe deserialization path.
    """
    if not isinstance(bundle, dict):
        raise FeatureContractError("Candidate must be a tensor bundle mapping")
    if "config_json" in bundle:
        raw = bundle["config_json"]
        if not isinstance(raw, str) or len(raw) > 128 * 1024:
            raise FeatureContractError("Candidate config_json must be a bounded JSON string")
        try:
            config = json.loads(raw)
        except ValueError as error:
            raise FeatureContractError("Candidate config_json is invalid") from error
    else:
        config = bundle.get("config")
    return validate_config(config)


def _validate_manifest(manifest):
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        raise FeatureContractError("Unsupported frozen local manifest schema")
    if manifest.get("synthetic") is not True or manifest.get("mode") != "synthetic_research_only":
        raise FeatureContractError("Only explicitly synthetic research data is permitted")
    if not isinstance(manifest.get("node_id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", manifest["node_id"]):
        raise FeatureContractError("Frozen local node identity must match the registration contract")
    for name in ("node_id", "protection_namespace"):
        value = manifest.get(name)
        if not isinstance(value, str) or not value.strip() or len(value) > 200:
            raise FeatureContractError("Frozen local node identity is missing")
    config = validate_config(manifest.get("config"))
    if manifest.get("config_sha256") != sha256_bytes(canonical_json(config)):
        raise FeatureContractError("Frozen config SHA-256 mismatch")
    if manifest.get("input_contract") != input_contract(config):
        raise FeatureContractError("Frozen HGST preprocessing contract mismatch")
    return config


def _load_source(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "backend/app/services/hgst_runtime" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def legacy_dependencies():
    import numpy as np
    import torch
    import dhg
    import sklearn
    import pandas
    import cryptography
    if torch.__version__.split("+")[0] != "1.13.1" or dhg.__version__ != "0.9.5":
        raise FeatureContractError("Extraction requires actual Torch 1.13.1 and DHG 0.9.5; use the isolated legacy runtime")
    modeling = _load_source("federated_local_hgst_modeling", "modeling.py")
    preprocessing = _load_source("federated_local_hgst_preprocessing", "preprocessing.py")
    runtime = {"python": sys.version.split()[0], "torch": torch.__version__, "dhg": dhg.__version__,
               "numpy": np.__version__, "sklearn": sklearn.__version__, "pandas": pandas.__version__,
               "cryptography": cryptography.__version__}
    return np, torch, dhg, modeling, preprocessing, runtime


def make_encoder(modeling, config):
    return modeling.PreModel(in_dim=config["in_dim"], hid_dim=config["hid_dim"],
        edge_dim=config["num_nodes"], feat_drop=config["dropout"], use_bn=config["use_bn"],
        mask_rate=config["mask_rate"], encoder_type=config["encoder_type"],
        decoder_type=config["decoder_type"], loss_fn=config["loss_fn"],
        replace_rate=config["replace_rate"], drop_edge_rate=config.get("drop_edge_rate", 0.0),
        alpha_l=config.get("alpha_l", 2))


def tensor_descriptors(state, np, torch, names=None):
    if not isinstance(state, dict) or not state or len(state) > 256:
        raise FeatureContractError("Candidate state must be a bounded tensor mapping")
    if any(not isinstance(name, str) for name in state):
        raise FeatureContractError("Candidate tensor names must be strings")
    result = []
    for name in names if names is not None else sorted(state):
        value = state.get(name)
        if not isinstance(value, torch.Tensor) or value.dtype != torch.float32 or not torch.isfinite(value).all():
            # BatchNorm's num_batches_tracked is the sole supported integer buffer.
            if not (isinstance(value, torch.Tensor) and name.endswith(".num_batches_tracked")
                    and value.dtype == torch.int64 and value.ndim == 0):
                raise FeatureContractError("Candidate contains invalid or nonfinite tensors")
        array = value.detach().cpu().contiguous().numpy()
        result.append({"name": name, "shape": list(array.shape), "dtype": str(array.dtype),
                       "sha256": sha256_bytes(array.tobytes(order="C"))})
    return result


def _load_roi(path, expected_sha256, np):
    _digest(expected_sha256, "ROI SHA-256")
    if not path.is_file() or path.stat().st_size > MAX_ARRAY_BYTES:
        raise FeatureContractError("Missing or oversized local ROI NPZ")
    raw = path.read_bytes()
    if sha256_bytes(raw) != expected_sha256:
        raise FeatureContractError("Local ROI SHA-256 mismatch")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) != 3 or sum(item.file_size for item in entries) > MAX_ARRAY_BYTES:
                raise FeatureContractError("ROI NPZ exceeds its bounded numeric contract")
        with np.load(io.BytesIO(raw), allow_pickle=False) as arrays:
            if set(arrays.files) != {"roi", "labels", "synthetic"}:
                raise FeatureContractError("ROI NPZ requires exactly roi, labels and synthetic")
            roi, labels, synthetic = arrays["roi"], arrays["labels"], arrays["synthetic"]
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        raise FeatureContractError("ROI NPZ must contain safe numeric arrays with allow_pickle=False") from error
    if synthetic.shape != () or synthetic.dtype != np.bool_ or not bool(synthetic):
        raise FeatureContractError("ROI NPZ must carry an explicit synthetic flag")
    if roi.dtype not in (np.dtype("float32"), np.dtype("float64")) or roi.ndim != 3:
        raise FeatureContractError("ROI array must be floating subject,time,roi data")
    if not (1 <= roi.shape[0] <= 64 and 10 <= roi.shape[1] <= 4096 and roi.shape[2] == 90):
        raise FeatureContractError("ROI array requires 1..64 subjects, 10..4096 timepoints and 90 ROI")
    if not np.isfinite(roi).all():
        raise FeatureContractError("ROI values must all be finite")
    if labels.dtype != np.int64 or labels.shape != (len(roi),) or not np.isin(labels, [0, 1]).all():
        raise FeatureContractError("Labels must be one int64 binary label per synthetic subject")
    return roi, labels


def _atomic_write(path, raw):
    descriptor, temporary = tempfile.mkstemp(prefix=".f02-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()


def extract_local_features(node_directory, manifest_path, *, candidate_path, candidate_sha256):
    """Run only inside the legacy process; return digest-only local status."""
    node = Path(node_directory).resolve()
    if not node.is_dir():
        raise FeatureContractError("The node directory must already exist")
    manifest_file = _local_path(node, manifest_path)
    candidate = Path(candidate_path)
    if not candidate.is_absolute():
        raise FeatureContractError("Trusted candidate path must be absolute")
    candidate = candidate.resolve()
    _digest(candidate_sha256, "candidate SHA-256")
    if not candidate.is_file() or candidate.stat().st_size > MAX_BUNDLE_BYTES:
        raise FeatureContractError("Missing or oversized trusted candidate")
    # Hash and load the same immutable bytes, avoiding a check/load path race.
    candidate_bytes = candidate.read_bytes()
    if sha256_bytes(candidate_bytes) != candidate_sha256:
        raise FeatureContractError("Trusted candidate SHA-256 mismatch")
    if not manifest_file.is_file() or manifest_file.stat().st_size > 1024 * 1024:
        raise FeatureContractError("Missing or oversized frozen local manifest")
    manifest_bytes = manifest_file.read_bytes()
    try:
        manifest = json.loads(manifest_bytes)
    except (ValueError, UnicodeDecodeError) as error:
        raise FeatureContractError("Frozen local manifest must be JSON") from error
    config = _validate_manifest(manifest)
    if manifest.get("candidate_sha256") != candidate_sha256:
        raise FeatureContractError("Frozen manifest candidate SHA-256 mismatch")
    roi_path = _local_path(node, manifest.get("roi_file", ""), relative=True)
    key_path = _local_path(node, manifest.get("private_key_file", ""), relative=True)
    feature_path = _local_path(node, "features.npz", relative=True)
    metadata_path = _local_path(node, "features.metadata.json", relative=True)
    if len({manifest_file, roi_path, key_path, feature_path, metadata_path, candidate}) != 6:
        raise FeatureContractError("Node inputs and outputs must have distinct paths")
    np, torch, dhg, modeling, preprocessing, runtime = legacy_dependencies()
    torch.set_num_threads(1)
    roi, labels = _load_roi(roi_path, manifest.get("roi_sha256"), np)
    # No generic pickle fallback, even in the original Torch 1.13.1 environment.
    bundle = torch.load(io.BytesIO(candidate_bytes), map_location="cpu", weights_only=True)
    if candidate_config(bundle) != config:
        raise FeatureContractError("Candidate config differs from the frozen manifest")
    if bundle.get("classifier_input_dim") != 90 * config["hid_dim"]:
        raise FeatureContractError("Candidate classifier input dimension mismatch")
    encoder_state, classifier_state = bundle.get("encoder_state_dict"), bundle.get("classifier_state_dict")
    encoder_parameters = tensor_descriptors(encoder_state, np, torch)
    if not isinstance(classifier_state, dict) or set(classifier_state) != set(CLASSIFIER_NAMES):
        raise FeatureContractError("Classifier must contain exactly the four original MLP parameters")
    classifier_parameters = tensor_descriptors(classifier_state, np, torch, CLASSIFIER_NAMES)
    if manifest.get("classifier_parameters") != classifier_parameters:
        raise FeatureContractError("Frozen classifier parameter descriptors differ from the candidate")
    encoder = make_encoder(modeling, config)
    encoder.load_state_dict(encoder_state, strict=True)
    encoder.eval()
    encoder.requires_grad_(False)
    classifier = modeling.MLPClassifier(90 * config["hid_dim"], 2)
    classifier.load_state_dict(classifier_state, strict=True)
    features = []
    with torch.no_grad():
        for timeseries in roi:
            # These are the original deployment functions, not an approximation.
            connectivity = preprocessing.subject_connectivity(timeseries)
            hyperedges = preprocessing.construct_hyperedges_from_time_series(timeseries, lambda_value=config["edge_lambda"])
            graph = dhg.Hypergraph(90, hyperedges)
            embedded = encoder.embed(torch.tensor(connectivity, dtype=torch.float32), graph)
            feature = embedded.reshape(-1).cpu().numpy().astype(np.float32, copy=False)
            if feature.shape != (90 * config["hid_dim"],) or not np.isfinite(feature).all():
                raise FeatureContractError("HGST produced invalid or nonfinite local embeddings")
            features.append(feature)
    local_arrays = {"features": np.stack(features), "labels": labels,
                    **{name: classifier_state[name].detach().cpu().numpy() for name in CLASSIFIER_NAMES}}
    stream = io.BytesIO()
    np.savez_compressed(stream, **local_arrays)
    feature_bytes = stream.getvalue()
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    if not key_path.is_file() or key_path.stat().st_size > 4096:
        raise FeatureContractError("Missing or oversized node-local Ed25519 private key")
    private_key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    if not isinstance(private_key, Ed25519PrivateKey):
        raise FeatureContractError("Node-local key must be Ed25519")
    public_bytes = private_key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    if manifest.get("node_public_key_sha256") != sha256_bytes(public_bytes):
        raise FeatureContractError("Node-local key differs from the frozen public identity")
    payload = {"schema": SCHEMA, "mode": "synthetic_research_only", "node_id": manifest["node_id"],
        "protection_namespace": manifest["protection_namespace"], "manifest_sha256": sha256_bytes(manifest_bytes),
        "candidate_sha256": candidate_sha256, "config_sha256": manifest["config_sha256"],
        "input_contract_sha256": sha256_bytes(canonical_json(manifest["input_contract"])),
        "features_sha256": sha256_bytes(feature_bytes), "feature_dimension": 90 * config["hid_dim"],
        "encoder_parameters_sha256": sha256_bytes(canonical_json(encoder_parameters)),
        "classifier_parameters": classifier_parameters, "runtime": runtime,
        "modeling_code_sha256": file_sha256(ROOT / "backend/app/services/hgst_runtime/modeling.py"),
        "preprocessing_code_sha256": file_sha256(ROOT / "backend/app/services/hgst_runtime/preprocessing.py"),
        "encoder_origin": bundle.get("encoder_origin", "external_unverified"),
        "r03_equivalence_verified": False, "clinical_admission": False, "encoder_dp_protected": False,
        "node_public_key_sha256": sha256_bytes(public_bytes)}
    signed = {"payload": payload, "public_key_hex": public_bytes.hex(),
              "signature_hex": private_key.sign(canonical_json(payload)).hex()}
    metadata_bytes = canonical_json(signed)
    _atomic_write(feature_path, feature_bytes)
    _atomic_write(metadata_path, metadata_bytes)
    return {"status": "features_ready", "candidate_sha256": candidate_sha256,
            "features_sha256": payload["features_sha256"], "metadata_sha256": sha256_bytes(metadata_bytes)}


def run_legacy_feature_extraction(node_directory, manifest_path, *, candidate_path, candidate_sha256,
                                  legacy_python, legacy_site_packages=None, timeout=180):
    """Modern node launcher. Paths and interpreter are trusted local configuration."""
    command = [str(Path(legacy_python).resolve()), "-B", str(Path(__file__).resolve()),
               "--node-directory", str(Path(node_directory).resolve()),
               "--manifest", str(Path(manifest_path).resolve()),
               "--candidate", str(candidate_path), "--candidate-sha256", candidate_sha256]
    if legacy_site_packages is not None:
        command += ["--legacy-site-packages", str(Path(legacy_site_packages).resolve())]
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, cwd=ROOT)
    if result.returncode:
        # Child output may include local paths but is intentionally not forwarded
        # into a central log or surfaced as patient-level diagnostic data.
        raise FeatureContractError("Legacy HGST feature subprocess failed; inspect the node-local inputs and runtime")
    try:
        receipt = json.loads(result.stdout)
    except ValueError as error:
        raise FeatureContractError("Legacy HGST returned invalid digest-only status") from error
    if set(receipt) != {"status", "candidate_sha256", "features_sha256", "metadata_sha256"} or receipt["status"] != "features_ready":
        raise FeatureContractError("Legacy HGST returned an unexpected status contract")
    for field in ("candidate_sha256", "features_sha256", "metadata_sha256"):
        _digest(receipt[field], field)
    if receipt["candidate_sha256"] != candidate_sha256:
        raise FeatureContractError("Legacy HGST returned a different candidate SHA-256")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-directory", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--candidate-sha256", required=True)
    parser.add_argument("--legacy-site-packages")
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    if args.legacy_site_packages:
        sys.path.insert(0, str(Path(args.legacy_site_packages).resolve()))
    try:
        receipt = extract_local_features(args.node_directory, args.manifest,
            candidate_path=args.candidate, candidate_sha256=args.candidate_sha256)
    except Exception as error:
        print("F02 extraction refused: " + type(error).__name__ + ": " + str(error), file=sys.stderr)
        return 2
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
