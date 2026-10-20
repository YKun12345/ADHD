from sqlalchemy import select
from backend.tests.test_assessment_consumers import complete_assessment, drain


def test_actual_self_closure_publishes_one_immutable_system_report_without_a_fictional_doctor(client):
    owner, _, session, pid = complete_assessment(client); assert drain() == 8
    response = client.get(f"/api/v1/care/assessments/{session['id']}/reports", headers=owner)
    assert response.status_code == 200, response.text
    assert len(response.json()['items']) == 1, response.text
    report = response.json()['items'][0]
    assert report['category'] == 'self_screening' and report['review_id'] is None
    assert report['publisher_kind'] == 'system' and report['responsible_doctor_id'] is None and report['professional_confirmation'] is False
    assert report['input_snapshot']['background_visibility'] == 'not_included'
    assert len(report['input_snapshot']['evidence']) == 7 and report['input_snapshot']['missing_items'] == []
    assert all(row['acceptance_status'] == 'not_required' and row['quality_status'] == 'valid' for row in report['input_snapshot']['evidence'])
    scale = next(row for row in report['input_snapshot']['evidence'] if row['kind'] == 'scale')
    assert type(scale['server_result']['total_score']) in {int, float} and scale['server_result']['total_score'] == 0
    assert drain() == 0
    assert client.get(f"/api/v1/care/reports/{report['id']}", headers=owner).json() == report
    from backend.app.db.session import SessionLocal
    from backend.app.models.review import ReportVersion, ReviewRecord
    from backend.app.services.consent_service import current_consent
    with SessionLocal() as db:
        assert not db.scalars(select(ReviewRecord).where(ReviewRecord.assessment_id == session['id'])).all()
        original = db.get(ReportVersion, report['id'])
        try:
            original.category = 'diagnosis'; db.flush()
        except ValueError:
            db.rollback()
        else:
            raise AssertionError('System report cannot be changed into a diagnosis')
        consent = current_consent(db, pid, 'basic_use'); consent_id, revision = consent.id, consent.revision
    withdrawn = client.post(f'/api/v1/patient/consents/{consent_id}/withdraw', headers=owner, json={'expected_revision': revision})
    assert withdrawn.status_code == 200, withdrawn.text
    assert client.get(f"/api/v1/care/reports/{report['id']}", headers=owner).json() == report
