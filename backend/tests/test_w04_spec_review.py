"""Independent W04 P0 HTTP review; no implementation digest is used as oracle."""
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
P0_SOURCES = (
    "backend/app/main.py",
    "backend/app/api/routes/patient.py",
    "backend/app/services/cognitive_contract.py",
    "backend/app/services/identity_access.py",
    "backend/app/schemas/cognitive.py",
    "backend/app/schemas/scale.py",
    "backend/app/models/cognitive_test.py",
    "backend/app/core/record_fields.py",
)


def source_hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            for name in P0_SOURCES if (ROOT / name).is_file()}


@pytest.fixture(scope="module", autouse=True)
def review_source_window():
    before = source_hashes()
    started = datetime.now(timezone.utc).isoformat()
    # Implementers can run this independent suite concurrently. Give each
    # invocation its own source receipt instead of racing over one filename.
    receipt_name = os.environ.get("W04_SPEC_SOURCE_RECEIPT", "w04-spec-source-window-" + uuid.uuid4().hex + ".json")
    assert receipt_name.startswith("w04-spec-") and Path(receipt_name).name == receipt_name
    yield
    after = source_hashes()
    protected = json.loads((ROOT / "docs/evidence/w03-change-checkpoint.json").read_text(encoding="utf-8"))["preserved"]
    result = {
        "scope": "Independent legacy HTTP P0 only; not full W04/W05 acceptance",
        "started_at": started,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "sources_before": before,
        "sources_after": after,
        "sources_changed_during_test": [name for name in before if before[name] != after.get(name)],
        "protected": [{"path": row["path"], "unchanged": hashlib.sha256((ROOT / row["path"]).read_bytes()).hexdigest() == row["sha256"]} for row in protected],
        "test_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "receipt_filename": receipt_name,
    }
    (ROOT / "docs/evidence" / receipt_name).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


def owner(client, suffix="owner"):
    data, headers = register(client, f"w04-spec-{suffix}@example.com")
    return data["user"]["patient_profile"]["id"], headers


def evidence(run="spec-run"):
    return {
        "test_run_id": run,
        "source": "miniprogram",
        "protocol_id": "continuous-mobile-v4",
        "protocol_schema_version": 6,
        "age_group": "adult",
        "finished_at": "2026-10-15T04:01:00Z",
        "raw_result": {"average_reaction_time_ms": 450, "accuracy": 92, "false_starts": 0},
        "trials": [{"trial": 1, "responseTimeMs": 450}, {"trial": 2, "responseTimeMs": 451}],
        "execution_metadata": {"input": "touch", "exposure_count": 1},
    }


def submit(client, headers, pid, result, test_type="reaction"):
    return client.post("/api/v1/patient/submit_cognitive_test", headers=headers,
                       json={"patient_id": pid, "test_type": test_type, "result_json": result})


def test_raw_alias_only_and_canonical_payload_are_same_legacy_evidence(client):
    pid, headers = owner(client)
    alias = evidence()
    alias["raw_result"] = {"avg_reaction_ms": 450.0, "correct_rate": 0.92, "false_starts": 0}
    first = submit(client, headers, pid, alias, "go_no_go")
    retry = submit(client, headers, pid, evidence(), "reaction")
    assert first.status_code == 201, first.text
    assert retry.status_code == 201, retry.text
    assert first.json()["id"] == retry.json()["id"]
    assert first.json()["result_json"]["raw_result"]["average_reaction_time_ms"] == 450
    assert first.json()["result_json"]["raw_result"]["accuracy"] == 92


def test_cross_level_metric_contradiction_is_not_silently_erased(client):
    pid, headers = owner(client)
    payload = evidence()
    payload["average_reaction_time_ms"] = 999
    payload["accuracy"] = 25
    response = submit(client, headers, pid, payload)
    assert response.status_code == 422, response.text


def test_retry_cannot_hide_changed_top_level_metric_behind_unchanged_raw(client):
    pid, headers = owner(client)
    payload = evidence()
    payload.update(average_reaction_time_ms=450, accuracy=92)
    first = submit(client, headers, pid, payload)
    assert first.status_code == 201, first.text
    changed = deepcopy(payload)
    changed["accuracy"] = 25
    response = submit(client, headers, pid, changed)
    assert response.status_code in {409, 422}, response.text


def test_boolean_is_not_a_numeric_accuracy(client):
    pid, headers = owner(client)
    payload = evidence()
    payload["raw_result"]["accuracy"] = True
    response = submit(client, headers, pid, payload)
    assert response.status_code == 422, response.text


def test_numeric_overflow_json_is_validation_error_not_server_exception(client, monkeypatch):
    pid, headers = owner(client)
    payload = evidence()
    payload["raw_result"]["average_reaction_time_ms"] = "SPEC_OVERFLOW"
    # 1e309 is syntactically valid JSON, unlike bare NaN/Infinity tokens.
    body = json.dumps({"patient_id": pid, "test_type": "reaction", "result_json": payload}).replace('"SPEC_OVERFLOW"', '1e309')
    monkeypatch.setattr(client._transport, "raise_server_exceptions", False)
    response = client.post("/api/v1/patient/submit_cognitive_test", headers={**headers, "Content-Type": "application/json"}, content=body)
    assert response.status_code == 422, response.text


def test_new_numeric_representation_version_is_strict_and_invalid_values_are_422(client, monkeypatch):
    pid, headers = owner(client)
    monkeypatch.setattr(client._transport, "raise_server_exceptions", False)
    for index, value in enumerate(([], {}, True, 1.0, 2)):
        payload = evidence("invalid-representation-" + str(index))
        payload["normalization_version"] = value
        response = submit(client, headers, pid, payload)
        assert response.status_code == 422, (repr(value), response.text)


def test_equal_finite_numeric_representations_and_type_alias_share_result(client):
    pid, headers = owner(client)
    first_payload = evidence()
    first_payload["raw_result"]["false_starts"] = -0.0
    first = submit(client, headers, pid, first_payload, "gonogo")
    second_payload = evidence()
    second_payload["raw_result"]["average_reaction_time_ms"] = 450.0
    second_payload["execution_metadata"]["exposure_count"] = 1.0
    retry = submit(client, headers, pid, second_payload, "reaction")
    assert first.status_code == retry.status_code == 201, (first.text, retry.text)
    assert first.json()["id"] == retry.json()["id"]


def test_fractional_accuracy_is_converted_once_and_exact_retry_is_stable(client):
    pid, headers = owner(client)
    payload = evidence()
    payload["raw_result"]["accuracy"] = 0.005
    first = submit(client, headers, pid, payload)
    assert first.status_code == 201, first.text
    assert first.json()["result_json"]["raw_result"]["accuracy"] == 0.5
    retry = submit(client, headers, pid, payload)
    assert retry.status_code == 201, retry.text
    assert retry.json()["id"] == first.json()["id"]
    assert retry.json()["result_json"]["raw_result"]["accuracy"] == 0.5
    canonical_retry = submit(client, headers, pid, first.json()["result_json"])
    assert canonical_retry.status_code == 201, canonical_retry.text
    assert canonical_retry.json()["id"] == first.json()["id"]
    changed = deepcopy(payload)
    changed["raw_result"]["accuracy"] = 0.5
    conflict = submit(client, headers, pid, changed)
    assert conflict.status_code == 409, conflict.text


def test_trial_order_time_unknown_actual_metadata_and_protocol_are_immutable(client):
    pid, headers = owner(client)
    baseline = evidence()
    first = submit(client, headers, pid, baseline)
    assert first.status_code == 201, first.text
    alternatives = []
    changed = deepcopy(baseline)
    changed["trials"].reverse()
    alternatives.append(changed)
    changed = deepcopy(baseline)
    changed["trials"][0]["responseTimeMs"] += 1
    alternatives.append(changed)
    changed = deepcopy(baseline)
    changed["execution_metadata"]["exposure_count"] = 2
    alternatives.append(changed)
    changed = deepcopy(baseline)
    changed["protocol_schema_version"] = 5
    alternatives.append(changed)
    changed = deepcopy(baseline)
    changed["finished_at"] = "2026-10-15T04:02:00Z"
    alternatives.append(changed)
    for changed in alternatives:
        response = submit(client, headers, pid, changed, "go_no_go")
        assert response.status_code == 409, response.text
    retry = submit(client, headers, pid, baseline)
    assert retry.status_code == 201 and retry.json()["id"] == first.json()["id"]


def test_real_unique_key_race_compares_the_losing_actual_payload(client, monkeypatch):
    from sqlalchemy import func, select
    from sqlalchemy.orm import Session
    from backend.app.db.session import SessionLocal
    from backend.app.models.cognitive_test import CognitiveTest
    pid, headers = owner(client)
    barrier = threading.Barrier(2, timeout=20)
    seen = threading.local()
    original = Session.scalar

    def synchronized_initial_lookup(db, statement, *args, **kwargs):
        result = original(db, statement, *args, **kwargs)
        descriptions = getattr(statement, "column_descriptions", [])
        if descriptions and descriptions[0].get("entity") is CognitiveTest and not getattr(seen, "initial_lookup", False):
            seen.initial_lookup = True
            assert result is None
            barrier.wait()
        return result

    monkeypatch.setattr(Session, "scalar", synchronized_initial_lookup)
    first = evidence("concurrent-actual-conflict")
    second = deepcopy(first)
    second["raw_result"]["average_reaction_time_ms"] = 451
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(submit, client, headers, pid, payload) for payload in (first, second)]
        responses = [future.result(timeout=40) for future in futures]
    assert sorted(response.status_code for response in responses) == [201, 409], [response.text for response in responses]
    monkeypatch.setattr(Session, "scalar", original)
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(CognitiveTest)) == 1
        stored = db.scalar(select(CognitiveTest))
        winner = next(response for response in responses if response.status_code == 201)
        assert stored.id == winner.json()["id"]
        assert stored.result_json["raw_result"]["average_reaction_time_ms"] == winner.json()["result_json"]["raw_result"]["average_reaction_time_ms"]


def test_no_run_legacy_is_independent_and_does_not_claim_formal_context(client):
    pid, headers = owner(client)
    payload = evidence()
    payload.pop("test_run_id")
    first = submit(client, headers, pid, payload)
    second = submit(client, headers, pid, payload)
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] != second.json()["id"]
    for response in (first, second):
        assert response.json()["legacy"] is True
        assert all(response.json()[key] is None for key in ("assessment_id", "assessment_item_id", "task_attempt_id"))


def test_server_reserved_run_is_never_accepted_by_legacy_route_after_regrant(client):
    from backend.tests.test_assessment_sessions import created, start
    pid, headers = owner(client)
    session = created(client, headers, pid)
    item = session["items"][1]
    attempt = start(client, headers, item, pid)
    assert attempt.status_code == 201, attempt.text
    basic = next(row for row in client.get("/api/v1/patient/consents", headers=headers).json()["items"] if row["purpose"] == "basic_use" and row["effective_access"])
    withdrawn = client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=headers, json={"expected_revision": basic["revision"]})
    assert withdrawn.status_code == 200, withdrawn.text
    payload = evidence(attempt.json()["run_id"])
    assert submit(client, headers, pid, payload).status_code == 403
    regrant = client.post("/api/v1/patient/consents", headers=headers, json={"patient_id": pid, "purpose": "basic_use", "scope": ["profile", "assessment", "tracking", "care", "imaging"], "terms_version": "W02-1"})
    assert regrant.status_code == 201, regrant.text
    assert submit(client, headers, pid, payload).status_code == 409


def test_legacy_target_and_current_basic_scope_are_checked_even_for_exact_retry(client):
    pid, headers = owner(client)
    other, _ = owner(client, "other")
    payload = evidence()
    first = submit(client, headers, pid, payload)
    assert first.status_code == 201, first.text
    assert submit(client, headers, other, payload).status_code in {403, 409}
    basic = next(row for row in client.get("/api/v1/patient/consents", headers=headers).json()["items"] if row["purpose"] == "basic_use" and row["effective_access"])
    response = client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=headers, json={"expected_revision": basic["revision"]})
    assert response.status_code == 200, response.text
    assert submit(client, headers, pid, payload).status_code == 403
    tracking_only = client.post("/api/v1/patient/consents", headers=headers, json={"patient_id": pid, "purpose": "basic_use", "scope": ["tracking"], "terms_version": "W02-1"})
    assert tracking_only.status_code == 201, tracking_only.text
    assert submit(client, headers, pid, payload).status_code == 403


def test_guardian_conversion_does_not_move_old_payload_to_other_profile(client):
    from backend.tests.test_authorization_edges import verified_guardian, account_only
    child, guardian, reviewer, row = verified_guardian(client, suffix="w04-spec-conversion")
    pid = row["patient_id"]
    payload = evidence()
    payload["age_group"] = "child"
    first = submit(client, guardian, pid, payload)
    assert first.status_code == 201, first.text
    adult, adult_headers = account_only(client, "w04-spec-independent-adult@example.com")
    confirmation = client.post(f"/api/v1/identity/guardians/{row['id']}/confirm-adult-conversion", headers=adult_headers, json={"expected_revision": 2, "proof_reference": "w04-spec-adult-proof", "age": 19, "terms_version": "W02-1"})
    assert confirmation.status_code == 200, confirmation.text
    converted = client.post(f"/api/v1/identity/guardians/{row['id']}/adult-conversion", headers=reviewer, json={"expected_revision": 2, "adult_user_id": adult["user"]["id"], "adult_confirmed": True, "age": 19, "review_reference": "w04-spec-institution-review"})
    assert converted.status_code == 200, converted.text
    assert submit(client, guardian, pid, payload).status_code == 403
    own_history = client.get("/api/v1/patient/comprehensive_report", headers=adult_headers)
    assert own_history.status_code == 200, own_history.text
    assert own_history.json()["cognitive_profile"]["latest_tests"][0]["legacy"] is True
