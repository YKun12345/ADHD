"""An actual authority denial during critical audit keeps its 403 meaning."""
from datetime import datetime
from zoneinfo import ZoneInfo
import pytest
from sqlalchemy import select
from backend.tests.test_assessment_sessions import actor


@pytest.mark.parametrize("list_view",[False,True])
def test_cycle_audit_does_not_disguise_request_time_authority_denial_as_retryable_failure(client,monkeypatch,list_view):
    data,owner,pid = actor(client,suffix="cycle-audit-race-"+str(list_view))
    day = str(datetime.now(ZoneInfo("Asia/Shanghai")).date())
    saved = client.post("/api/v1/care/cycles",headers=owner,json={"patient_id":pid,"client_cycle_id":"cycle-audit-race",
        "start_date":day,"end_date":day})
    assert saved.status_code == 201,saved.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import PatientAccess
    from backend.app.services import authorization_ledger as ledger,care_cycle_service
    original = care_cycle_service._audit
    calls = []
    def deny_before_audit(db,user,patient_id,action,**detail):
        calls.append(action)
        with SessionLocal() as authority:
            access = authority.scalar(select(PatientAccess).where(PatientAccess.patient_id == pid,PatientAccess.user_id == data["user"]["id"]))
            ledger.deny(access)
        return original(db,user,patient_id,action,**detail)
    monkeypatch.setattr(care_cycle_service,"_audit",deny_before_audit)
    route = f"/api/v1/care/cycles?patient_id={pid}" if list_view else f"/api/v1/care/cycles/{saved.json()['id']}"
    response = client.get(route,headers=owner)
    assert calls == ["care_cycles_read" if list_view else "care_cycle_read"]
    assert response.status_code == 403,response.text
    assert "cycle-audit-race" not in response.text
