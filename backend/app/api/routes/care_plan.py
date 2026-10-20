from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session
from backend.app.api.deps import get_current_user, get_db
from backend.app.api.routes.care import _commit_cycle_response
from backend.app.models.user import User
from backend.app.schemas.care_plan import PlanPublication, PlanReceipt
from backend.app.services import care_plan_service as plans

router = APIRouter(prefix='/care', tags=['doctor-plans'])


@router.get('/assessments/{assessment_id}/plan-context')
def plan_context(assessment_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, plans.plan_context(db, user, assessment_id))


@router.post('/plan-versions', status_code=201)
def publish_plan(payload: PlanPublication, response: Response, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result, created = plans.publish_plan(db, user, payload); response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)


@router.get('/plan-versions/submissions/{client_id}')
def query_plan(client_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, plans.query_plan_publication(db, user, client_id))


@router.get('/plans')
def plan_list(patient_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, plans.list_plans(db, user, patient_id))


@router.get('/plans/{plan_id}')
def plan_detail(plan_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, plans.get_plan(db, user, plan_id))


@router.get('/plan-versions/{plan_version_id}/acknowledgement-context')
def receipt_context(plan_version_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, plans.acknowledgement_context(db, user, plan_version_id))


@router.post('/plan-acknowledgements', status_code=201)
def receive_plan(payload: PlanReceipt, response: Response, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result, created = plans.acknowledge_plan(db, user, payload); response.status_code = 201 if created else 200
    return _commit_cycle_response(db, result)


@router.get('/plan-acknowledgements/submissions/{client_id}')
def query_receipt(client_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _commit_cycle_response(db, plans.query_receipt(db, user, client_id))
