"""Review APIs disclose only after the critical read/write transaction commits."""
from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, get_db
from backend.app.api.routes.care import _commit_cycle_response
from backend.app.models.user import User
from backend.app.services import review_service, clarification_service
from backend.app.schemas.review import ReviewCreate, ReviewPublicationCreate, ClarificationCreate, ClarificationReplyCreate

router = APIRouter(prefix='/care', tags=['professional-review'])


@router.get('/assessments/{assessment_id}/review-context')
def get_review_context(assessment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, review_service.review_context(db, current_user, assessment_id))


@router.post('/reviews', status_code=201)
def save_review(payload: ReviewCreate, response: Response, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result, created = review_service.create_review(db, current_user, payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)


@router.get('/reviews/submissions/{client_review_id}')
def original_review(client_review_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, review_service.query_review(db, current_user, client_review_id))


@router.get('/reviews/{review_id}')
def private_review(review_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, review_service.review_detail(db, current_user, review_id))


@router.get('/assessments/{assessment_id}/reviews')
def assessment_reviews(assessment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, review_service.list_reviews(db, current_user, assessment_id))


@router.get('/assessments/{assessment_id}/reports')
def assessment_reports(assessment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, review_service.list_reports(db, current_user, assessment_id))


@router.get('/reviews/{review_id}/publication-context')
def preflight_publication(review_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, review_service.publication_context(db, current_user, review_id))


@router.post('/review-publications', status_code=201)
def publish_review(payload: ReviewPublicationCreate, response: Response, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result, created = review_service.publish_review(db, current_user, payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)


@router.get('/review-publications/submissions/{client_publication_id}')
def original_publication(client_publication_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, review_service.query_publication(db, current_user, client_publication_id))


@router.get('/reports/{report_id}')
def published_report(report_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, review_service.report_detail(db, current_user, report_id))


@router.get('/assessments/{assessment_id}/clarifications')
def specific_questions(assessment_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, clarification_service.list_questions(db, current_user, assessment_id))


@router.post('/clarifications', status_code=201)
def ask_specific_question(payload: ClarificationCreate, response: Response, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result, created = clarification_service.create_question(db, current_user, payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)


@router.get('/clarifications/submissions/{client_question_id}')
def original_question(client_question_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, clarification_service.query_original(db, current_user, client_question_id))


@router.get('/clarifications/{question_id}/reply-context')
def prepare_question_reply(question_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, clarification_service.reply_context(db, current_user, question_id))


@router.post('/clarification-replies', status_code=201)
def answer_specific_question(payload: ClarificationReplyCreate, response: Response, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result, created = clarification_service.create_reply(db, current_user, payload)
    response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)


@router.get('/clarification-replies/submissions/{client_reply_id}')
def original_question_reply(client_reply_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, clarification_service.query_original(db, current_user, client_reply_id, reply=True))
