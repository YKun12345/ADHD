"""Actual HTTP accepts actual client-generated synthetic trials, never only claims."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import pytest
from backend.tests.test_assessment_sessions import actor,created,start


def cognitive_submission(client,task="reaction",*,child=False,context=None):
    if context is None:
        _,owner,pid = actor(client,child=child,suffix="cognitive-submit")
        session = created(client,owner,pid,child=child)
    else:
        owner,session,pid = context
    item = next(row for row in session["items"] if row["key"] == task)
    response = start(client,owner,item,pid)
    assert response.status_code == 201,response.text
    attempt = response.json()
    completed = subprocess.run(["node",str(Path(__file__).with_name("w04_cognitive_fixture.cjs"))],input=json.dumps({"config":item["config"],"run_id":attempt["run_id"]}),capture_output=True,text=True,encoding="utf-8",check=True)
    evidence = json.loads(completed.stdout)
    metadata = {key:attempt["metadata"][key] for key in ("device","input","timing","practice","assistance")}
    metadata["practice"] = {"completed":True,"attempts":1,"exposure_count":0}
    metadata.update(interrupted_count=0,practice_records=evidence["practice_records"])
    body = {"submission_id":"w04-cognitive-"+task,"kind":"cognitive","patient_id":pid,"assessment_id":session["id"],"assessment_item_id":item["id"],"attempt_id":attempt["id"],"run_id":attempt["run_id"],"task_id":None,**{key:attempt[key] for key in ("protocol_id","protocol_schema_version","config_digest","template_digest","actor_user_id","performer_kind","performer_user_id","performer_patient_id","respondent_user_id","respondent_kind","submitter_user_id")},"content":{**evidence["payload"],"execution_metadata":metadata}}
    return owner,session,item,attempt,body


@pytest.mark.parametrize("task",["reaction","stroop","flanker","nback","trail","digit"])
@pytest.mark.parametrize("child",[False,True])
def test_actual_frozen_client_trials_are_server_validated(client,task,child):
    owner,_,_,attempt,body = cognitive_submission(client,task,child=child)
    response = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert response.status_code == 201,response.text
    assert response.json()["quality_status"] == "valid"
    assert response.json()["acceptance_status"] == "not_required"
    assert response.json()["comparability_status"] == "not_verified"
    assert "device_equivalence_not_verified" in response.json()["comparability_reasons"]
    retry = client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert retry.status_code == 200 and retry.json()["result"] == response.json()["result"]


@pytest.mark.parametrize("change",["missing_trial","forged_correct","summary","practice_claim_only","source","config"])
def test_claims_cannot_promote_missing_or_contradictory_evidence(client,change):
    owner,_,_,_,body = cognitive_submission(client,"flanker")
    altered = deepcopy(body)
    content = altered["content"]
    if change == "missing_trial": content["result_json"]["trials"].pop()
    elif change == "forged_correct": content["result_json"]["trials"][0]["answer"] = "left" if content["result_json"]["trials"][0]["target"] == "right" else "right"
    elif change == "summary": content["result_json"]["raw_result"]["accuracy"] = 1
    elif change == "practice_claim_only": content["execution_metadata"]["practice_records"] = []
    elif change == "source": content["result_json"]["source"] = "patient_web"
    elif change == "config": content["result_json"]["protocol_schema_version"] = 5
    content["result_json"]["quality"]["valid"] = True
    response = client.post("/api/v1/care/submissions",headers=owner,json=altered)
    if change == "practice_claim_only":
        assert response.status_code == 201 and response.json()["quality_status"] != "valid",response.text
    else:
        assert response.status_code == 422,response.text
