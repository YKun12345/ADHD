"""Actual service lifespan drives committed work without a manual handler call."""
import time
import pytest


def test_sqlite_maintenance_releases_writer_between_items(client, monkeypatch):
    """A SQLite polling cycle must yield its sole writer after each item."""
    from threading import Event
    from backend.app.db.session import SessionLocal
    from backend.app.workers import care_worker_runtime as worker
    from backend.app.services import care_authority_reconciliation as reconcile
    from backend.app.services import attention_deadline_service as deadlines
    from backend.app.services import care_transfer_maintenance as transfers

    done = Event()
    observed = []
    monkeypatch.setattr(worker, 'run_once', lambda *a, **k: False)
    def check(*a, **kw):
        observed.append(kw['limit'])
        if len(observed) == 3:
            done.set()
        return 0
    monkeypatch.setattr(reconcile, 'reconcile_once', check)
    monkeypatch.setattr(deadlines, 'monitor_once', check)
    monkeypatch.setattr(transfers, 'maintain_once', check)
    runtime = worker.CareWorkerRuntime(SessionLocal, interval_seconds=.1, batch_size=16)
    runtime.start()
    try:
        assert done.wait(4), 'All three background maintenance stages must still run.'
    finally:
        assert runtime.stop()
    assert observed[:3] == [1, 1, 1], 'A batch must not hold the SQLite writer for 16 records.'


@pytest.fixture
def worker_client(monkeypatch,request):
    monkeypatch.setenv("CARE_WORKER_ENABLED","true")
    monkeypatch.setenv("CARE_WORKER_INTERVAL_SECONDS","0.1")
    return request.getfixturevalue("client")


def test_actual_lifespan_consumes_committed_quality_event_and_stops(worker_client):
    from backend.tests.test_submission_cognitive_evidence import cognitive_submission
    owner,_,_,_,body = cognitive_submission(worker_client,"flanker")
    body["content"]["execution_metadata"]["interrupted_count"] = 1
    submitted = worker_client.post("/api/v1/care/submissions",headers=owner,json=body)
    assert submitted.status_code == 201,submitted.text
    rows = []
    for _ in range(100):
        response = worker_client.get(f"/api/v1/care/patient/attention?patient_id={body['patient_id']}",headers=owner)
        assert response.status_code == 200,response.text
        rows = response.json()["items"]
        if rows:
            break
        time.sleep(0.05)
    assert len(rows) == 1,"The actual running service must consume its committed event without a test calling run_once."
    assert rows[0]["submission_id"] == body["submission_id"]
    runtime = worker_client.app.state.care_worker
    assert runtime.running
    assert runtime.stop(timeout=5) is True
    assert runtime.running is False
