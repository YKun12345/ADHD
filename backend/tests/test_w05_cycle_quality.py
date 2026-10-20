"""Independent recovery/response-boundary review; disposable client stores only."""
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import event, func, select

from backend.tests.test_assessment_sessions import actor


def _setup(client, suffix):
    _, headers, pid = actor(client, suffix=suffix)
    day = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    body = {"patient_id": pid, "client_cycle_id": "quality-" + suffix,
            "start_date": day, "end_date": day}
    return headers, body


def _daily(cycle, key="quality-original", revision=0):
    return {"patient_id": cycle["patient_id"], "cycle_id": cycle["id"],
            "record_date": cycle["start_date"], "client_submission_id": key,
            "expected_revision": revision, "recorded_at": None,
            "content": {"focus_minutes": 0, "is_medication": False, "note": "合成恢复原件"}}


def _fail_next_commit(monkeypatch, action):
    from backend.app.services import care_cycle_service
    original = care_cycle_service._audit
    state = {"armed": True}

    def audit(db, user, patient_id, current_action, **detail):
        original(db, user, patient_id, current_action, **detail)
        if state["armed"] and current_action == action:
            state["armed"] = False

            def fail(session):
                raise RuntimeError("synthetic quality commit boundary failure")

            event.listen(db, "before_commit", fail, once=True)

    monkeypatch.setattr(care_cycle_service, "_audit", audit)
    return state


def _count(model, **where):
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        statement = select(func.count()).select_from(model)
        for field, value in where.items():
            statement = statement.where(getattr(model, field) == value)
        return db.scalar(statement)


def test_cycle_commit_failure_keeps_no_partial_fact_then_original_id_retry_recovers(client, monkeypatch):
    from backend.app.models.care_cycle import CareCycle
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    headers, body = _setup(client, "quality-create")
    state = _fail_next_commit(monkeypatch, "self_cycle_created")
    failed = client.post("/api/v1/care/cycles", headers=headers, json=body)
    assert state["armed"] is False
    assert failed.status_code == 503, failed.text
    assert _count(CareCycle) == 0
    assert _count(CareEvent, event_type="self_cycle_created") == 0
    assert _count(SecurityAuditLog, action="self_cycle_created") == 0
    recovered = client.post("/api/v1/care/cycles", headers=headers, json=body)
    assert recovered.status_code == 201, recovered.text
    again = client.post("/api/v1/care/cycles", headers=headers, json=body)
    assert again.status_code == 201 and again.json() == recovered.json(), again.text
    assert _count(CareCycle) == 1
    assert _count(CareEvent, event_type="self_cycle_created") == 1
    assert _count(SecurityAuditLog, action="self_cycle_created") == 1


def test_failed_daily_commit_retries_once_and_old_lost_ack_survives_a_new_revision(client, monkeypatch):
    from backend.app.models.care_cycle import DailyRecord
    from backend.app.models.event import CareEvent
    from backend.app.models.security import SecurityAuditLog
    headers, body = _setup(client, "quality-daily")
    created = client.post("/api/v1/care/cycles", headers=headers, json=body)
    assert created.status_code == 201, created.text
    payload = _daily(created.json())
    state = _fail_next_commit(monkeypatch, "daily_record_submitted")
    failed = client.post("/api/v1/care/daily-records", headers=headers, json=payload)
    assert state["armed"] is False
    assert failed.status_code == 503, failed.text
    assert _count(DailyRecord) == 0
    assert _count(CareEvent, event_type="daily_record_submitted") == 0
    assert _count(SecurityAuditLog, action="daily_record_submitted") == 0
    recovered = client.post("/api/v1/care/daily-records", headers=headers, json=payload)
    assert recovered.status_code == 201, recovered.text
    original = recovered.json()
    revised = {**payload, "client_submission_id": "quality-second", "expected_revision": 1,
               "content": {"focus_minutes": 35, "is_medication": False}}
    revision = client.post("/api/v1/care/daily-records", headers=headers, json=revised)
    assert revision.status_code == 201 and revision.json()["revision"] == 2, revision.text
    old_retry = client.post("/api/v1/care/daily-records", headers=headers, json=payload)
    assert old_retry.status_code == 200 and old_retry.json() == original, old_retry.text
    old_read = client.get("/api/v1/care/daily-records/quality-original", headers=headers)
    assert old_read.status_code == 200 and old_read.json() == original, old_read.text
    history = client.get(f"/api/v1/care/cycles/{created.json()['id']}/daily-history",
                         headers=headers, params={"record_date": payload["record_date"]})
    assert history.status_code == 200, history.text
    assert [row["record_id"] for row in history.json()["items"]] == [original["record_id"], revision.json()["record_id"]]
    assert _count(DailyRecord) == 2
    assert _count(CareEvent, event_type="daily_record_submitted") == 2
    assert _count(SecurityAuditLog, action="daily_record_submitted") == 2


@pytest.mark.parametrize("operation,action", [
    ("list", "care_cycles_read"), ("detail", "care_cycle_read"),
    ("history", "daily_history_read"), ("ack", "daily_record_ack_read"),
])
def test_sensitive_read_commit_failure_never_discloses_content_and_next_read_recovers(client, monkeypatch, operation, action):
    from backend.app.models.care_cycle import DailyRecord
    from backend.app.models.security import SecurityAuditLog
    headers, body = _setup(client, "quality-read-" + operation)
    created = client.post("/api/v1/care/cycles", headers=headers, json=body)
    assert created.status_code == 201, created.text
    cycle = created.json()
    saved = client.post("/api/v1/care/daily-records", headers=headers, json=_daily(cycle))
    assert saved.status_code == 201, saved.text
    routes = {"list": f"/api/v1/care/cycles?patient_id={cycle['patient_id']}",
              "detail": f"/api/v1/care/cycles/{cycle['id']}",
              "history": f"/api/v1/care/cycles/{cycle['id']}/daily-history?record_date={cycle['start_date']}",
              "ack": "/api/v1/care/daily-records/quality-original"}
    before = _count(SecurityAuditLog, action=action)
    state = _fail_next_commit(monkeypatch, action)
    failed = client.get(routes[operation], headers=headers)
    assert state["armed"] is False
    assert failed.status_code == 503, failed.text
    assert set(failed.json()) == {"detail"}
    assert "合成恢复原件" not in failed.text
    assert _count(SecurityAuditLog, action=action) == before
    recovered = client.get(routes[operation], headers=headers)
    assert recovered.status_code == 200, recovered.text
    assert _count(SecurityAuditLog, action=action) == before + 1
    assert _count(DailyRecord) == 1
    if operation == "ack":
        assert recovered.json() == saved.json()
