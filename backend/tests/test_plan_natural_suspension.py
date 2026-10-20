from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import select
from backend.tests.test_assessment_consumers import complete_assessment, drain
from backend.tests.test_report_publications import publication_body


def test_completed_assessment_still_has_its_active_plan_suspended_by_bounded_background_observation(client):
    owner, doctor, session, pid = complete_assessment(client, doctor=True); drain()
    ctx = client.get(f"/api/v1/care/assessments/{session['id']}/review-context", headers=doctor).json()
    review = client.post('/api/v1/care/reviews', headers=doctor, json={'client_review_id': 'natural-plan-review', 'patient_id': pid,
        'assessment_id': session['id'], 'expected_assessment_version': ctx['assessment_version'], 'input_digest': ctx['input_digest'],
        'review_context': ctx['review_context'], 'category': 'evidence_review', 'body': '实际核对本轮全部合成原件。', 'limitations': '仅演示材料审核，不是诊断。',
        'decisions': [{'submission_id': row['submission_id'], 'assessment_item_id': row['assessment_item_id'], 'attempt_id': row['attempt_id'],
            'decision': 'accepted', 'reason': '已核对原件与实际质量。'} for row in ctx['submissions']], 'confirmed': True})
    assert review.status_code == 201, review.text
    report = client.post('/api/v1/care/review-publications', headers=doctor, json=publication_body(client, doctor, review.json()))
    assert report.status_code == 201 and report.json()['assessment_status'] == 'reviewed', report.text
    planctx = client.get(f"/api/v1/care/assessments/{session['id']}/plan-context", headers=doctor).json()
    day = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    published = client.post('/api/v1/care/plan-versions', headers=doctor, json={'client_plan_version_id': 'natural-observed-plan',
        'patient_id': pid, 'assessment_id': session['id'], 'expected_assessment_version': planctx['assessment_version'],
        'expected_previous_version': 0, 'expected_plan_revision': 0, 'source_report_id': planctx['source_report_id'], 'input_digest': planctx['input_digest'],
        'plan_context': planctx['plan_context'], 'title': '合成后续观察', 'instructions': '真实记录日期与实际情况。', 'start_date': str(day),
        'end_date': str(day + timedelta(days=1)), 'confirmed': True})
    assert published.status_code == 201, published.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.care_plan import CarePlan
    from backend.app.models.identity import DoctorQualification
    from backend.app.models.care_system_event import CareSystemEvent
    from backend.app.services.care_authority_reconciliation import reconcile_once, verify_system_event
    with SessionLocal() as db:
        qualification = db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == session['responsible_doctor_id']))
        expiry = qualification.expires_at
        qualification.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1); db.commit()
    assert reconcile_once(SessionLocal, limit=50) >= 1
    with SessionLocal() as db:
        plan = db.get(CarePlan, published.json()['plan_id'])
        assert plan.status == 'suspended' and plan.suspension_reason == 'original_authority_invalid'
        facts = db.scalars(select(CareSystemEvent).where(CareSystemEvent.event_type == 'professional_plan_suspended')).all()
        assert len(facts) == 1
        assert verify_system_event(facts[0])['human_action'] is False
        qualification = db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == session['responsible_doctor_id']))
        qualification.expires_at = expiry; db.commit()
    read = client.get(f"/api/v1/care/plans/{published.json()['plan_id']}", headers=owner)
    assert read.status_code == 200 and read.json()['status'] == 'suspended', read.text
    assert client.get(f"/api/v1/care/assessments/{session['id']}/plan-context", headers=doctor).status_code == 409
