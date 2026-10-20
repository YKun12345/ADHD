"""Explicit engineering smoke: framed worker RPC, synthetic nodes, no business DB."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from uuid import uuid4

from federated_runtime.framing import read_frame, write_frame
from federated_runtime.hgst_features import canonical_json
from federated_runtime.project_round import DEFAULT_PRIVACY


ROOT = Path(__file__).resolve().parents[2]


def rpc_round(manifest, manifest_file, denied_action=None, denied_node=None):
    manifest_file.write_bytes(canonical_json(manifest))
    stderr = manifest_file.with_suffix(".stderr.txt").open("wb")
    child = subprocess.Popen([sys.executable, "-B", "-u", "-m", "federated_runtime.project_round",
        "--manifest", str(manifest_file), "--gate-stdio"], cwd=ROOT,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    timer = threading.Timer(240, child.kill)
    timer.start()
    try:
        while True:
            packet = json.loads(read_frame(child.stdout))
            if packet["type"] == "round_result":
                result = packet["receipt"]
                break
            assert packet["type"] == "authorization_gate"
            event = packet["event"]
            accepted = not ((denied_node is None or event["node_id"] == denied_node) and event["action"] == denied_action)
            write_frame(child.stdin, canonical_json({"authorized": accepted,
                **{name: event[name] for name in ("experiment_id", "round", "attempt", "node_id", "seq")}}))
        child.stdin.close()
        child.wait(timeout=15)
        assert child.returncode == (0 if result["status"] == "completed" else 2)
        return result
    finally:
        timer.cancel()
        if child.poll() is None:
            child.kill()
            child.wait(timeout=15)
        stderr.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-directory", required=True)
    parser.add_argument("--existing-node-a", required=True)
    parser.add_argument("--success-receipt", help="Reuse an already completed actual run while checking abort cleanup")
    args = parser.parse_args()
    directory = Path(args.fixture_directory).resolve()
    node_a = Path(args.existing_node_a).resolve()
    nodes = []
    for index, node_dir in enumerate((node_a, directory / "node-b", directory / "node-c"), 1):
        # The coordinator reads public enrollment only, never a node-local manifest.
        public = json.loads((node_dir / "public-enrollment.json").read_bytes())
        nodes.append({"node_id": public["node_id"], "institution_id": index, "index": index,
                      "directory": str(node_dir), "public_key_pem": public["public_key_pem"]})
    public = json.loads((node_a / "public-enrollment.json").read_bytes())
    template = {"schema": "federated-round/v1", "synthetic_only": True, "mode": "dp_secagg",
        "round": 1, "candidate_path": str(node_a / "synthetic-candidate.pt"),
        "candidate_sha256": public["candidate_sha256"], "base_parameters_path": None,
        "privacy": DEFAULT_PRIVACY, "nodes": nodes,
        "legacy_python": str(ROOT / ".codex-tmp/python310-compat-f00/python.exe"),
        "legacy_site_packages": str(ROOT / ".venv-hgst/Lib/site-packages")}
    results = {}
    for label, action, node in (("success", None, None), ("denied-node", "node_start", nodes[1]["node_id"]),
                                 ("revoked-gate", "protocol_compute", nodes[0]["node_id"])):
        manifest = {**template, "experiment_id": "synthetic-runtime-" + label,
                    "attempt": str(uuid4()), "output_directory": str(directory / (label + "-" + uuid4().hex[:8]))}
        result = (json.loads(Path(args.success_receipt).read_bytes()) if label == "success" and args.success_receipt
                  else rpc_round(manifest, directory / (label + "-manifest.json"), action, node))
        if label == "success":
            assert result["status"] == "completed", {"status": result["status"], "receipt_path": result["receipt_path"]}
            assert len(set(result["node_pids"].values())) == 3
            assert len(result["protocol_phases"]) == 4
            assert result["classifier_input_dim"] == 720
            assert result["conservative_sequential_history"][-1][2] >= 6
        else:
            assert result["status"] == "aborted" and result["applied"] is False
            assert result["error_code"] == "authorization_denied"
            assert not (Path(result["output_directory"]) / "aggregate-classifier.npz").exists()
        results[label] = {name: result.get(name) for name in ("status", "applied", "node_pids", "receipt_path",
            "aggregate_path", "conservative_sequential_epsilon", "error_code")}
        print(json.dumps({"case": label, **results[label]}), flush=True)
    (directory / "runtime-verification.json").write_bytes(canonical_json(results))


if __name__ == "__main__":
    main()
