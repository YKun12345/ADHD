"""Actual authenticated HTTP cycle/date/revision workflow against disposable stores."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from backend.tests.test_assessment_sessions import actor


def test_real_cycle_routes_keep_two_rounds_and_unknown_original_time_separate(client):
    _, owner, pid = actor(client, suffix="w05-cycle-http")
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    first_body = {"patient_id":pid,"client_cycle_id":"w05-http-first-cycle","start_date":str(today-timedelta(days=27)),"end_date":str(today-timedelta(days=14))}
    first = client.post("/api/v1/care/cycles",headers=owner,json=first_body)
    assert first.status_code == 201, first.text
    first = first.json()
    retry = client.post("/api/v1/care/cycles",headers=owner,json=first_body)
    assert retry.status_code == 201 and retry.json()["id"] == first["id"], retry.text
    second = client.post("/api/v1/care/cycles",headers=owner,json={"patient_id":pid,"client_cycle_id":"w05-http-second-cycle",
        "start_date":str(today-timedelta(days=13)),"end_date":str(today)})
    assert second.status_code == 201, second.text
    assert second.json()["id"] != first["id"]
    assert second.json()["responsible_doctor_id"] is None and second.json()["plan_version_id"] is None
    record = {"patient_id":pid,"cycle_id":first["id"],"record_date":first["start_date"],"client_submission_id":"w05-http-backfill",
        "expected_revision":0,"recorded_at":None,"content":{"focus_minutes":0,"note":"合成补录"}}
    saved = client.post("/api/v1/care/daily-records",headers=owner,json=record)
    assert saved.status_code == 201, saved.text
    assert saved.json()["recorded_at"] is None and saved.json()["recorded_at_status"] == "unknown"
    assert saved.json()["submission_status"] == "committed" and saved.json()["is_backfill"] is True
    recovered = client.get("/api/v1/care/daily-records/w05-http-backfill",headers=owner)
    assert recovered.status_code == 200 and recovered.json() == saved.json(), recovered.text
    retry = client.post("/api/v1/care/daily-records",headers=owner,json=record)
    assert retry.status_code == 200 and retry.json() == saved.json(), retry.text
    revision = {**record,"client_submission_id":"w05-http-revision","expected_revision":1,"content":{"focus_minutes":35}}
    corrected = client.post("/api/v1/care/daily-records",headers=owner,json=revision)
    assert corrected.status_code == 201 and corrected.json()["revision"] == 2, corrected.text
    history = client.get(f"/api/v1/care/cycles/{first['id']}/daily-history?record_date={first['start_date']}",headers=owner)
    assert history.status_code == 200, history.text
    assert [row["revision"] for row in history.json()["items"]] == [1,2]
    assert [row["content"]["focus_minutes"] for row in history.json()["items"]] == [0,35]
    first_summary = client.get(f"/api/v1/care/cycles/{first['id']}",headers=owner)
    assert first_summary.status_code == 200, first_summary.text
    assert first_summary.json()["summary"]["completed_count"] == 1
    assert len(first_summary.json()["summary"]["missing_dates"]) == 13
    second_summary = client.get(f"/api/v1/care/cycles/{second.json()['id']}",headers=owner)
    assert second_summary.status_code == 200 and second_summary.json()["summary"]["completed_count"] == 0, second_summary.text
    assert len(second_summary.json()["summary"]["missing_dates"]) == 14
    all_cycles = client.get(f"/api/v1/care/cycles?patient_id={pid}",headers=owner)
    assert all_cycles.status_code == 200 and len(all_cycles.json()["items"]) == 2
    consents = client.get("/api/v1/patient/consents",headers=owner).json()["items"]
    basic = next(row for row in consents if row["purpose"] == "basic_use" and row["status"] == "active")
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw",headers=owner,json={"expected_revision":basic["revision"]}).status_code == 200
    assert client.post("/api/v1/care/daily-records",headers=owner,json=revision).status_code == 403
    assert client.get("/api/v1/care/daily-records/w05-http-backfill",headers=owner).status_code == 403
    retained = client.get(f"/api/v1/care/cycles/{first['id']}/daily-history?record_date={first['start_date']}",headers=owner)
    assert retained.status_code == 200 and len(retained.json()["items"]) == 2, retained.text
