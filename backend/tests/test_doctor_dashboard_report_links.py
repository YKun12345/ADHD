from datetime import datetime, timedelta, timezone

from backend.tests.test_authorization_edges import active_care


def test_report_user_filter_has_same_seven_day_window_as_dashboard(client):
    _, doctor, _, _, pid, _ = active_care(client, suffix='dashboard-links')
    from backend.app.db.session import SessionLocal
    from backend.app.models.scale_result import ScaleResult
    with SessionLocal() as db:
        for days_ago in (1, 2, 8):
            db.add(ScaleResult(patient_id=pid, scale_type='ASRS', score_json={}, total_score=0,
                risk_level='low', created_at=datetime.now(timezone.utc) - timedelta(days=days_ago)))
        db.commit()
    patients = client.get('/api/v1/doctor/my_patients', headers=doctor)
    assert patients.status_code == 200, patients.text
    stats = client.get('/api/v1/doctor/dashboard_stats', headers=doctor).json()
    assert patients.json()['items'][0]['weekly_report_count'] == stats['weekly_report_count'] == 2


def test_report_filter_count_is_not_exposed_without_assessment_scope(client):
    _, doctor, _, _, _, _ = active_care(client, suffix='dashboard-care-links', scope=['care'])
    result = client.get('/api/v1/doctor/my_patients', headers=doctor)
    assert result.status_code == 200, result.text
    assert result.json()['items'][0]['weekly_report_count'] is None
