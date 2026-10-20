"""Independent malformed-evidence boundary checks using isolated real HTTP/DB."""
from copy import deepcopy

import pytest


@pytest.mark.parametrize("case,task", [
    ("finished_at_non_string", "reaction"),
    ("stimulus_non_scalar", "reaction"),
    ("stage_entry_non_object", "trail"),
    ("numeric_digest_out_of_bounds", "reaction"),
])
def test_malformed_nested_evidence_is_422_and_original_attempt_remains_retryable(
    client, monkeypatch, case, task
):
    from backend.tests.test_submission_cognitive_evidence import cognitive_submission
    from backend.app.db.session import SessionLocal
    from backend.app.models.assessment import TaskAttempt
    from backend.app.models.cognitive_test import CognitiveTest
    from backend.app.models.submission import SubmissionRecord
    from sqlalchemy import func, select

    owner, _, _, attempt, original = cognitive_submission(client, task)
    malformed = deepcopy(original)
    result = malformed["content"]["result_json"]
    if case == "finished_at_non_string":
        result["finished_at"] = 123
    elif case == "stimulus_non_scalar":
        result["trials"][0]["type"] = []
    elif case == "stage_entry_non_object":
        result["raw_result"]["stages"] = [123]
    else:
        result["raw_result"]["accuracy"] = 10 ** 310

    # Observe the real HTTP failure response rather than allowing TestClient
    # to re-raise the application's unhandled validation exception.
    monkeypatch.setattr(client._transport, "raise_server_exceptions", False)
    rejected = client.post("/api/v1/care/submissions", headers=owner, json=malformed)
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(SubmissionRecord)) == 0
        assert db.scalar(select(func.count()).select_from(CognitiveTest)) == 0
        assert db.get(TaskAttempt, attempt["id"]).execution_status == "in_progress"

    retried = client.post("/api/v1/care/submissions", headers=owner, json=original)
    assert retried.status_code == 201, retried.text
    assert retried.json()["quality_status"] == "valid"
    assert rejected.status_code == 422, (
        f"Malformed nested evidence {case} must be a client validation error; "
        f"got {rejected.status_code}: {rejected.text}"
    )
