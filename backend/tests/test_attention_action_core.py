"""Real consumer-owned attention actions, synthetic temporary DB and ledger only."""
import importlib
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import event, func, select, text

from backend.tests.test_assessment_consumers import drain
from backend.tests.test_submission_cognitive_evidence import cognitive_submission
from backend.tests.test_submission_context import scale_submission


def test_attention_action_core_exists_as_separate_immutable_fact():
    for name in ("models.attention_action", "schemas.attention_action", "services.attention_action_service"):
        assert importlib.util.find_spec("backend.app."+name), "Missing immutable attention action core: "+name


@pytest.fixture
def core(client):
    for name in ("models.attention_action", "schemas.attention_action", "services.attention_action_service"):
        assert importlib.util.find_spec("backend.app."+name), "Missing immutable attention action core: "+name
    from backend.app.db.base import Base
    from backend.app.db.session import SessionLocal, engine
    from backend.app.models.user import User
    model = importlib.import_module("backend.app.models.attention_action")
    schema = importlib.import_module("backend.app.schemas.attention_action")
    service = importlib.import_module("backend.app.services.attention_action_service")
    Base.metadata.create_all(engine)
    return client, SessionLocal, model, schema, service, User


def quality_attention(core, *, child=False, doctor=False):
    if doctor:
        owner, clinician, session, _, _, scale = scale_submission(core[0], doctor=True)
        owner, session, item, _, body = cognitive_submission(core[0], "flanker", context=(owner, session, scale["patient_id"]))
        body["task_id"] = item["patient_task_id"]
    else:
        owner, session, _, _, body = cognitive_submission(core[0], "flanker", child=child)
        clinician = None
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    result = core[0].post("/api/v1/care/submissions", headers=owner, json=body)
    assert result.status_code == 201 and result.json()["quality_status"] == "limited", result.text
    assert drain() == 2
    from backend.app.models.attention import AttentionItem
    from backend.app.models.submission import SubmissionRecord
    with core[1]() as db:
        row = db.scalar(select(AttentionItem).where(AttentionItem.assessment_id == session["id"]))
        uid = db.scalar(select(SubmissionRecord.actor_user_id).where(SubmissionRecord.submission_id == body["submission_id"]))
        return uid, owner, clinician, row.id, row.patient_id, row.responsible_doctor_id


def detail(core, uid, identifier):
    with core[1]() as db:
        value = core[4].attention_detail(db, db.get(core[5], uid), identifier)
        db.commit()  # Sensitive read audit must commit before caller disclosure.
        return value


def payload(core, uid, identifier, *, key="attention-action-original", action="acknowledge", reason=None, view=None):
    view = detail(core, uid, identifier) if view is None else view
    return core[3].AttentionActionCreate(client_action_id=key, action=action, reason=reason,
        expected_version=view["attention"]["version"], action_context=view["action_context"], confirmed=True)


def act(core, uid, identifier, body):
    with core[1]() as db:
        value = core[4].act_on_attention(db, db.get(core[5], uid), identifier, body)
        db.commit()
        return value


def facts(core, identifier):
    from backend.app.models.attention import AttentionItem
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    with core[1]() as db:
        row = db.get(AttentionItem, identifier)
        return (row.status, row.version,
            db.scalar(select(func.count()).select_from(core[2].AttentionAction)),
            db.scalar(select(func.count()).select_from(CareEvent).where(CareEvent.event_type == "attention_action_committed")),
            db.scalar(select(func.count()).select_from(SecurityAuditLog)))


@pytest.mark.parametrize("child", [False, True])
def test_original_ack_is_frozen_after_later_resolution_and_global_id_cannot_change(core, child):
    uid, _, _, identifier, pid, doctor = quality_attention(core, child=child)
    first = payload(core, uid, identifier)
    acknowledged, created = act(core, uid, identifier, first)
    assert created is True
    assert acknowledged["actor_user_id"] == uid and acknowledged["patient_id"] == pid
    assert acknowledged["actor_identity_basis"].startswith("guardian:" if child else "self:")
    assert acknowledged["previous_status"] == "open" and acknowledged["status"] == "acknowledged"
    assert acknowledged["expected_version"] == 1 and acknowledged["version"] == 2 and doctor is None
    assert acknowledged["confirmed"] is True and acknowledged["legacy"] is False
    assert len(acknowledged["action_context_digest"]) == 64
    resolved, _ = act(core, uid, identifier, payload(core, uid, identifier, key="actual-resolve",
        action="resolve", reason="合成事实：已说明本次中断及下一次操作注意事项。"))
    assert resolved["status"] == "resolved" and resolved["version"] == 3
    assert act(core, uid, identifier, first) == (acknowledged, False)
    with core[1]() as db:
        actual = core[4].query_attention_action(db, db.get(core[5], uid), first.client_action_id)
        history = core[4].attention_history(db, db.get(core[5], uid), identifier)
        db.commit()
    assert actual == acknowledged and history["items"] == [acknowledged, resolved]
    assert detail(core, uid, identifier)["allowed_actions"] == []
    with pytest.raises(HTTPException) as error:
        act(core, uid, identifier, first.model_copy(update={"reason":"changed original body"}))
    assert error.value.status_code == 409
    assert facts(core, identifier)[:4] == ("resolved", 3, 2, 2)


def test_first_post_cannot_borrow_new_basic_grant_and_own_history_stays_readable(core):
    uid, owner, _, identifier, pid, _ = quality_attention(core)
    queued = payload(core, uid, identifier)
    basic = next(row for row in core[0].get("/api/v1/patient/consents", headers=owner).json()["items"]
        if row["purpose"] == "basic_use" and row["status"] == "active")
    withdrawn = core[0].post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=owner,
        json={"expected_revision":basic["revision"]})
    assert withdrawn.status_code == 200, withdrawn.text
    history = detail(core, uid, identifier)
    assert history["allowed_actions"] == [] and history["action_context"] is None
    granted = core[0].post("/api/v1/patient/consents", headers=owner,
        json={"patient_id":pid,"purpose":"basic_use","scope":basic["scope"],"terms_version":"W02-1"})
    assert granted.status_code == 201, granted.text
    with pytest.raises(HTTPException) as error:
        act(core, uid, identifier, queued)
    assert error.value.status_code in {403,409}
    assert facts(core, identifier)[2:4] == (0,0)
    assert detail(core, uid, identifier)["allowed_actions"] == []


def test_clinical_attention_only_original_doctor_can_process_and_context_is_actor_bound(core):
    uid, owner, _, identifier, pid, doctor_uid = quality_attention(core, doctor=True)
    from backend.tests.w02_helpers import register, qualify
    other, other_headers = register(core[0], "attention-other-doctor@example.com", "researcher")
    qualify(other["user"]["id"])
    invited = core[0].post("/api/v1/care/relationships/invitations", headers=other_headers,
        json={"target_email":core[0].get("/api/v1/auth/me", headers=owner).json()["email"],
            "patient_id":pid,"scope":["profile","assessment","care"],"purpose":"clinical_sharing"})
    assert invited.status_code == 201, invited.text
    accepted = core[0].post(f"/api/v1/care/relationships/{invited.json()['id']}/accept", headers=owner,
        json={"expected_revision":invited.json()["revision"]})
    assert accepted.status_code == 200, accepted.text
    own = detail(core, uid, identifier)
    assert own["allowed_actions"] == [] and own["action_context"] is None
    queued = payload(core, doctor_uid, identifier)
    for actor in (uid, other["user"]["id"]):
        with pytest.raises(HTTPException) as error:
            act(core, actor, identifier, queued)
        assert error.value.status_code == 403
    ack, _ = act(core, doctor_uid, identifier, queued)
    assert ack["actor_user_id"] == doctor_uid and ack["actor_identity_basis"].startswith("doctor:")
    with pytest.raises(HTTPException) as error:
        act(core, other["user"]["id"], identifier, queued)
    assert error.value.status_code == 409  # A committed global ID never becomes another actor's ACK.


def test_action_context_tampering_and_stale_version_never_create_action(core):
    uid, _, _, identifier, _, _ = quality_attention(core)
    original = payload(core, uid, identifier)
    with pytest.raises(HTTPException) as error:
        act(core, uid, identifier, original.model_copy(update={"action_context":original.action_context[:-1]+("a" if original.action_context[-1] != "a" else "b")}))
    assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        act(core, uid, identifier, original.model_copy(update={"expected_version":2}))
    assert error.value.status_code == 409
    assert facts(core, identifier)[:4] == ("open",1,0,0)


def test_real_audit_failure_and_caller_rollback_preserve_all_fact_counts(core, monkeypatch):
    uid, _, _, identifier, _, _ = quality_attention(core)
    body = payload(core, uid, identifier)
    before = facts(core, identifier)
    with core[1]() as db:
        core[4].act_on_attention(db, db.get(core[5],uid), identifier, body)
        db.rollback()
    assert facts(core, identifier) == before
    from backend.app.services import security_service
    def fail(*args, **kwargs):
        raise RuntimeError("synthetic critical audit storage unavailable")
    monkeypatch.setattr(security_service, "_append_audit_log", fail)
    with pytest.raises(HTTPException) as error:
        act(core, uid, identifier, body)
    assert error.value.status_code == 503
    assert facts(core, identifier) == before
    with pytest.raises(HTTPException) as error:
        detail(core, uid, identifier)
    assert error.value.status_code == 503


def test_final_commit_ledger_denial_rolls_back_fact_state_event_and_audit(core):
    uid, _, _, identifier, pid, _ = quality_attention(core)
    body = payload(core, uid, identifier)
    before = facts(core, identifier)
    from backend.app.services.identity_access import recheck_request_authority
    from backend.app.models.consent import ConsentRecord
    from backend.app.services import authorization_ledger as ledger
    with core[1]() as db:
        event.listen(db, "before_flush", lambda *_:recheck_request_authority(db))
        event.listen(db, "before_commit", lambda *_:recheck_request_authority(db))
        core[4].act_on_attention(db, db.get(core[5],uid), identifier, body)
        with core[1]() as revoker:
            basic = revoker.scalar(select(ConsentRecord).where(ConsentRecord.patient_id == pid,
                ConsentRecord.purpose == "basic_use", ConsentRecord.status == "active"))
            ledger.deny(basic)
        with pytest.raises(HTTPException) as error:
            db.commit()
        assert error.value.status_code == 403
        db.rollback()
    assert facts(core, identifier) == before


def test_concurrent_same_version_has_one_real_winner(core):
    uid, _, _, identifier, _, _ = quality_attention(core)
    original = payload(core, uid, identifier)
    ready = Barrier(2)
    def submit(key):
        ready.wait(timeout=10)
        try:
            return act(core, uid, identifier, original.model_copy(update={"client_action_id":key}))[0]["status"]
        except HTTPException as exc:
            return exc.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(submit, ("concurrent-a", "concurrent-b")))
    assert sorted(outcomes, key=str) == sorted(["acknowledged",409], key=str)
    assert facts(core, identifier)[:4] == ("acknowledged",2,1,1)


@pytest.mark.parametrize("mutation", ["status='closed_with_reason', action='close_with_reason'", "actor_user_id=999999", "action_context_digest='tampered'", "reason='tampered'"])
def test_action_authenticated_metadata_tampering_fails_closed(core, mutation):
    uid, _, _, identifier, _, _ = quality_attention(core)
    body = payload(core, uid, identifier)
    act(core, uid, identifier, body)
    from backend.app.core.record_envelope import RecordIntegrityError
    with core[1]() as db:
        db.execute(text("UPDATE attention_actions SET "+mutation))
        db.commit()
    with core[1]() as db:
        with pytest.raises(RecordIntegrityError):
            core[4].query_attention_action(db, db.get(core[5],uid), body.client_action_id)


def test_action_orm_update_and_delete_are_forbidden(core):
    uid, _, _, identifier, _, _ = quality_attention(core)
    body = payload(core, uid, identifier)
    act(core, uid, identifier, body)
    for delete in (False, True):
        with core[1]() as db:
            row = db.scalar(select(core[2].AttentionAction))
            if delete:
                db.delete(row)
            else:
                row.status = "resolved"
            with pytest.raises(ValueError, match="immutable"):
                db.flush()
            db.rollback()
    assert facts(core, identifier)[:4] == ("acknowledged",2,1,1)


def test_action_schema_requires_actual_reason_confirmation_and_server_context(core):
    common = {"client_action_id":"schema-core","expected_version":1,"action":"acknowledge",
        "reason":None,"confirmed":True,"action_context":"server-context-placeholder"}
    for extra in ({"actor_user_id":1}, {"status":"resolved"}, {"confirmed":"true"}, {"confirmed":False},
            {"expected_version":True}, {"reason":" "}, {"action":"resolve"}, {"action":"close_with_reason"},
            {"action_context":""}):
        with pytest.raises(ValidationError):
            core[3].AttentionActionCreate.model_validate({**common, **extra})


def test_actual_deferred_commit_failure_rolls_back_provisional_action(core):
    """SQLite itself rejects COMMIT; a returned service value is not durable."""
    from sqlalchemy.exc import IntegrityError
    uid, _, _, identifier, _, _ = quality_attention(core)
    body = payload(core, uid, identifier)
    before = facts(core, identifier)
    with core[1]() as db:
        db.execute(text("CREATE TABLE synthetic_commit_parent (id INTEGER PRIMARY KEY)"))
        db.execute(text("CREATE TABLE synthetic_commit_guard (parent_id INTEGER REFERENCES "
            "synthetic_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)"))
        db.commit()
        db.connection().exec_driver_sql("PRAGMA foreign_keys=ON")
        db.execute(text("INSERT INTO synthetic_commit_guard VALUES (12345)"))
        provisional, created = core[4].act_on_attention(db, db.get(core[5],uid), identifier, body)
        assert created is True and provisional["status"] == "acknowledged"
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
        db.connection().exec_driver_sql("PRAGMA foreign_keys=OFF")
        db.commit()
    assert facts(core, identifier) == before


def test_terminal_attention_read_still_authenticates_its_actual_source_event(core):
    uid, _, _, identifier, _, _ = quality_attention(core)
    act(core, uid, identifier, payload(core, uid, identifier, action="close_with_reason",
        reason="合成记录：已核对中断情况并实际说明关闭缘由。"))
    from backend.app.core.record_envelope import RecordIntegrityError
    with core[1]() as db:
        db.execute(text("UPDATE care_events SET aggregate_id=aggregate_id+999 WHERE event_id="
            "(SELECT source_event_id FROM attention_items WHERE id=:identifier)"), {"identifier":identifier})
        db.commit()
    with pytest.raises(RecordIntegrityError):
        detail(core, uid, identifier)


def test_actual_unavailable_action_table_is_storage_503_not_permission_denial(core):
    uid, _, _, identifier, _, _ = quality_attention(core)
    body = payload(core, uid, identifier)
    from backend.app.models.attention import AttentionItem
    with core[1]() as db:
        db.execute(text("DROP TABLE attention_actions"))
        db.commit()
    with pytest.raises(HTTPException) as error:
        act(core, uid, identifier, body)
    assert error.value.status_code == 503
    with core[1]() as db:
        row = db.get(AttentionItem, identifier)
        assert (row.status,row.version) == ("open",1)
