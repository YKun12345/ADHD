"""Actual attention actions are explicit facts, separate from notification or clinical acceptance."""
from backend.tests.test_assessment_consumers import complete_assessment, drain
from backend.tests.test_submission_cognitive_evidence import cognitive_submission


def preflight(client,headers,attention_id):
    response = client.get(f"/api/v1/care/attention/{attention_id}",headers=headers)
    assert response.status_code == 200,response.text
    value = response.json()
    assert value["attention"]["id"] == attention_id
    return value


def action_body(view,key,action,reason=None):
    return {"client_action_id":key,"expected_version":view["attention"]["version"],"action":action,
        "reason":reason,"action_context":view["action_context"],"confirmed":True}


def test_self_quality_attention_ack_is_real_idempotent_and_never_clinical_acceptance(client):
    owner,session,_,_,body = cognitive_submission(client,"flanker")
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    saved = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert saved.status_code == 201 and saved.json()["quality_status"] == "limited",saved.text
    assert drain() == 2
    listed = client.get(f"/api/v1/care/patient/attention?patient_id={body['patient_id']}",headers=owner)
    assert listed.status_code == 200,listed.text
    attention = listed.json()["items"][0]
    view = preflight(client,owner,attention["id"])
    assert view["attention"]["owner_kind"] == "patient_self"
    assert view["allowed_actions"] == ["acknowledge","close_with_reason"]
    assert view["action_context"] and len(view["action_context_digest"]) == 64
    payload = action_body(view,"self-quality-ack-original","acknowledge")
    route = f"/api/v1/care/attention/{attention['id']}/actions"
    created = client.post(route,headers=owner,json=payload)
    assert created.status_code == 201,created.text
    ack = created.json()
    assert ack["status"] == "acknowledged" and ack["version"] == attention["version"]+1
    assert ack["submission_status"] == "committed" and ack["legacy"] is False
    retry = client.post(route,headers=owner,json=payload)
    assert retry.status_code == 200 and retry.json() == ack,retry.text
    recovered = client.get("/api/v1/care/attention-actions/self-quality-ack-original",headers=owner)
    assert recovered.status_code == 200 and recovered.json() == ack,recovered.text
    history = client.get(f"/api/v1/care/attention/{attention['id']}/history",headers=owner)
    assert history.status_code == 200 and len(history.json()["items"]) == 1,history.text
    unchanged = client.get(f"/api/v1/care/assessments/{session['id']}",headers=owner).json()
    assert unchanged["status"] == "active" and unchanged["responsible_doctor_id"] is None
    assert all(item["acceptance_status"] == "not_required" for item in unchanged["items"])


def test_doctor_owns_processing_and_real_reason_does_not_accept_the_assessment(client):
    owner,doctor,session,_ = complete_assessment(client,doctor=True)
    assert drain() == 8
    listed = client.get("/api/v1/care/doctor/work_queue",headers=doctor)
    assert listed.status_code == 200,listed.text
    attention = next(row for row in listed.json()["items"] if row["assessment_id"] == session["id"])
    view = preflight(client,doctor,attention["id"])
    owner_view = preflight(client,owner,attention["id"])
    assert owner_view["allowed_actions"] == [] and owner_view["action_context"] is None
    route = f"/api/v1/care/attention/{attention['id']}/actions"
    payload = action_body(view,"doctor-attention-ack","acknowledge")
    assert client.post(route,headers=owner,json=payload).status_code == 403
    acknowledged = client.post(route,headers=doctor,json=payload)
    assert acknowledged.status_code == 201 and acknowledged.json()["status"] == "acknowledged",acknowledged.text
    current = preflight(client,doctor,attention["id"])
    assert current["allowed_actions"] == ["resolve","close_with_reason"]
    no_reason = client.post(route,headers=doctor,json=action_body(current,"doctor-no-reason","resolve"))
    assert no_reason.status_code == 422,no_reason.text
    reason = "合成处理说明：已核对原材料并说明下一步，尚未发布任何诊断或专业验收。"
    resolved = client.post(route,headers=doctor,json=action_body(current,"doctor-attention-resolved","resolve",reason))
    assert resolved.status_code == 201,resolved.text
    assert resolved.json()["status"] == "resolved" and resolved.json()["reason"] == reason
    assert preflight(client,doctor,attention["id"])["allowed_actions"] == []
    actual = client.get(f"/api/v1/care/assessments/{session['id']}",headers=owner).json()
    assert actual["status"] == "under_review"
    assert all(item["acceptance_status"] == "pending_review" for item in actual["items"])
    assert not [row for row in client.get("/api/v1/care/doctor/work_queue",headers=doctor).json()["items"] if row["id"] == attention["id"]]
