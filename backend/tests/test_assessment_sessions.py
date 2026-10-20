"""W03 actual HTTP contracts; synthetic stores are selected before collection."""
import pytest

from backend.tests.w02_helpers import register, qualify, grant_synthetic_patient_authority


def actor(client, child=False, suffix="owner"):
    data, headers = register(client, f"w03-{suffix}@example.com", child=child)
    pid = (client.get("/api/v1/identity/context", headers=headers).json()["guardian_relationships"][0]["patient_id"] if child else data["user"]["patient_profile"]["id"])
    if child:
        reviewer, reviewer_headers = register(client, f"w03-{suffix}-reviewer@example.com", "researcher")
        qualify(reviewer["user"]["id"], reviewer=True)
        relationship = client.get("/api/v1/identity/context",headers=headers).json()["guardian_relationships"][0]
        reviewed = client.post(f"/api/v1/identity/guardians/{relationship['id']}/review",headers=reviewer_headers,json={"expected_revision":1,"status":"verified","review_reference":"synthetic-w03-institution-review","expires_at":"2090-01-01T00:00:00Z"})
        assert reviewed.status_code == 200, reviewed.text
    return data, headers, pid


def create(client, headers, pid, *, child=False, doctor=False, **extra):
    body = {"patient_id": pid, "template_id": "child-demo" if child else "adult-demo", "template_version": "W03-demo-1", "background": {}}
    body.update(extra)
    return client.post("/api/v1/care/doctor/assessments" if doctor else "/api/v1/care/patient/assessments", headers=headers, json=body)


def created(client, headers, pid, **kwargs):
    response = create(client, headers, pid, **kwargs)
    assert response.status_code == 201, response.text
    return response.json()


def attempt_body(item, pid):
    return {"expected_item_version": item["version"], "protocol_id": item["protocol_id"], "protocol_schema_version": item["protocol_schema_version"], "config_digest": item["config_digest"], "performer_patient_id": pid if item["kind"] == "cognitive" else None, "respondent_kind": item["respondent_kind"], "confirmed": True, "device": {"platform": "miniprogram", "device_type": "phone", "viewport_width":390, "viewport_height":844}, "input": {"method":"touch"}, "timing": {"clock_source":"performance.now", "unit":"ms"}, "practice": {"completed":True, "attempts":1, "exposure_count":0}, "assistance": {"provided":False, "kind":"none"}, "recall_window":item["recall_window"]}


def start(client, headers, item, pid, **extra):
    body = attempt_body(item, pid)
    body.update(extra)
    return client.post(f"/api/v1/care/assessment-items/{item['id']}/attempts", headers=headers, json=body)


def test_adult_self_all_background_skipped_has_no_fake_doctor_or_tasks(client):
    data, owner, pid = actor(client)
    session = created(client, owner, pid, background={"history":{"status":"skipped", "source":"self_report", "value":None, "confirmed":False}})
    assert session["source"] == "self" and session["responsible_doctor_id"] is None
    assert session["status"] == "active" and session["age_at_assessment"] == 25
    assert len(session["items"]) == 7
    assert session["background"]["history"]["value"] is None
    assert all(item["acceptance_status"] == "not_required" and item["execution_status"] == "not_started" and item["patient_task_id"] is None for item in session["items"])
    assert client.get("/api/v1/care/patient/tasks", headers=owner).json()["items"] == []
    assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()["id"] == session["id"]
    assert client.get(f"/api/v1/care/assessments?patient_id={pid}", headers=owner).json()["items"][0]["id"] == session["id"]


def test_child_observation_by_guardian_cognitive_by_child_server_binds_identity(client):
    data, guardian, pid = actor(client, child=True)
    session = created(client, guardian, pid, child=True)
    scale, cognitive = session["items"][:2]
    for item in (scale, cognitive):
        response = start(client, guardian, item, pid)
        assert response.status_code == 201, response.text
        attempt = response.json()
        assert attempt["actor_user_id"] == attempt["submitter_user_id"] == data["user"]["id"]
        assert attempt["age_at_attempt"] == 10
        assert attempt["performer_patient_id"] == (pid if item["kind"] == "cognitive" else None)
        assert attempt["performer_user_id"] == (data["user"]["id"] if item["kind"] == "scale" else None)
        assert attempt["performer_kind"] == ("patient" if item["kind"] == "cognitive" else "user")
        assert attempt["respondent_user_id"] == (data["user"]["id"] if item["kind"] == "scale" else None)
        assert attempt["recall_window"] == ("P6M" if item["kind"] == "scale" else None)
    fresh = client.get(f"/api/v1/care/assessments/{session['id']}",headers=guardian).json()["items"]
    assert start(client, guardian, fresh[0], pid, respondent_kind="self").status_code == 422
    assert start(client, guardian, fresh[1], pid, performer_patient_id=pid + 1000).status_code == 422


@pytest.mark.parametrize("extra", [{"template_id":"missing"}, {"template_version":"unknown"}, {"template_id":"child-demo"}, {"responsible_doctor_id":999}, {"status":"closed_self"}, {"approved":True}, {"background":{"history":{"status":"skipped","value":0,"source":"self_report","confirmed":False}}}])
def test_create_rejects_unknown_or_forged_context(client, extra):
    _, owner, pid = actor(client)
    response = create(client, owner, pid, **extra)
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("extra", [{"protocol_id":"patient-web-preview-v1"}, {"protocol_id":"unknown"}, {"protocol_schema_version":999}, {"config_digest":"changed"}, {"actor_user_id":999}, {"run_id":"reuse"}, {"result_id":1}, {"execution_status":"submitted"}, {"acceptance_status":"accepted"}])
def test_attempt_rejects_protocol_config_identity_result_or_status_declarations(client, extra):
    _, owner, pid = actor(client)
    item = created(client, owner, pid)["items"][1]
    response = start(client, owner, item, pid, **extra)
    assert response.status_code in {409,422}, response.text


def test_retest_allocates_new_attempt_run_and_preserves_old_context(client):
    data, owner, pid = actor(client)
    session = created(client, owner, pid)
    item = session["items"][1]
    first = start(client, owner, item, pid)
    assert first.status_code == 201, first.text
    assert start(client, owner, item, pid).status_code == 409
    fresh = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()["items"][1]
    second = start(client, owner, fresh, pid)
    assert second.status_code == 201, second.text
    assert first.json()["id"] != second.json()["id"] and first.json()["run_id"] != second.json()["run_id"]
    final = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()["items"][1]
    assert len(final["attempts"]) == 2
    assert final["attempts"][0] == first.json()
    assert final["execution_status"] == "in_progress" and final["quality_status"] == "pending_validation" and final["acceptance_status"] == "not_required"


def test_own_history_readable_after_basic_withdraw_new_processing_denied(client):
    _, owner, pid = actor(client)
    session = created(client, owner, pid)
    rows = client.get(f"/api/v1/patient/consents?patient_id={pid}", headers=owner).json()["items"]
    basic = next(row for row in rows if row["purpose"] == "basic_use")
    withdrawn = client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=owner, json={"expected_revision":basic["revision"]})
    assert withdrawn.status_code == 200, withdrawn.text
    retained = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner)
    assert retained.status_code == 200
    assert all(item["allowed_actions"] == [] for item in retained.json()["items"])
    assert create(client, owner, pid).status_code == 403
    assert start(client, owner, session["items"][0], pid).status_code == 403


def doctor_session(client):
    data, owner, pid = actor(client)
    doctor, doctor_headers = register(client, "w03-doctor@example.com", "researcher")
    assert create(client, doctor_headers, pid, doctor=True).status_code == 403
    grant_synthetic_patient_authority(pid, doctor["user"]["id"])
    return data, owner, pid, doctor, doctor_headers, created(client, doctor_headers, pid, doctor=True)


def test_doctor_publish_creates_real_tasks_manual_complete_cannot_fake_evidence(client):
    _, owner, pid, doctor, clinician, session = doctor_session(client)
    assert session["status"] == "draft" and session["responsible_doctor_id"] == doctor["user"]["id"]
    assert start(client, owner, session["items"][0], pid).status_code == 403
    url = f"/api/v1/care/assessments/{session['id']}/publish"
    assert client.post(url, headers=owner, json={"expected_version":1}).status_code == 403
    published = client.post(url, headers=clinician, json={"expected_version":1})
    assert published.status_code == 200, published.text
    assert published.json()["status"] == "active"
    assert client.post(url, headers=clinician, json={"expected_version":1}).status_code == 409
    tasks = client.get("/api/v1/care/patient/tasks", headers=owner).json()["items"]
    assert len(tasks) == 7 and all(row["researcher_id"] == doctor["user"]["id"] and row["legacy"] is False and row["assessment_item_id"] for row in tasks)
    assert client.post(f"/api/v1/care/patient/tasks/{tasks[0]['id']}/complete", headers=owner).status_code == 409
    assert start(client, clinician, published.json()["items"][0], pid).status_code == 403


def test_doctor_requires_both_scopes_and_clinical_withdraw_stops_attempts(client):
    _, owner, pid, doctor, clinician, session = doctor_session(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.services import authorization_ledger as ledger
    from sqlalchemy import select
    with SessionLocal() as db:
        relationship = db.scalar(select(CareRelationship).where(CareRelationship.doctor_user_id == doctor["user"]["id"]))
        relationship.status = "revoked"
        ledger.deny(relationship)
        db.commit()
    assert client.post(f"/api/v1/care/assessments/{session['id']}/publish", headers=clinician, json={"expected_version":1}).status_code == 403
    assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=clinician).status_code == 403
    assert client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).status_code == 403


def test_previous_batch_is_reference_only_and_cross_owner_is_denied(client):
    _, owner, pid = actor(client)
    first = created(client, owner, pid)
    second = created(client, owner, pid, previous_assessment_id=first["id"])
    assert second["previous_assessment_id"] == first["id"]
    assert {item["id"] for item in first["items"]}.isdisjoint({item["id"] for item in second["items"]})
    _, stranger, other_pid = actor(client, suffix="stranger")
    assert client.get(f"/api/v1/care/assessments/{first['id']}", headers=stranger).status_code == 403
    assert create(client, stranger, other_pid, previous_assessment_id=first["id"]).status_code in {403,409,422}


@pytest.mark.parametrize("authority", ["basic", "clinical", "qualification"])
def test_authority_withdrawn_before_flush_cannot_persist_new_assessment(client, authority):
    _, owner, pid = actor(client)
    doctor, clinician = register(client, "w03-race-doctor@example.com", "researcher")
    grant_synthetic_patient_authority(pid, doctor["user"]["id"])
    from sqlalchemy import event, select
    from sqlalchemy.orm import Session
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import ConsentRecord, DoctorQualification
    from backend.app.services import authorization_ledger as ledger
    fired = []

    def withdraw_before_flush(db, *_):
        if fired or not any(row.__tablename__ == "assessment_sessions" for row in db.new):
            return
        fired.append(True)
        with SessionLocal() as authority_db:
            if authority == "qualification":
                row = authority_db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == doctor["user"]["id"]))
            else:
                row = authority_db.scalar(select(ConsentRecord).where(ConsentRecord.patient_id == pid, ConsentRecord.purpose == ("basic_use" if authority == "basic" else "clinical_sharing")))
            ledger.deny(row)

    event.listen(Session, "before_flush", withdraw_before_flush)
    try:
        response = create(client, clinician, pid, doctor=True)
        assert response.status_code == 403, response.text
        assert fired == [True]
        from backend.app.models.assessment import AssessmentSession
        with SessionLocal() as db:
            assert db.scalar(select(AssessmentSession.id)) is None
    finally:
        event.remove(Session, "before_flush", withdraw_before_flush)


def test_assessment_only_doctor_cannot_create_or_read_unshared_background(client):
    data, owner, pid = actor(client)
    session = created(client, owner, pid, background={"history":{"status":"provided","source":"self_report","value":"Synthetic confidential background","confirmed":True}})
    doctor, clinician = register(client, "w03-partial-doctor@example.com", "researcher")
    qualify(doctor["user"]["id"])
    invitation = client.post("/api/v1/care/relationships/invitations", headers=clinician, json={"patient_id":pid, "target_email":data["user"]["email"], "scope":["assessment"], "purpose":"clinical_sharing"})
    assert invitation.status_code == 201, invitation.text
    accepted = client.post(f"/api/v1/care/relationships/{invitation.json()['id']}/accept", headers=owner, json={"expected_revision":1})
    assert accepted.status_code == 200, accepted.text
    read = client.get(f"/api/v1/care/assessments/{session['id']}", headers=clinician)
    assert read.status_code == 200, read.text
    assert read.json()["background"] == {} and read.json()["background_visibility"] == "withheld"
    assert "Synthetic confidential background" not in read.text
    assert create(client, clinician, pid, doctor=True).status_code == 403


def test_background_provided_needs_profile_processing_but_all_skipped_does_not(client):
    _,owner,pid = actor(client)
    consent = client.post("/api/v1/patient/consents",headers=owner,json={"patient_id":pid,"purpose":"basic_use","scope":["assessment"],"terms_version":"W02-1"})
    assert consent.status_code == 201, consent.text
    assert create(client,owner,pid,background={"history":{"status":"skipped","value":None,"source":"self_report","confirmed":False}}).status_code == 201
    provided = create(client,owner,pid,background={"history":{"status":"provided","value":"Synthetic protected background","source":"self_report","confirmed":True}})
    assert provided.status_code == 403, provided.text


def test_background_storage_is_encrypted_and_prior_legacy_result_remains_unbound(client):
    _, owner, pid = actor(client)
    historical = client.post("/api/v1/patient/submit_scale", headers=owner, json={"scale_type":"ASRS","answers":[0]*18,"respondent_type":"self"})
    assert historical.status_code == 201, historical.text
    assert historical.json()["legacy"] is True and historical.json()["task_attempt_id"] is None
    session = created(client, owner, pid, background={"history":{"status":"provided","source":"self_report","value":"Synthetic secret observation","confirmed":True}})
    item = session["items"][0]
    assert start(client, owner, item, pid, result_id=historical.json()["id"]).status_code == 422
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    from sqlalchemy import text
    with SessionLocal() as db:
        result = db.get(ScaleResult,historical.json()["id"])
        assert result.legacy is True and result.assessment_id is None and result.assessment_item_id is None and result.task_attempt_id is None
        raw = db.execute(text("SELECT background FROM assessment_sessions WHERE id=:id"),{"id":session["id"]}).scalar_one()
        assert raw.startswith("aesgcm:v2:") and "Synthetic secret observation" not in raw


def test_attempt_context_cannot_be_rewritten_and_history_age_is_frozen(client):
    _, owner, pid = actor(client)
    session = created(client, owner, pid)
    response = start(client, owner, session["items"][1], pid)
    assert response.status_code == 201, response.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.assessment import TaskAttempt
    from backend.app.models.patient import Patient
    with SessionLocal() as db:
        attempt = db.get(TaskAttempt,response.json()["id"])
        attempt.config_digest = "changed"
        with pytest.raises(ValueError,match="immutable"):
            db.commit()
        db.rollback()
        db.get(Patient,pid).age = 26
        db.commit()
    read = client.get(f"/api/v1/care/assessments/{session['id']}",headers=owner).json()
    assert read["age_at_assessment"] == 25 and read["items"][1]["attempts"][0]["age_at_attempt"] == 25


@pytest.mark.parametrize("authority", ["clinical", "qualification"])
def test_doctor_read_is_denied_when_original_authority_changes_before_response(client, monkeypatch, authority):
    _, owner, pid, doctor, clinician, session = doctor_session(client)
    from backend.app.services import assessment_service, authorization_ledger as ledger
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import ConsentRecord, DoctorQualification
    from sqlalchemy import select
    original = assessment_service.session_response
    changed = []
    def revoke_after_serialization(db,row,user):
        result = original(db,row,user)
        if not changed:
            with SessionLocal() as authority_db:
                model = DoctorQualification if authority == "qualification" else ConsentRecord
                query = select(model).where(model.user_id == doctor["user"]["id"]) if authority == "qualification" else select(model).where(model.patient_id == pid,model.purpose == "clinical_sharing")
                ledger.deny(authority_db.scalar(query))
            changed.append(True)
        return result
    monkeypatch.setattr(assessment_service,"session_response",revoke_after_serialization)
    denied = client.get(f"/api/v1/care/assessments/{session['id']}",headers=clinician)
    assert denied.status_code == 403, denied.text
    assert changed == [True]


def test_preview_web_cannot_claim_formal_mobile_attempt_source(client):
    _,owner,pid = actor(client)
    session = created(client,owner,pid)
    response = start(client,owner,session["items"][1],pid,device={"platform":"patient_web","device_type":"computer","viewport_width":1280,"viewport_height":800},input={"method":"mouse"})
    assert response.status_code == 422, response.text


def test_legacy_endpoints_cannot_claim_new_assessment_context_or_server_attempt_run(client):
    _,owner,pid = actor(client)
    session = created(client,owner,pid)
    attempt = start(client,owner,session["items"][1],pid)
    assert attempt.status_code == 201, attempt.text
    legacy_scale = client.post("/api/v1/patient/submit_scale",headers=owner,json={"scale_type":"ASRS","answers":[0]*18,"assessment_item_id":session["items"][0]["id"]})
    assert legacy_scale.status_code == 422, legacy_scale.text
    legacy_cognitive = client.post("/api/v1/patient/submit_cognitive_test",headers=owner,json={"test_type":"reaction","result_json":{"test_run_id":attempt.json()["run_id"],"raw_result":{"accuracy":80}}})
    assert legacy_cognitive.status_code == 409, legacy_cognitive.text
    read = client.get(f"/api/v1/care/assessments/{session['id']}",headers=owner).json()
    assert read["items"][1]["execution_status"] == "in_progress"


def test_verified_doctor_self_access_does_not_replace_actual_clinical_relationship(client):
    data,owner,pid = actor(client)
    qualify(data["user"]["id"])
    response = create(client,owner,pid,doctor=True)
    assert response.status_code == 403,response.text


def test_doctor_draft_cannot_borrow_new_relationship_after_original_revocation(client):
    _,owner,pid,doctor,clinician,session = doctor_session(client)
    from sqlalchemy import select
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import CareRelationship
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        old = db.scalar(select(CareRelationship).where(CareRelationship.doctor_user_id == doctor["user"]["id"]))
        ledger.deny(old)
        old.status = "revoked"
        db.commit()
    grant_synthetic_patient_authority(pid,doctor["user"]["id"])
    response = client.post(f"/api/v1/care/assessments/{session['id']}/publish",headers=clinician,json={"expected_version":1})
    assert response.status_code in {403,409},response.text


@pytest.mark.parametrize("authority", ["qualification", "relationship"])
def test_unfiltered_dual_authority_list_keeps_self_and_filters_revoked_doctor_scope(client,authority):
    data,actor_headers,own_pid = actor(client,suffix="dual-list")
    qualify(data["user"]["id"])
    own = created(client,actor_headers,own_pid)
    _,_,target_pid = actor(client,suffix="dual-list-target")
    grant_synthetic_patient_authority(target_pid,data["user"]["id"])
    assigned = created(client,actor_headers,target_pid,doctor=True)
    _,other_headers,unshared_pid = actor(client,suffix="dual-list-unshared")
    unshared = created(client,other_headers,unshared_pid)
    initial = client.get("/api/v1/care/assessments",headers=actor_headers)
    assert initial.status_code == 200,initial.text
    assert {row["id"] for row in initial.json()["items"]} == {own["id"],assigned["id"]}
    assert unshared["id"] not in {row["id"] for row in initial.json()["items"]}
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification,CareRelationship
    from backend.app.services import authorization_ledger as ledger
    from sqlalchemy import select
    with SessionLocal() as db:
        model = DoctorQualification if authority == "qualification" else CareRelationship
        query = select(model).where(model.user_id == data["user"]["id"]) if authority == "qualification" else select(model).where(model.patient_id == target_pid,model.doctor_user_id == data["user"]["id"])
        ledger.deny(db.scalar(query))
    after = client.get("/api/v1/care/assessments",headers=actor_headers)
    assert after.status_code == 200,after.text
    assert {row["id"] for row in after.json()["items"]} == {own["id"]}


@pytest.mark.parametrize("claimed_source", ["self_report", "guardian_report"])
@pytest.mark.parametrize("status", ["provided", "unknown", "skipped"])
def test_doctor_background_rejects_wrong_reporter_source_without_persisting_it(client,claimed_source,status):
    _,_,pid,_,clinician,original = doctor_session(client)
    response = create(client,clinician,pid,doctor=True,background={"history":{"status":status,"value":"Synthetic patient feedback" if status == "provided" else None,"source":claimed_source,"confirmed":status == "provided"}})
    assert response.status_code == 422,response.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.assessment import AssessmentSession
    from sqlalchemy import select
    with SessionLocal() as db:
        assert db.scalars(select(AssessmentSession.id)).all() == [original["id"]]


@pytest.mark.parametrize("status", ["provided", "unknown", "skipped"])
def test_doctor_patient_report_keeps_actual_recorder_and_null_unknown_values(client,status):
    _,_,pid,doctor,clinician,_ = doctor_session(client)
    response = create(client,clinician,pid,doctor=True,background={"history":{"status":status,"value":"Synthetic patient feedback" if status == "provided" else None,"source":"patient_report","confirmed":status == "provided"}})
    assert response.status_code == 201,response.text
    field = response.json()["background"]["history"]
    assert field["source"] == "patient_report" and field["recorded_by_user_id"] == doctor["user"]["id"]
    assert field["confirmed_by_user_id"] == (doctor["user"]["id"] if status == "provided" else None)
    assert field["value"] == ("Synthetic patient feedback" if status == "provided" else None)


@pytest.mark.parametrize("child", [False,True])
def test_self_background_keeps_actual_self_or_verified_guardian_source(client,child):
    data,owner,pid = actor(client,child=child,suffix="background-source-self")
    wrong = create(client,owner,pid,child=child,background={"history":{"status":"provided","value":"Synthetic user feedback","source":"patient_report","confirmed":True}})
    assert wrong.status_code == 422,wrong.text
    expected_source = "guardian_report" if child else "self_report"
    correct = create(client,owner,pid,child=child,background={"history":{"status":"provided","value":"Synthetic user feedback","source":expected_source,"confirmed":True}})
    assert correct.status_code == 201,correct.text
    field = correct.json()["background"]["history"]
    assert field["source"] == expected_source
    assert field["recorded_by_user_id"] == field["confirmed_by_user_id"] == data["user"]["id"]
