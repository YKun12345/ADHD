from backend.tests.w02_helpers import register, qualify, invite


def test_old_registration_consent_does_not_enable_external_ai(client, monkeypatch):
    patient, owner = register(client, "no-external@example.com")
    from backend.app.services import ai_service
    monkeypatch.setattr(ai_service.settings, "DEEPSEEK_API_KEY", "synthetic-only-key")
    calls = []
    def forbidden(*args, **kwargs):
        calls.append(True)
        raise AssertionError("External provider invoked without explicit consent")
    monkeypatch.setattr(ai_service, "urlopen", forbidden)
    response = client.post("/api/v1/ai/chat", headers=owner, json={"message":"你好", "conversation":[], "context_scope":"general"})
    assert response.status_code == 200, response.text
    assert response.json()["provider"] == "local"
    assert response.json()["degraded"] is True
    assert calls == [], "External provider was called before falling back"
    assert client.get("/api/v1/patient/dashboard_status", headers=owner).status_code == 200


def test_consent_withdraw_business_restore_remains_denied(client, sqlite_database_path, tmp_path):
    import sqlite3
    patient, owner = register(client, "restore@example.com")
    patient_id = patient["user"]["patient_profile"]["id"]
    response = client.post("/api/v1/patient/consents", headers=owner, json={"patient_id":patient_id,"purpose":"external_ai","scope":["profile","assessment","tracking"],"terms_version":"W02-1"})
    assert response.status_code == 201, response.text
    consent = response.json()
    backup_path = tmp_path / "business-backup.db"
    with sqlite3.connect(sqlite_database_path) as business, sqlite3.connect(backup_path) as backup:
        business.backup(backup)
    withdraw_url = f"/api/v1/patient/consents/{consent['id']}/withdraw"
    assert client.post(withdraw_url, headers=owner, json={"expected_revision":9}).status_code == 409
    assert client.post(withdraw_url, headers=owner, json={"expected_revision":1}).status_code == 200
    from backend.app.db.session import engine, SessionLocal
    engine.dispose()
    with sqlite3.connect(backup_path) as backup, sqlite3.connect(sqlite_database_path) as business:
        backup.backup(business)
    from backend.app.services.consent_service import has_consent
    with SessionLocal() as db:
        assert not has_consent(db, patient_id, "external_ai")
    assert client.post(withdraw_url, headers=owner, json={"expected_revision":1}).status_code in [403,409]
