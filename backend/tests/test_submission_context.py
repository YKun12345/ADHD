"""Real W03 attempts must acquire immutable W04 result associations."""
from copy import deepcopy
import pytest
from backend.tests.test_assessment_sessions import actor,created,start,doctor_session


def scale_submission(client, *, child=False, doctor=False, suffix="submission"):
    if doctor:
        _,owner,pid,_,clinician,session = doctor_session(client)
        published = client.post(f"/api/v1/care/assessments/{session['id']}/publish",headers=clinician,json={"expected_version":session["version"]})
        assert published.status_code == 200,published.text
        session = published.json()
    else:
        _,owner,pid = actor(client,child=child,suffix=suffix)
        session = created(client,owner,pid,child=child)
        clinician = None
    item = session["items"][0]
    response = start(client,owner,item,pid)
    assert response.status_code == 201,response.text
    attempt = response.json()
    body = {"submission_id":"w04-"+suffix,"kind":"scale","patient_id":pid,
        "assessment_id":session["id"],"assessment_item_id":item["id"],"attempt_id":attempt["id"],
        "run_id":attempt["run_id"],"task_id":item["patient_task_id"],
        **{key:attempt[key] for key in ("protocol_id","protocol_schema_version","config_digest","template_digest","actor_user_id","performer_kind","performer_user_id","performer_patient_id","respondent_user_id","respondent_kind","submitter_user_id")},
        "content":{"scale_type":item["instrument"],"answers":[0]*(26 if child else 18),"recall_window":"P6M","content_digest":item["content_digest"]}}
    return owner,clinician,session,item,attempt,body


@pytest.mark.parametrize("child",[False,True])
def test_real_scale_submission_ack_retry_and_query(client,child):
    owner,_,session,item,attempt,body = scale_submission(client,child=child)
    first = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert first.status_code == 201,first.text
    retry = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert retry.status_code == 200,retry.text
    assert first.json()["result"] == retry.json()["result"]
    assert first.json()["execution_status"] == "submitted" and first.json()["quality_status"] == "valid"
    assert first.json()["acceptance_status"] == "not_required"
    saved = client.get("/api/v1/care/submissions/"+body["submission_id"],headers=owner)
    assert saved.status_code == 200 and saved.json()["result"] == first.json()["result"]
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    with SessionLocal() as db:
        result = db.get(ScaleResult,first.json()["result"]["id"])
        assert result.legacy is False and result.patient_id == body["patient_id"]
        assert (result.assessment_id,result.assessment_item_id,result.task_attempt_id) == (session["id"],item["id"],attempt["id"])
        assert result.total_score == 0


@pytest.mark.parametrize("field",["assessment_id","assessment_item_id","attempt_id","run_id","config_digest","actor_user_id","performer_kind","respondent_user_id"])
def test_submission_context_cannot_be_relabelled(client,field):
    owner,_,_,_,_,body = scale_submission(client)
    first = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert first.status_code == 201,first.text
    changed = deepcopy(body)
    changed[field] = changed[field]+100 if type(changed[field]) is int else ("patient" if field == "performer_kind" else "different")
    response = client.post("/api/v1/care/submissions",headers=owner,json=changed)
    assert response.status_code == 409,response.text


def test_submitted_attempt_cannot_take_different_content_or_submission_id(client):
    owner,_,_,_,_,body = scale_submission(client)
    assert client.post("/api/v1/care/submissions",headers=owner,json=body).status_code == 201
    changed = deepcopy(body)
    changed["content"]["answers"][0] = 1
    assert client.post("/api/v1/care/submissions",headers=owner,json=changed).status_code == 409
    changed = {**body,"submission_id":"different-submission"}
    assert client.post("/api/v1/care/submissions",headers=owner,json=changed).status_code == 409


def test_doctor_cannot_submit_for_user_and_never_auto_accepts(client):
    owner,clinician,_,_,_,body = scale_submission(client,doctor=True)
    assert client.post("/api/v1/care/submissions",headers=clinician,json=body).status_code == 403
    response = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert response.status_code == 201,response.text
    assert response.json()["acceptance_status"] == "pending_review"


def test_basic_withdrawal_blocks_submission_but_preserves_committed_own_history(client):
    owner,_,_,_,_,body = scale_submission(client)
    saved = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert saved.status_code == 201,saved.text
    consents = client.get("/api/v1/patient/consents",headers=owner).json()["items"]
    basic = next(row for row in consents if row["purpose"] == "basic_use")
    withdrawn = client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=owner,json={"expected_revision":basic["revision"]})
    assert withdrawn.status_code == 200,withdrawn.text
    assert client.post("/api/v1/care/submissions",headers=owner,json=body).status_code == 403
    assert client.get("/api/v1/care/submissions/"+body["submission_id"],headers=owner).status_code == 200


def test_attempt_read_links_exact_submission_and_authorized_original_evidence(client):
    owner,_,session,_,attempt,body = scale_submission(client)
    submitted = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert submitted.status_code == 201,submitted.text
    current = client.get(f"/api/v1/care/assessments/{session['id']}",headers=owner).json()
    saved = current["items"][0]["attempts"][0]
    assert saved["submission_id"] == body["submission_id"]
    assert saved["result"] == submitted.json()["result"]
    response = client.get(f"/api/v1/care/submissions/{body['submission_id']}/evidence",headers=owner)
    assert response.status_code == 200,response.text
    assert response.json()["context"]["attempt_id"] == attempt["id"]
    assert response.json()["server_result"]["score_json"]["answers"] == [0]*18
    assert response.json()["server_result"]["total_score"] == 0


def test_critical_audit_failure_cannot_disclose_submission_evidence(client,monkeypatch):
    owner,_,_,_,_,body = scale_submission(client)
    assert client.post("/api/v1/care/submissions",headers=owner,json=body).status_code == 201
    assert client.get(f"/api/v1/care/submissions/{body['submission_id']}/evidence",headers=owner).status_code == 200
    from backend.app.services import security_service
    def fail(*args,**kwargs): raise RuntimeError("synthetic critical audit unavailable")
    monkeypatch.setattr(security_service,"_append_audit_log",fail)
    response = client.get(f"/api/v1/care/submissions/{body['submission_id']}/evidence",headers=owner)
    assert response.status_code == 503,response.text
    assert "score_json" not in response.text and "answers" not in response.text
