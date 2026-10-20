from backend.tests.test_assessment_sessions import actor, create


def test_registry_freezes_test_only_scale_and_twelve_cognitive_configs(client):
    _, owner, pid = actor(client)
    response = client.get(f"/api/v1/care/assessment-templates?patient_id={pid}", headers=owner)
    assert response.status_code == 200, response.text
    registry = response.json()
    assert len(registry["registry_digest"]) == 64
    template = next(row for row in registry["items"] if row["id"] == "adult-demo")
    assert template["version"] == "W03-demo-1" and template["admission_status"] == "test_only"
    assert template["professional_approval"] is None and template["license_status"] == "not_verified"
    scale = template["items"][0]
    assert scale["recall_window"] == "P6M" and len(scale["config"]["questions"]) == 18
    assert scale["content_digest"] == "f115213d741ed4759d72de4aa6514e7fb8411faa41339c76c1eb21d92409949d"
    assert all(row["protocol_id"] == "continuous-mobile-v4" and row["protocol_schema_version"] == 6 for row in template["items"][1:])
    assert [row["age_group"] for row in registry["items"]] == ["adult"]
    assert [row["config"]["formalTrials"] for row in template["items"][1:5]] == [25,24,24,24]


def test_production_registry_stays_blocked_client_flags_cannot_approve(client, monkeypatch):
    _, owner, pid = actor(client)
    from backend.app.core.config import settings
    monkeypatch.setattr(settings, "APP_ENV", "production")
    response = client.get(f"/api/v1/care/assessment-templates?patient_id={pid}", headers=owner)
    assert response.status_code == 200, response.text
    assert response.json()["blockers"]
    assert all(row["admission_status"] == "blocked" and row["professional_approval"] is None for row in response.json()["items"])
    assert create(client, owner, pid).status_code == 403


def test_registry_creation_permissions_follow_current_basic_scope_and_withdrawal(client):
    _, owner, pid = actor(client)
    url = f"/api/v1/care/assessment-templates?patient_id={pid}"
    active = client.get(url,headers=owner)
    assert active.status_code == 200, active.text
    assert active.json()["can_create"] is True and active.json()["can_create_self"] is True
    assert active.json()["background_processing_allowed"] is True
    grant = client.post("/api/v1/patient/consents",headers=owner,json={"patient_id":pid,"purpose":"basic_use","scope":["assessment"],"terms_version":"W02-1"})
    assert grant.status_code == 201,grant.text
    limited = client.get(url,headers=owner)
    assert limited.json()["can_create"] is True and limited.json()["background_processing_allowed"] is False
    withdrawn = client.post(f"/api/v1/patient/consents/{grant.json()['id']}/withdraw",headers=owner,json={"expected_revision":grant.json()["revision"]})
    assert withdrawn.status_code == 200,withdrawn.text
    denied = client.get(url,headers=owner)
    assert denied.status_code == 200,denied.text
    assert denied.json()["can_create"] is False and denied.json()["can_create_self"] is False


def test_registry_assessment_only_doctor_can_read_but_cannot_create(client):
    from backend.tests.w02_helpers import register,qualify
    data,owner,pid = actor(client)
    doctor,clinician = register(client,"w03-template-partial@example.com","researcher")
    qualify(doctor["user"]["id"])
    invitation = client.post("/api/v1/care/relationships/invitations",headers=clinician,json={"patient_id":pid,"target_email":data["user"]["email"],"scope":["assessment"],"purpose":"clinical_sharing"})
    assert invitation.status_code == 201,invitation.text
    accepted = client.post(f"/api/v1/care/relationships/{invitation.json()['id']}/accept",headers=owner,json={"expected_revision":1})
    assert accepted.status_code == 200,accepted.text
    response = client.get(f"/api/v1/care/assessment-templates?patient_id={pid}",headers=clinician)
    assert response.status_code == 200,response.text
    assert response.json()["can_create"] is False and response.json()["can_create_doctor_assigned"] is False
