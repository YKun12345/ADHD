from backend.tests.w02_helpers import register, qualify


def test_technical_researcher_cannot_read_cross_patient_ai_endpoints(client):
    _, researcher = register(client, "technical@example.com", "researcher")
    patient, owner = register(client, "cross@example.com")
    patient_id = patient["user"]["patient_profile"]["id"]
    for suffix in ["adaptive_difficulty/stroop", "trend_predictions", "care_alerts"]:
        response = client.get(f"/api/v1/ai-enhanced/patient/{patient_id}/{suffix}", headers=researcher)
        assert response.status_code == 403, (suffix, response.text)
    assert client.get("/api/v1/patient/dashboard_status", headers=owner).status_code == 200


def test_confirmed_child_guardian_can_use_own_child_without_institution(client):
    child, guardian = register(client, "guardian@example.com", child=True)
    context = client.get("/api/v1/identity/context", headers=guardian)
    assert context.status_code == 200, context.text
    assert len(context.json()["accessible_patients"]) == 1
    assert context.json()["guardian_relationships"][0]["status"] == "confirmed"
    assert context.json()["guardian_relationships"][0]["institution_id"] is None
    assert client.get("/api/v1/patient/dashboard_status", headers=guardian).status_code == 200


def test_only_institution_reviewer_may_verify_guardian(client):
    child, guardian = register(client, "review-child@example.com", child=True)
    reviewer, reviewer_headers = register(client, "reviewer@example.com", "researcher")
    relationship = client.get("/api/v1/identity/context", headers=guardian).json()["guardian_relationships"][0]
    payload = {"expected_revision": 1, "status":"verified", "review_reference":"synthetic-institution-review", "expires_at":"2090-01-01T00:00:00Z"}
    url = f"/api/v1/identity/guardians/{relationship['id']}/review"
    assert client.post(url, headers=guardian, json=payload).status_code == 403
    assert client.post(url, headers=reviewer_headers, json=payload).status_code == 403
    qualify(reviewer["user"]["id"], reviewer=True)
    accepted = client.post(url, headers=reviewer_headers, json=payload)
    assert accepted.status_code == 200, accepted.text
    assert client.get("/api/v1/patient/dashboard_status", headers=guardian).status_code == 200
