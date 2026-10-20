"""P2A read-only originals and deterministic comparisons."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from backend.app.api.deps import get_current_user, get_db
from backend.app.api.routes.care import _commit_cycle_response
from backend.app.models.user import User
from backend.app.schemas.comparison import FollowupSummary, ResultComparison
from backend.app.services.followup_summary_service import followup_summary
from backend.app.services.comparison_service import compare_submissions
from backend.app.services.review_service import storage_boundary

router = APIRouter(prefix='/care', tags=['followup-comparison'])


@router.get('/followup-summary', response_model=FollowupSummary)
@storage_boundary
def get_followup_summary(patient_id: int = Query(gt=0),
                         user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, followup_summary(db, user, patient_id))


@router.get('/comparisons', response_model=ResultComparison)
@storage_boundary
def get_result_comparison(patient_id: int = Query(gt=0),
                          left_submission_id: str = Query(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_.:-]+$'),
                          right_submission_id: str = Query(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_.:-]+$'),
                          user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, compare_submissions(db, user, patient_id, left_submission_id, right_submission_id))
