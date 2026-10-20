"""Independent signed project node. Private keys, ROI and HGST features stay here."""
from __future__ import annotations

import argparse
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import zipfile

import numpy as np
import torch

from federated_runtime.framing import read_frame, write_frame
from federated_runtime.hgst_features import (
    CLASSIFIER_NAMES, MAX_ARRAY_BYTES, _local_path, _validate_manifest,
    canonical_json, file_sha256, run_legacy_feature_extraction, sha256_bytes,
)
from federated_runtime.privacy_store import PrivacyStore, merged_history


class NodeRejected(ValueError):
    pass


class MLPClassifier(torch.nn.Module):
    """Exact original classifier structure; no HGST encoder imports in Torch 2.6."""
    def __init__(self, input_dim):
        super().__init__()
        self.linear1 = torch.nn.Linear(input_dim, 256)
        self.relu = torch.nn.LeakyReLU()
        self.linear2 = torch.nn.Linear(256, 2)
        for layer in (self.linear1, self.linear2):
            torch.nn.init.xavier_uniform_(layer.weight)
            torch.nn.init.zeros_(layer.bias)

    def forward(self, features):
        return self.linear2(self.relu(self.linear1(features)))


def public_initial_arrays(input_dim, public_seed=1729):
    # Restore the unseeded process RNG before Poisson draws, DP noise or keys.
    with torch.random.fork_rng():
        torch.manual_seed(public_seed)
        model = MLPClassifier(input_dim)
    return [value.detach().numpy().copy() for value in model.state_dict().values()]


def validate_arrays(arrays, input_dim):
    expected = ((256, input_dim), (256,), (2, 256), (2,))
    if len(arrays) != 4 or any(value.dtype != np.float32 or value.shape != shape
                             or not np.isfinite(value).all() for value, shape in zip(arrays, expected)):
        raise NodeRejected("Classifier requires the original four finite float32 MLP arrays")


def load_base(path, input_dim):
    with np.load(path, allow_pickle=False) as archive:
        if set(archive.files) != set(CLASSIFIER_NAMES):
            raise NodeRejected("Base NPZ requires exactly the four original classifier names")
        arrays = [archive[name].copy() for name in CLASSIFIER_NAMES]
    validate_arrays(arrays, input_dim)
    return arrays


def arrays_digest(arrays):
    descriptors = [{"name": name, "shape": list(value.shape), "dtype": str(value.dtype),
                    "sha256": sha256_bytes(value.tobytes(order="C"))}
                   for name, value in zip(CLASSIFIER_NAMES, arrays)]
    return sha256_bytes(canonical_json(descriptors))


def slot_dataset(features, labels, capacity=64):
    from torch.utils.data import TensorDataset
    if not (features.dtype == np.float32 and features.ndim == 2 and 0 < len(features) <= capacity
            and np.isfinite(features).all() and labels.dtype == np.int64 and labels.shape == (len(features),)
            and np.isin(labels, [0, 1]).all()):
        raise NodeRejected("Local features and labels violate the synthetic slot contract")
    values = torch.zeros((capacity, features.shape[1]), dtype=torch.float32)
    targets = torch.zeros(capacity, dtype=torch.int64)
    occupied = torch.zeros(capacity, dtype=torch.float32)
    values[:len(features)] = torch.from_numpy(features.copy())
    targets[:len(features)] = torch.from_numpy(labels.copy())
    occupied[:len(features)] = 1
    return TensorDataset(values, targets, occupied)


def weighted_loss(logits, targets, occupied):
    if not len(targets):
        return logits.sum()
    return (torch.nn.functional.cross_entropy(logits, targets, reduction="none") * occupied).sum()


def make_private_training(parameters, features, labels, privacy):
    from opacus import PrivacyEngine
    from torch.utils.data import DataLoader
    validate_arrays(parameters, features.shape[1])
    model = MLPClassifier(features.shape[1])
    model.load_state_dict({name: torch.from_numpy(value.copy()) for name, value in zip(CLASSIFIER_NAMES, parameters)}, strict=True)
    dataset = slot_dataset(features, labels, privacy["capacity"])
    expected_batch = int(privacy["capacity"] * privacy["sample_rate"])
    loader = DataLoader(dataset, batch_size=expected_batch, shuffle=False)
    optimizer = torch.optim.SGD(model.parameters(), lr=.05, momentum=0)
    engine = PrivacyEngine(accountant="rdp", secure_mode=False)
    model, optimizer, loader = engine.make_private(
        module=model, optimizer=optimizer, data_loader=loader,
        noise_multiplier=privacy["noise_multiplier"], max_grad_norm=privacy["max_grad_norm"],
        poisson_sampling=True, loss_reduction="sum")
    # Hooks retain raw, unnormalised sample gradients (sum). The DP optimizer
    # clips those gradients, adds sigma*C noise, then divides by public E[|B|].
    # Its loss_reduction is deliberately independent of the model hook setting.
    optimizer.loss_reduction = "mean"
    optimizer.expected_batch_size = expected_batch
    if loader.sample_rate != privacy["sample_rate"] or len(dataset) != 64 or expected_batch != 8:
        raise NodeRejected("Actual Poisson sampler differs from the frozen 64-slot contract")
    return model, optimizer, loader, engine


def _read_local_features(directory, local, key, request):
    metadata_file = directory / "features.metadata.json"
    features_file = directory / "features.npz"
    if not metadata_file.exists() or not features_file.exists():
        run_legacy_feature_extraction(directory, directory / "manifest.json",
            candidate_path=request["candidate_path"], candidate_sha256=request["candidate_sha256"],
            legacy_python=request["legacy_python"], legacy_site_packages=request.get("legacy_site_packages"))
    raw = metadata_file.read_bytes()
    if len(raw) > 1024 * 1024:
        raise NodeRejected("Local feature metadata exceeds its bound")
    signed = json.loads(raw)
    payload = signed["payload"]
    key.public_key().verify(bytes.fromhex(signed["signature_hex"]), canonical_json(payload))
    required = {"node_id": local["node_id"], "protection_namespace": local["protection_namespace"],
                "manifest_sha256": file_sha256(directory / "manifest.json"),
                "candidate_sha256": request["candidate_sha256"], "config_sha256": request["config_sha256"],
                "feature_dimension": request["classifier_input_dim"]}
    if any(payload.get(name) != value for name, value in required.items()):
        raise NodeRejected("Signed local HGST feature contract differs from the frozen round")
    if not features_file.is_file() or features_file.stat().st_size > MAX_ARRAY_BYTES:
        raise NodeRejected("Local feature array exceeds its bound")
    feature_bytes = features_file.read_bytes()
    if sha256_bytes(feature_bytes) != payload["features_sha256"]:
        raise NodeRejected("Local HGST feature digest mismatch")
    with zipfile.ZipFile(io.BytesIO(feature_bytes)) as archive:
        if len(archive.infolist()) != 6 or sum(item.file_size for item in archive.infolist()) > MAX_ARRAY_BYTES:
            raise NodeRejected("Local feature NPZ exceeds its numeric resource bound")
    with np.load(io.BytesIO(feature_bytes), allow_pickle=False) as archive:
        if set(archive.files) != {"features", "labels", *CLASSIFIER_NAMES}:
            raise NodeRejected("Local feature NPZ has unexpected arrays")
        features, labels = archive["features"].copy(), archive["labels"].copy()
        classifier = [archive[name] for name in CLASSIFIER_NAMES]
        validate_arrays(classifier, request["classifier_input_dim"])
        for descriptor, value in zip(local["classifier_parameters"], classifier):
            if sha256_bytes(value.tobytes(order="C")) != descriptor["sha256"]:
                raise NodeRejected("Feature NPZ classifier reference changed")
    if features.ndim != 2 or features.shape[1] != request["classifier_input_dim"]:
        raise NodeRejected("HGST feature dimension differs from the original MLP")
    slot_dataset(features, labels)
    return features, labels, sha256_bytes(raw)


class SignedChannel:
    def __init__(self, manifest, node, key, store):
        self.manifest, self.node, self.key, self.store = manifest, node, key, store
        self.sequence = 0
        self.previous = "0" * 64
        self.request_sha256 = "0" * 64
        self.incoming, self.outgoing = sys.stdin.buffer, sys.stdout.buffer

    def receive(self):
        raw = read_frame(self.incoming)
        self.request_sha256 = sha256_bytes(raw)
        packet = json.loads(raw)
        if not isinstance(packet, dict) or packet.get("schema") != "federated-request/v1":
            raise NodeRejected("Unexpected local request schema")
        return packet

    def emit(self, kind, *, protobuf=None, **fields):
        self.sequence += 1
        payload = {"schema": "federated-node-reply/v1", "kind": kind,
            "node_id": self.node["node_id"], "institution_id": self.node["institution_id"],
            "index": self.node["index"], "experiment_id": self.manifest["experiment_id"],
            "round": self.manifest["round"], "attempt": self.manifest["attempt"],
            "pid": os.getpid(), "parent_pid": os.getppid(), "seq": self.sequence,
            "base_parameters_sha256": self.manifest["base_parameters_sha256"],
            "request_sha256": self.request_sha256, "previous_reply_sha256": self.previous, **fields}
        if protobuf is not None:
            payload["protobuf_sha256"] = sha256_bytes(protobuf)
        signed = {"payload": payload, "signature_hex": self.key.sign(canonical_json(payload)).hex()}
        self.previous = sha256_bytes(canonical_json(signed))
        wire = {**signed, **({"protobuf_b64": base64.b64encode(protobuf).decode("ascii")} if protobuf is not None else {})}
        write_frame(self.outgoing, canonical_json(wire))
        return self.previous

    def gate(self, action):
        digest = self.emit("gate_request", action=action,
                           privacy=self.store.snapshot(self.manifest["privacy"]["delta"]))
        # A one-use decision binds this exact signed gate. No authorisation cache.
        decision = json.loads(read_frame(self.incoming))
        if (decision.get("kind") != "gate_response" or decision.get("gate_sha256") != digest
                or decision.get("authorized") is not True):
            raise NodeRejected("Fresh project authorisation gate denied")


def train(parameters, features, labels, manifest, channel, store):
    privacy = manifest["privacy"]
    channel.gate("training_start")
    if manifest["mode"] == "dp_secagg":
        reservation = store.reserve(manifest["experiment_id"], manifest["round"], manifest["attempt"], privacy)
        model, optimizer, loader, engine = make_private_training(parameters, features, labels, privacy)
        iterator = iter(loader)
        for _ in range(privacy["logical_steps"]):
            channel.gate("logical_step")
            batch, target, occupied = next(iterator)
            optimizer.zero_grad()
            weighted_loss(model(batch), target, occupied).backward()
            for parameter in model.parameters():
                if (len(occupied) and torch.count_nonzero(parameter.grad_sample[occupied == 0]).item()
                        or not torch.isfinite(parameter.grad_sample).all()):
                    raise NodeRejected("Placeholder sample gradients are not finite exact zeros")
            optimizer.step()
            store.record_step(reservation["reservation_token"], engine.accountant.history, privacy["delta"])
        state = model._module.state_dict()
        actual_history = merged_history([engine.accountant.history])
        metrics = {"accountant_history": json.dumps(actual_history), "logical_steps": privacy["logical_steps"],
                   "epsilon": float(engine.get_epsilon(delta=privacy["delta"])), "secure_rng": False}
    else:
        model = MLPClassifier(features.shape[1])
        model.load_state_dict({name: torch.from_numpy(value.copy()) for name, value in zip(CLASSIFIER_NAMES, parameters)}, strict=True)
        optimizer = torch.optim.SGD(model.parameters(), lr=.05, momentum=0)
        dataset = slot_dataset(features, labels)
        for _ in range(privacy["logical_steps"]):
            channel.gate("logical_step")
            selected = torch.rand(privacy["capacity"]) < privacy["sample_rate"]
            batch, target, occupied = [value[selected] for value in dataset.tensors]
            optimizer.zero_grad()
            (weighted_loss(model(batch), target, occupied) / 8).backward()
            optimizer.step()
        state = model.state_dict()
        metrics = {"logical_steps": privacy["logical_steps"], "dp_enabled": False, "secagg_enabled": False}
    delta = [np.clip(state[name].detach().numpy() - prior, -1., 1.).astype(np.float32)
             for name, prior in zip(CLASSIFIER_NAMES, parameters)]
    validate_arrays(delta, features.shape[1])
    channel.gate("update_ready")
    return delta, metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--index", type=int, choices=(1, 2, 3), required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    if manifest.get("schema") != "federated-round/v1" or manifest.get("synthetic_only") is not True:
        parser.error("Only explicitly synthetic project manifests are permitted")
    node = next(value for value in manifest["nodes"] if value["index"] == args.index)
    directory = Path(node["directory"]).resolve()
    local = json.loads((directory / "manifest.json").read_bytes())
    config = _validate_manifest(local)
    if local["node_id"] != node["node_id"] or sha256_bytes(canonical_json(config)) != manifest["config_sha256"]:
        raise NodeRejected("Frozen local identity/config differs from round manifest")
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    key_file = _local_path(directory, local["private_key_file"], relative=True)
    if key_file.stat().st_size > 4096:
        raise NodeRejected("Oversized node-local key")
    key = serialization.load_pem_private_key(key_file.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise NodeRejected("Only node-local Ed25519 keys are permitted")
    public_pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode("ascii")
    public_raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    if public_pem != node["public_key_pem"] or sha256_bytes(public_raw) != local["node_public_key_sha256"]:
        raise NodeRejected("Node private key does not match registered public identity")
    store = PrivacyStore(directory / "privacy.sqlite3", local["protection_namespace"], node["node_id"], key)
    channel = SignedChannel(manifest, node, key, store)
    try:
        if channel.receive().get("kind") != "start":
            raise NodeRejected("Node requires a fresh start handshake")
        channel.gate("node_start")
        features, labels, feature_metadata_sha = _read_local_features(directory, local, key, manifest)
        base = load_base(manifest["base_parameters_path"], manifest["classifier_input_dim"])
        if arrays_digest(base) != manifest["base_parameters_sha256"]:
            raise NodeRejected("Base arrays do not match the frozen round")
        snapshot = store.snapshot(manifest["privacy"]["delta"])
        projected = merged_history([snapshot["reserved_history"], [[manifest["privacy"]["noise_multiplier"],
            manifest["privacy"]["sample_rate"], manifest["privacy"]["logical_steps"]]]]) if manifest["mode"] == "dp_secagg" else snapshot["reserved_history"]
        channel.gate("hello_reply")
        channel.emit("hello", privacy=snapshot, projected_reserved_history=projected,
                     feature_metadata_sha256=feature_metadata_sha, classifier_input_dim=features.shape[1])
        from flwr.client import ClientApp, NumPyClient
        from flwr.client.mod import secaggplus_mod
        from flwr.common import Context, RecordDict
        from flwr.common.serde import message_from_proto, message_to_proto
        from flwr.proto.message_pb2 import Message as ProtoMessage
        metrics = {}
        fitted = False
        class Node(NumPyClient):
            def fit(self, parameters, config):
                nonlocal fitted, metrics
                if fitted or arrays_digest(parameters) != manifest["base_parameters_sha256"]:
                    raise NodeRejected("Repeated fit or changed common base is forbidden")
                fitted = True
                delta, metrics = train(parameters, features, labels, manifest, channel, store)
                return delta, 1, {**metrics, "node_pid": os.getpid(), "institution_weight": 1}
        app = ClientApp(client_fn=lambda context: Node().to_client(),
                        mods=[secaggplus_mod] if manifest["mode"] == "dp_secagg" else [])
        context = Context(run_id=1, node_id=args.index, node_config={}, state=RecordDict(), run_config={})
        while True:
            try:
                packet = channel.receive()
            except EOFError:
                return 0
            if packet.get("kind") == "finalize":
                channel.gate("aggregate_commit")
                channel.emit("final_ready", privacy=store.snapshot(manifest["privacy"]["delta"]), training=metrics)
                continue
            if packet.get("kind") != "protocol":
                raise NodeRejected("Only Flower protocol messages are accepted after handshake")
            raw = base64.b64decode(packet["protobuf_b64"], validate=True)
            message = message_from_proto(ProtoMessage.FromString(raw))
            if (message.metadata.run_id != 1 or message.metadata.dst_node_id != args.index
                    or message.metadata.src_node_id != 0):
                raise NodeRejected("Flower request identity differs from this independent node")
            channel.gate("protocol_compute")
            with contextlib.redirect_stdout(sys.stderr):
                reply = app(message, context)
            channel.gate("protocol_reply")
            channel.emit("protocol_reply", protobuf=message_to_proto(reply).SerializeToString(),
                         privacy=store.snapshot(manifest["privacy"]["delta"]), training=metrics)
    except Exception as error:
        # Never send subject data, private paths, logits, losses or tracebacks.
        channel.emit("failed", error_type=type(error).__name__, privacy=store.snapshot(manifest["privacy"]["delta"]))
        return 2


if __name__ == "__main__":
    torch.set_num_threads(1)
    raise SystemExit(main())
