"""Formal immutable results cannot evade the guard by changing the legacy flag."""
import pytest

from backend.tests.test_submission_context import scale_submission
from backend.tests.test_submission_cognitive_evidence import cognitive_submission


@pytest.mark.parametrize("kind", ["scale", "cognitive"])
def test_formal_result_cannot_be_downgraded_to_legacy_for_rewrite(client, kind):
    if kind == "scale":
        owner, _, _, _, _, body = scale_submission(client, suffix="immutable-downgrade")
    else:
        owner, _, _, _, body = cognitive_submission(client, "flanker")
    response = client.post("/api/v1/care/submissions", headers=owner, json=body)
    assert response.status_code == 201, response.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from backend.app.models.cognitive_test import CognitiveTest
    with SessionLocal() as db:
        row = db.get(ScaleResult if kind == "scale" else CognitiveTest, response.json()["result"]["id"])
        row.legacy = True
        with pytest.raises(ValueError, match="(?i)immutable|formal|legacy"):
            db.commit()
        db.rollback()
    original = client.get("/api/v1/care/submissions/" + body["submission_id"] + "/evidence", headers=owner)
    assert original.status_code == 200, original.text
    assert original.json()["server_result"]["legacy"] is False
