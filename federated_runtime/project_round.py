"""Trusted worker entry point for one synthetic HGST classifier round.

``run_round(manifest, authorize)`` launches three independent signed nodes and
returns a JSON receipt. ``authorize`` is required and called afresh for every
signed node gate; a business worker must re-read its authoritative DB there.
The CLI's explicitly synthetic-only gate is solely an engineering check.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import importlib.metadata
import io
import json
import os
import queue
from pathlib import Path
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from uuid import UUID, uuid4
import zipfile

from federated_runtime.framing import read_frame, write_frame
from federated_runtime.hgst_features import (
    CLASSIFIER_NAMES, MAX_ARRAY_BYTES, MAX_BUNDLE_BYTES,
    candidate_config, canonical_json, sha256_bytes,
)
from federated_runtime.privacy_store import epsilon_for_history, merged_history


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PRIVACY = {"capacity": 64, "noise_multiplier": 2.0, "max_grad_norm": 1.0,
                   "sample_rate": .125, "logical_steps": 2, "delta": 1e-5,
                   "max_epsilon": 10.0, "max_rounds": 5}
REQUIRED_VERSIONS = {"flwr": "1.23.0", "opacus": "1.5.4", "torch": "2.6.0", "numpy": "1.26.4"}


class RoundRejected(ValueError):
    pass


class AuthorizationDenied(RoundRejected):
    pass


def check_environment():
    actual = {name: importlib.metadata.version(name) for name in REQUIRED_VERSIONS}
    if actual != REQUIRED_VERSIONS or Path(sys.prefix).resolve().name != ".venv-federated":
        raise RoundRejected("Use only the isolated pinned .venv-federated environment")
    return actual


def _public_key(node):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    key = serialization.load_pem_public_key(node["public_key_pem"].encode("ascii"))
    if not isinstance(key, Ed25519PublicKey):
        raise RoundRejected("Registered node identity must be Ed25519")
    return key


def verify_signed_envelope(envelope, node, manifest, *, sequence, previous_sha256, request_sha256):
    from cryptography.exceptions import InvalidSignature
    if (not isinstance(envelope, dict) or set(envelope) - {"payload", "signature_hex", "protobuf_b64"}
            or not isinstance(envelope.get("payload"), dict)):
        raise RoundRejected("Invalid signed node envelope")
    payload = envelope["payload"]
    required = {"schema": "federated-node-reply/v1", "node_id": node["node_id"],
        "institution_id": node["institution_id"], "index": node["index"],
        "experiment_id": manifest["experiment_id"], "round": manifest["round"], "attempt": manifest["attempt"],
        "base_parameters_sha256": manifest["base_parameters_sha256"], "seq": sequence,
        "previous_reply_sha256": previous_sha256, "request_sha256": request_sha256}
    if any(payload.get(name) != value for name, value in required.items()):
        raise RoundRejected("Signed reply identity, sequence, request or common base mismatch")
    try:
        _public_key(node).verify(bytes.fromhex(envelope["signature_hex"]), canonical_json(payload))
        if "protobuf_b64" in envelope:
            raw = base64.b64decode(envelope["protobuf_b64"], validate=True)
            if sha256_bytes(raw) != payload.get("protobuf_sha256"):
                raise RoundRejected("Signed protobuf digest mismatch")
    except (InvalidSignature, ValueError, KeyError) as error:
        raise RoundRejected("Node signature or protected packet is invalid") from error
    return {"payload": payload, "signature_hex": envelope["signature_hex"]}


def _verify_actual_pid(child, payload):
    pid = payload.get("pid")
    if type(pid) is not int or pid <= 0:
        raise RoundRejected("Signed node PID is invalid")
    if pid == child.pid:
        child.federated_node_pid = pid
        return
    # Windows venv's redirector can launch the actual interpreter as a child.
    # Verify that parent relation with the OS, rather than trusting reported PPID.
    if os.name != "nt":
        raise RoundRejected("Signed node PID differs from the launched process")
    import ctypes
    from ctypes import wintypes
    class BasicInfo(ctypes.Structure):
        _fields_ = [("Reserved1", ctypes.c_void_p), ("PebBaseAddress", ctypes.c_void_p),
                    ("Reserved2", ctypes.c_void_p * 2), ("UniqueProcessId", ctypes.c_size_t),
                    ("InheritedFromUniqueProcessId", ctypes.c_size_t)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        raise RoundRejected("Cannot inspect actual node process identity")
    try:
        info = BasicInfo()
        query = ctypes.WinDLL("ntdll").NtQueryInformationProcess
        query.argtypes = [wintypes.HANDLE, wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG, ctypes.c_void_p]
        if query(handle, 0, ctypes.byref(info), ctypes.sizeof(info), None) != 0 or info.InheritedFromUniqueProcessId != child.pid:
            raise RoundRejected("Actual interpreter is not the launched node process")
        child.federated_node_pid = pid
    finally:
        kernel.CloseHandle(handle)


def _kill_child_tree(child):
    if os.name == "nt":
        # Terminate only the OS-verified node interpreter and its owned launcher;
        # broad process enumeration is unnecessary and can be denied in a sandbox.
        pid = getattr(child, "federated_node_pid", child.pid)
        if pid != child.pid:
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(1, False, pid)
            if handle:
                try:
                    kernel.TerminateProcess(handle, 1)
                finally:
                    kernel.CloseHandle(handle)
    if child.poll() is None:
        child.kill()


def validate_privacy_snapshot(snapshot, node, delta):
    if not isinstance(snapshot, dict) or snapshot.get("accountant") != "rdp":
        raise RoundRejected("Missing signed persistent privacy snapshot")
    events = snapshot.get("signed_events", [])
    if len(events) > 100000:
        raise RoundRejected("Privacy event history exceeds its resource bound")
    previous, reserved, actual = "0" * 64, {}, {}
    for sequence, signed in enumerate(events, 1):
        payload = signed["payload"]
        _public_key(node).verify(bytes.fromhex(signed["signature_hex"]), canonical_json(payload))
        if (payload.get("schema") != "federated-privacy-event/v1" or payload.get("node_id") != node["node_id"]
                or payload.get("namespace") != snapshot["namespace"] or payload.get("ledger_epoch") != snapshot["ledger_epoch"]
                or payload.get("sequence") != sequence or payload.get("previous_sha256") != previous):
            raise RoundRejected("Signed privacy chain identity or sequence mismatch")
        token = payload["token"]
        if payload["event"] == "reserved":
            if token in reserved:
                raise RoundRejected("Duplicate privacy reservation event")
            reserved[token] = payload["history"]
        elif payload["event"] == "spent" and token in reserved:
            prior_steps = sum(item[2] for item in actual.get(token, []))
            if (sum(item[2] for item in payload["history"]) != prior_steps + 1
                    or sum(item[2] for item in payload["history"]) > sum(item[2] for item in reserved[token])
                    or any(item[:2] != reserved[token][0][:2] for item in payload["history"])):
                raise RoundRejected("Signed actual privacy steps are not monotonic")
            actual[token] = payload["history"]
        else:
            raise RoundRejected("Invalid signed privacy event transition")
        previous = sha256_bytes(canonical_json(signed))
    history = merged_history(reserved.values())
    epsilon = epsilon_for_history(history, delta)
    if (snapshot.get("ledger_sequence") != len(events) or snapshot.get("ledger_head_sha256") != previous
            or snapshot.get("reserved_history") != history or snapshot.get("actual_history") != merged_history(actual.values())
            or snapshot.get("delta") != delta or abs(snapshot.get("epsilon", -1) - epsilon) > 1e-10):
        raise RoundRejected("Privacy summary differs from the original signed event chain")
    return history


def _prepare_manifest(value):
    import numpy as np
    import torch
    from cryptography.hazmat.primitives import serialization
    from federated_runtime.project_node import arrays_digest, load_base, public_initial_arrays, validate_arrays
    manifest = json.loads(canonical_json(value))
    if manifest.get("schema") != "federated-round/v1" or manifest.get("synthetic_only") is not True:
        raise RoundRejected("Only explicit synthetic federated-round/v1 manifests are accepted")
    if manifest.get("mode") not in ("dp_secagg", "synthetic_plaintext"):
        raise RoundRejected("Unknown mode; there is no plaintext fallback")
    if not isinstance(manifest.get("experiment_id"), str) or not 0 < len(manifest["experiment_id"]) <= 128:
        raise RoundRejected("A bounded persistent experiment identity is required")
    UUID(manifest["attempt"])
    if type(manifest.get("round")) is not int or not 1 <= manifest["round"] <= 5:
        raise RoundRejected("Round must remain within the maximum five-round plan")
    privacy = {**DEFAULT_PRIVACY, **manifest.get("privacy", {})}
    if set(privacy) != set(DEFAULT_PRIVACY) or any(privacy[name] != expected for name, expected in DEFAULT_PRIVACY.items() if name != "noise_multiplier"):
        raise RoundRejected("Privacy settings differ from the frozen final 64-slot research preset")
    if type(privacy["noise_multiplier"]) not in (int, float) or not 2 <= privacy["noise_multiplier"] <= 100:
        raise RoundRejected("Noise multiplier must be at least two and finite")
    manifest["privacy"] = privacy
    for name, expected in (("legacy_python", ROOT / ".codex-tmp/python310-compat-f00/python.exe"),
                           ("legacy_site_packages", ROOT / ".venv-hgst/Lib/site-packages")):
        configured = Path(manifest.get(name, str(expected)))
        if not configured.is_absolute() or configured.resolve() != expected.resolve() or not configured.exists():
            raise RoundRejected("Legacy feature extraction must use the unchanged pinned local runtime")
        manifest[name] = str(configured.resolve())
    nodes = manifest.get("nodes", [])
    if (len(nodes) != 3 or {node.get("index") for node in nodes} != {1, 2, 3}
            or len({node.get("node_id") for node in nodes}) != 3
            or len({node.get("institution_id") for node in nodes}) != 3):
        raise RoundRejected("Exactly three distinct registered institutions and nodes are required")
    for node in nodes:
        _public_key(node)
        path = Path(node["directory"])
        if not path.is_absolute() or not path.is_dir():
            raise RoundRejected("Nodes require existing trusted absolute local directories")
        node["directory"] = str(path.resolve())
    if len({_public_key(node).public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw) for node in nodes}) != 3:
        raise RoundRejected("All three nodes require independent Ed25519 public identities")
    if len({node["directory"].casefold() for node in nodes}) != 3:
        raise RoundRejected("Node directories must be independent")
    candidate = Path(manifest["candidate_path"])
    if not candidate.is_absolute() or not candidate.is_file() or candidate.stat().st_size > MAX_BUNDLE_BYTES:
        raise RoundRejected("An explicit bounded trusted research candidate is required")
    raw = candidate.read_bytes()
    if sha256_bytes(raw) != manifest["candidate_sha256"]:
        raise RoundRejected("Trusted candidate SHA-256 mismatch")
    bundle = torch.load(io.BytesIO(raw), map_location="cpu", weights_only=True)
    config = candidate_config(bundle)
    input_dim = 90 * config["hid_dim"]
    state = bundle.get("classifier_state_dict")
    if not isinstance(state, dict) or set(state) != set(CLASSIFIER_NAMES):
        raise RoundRejected("Candidate classifier must contain exactly four original MLP arrays")
    if any(not isinstance(state[name], torch.Tensor) for name in CLASSIFIER_NAMES):
        raise RoundRejected("Candidate classifier state must contain only tensors")
    reference = [state[name].detach().cpu().numpy().copy() for name in CLASSIFIER_NAMES]
    validate_arrays(reference, input_dim)
    if bundle.get("classifier_input_dim") != input_dim:
        raise RoundRejected("Candidate classifier dimension differs from HGST config")
    base_file = manifest.get("base_parameters_path")
    if base_file:
        path = Path(base_file)
        if not path.is_absolute() or not path.is_file() or path.stat().st_size > MAX_ARRAY_BYTES:
            raise RoundRejected("Base parameters require a bounded trusted absolute NPZ")
        base_bytes = path.read_bytes()
        with zipfile.ZipFile(io.BytesIO(base_bytes)) as archive:
            if len(archive.infolist()) != 4 or sum(item.file_size for item in archive.infolist()) > MAX_ARRAY_BYTES:
                raise RoundRejected("Base parameters exceed the four-array numeric bound")
        base = load_base(io.BytesIO(base_bytes), input_dim)
        initialisation = "previous_committed_public_arrays"
        if manifest["round"] == 1:
            if arrays_digest(base) != arrays_digest(public_initial_arrays(input_dim, 1729)):
                raise RoundRejected("First round requires fresh public-seed initialisation, not a trained private classifier")
            initialisation = "fresh_public_seed_1729_original_mlp"
    else:
        if manifest["round"] != 1:
            raise RoundRejected("A later round requires the previous committed four-array base")
        base = public_initial_arrays(input_dim, 1729)
        initialisation = "fresh_public_seed_1729_original_mlp"
    if manifest.get("base_parameters_sha256") not in (None, arrays_digest(base)):
        raise RoundRejected("Frozen base parameter SHA-256 differs from the trusted arrays")
    output = Path(manifest["output_directory"])
    if not output.is_absolute() or output.exists():
        raise RoundRejected("Round output must be a fresh absolute directory")
    for node in nodes:
        if output.resolve().is_relative_to(Path(node["directory"])) or Path(node["directory"]).is_relative_to(output.resolve()):
            raise RoundRejected("Central output must be separate from each private node directory")
    output.mkdir(parents=True, exist_ok=False)
    base_path = output / "base-parameters.npz"
    np.savez(base_path, **dict(zip(CLASSIFIER_NAMES, base)))
    manifest.update(candidate_path=str(candidate.resolve()), base_parameters_path=str(base_path),
                    base_parameters_sha256=arrays_digest(base), classifier_input_dim=input_dim,
                    config_sha256=sha256_bytes(canonical_json(config)), output_directory=str(output.resolve()),
                    initialization=initialisation)
    (output / "round-manifest.json").write_bytes(canonical_json(manifest))
    return manifest, base


def run_round(manifest, authorize):
    """Execute one round; return completed/aborted/failed receipt (no fallback).

    Input paths and identities come from trusted worker configuration. The parent
    reads only the public candidate/base, never node manifests, keys or features.
    Each ``authorize(event)`` receives a verified signed gate's payload plus its
    signature_hex. It must return the boolean True for this exact fresh event.
    Exceptions and false decisions abort all children without publishing a model.
    """
    if not callable(authorize):
        raise TypeError("A fresh authoritative authorization callback is mandatory")
    versions = check_environment()
    manifest, base = _prepare_manifest(manifest)
    import numpy as np
    from flwr.common import ConfigRecord, Context, FitIns, Message, MessageType, RecordDict, ndarrays_to_parameters, parameters_to_ndarrays
    from flwr.common.recorddict_compat import parameters_to_arrayrecord, fitins_to_recorddict, recorddict_to_fitres
    from flwr.common.serde import message_from_proto, message_to_proto
    from flwr.proto.message_pb2 import Message as ProtoMessage
    from flwr.server import LegacyContext
    from flwr.server.workflow import SecAggPlusWorkflow
    from flwr.server.workflow.constant import MAIN_CONFIGS_RECORD, MAIN_PARAMS_RECORD, Key
    from federated_runtime.project_node import arrays_digest, validate_arrays
    directory = Path(manifest["output_directory"])
    nodes = {node["index"]: node for node in manifest["nodes"]}
    children, logs, latest, handshakes = {}, [], {}, {}
    sequences = {index: 0 for index in nodes}
    chains = {index: "0" * 64 for index in nodes}
    phases, gates = [], []
    event_log = (directory / "signed-node-events.jsonl").open("wb")
    started = time.monotonic()
    receipt = {"schema": "federated-round-receipt/v1", "experiment_id": manifest["experiment_id"],
        "round": manifest["round"], "attempt": manifest["attempt"], "mode": manifest["mode"],
        "synthetic_only": True, "applied": False, "status": "running", "versions": versions,
        "base_parameters_sha256": manifest["base_parameters_sha256"], "candidate_sha256": manifest["candidate_sha256"],
        "initialization": manifest["initialization"], "classifier_input_dim": manifest["classifier_input_dim"],
        "parameter_names": list(CLASSIFIER_NAMES), "privacy_config": manifest["privacy"],
        "dp_enabled": manifest["mode"] == "dp_secagg", "secagg_enabled": manifest["mode"] == "dp_secagg",
        "secure_rng": False, "real_patient_training_allowed": False, "encoder_dp_protected": False,
        "r03_equivalence_verified": False, "clinical_admission": False,
        "transport": "bounded_signed_json_base64_protobuf_pipes", "institution_weight": 1,
        "external_rollback_witnessed": False, "output_directory": str(directory)}
    if manifest["mode"] == "dp_secagg":
        receipt["secure_aggregation_config"] = {"implementation": "Flower.SecAggPlusWorkflow/secaggplus_mod",
            "participants": 3, "num_shares": 3, "reconstruction_threshold": 3,
            "clipping_range": 1., "quantization_range": 2**20, "modulus_range": 2**32,
            "fixed_institution_weight": 1, "single_quantization": True,
            "public_control_error_bound": 8 / (2**20)}

    def exchange(index, packet):
        child, node = children[index], nodes[index]
        request = canonical_json({"schema": "federated-request/v1", "request_id": str(uuid4()), **packet})
        digest = sha256_bytes(request)
        timer = threading.Timer(60, _kill_child_tree, args=(child,))
        timer.start()
        try:
            write_frame(child.stdin, request)
            while True:
                envelope = json.loads(read_frame(child.stdout))
                signed = verify_signed_envelope(envelope, node, manifest, sequence=sequences[index] + 1,
                    previous_sha256=chains[index], request_sha256=digest)
                payload = signed["payload"]
                _verify_actual_pid(child, payload)
                sequences[index] += 1
                chains[index] = sha256_bytes(canonical_json(signed))
                event_log.write(canonical_json(signed) + b"\n")
                event_log.flush()
                os.fsync(event_log.fileno())
                if "privacy" in payload:
                    validate_privacy_snapshot(payload["privacy"], node, manifest["privacy"]["delta"])
                latest[index] = payload
                if payload["kind"] == "gate_request":
                    accepted = authorize({**payload, "signature_hex": signed["signature_hex"]}) is True
                    gates.append({"node_id": node["node_id"], "seq": payload["seq"], "action": payload["action"], "authorized": accepted})
                    write_frame(child.stdin, canonical_json({"kind": "gate_response", "gate_sha256": chains[index], "authorized": accepted}))
                    if not accepted:
                        raise AuthorizationDenied("Authoritative source authorization changed")
                    continue
                if payload["kind"] == "failed":
                    raise RoundRejected("Independent node failed: " + str(payload.get("error_type", "unknown")))
                return envelope
        finally:
            timer.cancel()

    proxies = [SimpleNamespace(node_id=index, cid=str(index)) for index in (1, 2, 3)]
    class Strategy:
        aggregate = None
        def configure_fit(self, server_round, parameters, client_manager):
            return [(proxy, FitIns(parameters, {})) for proxy in proxies]
        def aggregate_fit(self, server_round, results, failures):
            if failures or len(results) != 3 or any(value.num_examples != 1 for _, value in results):
                raise RoundRejected("All three fixed-weight institutions must complete the round")
            for proxy, value in results:
                report = latest[proxy.node_id]
                if (value.metrics.get("node_pid") != report["pid"] or value.metrics.get("institution_weight") != 1
                        or value.metrics.get("logical_steps") != manifest["privacy"]["logical_steps"]):
                    raise RoundRejected("Protocol training result differs from its signed actual node receipt")
                if manifest["mode"] == "dp_secagg":
                    expected = [[manifest["privacy"]["noise_multiplier"], manifest["privacy"]["sample_rate"], manifest["privacy"]["logical_steps"]]]
                    history = json.loads(value.metrics.get("accountant_history", "[]"))
                    if history != expected or report.get("training", {}).get("accountant_history") != value.metrics["accountant_history"]:
                        raise RoundRejected("Actual Opacus history differs from the frozen logical steps")
            if len({latest[index]["pid"] for index in nodes}) != 3:
                raise RoundRejected("Three distinct actual process identities are required")
            if manifest["mode"] == "dp_secagg":
                mean = parameters_to_ndarrays(results[0][1].parameters)
                # Flower's official integer dequantizer returns float64. Validate
                # that decoded numeric aggregate before the frozen float32 cast.
                if (len(mean) != 4 or any(value.dtype not in (np.float32, np.float64)
                        or value.shape != prior.shape or not np.isfinite(value).all()
                        for value, prior in zip(mean, base))):
                    raise RoundRejected("Decoded secure aggregate violates the four-array numeric contract")
                mean = [value.astype(np.float32) for value in mean]
            else:
                per_node = [parameters_to_ndarrays(value.parameters) for _, value in results]
                for arrays in per_node:
                    validate_arrays(arrays, manifest["classifier_input_dim"])
                mean = [np.mean([arrays[position] for arrays in per_node], axis=0).astype(np.float32) for position in range(4)]
            validate_arrays(mean, manifest["classifier_input_dim"])
            self.aggregate = [(prior + delta).astype(np.float32) for prior, delta in zip(base, mean)]
            validate_arrays(self.aggregate, manifest["classifier_input_dim"])
            return ndarrays_to_parameters(self.aggregate), {}
    strategy = Strategy()

    class LocalGrid:
        def send_and_receive(self, messages, timeout=None):
            replies, phase = [], []
            for message in messages:
                index = message.metadata.dst_node_id
                proto = message_to_proto(message)
                proto.metadata.run_id, proto.metadata.src_node_id = 1, 0
                proto.metadata.message_id = uuid4().hex
                raw = proto.SerializeToString()
                envelope = exchange(index, {"kind": "protocol", "protobuf_b64": base64.b64encode(raw).decode("ascii")})
                if envelope["payload"]["kind"] != "protocol_reply":
                    raise RoundRejected("Unexpected node protocol reply kind")
                raw_reply = base64.b64decode(envelope["protobuf_b64"], validate=True)
                reply = message_from_proto(ProtoMessage.FromString(raw_reply))
                if (reply.metadata.src_node_id != index or reply.metadata.dst_node_id != 0 or reply.metadata.run_id != 1
                        or reply.metadata.reply_to_message_id != proto.metadata.message_id or reply.has_error()):
                    raise RoundRejected("Flower reply failed its request identity or protocol check")
                phase.append({"node_id": nodes[index]["node_id"], "request_bytes": len(raw), "reply_bytes": len(raw_reply)})
                replies.append(reply)
            phases.append(phase)
            return replies

    try:
        for index, node in nodes.items():
            log = (directory / ("node-" + str(index) + ".stderr.txt")).open("wb")
            logs.append(log)
            children[index] = subprocess.Popen([sys.executable, "-B", "-u", "-m", "federated_runtime.project_node",
                "--manifest", str(directory / "round-manifest.json"), "--index", str(index)], cwd=ROOT,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                env={**os.environ, "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "FLWR_TELEMETRY_ENABLED": "0"})
        for index in nodes:
            envelope = exchange(index, {"kind": "start"})
            if envelope["payload"]["kind"] != "hello":
                raise RoundRejected("Node did not complete its signed handshake")
            handshakes[index] = envelope["payload"]
        if manifest["mode"] == "dp_secagg":
            projected_histories = []
            plan = [[manifest["privacy"]["noise_multiplier"], manifest["privacy"]["sample_rate"], manifest["privacy"]["logical_steps"]]]
            for item in handshakes.values():
                expected = merged_history([item["privacy"]["reserved_history"], plan])
                if item["projected_reserved_history"] != expected:
                    raise RoundRejected("Signed preflight projection does not preserve all prior reservations")
                projected_histories.append(expected)
            projected = merged_history(projected_histories)
            if epsilon_for_history(projected, manifest["privacy"]["delta"]) > manifest["privacy"]["max_epsilon"]:
                raise RoundRejected("Conservative three-hospital sequential budget would be exceeded")
            context = LegacyContext(Context(run_id=1, node_id=0, node_config={}, state=RecordDict(), run_config={}), strategy=strategy)
            for proxy in proxies:
                context.client_manager.register(proxy)
            context.state.config_records[MAIN_CONFIGS_RECORD] = ConfigRecord({Key.CURRENT_ROUND: manifest["round"], Key.START_TIME: time.time()})
            context.state.array_records[MAIN_PARAMS_RECORD] = parameters_to_arrayrecord(ndarrays_to_parameters(base), True)
            workflow = SecAggPlusWorkflow(num_shares=1.0, reconstruction_threshold=1.0, max_weight=1.,
                clipping_range=1., quantization_range=2**20, modulus_range=2**32, timeout=60.)
            workflow(LocalGrid(), context)
            if len(phases) != 4 or any(len(phase) != 3 for phase in phases):
                raise RoundRejected("Full three-node official SecAgg+ workflow did not finish")
        else:
            messages = [Message(fitins_to_recorddict(FitIns(ndarrays_to_parameters(base), {}), True),
                                dst_node_id=index, message_type=MessageType.TRAIN) for index in nodes]
            replies = LocalGrid().send_and_receive(messages)
            strategy.aggregate_fit(manifest["round"], [(proxies[reply.metadata.src_node_id - 1], recorddict_to_fitres(reply.content, True)) for reply in replies], [])
        if strategy.aggregate is None:
            raise RoundRejected("No complete aggregate was produced")
        for index in nodes:
            envelope = exchange(index, {"kind": "finalize"})
            if envelope["payload"]["kind"] != "final_ready":
                raise RoundRejected("Final node authorization was not confirmed")
        if manifest["mode"] == "dp_secagg":
            history = merged_history(latest[index]["privacy"]["reserved_history"] for index in nodes)
            epsilon = epsilon_for_history(history, manifest["privacy"]["delta"])
            if epsilon > manifest["privacy"]["max_epsilon"]:
                raise RoundRejected("Final conservative sequential budget exceeds the frozen cap")
            receipt.update(conservative_sequential_epsilon=epsilon, conservative_sequential_history=history,
                           overall_delta=manifest["privacy"]["delta"])
        aggregate_file = directory / "aggregate-classifier.npz"
        np.savez(aggregate_file, **dict(zip(CLASSIFIER_NAMES, strategy.aggregate)))
        receipt.update(status="completed", applied=True, aggregate_path=str(aggregate_file),
                       aggregate_sha256=sha256_bytes(aggregate_file.read_bytes()),
                       aggregate_parameters_sha256=arrays_digest(strategy.aggregate))
    except Exception as error:
        receipt.update(status="aborted" if isinstance(error, (RoundRejected, EOFError, BrokenPipeError)) else "failed",
                       error_type=type(error).__name__, error_code="authorization_denied" if isinstance(error, AuthorizationDenied) else "round_incomplete")
        if isinstance(error, RoundRejected):
            receipt["error_detail"] = str(error)
    finally:
        for child in children.values():
            if child.stdin:
                try:
                    child.stdin.close()
                except BrokenPipeError:
                    pass
            # A denied gate may make the node send a large signed failure receipt.
            # Close our read end before waiting, so that write cannot deadlock exit.
            if child.stdout:
                child.stdout.close()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                _kill_child_tree(child)
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    receipt["node_cleanup_incomplete"] = True
        for log in logs:
            log.close()
        event_log.close()
    receipt.update(node_pids={nodes[index]["node_id"]: payload["pid"] for index, payload in latest.items()},
                   launcher_pids={nodes[index]["node_id"]: child.pid for index, child in children.items()},
                   node_receipts=[{"node_id": nodes[index]["node_id"], "institution_id": nodes[index]["institution_id"],
                       "pid": payload["pid"], "privacy": payload.get("privacy"), "training": payload.get("training", {}),
                       "last_reply_seq": payload["seq"], "signed_reply_head_sha256": chains[index]}
                       for index, payload in latest.items()],
                   protocol_phases=phases, authorization_gates=gates,
                   signed_events_path=str(directory / "signed-node-events.jsonl"),
                   elapsed_seconds=round(time.monotonic() - started, 3), receipt_path=str(directory / "receipt.json"))
    (directory / "receipt.json").write_bytes(canonical_json(receipt))
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--synthetic-only", action="store_true")
    modes.add_argument("--gate-stdio", action="store_true", help="Framed fresh authorization RPC to the business worker")
    parser.add_argument("--deny-node", help="Synthetic negative check: reject this registered node")
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    if args.gate_stdio:
        if args.deny_node:
            parser.error("--deny-node is an explicit synthetic engineering check only")
        incoming, outgoing = sys.stdin.buffer, sys.stdout.buffer
        def authorize(event):
            write_frame(outgoing, canonical_json({"type": "authorization_gate", "event": event}))
            received = queue.Queue(maxsize=1)
            def receive():
                try:
                    received.put((True, read_frame(incoming)))
                except Exception as error:
                    received.put((False, error))
            threading.Thread(target=receive, daemon=True).start()
            try:
                success, raw = received.get(timeout=60)
                if not success:
                    return False
                ack = json.loads(raw)
                if (not isinstance(ack, dict) or type(ack.get("authorized")) is not bool
                        or any(ack.get(name) != event[name] for name in ("experiment_id", "round", "attempt", "node_id", "seq"))):
                    return False
                return ack["authorized"]
            except (queue.Empty, ValueError, KeyError):
                return False
        with contextlib.redirect_stdout(sys.stderr):
            result = run_round(manifest, authorize)
        write_frame(outgoing, canonical_json({"type": "round_result", "receipt": result}))
    else:
        result = run_round(manifest, lambda event: event["node_id"] != args.deny_node)
        print(json.dumps(result, indent=2))
    return 0 if result["status"] == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
