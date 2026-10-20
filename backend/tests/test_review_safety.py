import json
import pytest
from sqlalchemy import text, select, inspect
from backend.tests.test_report_publications import saved_draft, publication_body


@pytest.mark.parametrize('kind', ['audit', 'commit'])
def test_publication_critical_fault_rolls_back_report_acceptance_and_event(client, monkeypatch, kind):
    owner, doctor, _, session, draft, _ = saved_draft(client)
    payload = publication_body(client, doctor, draft)
    from backend.app.services import review_service
    original = review_service._audit
    def audit(db, *args, **kwargs):
        if args[2] == 'professional_report_published':
            if kind == 'audit':
                from fastapi import HTTPException
                raise HTTPException(503, 'synthetic critical review audit failure')
            db.info['synthetic_review_commit_failure'] = True
        return original(db, *args, **kwargs)
    monkeypatch.setattr(review_service, '_audit', audit)
    from sqlalchemy.orm import Session
    old_commit = Session.commit
    def commit(db):
        if db.info.get('synthetic_review_commit_failure'):
            raise RuntimeError('synthetic final review COMMIT failure')
        return old_commit(db)
    monkeypatch.setattr(Session, 'commit', commit)
    response = client.post('/api/v1/care/review-publications', headers=doctor, json=payload)
    assert response.status_code == 503, response.text
    assert client.get('/api/v1/care/review-publications/submissions/original-publication', headers=doctor).status_code == 404
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        assert db.execute(text('SELECT COUNT(*) FROM report_versions')).scalar_one() == 0
        assert db.execute(text("SELECT COUNT(*) FROM care_events WHERE event_type='professional_report_published'")).scalar_one() == 0
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    assert current['version'] == payload['expected_assessment_version']
    assert all(row['acceptance_status'] == 'pending_review' for row in current['items'])


def test_basic_withdrawal_preserves_original_draft_and_published_history_but_denies_new_processing(client):
    owner, doctor, _, session, draft, body = saved_draft(client)
    payload = publication_body(client, doctor, draft)
    saved = client.post('/api/v1/care/review-publications', headers=doctor, json=payload)
    assert saved.status_code == 201, saved.text
    original = saved.json()
    basic = next(row for row in client.get('/api/v1/patient/consents', headers=owner).json()['items'] if row['purpose'] == 'basic_use')
    assert client.post(f"/api/v1/patient/consents/{basic['id']}/withdraw", headers=owner, json={'expected_revision': basic['revision']}).status_code == 200
    assert client.get('/api/v1/care/reviews/submissions/original-review-draft', headers=doctor).json() == draft
    assert client.get('/api/v1/care/review-publications/submissions/original-publication', headers=doctor).json() == original
    assert client.get(f"/api/v1/care/reports/{original['id']}", headers=owner).json()['body'] == draft['body']
    assert client.post('/api/v1/care/review-publications', headers=doctor, json=payload).status_code == 403
    assert client.post('/api/v1/care/reviews', headers=doctor, json=body).status_code == 403


def test_renewed_doctor_qualification_cannot_borrow_earlier_draft_context_or_history(client):
    _, doctor, _, _, draft, body = saved_draft(client)
    from backend.app.db.session import SessionLocal
    from backend.app.models.identity import DoctorQualification
    from backend.app.services import authorization_ledger as ledger
    with SessionLocal() as db:
        qualification = db.scalar(select(DoctorQualification).where(DoctorQualification.user_id == draft['actor_user_id']))
        ledger.deny(qualification); db.commit(); ledger.publish(qualification)
    denied = client.get('/api/v1/care/reviews/submissions/original-review-draft', headers=doctor)
    assert denied.status_code in {403, 409}, denied.text
    assert draft['body'] not in denied.text
    assert client.post('/api/v1/care/reviews', headers=doctor, json={**body, 'client_review_id': 'borrow-renewed'}).status_code in {403, 409}


@pytest.mark.parametrize('mutation', ['cross_row', 'metadata'])
def test_draft_ciphertext_or_metadata_cannot_be_rebound_to_another_original(client, mutation):
    _, doctor, _, _, draft, body = saved_draft(client)
    second = client.post('/api/v1/care/reviews', headers=doctor, json={**body, 'client_review_id': 'second-original'})
    assert second.status_code == 201, second.text
    from backend.app.db.session import SessionLocal
    with SessionLocal() as db:
        if mutation == 'cross_row':
            cipher = db.execute(text('SELECT snapshot FROM review_records WHERE id=:id'), {'id': draft['id']}).scalar_one()
            db.execute(text('UPDATE review_records SET snapshot=:cipher WHERE id=:id'), {'cipher': cipher, 'id': second.json()['id']})
        else:
            db.execute(text("UPDATE review_records SET category='screening_opinion' WHERE id=:id"), {'id': second.json()['id']})
        db.commit()
    response = client.get(f"/api/v1/care/reviews/{second.json()['id']}", headers=doctor)
    assert response.status_code in {409, 503}, response.text
    assert draft['body'] not in response.text


@pytest.mark.parametrize('category', ['clinical_assessment', 'diagnosis'])
def test_demo_cannot_be_promoted_by_a_qualified_doctor_or_an_environment_flag(client, category):
    _, doctor, _, _, _, body = saved_draft(client)
    response = client.post('/api/v1/care/reviews', headers=doctor, json={**body, 'category': category, 'client_review_id': 'forbidden-category'})
    assert response.status_code == 409, response.text


def test_published_objects_are_immutable_and_original_read_audit_must_commit(client, monkeypatch):
    owner, doctor, _, _, draft, _ = saved_draft(client)
    publication = client.post('/api/v1/care/review-publications', headers=doctor, json=publication_body(client, doctor, draft))
    assert publication.status_code == 201, publication.text
    from backend.app.db.session import SessionLocal
    from backend.app.models.review import ReviewInputSnapshot, ReviewRecord, ReportVersion
    for model in [ReviewInputSnapshot, ReviewRecord, ReportVersion]:
        for action in ['update', 'delete']:
            with SessionLocal() as db:
                row = db.scalar(select(model))
                if action == 'delete':
                    db.delete(row)
                else:
                    row.input_digest = '0'*64
                with pytest.raises(ValueError, match='immutable|deleted'):
                    db.commit()
                db.rollback()
    from backend.app.services import review_service
    def unavailable(*a, **k):
        from fastapi import HTTPException
        raise HTTPException(503, 'synthetic sensitive read audit failure')
    monkeypatch.setattr(review_service, '_audit', unavailable)
    response = client.get(f"/api/v1/care/reports/{publication.json()['id']}", headers=owner)
    assert response.status_code == 503 and draft['body'] not in response.text


def test_readonly_review_schema_plan_and_missing_store_rehearsal_are_explicit(client):
    _, doctor, _, session, _, body = saved_draft(client)
    from backend.app.db.session import engine
    with engine.begin() as conn:
        for table in ['report_versions', 'review_records', 'review_input_snapshots']:
            conn.execute(text(f'DROP TABLE {table}'))
    before = set(inspect(engine).get_table_names())
    from backend.app.db.review_migration import review_schema_plan
    plan = review_schema_plan(engine)
    assert plan['requires_explicit_review'] is True and len(plan['statements']) >= 3
    assert set(inspect(engine).get_table_names()) == before
    denied = client.post('/api/v1/care/reviews', headers=doctor, json=body)
    assert denied.status_code == 503, denied.text
    assert set(inspect(engine).get_table_names()) == before
    with engine.begin() as conn:
        for statement in plan['statements']:
            conn.execute(text(statement))
    assert review_schema_plan(engine)['statements'] == []
    saved = client.post('/api/v1/care/reviews', headers=doctor, json=body)
    assert saved.status_code == 201, saved.text


def test_publication_versions_every_item_so_a_previously_read_attempt_cannot_start_after_round_review(client):
    owner, doctor, _, session, draft, _ = saved_draft(client)
    old = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    saved = client.post('/api/v1/care/review-publications', headers=doctor, json=publication_body(client, doctor, draft))
    assert saved.status_code == 201, saved.text
    current = client.get(f"/api/v1/care/assessments/{session['id']}", headers=owner).json()
    assert all(after['version'] == before['version'] + 1 for before, after in zip(old['items'], current['items']))
