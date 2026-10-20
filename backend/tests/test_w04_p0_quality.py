"""Independent quality probes for the legacy cognitive P0 HTTP boundary only."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import threading
import uuid

import pytest

from backend.tests.w02_helpers import register


ROOT = Path(__file__).resolve().parents[2]
SOURCES = (
    "backend/app/main.py",
    "backend/app/api/routes/patient.py",
    "backend/app/services/cognitive_contract.py",
    "backend/app/services/identity_access.py",
    "backend/app/schemas/cognitive.py",
    "backend/app/schemas/scale.py",
    "backend/app/models/cognitive_test.py",
    "backend/app/core/record_fields.py",
)


def _hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture(scope="module", autouse=True)
def quality_source_window():
    started = datetime.now(timezone.utc).isoformat()
    before = {path: _hash(ROOT / path) for path in SOURCES}
    receipt = os.environ.get("W04_P0_QUALITY_RECEIPT", "w04-p0-quality-window-" + uuid.uuid4().hex + ".json")
    assert receipt.startswith("w04-p0-quality-") and Path(receipt).name == receipt
    yield
    after = {path: _hash(ROOT / path) for path in SOURCES}
    preserved = json.loads((ROOT / "docs/evidence/w03-change-summary.json").read_text(encoding="utf-8"))["preserved"]
    result = {
        "scope": "legacy cognitive HTTP P0 quality only; no full W04/W05 acceptance",
        "started_at": started,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "sources_before": before,
        "sources_after": after,
        "sources_changed_during_test": [path for path in SOURCES if before[path] != after[path]],
        "protected": [{"path": row["path"], "unchanged": _hash(ROOT / row["path"]) == row["sha256"]} for row in preserved],
        "test_sha256": _hash(Path(__file__)),
        "receipt_filename": receipt,
    }
    (ROOT / "docs/evidence" / receipt).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")


def owner(client, suffix="owner"):
    data, headers = register(client, "w04-quality-" + suffix + "@example.com")
    return data["user"]["patient_profile"]["id"], headers


def evidence(run="quality-run"):
    return {
        "test_run_id": run,
        "source": "miniprogram",
        "protocol_id": "continuous-mobile-v4",
        "protocol_schema_version": 6,
        "age_group": "adult",
        "finished_at": "2026-10-15T01:20:00Z",
        "raw_result": {"average_reaction_time_ms": 450, "accuracy": 92, "false_starts": 0},
        "trials": [{"trial": 1, "responseTimeMs": 450}],
        "execution_metadata": {"input": "touch", "counter": 1},
    }


def submit(client, headers, patient_id, payload, test_type="reaction"):
    return client.post("/api/v1/patient/submit_cognitive_test", headers=headers,
                       json={"patient_id": patient_id, "test_type": test_type, "result_json": payload})


def count_results():
    from sqlalchemy import func, select
    from backend.app.db.session import SessionLocal
    from backend.app.models.cognitive_test import CognitiveTest
    with SessionLocal() as db:
        return db.scalar(select(func.count()).select_from(CognitiveTest))


def test_equivalent_aliases_racing_on_real_unique_constraint_return_same_original(client, monkeypatch):
    from sqlalchemy.orm import Session
    from backend.app.models.cognitive_test import CognitiveTest
    pid, headers = owner(client)
    barrier = threading.Barrier(2, timeout=20)
    seen = threading.local()
    scalar = Session.scalar

    def synchronized_lookup(db, statement, *args, **kwargs):
        result = scalar(db, statement, *args, **kwargs)
        descriptions = getattr(statement, "column_descriptions", [])
        if descriptions and descriptions[0].get("entity") is CognitiveTest and not getattr(seen, "initial", False):
            seen.initial = True
            assert result is None
            barrier.wait()
        return result

    monkeypatch.setattr(Session, "scalar", synchronized_lookup)
    original = evidence()
    alias = deepcopy(original)
    alias["raw_result"] = {"avg_reaction_ms": 450.0, "correct_rate": 0.92, "false_starts": -0.0}
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(submit, client, headers, pid, value, kind)
                for value, kind in ((original, "reaction"), (alias, "go_no_go"))]
        responses = [job.result(timeout=45) for job in jobs]
    monkeypatch.setattr(Session, "scalar", scalar)
    assert [r.status_code for r in responses] == [201, 201], [r.text for r in responses]
    assert len({r.json()["id"] for r in responses}) == 1
    assert count_results() == 1
    for response in responses:
        assert response.json()["result_json"]["raw_result"]["average_reaction_time_ms"] == 450
        assert response.json()["result_json"]["raw_result"]["accuracy"] == 92
        assert response.json()["legacy"] is True


def test_large_json_integer_is_validated_or_preserved_without_server_exception(client, monkeypatch):
    pid, headers = owner(client)
    monkeypatch.setattr(client._transport, "raise_server_exceptions", False)
    accepted = 0
    for index, key in enumerate(("average_reaction_time_ms", "unknown_actual_count")):
        payload = evidence("large-int-" + str(index))
        payload["raw_result"][key] = 10 ** 400
        payload["sensitive_marker"] = "SYNTHETIC-HEALTH-NOT-FOR-ERROR-ECHO"
        response = submit(client, headers, pid, payload)
        assert response.status_code in {201, 422}, (key, response.status_code, response.text)
        if response.status_code == 422:
            assert "SYNTHETIC-HEALTH-NOT-FOR-ERROR-ECHO" not in response.text
        else:
            accepted += 1
            assert response.json()["result_json"]["raw_result"][key] == 10 ** 400
            retry = submit(client, headers, pid, payload)
            assert retry.status_code == 201, retry.text
            assert retry.json()["id"] == response.json()["id"]
            changed = deepcopy(payload)
            changed["raw_result"][key] += 1
            conflict = submit(client, headers, pid, changed)
            assert conflict.status_code == 409, conflict.text
        assert "Traceback" not in response.text
    assert count_results() == accepted


def test_trail_error_aliases_cannot_disagree(client):
    pid, headers = owner(client)
    payload = evidence()
    payload["raw_result"] = {"elapsed_ms": 10000, "accuracy": 92, "errors": 1, "wrong": 2}
    response = submit(client, headers, pid, payload, "trail")
    assert response.status_code == 422, response.text
    assert count_results() == 0


def test_trail_wrong_and_errors_are_equivalent_legacy_aliases(client):
    pid, headers = owner(client)
    original = evidence()
    original["raw_result"] = {"duration_s": 10, "wrong": 1, "accuracy": 92}
    first = submit(client, headers, pid, original, "trail")
    canonical = evidence()
    canonical["raw_result"] = {"elapsed_ms": 10000, "errors": 1, "accuracy": 92}
    retry = submit(client, headers, pid, canonical, "trail")
    assert first.status_code == retry.status_code == 201, (first.text, retry.text)
    assert first.json()["id"] == retry.json()["id"]
    assert count_results() == 1


def test_decimal_seconds_and_milliseconds_are_equivalent(client):
    pid, headers = owner(client)
    original = evidence()
    original["raw_result"] = {"duration_s": 0.1234, "errors": 0, "accuracy": 92}
    first = submit(client, headers, pid, original, "trail")
    canonical = evidence()
    canonical["raw_result"] = {"elapsed_ms": 123.4, "errors": 0, "accuracy": 92}
    retry = submit(client, headers, pid, canonical, "trail")
    assert first.status_code == retry.status_code == 201, (first.text, retry.text)
    assert first.json()["id"] == retry.json()["id"]


def test_accuracy_fraction_precision_is_not_discarded_for_idempotency(client):
    pid, headers = owner(client)
    original = evidence()
    original["raw_result"]["accuracy"] = 0.921234
    first = submit(client, headers, pid, original)
    assert first.status_code == 201, first.text
    changed = deepcopy(original)
    changed["raw_result"]["accuracy"] = 0.921235
    conflict = submit(client, headers, pid, changed)
    assert conflict.status_code == 409, (first.text, conflict.text)
    assert count_results() == 1


def test_validation_messages_never_echo_actual_health_evidence(client, monkeypatch):
    pid, headers = owner(client)
    monkeypatch.setattr(client._transport, "raise_server_exceptions", False)
    marker = "SYNTHETIC-HEALTH-NOT-FOR-ERROR-ECHO"
    for index, invalid in enumerate((True, "91", [], {}, float("inf"))):
        payload = evidence("validation-msg-" + str(index))
        payload["raw_result"]["accuracy"] = invalid
        payload["sensitive_marker"] = marker
        if isinstance(invalid, float):
            body = json.dumps({"patient_id": pid, "test_type": "reaction", "result_json": payload}).replace("Infinity", "1e309")
            response = client.post("/api/v1/patient/submit_cognitive_test", headers={**headers, "Content-Type": "application/json"}, content=body)
        else:
            response = submit(client, headers, pid, payload)
        assert response.status_code == 422, response.text
        assert marker not in response.text
        assert response.json()["detail"]
        assert all(set(error) <= {"loc", "msg", "type"} for error in response.json()["detail"])
    assert count_results() == 0


def test_strict_fixed_target_rejects_invalid_and_different_profiles_without_mutation(client):
    pid, headers = owner(client)
    other, _ = owner(client, "other")
    payload = evidence()
    first = submit(client, headers, pid, payload)
    assert first.status_code == 201, first.text
    for invalid in (True, float(pid), str(pid), 0, -1):
        response = submit(client, headers, invalid, payload)
        assert response.status_code == 422, (repr(invalid), response.text)
    mismatched = submit(client, headers, other, payload)
    assert mismatched.status_code == 409, mismatched.text
    assert "result_json" not in mismatched.text
    original = submit(client, headers, pid, payload)
    assert original.status_code == 201, original.text
    assert original.json()["id"] == first.json()["id"]
    assert count_results() == 1


def test_unknown_actual_nested_types_and_array_order_are_not_erased(client):
    pid, headers = owner(client)
    payload = evidence()
    payload["execution_metadata"]["calibration"] = {"flag": True, "values": [1, 2]}
    first = submit(client, headers, pid, payload)
    assert first.status_code == 201, first.text
    for variation in ({"flag": 1, "values": [1, 2]}, {"flag": True, "values": [2, 1]}):
        changed = deepcopy(payload)
        changed["execution_metadata"]["calibration"] = variation
        response = submit(client, headers, pid, changed)
        assert response.status_code == 409, response.text
        assert "calibration" not in response.text
    assert count_results() == 1


def test_exact_retry_rechecks_current_authority_without_disclosing_original(client):
    pid, headers = owner(client)
    payload = evidence()
    payload["private_note"] = "SYNTHETIC-PRIVATE-RETRY-EVIDENCE"
    first = submit(client, headers, pid, payload)
    assert first.status_code == 201, first.text
    unauthenticated = submit(client, {}, pid, payload)
    assert unauthenticated.status_code == 401, unauthenticated.text
    other, other_headers = owner(client, "unauthorized")
    unrelated = submit(client, other_headers, pid, payload)
    assert unrelated.status_code == 409, unrelated.text
    assert other != pid
    consent = next(row for row in client.get("/api/v1/patient/consents", headers=headers).json()["items"]
                   if row["purpose"] == "basic_use" and row["effective_access"])
    withdrawn = client.post(f"/api/v1/patient/consents/{consent['id']}/withdraw", headers=headers,
                            json={"expected_revision": consent["revision"]})
    assert withdrawn.status_code == 200, withdrawn.text
    revoked = submit(client, headers, pid, payload)
    assert revoked.status_code == 403, revoked.text
    for response in (unauthenticated, unrelated, revoked):
        assert "SYNTHETIC-PRIVATE-RETRY-EVIDENCE" not in response.text
        assert "result_json" not in response.text
    assert count_results() == 1
