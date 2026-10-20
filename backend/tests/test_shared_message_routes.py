"""Real HTTP sends are scoped to one accepted relationship and pre-send authority."""
from backend.tests.test_care_message_scope import message_world


def send_context(client,headers,pid,relationship_id):
    response = client.get(f"/api/v1/care/shared-messages/relationships?patient_id={pid}",headers=headers)
    assert response.status_code == 200, response.text
    return next(row for row in response.json()["items"] if row["relationship_id"] == relationship_id)


def test_actual_shared_message_routes_isolate_doctors_and_keep_own_history(client):
    owner_data,owner,pid,doctors = message_world(client)
    _,doctor_a,rel_a = doctors[0]
    _,doctor_b,rel_b = doctors[1]
    context = send_context(client,owner,pid,rel_a["id"])
    body = {"patient_id":pid,"relationship_id":rel_a["id"],"client_message_id":"w05-http-shared-original",
        "content":"合成资料：明确给A的共享反馈。","confirmed":True,"send_context":context["send_context"]}
    created = client.post("/api/v1/care/shared-messages",headers=owner,json=body)
    assert created.status_code == 201, created.text
    ack = created.json()
    assert ack["sender_user_id"] == owner_data["user"]["id"] and ack["relationship_id"] == rel_a["id"]
    assert ack["submission_status"] == "committed" and ack["legacy"] is False
    retry = client.post("/api/v1/care/shared-messages",headers=owner,json=body)
    assert retry.status_code == 200 and retry.json() == ack, retry.text
    recovered = client.get("/api/v1/care/shared-messages/submissions/w05-http-shared-original",headers=owner)
    assert recovered.status_code == 200 and recovered.json() == ack, recovered.text
    url = f"/api/v1/care/shared-messages?patient_id={pid}&relationship_id="
    actual_a = client.get(url+str(rel_a["id"]),headers=doctor_a)
    assert actual_a.status_code == 200 and actual_a.json()["items"][0]["content"] == body["content"]
    actual_b = client.get(url+str(rel_b["id"]),headers=doctor_b)
    assert actual_b.status_code == 200 and actual_b.json()["items"] == []
    assert client.get(url+str(rel_a["id"]),headers=doctor_b).status_code == 403
    receipt = client.post(f"/api/v1/care/shared-messages/{ack['message_id']}/read",headers=doctor_a)
    assert receipt.status_code == 200 and receipt.json()["viewer_user_id"] == doctors[0][0]["user"]["id"], receipt.text
    assert client.post(f"/api/v1/care/shared-messages/{ack['message_id']}/read",headers=doctor_b).status_code == 403
    revoked = client.post(f"/api/v1/care/relationships/{rel_a['id']}/revoke",headers=owner,json={"expected_revision":rel_a["revision"]})
    assert revoked.status_code == 200, revoked.text
    assert client.get(url+str(rel_a["id"]),headers=doctor_a).status_code == 403
    own = client.get(url+str(rel_a["id"]),headers=owner)
    assert own.status_code == 200 and own.json()["items"][0]["content"] == body["content"]
    history = send_context(client,owner,pid,rel_a["id"])
    assert history["can_send"] is False and history["send_context"] is None


def test_original_unsent_shared_context_cannot_borrow_regranted_basic_authority(client):
    _,owner,pid,doctors = message_world(client)
    rel = doctors[0][2]
    original = send_context(client,owner,pid,rel["id"])
    body = {"patient_id":pid,"relationship_id":rel["id"],"client_message_id":"w05-http-before-withdrawal",
        "content":"合成离线消息原件。","confirmed":True,"send_context":original["send_context"]}
    basic = next(row for row in client.get("/api/v1/patient/consents",headers=owner).json()["items"]
        if row["purpose"] == "basic_use" and row["status"] == "active")
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=owner,json={"expected_revision":basic["revision"]}).status_code == 200
    regranted = client.post("/api/v1/patient/consents",headers=owner,json={"patient_id":pid,"purpose":"basic_use","scope":basic["scope"],"terms_version":"W02-1"})
    assert regranted.status_code == 201, regranted.text
    rejected = client.post("/api/v1/care/shared-messages",headers=owner,json=body)
    assert rejected.status_code in {403,409}, rejected.text
    assert client.get("/api/v1/care/shared-messages/submissions/"+body["client_message_id"],headers=owner).status_code == 404
    fresh = send_context(client,owner,pid,rel["id"])
    explicit_new = {**body,"client_message_id":"w05-http-new-confirmation","send_context":fresh["send_context"]}
    saved = client.post("/api/v1/care/shared-messages",headers=owner,json=explicit_new)
    assert saved.status_code == 201, saved.text
