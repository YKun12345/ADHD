"""Create one fresh, isolated synthetic F02 node; never read patient data.

Without --candidate this writes a fresh random, untrained 90-ROI/hid_dim=8
research candidate inside the new node directory. With --candidate, supply the
same trusted absolute candidate path and SHA-256 later resolved by ModelVersion.
Run in the legacy interpreter with -B and its unchanged site-packages directory.
The printed enrollment contains only the public identity and candidate digest.
"""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
import re
import sys
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-directory", required=True)
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--protection-namespace")
    parser.add_argument("--candidate")
    parser.add_argument("--candidate-sha256")
    parser.add_argument("--legacy-site-packages")
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    if args.legacy_site_packages:
        sys.path.insert(0, str(Path(args.legacy_site_packages).resolve()))
    sys.path.insert(0, str(ROOT))
    from federated_runtime.hgst_features import (
        SCHEMA, CLASSIFIER_NAMES, FeatureContractError, canonical_json,
        candidate_config, file_sha256, input_contract, legacy_dependencies, make_encoder,
        sha256_bytes, tensor_descriptors, validate_config,
    )
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    node = Path(args.node_directory)
    if not node.is_absolute() or node.exists():
        parser.error("The synthetic node directory must be an explicit fresh absolute path")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.node_id):
        parser.error("The node identity must be 1..64 ASCII letters, digits, underscores or hyphens")
    if bool(args.candidate) != bool(args.candidate_sha256):
        parser.error("An existing candidate requires both absolute path and SHA-256")
    np, torch, dhg, modeling, preprocessing, runtime = legacy_dependencies()
    torch.set_num_threads(1)
    candidate_bytes = None
    if args.candidate:
        candidate = Path(args.candidate)
        if not candidate.is_absolute() or not candidate.is_file():
            parser.error("Trusted candidate must be an existing absolute path")
        candidate_bytes = candidate.read_bytes()
        if sha256_bytes(candidate_bytes) != args.candidate_sha256:
            raise FeatureContractError("Trusted candidate SHA-256 mismatch")
        bundle = torch.load(io.BytesIO(candidate_bytes), map_location="cpu", weights_only=True)
        config = candidate_config(bundle)
    else:
        config = {"num_nodes": 90, "in_dim": 90, "hid_dim": 8, "num_classes": 2,
                  "encoder_type": "hgnnp", "decoder_type": "hgnnp", "use_bn": True,
                  "dropout": 0.0, "mask_rate": 0.5, "replace_rate": 0.05,
                  "loss_fn": "sce", "edge_lambda": 0.2, "connectivity_kind": "correlation",
                  "model_name": "fresh_synthetic_hgst_no_clinical_admission",
                  "model_version": "f02-synthetic-v1"}
        # A public fixture seed initializes synthetic test weights only. fork_rng
        # restores process state; key generation uses the OS and no DP runs here.
        with torch.random.fork_rng():
            torch.manual_seed(20261017)
            encoder = make_encoder(modeling, config)
            classifier = modeling.MLPClassifier(90 * config["hid_dim"], 2)
        # Torch 1.13.1 weights_only lacks the pickle BINFLOAT opcode. Keep the
        # full typed config in safe JSON and a legacy-inference config mapping
        # with numerical strings (the original inference constructor casts them).
        legacy_config = {name: str(value) if type(value) is float else value for name, value in config.items()}
        bundle = {"config": legacy_config, "config_json": canonical_json(config).decode("utf-8"),
                  "encoder_state_dict": encoder.state_dict(),
                  "classifier_state_dict": classifier.state_dict(),
                  "classifier_input_dim": 90 * config["hid_dim"],
                  "encoder_origin": "fresh_random_synthetic_untrained",
                  "training_scope": "none", "synthetic": True,
                  "clinical_admission": False, "r03_equivalence_verified": False}
        stream = io.BytesIO()
        torch.save(bundle, stream)
        candidate_bytes = stream.getvalue()
        candidate = node / "synthetic-candidate.pt"
    config = validate_config(config)
    # Validate the package's actual tensors before creating any local node files.
    tensor_descriptors(bundle.get("encoder_state_dict"), np, torch)
    classifier_state = bundle.get("classifier_state_dict")
    if not isinstance(classifier_state, dict) or set(classifier_state) != set(CLASSIFIER_NAMES):
        raise FeatureContractError("Candidate must have the four original MLP parameters")
    descriptors = tensor_descriptors(classifier_state, np, torch, CLASSIFIER_NAMES)
    make_encoder(modeling, config).load_state_dict(bundle["encoder_state_dict"], strict=True)
    modeling.MLPClassifier(90 * config["hid_dim"], 2).load_state_dict(classifier_state, strict=True)
    if bundle.get("classifier_input_dim") != 90 * config["hid_dim"]:
        raise FeatureContractError("Candidate classifier dimension mismatch")
    node.mkdir(parents=True, exist_ok=False)
    key_dir = node / "keys"
    key_dir.mkdir()
    if not args.candidate:
        with candidate.open("xb") as target:
            target.write(candidate_bytes)
    rng = np.random.default_rng(20261017)
    roi = rng.normal(size=(8, 32, 90)).astype(np.float32)
    labels = (np.arange(8) % 2).astype(np.int64)
    np.savez_compressed(node / "roi.npz", roi=roi, labels=labels, synthetic=np.array(True, dtype=np.bool_))
    private_key = Ed25519PrivateKey.generate()
    private_path = key_dir / "ed25519-private.pem"
    private_path.write_bytes(private_key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    public_bytes = private_key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    public_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    (key_dir / "ed25519-public.pem").write_bytes(public_pem)
    # A new namespace represents this entirely new synthetic scope only. Runtime
    # configuration changes for an existing scope must retain its prior namespace.
    manifest = {"schema": SCHEMA, "mode": "synthetic_research_only", "synthetic": True,
        "node_id": args.node_id, "protection_namespace": args.protection_namespace or "synthetic-" + uuid4().hex,
        "roi_file": "roi.npz", "roi_sha256": file_sha256(node / "roi.npz"),
        "private_key_file": "keys/ed25519-private.pem", "candidate_sha256": sha256_bytes(candidate_bytes),
        "node_public_key_sha256": sha256_bytes(public_bytes),
        "config": config, "config_sha256": sha256_bytes(canonical_json(config)),
        "input_contract": input_contract(config), "classifier_parameters": descriptors}
    (node / "manifest.json").write_bytes(canonical_json(manifest))
    enrollment = {"node_id": args.node_id, "public_key_hex": public_bytes.hex(),
                  "public_key_pem": public_pem.decode("ascii"),
                  "public_key_sha256": sha256_bytes(public_bytes),
                  "candidate_sha256": manifest["candidate_sha256"],
                  "mode": "synthetic_research_only"}
    (node / "public-enrollment.json").write_bytes(canonical_json(enrollment))
    print(json.dumps(enrollment, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
